/** Fatia D: mão dupla das listas de preços e das definições de campos
 * customizados (de produto e de contato), como a da versão 19: interruptor
 * por tipo e sentido, todos desligados, ligar com aviso e registro; o que muda
 * no Bling entra pelas mesmas funções da adoção; o que muda no ERP vai por uma
 * fila no alarme, uma chamada por acordada, e envio incerto nunca é repetido
 * sozinho (a pessoa diz se entrou ou manda de novo). Naturezas, NFS-e e
 * contratos não estão aqui: nunca voltam ao Bling. Só atualiza no Bling o que
 * veio de lá (PUT no registro ligado); não cria registro novo no Bling. */
import type { SqlDriver } from "../engine/driver.ts";
import type { ErpParts } from "../parts.ts";
import { ERP_PART_MODULES, ERP_PART_NAMES } from "../parts.ts";
import type { BlingContext } from "./contracts.ts";
import { BlingAdoptionError } from "./adoption-contracts.ts";
import { clip, commandUuid, sha, type Json } from "./adoption-store.ts";
import { command, systemIdentity, transaction, type AdoptionCall } from "./adoption.ts";
import { publicCutover } from "./cutover.ts";
import {
  BLING_EXTRAS_OUTBOX_STATES, BLING_EXTRAS_TWO_WAY, BLING_EXTRAS_TWO_WAY_LABELS, BLING_EXTRAS_TWO_WAY_PARTS,
  type BlingExtrasOperationMap, type BlingExtrasOutboxItem, type BlingExtrasOutboxState, type BlingExtrasStatus, type BlingExtrasTwoWayEntity,
} from "./extras-contracts.ts";
import { adoptExtraCollected, applyExtraUpdate, extraLink, readExtraRaw, writeExtraReview } from "./extras.ts";
import type { BlingWritePort } from "./writer.ts";
import { takeCall } from "./two-way.ts";

type Direction = "inbound" | "outbound";
const DEFAULT_PACE = 15 * 60_000;
const iso = (v: unknown) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();
const batchOf = (entity: BlingExtrasTwoWayEntity) => entity === "price_lists" ? "price_lists" as const : "custom_fields" as const;
const moduleOf = (entity: BlingExtrasTwoWayEntity) => entity === "custom_fields_products" ? "products" : entity === "custom_fields_contacts" ? "contacts" : null;
const partsOn = (entity: BlingExtrasTwoWayEntity, parts: Readonly<ErpParts> | null | undefined) => !!parts?.customers && BLING_EXTRAS_TWO_WAY_PARTS[entity].every(part => !!parts[part]);
const partOff = (entity: BlingExtrasTwoWayEntity) => `Para a mão dupla de ${BLING_EXTRAS_TWO_WAY_LABELS[entity].toLowerCase()}, ligue o módulo ${ERP_PART_NAMES[ERP_PART_MODULES[BLING_EXTRAS_TWO_WAY_PARTS[entity][0]]]} em Gestão → Módulos.`;

function setting(db: SqlDriver, entity: BlingExtrasTwoWayEntity, direction: Direction) {
  const r = db.exec("SELECT enabled, enabled_since, next_scan_at, updated_by FROM wb_bling_adoption_extra_twoway WHERE entity=? AND direction=?", entity, direction).rows[0];
  return r ? { enabled: Number(r.enabled) === 1, since: r.enabled_since == null ? null : Number(r.enabled_since), next_scan_at: Number(r.next_scan_at), by: String(r.updated_by) } : { enabled: false, since: null, next_scan_at: 0, by: "" };
}

export function extrasTwoWayStatus(db: SqlDriver, parts: Readonly<ErpParts>): Pick<BlingExtrasStatus, "audit"> & { entities: BlingExtrasStatus["two_way"] } {
  const n = (sql: string, ...args: unknown[]) => Number(db.exec(sql, ...args).rows[0]?.n ?? 0);
  const entities = BLING_EXTRAS_TWO_WAY.map(entity => {
    const inbound = setting(db, entity, "inbound"), outbound = setting(db, entity, "outbound"), enabled = partsOn(entity, parts);
    return { entity, label: BLING_EXTRAS_TWO_WAY_LABELS[entity], enabled, part_off_message: enabled ? null : partOff(entity),
      inbound: { enabled: inbound.enabled, since: iso(inbound.since) }, outbound: { enabled: outbound.enabled, since: iso(outbound.since) },
      queued: n("SELECT count(*) AS n FROM wb_bling_adoption_extra_outbox WHERE entity=? AND state IN ('pending','sending')", entity),
      uncertain: n("SELECT count(*) AS n FROM wb_bling_adoption_extra_outbox WHERE entity=? AND state='uncertain'", entity),
      failed: n("SELECT count(*) AS n FROM wb_bling_adoption_extra_outbox WHERE entity=? AND state='failed'", entity) };
  });
  const audit = db.exec("SELECT * FROM wb_bling_adoption_extra_audit ORDER BY created_at DESC, id DESC LIMIT 20").rows.map(r => ({
    at: iso(r.created_at)!, by: clip(String(r.actor_id), 200)!, entity: String(r.entity) as BlingExtrasTwoWayEntity, direction: String(r.direction) as Direction, enabled: Number(r.enabled) === 1, detail: clip(String(r.detail), 600)! }));
  return { entities, audit };
}

/** Só o administrador, pela tela (o despacho recusa bots). */
export function extrasSwitch(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_switch"]["input"]): BlingExtrasOperationMap["erp_bling_extras_switch"]["output"] {
  if (input.enabled && !partsOn(input.entity, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", partOff(input.entity));
  if (input.enabled && !publicCutover(call.db).cutover_on) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "A mão dupla só funciona depois do corte. Confirme a data de corte em Passar a operar aqui.");
  const result = command(call, "erp_bling_extras_switch", input.command_id, ctx => {
    const actor = call.identity.actor!.user_id, now = call.now(), before = setting(ctx.db, input.entity, input.direction);
    const since = input.enabled ? (before.enabled ? before.since : now) : null;
    ctx.db.exec(`INSERT INTO wb_bling_adoption_extra_twoway(entity,direction,enabled,enabled_since,next_scan_at,updated_by,updated_at) VALUES(?,?,?,?,0,?,?)
      ON CONFLICT(entity,direction) DO UPDATE SET enabled=excluded.enabled, enabled_since=excluded.enabled_since, next_scan_at=0, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      input.entity, input.direction, input.enabled ? 1 : 0, since, actor, now);
    if (before.enabled !== input.enabled)
      ctx.db.exec("INSERT INTO wb_bling_adoption_extra_audit(id,actor_id,entity,direction,enabled,detail,created_at) VALUES(?,?,?,?,?,?,?)",
        commandUuid("bling-extras-audit", input.command_id), actor, input.entity, input.direction, input.enabled ? 1 : 0,
        `${input.enabled ? "Ligou" : "Desligou"} ${input.direction === "inbound" ? "Receber do Bling" : "Escrever no Bling"} em ${BLING_EXTRAS_TWO_WAY_LABELS[input.entity]}${input.enabled ? " (aviso confirmado)" : ""}.`, now);
    return { entity: input.entity, direction: input.direction, enabled: input.enabled, since: iso(since) };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Impressão do ERP e corpo do envio (a partir do último registro lido do Bling)

const linkedBlingProduct = (db: SqlDriver, record: string) => (db.exec("SELECT source_id FROM wb_bling_adoption_link WHERE entity='products' AND record_id=?", record).rows[0]?.source_id as string | undefined) ?? null;
/** O que o ERP manteria igual no Bling; null quando o registro não existe mais. */
export function erpState(db: SqlDriver, entity: BlingExtrasTwoWayEntity, record: string): Json | null {
  if (entity === "price_lists") {
    const list = db.exec("SELECT name FROM erp_pricing__price_list WHERE id=?", record).rows[0];
    if (!list) return null;
    const items = db.exec("SELECT product_id, CAST(custom_price AS TEXT) AS price FROM erp_pricing__price_list_item WHERE list_id=? ORDER BY product_id", record).rows.map(r => [String(r.product_id), r.price == null ? null : String(r.price)]);
    return { name: String(list.name), items };
  }
  if (entity === "custom_fields_products") {
    const f = db.exec("SELECT name, required FROM erp_catalog__custom_field WHERE id=?", record).rows[0];
    if (!f) return null;
    return { name: String(f.name), required: Number(f.required) === 1, options: db.exec("SELECT label FROM erp_catalog__custom_field_option WHERE field_id=? ORDER BY position", record).rows.map(r => String(r.label)) };
  }
  const f = db.exec("SELECT name, required, options FROM erp_catalog__contact_field WHERE id=?", record).rows[0];
  if (!f) return null;
  return { name: String(f.name), required: Number(f.required) === 1, options: (JSON.parse(String(f.options)) as { label: string }[]).map(o => o.label) };
}
export const erpHash = (state: Json) => sha(JSON.stringify(state));
function bodyFor(db: SqlDriver, entity: BlingExtrasTwoWayEntity, source: string, state: Json): { body: Json } | { problem: string } {
  const raw = readExtraRaw(db, batchOf(entity), source);
  const base = raw?.payload ?? {};
  if (entity === "price_lists") {
    const items: Json[] = [];
    for (const [product, price] of state.items as [string, string | null][]) {
      const id = linkedBlingProduct(db, product);
      if (!id) return { problem: "Um produto desta lista não veio do Bling. Adote-o na mão dupla de produtos antes, ou tire-o da lista." };
      items.push({ produto: { id }, preco: price });
    }
    return { body: { ...base, nome: state.name, produtos: items } };
  }
  return { body: { ...base, nome: state.name, obrigatorio: state.required, ...(Array.isArray(base.opcoes) ? { opcoes: (state.options as string[]).map(nome => ({ nome })) } : {}) } };
}
const pathFor = (entity: BlingExtrasTwoWayEntity, source: string) => `${entity === "price_lists" ? "/listas-precos" : "/campos-customizados"}/${source}`;

// ---------------------------------------------------------------------------
// Parte local (sem I/O): entrada e varredura do ERP

const linksOf = (db: SqlDriver, entity: BlingExtrasTwoWayEntity) => {
  const module = moduleOf(entity);
  return db.exec(`SELECT source_id, record_id, source_version, erp_hash FROM wb_bling_adoption_extra_link WHERE entity=? ${module ? "AND json_extract(data,'$.module')=?" : ""} ORDER BY source_id`, batchOf(entity), ...(module ? [module] : [])).rows;
};
/** Próxima varredura local da fatia D (algum interruptor ligado e o corte confirmado). */
export function extrasScanAt(db: { exec(sql: string): { rows?: unknown[]; toArray?(): unknown[] } } | SqlDriver): number | null {
  try {
    const result = (db as SqlDriver).exec("SELECT min(next_scan_at) AS due FROM wb_bling_adoption_extra_twoway WHERE enabled=1 AND EXISTS(SELECT 1 FROM wb_bling_cutover WHERE id=1)");
    const due = result.rows[0]?.due;
    return due == null ? null : Number(due);
  } catch { return null; }
}
export function extrasOutboxAt(db: SqlDriver): number | null {
  try {
    const due = db.exec(`SELECT min(o.not_before) AS due FROM wb_bling_adoption_extra_outbox o WHERE o.state='sending'
      OR (o.state='pending' AND EXISTS(SELECT 1 FROM wb_bling_adoption_extra_twoway s WHERE s.entity=o.entity AND s.direction='outbound' AND s.enabled=1))`).rows[0]?.due;
    return due == null ? null : Number(due);
  } catch { return null; }
}
const pace = (db: SqlDriver) => { try { const r = db.exec("SELECT pace_minutes FROM wb_bling_twoway WHERE id=1").rows[0]; return r ? Number(r.pace_minutes) * 60_000 : DEFAULT_PACE; } catch { return DEFAULT_PACE; } };

export interface ExtrasLocalOptions { db: SqlDriver; profile: string; now(): number; parts: Readonly<ErpParts> }
/** Uma rodada local: até 10 registros recebidos e a varredura do ERP de cada tipo ligado. */
export function runExtrasTwoWayLocal(options: ExtrasLocalOptions): { worked: boolean; more: boolean } {
  const { db, profile, now, parts } = options;
  if (!publicCutover(db).cutover_on) return { worked: false, more: false };
  let worked = false, more = false;
  for (const entity of BLING_EXTRAS_TWO_WAY) {
    if (!partsOn(entity, parts)) continue;
    const inbound = setting(db, entity, "inbound"), outbound = setting(db, entity, "outbound");
    const due = [inbound, outbound].filter(s => s.enabled && s.next_scan_at <= now());
    if (!due.length) continue;
    let left = false;
    if (inbound.enabled && inbound.next_scan_at <= now()) {
      const batch = batchOf(entity), module = moduleOf(entity), since = inbound.since ?? now();
      const rows = db.exec(`SELECT r.source_id, r.version FROM wb_bling_extra_raw r LEFT JOIN wb_bling_adoption_extra_link l ON l.entity=r.entity AND l.source_id=r.source_id
          LEFT JOIN wb_bling_adoption_extra_review v ON v.entity=r.entity AND v.source_id=r.source_id
        WHERE r.entity=? AND r.changed_at>? AND (l.source_id IS NULL OR l.source_version<r.version) AND (v.source_id IS NULL OR v.source_version<r.version)
          ${module ? "AND (l.source_id IS NULL OR json_extract(l.data,'$.module')=?)" : ""}
        ORDER BY r.changed_at, r.source_id LIMIT 11`, batch, since, ...(module ? [module] : [])).rows;
      left = rows.length > 10;
      for (const row of rows.slice(0, 10)) {
        const source = String(row.source_id), at = now();
        try {
          transaction(db, profile, ctx => {
            const link = extraLink(ctx.db, batch, source), raw = readExtraRaw(ctx.db, batch, source);
            if (!raw) return;
            if (!link) { adoptExtraCollected(ctx, batch, source, inbound.by, at, parts); return; }
            const state = erpState(ctx.db, entity, link.record_id);
            // Mudou dos dois lados desde a última sincronização: nada é sobrescrito.
            if (state && link.erp_hash && erpHash(state) !== link.erp_hash) { writeExtraReview(ctx.db, batch, raw, "conflict", [link.record_id], at); return; }
            applyExtraUpdate(ctx, batch, source, inbound.by, at, parts);
            const after = erpState(ctx.db, entity, link.record_id);
            if (after) ctx.db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", erpHash(after), batch, source);
          }, { identity: systemIdentity(inbound.by), parts });
        } catch (error) {
          const raw = readExtraRaw(db, batch, source);
          if (raw) db.transaction(() => writeExtraReview(db, batch, raw, "failed", [], at, error instanceof BlingAdoptionError ? error.detail ?? error.message : null));
        }
        worked = true;
      }
    }
    if (outbound.enabled && outbound.next_scan_at <= now()) {
      db.transaction(() => {
        for (const link of linksOf(db, entity)) {
          const record = String(link.record_id), source = String(link.source_id), state = erpState(db, entity, record);
          if (!state) continue;
          const hash = erpHash(state);
          // Primeira vez: o ERP de agora é o ponto de partida (ligar não reenvia o que já está igual).
          if (!link.erp_hash) { db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", hash, batchOf(entity), source); continue; }
          if (hash === link.erp_hash) continue;
          const raw = readExtraRaw(db, batchOf(entity), source);
          if (raw && raw.version > Number(link.source_version)) continue; // o Bling também mudou: a entrada decide (conflito)
          const id = `x${commandUuid("bling-extras-out", entity, record, hash).replace(/-/g, "")}`;
          if (db.exec("SELECT 1 AS x FROM wb_bling_adoption_extra_outbox WHERE id=?", id).rows.length) continue;
          if (db.exec("SELECT 1 AS x FROM wb_bling_adoption_extra_outbox WHERE entity=? AND record_id=? AND state IN ('sending','uncertain')", entity, record).rows.length) continue;
          db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='superseded', finished_at=?, updated_at=? WHERE entity=? AND record_id=? AND state IN ('pending','failed')", now(), now(), entity, record);
          const built = bodyFor(db, entity, source, state);
          db.exec(`INSERT INTO wb_bling_adoption_extra_outbox(id,entity,record_id,source_id,path,body,erp_hash,state,attempts,not_before,error_text,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,NULL)`,
            id, entity, record, source, pathFor(entity, source), JSON.stringify("body" in built ? built.body : {}), hash, "body" in built ? "pending" : "failed", now(), "problem" in built ? built.problem : null, now(), now());
          worked = true;
        }
      });
    }
    const next = left ? now() : now() + pace(db);
    db.exec("UPDATE wb_bling_adoption_extra_twoway SET next_scan_at=? WHERE entity=? AND enabled=1", next, entity);
    more ||= left;
  }
  return { worked, more };
}

// ---------------------------------------------------------------------------
// Envio (uma chamada HTTP por acordada)

export interface ExtrasOutboundOptions { db: SqlDriver; profile: string; now(): number; parts: Readonly<ErpParts>; writer: BlingWritePort; ctx: BlingContext; deadline: number }
export async function runExtrasOutboundUnit(options: ExtrasOutboundOptions): Promise<{ worked: boolean; nextWake: number | null; requests: 0 | 1 }> {
  const { db, now, writer, ctx, deadline } = options;
  // Queda no meio do envio: o que ficou "enviando" vira conferência da pessoa, sem reenviar.
  db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='uncertain', error_text=?, updated_at=? WHERE state='sending' AND updated_at<?",
    "O envio foi interrompido e não deu para saber se entrou no Bling. Confira lá e diga se entrou ou mande de novo.", now(), now() - 60_000);
  const item = db.exec(`SELECT o.* FROM wb_bling_adoption_extra_outbox o JOIN wb_bling_adoption_extra_twoway s ON s.entity=o.entity AND s.direction='outbound' AND s.enabled=1
    WHERE o.state='pending' AND o.not_before<=? ORDER BY o.not_before, o.created_at LIMIT 1`, now()).rows[0];
  if (!item || deadline - now() < 1_000) return { worked: false, nextWake: extrasOutboxAt(db), requests: 0 };
  const entity = String(item.entity) as BlingExtrasTwoWayEntity;
  if (!partsOn(entity, options.parts)) return { worked: false, nextWake: null, requests: 0 };
  // Mesma reserva da coleta: credencial pronta, intervalo mínimo e teto diário.
  const slot = takeCall(db, now());
  if (!slot.ok) {
    db.exec("UPDATE wb_bling_adoption_extra_outbox SET not_before=?, error_text=?, updated_at=? WHERE id=? AND state='pending'", slot.retry_at, clip(slot.reason, 600), now(), item.id);
    return { worked: false, nextWake: slot.retry_at, requests: 0 };
  }
  db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='sending', attempts=attempts+1, updated_at=? WHERE id=? AND state='pending'", now(), item.id);
  const result = await writer.send(ctx, { method: "PUT", path: String(item.path), body: JSON.parse(String(item.body)), deadline: Math.min(deadline - 250, now() + 3_000) });
  const finish = (state: BlingExtrasOutboxState, error: string | null, notBefore = now()) => db.exec(
    "UPDATE wb_bling_adoption_extra_outbox SET state=?, error_text=?, not_before=?, updated_at=?, finished_at=? WHERE id=?",
    state, error ? clip(error, 600) : null, notBefore, now(), state === "done" || state === "superseded" ? now() : null, item.id);
  db.transaction(() => {
    if (result.kind === "ok") {
      finish("done", null);
      // A linha de base passa a ser a enviada: o eco da coleta não vira conflito.
      db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", item.erp_hash, batchOf(entity), item.source_id);
    } else if (result.kind === "rejected") finish("failed", result.message);
    else if (result.kind === "auth") finish("failed", result.message);
    else if (result.kind === "rate") {
      finish("pending", null, result.retry_at);
      db.exec("UPDATE wb_bling_control SET next_allowed_at=max(coalesce(next_allowed_at,0),?), updated_at=? WHERE id=1", result.retry_at, now());
    }
    else if (result.kind === "not_sent") finish("pending", result.message, result.retry_at);
    else finish("uncertain", "O Bling não respondeu a tempo e não dá para saber se gravou. Confira lá e diga se entrou ou mande de novo; nada é reenviado sozinho.");
  });
  return { worked: true, nextWake: extrasOutboxAt(db), requests: result.kind === "not_sent" ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// Fila na tela

const ACTIONS: Record<string, BlingExtrasOutboxItem["actions"]> = {
  uncertain: [{ action: "confirm_sent", label: "Entrou no Bling" }, { action: "resend", label: "Não entrou: enviar de novo" }],
  failed: [{ action: "resend", label: "Tentar de novo" }, { action: "discard", label: "Deixar como está" }],
};
export function extrasOutbox(call: Pick<AdoptionCall, "db">, input: BlingExtrasOperationMap["erp_bling_extras_outbox"]["input"]): BlingExtrasOperationMap["erp_bling_extras_outbox"]["output"] {
  const state = input.state ?? "open";
  const where = state === "open" ? "state IN ('pending','sending','uncertain','failed')" : state === "done" ? "state IN ('done','superseded')" : "1=1";
  const rows = call.db.exec(`SELECT * FROM wb_bling_adoption_extra_outbox WHERE ${where} ORDER BY updated_at DESC, id LIMIT ?`, input.limit ?? 20).rows;
  return { items: rows.map(r => {
    const entity = String(r.entity) as BlingExtrasTwoWayEntity, s = String(r.state) as BlingExtrasOutboxState;
    const body = JSON.parse(String(r.body)) as Json;
    return { id: String(r.id), entity, label: clip(`${BLING_EXTRAS_TWO_WAY_LABELS[entity]}: ${typeof body.nome === "string" ? body.nome : r.source_id}`, 200)!,
      state: s, state_text: BLING_EXTRAS_OUTBOX_STATES[s], attempts: Number(r.attempts), error_text: r.error_text == null ? null : String(r.error_text), updated_at: iso(r.updated_at), actions: ACTIONS[s] ?? [] };
  }) };
}
export function extrasOutboxResolve(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_outbox_resolve"]["input"]): BlingExtrasOperationMap["erp_bling_extras_outbox_resolve"]["output"] {
  return command(call, "erp_bling_extras_outbox_resolve", input.command_id, ctx => {
    const r = ctx.db.exec("SELECT * FROM wb_bling_adoption_extra_outbox WHERE id=?", input.id).rows[0];
    if (!r) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    const state = String(r.state), now = call.now();
    const allowed = (ACTIONS[state] ?? []).some(a => a.action === input.action);
    if (!allowed) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Este envio já mudou de situação. Atualize a tela.");
    if (input.action === "confirm_sent") {
      ctx.db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='done', error_text=NULL, updated_at=?, finished_at=? WHERE id=?", now, now, input.id);
      ctx.db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", r.erp_hash, batchOf(String(r.entity) as BlingExtrasTwoWayEntity), r.source_id);
      return { outcome: "confirmed" as const, message: "Marcado como gravado no Bling." };
    }
    if (input.action === "resend") {
      ctx.db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='pending', error_text=NULL, not_before=?, updated_at=? WHERE id=?", now, now, input.id);
      return { outcome: "queued" as const, message: "Volta para a fila e sai na próxima rodada (com a escrita ligada)." };
    }
    ctx.db.exec("UPDATE wb_bling_adoption_extra_outbox SET state='superseded', updated_at=?, finished_at=? WHERE id=?", now, now, input.id);
    // Deixar como está: a próxima mudança no ERP volta a ser enviada; esta não.
    ctx.db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", r.erp_hash, batchOf(String(r.entity) as BlingExtrasTwoWayEntity), r.source_id);
    return { outcome: "discarded" as const, message: "O envio foi descartado. O ERP fica como está." };
  });
}
