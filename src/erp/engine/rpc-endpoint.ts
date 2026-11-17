// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver, type SqlDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { ErpGateDenied, callRpc, rpcObjectKeys, rpcWakes, rpcWantsListing, type StoredListing, type StoredObject } from "./registry.ts";
import { GATE_DENIED_HEADER, GATE_HEADER, IDENTITY_HEADER, decodeIdentity } from "./identity.ts";
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
