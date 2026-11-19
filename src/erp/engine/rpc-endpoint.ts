// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver, type SqlDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { ErpGateDenied, callRpc, isPorted, rpcObjectKeys, rpcWakes, rpcWantsListing, type StoredListing, type StoredObject } from "./registry.ts";
import { CUSTOMER_BRIDGE_FIELDS, CUSTOMER_BRIDGE_SCAN, CUSTOMER_BRIDGE_USER_ID, GATE_DENIED_HEADER, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, decodeIdentity } from "./identity.ts";
import { SIGNATURES } from "./signatures.generated.ts";
import { ENGINE_SIGNATURES } from "./signatures-engine.ts";

/**
 * RPCs do agendador e da plataforma, sem checagem de quem chama (no Fagoo só
 * têm GRANT para o service_role): na rota /erp-rpc, só com a marca de
 * chamada interna (SYSTEM_HEADER). Defesa em profundidade: o cliente nunca
 * escolhe nome de RPC nem p_user_id (as rotas da erp-api escolhem), mas um
 * caminho novo que repasse nome vindo de fora não alcança estas
 * (N-consulta-leituras.md; tests/erp-do-rpc-system.test.ts).
 */
export const SYSTEM_RPCS: ReadonlySet<string> = new Set([
  "erp_platform_schedule",
  "erp_platform_task_claim",
  "erp_platform_task_progress",
  "erp_platform_task_finish",
  "erp_platform_notifications_run",
  "erp_platform_export_plan",
  "erp_platform_export_chunk",
  "erp_platform_export_complete",
  "erp_platform_export_expired",
  "erp_platform_export_removed",
  "erp_wabotia_state",
]);
import { Clock } from "./time.ts";

const clocks = new WeakMap<DurableObjectState, Clock>();

const mirrorRecord = (record: Record<string, unknown>) => Object.fromEntries(
  ["id", "version", "name", "phone", "mobile", "email", "document", "person_type"].map((key) => [key, record[key]]),
);
/** O executor técnico não recebe classificações, observações ou ficha ampliada. */
function bridgeResponse(name: string, value: unknown): unknown {
  const result = value as Record<string, any>;
  if (name === "erp_catalog_contact_get" || name === "erp_catalog_contact_save")
    return { entity: "contacts", record: mirrorRecord(result.record), replayed: result.replayed === true };
  if (name === "erp_catalog_contact_page")
    return { items: result.items.map(mirrorRecord), total: result.total };
  return { warnings: result.warnings.map((warning: Record<string, any>) => ({
    code: warning.code, total: warning.total, blocked: warning.blocked,
    matches: warning.matches?.map((match: Record<string, unknown>) => ({ id: match.id })),
  })) };
}

/** O relógio monotônico do objeto, o mesmo para os RPCs e o agendador (src/erp/scheduler/). */
export function engineClock(ctx: DurableObjectState): Clock {
  let clock = clocks.get(ctx);
  if (!clock) clocks.set(ctx, (clock = new Clock()));
  return clock;
}

/** Chave no R2 de um objeto do ERP ("bucket/nome" do Supabase), por área. */
export const erpObjectKey = (profile: string, key: string) => `erp-storage/${profile}/${key}`;

/**
 * O que o RPC lê do armazenamento, do R2, antes da transação (que é
 * síncrona): os objetos que ele declarou em registerRpc(…, { objects }) e,
 * com { listing: true }, todos os objetos da área. Usado pela rota /erp-rpc e
 * pelo agendador (src/erp/scheduler/files.ts).
 */
export async function rpcStorage(
  profile: string,
  name: string,
  args: Record<string, unknown>,
  media?: R2Bucket,
  db?: SqlDriver,
): Promise<{ objects: (key: string) => StoredObject | null; listing: StoredListing[] }> {
  const found = new Map<string, StoredObject>();
  for (const key of rpcObjectKeys(name, args, db)) {
    const head = media ? await media.head(erpObjectKey(profile, key)) : null;
    if (head) found.set(key, { size: head.size, mimetype: head.httpMetadata?.contentType ?? "" });
  }
  // Todos os objetos da área, para quem soma o armazenamento (erp_access_storage).
  const listing: StoredListing[] = [];
  if (media && rpcWantsListing(name)) {
    const prefix = erpObjectKey(profile, "");
    let cursor: string | undefined;
    do {
      const page = await media.list({ prefix, cursor });
      for (const o of page.objects) {
        const [bucket, ...rest] = o.key.slice(prefix.length).split("/");
        // Partes temporárias de um envio em andamento (src/erp-storage.ts,
        // <bucket>/.upload/<id>/<n>): no Supabase não aparecem em storage.objects.
        if (rest[0] === ".upload") continue;
        if (bucket && rest.length) listing.push({ bucket, name: rest.join("/"), size: o.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return { objects: (k) => found.get(k) ?? null, listing };
}

/** Em quanto tempo o agendador acorda depois de um RPC com { wake: true }. */
export const RPC_WAKE_MS = 1_000;

/** Antecipa o alarme do objeto para daqui a RPC_WAKE_MS; nunca adia um alarme mais cedo. */
export async function wakeSoon(ctx: DurableObjectState) {
  const at = Date.now() + RPC_WAKE_MS;
  const current = await ctx.storage.getAlarm();
  if (current === null || current > at) await ctx.storage.setAlarm(at);
}

export async function handleRpc(
  ctx: DurableObjectState,
  profile: string,
  name: string,
  request: Request,
  media?: R2Bucket,
): Promise<Response> {
  // Nome fora do registro e fora do oráculo: erro claro, como o PGRST202 do
  // PostgREST (função que o oráculo tem e o motor ainda não portou continua
  // 0A000 visível, pelo callRpc).
  if (name !== CUSTOMER_BRIDGE_SCAN && !isPorted(name) && !(name in SIGNATURES) && !(name in ENGINE_SIGNATURES))
    return Response.json({ code: "PGRST202", message: `erp_rpc_unknown:${name}`, details: null, hint: null }, { status: 404 });
  if (SYSTEM_RPCS.has(name) && request.headers.get(SYSTEM_HEADER) !== "1")
    return Response.json({ code: "42501", message: "erp_rpc_system_only", details: null, hint: null }, { status: 403 });
  let args: unknown;
  try {
    args = await request.json();
  } catch {
    args = null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return Response.json({ code: "22023", message: "erp_rpc_body_invalid" }, { status: 400 });
  const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
  const a = args as Record<string, unknown>;
  const bridge = identity.actor?.user_id === CUSTOMER_BRIDGE_USER_ID;
  const denied = () => Response.json({ code: "42501", message: "erp_customer_bridge_scope" }, { status: 403 });
  if (bridge) {
    if (!identity.actor?.is_agent || identity.actor.erp_role !== "vendas" || identity.actor.session_id !== null ||
        identity.actor.aal !== "aal1" || identity.actor.verified_factor ||
        a.p_user_id !== CUSTOMER_BRIDGE_USER_ID || request.headers.get(GATE_HEADER) !== "1") return denied();
    if (![CUSTOMER_BRIDGE_SCAN, "erp_catalog_contact_get", "erp_catalog_contact_page",
      "erp_catalog_contact_check", "erp_catalog_contact_save"].includes(name)) return denied();
    if (name.endsWith("_save") || name.endsWith("_check")) {
      const data = a.p_data;
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) =>
        !CUSTOMER_BRIDGE_FIELDS.includes(key) && !(key === "roles" && a.p_id === null &&
          JSON.stringify((data as Record<string, unknown>).roles) === '["customer"]'))) return denied();
      if (name.endsWith("_save") && JSON.stringify(a.p_acknowledged) !== "[]") return denied();
    }
  }
  if (name === CUSTOMER_BRIDGE_SCAN && !bridge) return denied();
  const clock = engineClock(ctx);
  const storage = await rpcStorage(profile, name, args as Record<string, unknown>, media, storageDriver(ctx.storage));
  try {
    if (name === CUSTOMER_BRIDGE_SCAN) {
      // Só leitura por ID, sem novo esquema, registro de domínio ou D1 no objeto.
      const after = a.p_after ?? "";
      const limit = a.p_limit;
      if (typeof after !== "string" || (after !== "" && !/^[0-9a-f-]{36}$/.test(after)) ||
          !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20)
        return Response.json({ code: "22023", message: "invalid_cursor" }, { status: 400 });
      const db = storageDriver(ctx.storage);
      const call = (rpc: string, input: Record<string, unknown>) => callRpc(db, rpc,
        { ...input, p_user_id: a.p_user_id }, clock, { identity, gate: true });
      const rows = db.exec("SELECT id FROM erp_catalog__record WHERE entity='contacts' AND id>? ORDER BY id LIMIT ?", after, Number(limit) + 1).rows;
      // Cada GET aplica autorização/portão antes de devolver qualquer dado.
      // Na página vazia também precisa conferir o acesso. Evita executar a
      // listagem (que filtra toda a base) a cada página da varredura por ID.
      if (!rows.length) call("erp_catalog_contact_page", { p_page: 1, p_size: 1, p_sort: "created_desc", p_situation: "all" });
      const items = rows.slice(0, Number(limit)).map(({ id }) => {
        const result = call("erp_catalog_contact_get", { p_id: id }) as { record: Record<string, unknown> };
        const record = result.record;
        return mirrorRecord(record);
      });
      return Response.json({ items, nextCursor: rows.length > Number(limit) ? String(items.at(-1)!.id) : null });
    }
    const result = callRpc(storageDriver(ctx.storage), name, args as Record<string, unknown>, clock, {
      ...storage,
      identity,
      gate: request.headers.get(GATE_HEADER) === "1",
    });
    // RPC que cria tarefa da plataforma (exportação pedida no painel): o
    // agendador acorda em 1 s, sem esperar a próxima acordada (até 1 h).
    if (rpcWakes(name)) await wakeSoon(ctx);
    return Response.json(bridge ? bridgeResponse(name, result) : result);
  } catch (error) {
    // Portão fechado: o RPC não rodou; a costura devolve o erro do Fagoo.
    if (error instanceof ErpGateDenied)
      return Response.json(
        { code: error.code, message: error.message, details: null, hint: null },
        { status: 403, headers: { [GATE_DENIED_HEADER]: error.reason } },
      );
    if (error instanceof ErpError)
      return Response.json(
        { code: error.code, message: error.message, details: null, hint: null },
        { status: error.code === "0A000" ? 501 : 400 },
      );
    throw error;
  }
}
