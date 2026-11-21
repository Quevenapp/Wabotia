/** Aviso do Bling (webhook) numa conta real.
 *
 * O Bling chama o endereço público da área quando um pedido de venda, produto,
 * estoque ou nota muda. O Worker confere a assinatura (cabeçalho
 * X-Bling-Signature-256: "sha256=" + HMAC-SHA256 do corpo com o segredo do
 * aplicativo da área, lido do cofre), guarda só o essencial do evento no D1
 * (migração 0280; repetição do mesmo evento não duplica) e acorda o objeto da
 * área. Na acordada, o objeto confere a empresa vinculada (companyId do aviso
 * contra a conta gravada pela prova de conta), marca a entidade como avisada
 * (wb_bling_webhook_hint, versão 32) e a coleta daquela entidade roda já, em
 * vez de esperar o ritmo. A consulta periódica continua como reserva, mais
 * espaçada (BLING_WEBHOOK_RESERVE_MS) para quem tem aviso; quem não tem segue
 * o ritmo de sempre. Nenhum dado do aviso entra no ERP direto: o que muda vem
 * pela coleta, com as mesmas conferências. Desligado, o aviso é ignorado.
 *
 * Parte leve: importado pelo Worker e pela montagem; sem motor do ERP. */
import type { Env } from "../../types.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { createBlingVault } from "./vault.ts";

/** Recurso do evento do Bling → entidade da coleta. Os outros são ignorados. */
export const BLING_WEBHOOK_RESOURCES: Readonly<Record<string, string>> = Object.freeze({
  order: "sales_orders", product: "products", stock: "stock_balances", invoice: "nfe", consumer_invoice: "nfce",
});
/** Consulta de reserva para a entidade com aviso ligado. */
export const BLING_WEBHOOK_RESERVE_MS = 2 * 3_600_000;
export const BLING_WEBHOOK_SIGNATURE_HEADER = "x-bling-signature-256";
const BODY_LIMIT = 65_536;
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: privateHeaders });
const one = (db: SqlDriver, sql: string, ...params: unknown[]): Row | undefined => db.exec(sql, ...params).rows[0];
const encoder = new TextEncoder();

export async function blingWebhookSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export interface BlingWebhookEvent { event_id: string; entity: string; action: string; source_id: string | null; company_id: string }
/** Lê o essencial do aviso. null: formato que não é de aviso do Bling. undefined: recurso que a coleta não usa. */
export function parseBlingWebhook(body: unknown): BlingWebhookEvent | null | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const eventId = typeof b.eventId === "string" ? b.eventId : null, event = typeof b.event === "string" ? b.event : null;
  const company = typeof b.companyId === "string" ? b.companyId : typeof b.companyId === "number" ? String(b.companyId) : null;
  if (!eventId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(eventId) || !event || !/^[a-z_]{1,40}\.[a-z_]{1,40}$/.test(event)
      || !company || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(company)) return null;
  const [resource, action] = event.split(".");
  const entity = BLING_WEBHOOK_RESOURCES[resource];
  if (!entity) return undefined;
  const data = b.data && typeof b.data === "object" ? b.data as Record<string, unknown> : null;
  const id = data?.id, source = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === "string" && /^[1-9]\d{0,39}$/.test(id) ? id : null;
  return { event_id: eventId, entity, action, source_id: source, company_id: company };
}

/** Worker: POST /api/public/erp-bling/:profile/webhook. Sem sessão; só a assinatura. */
export interface BlingWebhookOptions {
  /** Acordar a área (padrão: /erp-wake do objeto da área). */
  wake?(profile: string): Promise<unknown>;
  /** Segredo do aplicativo da área (padrão: o cofre). */
  secret?(profile: string): Promise<string | null>;
}
export async function handleBlingWebhook(env: Pick<Env, "DB">, profile: string, request: Request, options: BlingWebhookOptions = {}): Promise<Response> {
  const wake = options.wake;
  if (request.method !== "POST") return reply(405, { ok: false });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(profile)) return reply(404, { ok: false });
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) return reply(413, { ok: false });
  const text = await request.text();
  if (!text || text.length > BODY_LIMIT) return reply(400, { ok: false });
  const header = request.headers.get(BLING_WEBHOOK_SIGNATURE_HEADER) ?? "";
  const signature = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim())?.[1]?.toLowerCase();
  if (!signature) return reply(401, { ok: false });
  let secret: string | null = null;
  try { secret = options.secret ? await options.secret(profile) : (await createBlingVault(env as Env).read(profile)).value.application?.client_secret ?? null; } catch { secret = null; }
  if (!secret || !sameText(await blingWebhookSignature(secret, text), signature)) return reply(401, { ok: false });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply(400, { ok: false }); }
  const event = parseBlingWebhook(body);
  if (event === null) return reply(400, { ok: false });
  // Recurso que a coleta não usa: aceito (o Bling não repete), nada guardado.
  if (event === undefined) return reply(200, { ok: true, ignored: true });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO erp_bling_webhook_event(profile_id,event_id,entity,action,source_id,company_id,received_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(profile, event.event_id, event.entity, event.action.slice(0, 40), event.source_id, event.company_id, now),
    // Limpeza: avisos já lidos há mais de sete dias.
    env.DB.prepare("DELETE FROM erp_bling_webhook_event WHERE profile_id=? AND consumed_at IS NOT NULL AND consumed_at<?").bind(profile, now - 7 * 86_400_000),
  ]);
  try {
    if (wake) await wake(profile);
    else {
      const { erpFetch } = await import("../hub.ts");
      await erpFetch(env as Env, profile, "/erp-wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
  } catch { /* o aviso fica guardado; a próxima acordada lê */ }
  return reply(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Objeto da área (SQLite da versão 32)

/** O aviso está ligado nesta área? Sem tabela, não. */
export function webhookEnabled(db: SqlDriver): boolean {
  try { return Number(one(db, "SELECT enabled FROM wb_bling_return_setting WHERE kind='webhook'")?.enabled ?? 0) === 1; } catch { return false; }
}
/** Entidade avisada → horário do último aviso. Desligado, vazio. */
export function webhookHints(db: SqlDriver): ReadonlyMap<string, number> {
  if (!webhookEnabled(db)) return new Map();
  try {
    return new Map(db.exec("SELECT entity, pending_since FROM wb_bling_webhook_hint WHERE pending_since IS NOT NULL").rows.map(r => [String(r.entity), Number(r.pending_since)]));
  } catch { return new Map(); }
}
/** Ritmo da consulta de reserva para a entidade que tem aviso (null: o ritmo de sempre). */
export function webhookPace(db: SqlDriver, entity: string | undefined, base: number | null): number | null {
  if (!entity || !webhookEnabled(db)) return base;
  try {
    const seen = one(db, "SELECT 1 AS x FROM wb_bling_webhook_hint WHERE entity=?", entity);
    return seen ? Math.max(base ?? 0, BLING_WEBHOOK_RESERVE_MS) : base;
  } catch { return base; }
}
export interface WebhookEventSource {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
}
/** Lê os avisos guardados pelo Worker, confere a empresa e marca as entidades. */
export async function consumeBlingWebhookEvents(source: WebhookEventSource, db: SqlDriver, profile: string, now: number): Promise<number> {
  if (!webhookEnabled(db)) return 0;
  const account = one(db, "SELECT account_id FROM wb_bling_control WHERE id=1")?.account_id;
  const { results } = await source.prepare("SELECT event_id, entity, company_id, received_at FROM erp_bling_webhook_event WHERE profile_id=? AND consumed_at IS NULL ORDER BY received_at LIMIT 50")
    .bind(profile).all<{ event_id: string; entity: string; company_id: string; received_at: number }>();
  if (!results.length) return 0;
  let accepted = 0;
  db.transaction(() => {
    for (const event of results) {
      // Aviso de outra empresa: ignorado (a conta vinculada é a da prova de conta).
      if (!account || String(account) !== event.company_id || !Object.values(BLING_WEBHOOK_RESOURCES).includes(event.entity)) continue;
      db.exec(`INSERT INTO wb_bling_webhook_hint(entity,pending_since,events,last_event_at,updated_at) VALUES(?,?,1,?,?)
        ON CONFLICT(entity) DO UPDATE SET pending_since=max(coalesce(pending_since,0),excluded.pending_since), events=events+1, last_event_at=excluded.last_event_at, updated_at=excluded.updated_at`,
        event.entity, Number(event.received_at), Number(event.received_at), now);
      accepted++;
    }
  });
  const ids = results.map(event => event.event_id);
  await source.prepare("UPDATE erp_bling_webhook_event SET consumed_at=? WHERE profile_id=? AND event_id IN (SELECT value FROM json_each(?))").bind(now, profile, JSON.stringify(ids)).run();
  return accepted;
}
