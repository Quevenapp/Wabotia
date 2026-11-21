// Campos próprios de contato pela rota do Wabotia (src/erp/contact-fields):
// Preferências › Cadastros, cadastro do contato, ficha do atendimento, lista,
// importação e as operações dos bots, com só a parte Cadastros ligada. O motor
// é o de verdade (objeto erp da área); nada sai para a rede.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { uid } from "../src/types";
import { localFetch } from "../src/erp/api/local-fetch";
import { erpIdentity } from "../src/modules/erp/identity";
import { moduleStates } from "../src/modules/registry";
import { ERP_BOT_OPERATIONS, erpBotModules } from "../src/modules/erp/bot-access";
import { erpModule } from "../src/modules/erp/definition";
import { bearer, fixture, type Fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const LOCAL = "https://erp.wabotia.invalid/rest/v1/rpc/";
async function setup() {
  const f = await fixture();
  // Só Cadastros: nada aqui pode pedir Produtos, Vendas ou Financeiro.
  await setModule(f.profile, "erp", true, f.admin.id);
  const token = await bearer(f.admin);
  const send = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await send(new Request(`https://test/api/v1/profiles/${f.profile}/erp-contato-campos${path}`, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": uid() }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { f, call };
}
async function contact(f: Fixture, name: string, roles: string[]) {
  const identity = await erpIdentity(env, f.admin, f.profile);
  const response = await localFetch(env, f.profile, f.admin, identity, { read: false, trackCustomers: false, gate: { denied: null } })(LOCAL + "erp_catalog_contact_save", {
    method: "POST", body: JSON.stringify({ p_user_id: identity.actor!.user_id, p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: { name, person_type: "J", roles }, p_acknowledged: [] }) });
  const body = await response.json<any>();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.record as { id: string };
}

describe("campos próprios de contato", () => {
  it("define em Preferências, preenche no cadastro, mostra na ficha sem o sensível e libera com aviso", { timeout: 120_000 }, async () => {
    const { f, call } = await setup();
    const states = await moduleStates(env, f.profile);
    expect(states["erp-produtos"] || states["erp-vendas"] || states["erp-financeiro"]).toBeFalsy();
    const client = await contact(f, "Cliente dos campos", ["customer"]);
    const size = await call("", "POST", { command_id: uid(), data: { name: "Porte", field_type: "list", roles: ["customer"], options: [{ label: "Pequeno" }, { label: "Grande" }], list_column: true, list_filter: true } });
    expect(size.status, JSON.stringify(size.body)).toBe(200);
    expect(size.body.saved).toBe(true);
    const secret = (await call("", "POST", { command_id: uid(), data: { name: "Saúde", field_type: "text", roles: ["customer"], sensitive: true } })).body.field;
    const duplicate = await call("", "POST", { command_id: uid(), data: { name: "porte", field_type: "text", roles: ["supplier"] } });
    expect(duplicate.body).toMatchObject({ saved: false, reason: "duplicate_name" });
    const bad = await call("", "POST", { command_id: uid(), data: { name: "Sem papel", field_type: "text", roles: [] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/tipos de contato/);

    // Cadastro: validação com a mensagem do campo; nada gravado com erro.
    const wrong = await call(`/contato/${client.id}`, "PUT", { command_id: uid(), valores: { [size.body.field.id]: "Médio" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/Porte/);
    expect(wrong.body.error.campos[0]).toMatchObject({ field_id: size.body.field.id, code: "list" });
    const saved = await call(`/contato/${client.id}`, "PUT", { command_id: uid(), valores: { [size.body.field.id]: "Grande", [secret.id]: "Alergia" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(Object.keys(saved.body.values).sort()).toEqual([size.body.field.id, secret.id].sort());

    // Ficha do atendimento: só leitura, sem o sensível não liberado.
    const card = await call(`/contato/${client.id}?para=ficha`);
    expect(card.body.fields.map((x: any) => x.id)).toEqual([size.body.field.id]);
    expect(card.body.hidden).toBe(1);
    // Lista: coluna e filtro.
    const columns = await call("/valores", "POST", { ids: [client.id] });
    expect(columns.body.items[0].values).toEqual({ [size.body.field.id]: size.body.field.options[1].id });
    const filtered = await call(`/lista?situation=all&campos=${encodeURIComponent(JSON.stringify([{ field_id: size.body.field.id, value: "Grande" }]))}`);
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.items.map((x: any) => x.id)).toEqual([client.id]);

    // Liberar o sensível: sem o aviso, recusa; com o aviso, aparece na ficha.
    const noAck = await call(`/${secret.id}`, "PATCH", { command_id: uid(), expected_version: secret.version, data: { exposed: true } });
    expect(noAck.status).toBe(400);
    expect(noAck.body.error.message).toMatch(/aviso/);
    const exposed = await call(`/${secret.id}`, "PATCH", { command_id: uid(), expected_version: secret.version, data: { exposed: true, exposure_ack: true } });
    expect(exposed.body.field).toMatchObject({ exposed: true });
    expect((await call(`/contato/${client.id}?para=ficha`)).body.hidden).toBe(0);
    const admin = await call("?para=admin");
    expect(admin.body.items.find((x: any) => x.id === secret.id)).toMatchObject({ exposed: true, contacts: 1 });

    // Importação: linha a linha.
    const other = await contact(f, "Outro cliente", ["customer"]);
    const imported = await call("/importar", "POST", { command_id: uid(), itens: [{ contato: other.id, valores: { [size.body.field.id]: "Pequeno" } }] });
    expect(imported.body.items[0]).toMatchObject({ saved: true });
  });

  it("Cadastros desligado recusa com o código de parte desligada; bots só pelas operações concedidas", { timeout: 120_000 }, async () => {
    const { f, call } = await setup();
    expect(erpModule.routes).toContain("erp-contato-campos");
    const ops = ERP_BOT_OPERATIONS.filter(op => op.id.startsWith("erp.contato.campos."));
    expect(ops.map(op => [op.id, op.method, op.sensitive])).toEqual([
      ["erp.contato.campos.definicoes", "GET", false], ["erp.contato.campos.ler", "GET", false], ["erp.contato.campos.gravar", "PUT", true]]);
    for (const op of ops) expect(erpBotModules(op)).toEqual(["erp"]);
    await setModule(f.profile, "erp", false, f.admin.id);
    const off = await call("");
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("module_disabled");
  });
});
