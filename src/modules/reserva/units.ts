// Cadastros da Reserva: unidades reserváveis e bloqueios manuais de datas.
// Só administradores gravam; a leitura segue conversations:read.
import { all, exec, one } from "../../db";
import { admin } from "../../security";
import {
  ApiError,
  type Actor,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import { addDays, brasiliaDate, DAY_MS, dayStart, validDate } from "./config";

export type UnitMode = "daily" | "hourly";
export const UNIT_KINDS = ["room", "house", "court", "hall", "other"] as const;

export interface Unit {
  id: string;
  name: string;
  kind: (typeof UNIT_KINDS)[number];
  description: string;
  capacity: number;
  photos: string[];
  mode: UnitMode;
  price_cents: number;
  active: boolean;
  position: number;
  created: number;
  updated: number;
}

export function unitView(row: any): Unit {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    capacity: row.capacity,
    photos: json(row.photos, []),
    mode: row.mode,
    price_cents: row.price_cents,
    active: !!row.active,
    position: row.position,
    created: row.created,
    updated: row.updated,
  };
}

/** Unidades da área (sem as excluídas); `onlyActive` para o WhatsApp. */
export async function listUnits(ctx: ModuleContext, onlyActive = false) {
  const rows = await all(
    ctx.env,
    `SELECT * FROM reserva_units WHERE profile_id=? AND archived=0${onlyActive ? " AND active=1" : ""} ORDER BY position,name`,
    ctx.profile,
  );
  return rows.map(unitView);
}

/** Uma unidade, inclusive excluída (reservas antigas a mostram). */
export async function getUnit(ctx: ModuleContext, id: string) {
  const row = await one(
    ctx.env,
    "SELECT * FROM reserva_units WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Unidade não encontrada.");
  return unitView(row);
}

const text = (value: unknown, max: number, what: string, required = false) => {
  if (value === undefined || value === null) value = "";
  requireValue(typeof value === "string", `${what}: texto inválido.`);
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  requireValue(
    Array.from(out).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  return out;
};

function photosOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  requireValue(
    Array.isArray(value) && value.length <= 6,
    "Fotos: até 6 endereços.",
  );
  return (value as unknown[]).map((raw) => {
    requireValue(
      typeof raw === "string" && raw.length <= 500,
      "Foto: endereço inválido.",
    );
    let url: URL;
    try {
      url = new URL(raw as string);
    } catch {
      throw new ApiError(
        400,
        "invalid_request",
        "Foto: use um endereço https:// completo.",
      );
    }
    requireValue(url.protocol === "https:", "Foto: use um endereço https://.");
    return url.toString();
  });
}

/** POST /reserva/units e PUT /reserva/units/:id (administrador). */
export async function saveUnit(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  const old = data.id ? await getUnit(ctx, data.id) : null;
  requireValue(!old || old.id, "Unidade não encontrada.");
  const pick = (key: string) =>
    data[key] !== undefined ? data[key] : (old as any)?.[key];
  const name = text(pick("name"), 80, "o nome da unidade", true);
  const kind = pick("kind") ?? "room";
  requireValue(
    UNIT_KINDS.includes(kind),
    "Tipo: room, house, court, hall ou other.",
  );
  const mode = pick("mode");
  requireValue(
    mode === "daily" || mode === "hourly",
    "Modo de reserva: daily (diárias) ou hourly (por hora).",
  );
  const capacity = pick("capacity") ?? 1;
  requireValue(
    Number.isInteger(capacity) && capacity >= 1 && capacity <= 1000,
    "Capacidade de 1 a 1000 pessoas.",
  );
  const price = pick("price_cents");
  requireValue(
    Number.isInteger(price) && price >= 0 && price <= 100_000_00,
    "Informe o preço em centavos (até R$ 100.000,00).",
  );
  const active = pick("active") ?? true;
  requireValue(typeof active === "boolean", "active: verdadeiro ou falso.");
  const position = pick("position") ?? 0;
  requireValue(
    Number.isInteger(position) && position >= 0 && position <= 10000,
    "Posição inválida.",
  );
  const description = text(pick("description"), 600, "a descrição");
  const photos = photosOf(pick("photos"));
  const at = now();
  const id = old?.id || uid();
  if (old)
    await exec(
      ctx.env,
      "UPDATE reserva_units SET name=?,kind=?,description=?,capacity=?,photos=?,mode=?,price_cents=?,active=?,position=?,updated=? WHERE id=? AND profile_id=?",
      name,
      kind,
      description,
      capacity,
      JSON.stringify(photos),
      mode,
      price,
      active ? 1 : 0,
      position,
      at,
      id,
      ctx.profile,
    );
  else {
    const count = await one(
      ctx.env,
      "SELECT count(*) AS n FROM reserva_units WHERE profile_id=? AND archived=0",
      ctx.profile,
    );
    requireValue((count?.n || 0) < 200, "Limite de 200 unidades por área.");
    await exec(
      ctx.env,
      "INSERT INTO reserva_units(id,profile_id,name,kind,description,capacity,photos,mode,price_cents,active,position,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      ctx.profile,
      name,
      kind,
      description,
      capacity,
      JSON.stringify(photos),
      mode,
      price,
      active ? 1 : 0,
      position,
      at,
      at,
    );
  }
  return getUnit(ctx, id);
}

/** DELETE /reserva/units/:id: arquiva (as reservas antigas continuam). */
export async function archiveUnit(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  admin(actor);
  await getUnit(ctx, id);
  await exec(
    ctx.env,
    "UPDATE reserva_units SET archived=1,active=0,updated=? WHERE id=? AND profile_id=?",
    now(),
    id,
    ctx.profile,
  );
  return { id, archived: true };
}

// ---------------------------------------------------------------------------
// Bloqueios

export interface Block {
  id: string;
  unit_id: string | null;
  starts: number;
  ends: number;
  /** Dias de Brasília cobertos (o último inclusive). */
  from_date: string;
  to_date: string;
  reason: string;
  created_by: string;
  created: number;
}

export const blockView = (row: any): Block => ({
  id: row.id,
  unit_id: row.unit_id || null,
  starts: row.starts,
  ends: row.ends,
  from_date: brasiliaDate(row.starts),
  to_date: brasiliaDate(row.ends - 1),
  reason: row.reason,
  created_by: row.created_by,
  created: row.created,
});

export async function listBlocks(ctx: ModuleContext, from: number, to: number) {
  const rows = await all(
    ctx.env,
    "SELECT * FROM reserva_blocks WHERE profile_id=? AND starts<? AND ends>? ORDER BY starts LIMIT 1000",
    ctx.profile,
    to,
    from,
  );
  return rows.map(blockView);
}

/**
 * POST /reserva/blocks (administrador): `{unit_id?, from_date, to_date?}`
 * bloqueia dias inteiros (o último inclusive); `{unit_id?, starts, ends}`
 * bloqueia um intervalo (unidades por hora). Não apaga reservas existentes.
 */
export async function saveBlock(ctx: ModuleContext, actor: Actor, data: any) {
  admin(actor);
  let starts: number, ends: number;
  if (data.from_date !== undefined) {
    requireValue(validDate(data.from_date), "from_date no formato AAAA-MM-DD.");
    const to = data.to_date ?? data.from_date;
    requireValue(
      validDate(to) && to >= data.from_date,
      "to_date no formato AAAA-MM-DD, igual ou depois de from_date.",
    );
    starts = dayStart(data.from_date);
    ends = dayStart(addDays(to, 1));
  } else {
    starts = data.starts;
    ends = data.ends;
    requireValue(
      Number.isInteger(starts) && Number.isInteger(ends) && ends > starts,
      "Informe from_date (e to_date) ou starts e ends em milissegundos.",
    );
  }
  requireValue(ends - starts <= 400 * DAY_MS, "Bloqueie até 400 dias por vez.");
  const unit = data.unit_id ?? null;
  if (unit !== null) {
    requireValue(typeof unit === "string", "unit_id inválido.");
    await getUnit(ctx, unit);
  }
  const reason = text(data.reason, 200, "o motivo");
  const id = uid();
  await exec(
    ctx.env,
    "INSERT INTO reserva_blocks(id,profile_id,unit_id,starts,ends,reason,created_by,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    ctx.profile,
    unit,
    starts,
    ends,
    reason,
    actor.id,
    now(),
  );
  return blockView(
    await one(ctx.env, "SELECT * FROM reserva_blocks WHERE id=?", id),
  );
}

export async function deleteBlock(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  admin(actor);
  const removed = await exec(
    ctx.env,
    "DELETE FROM reserva_blocks WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!removed.meta?.changes)
    throw new ApiError(404, "not_found", "Bloqueio não encontrado.");
  return { id, deleted: true };
}
