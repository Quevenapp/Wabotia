// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver, type SqlDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { ErpGateDenied, callRpc, isPorted, rpcObjectKeys, rpcWakes, rpcWantsListing, type StoredListing, type StoredObject } from "./registry.ts";
import { GATE_DENIED_HEADER, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, decodeIdentity } from "./identity.ts";
import { SIGNATURES } from "./signatures.generated.ts";
import { ENGINE_SIGNATURES } from "./signatures-engine.ts";
import { requestModuleState } from "./module-state.ts";

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
  if (!isPorted(name) && !(name in SIGNATURES) && !(name in ENGINE_SIGNATURES))
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
  const clock = engineClock(ctx);
  const storage = await rpcStorage(profile, name, args as Record<string, unknown>, media, storageDriver(ctx.storage));
  const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
  try {
    const result = callRpc(storageDriver(ctx.storage), name, args as Record<string, unknown>, clock, {
      ...storage,
      identity,
      modules: requestModuleState(request.headers, request.headers.get(SYSTEM_HEADER) === "1"),
      gate: request.headers.get(GATE_HEADER) === "1",
    });
    // RPC que cria tarefa da plataforma (exportação pedida no painel): o
    // agendador acorda em 1 s, sem esperar a próxima acordada (até 1 h).
    if (rpcWakes(name)) await wakeSoon(ctx);
    return Response.json(result);
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
