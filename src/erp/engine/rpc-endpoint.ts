// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { ErpGateDenied, callRpc, rpcObjectKeys, rpcWantsListing, type StoredListing, type StoredObject } from "./registry.ts";
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
  // Objetos do armazenamento que o RPC consulta: lidos do R2 antes da transação.
  const found = new Map<string, StoredObject>();
  for (const key of rpcObjectKeys(name, args as Record<string, unknown>)) {
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
        if (bucket && rest.length) listing.push({ bucket, name: rest.join("/"), size: o.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
  try {
    const result = callRpc(storageDriver(ctx.storage), name, args as Record<string, unknown>, clock, {
      objects: (k) => found.get(k) ?? null,
      listing,
      identity,
      gate: request.headers.get(GATE_HEADER) === "1",
    });
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
