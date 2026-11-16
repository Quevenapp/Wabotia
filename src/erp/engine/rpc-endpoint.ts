// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { callRpc } from "./registry.ts";
import { Clock } from "./time.ts";

const clocks = new WeakMap<DurableObjectState, Clock>();

export async function handleRpc(
  ctx: DurableObjectState,
  _profile: string,
  name: string,
  request: Request,
): Promise<Response> {
  let args: unknown;
  try {
    args = await request.json();
  } catch {
    args = null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return Response.json({ code: "22023", message: "erp_rpc_body_invalid" }, { status: 400 });
  let clock = clocks.get(ctx);
  if (!clock) clocks.set(ctx, (clock = new Clock()));
  try {
    const result = callRpc(storageDriver(ctx.storage), name, args as Record<string, unknown>, clock);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ErpError)
      return Response.json(
        { code: error.code, message: error.message, details: null, hint: null },
        { status: error.code === "0A000" ? 501 : 400 },
      );
    throw error;
  }
}
