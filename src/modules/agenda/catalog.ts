// Cadastros da Agenda: serviços, profissionais (com serviços e horário de
// trabalho) e folgas/bloqueios. As escritas rodam como comandos do módulo
// (Coordinator da área); só administradores alteram os cadastros.
import { all, batch, exec, one } from "../../db";
import { admin } from "../../security";
import { ApiError, type Actor, now, requireValue, uid } from "../../types";
import type { ModuleContext } from "../api";
import {
  addDays,
  clockOfMinute,
  DAY_MS,
  dayStart,
  minuteOf,
  validDate,
} from "./config";

export const SERVICES_LIMIT = 100;
export const PROFESSIONALS_LIMIT = 100;

export interface Service {
  id: string;
  name: string;
  description: string;
  duration_minutes: number;
  price_cents: number | null;
  active: boolean;
  position: number;
}
export interface WorkInterval {
  weekday: number;
  start: string;
  end: string;
}
export interface Professional {
  id: string;
  name: string;
  user_id: string | null;
  active: boolean;
  position: number;
  service_ids: string[];
  hours: WorkInterval[];
}
export interface Block {
  id: string;
  professional_id: string | null;
  starts: number;
  ends: number;
  reason: string;
  created_by: string;
  created: number;
}

const text = (
  value: unknown,
  max: number,
  what: string,
  required = false,
): string => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase() + what.slice(1)} com até ${max} caracteres.`,
  );
  return (value as string).trim();
};
const flag = (value: unknown, fallback: boolean, what: string) => {
  if (value === undefined) return fallback;
  requireValue(typeof value === "boolean", `${what}: verdadeiro ou falso.`);
  return value as boolean;
};
const position = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 9999,
    "Posição de 0 a 9999.",
  );
  return value as number;
};

export const serviceView = (row: any): Service => ({
  id: row.id,
  name: row.name,
  description: row.description || "",
  duration_minutes: row.duration_minutes,
  price_cents: row.price_cents ?? null,
  active: !!row.active,
  position: row.position,
});

export async function listServices(ctx: ModuleContext, activeOnly = false) {
  const rows = await all(
    ctx.env,
    `SELECT * FROM agenda_services WHERE profile_id=? AND archived=0${activeOnly ? " AND active=1" : ""} ORDER BY position,name`,
    ctx.profile,
  );
  return rows.map(serviceView);
}

export async function listProfessionals(
  ctx: ModuleContext,
  activeOnly = false,
): Promise<Professional[]> {
  const [rows, links, hours] = await Promise.all([
    all(
      ctx.env,
      `SELECT * FROM agenda_professionals WHERE profile_id=? AND archived=0${activeOnly ? " AND active=1" : ""} ORDER BY position,name`,
      ctx.profile,
    ),
    all(
      ctx.env,
      "SELECT professional_id,service_id FROM agenda_professional_services WHERE profile_id=?",
      ctx.profile,
    ),
    all(
      ctx.env,
      "SELECT * FROM agenda_hours WHERE profile_id=? ORDER BY weekday,start_minute",
      ctx.profile,
    ),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    user_id: row.user_id || null,
    active: !!row.active,
    position: row.position,
    service_ids: links
      .filter((l) => l.professional_id === row.id)
      .map((l) => l.service_id),
    hours: hours
      .filter((h) => h.professional_id === row.id)
      .map((h) => ({
        weekday: h.weekday,
        start: clockOfMinute(h.start_minute),
        end: clockOfMinute(h.end_minute),
      })),
  }));
}

export async function listBlocks(
  ctx: ModuleContext,
  from: number,
  to: number,
): Promise<Block[]> {
  return (
    await all(
      ctx.env,
      "SELECT * FROM agenda_blocks WHERE profile_id=? AND starts<? AND ends>? ORDER BY starts",
      ctx.profile,
      to,
      from,
    )
  ).map((row) => ({
    id: row.id,
    professional_id: row.professional_id || null,
    starts: row.starts,
    ends: row.ends,
    reason: row.reason,
    created_by: row.created_by,
    created: row.created,
  }));
}

// ---------------------------------------------------------------------------
// Serviços

export async function saveService(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM agenda_services WHERE id=? AND profile_id=? AND archived=0",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing)
    throw new ApiError(404, "not_found", "Serviço não encontrado.");
  if (!existing) {
    const count = await one(
      ctx.env,
      "SELECT count(*) AS n FROM agenda_services WHERE profile_id=? AND archived=0",
      ctx.profile,
    );
    requireValue(
      count.n < SERVICES_LIMIT,
      `Cadastre até ${SERVICES_LIMIT} serviços.`,
    );
  }
  const base = existing ? serviceView(existing) : null;
  const name =
    data.name === undefined && base
      ? base.name
      : text(data.name, 80, "o nome do serviço", true);
  const description =
    data.description === undefined && base
      ? base.description
      : text(data.description, 300, "a descrição");
  const duration = data.duration_minutes ?? base?.duration_minutes;
  requireValue(
    Number.isInteger(duration) &&
      duration >= 5 &&
      duration <= 720 &&
      duration % 5 === 0,
    "Duração de 5 a 720 minutos, em múltiplos de 5.",
  );
  let price = base ? base.price_cents : null;
  if (data.price_cents !== undefined) {
    requireValue(
      data.price_cents === null ||
        (Number.isInteger(data.price_cents) &&
          data.price_cents >= 0 &&
          data.price_cents <= 100000000),
      "Preço em centavos, de 0 a 100000000, ou vazio.",
    );
    price = data.price_cents;
  }
  const active = flag(data.active, base ? base.active : true, "Ativo");
  const pos = position(data.position, base ? base.position : 0);
  const id = existing?.id || uid(),
    at = now();
  if (existing)
    await exec(
      ctx.env,
      "UPDATE agenda_services SET name=?,description=?,duration_minutes=?,price_cents=?,active=?,position=?,updated=? WHERE id=?",
      name,
      description,
      duration,
      price,
      active ? 1 : 0,
      pos,
      at,
      id,
    );
  else
    await exec(
      ctx.env,
      "INSERT INTO agenda_services(id,profile_id,name,description,duration_minutes,price_cents,active,position,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      ctx.profile,
      name,
      description,
      duration,
      price,
      active ? 1 : 0,
      pos,
      at,
      at,
    );
  return serviceView(
    await one(ctx.env, "SELECT * FROM agenda_services WHERE id=?", id),
  );
}

export async function archiveService(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT id FROM agenda_services WHERE id=? AND profile_id=? AND archived=0",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Serviço não encontrado.");
  await batch(ctx.env, [
    [
      "UPDATE agenda_services SET archived=1,active=0,updated=? WHERE id=?",
      [now(), id],
    ],
    ["DELETE FROM agenda_professional_services WHERE service_id=?", [id]],
  ]);
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Profissionais

function validateHours(
  value: unknown,
): { weekday: number; start: number; end: number }[] {
  if (value === undefined) return [];
  requireValue(
    Array.isArray(value) && value.length <= 28,
    "Horário de trabalho: até 28 intervalos.",
  );
  const intervals = (value as any[]).map((raw) => {
    requireValue(
      raw &&
        Number.isInteger(raw.weekday) &&
        raw.weekday >= 0 &&
        raw.weekday <= 6,
      "Dia da semana de 0 (domingo) a 6 (sábado).",
    );
    const start = minuteOf(raw.start),
      end = minuteOf(raw.end);
    requireValue(
      start !== null && end !== null && start < 1440,
      "Informe o horário de trabalho no formato HH:MM.",
    );
    requireValue(
      start < end,
      "O fim do intervalo precisa ser depois do início.",
    );
    return { weekday: raw.weekday as number, start, end };
  });
  intervals.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
  for (let i = 1; i < intervals.length; i++)
    requireValue(
      intervals[i].weekday !== intervals[i - 1].weekday ||
        intervals[i].start >= intervals[i - 1].end,
      "Os intervalos de um mesmo dia não podem se sobrepor.",
    );
  return intervals;
}

export async function saveProfessional(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  admin(actor);
  const existing = data.id
    ? await one(
        ctx.env,
        "SELECT * FROM agenda_professionals WHERE id=? AND profile_id=? AND archived=0",
        data.id,
        ctx.profile,
      )
    : null;
  if (data.id && !existing)
    throw new ApiError(404, "not_found", "Profissional não encontrado.");
  if (!existing) {
    const count = await one(
      ctx.env,
      "SELECT count(*) AS n FROM agenda_professionals WHERE profile_id=? AND archived=0",
      ctx.profile,
    );
    requireValue(
      count.n < PROFESSIONALS_LIMIT,
      `Cadastre até ${PROFESSIONALS_LIMIT} profissionais.`,
    );
  }
  const name =
    data.name === undefined && existing
      ? existing.name
      : text(data.name, 80, "o nome do profissional", true);
  let user = existing?.user_id || null;
  if (data.user_id !== undefined) {
    user = data.user_id || null;
    if (user) {
      const person = await one(
        ctx.env,
        "SELECT id,role,profiles FROM users WHERE id=?",
        user,
      );
      requireValue(
        person &&
          (person.role === "admin" ||
            (JSON.parse(person.profiles || "[]") as string[]).includes(
              ctx.profile,
            )),
        "Pessoa da equipe não encontrada nesta área.",
      );
    }
  }
  const active = flag(
    data.active,
    existing ? !!existing.active : true,
    "Ativo",
  );
  const pos = position(data.position, existing ? existing.position : 0);
  let services: string[] | null = null;
  if (data.service_ids !== undefined) {
    requireValue(
      Array.isArray(data.service_ids) &&
        data.service_ids.length <= SERVICES_LIMIT &&
        data.service_ids.every((s: unknown) => typeof s === "string"),
      "Serviços do profissional inválidos.",
    );
    services = [...new Set(data.service_ids as string[])];
    if (services.length) {
      const known = await all(
        ctx.env,
        `SELECT id FROM agenda_services WHERE profile_id=? AND archived=0 AND id IN (${services.map(() => "?").join(",")})`,
        ctx.profile,
        ...services,
      );
      requireValue(
        known.length === services.length,
        "Algum serviço escolhido não existe.",
      );
    }
  }
  const hours = data.hours !== undefined ? validateHours(data.hours) : null;
  const id = existing?.id || uid(),
    at = now();
  const writes: [string, any[]][] = [
    existing
      ? [
          "UPDATE agenda_professionals SET name=?,user_id=?,active=?,position=?,updated=? WHERE id=?",
          [name, user, active ? 1 : 0, pos, at, id],
        ]
      : [
          "INSERT INTO agenda_professionals(id,profile_id,name,user_id,active,position,created,updated) VALUES(?,?,?,?,?,?,?,?)",
          [id, ctx.profile, name, user, active ? 1 : 0, pos, at, at],
        ],
  ];
  if (services) {
    writes.push([
      "DELETE FROM agenda_professional_services WHERE professional_id=?",
      [id],
    ]);
    for (const service of services)
      writes.push([
        "INSERT INTO agenda_professional_services(profile_id,professional_id,service_id) VALUES(?,?,?)",
        [ctx.profile, id, service],
      ]);
  }
  if (hours) {
    writes.push(["DELETE FROM agenda_hours WHERE professional_id=?", [id]]);
    for (const h of hours)
      writes.push([
        "INSERT INTO agenda_hours(profile_id,professional_id,weekday,start_minute,end_minute) VALUES(?,?,?,?,?)",
        [ctx.profile, id, h.weekday, h.start, h.end],
      ]);
  }
  await batch(ctx.env, writes);
  return (await listProfessionals(ctx)).find((p) => p.id === id)!;
}

export async function archiveProfessional(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  admin(actor);
  const row = await one(
    ctx.env,
    "SELECT id FROM agenda_professionals WHERE id=? AND profile_id=? AND archived=0",
    id,
    ctx.profile,
  );
  if (!row)
    throw new ApiError(404, "not_found", "Profissional não encontrado.");
  await exec(
    ctx.env,
    "UPDATE agenda_professionals SET archived=1,active=0,updated=? WHERE id=?",
    now(),
    id,
  );
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Folgas e bloqueios

/**
 * Bloqueio por instante ({starts, ends} em ms) ou por dias inteiros de
 * Brasília ({date, until?}), com horário opcional ({date, start, end}).
 */
export function blockRange(data: any): { starts: number; ends: number } {
  if (data.date !== undefined) {
    requireValue(validDate(data.date), "Data no formato AAAA-MM-DD.");
    const until = data.until ?? data.date;
    requireValue(
      validDate(until) && until >= data.date,
      "Data final no formato AAAA-MM-DD, igual ou depois da inicial.",
    );
    if (data.start !== undefined || data.end !== undefined) {
      const start = minuteOf(data.start),
        end = minuteOf(data.end);
      requireValue(
        start !== null && end !== null && start < end,
        "Informe início e fim do bloqueio no formato HH:MM.",
      );
      requireValue(
        until === data.date,
        "Bloqueio com horário vale para um dia só.",
      );
      return {
        starts: dayStart(data.date) + start * 60000,
        ends: dayStart(data.date) + end * 60000,
      };
    }
    return { starts: dayStart(data.date), ends: dayStart(addDays(until, 1)) };
  }
  requireValue(
    Number.isInteger(data.starts) && Number.isInteger(data.ends),
    "Informe starts e ends (ms) ou date.",
  );
  requireValue(data.ends > data.starts, "O fim precisa ser depois do início.");
  return { starts: data.starts, ends: data.ends };
}

export async function saveBlock(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const range = blockRange(data);
  requireValue(
    range.ends - range.starts <= 366 * DAY_MS,
    "Bloqueio de até 366 dias.",
  );
  const professional = data.professional_id || null;
  if (professional)
    requireValue(
      await one(
        ctx.env,
        "SELECT id FROM agenda_professionals WHERE id=? AND profile_id=? AND archived=0",
        professional,
        ctx.profile,
      ),
      "Profissional não encontrado.",
    );
  const id = uid();
  await exec(
    ctx.env,
    "INSERT INTO agenda_blocks(id,profile_id,professional_id,starts,ends,reason,created_by,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    ctx.profile,
    professional,
    range.starts,
    range.ends,
    text(data.reason, 120, "o motivo"),
    actor.id,
    now(),
  );
  return (await listBlocks(ctx, range.starts, range.ends)).find(
    (b) => b.id === id,
  )!;
}

export async function deleteBlock(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  admin(actor);
  const done = await exec(
    ctx.env,
    "DELETE FROM agenda_blocks WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!done.meta?.changes)
    throw new ApiError(404, "not_found", "Bloqueio não encontrado.");
  return { id, deleted: true };
}
