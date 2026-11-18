// Rota /erp-rpc/<nome> do objeto erp: (engine/rpc-endpoint.ts), defesa em
// profundidade pedida pela orquestração (17/11, N-consulta-leituras.md):
// - as RPCs do agendador e da plataforma (SYSTEM_RPCS) só com a marca de
//   chamada interna (SYSTEM_HEADER), que só a costura da erp-api põe;
// - nome fora do registro e fora do oráculo: 404 com erro claro;
// - o agendador do objeto chama callRpc direto e segue passando.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { SYSTEM_RPCS } from "../src/erp/engine/rpc-endpoint";
import { SYSTEM_HEADER } from "../src/erp/engine/identity";
import { callRpc, isPorted } from "../src/erp/engine/registry";
import { storageDriver } from "../src/erp/engine/driver";

const post = (profile: string, name: string, body: unknown, headers: Record<string, string> = {}) =>
  erpFetch(env, profile, `/erp-rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("ERP: rota /erp-rpc com as RPCs do agendador", () => {
  it("as 11 RPCs do agendador estão registradas", () => {
    expect(SYSTEM_RPCS.size).toBe(11);
    for (const name of SYSTEM_RPCS) expect(isPorted(name), name).toBe(true);
  });

  it("task_claim e export_chunk sem a marca interna são recusados; com a marca, passam; o agendador segue passando", async () => {
    const profile = uid();
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    const lease = crypto.randomUUID();
    for (const [name, body] of [
      ["erp_platform_task_claim", { p_lease: lease, p_purposes: ["company_export"] }],
      ["erp_platform_export_chunk", { p_task: crypto.randomUUID(), p_lease: lease, p_dataset: "erp_catalog.record", p_offset: 0, p_limit: 10 }],
      ["erp_wabotia_state", { p_action: "read" }],
    ] as const) {
      const r = await post(profile, name, body);
      expect(r.status, name).toBe(403);
      expect(await r.json()).toMatchObject({ code: "42501", message: "erp_rpc_system_only" });
    }
    // Com a marca (o que a costura local-fetch.ts põe): o RPC roda (fila vazia).
    const claimed = await post(profile, "erp_platform_task_claim", { p_lease: lease, p_purposes: ["company_export"] }, { [SYSTEM_HEADER]: "1" });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ task: null });
    // O agendador do objeto: callRpc direto, sem rota e sem marca.
    const direct = await runInDurableObject(erpStub(env, profile), (_i: any, state: DurableObjectState) =>
      callRpc(storageDriver(state.storage), "erp_platform_task_claim", { p_lease: crypto.randomUUID(), p_purposes: ["company_export"] }),
    );
    expect(direct).toMatchObject({ task: null });
  });

  it("nome fora do registro e do oráculo: 404 erp_rpc_unknown; RPC comum segue respondendo", async () => {
    const profile = uid();
    const r = await post(profile, "erp_nao_existe_de_jeito_nenhum", {});
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "PGRST202", message: "erp_rpc_unknown:erp_nao_existe_de_jeito_nenhum" });
    // RPC comum (não do agendador), sem a marca: a rota não recusa por nome.
    const common = await post(profile, "erp_activity_list", {
      p_user_id: crypto.randomUUID(), p_from: null, p_to: null, p_module: null, p_operation: null, p_actor: null, p_query: null, p_limit: 1, p_offset: 0,
    });
    expect(common.status).not.toBe(403);
    expect(common.status).not.toBe(404);
  });
});
