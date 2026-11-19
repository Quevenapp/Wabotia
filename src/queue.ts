// Fila de espera com senha. Contrato: docs/FILA-SENHAS.md.
// Every write runs inside the area's Coordinator (commands and inbox), so reads
// followed by a guarded UPDATE are not raced by another write of the same area.
import {
  all,
  one,
  exec,
  batch,
  batchPrefetched,
  cached,
  PROFILE_SETTINGS_SQL,
  PUBLIC_ORIGIN_SQL,
  reads,
  readValues,
  seedRead,
  withReadCache,
  type Read,
} from "./db";
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
import { event, eventStatement, fanOut } from "./events";
import { commandClosing, type CommandClosing } from "./command-context";
import { BRASILIA_OFFSET_MS } from "./business-time";
import { conversation, enqueue, settings } from "./service";
import { establishment } from "./establishment";
import { publicOrigin } from "./web-steps";
import { normalizeCustomerPhone } from "./customer/phone";
import { customerRecordStatements, resolveCustomer } from "./customer/ports";
import { verifiedPhone } from "./protocol-lookup";

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
/**
 * O que o cupom da senha impresso pelo totem traz (`queue.coupon`). Cada item
 * liga e desliga; o rodapé usa `footer_text` ou, vazio, o rodapé do cadastro
 * do estabelecimento.
 */
export const couponDefaults = {
  establishment: true,
  position: true,
  footer: true,
  footer_text: "",
  whatsapp_qr: true,
};
export type CouponSettings = typeof couponDefaults;
export const COUPON_FOOTER_MAX = 300;

export type QueueSettings = typeof queueDefaults & { coupon: CouponSettings };

const intIn = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function couponSettings(saved: unknown): CouponSettings {
  const from = plainObject(saved) ? saved : {};
  const out: any = { ...couponDefaults };
  for (const [key, fallback] of Object.entries(couponDefaults))
    if (typeof from[key] === typeof fallback) out[key] = from[key];
  return out;
}

/** Tolerant read of the saved settings: a malformed field falls back. */
export function queueSettings(cfg: any): QueueSettings {
  const saved = cfg?.queue && typeof cfg.queue === "object" ? cfg.queue : {};
  const out: any = { ...queueDefaults };
  for (const [key, fallback] of Object.entries(queueDefaults))
    if (typeof saved[key] === typeof fallback) out[key] = saved[key];
  out.coupon = couponSettings(saved.coupon);
  return out;
}

/** Strict validation of `queue.coupon`; a partial object keeps `old`. */
function validateCoupon(value: unknown, old: unknown): CouponSettings {
  if (value === undefined) return couponSettings(old);
  requireValue(plainObject(value), "Cupom da senha: configuração inválida.");
  const next: any = { ...couponSettings(old), ...value };
  for (const key of [
    "establishment",
    "position",
    "footer",
    "whatsapp_qr",
  ] as const)
    requireValue(
      typeof next[key] === "boolean",
      `Cupom da senha: ${key} deve ser ligado ou desligado.`,
    );
  requireValue(
    typeof next.footer_text === "string" &&
      Array.from(next.footer_text.trim()).length <= COUPON_FOOTER_MAX,
    `Cupom da senha: a mensagem de rodapé deve ter até ${COUPON_FOOTER_MAX} caracteres.`,
  );
  const out: any = {};
  for (const key of Object.keys(couponDefaults)) out[key] = next[key];
  out.footer_text = out.footer_text.trim();
  return out;
}

/**
 * Strict validation for PUT /settings. `old` is the saved block: a partial
 * `coupon` merges with it.
 */
export function validateQueueSettings(value: any, old?: any): QueueSettings {
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
  out.coupon = validateCoupon(value.coupon, old?.coupon);
  return out;
}

/** Calendar day in Brasília (fixed UTC-3), e.g. "2026-11-14". */
export const serviceDay = (at = now()) =>
  new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
/** End of the Brasília day that contains `at`, in ms. */
const dayEnd = (at = now()) =>
  Date.parse(serviceDay(at) + "T00:00:00Z") + BRASILIA_OFFSET_MS + DAY_MS;

export const normalizePhone = (value: unknown) =>
  normalizeCustomerPhone(value, "international") || "";

/** Marcador de canal autenticado; telefone digitado e external_id não são prova. */
export function verifiedQueuePhone(c: Conversation): string | null {
  return verifiedPhone(c);
}

async function queueCustomer(env: Env, c: Conversation) {
  const phone = verifiedQueuePhone(c);
  if (!phone) throw new ApiError(403, "forbidden", "A senha precisa de uma conversa com telefone autenticado.");
  const ref = await resolveCustomer(env, c);
  if (ref.state !== "ready" || !ref.contactId || ref.namespace !== "team" || ref.profileId !== c.profile_id || ref.verifiedPhone !== phone)
    throw new ApiError(409, "customer_ambiguous", "Confirme o vínculo do contato antes de associar a senha.");
  return { phone, contactId: ref.contactId };
}

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

/** The queue shows a waiting-time estimate (wait_mode is not "off"). */
export const waitShown = (queue: any) => Number(queue?.show_wait ?? 1) !== 0;
/** Minutes per service for the estimate, by the queue's mode. */
export async function serviceMinutes(env: Env, queue: any) {
  if (queue.wait_mode === "fixed") return minutesPerService(queue, null);
  const row = await one(env, VIEW_SQL.service, queue.id, serviceDay());
  return minutesPerService(queue, row);
}
/**
 * Minutos por atendimento a partir da média já lida (`service`: ms e n dos
 * últimos 20 atendimentos do dia), ou o fixo da fila.
 */
function minutesPerService(queue: any, service: any) {
  const fallback = Math.max(1, Number(queue?.service_minutes) || 10);
  return queue?.wait_mode === "fixed" || !service?.n
    ? fallback
    : Math.max(1, service.ms / 60000);
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

/** WhatsApp lines of the area and the first number usable in a wa.me link. */
async function whatsappLine(env: Env, profile: string, queue: any) {
  const rows = await all(
    env,
    "SELECT id,config FROM connections WHERE profile_id=? AND kind IN ('zernio','qr') ORDER BY (id=?) DESC,created",
    profile,
    queue?.whatsapp_line_id || "",
  );
  return { lines: rows.length, number: lineNumber(rows) };
}

/**
 * Página pública com a prévia (Open Graph) da imagem que aponta o botão de
 * enviar. Fica sob /api/ porque só esses caminhos chegam ao Worker
 * (run_worker_first em wrangler.jsonc); fora deles, o fallback de página
 * única dos arquivos estáticos responde com o painel, sem Open Graph.
 */
export const SEND_HINT_PATH = "/api/public/imagemwa";

/**
 * Texto que o QR do cupom deixa escrito no WhatsApp: instrução curta para
 * quem não está acostumado, a linha "SENHA N023 AB12CD" que vincula a conversa
 * (src/queue-flow.ts) e o link da imagem com a seta, cuja prévia aparece no
 * rascunho quando o WhatsApp a gera.
 */
export function couponWhatsappText(
  ticket: { code: string; link_code: string },
  origin: string | null,
) {
  return [
    "Aperte ENVIAR para ser chamado pelo WhatsApp.",
    `SENHA ${ticket.code} ${ticket.link_code}`,
    ...(origin ? [`${origin}${SEND_HINT_PATH}`] : []),
  ].join("\n");
}

export type CouponQrIssue = "disabled" | "no_line" | "no_number";
const COUPON_QR_NOTICE: Record<CouponQrIssue, string> = {
  disabled: "O QR do WhatsApp está desligado no cupom.",
  no_line:
    "O QR do WhatsApp não sai no cupom porque a área não tem linha de WhatsApp. Conecte uma linha em Integrações.",
  no_number:
    "O QR do WhatsApp não sai no cupom porque nenhuma linha de WhatsApp da área tem o número registrado. Confira a conexão da linha em Integrações.",
};

/** "123.456.789-09" → "***.456.789-**". */
export const maskCpf = (display: string) =>
  /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(display)
    ? `***${display.slice(3, 11)}-**`
    : "";

/**
 * O que o aparelho imprime no cupom da senha, já resolvido (contrato em
 * docs/FILA-SENHAS.md, "Cupom da senha"). Vai no snapshot da fila.
 */
export async function couponView(
  env: Env,
  profile: string,
  cfg: QueueSettings,
  /** As linhas de WhatsApp da área, se já lidas (overviewData). */
  lineRows?: any[],
) {
  const c = cfg.coupon;
  const est =
    c.establishment || c.footer ? await establishment(env, profile) : null;
  const line = !c.whatsapp_qr
    ? null
    : lineRows
      ? { lines: lineRows.length, number: lineNumber(lineRows) }
      : await whatsappLine(env, profile, null);
  const issue: CouponQrIssue | null = !line
    ? "disabled"
    : !line.lines
      ? "no_line"
      : !line.number
        ? "no_number"
        : null;
  return {
    establishment:
      c.establishment && est
        ? {
            name: est.name,
            // CPF vai mascarado: o cupom fica com o cliente e o aparelho só
            // tem queue:read. CNPJ sai inteiro.
            document_type: est.document_type,
            document_display:
              est.document_type === "cpf"
                ? maskCpf(est.document_display)
                : est.document_display,
            address: est.address,
            phone: est.phone,
          }
        : null,
    position: c.position,
    footer: (c.footer && (c.footer_text || est?.footer)) || null,
    whatsapp_qr: c.whatsapp_qr,
    whatsapp_qr_issue: issue,
    whatsapp_qr_notice: issue ? COUPON_QR_NOTICE[issue] : null,
  };
}

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

/** Leituras da vista de uma senha que vão juntas ao D1 (ticketView). */
const VIEW_SQL = {
  queue: "SELECT * FROM queues WHERE id=?",
  counter: "SELECT id,name FROM counters WHERE id=?",
  aheadPreferential:
    "SELECT (SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=1 AND (created_at<?3 OR (created_at=?3 AND seq<?4))) pref,(SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=0) normal,(SELECT normals_per_preferential FROM queues WHERE id=?1) normals_per_preferential,(SELECT normals_since_preferential FROM queues WHERE id=?1) normals_since_preferential",
  aheadNormal:
    "SELECT (SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=0 AND (created_at<?3 OR (created_at=?3 AND seq<?4)))+(SELECT count(*) FROM queue_tickets WHERE queue_id=?1 AND service_day=?2 AND status='waiting' AND preferential=1) n",
  service:
    "SELECT avg(finished_at-started_at) ms,count(*) n FROM (SELECT finished_at,started_at FROM queue_tickets WHERE queue_id=? AND service_day=? AND status='done' AND started_at IS NOT NULL AND finished_at>=started_at ORDER BY finished_at DESC LIMIT 20)",
  open: "SELECT count(*) n FROM counters c WHERE c.profile_id=? AND c.enabled=1 AND c.status='open' AND EXISTS(SELECT 1 FROM json_each(c.queue_ids) WHERE value=?)",
  window:
    "SELECT c.last_customer,n.kind FROM conversations c LEFT JOIN connections n ON n.id=c.connection_id WHERE c.id=?",
  // A linha da fila primeiro (whatsapp_line_id), como em whatsappLine.
  lines:
    "SELECT id,config FROM connections WHERE profile_id=? AND kind IN ('zernio','qr') ORDER BY (id=coalesce((SELECT whatsapp_line_id FROM queues WHERE id=?),'')) DESC,created",
};

/** Primeiro número de WhatsApp utilizável das linhas (whatsappLine). */
function lineNumber(rows: any[]) {
  for (const row of rows) {
    const cfg = json(row.config);
    const digits = normalizePhone(cfg.number || cfg.phone || "");
    if (digits.length >= 10) return digits;
  }
  return null;
}

/**
 * Vista de uma senha. As leituras que ela precisa (fila, guichê, quem está
 * na frente, tempo médio, guichês abertos, conversa, linhas do WhatsApp e,
 * se ainda não estiverem no cache da requisição, as configurações e o
 * endereço público) vão numa ida só ao D1 (docs/LIMITES.md).
 */
export async function ticketView(
  env: Env,
  row: any,
  options: ViewOptions = {},
) {
  const plan = viewReads(env, row, options);
  return viewOf(env, row, options, plan, await reads(env, plan.items));
}

interface ViewOptions {
  staff?: boolean;
  queue?: any;
  counter?: any;
  link?: boolean;
}
type ViewPlan = ReturnType<typeof viewReads>;

/**
 * As leituras da vista de uma senha, para irem ao D1 sozinhas (ticketView)
 * ou no lote de uma escrita (callNext). `row`: a senha como vai estar.
 */
function viewReads(env: Env, row: any, options: ViewOptions) {
  const waiting = row.status === "waiting";
  const link = options.link !== false;
  const items: Read[] = [];
  const index: Record<string, number> = {};
  const add = (name: string, read: Read) => {
    index[name] = items.length;
    items.push(read);
  };
  if (!options.queue)
    add("queue", { sql: VIEW_SQL.queue, args: [row.queue_id], first: true });
  if (!options.counter && row.counter_id)
    add("counter", {
      sql: VIEW_SQL.counter,
      args: [row.counter_id],
      first: true,
    });
  if (waiting) {
    const sql = row.preferential
      ? VIEW_SQL.aheadPreferential
      : VIEW_SQL.aheadNormal;
    // Senha gravada no mesmo lote (issueTicket): o número ainda não é
    // conhecido, então a ordem vem da própria linha, pelo id.
    const byId = row.seq === undefined;
    add("ahead", {
      sql: byId
        ? sql
            .replaceAll(
              "?3",
              "(SELECT created_at FROM queue_tickets WHERE id=?3)",
            )
            .replaceAll("?4", "(SELECT seq FROM queue_tickets WHERE id=?3)")
        : sql,
      args: byId
        ? [row.queue_id, row.service_day, row.id]
        : [row.queue_id, row.service_day, row.created_at, row.seq],
      first: true,
    });
    add("service", {
      sql: VIEW_SQL.service,
      args: [row.queue_id, serviceDay()],
      first: true,
    });
    add("open", {
      sql: VIEW_SQL.open,
      args: [row.profile_id, row.queue_id],
      first: true,
    });
  }
  if (options.staff && row.conversation_id)
    add("window", {
      sql: VIEW_SQL.window,
      args: [row.conversation_id],
      first: true,
    });
  // Configurações e endereço público: do cache da requisição (o comando já
  // os leu na abertura) ou neste mesmo lote.
  const settingsRead: Read = {
    sql: PROFILE_SETTINGS_SQL,
    args: [row.profile_id],
    first: true,
  };
  const originRead: Read = { sql: PUBLIC_ORIGIN_SQL, args: [], first: true };
  if (link) {
    add("lines", { sql: VIEW_SQL.lines, args: [row.profile_id, row.queue_id] });
    if (!cached(env, settingsRead)) add("settings", settingsRead);
    if (!cached(env, originRead)) add("origin", originRead);
  }
  return { items, index, settingsRead, originRead };
}

/** A vista de uma senha com as leituras de viewReads já feitas (`got`). */
async function viewOf(
  env: Env,
  row: any,
  options: ViewOptions,
  plan: ViewPlan,
  got: any[],
) {
  const { index, settingsRead, originRead } = plan;
  const waiting = row.status === "waiting";
  const link = options.link !== false;
  const pick = (name: string): any => (name in index ? got[index[name]] : null);
  if ("settings" in index) seedRead(env, settingsRead, [pick("settings")]);
  if ("origin" in index) seedRead(env, originRead, [pick("origin")]);
  const queue = options.queue || pick("queue");
  const counter = options.counter || pick("counter");
  const aheadRow = pick("ahead");
  const ahead = !waiting
    ? 0
    : row.preferential
      ? (aheadRow?.pref || 0) +
        Math.min(normalsOwed(aheadRow), aheadRow?.normal || 0)
      : aheadRow?.n || 0;
  const perService = minutesPerService(queue, pick("service"));
  // null: the queue does not show a waiting time.
  const minutes = !waitShown(queue)
    ? null
    : waiting
      ? estimateMinutes(ahead, perService, pick("open")?.n || 0)
      : 0;
  const windowRow = pick("window");
  let whatsapp_link: string | null = null;
  if (link) {
    const cfg = queueSettings(await settings(env, row.profile_id));
    const number = cfg.coupon.whatsapp_qr ? lineNumber(pick("lines")) : null;
    whatsapp_link = number
      ? `https://wa.me/${number}?text=${encodeURIComponent(couponWhatsappText(row, await publicOrigin(env)))}`
      : null;
  }
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
          window_open:
            !!windowRow &&
            (!["meta", "zernio"].includes(windowRow.kind) ||
              now() - windowRow.last_customer < DAY_MS),
          cancel_reason: row.cancel_reason || null,
        }
      : {}),
    created_at: row.created_at,
    called_at: row.called_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    service_day: row.service_day,
    public_token: row.public_token,
    whatsapp_link,
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

/** Leituras do panorama da fila, todas da área inteira (overviewData). */
const OVERVIEW_SQL = {
  queues: "SELECT * FROM queues WHERE profile_id=? ORDER BY sort,name,id",
  waiting:
    "SELECT queue_id,sum(preferential=0) normal,sum(preferential=1) preferential FROM queue_tickets WHERE profile_id=? AND service_day=? AND status='waiting' GROUP BY queue_id",
  open: "SELECT j.value queue_id,count(DISTINCT c.id) n FROM counters c,json_each(c.queue_ids) j WHERE c.profile_id=? AND c.enabled=1 AND c.status='open' GROUP BY j.value",
  // Os últimos 20 atendimentos do dia de cada fila (VIEW_SQL.service).
  service:
    "SELECT queue_id,avg(finished_at-started_at) ms,count(*) n FROM (SELECT queue_id,finished_at,started_at,row_number() OVER (PARTITION BY queue_id ORDER BY finished_at DESC) rn FROM queue_tickets WHERE profile_id=? AND service_day=? AND status='done' AND started_at IS NOT NULL AND finished_at>=started_at) WHERE rn<=20 GROUP BY queue_id",
  counters:
    "SELECT c.*,u.name user_name FROM counters c LEFT JOIN users u ON u.id=c.user_id WHERE c.profile_id=? AND c.enabled=1 ORDER BY c.name,c.id",
  // A senha chamada ou em atendimento mais recente de cada guichê.
  current:
    "SELECT * FROM (SELECT t.*,row_number() OVER (PARTITION BY t.counter_id ORDER BY t.called_at DESC) current_rank FROM queue_tickets t WHERE t.profile_id=? AND t.counter_id IS NOT NULL AND t.status IN ('called','serving')) WHERE current_rank=1",
  recent:
    "SELECT t.*,c.name counter_name FROM queue_tickets t LEFT JOIN counters c ON c.id=t.counter_id WHERE t.profile_id=? AND t.service_day=? AND t.called_at IS NOT NULL AND t.status IN ('called','serving','done') ORDER BY t.called_at DESC LIMIT 30",
  lines:
    "SELECT id,config FROM connections WHERE profile_id=? AND kind IN ('zernio','qr') ORDER BY created",
};

export type OverviewData = Awaited<ReturnType<typeof overviewData>>;

/**
 * Tudo o que o panorama da fila lê, numa ida só ao D1 (docs/LIMITES.md), da
 * área inteira: o envio aos painéis monta o panorama de cada filtro com uma
 * leitura só (overviewOf). `extra`: leituras que precisam ser do mesmo
 * instante do panorama, no mesmo lote (os eventos do envio aos painéis);
 * os resultados voltam em `extra`, na ordem.
 */
export async function overviewData(
  env: Env,
  profile: string,
  extra: Read[] = [],
) {
  env = withReadCache(env);
  const day = serviceDay();
  const settingsRead: Read = {
    sql: PROFILE_SETTINGS_SQL,
    args: [profile],
    first: true,
  };
  const items: Read[] = [
    { sql: OVERVIEW_SQL.queues, args: [profile] },
    { sql: OVERVIEW_SQL.waiting, args: [profile, day] },
    { sql: OVERVIEW_SQL.open, args: [profile] },
    { sql: OVERVIEW_SQL.service, args: [profile, day] },
    { sql: OVERVIEW_SQL.counters, args: [profile] },
    { sql: OVERVIEW_SQL.current, args: [profile] },
    { sql: OVERVIEW_SQL.recent, args: [profile, day] },
    { sql: OVERVIEW_SQL.lines, args: [profile] },
  ];
  const withSettings = !cached(env, settingsRead);
  const got = await reads(env, [
    ...items,
    ...(withSettings ? [settingsRead] : []),
    ...extra,
  ]);
  if (withSettings) seedRead(env, settingsRead, [got[items.length]]);
  const extraResults = got.slice(got.length - extra.length);
  const [queues, waiting, open, service, counters, current, recent, lines] =
    got as any[][];
  const byQueueId = (rows: any[]) => new Map(rows.map((r) => [r.queue_id, r]));
  const cfg = queueSettings(await settings(env, profile));
  return {
    env,
    profile,
    day,
    cfg,
    coupon: await couponView(env, profile, cfg, lines),
    queues,
    waiting: byQueueId(waiting),
    open: byQueueId(open),
    service: byQueueId(service),
    counters,
    current: new Map(current.map((t) => [t.counter_id, t])),
    recent,
    extra: extraResults,
  };
}

/** Panorama da fila (GET /queue, painéis e telas), só das filas do filtro. */
export async function overview(
  env: Env,
  profile: string,
  filter: string[] | null = null,
) {
  return overviewOf(await overviewData(env, profile), filter);
}

/** Panorama de um filtro a partir do que overviewData leu. */
export async function overviewOf(
  data: OverviewData,
  filter: string[] | null = null,
) {
  const { env, cfg } = data;
  const queues = data.queues.filter(
    (q) => !filter?.length || filter.includes(q.id),
  );
  const out = [];
  for (const q of queues) {
    const w = data.waiting.get(q.id);
    const waiting = {
      normal: w?.normal || 0,
      preferential: w?.preferential || 0,
    };
    const counters = data.open.get(q.id)?.n || 0;
    const minutes = minutesPerService(q, data.service.get(q.id));
    out.push({
      ...queuePublic(q),
      waiting,
      wait_minutes: waitShown(q)
        ? {
            normal: estimateMinutes(
              aheadOfNew(waiting, false),
              minutes,
              counters,
            ),
            preferential: estimateMinutes(
              aheadOfNew(waiting, true, normalsOwed(q)),
              minutes,
              counters,
            ),
          }
        : null,
      open_counters: counters,
    });
  }
  const counterRows = data.counters.filter(
    (c) =>
      !filter?.length ||
      json(c.queue_ids, []).some((id: string) => filter.includes(id)),
  );
  // Todas as filas da área: a senha atual de um guichê pode ser de uma fila
  // fora do filtro (ticketView não volta ao banco para buscá-la).
  const byQueue = new Map(data.queues.map((q) => [q.id, q]));
  const counters = [];
  for (const c of counterRows) {
    const current = data.current.get(c.id);
    counters.push({
      id: c.id,
      name: c.name,
      queue_ids: json(c.queue_ids, []),
      status: c.status,
      user_id: c.user_id || null,
      user_name: c.user_id ? c.user_name || null : null,
      current: current
        ? await ticketView(env, current, {
            queue: byQueue.get(current.queue_id),
            counter: c,
            link: false,
          })
        : null,
    });
  }
  return {
    day: data.day,
    settings: { front_door: cfg.front_door, notify_ahead: cfg.notify_ahead },
    coupon: data.coupon,
    queues: out,
    counters,
    recent_calls: data.recent
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
    wait_mode: waitShown(q) ? q.wait_mode : "off",
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
  /** Totem (aplicação): o limite por minuto, conferido na mesma ida. */
  kioskRate?: { key: string; expires: number; limit: number };
  /**
   * A vista da senha nova (ticketView), com as leituras no lote da gravação.
   * Vem em `view` só quando a senha foi criada agora.
   */
  view?: Omit<ViewOptions, "queue">;
  /**
   * /command: a auditoria e a marca do recibo vão no lote da gravação da
   * senha (src/command-context.ts).
   */
  closing?: CommandClosing | null;
}

/**
 * Issues a ticket, or returns the contact's active one in this queue.
 * Throws contact_blocked / daily_limit / queue_closed.
 */
/**
 * O começo da emissão (issueTicket): a senha já emitida com esta chave, a
 * fila e, no totem, o +1 do contador por minuto. O /command adianta estas
 * mesmas instruções no lote da abertura (queuePrefetch).
 */
function issueFirstStatements(
  profile: string,
  input: Pick<IssueInput, "sourceKey" | "queueId"> & {
    kioskRate?: { key: string; expires: number };
  },
) {
  const items: [string, any[]][] = [];
  if (input.sourceKey)
    items.push([
      "SELECT * FROM queue_tickets WHERE source_key=?",
      [input.sourceKey],
    ]);
  if (typeof input.queueId === "string")
    items.push([
      "SELECT * FROM queues WHERE id=? AND profile_id=?",
      [input.queueId, profile],
    ]);
  if (input.kioskRate)
    items.push([
      "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
      [input.kioskRate.key, input.kioskRate.expires],
    ]);
  return items;
}

/** Contador por minuto do totem (aplicação) na emissão. */
function kioskRateOf(actor: Actor, at = now()) {
  const minute = Math.floor(at / 60000);
  return {
    key: `queue-kiosk:${actor.id}:${minute}`,
    expires: (minute + 1) * 60000,
  };
}

/** Chave de origem da emissão por /command (repetição devolve a mesma senha). */
const issueSourceKey = (actor: Actor, requestId: string) =>
  `issue:${actor.id}:${requestId}`;

export async function issueTicket(
  env: Env,
  profile: string,
  input: IssueInput,
) {
  // Uma ida ao D1 para o começo (docs/LIMITES.md), ou nenhuma, quando o
  // /command já adiantou estas instruções no lote da abertura.
  const items = issueFirstStatements(profile, input);
  const hasQueueId = typeof input.queueId === "string";
  // Repetir não faz mal: só leituras e o +1 do contador por minuto.
  const first = items.length
    ? await batchPrefetched(env, items, { retry: true })
    : [];
  let pos = 0;
  const old: any = input.sourceKey ? first[pos++].results[0] : null;
  const queueFound: any = hasQueueId ? first[pos++].results[0] : null;
  if (input.kioskRate) {
    const count = (first[pos].results[0] as any)?.count || 1;
    if (count > input.kioskRate.limit)
      throw new ApiError(
        429,
        "kiosk_rate",
        "Muitas senhas em pouco tempo. Aguarde um instante.",
      );
  }
  if (old) {
    if (input.source === "whatsapp" && input.conversationId) {
      const customer = await queueCustomer(env, await conversation(env, input.conversationId || "", profile));
      const linked = await one(env, "SELECT contact_id FROM customer_records WHERE profile_id=? AND module_id='queue' AND kind='ticket' AND record_id=?", profile, old.id);
      if (old.profile_id !== profile || old.conversation_id !== input.conversationId || (linked && linked.contact_id !== customer.contactId))
        throw new ApiError(409, "contact_conflict", "Esta senha pertence a outro vínculo de atendimento.");
    }
    return { ticket: old, created: false, queue: queueFound ?? null };
  }
  if (!queueFound)
    throw new ApiError(404, "queue_not_found", "Fila não encontrada.");
  const queue = queueFound;
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
  const customer = input.source === "whatsapp" && input.conversationId
    ? await queueCustomer(env, await conversation(env, input.conversationId || "", profile)) : null;
  const phone = customer?.phone || normalizePhone(input.phone);
  const day = serviceDay();
  if (phone) {
    const existing = await one(
      env,
      `SELECT * FROM queue_tickets WHERE profile_id=? AND queue_id=? AND phone=? AND service_day=? AND status IN ('waiting','called','serving') ${customer ? "AND conversation_id=? AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=queue_tickets.profile_id AND r.module_id='queue' AND r.kind='ticket' AND r.record_id=queue_tickets.id AND r.contact_id<>?)" : ""} ORDER BY created_at DESC LIMIT 1`,
      profile,
      queue.id,
      phone,
      day,
      ...(customer ? [input.conversationId, customer.contactId] : []),
    );
    if (existing) return { ticket: existing, created: false, queue };
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
  // O evento queue.issued vai no mesmo lote (uma ida ao D1), com o código
  // lido da senha recém-gravada, e as leituras da vista, se pedida.
  const viewOptions = input.view ? { ...input.view, queue } : null;
  const view = viewOptions
    ? viewReads(
        env,
        {
          id,
          profile_id: profile,
          queue_id: queue.id,
          service_day: day,
          status: "waiting",
          preferential: input.preferential ? 1 : 0,
          conversation_id: input.conversationId || null,
          counter_id: null,
        },
        viewOptions,
      )
    : null;
  const results = await batch(env, [
    [
      "INSERT INTO queue_tickets(id,profile_id,queue_id,service_day,prefix,seq,code,preferential,source,source_key,issued_by,conversation_id,phone,public_token,link_code,created_at,updated) SELECT ?,?,?,?,?,coalesce(max(seq),0)+1,?||printf('%03d',coalesce(max(seq),0)+1),?,?,?,?,?,?,?,?,?,? FROM queue_tickets WHERE profile_id=? AND queue_id=? AND service_day=? AND prefix=? RETURNING *",
      [
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
      ],
    ],
    [
      "INSERT INTO events(profile_id,kind,resource_id,payload,created,source_key) SELECT ?,'queue.issued',id,json_object('id',id,'queue_id',queue_id,'code',code,'preferential',json(CASE WHEN preferential THEN 'true' ELSE 'false' END),'source',source),?,NULL FROM queue_tickets WHERE id=? RETURNING id",
      [profile, at, id],
    ],
    ...(customer ? customerRecordStatements({ profileId: profile, contactId: customer.contactId, moduleId: "queue", kind: "ticket", recordId: id, conversationId: input.conversationId!, linkedBy: `conversation:${input.conversationId}`, occurredAt: at }) : []),
    // /command: a auditoria e a marca do recibo no mesmo lote (atômico).
    ...(input.closing?.statements(id) ?? []),
    ...(view?.items ?? []).map((r) => [r.sql, r.args] as [string, any[]]),
  ]);
  const [inserted, issued] = results;
  const ticket = inserted.results[0] as any;
  input.closing?.committed(id);
  await fanOut(env, profile, "queue.issued", (issued.results[0] as any).id);
  return {
    ticket,
    created: true,
    queue,
    view:
      view && viewOptions
        ? await viewOf(
            env,
            ticket,
            viewOptions,
            view,
            readValues(view.items, results),
          )
        : undefined,
  };
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

const CURRENT_SQL =
  "SELECT * FROM queue_tickets WHERE counter_id=? AND status IN ('called','serving')";

/**
 * O encerramento das senhas em curso no guichê (`current`, já lidas com
 * CURRENT_SQL): por senha, a atualização e o evento queue.finished, para irem
 * num lote. `events`: os eventos, na ordem, para o fanOut depois do lote.
 */
function finishStatements(
  current: any[],
  counterId: string,
  actor: string,
  at: number,
) {
  const statements: [string, any[]][] = [];
  const events: { profile: string; at: number }[] = [];
  for (const t of current) {
    statements.push([
      "UPDATE queue_tickets SET status='done',started_at=coalesce(started_at,called_at),finished_at=?,served_by=coalesce(served_by,?),updated=? WHERE id=? AND status IN ('called','serving')",
      [at, actor, at, t.id],
    ]);
    events.push({ profile: t.profile_id, at: statements.length });
    statements.push(
      eventStatement(t.profile_id, "queue.finished", t.id, {
        id: t.id,
        code: t.code,
        counter_id: counterId,
      }),
    );
  }
  return { statements, events };
}
/** fanOut dos eventos gravados num lote (`at`: posição da instrução). */
async function fanOutBatch(
  env: Env,
  results: D1Result[],
  events: { profile: string; kind: string; at: number }[],
) {
  for (const e of events) {
    const row = results[e.at].results[0] as any;
    if (row) await fanOut(env, e.profile, e.kind, row.id);
  }
}

async function finishCurrent(env: Env, counterId: string, actor: string) {
  const current = await all(env, CURRENT_SQL, counterId);
  if (!current.length) return;
  const { statements, events } = finishStatements(
    current,
    counterId,
    actor,
    now(),
  );
  const results = await batch(env, statements);
  await fanOutBatch(
    env,
    results,
    events.map((e) => ({ ...e, kind: "queue.finished" })),
  );
}

/** Leituras da chamada da próxima senha, todas numa ida (callNext). */
const CALL_SQL = {
  counter: "SELECT * FROM counters WHERE id=? AND profile_id=?",
  // As filas do guichê e as das senhas transferidas para ele.
  queues:
    "SELECT * FROM queues WHERE profile_id=?1 AND (id IN (SELECT value FROM json_each((SELECT queue_ids FROM counters WHERE id=?2 AND profile_id=?1))) OR id IN (SELECT queue_id FROM queue_tickets WHERE profile_id=?1 AND service_day=?3 AND status='waiting' AND target_counter_id=?2))",
  candidates:
    "SELECT id,queue_id,preferential,created_at,seq,target_counter_id,code,conversation_id FROM queue_tickets WHERE profile_id=?1 AND service_day=?3 AND status='waiting' AND (target_counter_id=?2 OR (target_counter_id IS NULL AND queue_id IN (SELECT value FROM json_each((SELECT queue_ids FROM counters WHERE id=?2 AND profile_id=?1)))))",
  // O evento queue.called com a senha como ficou (callFrame), só se a
  // chamada pegou: a senha está chamada neste guichê, neste instante.
  called:
    "INSERT INTO events(profile_id,kind,resource_id,payload,created,source_key) SELECT t.profile_id,'queue.called',t.id,json_object('ticket_id',t.id,'code',t.code,'preferential',json(CASE WHEN t.preferential THEN 'true' ELSE 'false' END),'queue_id',t.queue_id,'queue_name',?,'counter_id',t.counter_id,'counter_name',?,'call_count',t.call_count,'recall',json('false'),'at',t.called_at,'speech',?),?,NULL FROM queue_tickets t WHERE t.id=? AND t.status='called' AND t.counter_id=? AND t.called_at=? RETURNING id",
  cycle:
    "UPDATE queues SET normals_since_preferential=?,updated=? WHERE id=? AND EXISTS(SELECT 1 FROM queue_tickets WHERE id=? AND status='called' AND counter_id=? AND called_at=?)",
};

/**
 * Chama a próxima senha do guichê em duas idas ao D1 (docs/LIMITES.md): as
 * leituras (guichê, filas, candidatas e senhas em curso) e, num lote, o
 * encerramento das em curso, a chamada, o evento, o ciclo da fila, as senhas
 * a avisar de "faltam N" e as leituras da vista.
 */
/** As leituras do começo da chamada (callNext). */
function callNextReads(profile: string, counterId: string): Read[] {
  const day = serviceDay();
  return [
    { sql: CALL_SQL.counter, args: [counterId, profile], first: true },
    { sql: CALL_SQL.queues, args: [profile, counterId, day] },
    { sql: CALL_SQL.candidates, args: [profile, counterId, day] },
    { sql: CURRENT_SQL, args: [counterId] },
  ];
}

/**
 * Instruções que a operação da fila vai fazer primeiro, para o /command
 * adiantar no lote da abertura (src/coordinator.ts): a emissão e a chamada
 * passam a duas idas ao D1 (abertura e gravação). Têm de ser as mesmas da
 * operação (mesma instrução, mesmos argumentos); o que não bater vai ao
 * banco normalmente. Só leituras e o +1 do contador por minuto do totem, que
 * pode contar uma repetição a mais sem problema.
 */
export function queuePrefetch(
  op: string,
  data: any,
  actor: Actor,
  profile: string,
  requestId: string,
): [string, any[]][] {
  if (op === "queue.issue" && typeof data?.queue_id === "string")
    return issueFirstStatements(profile, {
      sourceKey: issueSourceKey(actor, requestId),
      queueId: data.queue_id,
      kioskRate: actor.kind === "app" ? kioskRateOf(actor) : undefined,
    });
  if (op === "queue.call_next" && typeof data?.id === "string")
    return callNextReads(profile, data.id).map((r) => [r.sql, r.args]);
  return [];
}

/** Operações da fila que fecham o recibo no lote da escrita (src/command-context.ts). */
export const QUEUE_CLOSING_OPS = new Set(["queue.issue", "queue.call_next"]);

/**
 * Resposta de uma emissão ou chamada reconstruída pelo recurso, para a
 * repetição com a mesma chave quando o recibo só tem a marca
 * ("ref:<operação>:<id>"): o objeto reiniciou ou a gravação da resposta
 * falhou depois de responder. A senha é a mesma; o que pode diferir da
 * resposta original é o que mudou desde então: quantos estão na frente e a
 * espera estimada (outras senhas foram chamadas) e, na chamada, o estado e o
 * número de chamadas se a senha já andou (atendida, rechamada).
 */
export async function queueReplay(
  env: Env,
  actor: Actor,
  profile: string,
  ref: string,
) {
  const match = /^ref:(queue\.issue|queue\.call_next):([^:]+)$/.exec(ref);
  if (!match) throw new Error("queue_replay_ref_invalid");
  const row = await ticketRow(env, profile, match[2]);
  return ticketView(env, row, {
    staff: match[1] === "queue.call_next" || actor.kind === "user",
  });
}

async function callNext(
  env: Env,
  actor: Actor,
  profile: string,
  counterId: string,
) {
  if (typeof counterId !== "string")
    throw new ApiError(404, "counter_not_found", "Guichê não encontrado.");
  const cfg = queueSettings(await settings(env, profile));
  for (let attempt = 0; attempt < 5; attempt++) {
    // Na primeira tentativa, estas leituras já vieram no lote da abertura do
    // /command (queuePrefetch); nas seguintes, vão ao banco.
    const [counter, queueRows, candidates, current] = await reads(
      env,
      callNextReads(profile, counterId),
    );
    if (!counter)
      throw new ApiError(404, "counter_not_found", "Guichê não encontrado.");
    if (!counter.enabled || counter.status !== "open")
      throw new ApiError(
        409,
        "counter_closed",
        "Abra o guichê antes de chamar.",
      );
    const queues = new Map<string, any>(queueRows.map((q: any) => [q.id, q]));
    const next = pickNext(candidates, queues, counter.id);
    if (!next)
      throw new ApiError(
        404,
        "queue_empty",
        "Nenhuma senha aguardando para este guichê.",
      );
    const q = queues.get(next.queue_id);
    if (!q) throw new ApiError(404, "queue_not_found", "Fila não encontrada.");
    const at = now();
    const finish = finishStatements(current, counter.id, actor.id, at);
    const statements = [...finish.statements];
    const callAt = statements.length;
    statements.push([
      "UPDATE queue_tickets SET status='called',counter_id=?,target_counter_id=NULL,called_at=?,call_count=call_count+1,served_by=?,updated=? WHERE id=? AND status='waiting' RETURNING *",
      [counter.id, at, actor.id, at, next.id],
    ]);
    const calledAt = statements.length;
    statements.push([
      CALL_SQL.called,
      [
        q.name || "",
        counter.name || null,
        speech((next as any).code, counter.name),
        at,
        next.id,
        counter.id,
        at,
      ],
    ]);
    statements.push([
      CALL_SQL.cycle,
      [
        nextCycle(q.normals_since_preferential, !!next.preferential),
        at,
        q.id,
        next.id,
        counter.id,
        at,
      ],
    ]);
    // /command: a auditoria e a marca do recibo no mesmo lote, só se a
    // chamada pegou (a mesma condição do evento e do ciclo).
    const closing = commandClosing(env, "queue.call_next");
    if (closing)
      statements.push(
        ...closing.statements(next.id, [
          "EXISTS(SELECT 1 FROM queue_tickets WHERE id=? AND status='called' AND counter_id=? AND called_at=?)",
          [next.id, counter.id, at],
        ]),
      );
    // Depois da chamada, no mesmo lote: quem está na frente já conta com ela.
    const tail: Read[] = cfg.notify_ahead ? [aheadRead(profile, q.id)] : [];
    const view = viewReads(
      env,
      {
        ...next,
        profile_id: profile,
        status: "called",
        counter_id: counter.id,
      },
      { staff: true, queue: q, counter },
    );
    tail.push(...view.items);
    const results = await batch(env, [
      ...statements,
      ...tail.map((r) => [r.sql, r.args] as [string, any[]]),
    ]);
    await fanOutBatch(env, results, [
      ...finish.events.map((e) => ({ ...e, kind: "queue.finished" })),
      { profile, kind: "queue.called", at: calledAt },
    ]);
    const ticket = results[callAt].results[0] as any;
    if (!ticket) continue;
    closing?.committed(next.id);
    const got = readValues(tail, results);
    await notify(env, ticket, "called", { counter: counter.name });
    if (cfg.notify_ahead) await notifyAheadOf(env, got[0], cfg.notify_ahead);
    return viewOf(
      env,
      ticket,
      { staff: true, queue: q, counter },
      view,
      cfg.notify_ahead ? got.slice(1) : got,
    );
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

/**
 * Senhas ainda não avisadas de "faltam N" de uma fila, cada uma com quantas
 * estão na frente (`ahead_count`, a conta de aheadOf feita no banco), para a
 * leitura ir no lote da chamada (callNext).
 */
export const AHEAD_SQL = `SELECT t.*,CASE WHEN t.preferential THEN (SELECT count(*) FROM queue_tickets a WHERE a.queue_id=t.queue_id AND a.service_day=t.service_day AND a.status='waiting' AND a.preferential=1 AND (a.created_at<t.created_at OR (a.created_at=t.created_at AND a.seq<t.seq)))+min(coalesce((SELECT CASE WHEN coalesce(q.normals_per_preferential,0)=0 OR q.normals_since_preferential IS NULL THEN 0 ELSE max(0,q.normals_per_preferential-q.normals_since_preferential) END FROM queues q WHERE q.id=t.queue_id),0),(SELECT count(*) FROM queue_tickets a WHERE a.queue_id=t.queue_id AND a.service_day=t.service_day AND a.status='waiting' AND a.preferential=0)) ELSE (SELECT count(*) FROM queue_tickets a WHERE a.queue_id=t.queue_id AND a.service_day=t.service_day AND a.status='waiting' AND a.preferential=0 AND (a.created_at<t.created_at OR (a.created_at=t.created_at AND a.seq<t.seq)))+(SELECT count(*) FROM queue_tickets a WHERE a.queue_id=t.queue_id AND a.service_day=t.service_day AND a.status='waiting' AND a.preferential=1) END ahead_count FROM queue_tickets t WHERE t.profile_id=? AND t.queue_id=? AND t.service_day=? AND t.status='waiting' AND t.notified_ahead=0 AND t.conversation_id IS NOT NULL ORDER BY t.created_at,t.seq LIMIT 30`;

const aheadRead = (profile: string, queueId: string): Read => ({
  sql: AHEAD_SQL,
  args: [profile, queueId, serviceDay()],
});

/** "Faltam N senhas" for tickets that reached the configured distance. */
async function notifyAhead(env: Env, profile: string, queueId: string) {
  const cfg = queueSettings(await settings(env, profile));
  if (!cfg.notify_ahead) return;
  const [waiting] = await reads(env, [aheadRead(profile, queueId)]);
  await notifyAheadOf(env, waiting, cfg.notify_ahead);
}
/** Os avisos de "faltam N" das senhas já lidas com AHEAD_SQL. */
async function notifyAheadOf(env: Env, waiting: any[], distance: number) {
  const due = waiting.filter((t) => t.ahead_count <= distance);
  if (!due.length) return;
  await exec(
    env,
    "UPDATE queue_tickets SET notified_ahead=1 WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(due.map((t) => t.id)),
  );
  for (const { ahead_count, ...t } of due)
    await notify(env, t, "ahead", { ahead: ahead_count });
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
    wait_mode: data.wait_mode ?? (old ? queuePublic(old).wait_mode : "average"),
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
    ["average", "fixed", "off"].includes(next.wait_mode),
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
  // "off" hides the estimate; the column keeps the last real mode.
  const showWait = next.wait_mode !== "off",
    storedMode = showWait
      ? next.wait_mode
      : old?.wait_mode === "fixed"
        ? "fixed"
        : "average";
  await exec(
    env,
    "INSERT INTO queues(id,profile_id,name,prefix_normal,prefix_preferential,normals_per_preferential,priority,wait_mode,show_wait,service_minutes,channels,preferential_notice,whatsapp_line_id,sort,enabled,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prefix_normal=excluded.prefix_normal,prefix_preferential=excluded.prefix_preferential,normals_per_preferential=excluded.normals_per_preferential,priority=excluded.priority,wait_mode=excluded.wait_mode,show_wait=excluded.show_wait,service_minutes=excluded.service_minutes,channels=excluded.channels,preferential_notice=excluded.preferential_notice,whatsapp_line_id=excluded.whatsapp_line_id,sort=excluded.sort,enabled=excluded.enabled,updated=excluded.updated",
    id,
    profile,
    next.name,
    next.prefix_normal,
    next.prefix_preferential,
    next.normals_per_preferential,
    next.priority,
    storedMode,
    showWait ? 1 : 0,
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
    // Totem (aplicação): limite por minuto, conferido na mesma ida que a fila
    // (issueTicket). As configurações já vieram na abertura do comando.
    const kioskRate =
      actor.kind === "app"
        ? {
            ...kioskRateOf(actor),
            limit: queueSettings(await settings(env, profile)).kiosk_per_minute,
          }
        : undefined;
    const staff = actor.kind === "user";
    const { ticket, queue, view } = await issueTicket(env, profile, {
      queueId: data.queue_id,
      preferential: data.preferential,
      source,
      actorId: actor.id,
      phone: staff ? data.phone : null,
      sourceKey: issueSourceKey(actor, requestId),
      kioskRate,
      view: { staff },
      closing: commandClosing(env, "queue.issue"),
    });
    return view ?? ticketView(env, ticket, { staff, queue });
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

/** Vínculo persistido ou senha do balcão para o telefone provado pelo canal. */
export async function activeTicketForConversation(env: Env, profile: string, conversationId: string) {
  return one(env, `SELECT q.* FROM queue_tickets q JOIN conversations c ON c.profile_id=q.profile_id
    WHERE q.profile_id=? AND c.id=? AND q.service_day=? AND q.status IN ('waiting','called','serving')
    AND (q.conversation_id=c.id OR (q.conversation_id IS NULL AND q.source='staff'
      AND c.connection_id IS NOT NULL AND c.external_namespace='channel:'||c.connection_id
      AND c.phone<>'' AND (c.verified_phone IS NULL OR c.verified_phone=c.phone)
      AND (c.verified_phone IS NOT NULL OR (c.external_id NOT LIKE '%@lid' AND c.external_id NOT LIKE '%@g.us'))
      AND (q.phone=c.phone
        OR (length(c.phone)=13 AND c.phone GLOB '55[0-9][0-9]9*' AND q.phone=substr(c.phone,1,4)||substr(c.phone,6))
        OR (length(c.phone)=12 AND c.phone GLOB '55[0-9][0-9][6-9]*' AND q.phone=substr(c.phone,1,4)||'9'||substr(c.phone,5)))))
    AND c.chat_type<>'group' AND c.customer_link_state NOT IN ('blocked','excluded','ambiguous')
    AND NOT EXISTS(SELECT 1 FROM conversation_contacts cc JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id
      WHERE cc.profile_id=c.profile_id AND cc.conversation_id=c.id AND p.identity_state<>'active')
    AND NOT EXISTS(SELECT 1 FROM customer_records r LEFT JOIN conversation_contacts cc ON cc.profile_id=r.profile_id AND cc.conversation_id=c.id
      LEFT JOIN customer_phones cp ON cp.profile_id=c.profile_id AND cp.namespace='team' AND cp.phone=c.verified_phone AND cp.state='ready'
      LEFT JOIN contacts p ON p.id=r.contact_id AND p.profile_id=r.profile_id
      WHERE r.profile_id=q.profile_id AND r.module_id='queue' AND r.kind='ticket' AND r.record_id=q.id
      AND (coalesce(cc.contact_id,cp.contact_id) IS NULL OR r.contact_id<>coalesce(cc.contact_id,cp.contact_id) OR p.id IS NULL OR p.identity_state<>'active'))
    ORDER BY q.created_at DESC,q.id DESC LIMIT 1`, profile, conversationId, serviceDay());
}

/**
 * "Minha senha" for the customer of a conversation (bot tool
 * queue_minha_senha): today's active ticket linked to this conversation or
 * issued by staff for its authenticated phone. Only what the
 * customer sees on WhatsApp: code, queue, position and estimate; no phone,
 * public token or link.
 */
export async function conversationTicket(
  env: Env,
  profile: string,
  conversationId: string,
  _phone: string | null = null,
) {
  const row = await activeTicketForConversation(env, profile, conversationId);
  if (!row) return { senha: null };
  const view = await ticketView(env, row, { link: false });
  return {
    senha: {
      codigo: view.code,
      fila: view.queue_name,
      preferencial: view.preferential,
      estado:
        view.status === "waiting"
          ? "aguardando"
          : view.status === "called"
            ? "chamada"
            : "em atendimento",
      a_frente: view.status === "waiting" ? view.ahead : 0,
      espera_estimada_min: view.status === "waiting" ? view.wait_minutes : null,
      guiche: view.counter_name,
    },
  };
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
  c = await conversation(env, c.id, c.profile_id);
  const customer = await queueCustomer(env, c);
  const ticket = await one(
    env,
    "SELECT q.*,(SELECT contact_id FROM customer_records r WHERE r.profile_id=q.profile_id AND r.module_id='queue' AND r.kind='ticket' AND r.record_id=q.id) linked_contact FROM queue_tickets q WHERE profile_id=? AND service_day=? AND code=? AND link_code=? AND status IN ('waiting','called','serving') LIMIT 1",
    c.profile_id,
    serviceDay(),
    code.toUpperCase(),
    linkCode.toUpperCase(),
  );
  if (!ticket) return { ticket: null, blocked: null };
  if ((ticket.conversation_id && ticket.conversation_id !== c.id) ||
      (ticket.linked_contact && ticket.linked_contact !== customer.contactId) ||
      (ticket.phone && normalizePhone(ticket.phone) !== customer.phone))
    throw new ApiError(409, "contact_conflict", "Esta senha já está associada. Procure o atendimento para conferir o vínculo.");
  const phone = customer.phone;
  const block = await activeBlock(env, c.profile_id, phone);
  if (block) return { ticket, blocked: block };
  await batch(env, [
    [
      "UPDATE queue_tickets SET conversation_id=?,phone=?,updated=? WHERE id=? AND profile_id=? AND (conversation_id IS NULL OR conversation_id=?) AND status IN ('waiting','called','serving')",
      [c.id, phone, now(), ticket.id, c.profile_id, c.id],
    ],
    ["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok", [`queue-link:${ticket.id}:claim`]],
    ["DELETE FROM customer_assert WHERE id=?", [`queue-link:${ticket.id}:claim`]],
    ...customerRecordStatements({ profileId: c.profile_id, contactId: customer.contactId, moduleId: "queue", kind: "ticket", recordId: ticket.id, conversationId: c.id, linkedBy: `conversation:${c.id}`, occurredAt: ticket.created_at }),
  ]);
  return {
    ticket: await ticketRow(env, c.profile_id, ticket.id),
    blocked: null,
  };
}
