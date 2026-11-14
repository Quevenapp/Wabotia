// Fila de espera com senha. Contrato: docs/FILA-SENHAS.md.
// Every write runs inside the area's Coordinator (commands and inbox), so reads
// followed by a guarded UPDATE are not raced by another write of the same area.
import { all, one, exec, batch } from "./db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";
import { admin, canProfile, random, sha } from "./security";
import { event } from "./events";
import { BRASILIA_OFFSET_MS } from "./business-time";
import { conversation, enqueue, settings } from "./service";

const DAY_MS = 86400000;
export const QUEUE_SCOPES = ["queue:read", "queue:issue", "queue:operate"];
export const ACTIVE = ["waiting", "called", "serving"];
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const queueDefaults = {
  front_door: false,
  notify_ahead: 2,
  max_daily_per_contact: 3,
  kiosk_per_minute: 6,
  block_no_shows: 3,
  block_window_days: 30,
  block_days: 7,
  block_too_many: true,
  operators_can_block: true,
  blocked_can_talk: true,
};
export type QueueSettings = typeof queueDefaults;

const intIn = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

/** Tolerant read of the saved settings: a malformed field falls back. */
export function queueSettings(cfg: any): QueueSettings {
  const saved = cfg?.queue && typeof cfg.queue === "object" ? cfg.queue : {};
  const out: any = { ...queueDefaults };
  for (const [key, fallback] of Object.entries(queueDefaults))
    if (typeof saved[key] === typeof fallback) out[key] = saved[key];
  return out;
}

/** Strict validation for PUT /settings. */
export function validateQueueSettings(value: any): QueueSettings {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Configuração da fila inválida.",
  );
  const next = { ...queueDefaults, ...value };
  for (const key of [
    "front_door",
    "block_too_many",
    "operators_can_block",
    "blocked_can_talk",
  ] as const)
    requireValue(
      typeof next[key] === "boolean",
      `Fila: ${key} deve ser ligado ou desligado.`,
    );
  for (const [key, min, max] of [
    ["notify_ahead", 0, 20],
    ["max_daily_per_contact", 1, 50],
    ["kiosk_per_minute", 1, 120],
    ["block_no_shows", 0, 50],
    ["block_window_days", 1, 365],
    ["block_days", 1, 365],
  ] as const)
    requireValue(
      intIn(next[key], min, max),
      `Fila: ${key} deve ser um número inteiro de ${min} a ${max}.`,
    );
  const out: any = {};
  for (const key of Object.keys(queueDefaults)) out[key] = next[key];
  return out;
}

/** Calendar day in Brasília (fixed UTC-3), e.g. "2026-11-14". */
export const serviceDay = (at = now()) =>
  new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
/** End of the Brasília day that contains `at`, in ms. */
const dayEnd = (at = now()) =>
  Date.parse(serviceDay(at) + "T00:00:00Z") + BRASILIA_OFFSET_MS + DAY_MS;

export const normalizePhone = (value: unknown) =>
  typeof value === "string" ? value.replace(/\D/g, "").slice(0, 20) : "";

/** Spoken form: "N023" → "Senha N 23". */
export function speech(code: string, counter?: string | null) {
  const match = /^([A-Za-z]*)0*(\d+)$/.exec(code);
  const spoken = match
    ? `${match[1].split("").join(" ")} ${match[2]}`.trim()
    : code;
  return `Senha ${spoken}${counter ? `, ${counter}` : ""}`;
}

function queueAccess(actor: Actor, profile: string, scope: string) {
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  if (actor.kind === "app" && !actor.scopes.includes(scope))
    throw new ApiError(403, "missing_scope", `Permissão necessária: ${scope}`);
  if (actor.kind === "connector")
    throw new ApiError(403, "forbidden", "Operação não permitida.");
}
/** Reading is allowed with any of the queue scopes. */
export function queueRead(actor: Actor, profile: string) {
  if (
    actor.kind === "app" &&
    QUEUE_SCOPES.some((s) => actor.scopes.includes(s))
  )
    return queueAccess(
      actor,
      profile,
      actor.scopes.find((s) => QUEUE_SCOPES.includes(s))!,
    );
  queueAccess(actor, profile, "queue:read");
}

// ---------------------------------------------------------------------------
// Reads

export async function queueRow(env: Env, profile: string, id: unknown) {
  const row =
    typeof id === "string"
      ? await one(
          env,
          "SELECT * FROM queues WHERE id=? AND profile_id=?",
          id,
          profile,
        )
      : null;
  if (!row) throw new ApiError(404, "queue_not_found", "Fila não encontrada.");
  return row;
}
export async function counterRow(env: Env, profile: string, id: unknown) {
  const row =
    typeof id === "string"
      ? await one(
          env,
          "SELECT * FROM counters WHERE id=? AND profile_id=?",
          id,
          profile,
        )
      : null;
  if (!row)
    throw new ApiError(404, "counter_not_found", "Guichê não encontrado.");
  return row;
}
export async function ticketRow(env: Env, profile: string, id: unknown) {
  const row =
    typeof id === "string"
      ? await one(
          env,
          "SELECT * FROM queue_tickets WHERE id=? AND profile_id=?",
          id,
          profile,
        )
      : null;
  if (!row)
    throw new ApiError(404, "ticket_not_found", "Senha não encontrada.");
  return row;
}

async function waitingCounts(env: Env, profile: string, queueId: string) {
  const row = await one(
    env,
    "SELECT sum(preferential=0) normal,sum(preferential=1) preferential FROM queue_tickets WHERE profile_id=? AND queue_id=? AND service_day=? AND status='waiting'",
    profile,
    queueId,
    serviceDay(),
  );
  return { normal: row?.normal || 0, preferential: row?.preferential || 0 };
}
async function openCounters(env: Env, profile: string, queueId: string) {
  return (
    (
      await one(
        env,
        "SELECT count(*) n FROM counters c WHERE c.profile_id=? AND c.enabled=1 AND c.status='open' AND EXISTS(SELECT 1 FROM json_each(c.queue_ids) WHERE value=?)",
        profile,
        queueId,
      )
    )?.n || 0
  );
}
/** Minutes per service for the estimate, by the queue's mode. */
export async function serviceMinutes(env: Env, queue: any) {
  const fallback = Math.max(1, Number(queue.service_minutes) || 10);
  if (queue.wait_mode === "fixed") return fallback;
  const row = await one(
    env,
    "SELECT avg(finished_at-started_at) ms,count(*) n FROM (SELECT finished_at,started_at FROM queue_tickets WHERE queue_id=? AND service_day=? AND status='done' AND started_at IS NOT NULL AND finished_at>=started_at ORDER BY finished_at DESC LIMIT 20)",
    queue.id,
    serviceDay(),
  );
  return row?.n ? Math.max(1, row.ms / 60000) : fallback;
}
export function estimateMinutes(
  ahead: number,
  minutes: number,
  counters: number,
) {
  return Math.ceil((ahead * minutes) / Math.max(1, counters));
}
/**
 * Normals the queue still owes before the next preferential (the cycle of
 * `pickNext`): right after a preferential, `normals_per_preferential` normals
 * go first when they are waiting.
 */
export const normalsOwed = (queue: any) =>
  !queue?.normals_per_preferential ||
  queue.normals_since_preferential === null ||
  queue.normals_since_preferential === undefined
    ? 0
    : Math.max(
        0,
        queue.normals_per_preferential - queue.normals_since_preferential,
      );

/** People ahead of a new ticket of this type. */
export const aheadOfNew = (
  waiting: { normal: number; preferential: number },
  preferential: boolean,
  owed = 0,
) =>
  preferential
    ? waiting.preferential + Math.min(owed, waiting.normal)
    : waiting.normal + waiting.preferential;

/** People ahead of an existing waiting ticket. */
async function aheadOf(env: Env, ticket: any) {
  if (ticket.status !== "waiting") return 0;
  if (ticket.preferential) {
    const row = await one(
      env,
      "SELECT (SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=1 AND (created_at<?3 OR (created_at=?3 AND seq<?4))) pref,(SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=0) normal,(SELECT normals_per_preferential FROM queues WHERE id=?1) normals_per_preferential,(SELECT normals_since_preferential FROM queues WHERE id=?1) normals_since_preferential",
      ticket.queue_id,
      ticket.service_day,
      ticket.created_at,
      ticket.seq,
    );
    return (row?.pref || 0) + Math.min(normalsOwed(row), row?.normal || 0);
  }
  const row = await one(
    env,
    "SELECT (SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=0 AND (created_at<?3 OR (created_at=?3 AND seq<?4)))+(SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=1) n",
    ticket.queue_id,
    ticket.service_day,
    ticket.created_at,
    ticket.seq,
  );
  return row?.n || 0;
}

async function whatsappNumber(env: Env, profile: string, queue: any) {
  const rows = await all(
    env,
    "SELECT id,config FROM connections WHERE profile_id=? AND kind IN ('zernio','qr','hermes-whatsapp') ORDER BY (id=?) DESC,created",
    profile,
    queue?.whatsapp_line_id || "",
  );
  for (const row of rows) {
    const cfg = json(row.config);
    const digits = normalizePhone(cfg.number || cfg.phone || "");
    if (digits.length >= 10) return digits;
  }
  return null;
}
export async function whatsappLink(
  env: Env,
  profile: string,
  queue: any,
  ticket: any,
) {
  const number = await whatsappNumber(env, profile, queue);
  return number
    ? `https://wa.me/${number}?text=${encodeURIComponent(`SENHA ${ticket.code} ${ticket.link_code}`)}`
    : null;
}

const userNames = async (env: Env, ids: string[]) => {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return map;
  for (const row of await all(
    env,
    "SELECT id,name FROM users WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(unique),
  ))
    map.set(row.id, row.name);
  return map;
};

async function windowOpen(env: Env, conversationId: string | null) {
  if (!conversationId) return false;
  const c = await one(
    env,
    "SELECT c.last_customer,n.kind FROM conversations c LEFT JOIN connections n ON n.id=c.connection_id WHERE c.id=?",
    conversationId,
  );
  if (!c) return false;
  return (
    !["meta", "zernio"].includes(c.kind) || now() - c.last_customer < DAY_MS
  );
}

export async function ticketView(
  env: Env,
  row: any,
  options: { staff?: boolean; queue?: any; counter?: any; link?: boolean } = {},
) {
  const queue =
    options.queue ||
    (await one(env, "SELECT * FROM queues WHERE id=?", row.queue_id));
  const counter =
    options.counter ||
    (row.counter_id
      ? await one(
          env,
          "SELECT id,name FROM counters WHERE id=?",
          row.counter_id,
        )
      : null);
  const ahead = await aheadOf(env, row);
  const minutes =
    row.status === "waiting"
      ? estimateMinutes(
          ahead,
          await serviceMinutes(env, queue),
          await openCounters(env, row.profile_id, row.queue_id),
        )
      : 0;
  return {
    id: row.id,
    queue_id: row.queue_id,
    queue_name: queue?.name || "",
    code: row.code,
    preferential: !!row.preferential,
    source: row.source,
    status: row.status,
    counter_id: row.counter_id || null,
    counter_name: counter?.name || null,
    target_counter_id: row.target_counter_id || null,
    call_count: row.call_count,
    ahead,
    wait_minutes: minutes,
    ...(options.staff
      ? {
          phone: row.phone || null,
          conversation_id: row.conversation_id || null,
          window_open: await windowOpen(env, row.conversation_id),
          cancel_reason: row.cancel_reason || null,
        }
      : {}),
    created_at: row.created_at,
    called_at: row.called_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    service_day: row.service_day,
    public_token: row.public_token,
    whatsapp_link:
      options.link === false
        ? null
        : await whatsappLink(env, row.profile_id, queue, row),
  };
}

export function callFrame(
  ticket: any,
  queue: any,
  counter: any,
  recall = false,
) {
  return {
    ticket_id: ticket.id,
    code: ticket.code,
    preferential: !!ticket.preferential,
    queue_id: queue?.id || ticket.queue_id,
    queue_name: queue?.name || "",
    counter_id: counter?.id || ticket.counter_id || null,
    counter_name: counter?.name || null,
    call_count: ticket.call_count,
    recall,
    at: ticket.called_at || now(),
    speech: speech(ticket.code, counter?.name),
  };
}

export async function overview(
  env: Env,
  profile: string,
  filter: string[] | null = null,
) {
  const cfg = queueSettings(await settings(env, profile));
  const queues = (
    await all(
      env,
      "SELECT * FROM queues WHERE profile_id=? ORDER BY sort,name,id",
      profile,
    )
  ).filter((q) => !filter?.length || filter.includes(q.id));
  const out = [];
  for (const q of queues) {
    const waiting = await waitingCounts(env, profile, q.id);
    const counters = await openCounters(env, profile, q.id);
    const minutes = await serviceMinutes(env, q);
    out.push({
      ...queuePublic(q),
      waiting,
      wait_minutes: {
        normal: estimateMinutes(aheadOfNew(waiting, false), minutes, counters),
        preferential: estimateMinutes(
          aheadOfNew(waiting, true, normalsOwed(q)),
          minutes,
          counters,
        ),
      },
      open_counters: counters,
    });
  }
  const counterRows = (
    await all(
      env,
      "SELECT * FROM counters WHERE profile_id=? AND enabled=1 ORDER BY name,id",
      profile,
    )
  ).filter(
    (c) =>
      !filter?.length ||
      json(c.queue_ids, []).some((id: string) => filter.includes(id)),
  );
  const names = await userNames(
    env,
    counterRows.map((c) => c.user_id),
  );
  const byQueue = new Map(queues.map((q) => [q.id, q]));
  const counters = [];
  for (const c of counterRows) {
    const current = await one(
      env,
      "SELECT * FROM queue_tickets WHERE counter_id=? AND status IN ('called','serving') ORDER BY called_at DESC LIMIT 1",
      c.id,
    );
    counters.push({
      id: c.id,
      name: c.name,
      queue_ids: json(c.queue_ids, []),
      status: c.status,
      user_id: c.user_id || null,
      user_name: c.user_id ? names.get(c.user_id) || null : null,
      current: current
        ? await ticketView(env, current, {
            queue: byQueue.get(current.queue_id),
            counter: c,
            link: false,
          })
        : null,
    });
  }
  const recent = await all(
    env,
    "SELECT t.*,c.name counter_name FROM queue_tickets t LEFT JOIN counters c ON c.id=t.counter_id WHERE t.profile_id=? AND t.service_day=? AND t.called_at IS NOT NULL AND t.status IN ('called','serving','done') ORDER BY t.called_at DESC LIMIT 30",
    profile,
    serviceDay(),
  );
  return {
    day: serviceDay(),
    settings: { front_door: cfg.front_door, notify_ahead: cfg.notify_ahead },
    queues: out,
    counters,
    recent_calls: recent
      .filter((t) => !filter?.length || filter.includes(t.queue_id))
      .slice(0, 10)
      .map((t) =>
        callFrame(t, byQueue.get(t.queue_id), {
          id: t.counter_id,
          name: t.counter_name,
        }),
      ),
  };
}

function queuePublic(q: any) {
  return {
    id: q.id,
    name: q.name,
    prefix_normal: q.prefix_normal,
    prefix_preferential: q.prefix_preferential,
    normals_per_preferential: q.normals_per_preferential,
    priority: q.priority,
    wait_mode: q.wait_mode,
    service_minutes: q.service_minutes,
    channels: json(q.channels, []),
    preferential_notice: q.preferential_notice,
    whatsapp_line_id: q.whatsapp_line_id || null,
    sort: q.sort,
    enabled: !!q.enabled,
  };
}

export async function listTickets(
  env: Env,
  actor: Actor,
  profile: string,
  query: { queue_id?: string; status?: string; day?: string },
) {
  queueAccess(actor, profile, "queue:operate");
  const day =
    query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day)
      ? query.day
      : serviceDay();
  const statuses = (query.status || "")
    .split(",")
    .filter((s) =>
      ["waiting", "called", "serving", "done", "no_show", "cancelled"].includes(
        s,
      ),
    );
  const rows = await all(
    env,
    `SELECT * FROM queue_tickets WHERE profile_id=? AND service_day=? ${query.queue_id ? "AND queue_id=?" : "AND ?=''"} ${statuses.length ? "AND status IN (SELECT value FROM json_each(?))" : "AND ?=''"} ORDER BY created_at,seq LIMIT 500`,
    profile,
    day,
    query.queue_id || "",
    statuses.length ? JSON.stringify(statuses) : "",
  );
  const queues = new Map(
    (await all(env, "SELECT * FROM queues WHERE profile_id=?", profile)).map(
      (q) => [q.id, q],
    ),
  );
  const counters = new Map(
    (
      await all(env, "SELECT id,name FROM counters WHERE profile_id=?", profile)
    ).map((c) => [c.id, c]),
  );
  const data = [];
  for (const row of rows)
    data.push(
      await ticketView(env, row, {
        staff: true,
        queue: queues.get(row.queue_id),
        counter: counters.get(row.counter_id),
        link: false,
      }),
    );
  return { data };
}

export async function getTicket(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  queueAccess(actor, profile, "queue:operate");
  return ticketView(env, await ticketRow(env, profile, id), { staff: true });
}

export async function listBlocklist(env: Env, actor: Actor, profile: string) {
  queueAccess(actor, profile, "queue:operate");
  requireValue(
    actor.kind === "user",
    "A lista negra é consultada pela equipe.",
  );
  const rows = await all(
    env,
    "SELECT * FROM queue_blocklist WHERE profile_id=? ORDER BY created DESC LIMIT 500",
    profile,
  );
  const data = [];
  for (const row of rows) {
    const noShows = await one(
      env,
      "SELECT count(*) n FROM queue_tickets WHERE profile_id=? AND phone=? AND status='no_show'",
      profile,
      row.phone,
    );
    data.push({
      ...row,
      active:
        !row.lifted_at && (row.expires_at === null || row.expires_at > now()),
      no_shows: noShows?.n || 0,
    });
  }
  return { data };
}

export async function listDisplays(env: Env, actor: Actor, profile: string) {
  admin(actor);
  return {
    data: (
      await all(
        env,
        "SELECT id,name,queue_ids,revoked,created FROM queue_displays WHERE profile_id=? ORDER BY created DESC",
        profile,
      )
    ).map((d) => ({
      ...d,
      queue_ids: json(d.queue_ids, []),
      revoked: !!d.revoked,
    })),
  };
}

/** TV panel token → its area and queue filter, or null. */
export async function displayByToken(env: Env, token: unknown) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await one(
    env,
    "SELECT * FROM queue_displays WHERE token_hash=? AND revoked=0",
    await sha(token),
  );
  return row
    ? {
        id: row.id,
        profile: row.profile_id,
        name: row.name,
        queue_ids: json(row.queue_ids, []) as string[],
      }
    : null;
}

/** Public tracking page data (no phone, no conversation). */
export async function publicTicket(env: Env, token: unknown) {
  const row =
    typeof token === "string" && /^[0-9a-f]{32,64}$/.test(token)
      ? await one(
          env,
          "SELECT * FROM queue_tickets WHERE public_token=?",
          token,
        )
      : null;
  if (!row)
    throw new ApiError(404, "ticket_not_found", "Senha não encontrada.");
  const { whatsapp_link, public_token, ...view } = await ticketView(env, row, {
    link: false,
  });
  return view;
}

// ---------------------------------------------------------------------------
// Blocklist

export async function activeBlock(env: Env, profile: string, phone: string) {
  if (!phone) return null;
  return one(
    env,
    "SELECT * FROM queue_blocklist WHERE profile_id=? AND phone=? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created DESC LIMIT 1",
    profile,
    phone,
    now(),
  );
}
export function blockMessage(block: any) {
  const until = block.expires_at
    ? ` até ${new Date(block.expires_at - BRASILIA_OFFSET_MS).toISOString().slice(8, 10)}/${new Date(block.expires_at - BRASILIA_OFFSET_MS).toISOString().slice(5, 7)}`
    : "";
  const why =
    block.reason === "auto_no_show"
      ? " por ausências seguidas"
      : block.reason === "auto_too_many"
        ? " por excesso de pedidos de senha"
        : "";
  return `Você está impedido de retirar senha pelo WhatsApp${until}${why}. Procure o atendimento presencial.`;
}
async function createBlock(
  env: Env,
  profile: string,
  phone: string,
  reason: "auto_no_show" | "auto_too_many" | "manual",
  by: string,
  days: number | null,
  note = "",
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO queue_blocklist(id,profile_id,phone,reason,note,blocked_by,created,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    id,
    profile,
    phone,
    reason,
    note,
    by,
    now(),
    days === null ? null : now() + days * DAY_MS,
  );
  await event(env, profile, "queue.blocked", id, {
    id,
    phone,
    reason,
    days,
  });
  return one(env, "SELECT * FROM queue_blocklist WHERE id=?", id);
}
/** Doubling duration for repeated automatic blocks in the last year. */
async function autoDays(
  env: Env,
  profile: string,
  phone: string,
  base: number,
) {
  const previous =
    (
      await one(
        env,
        "SELECT count(*) n FROM queue_blocklist WHERE profile_id=? AND phone=? AND reason!='manual' AND created>?",
        profile,
        phone,
        now() - 365 * DAY_MS,
      )
    )?.n || 0;
  return Math.min(365, base * 2 ** Math.min(previous, 6));
}
/** After a no-show: block the phone when it reached the configured limit. */
async function checkNoShows(env: Env, profile: string, phone: string | null) {
  if (!phone) return null;
  const cfg = queueSettings(await settings(env, profile));
  if (!cfg.block_no_shows || (await activeBlock(env, profile, phone)))
    return null;
  // Absences already punished by an earlier automatic block do not count again.
  const last = await one(
    env,
    "SELECT max(created) at FROM queue_blocklist WHERE profile_id=? AND phone=? AND reason='auto_no_show'",
    profile,
    phone,
  );
  const since = Math.max(now() - cfg.block_window_days * DAY_MS, last?.at || 0);
  const count =
    (
      await one(
        env,
        "SELECT count(*) n FROM queue_tickets WHERE profile_id=? AND phone=? AND status='no_show' AND updated>?",
        profile,
        phone,
        since,
      )
    )?.n || 0;
  if (count < cfg.block_no_shows) return null;
  return createBlock(
    env,
    profile,
    phone,
    "auto_no_show",
    "system",
    await autoDays(env, profile, phone, cfg.block_days),
    `${count} ausências`,
  );
}

async function bump(env: Env, key: string, expires: number) {
  return (
    (
      await one(
        env,
        "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
        key,
        expires,
      )
    )?.count || 1
  );
}

// ---------------------------------------------------------------------------
// Issuing

export interface IssueInput {
  queueId: string;
  preferential: boolean;
  source: "whatsapp" | "kiosk" | "staff";
  actorId: string;
  conversationId?: string | null;
  phone?: string | null;
  sourceKey?: string | null;
}

/**
 * Issues a ticket, or returns the contact's active one in this queue.
 * Throws contact_blocked / daily_limit / queue_closed.
 */
export async function issueTicket(
  env: Env,
  profile: string,
  input: IssueInput,
) {
  if (input.sourceKey) {
    const old = await one(
      env,
      "SELECT * FROM queue_tickets WHERE source_key=?",
      input.sourceKey,
    );
    if (old) return { ticket: old, created: false };
  }
  const queue = await queueRow(env, profile, input.queueId);
  const channel = input.source === "whatsapp" ? "whatsapp" : "kiosk";
  if (
    !queue.enabled ||
    (input.source !== "staff" && !json(queue.channels, []).includes(channel))
  )
    throw new ApiError(
      409,
      "queue_closed",
      "Esta fila não está aceitando senhas.",
    );
  const phone = normalizePhone(input.phone);
  const day = serviceDay();
  if (phone) {
    const existing = await one(
      env,
      "SELECT * FROM queue_tickets WHERE profile_id=? AND queue_id=? AND phone=? AND service_day=? AND status IN ('waiting','called','serving') ORDER BY created_at DESC LIMIT 1",
      profile,
      queue.id,
      phone,
      day,
    );
    if (existing) return { ticket: existing, created: false };
    if (input.source === "whatsapp") {
      const block = await activeBlock(env, profile, phone);
      if (block)
        throw new ApiError(403, "contact_blocked", blockMessage(block));
      const cfg = queueSettings(await settings(env, profile));
      const today =
        (
          await one(
            env,
            "SELECT count(*) n FROM queue_tickets WHERE profile_id=? AND phone=? AND service_day=?",
            profile,
            phone,
            day,
          )
        )?.n || 0;
      if (today >= cfg.max_daily_per_contact) {
        const hits = await bump(
          env,
          `queue-limit:${profile}:${phone}:${day}`,
          dayEnd(),
        );
        if (cfg.block_too_many && hits >= 3) {
          const block = await createBlock(
            env,
            profile,
            phone,
            "auto_too_many",
            "system",
            await autoDays(env, profile, phone, cfg.block_days),
            "Excesso de pedidos de senha",
          );
          throw new ApiError(403, "contact_blocked", blockMessage(block));
        }
        throw new ApiError(
          429,
          "daily_limit",
          `Você já retirou ${today} senhas hoje, o limite diário. Procure o atendimento presencial.`,
        );
      }
    }
  }
  const prefix = input.preferential
    ? queue.prefix_preferential
    : queue.prefix_normal;
  const id = uid(),
    at = now();
  const link = Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    (v) => LINK_ALPHABET[v % LINK_ALPHABET.length],
  ).join("");
  // One statement: the number cannot be taken twice even if writes interleave.
  const ticket = await one(
    env,
    "INSERT INTO queue_tickets(id,profile_id,queue_id,service_day,prefix,seq,code,preferential,source,source_key,issued_by,conversation_id,phone,public_token,link_code,created_at,updated) SELECT ?,?,?,?,?,coalesce(max(seq),0)+1,?||printf('%03d',coalesce(max(seq),0)+1),?,?,?,?,?,?,?,?,?,? FROM queue_tickets WHERE profile_id=? AND queue_id=? AND service_day=? AND prefix=? RETURNING *",
    id,
    profile,
    queue.id,
    day,
    prefix,
    prefix,
    input.preferential ? 1 : 0,
    input.source,
    input.sourceKey || null,
    input.actorId,
    input.conversationId || null,
    phone || null,
    random().slice(0, 32),
    link,
    at,
    at,
    profile,
    queue.id,
    day,
    prefix,
  );
  await event(env, profile, "queue.issued", id, {
    id,
    queue_id: queue.id,
    code: ticket.code,
    preferential: !!ticket.preferential,
    source: input.source,
  });
  return { ticket, created: true };
}

// ---------------------------------------------------------------------------
// Calling

export interface Candidate {
  id: string;
  queue_id: string;
  preferential: number | boolean;
  created_at: number;
  seq: number;
  target_counter_id?: string | null;
}
/**
 * Next ticket for a counter (port of Vinki `fila.rs::escolher`): a ticket
 * transferred to this counter first; then a normal while the queue still owes
 * normals; then preferential before normal; then queue priority; then issue
 * order, number and id.
 */
export function pickNext(
  candidates: Candidate[],
  queues: Map<
    string,
    {
      normals_per_preferential: number;
      normals_since_preferential: number | null;
      priority: number;
    }
  >,
  counterId: string,
) {
  const withNormal = new Set(
    candidates.filter((c) => !c.preferential).map((c) => c.queue_id),
  );
  const debt = (queueId: string) => {
    const q = queues.get(queueId);
    if (
      !q ||
      !q.normals_per_preferential ||
      q.normals_since_preferential === null
    )
      return 0;
    return Math.max(
      0,
      q.normals_per_preferential - q.normals_since_preferential,
    );
  };
  const tier = (c: Candidate) =>
    c.target_counter_id === counterId
      ? 3
      : !c.preferential && debt(c.queue_id) > 0 && withNormal.has(c.queue_id)
        ? 2
        : c.preferential
          ? 1
          : 0;
  return (
    [...candidates].sort(
      (a, b) =>
        tier(b) - tier(a) ||
        (queues.get(b.queue_id)?.priority || 0) -
          (queues.get(a.queue_id)?.priority || 0) ||
        a.created_at - b.created_at ||
        a.seq - b.seq ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0] || null
  );
}
/** Cycle after calling a ticket: preferential resets, normal counts up. */
export const nextCycle = (since: number | null, preferential: boolean) =>
  preferential ? 0 : since === null ? null : since + 1;

const system = "system";

async function finishCurrent(env: Env, counterId: string, actor: string) {
  const at = now();
  const current = await all(
    env,
    "SELECT * FROM queue_tickets WHERE counter_id=? AND status IN ('called','serving')",
    counterId,
  );
  for (const t of current) {
    await exec(
      env,
      "UPDATE queue_tickets SET status='done',started_at=coalesce(started_at,called_at),finished_at=?,served_by=coalesce(served_by,?),updated=? WHERE id=? AND status IN ('called','serving')",
      at,
      actor,
      at,
      t.id,
    );
    await event(env, t.profile_id, "queue.finished", t.id, {
      id: t.id,
      code: t.code,
      counter_id: counterId,
    });
  }
}

async function callNext(
  env: Env,
  actor: Actor,
  profile: string,
  counterId: string,
) {
  const counter = await counterRow(env, profile, counterId);
  if (!counter.enabled || counter.status !== "open")
    throw new ApiError(409, "counter_closed", "Abra o guichê antes de chamar.");
  const queueIds: string[] = json(counter.queue_ids, []);
  const queues = new Map(
    (
      await all(
        env,
        "SELECT * FROM queues WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
        profile,
        JSON.stringify(queueIds),
      )
    ).map((q) => [q.id, q]),
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidates = await all<Candidate>(
      env,
      "SELECT id,queue_id,preferential,created_at,seq,target_counter_id FROM queue_tickets WHERE profile_id=? AND service_day=? AND status='waiting' AND (target_counter_id=? OR (target_counter_id IS NULL AND queue_id IN (SELECT value FROM json_each(?))))",
      profile,
      serviceDay(),
      counter.id,
      JSON.stringify(queueIds),
    );
    for (const c of candidates)
      if (!queues.has(c.queue_id))
        queues.set(c.queue_id, await queueRow(env, profile, c.queue_id));
    const next = pickNext(candidates, queues, counter.id);
    if (!next)
      throw new ApiError(
        404,
        "queue_empty",
        "Nenhuma senha aguardando para este guichê.",
      );
    await finishCurrent(env, counter.id, actor.id);
    const at = now();
    const changed = await exec(
      env,
      "UPDATE queue_tickets SET status='called',counter_id=?,target_counter_id=NULL,called_at=?,call_count=call_count+1,served_by=?,updated=? WHERE id=? AND status='waiting'",
      counter.id,
      at,
      actor.id,
      at,
      next.id,
    );
    if (!changed.meta.changes) continue;
    const q = queues.get(next.queue_id);
    await exec(
      env,
      "UPDATE queues SET normals_since_preferential=?,updated=? WHERE id=?",
      nextCycle(q.normals_since_preferential, !!next.preferential),
      at,
      q.id,
    );
    const ticket = await ticketRow(env, profile, next.id);
    const frame = callFrame(ticket, q, counter);
    await event(env, profile, "queue.called", ticket.id, frame);
    await notify(env, ticket, "called", { counter: counter.name });
    await notifyAhead(env, profile, ticket.queue_id);
    return ticketView(env, ticket, { staff: true, queue: q, counter });
  }
  throw new ApiError(
    409,
    "queue_busy",
    "A fila mudou durante a chamada. Tente de novo.",
  );
}

const transitions: Record<string, { from: string[]; to: string }> = {
  "queue.start": { from: ["called"], to: "serving" },
  "queue.finish": { from: ["called", "serving"], to: "done" },
  "queue.no_show": { from: ["called"], to: "no_show" },
  "queue.cancel": { from: ["waiting", "called"], to: "cancelled" },
};
const eventFor: Record<string, string> = {
  "queue.start": "queue.started",
  "queue.finish": "queue.finished",
  "queue.no_show": "queue.no_show",
  "queue.cancel": "queue.cancelled",
};

async function moveTicket(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
) {
  const ticket = await ticketRow(env, profile, data.id);
  const rule = transitions[op];
  if (!rule.from.includes(ticket.status))
    throw new ApiError(
      409,
      "invalid_transition",
      `A senha ${ticket.code} está "${ticket.status}" e não pode passar para "${rule.to}".`,
    );
  const at = now();
  const reason =
    op === "queue.cancel" ? String(data.reason || "staff").slice(0, 100) : null;
  const changed = await exec(
    env,
    `UPDATE queue_tickets SET status=?,updated=?,${
      rule.to === "serving"
        ? "started_at=?"
        : rule.to === "done"
          ? "started_at=coalesce(started_at,called_at),finished_at=?"
          : "finished_at=?"
    },cancel_reason=coalesce(?,cancel_reason) WHERE id=? AND status=?`,
    rule.to,
    at,
    at,
    reason,
    ticket.id,
    ticket.status,
  );
  if (!changed.meta.changes)
    throw new ApiError(
      409,
      "invalid_transition",
      "A senha mudou. Atualize a tela.",
    );
  await event(env, profile, eventFor[op], ticket.id, {
    id: ticket.id,
    code: ticket.code,
    status: rule.to,
    counter_id: ticket.counter_id,
    by: actor.id,
  });
  const updated = await ticketRow(env, profile, ticket.id);
  if (op === "queue.no_show") await checkNoShows(env, profile, ticket.phone);
  if (op === "queue.cancel") {
    await notify(env, updated, "cancelled");
    await notifyAhead(env, profile, ticket.queue_id);
  }
  return ticketView(env, updated, { staff: true });
}

async function recall(env: Env, actor: Actor, profile: string, data: any) {
  const ticket = await ticketRow(env, profile, data.id);
  if (!["called", "serving"].includes(ticket.status) || !ticket.counter_id)
    throw new ApiError(
      409,
      "invalid_transition",
      "Só é possível rechamar uma senha chamada.",
    );
  const at = now();
  await exec(
    env,
    "UPDATE queue_tickets SET status='called',call_count=call_count+1,called_at=?,updated=? WHERE id=?",
    at,
    at,
    ticket.id,
  );
  const updated = await ticketRow(env, profile, ticket.id);
  const queue = await queueRow(env, profile, updated.queue_id);
  const counter = await counterRow(env, profile, updated.counter_id);
  await event(
    env,
    profile,
    "queue.recalled",
    updated.id,
    {
      ...callFrame(updated, queue, counter, true),
      // A distinct key per recall: each one must reach the panels.
      n: updated.call_count,
    },
    `${profile}:queue.recalled:${updated.id}:${updated.call_count}`,
  );
  await notify(env, updated, "recalled", { counter: counter.name });
  return ticketView(env, updated, { staff: true, queue, counter });
}

async function transfer(env: Env, actor: Actor, profile: string, data: any) {
  const ticket = await ticketRow(env, profile, data.id);
  if (!ACTIVE.includes(ticket.status))
    throw new ApiError(
      409,
      "invalid_transition",
      "Só senhas ativas podem ser transferidas.",
    );
  requireValue(
    !!data.queue_id !== !!data.counter_id,
    "Escolha uma fila ou um guichê de destino.",
  );
  let queueId = ticket.queue_id,
    target: string | null = null,
    label = "";
  if (data.counter_id) {
    const counter = await counterRow(env, profile, data.counter_id);
    requireValue(counter.enabled, "Guichê desativado.");
    target = counter.id;
    label = counter.name;
  } else {
    const queue = await queueRow(env, profile, data.queue_id);
    requireValue(queue.enabled, "Fila desativada.");
    queueId = queue.id;
    label = `fila ${queue.name}`;
  }
  const at = now();
  await exec(
    env,
    "UPDATE queue_tickets SET status='waiting',queue_id=?,transferred_from_queue_id=CASE WHEN ?!=queue_id THEN queue_id ELSE transferred_from_queue_id END,target_counter_id=?,counter_id=NULL,called_at=NULL,started_at=NULL,notified_ahead=0,updated=? WHERE id=?",
    queueId,
    queueId,
    target,
    at,
    ticket.id,
  );
  const updated = await ticketRow(env, profile, ticket.id);
  await event(
    env,
    profile,
    "queue.transferred",
    ticket.id,
    {
      id: ticket.id,
      code: ticket.code,
      from_queue_id: ticket.queue_id,
      queue_id: queueId,
      counter_id: target,
      by: actor.id,
    },
    `${profile}:queue.transferred:${ticket.id}:${at}`,
  );
  await notify(env, updated, "transferred", { target: label });
  return ticketView(env, updated, { staff: true });
}

// ---------------------------------------------------------------------------
// WhatsApp notices

async function notify(
  env: Env,
  ticket: any,
  kind: "called" | "recalled" | "ahead" | "transferred" | "cancelled",
  extra: { counter?: string; target?: string; ahead?: number } = {},
) {
  if (!ticket.conversation_id || !ticket.phone) return;
  if (await activeBlock(env, ticket.profile_id, ticket.phone)) return;
  let c: Conversation;
  try {
    c = await conversation(env, ticket.conversation_id, ticket.profile_id);
  } catch {
    return;
  }
  const text =
    kind === "called"
      ? `🔔 Senha ${ticket.code}: é a sua vez! Dirija-se ao ${extra.counter}.`
      : kind === "recalled"
        ? `🔔 Senha ${ticket.code}: estamos chamando novamente. Dirija-se ao ${extra.counter}.`
        : kind === "ahead"
          ? extra.ahead
            ? `Senha ${ticket.code}: falta${extra.ahead === 1 ? "" : "m"} ${extra.ahead} senha${extra.ahead === 1 ? "" : "s"} para a sua vez. Fique por perto.`
            : `Senha ${ticket.code}: você é o próximo! Fique por perto.`
          : kind === "transferred"
            ? `Senha ${ticket.code}: sua senha foi transferida para ${extra.target}. Aguarde a chamada.`
            : `Senha ${ticket.code} cancelada.`;
  const open = await windowOpen(env, c.id);
  // Calls go even outside the 24h window (as the notification template);
  // the other notices only while the window is open.
  if (!open && !["called", "recalled"].includes(kind)) return;
  try {
    await enqueue(
      env,
      c,
      system,
      ["called", "recalled"].includes(kind) ? "notification" : "text",
      {
        text,
        automation: "queue",
        ticket_id: `Senha ${ticket.code}`,
        queue_ticket_id: ticket.id,
      },
      `queue:${kind}:${ticket.id}:${ticket.call_count}:${ticket.updated}`,
    );
  } catch (error) {
    // A line without permission or removed never blocks the counter.
    if (!(error instanceof ApiError)) throw error;
  }
}

/** "Faltam N senhas" for tickets that reached the configured distance. */
async function notifyAhead(env: Env, profile: string, queueId: string) {
  const cfg = queueSettings(await settings(env, profile));
  if (!cfg.notify_ahead) return;
  const waiting = await all(
    env,
    "SELECT * FROM queue_tickets WHERE profile_id=? AND queue_id=? AND service_day=? AND status='waiting' AND notified_ahead=0 AND conversation_id IS NOT NULL ORDER BY created_at,seq LIMIT 30",
    profile,
    queueId,
    serviceDay(),
  );
  for (const t of waiting) {
    const ahead = await aheadOf(env, t);
    if (ahead > cfg.notify_ahead) continue;
    await exec(
      env,
      "UPDATE queue_tickets SET notified_ahead=1 WHERE id=?",
      t.id,
    );
    await notify(env, t, "ahead", { ahead });
  }
}

/** Closes tickets left open on previous days. Cheap; runs on every alarm. */
export async function closeDay(env: Env, profile: string) {
  const day = serviceDay();
  const result = await exec(
    env,
    "UPDATE queue_tickets SET status='cancelled',cancel_reason='day_closed',updated=? WHERE profile_id=? AND service_day<? AND status IN ('waiting','called','serving')",
    now(),
    profile,
    day,
  );
  if (result.meta.changes) {
    await exec(
      env,
      "UPDATE queues SET normals_since_preferential=NULL WHERE profile_id=?",
      profile,
    );
    await event(
      env,
      profile,
      "queue.changed",
      profile,
      { day_closed: day },
      `${profile}:queue.day:${day}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commands (Coordinator → perform)

const name = (value: unknown, max: number, label: string) => {
  requireValue(
    typeof value === "string" &&
      value.trim() &&
      Array.from(value.trim()).length <= max,
    `Informe ${label} (até ${max} caracteres).`,
  );
  return (value as string).trim();
};
const prefixOf = (value: unknown, fallback: string) => {
  const v = value === undefined ? fallback : value;
  requireValue(
    typeof v === "string" && /^[A-Z]{1,3}$/.test(v),
    "O prefixo da senha deve ter de 1 a 3 letras maiúsculas.",
  );
  return v as string;
};

async function saveQueue(env: Env, actor: Actor, profile: string, data: any) {
  admin(actor);
  const old = data.id ? await queueRow(env, profile, data.id) : null;
  const next = {
    name: name(data.name ?? old?.name, 60, "o nome da fila"),
    prefix_normal: prefixOf(data.prefix_normal, old?.prefix_normal || "N"),
    prefix_preferential: prefixOf(
      data.prefix_preferential,
      old?.prefix_preferential || "P",
    ),
    normals_per_preferential:
      data.normals_per_preferential ?? old?.normals_per_preferential ?? 2,
    priority: data.priority ?? old?.priority ?? 0,
    wait_mode: data.wait_mode ?? old?.wait_mode ?? "average",
    service_minutes: data.service_minutes ?? old?.service_minutes ?? 10,
    channels:
      data.channels ?? (old ? json(old.channels, []) : ["whatsapp", "kiosk"]),
    preferential_notice:
      data.preferential_notice ??
      old?.preferential_notice ??
      "Atendimento preferencial: pessoas com 60 anos ou mais, gestantes, lactantes, pessoas com criança de colo, pessoas com deficiência ou mobilidade reduzida.",
    whatsapp_line_id:
      data.whatsapp_line_id === undefined
        ? old?.whatsapp_line_id || null
        : data.whatsapp_line_id || null,
    sort: data.sort ?? old?.sort ?? 0,
    enabled:
      data.enabled === undefined ? (old ? !!old.enabled : true) : data.enabled,
  };
  requireValue(
    next.prefix_normal !== next.prefix_preferential,
    "Use prefixos diferentes para senha normal e preferencial.",
  );
  requireValue(
    intIn(next.normals_per_preferential, 0, 20),
    "Normais por preferencial: de 0 a 20.",
  );
  requireValue(
    intIn(next.priority, -100, 100),
    "Prioridade da fila: de -100 a 100.",
  );
  requireValue(
    ["average", "fixed"].includes(next.wait_mode),
    "Modo do tempo de espera inválido.",
  );
  requireValue(
    intIn(next.service_minutes, 1, 600),
    "Minutos por atendimento: de 1 a 600.",
  );
  requireValue(
    Array.isArray(next.channels) &&
      next.channels.every((c: any) => ["whatsapp", "kiosk"].includes(c)),
    "Canais inválidos: use whatsapp e/ou kiosk.",
  );
  requireValue(
    typeof next.preferential_notice === "string" &&
      next.preferential_notice.length <= 500,
    "O aviso preferencial deve ter até 500 caracteres.",
  );
  requireValue(intIn(next.sort, 0, 10000), "Ordem inválida.");
  requireValue(typeof next.enabled === "boolean", "Ativação inválida.");
  if (next.whatsapp_line_id)
    requireValue(
      await one(
        env,
        "SELECT id FROM connections WHERE id=? AND profile_id=?",
        next.whatsapp_line_id,
        profile,
      ),
      "Linha de WhatsApp não pertence à área.",
    );
  const id = old?.id || uid(),
    at = now();
  await exec(
    env,
    "INSERT INTO queues(id,profile_id,name,prefix_normal,prefix_preferential,normals_per_preferential,priority,wait_mode,service_minutes,channels,preferential_notice,whatsapp_line_id,sort,enabled,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prefix_normal=excluded.prefix_normal,prefix_preferential=excluded.prefix_preferential,normals_per_preferential=excluded.normals_per_preferential,priority=excluded.priority,wait_mode=excluded.wait_mode,service_minutes=excluded.service_minutes,channels=excluded.channels,preferential_notice=excluded.preferential_notice,whatsapp_line_id=excluded.whatsapp_line_id,sort=excluded.sort,enabled=excluded.enabled,updated=excluded.updated",
    id,
    profile,
    next.name,
    next.prefix_normal,
    next.prefix_preferential,
    next.normals_per_preferential,
    next.priority,
    next.wait_mode,
    next.service_minutes,
    JSON.stringify([...new Set(next.channels)]),
    next.preferential_notice.trim(),
    next.whatsapp_line_id,
    next.sort,
    next.enabled ? 1 : 0,
    at,
    at,
  );
  await event(
    env,
    profile,
    "queue.changed",
    id,
    { queue_id: id },
    `${profile}:queue.changed:${id}:${at}`,
  );
  return queuePublic(await queueRow(env, profile, id));
}

async function saveCounter(env: Env, actor: Actor, profile: string, data: any) {
  admin(actor);
  const old = data.id ? await counterRow(env, profile, data.id) : null;
  const queueIds = data.queue_ids ?? (old ? json(old.queue_ids, []) : []);
  requireValue(
    Array.isArray(queueIds) &&
      queueIds.length <= 50 &&
      queueIds.every((q: any) => typeof q === "string"),
    "Filas do guichê inválidas.",
  );
  for (const q of queueIds) await queueRow(env, profile, q);
  const enabled =
    data.enabled === undefined ? (old ? !!old.enabled : true) : data.enabled;
  requireValue(typeof enabled === "boolean", "Ativação inválida.");
  const id = old?.id || uid(),
    at = now();
  await exec(
    env,
    "INSERT INTO counters(id,profile_id,name,queue_ids,enabled,created,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,queue_ids=excluded.queue_ids,enabled=excluded.enabled,status=CASE WHEN excluded.enabled=0 THEN 'closed' ELSE status END,updated=excluded.updated",
    id,
    profile,
    name(data.name ?? old?.name, 40, "o nome do guichê"),
    JSON.stringify([...new Set(queueIds)]),
    enabled ? 1 : 0,
    at,
    at,
  );
  await event(
    env,
    profile,
    "queue.counter",
    id,
    { counter_id: id },
    `${profile}:queue.counter:${id}:${at}`,
  );
  const row = await counterRow(env, profile, id);
  return { ...row, queue_ids: json(row.queue_ids, []), enabled: !!row.enabled };
}

async function counterState(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  const counter = await counterRow(env, profile, data.id);
  requireValue(
    ["open", "paused", "closed"].includes(data.status),
    "Estado do guichê inválido: open, paused ou closed.",
  );
  requireValue(
    counter.enabled || data.status === "closed",
    "Guichê desativado.",
  );
  const at = now();
  if (data.status === "closed") await finishCurrent(env, counter.id, actor.id);
  await exec(
    env,
    "UPDATE counters SET status=?,user_id=?,updated=? WHERE id=?",
    data.status,
    data.status === "closed"
      ? null
      : actor.kind === "user"
        ? actor.id
        : counter.user_id,
    at,
    counter.id,
  );
  await event(
    env,
    profile,
    "queue.counter",
    counter.id,
    {
      counter_id: counter.id,
      status: data.status,
      by: actor.id,
    },
    `${profile}:queue.counter:${counter.id}:${at}`,
  );
  const row = await counterRow(env, profile, counter.id);
  return { ...row, queue_ids: json(row.queue_ids, []), enabled: !!row.enabled };
}

async function block(env: Env, actor: Actor, profile: string, data: any) {
  requireValue(actor.kind === "user", "Bloqueios são feitos pela equipe.");
  const cfg = queueSettings(await settings(env, profile));
  if (actor.role !== "admin" && !cfg.operators_can_block)
    throw new ApiError(
      403,
      "admin_required",
      "Somente administradores podem bloquear.",
    );
  let phone = normalizePhone(data.phone);
  if (!phone && data.ticket_id)
    phone = normalizePhone(
      (await ticketRow(env, profile, data.ticket_id)).phone,
    );
  if (!phone && data.conversation_id)
    phone = normalizePhone(
      (await conversation(env, data.conversation_id, profile, actor)).phone,
    );
  requireValue(phone.length >= 8, "Informe um telefone válido para bloquear.");
  const days = data.days === undefined ? cfg.block_days : data.days;
  requireValue(
    days === null || intIn(days, 1, 3650),
    "Prazo do bloqueio: de 1 a 3650 dias, ou permanente.",
  );
  const note = data.note === undefined ? "" : String(data.note);
  requireValue(note.length <= 300, "Observação até 300 caracteres.");
  const existing = await activeBlock(env, profile, phone);
  if (existing)
    await exec(
      env,
      "UPDATE queue_blocklist SET lifted_at=?,lifted_by=? WHERE id=?",
      now(),
      actor.id,
      existing.id,
    );
  return createBlock(
    env,
    profile,
    phone,
    "manual",
    actor.id,
    days,
    note.trim(),
  );
}

async function unblock(env: Env, actor: Actor, profile: string, data: any) {
  admin(actor);
  const row = await one(
    env,
    "SELECT * FROM queue_blocklist WHERE id=? AND profile_id=?",
    data.id,
    profile,
  );
  requireValue(row, "Bloqueio não encontrado.");
  await exec(
    env,
    "UPDATE queue_blocklist SET lifted_at=coalesce(lifted_at,?),lifted_by=coalesce(lifted_by,?) WHERE id=?",
    now(),
    actor.id,
    row.id,
  );
  await event(env, profile, "queue.unblocked", row.id, {
    id: row.id,
    phone: row.phone,
    by: actor.id,
  });
  return { id: row.id, lifted: true };
}

async function createDisplay(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  admin(actor);
  const queueIds = data.queue_ids ?? [];
  requireValue(
    Array.isArray(queueIds) &&
      queueIds.every((q: any) => typeof q === "string"),
    "Filas do painel inválidas.",
  );
  for (const q of queueIds) await queueRow(env, profile, q);
  const token = random(),
    id = uid();
  await exec(
    env,
    "INSERT INTO queue_displays(id,profile_id,name,queue_ids,token_hash,created) VALUES(?,?,?,?,?,?)",
    id,
    profile,
    name(data.name, 60, "o nome do painel"),
    JSON.stringify(queueIds),
    await sha(token),
    now(),
  );
  return { id, token, path: `/painel#t=${token}` };
}

export async function queueCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  requestId: string,
): Promise<any> {
  if (op === "queue.save") return saveQueue(env, actor, profile, data);
  if (op === "counter.save") return saveCounter(env, actor, profile, data);
  if (op === "queue.display.create")
    return createDisplay(env, actor, profile, data);
  if (op === "queue.display.revoke") {
    admin(actor);
    await exec(
      env,
      "UPDATE queue_displays SET revoked=1 WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    return { id: data.id, revoked: true };
  }
  if (op === "queue.block") return block(env, actor, profile, data);
  if (op === "queue.unblock") return unblock(env, actor, profile, data);
  if (op === "queue.issue") {
    queueAccess(actor, profile, "queue:issue");
    requireValue(
      typeof data.preferential === "boolean",
      "Informe se a senha é preferencial.",
    );
    const source =
      data.source === "staff" && actor.kind === "user" ? "staff" : "kiosk";
    if (actor.kind === "app") {
      const cfg = queueSettings(await settings(env, profile));
      const minute = Math.floor(now() / 60000);
      if (
        (await bump(
          env,
          `queue-kiosk:${actor.id}:${minute}`,
          (minute + 1) * 60000,
        )) > cfg.kiosk_per_minute
      )
        throw new ApiError(
          429,
          "kiosk_rate",
          "Muitas senhas em pouco tempo. Aguarde um instante.",
        );
    }
    const { ticket } = await issueTicket(env, profile, {
      queueId: data.queue_id,
      preferential: data.preferential,
      source,
      actorId: actor.id,
      phone: actor.kind === "user" ? data.phone : null,
      sourceKey: `issue:${actor.id}:${requestId}`,
    });
    return ticketView(env, ticket, { staff: actor.kind === "user" });
  }
  queueAccess(actor, profile, "queue:operate");
  if (op === "counter.state") return counterState(env, actor, profile, data);
  if (op === "queue.call_next") return callNext(env, actor, profile, data.id);
  if (op === "queue.recall") return recall(env, actor, profile, data);
  if (op === "queue.transfer") return transfer(env, actor, profile, data);
  if (transitions[op]) return moveTicket(env, actor, profile, op, data);
  throw new ApiError(404, "not_found", "Operação da fila desconhecida.");
}

// ---------------------------------------------------------------------------
// Customer side (WhatsApp)

/** The contact's active ticket today, if any. */
export async function activeTicketFor(
  env: Env,
  profile: string,
  phone: string | null,
) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  return one(
    env,
    "SELECT * FROM queue_tickets WHERE profile_id=? AND phone=? AND service_day=? AND status IN ('waiting','called','serving') ORDER BY created_at DESC LIMIT 1",
    profile,
    digits,
    serviceDay(),
  );
}

/** Customer gave up by WhatsApp (SAIR): not an absence. */
export async function customerCancel(env: Env, ticket: any) {
  const changed = await exec(
    env,
    "UPDATE queue_tickets SET status='cancelled',cancel_reason='customer',finished_at=?,updated=? WHERE id=? AND status IN ('waiting','called')",
    now(),
    now(),
    ticket.id,
  );
  if (changed.meta.changes) {
    await event(env, ticket.profile_id, "queue.cancelled", ticket.id, {
      id: ticket.id,
      code: ticket.code,
      status: "cancelled",
      by: "customer",
    });
    await notifyAhead(env, ticket.profile_id, ticket.queue_id);
  }
  return !!changed.meta.changes;
}

/**
 * "SENHA N023 AB12CD" sent from the kiosk coupon QR: ties the ticket to this
 * conversation so the customer is told when it is called.
 */
export async function linkKioskTicket(
  env: Env,
  c: Conversation,
  code: string,
  linkCode: string,
) {
  const ticket = await one(
    env,
    "SELECT * FROM queue_tickets WHERE profile_id=? AND service_day=? AND code=? AND link_code=? AND status IN ('waiting','called','serving') LIMIT 1",
    c.profile_id,
    serviceDay(),
    code.toUpperCase(),
    linkCode.toUpperCase(),
  );
  if (!ticket) return { ticket: null, blocked: null };
  const phone = normalizePhone(c.phone || c.external_id);
  const block = await activeBlock(env, c.profile_id, phone);
  if (block) return { ticket, blocked: block };
  await batch(env, [
    [
      "UPDATE queue_tickets SET conversation_id=?,phone=?,updated=? WHERE id=?",
      [c.id, phone || null, now(), ticket.id],
    ],
  ]);
  return {
    ticket: await ticketRow(env, c.profile_id, ticket.id),
    blocked: null,
  };
}
