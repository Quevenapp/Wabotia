// Documentos do ERP por e-mail (src/erp/email): proposta, pedido, compra,
// NF-e, NFC-e e cobrança pelo e-mail da instalação. A leitura do documento e
// das Preferências no ERP é simulada (loadEmailDocument, companyContact e
// erpCall); a rota, as partes, o registro, o reenvio, o envio automático da
// NF-e e o pedido ao provedor são os de verdade. O provedor de e-mail
// (API da Cloudflare) é simulado: nada sai para a rede.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { all, exec, one } from "../src/db";
import { uid } from "../src/types";
import { configureEmail } from "../src/email";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { ERP_BOT_OPERATIONS, erpBotInventory } from "../src/modules/erp/bot-access";
import type { EmailDocument } from "../src/erp/email/documents";

const state: { doc: EmailDocument | null; calls: number; prefs: Record<string, Record<string, unknown>> } = { doc: null, calls: 0, prefs: {} };
vi.mock("../src/erp/email/documents", () => ({
  loadEmailDocument: async () => {
    state.calls++;
    if (!state.doc) throw new Error("documento não preparado no teste");
    return state.doc;
  },
  companyContact: async () => ({ name: "Loja Exemplo", email: "contato@loja.exemplo.com.br" }),
}));
vi.mock("../src/erp/conversa/documents", () => ({
  erpCall: async (_env: unknown, _profile: string, _actor: unknown, _method: string, path: string) => {
    const page = /^\/v1\/preferencias\/([a-z-]+)$/.exec(path)?.[1];
    if (!page) throw new Error(`leitura do ERP inesperada: ${path}`);
    return { items: Object.entries(state.prefs[page] ?? {}).map(([key, value]) => ({ key, value })) };
  },
  loadDocument: async () => { throw new Error("não usado"); },
  salesPdf: async () => new Uint8Array(0),
}));

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const pdf = new TextEncoder().encode("%PDF-1.4\n% pedido\n");
const xml = new TextEncoder().encode("<nfeProc/>");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Pedidos ao provedor simulado e a resposta dele. */
let sent: { url: string; body: any }[] = [];
let reply: () => Response = () => ok();
const ok = () => Response.json({ success: true, errors: [], messages: [], result: { delivered: [sent.at(-1)?.body?.to], permanent_bounces: [], queued: [] } });
const original = globalThis.fetch;
beforeEach(() => {
  state.doc = null; state.calls = 0; state.prefs = {}; sent = []; reply = () => ok();
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "api.cloudflare.com") return original(input, init);
    sent.push({ url: request.url, body: await request.json() });
    return reply();
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  // D1 compartilhado entre arquivos: sem e-mail para os próximos testes.
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
  await exec(env, "DELETE FROM email_log");
});

function order(id: string): EmailDocument {
  return {
    type: "pedido", id, title: "Pedido de venda nº 77", contact_id: "30000000-0000-4000-8000-000000000001", customer_name: "Maria Souza",
    contact: { email: "Maria@Cliente.exemplo.com.br", nfe_email: null },
    values: { cliente: "Maria Souza", numero: "77", valor: "R$ 150,00", vencimento: null, link: null },
    files: [{ name: "Pedido-de-venda-77.pdf", type: "application/pdf", bytes: pdf }], xml_optional: false,
  };
}
function invoice(id: string): EmailDocument {
  return {
    type: "nota", id, title: "Nota fiscal nº 123 (série 1)", contact_id: "30000000-0000-4000-8000-000000000001", customer_name: "Maria Souza",
    contact: { email: "maria@cliente.exemplo.com.br", nfe_email: "fiscal@cliente.exemplo.com.br" },
    values: { cliente: "Maria Souza", numero: "123", valor: "R$ 150,00", vencimento: null, link: null },
    files: [{ name: "DANFE-123.pdf", type: "application/pdf", bytes: pdf }, { name: "NF-e-123.xml", type: "application/xml", bytes: xml, optional: "xml" }], xml_optional: false,
  };
}

async function setup({ email = true } = {}) {
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await setModule(f.profile, "erp-fiscal", true, f.admin.id);
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
  if (email) await configureEmail(env, f.admin, { account_id: ACCOUNT, token: "token-de-teste-com-permissao-12345", from_address: "nao-responda@loja.exemplo.com.br", from_name: "Wabotia" });
  const token = await bearer(f.admin);
  const call = async (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://test/api/v1/profiles/${f.profile}/erp-email${path}`, {
      ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers ?? {}) } }), env as any, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const post = (path: string, body: unknown, key = uid()) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } });
  return { f, call, post };
}

describe("ERP: documentos por e-mail", () => {
  it("sem e-mail configurado a prévia diz onde configurar e o envio recusa sem chamar o provedor", async () => {
    const { call, post } = await setup({ email: false });
    const id = uid();
    state.doc = order(id);
    const situation = await (await call("")).json<any>();
    expect(situation).toMatchObject({ configurado: false, onde_configurar: "Gestão → Sistema → E-mail" });
    const prep = await (await call(`/pedido/${id}`)).json<any>();
    expect(prep.email.configurado).toBe(false);
    expect(prep.email.aviso).toMatch(/Gestão → Sistema → E-mail/);
    const refused = await post(`/pedido/${id}/enviar`, { para: "maria@cliente.exemplo.com.br" });
    const body = await refused.json<any>();
    expect(refused.status).toBe(409);
    expect(body.error.code).toBe("email_unavailable");
    expect(body.error.message).toMatch(/O administrador configura em Gestão → Sistema → E-mail/);
    expect(sent).toEqual([]);
  });

  it("documento de parte desligada recusa com o código de parte desligada e diz qual ligar", async () => {
    const { f, call, post } = await setup();
    await setModule(f.profile, "erp-vendas", false, f.admin.id);
    const response = await call(`/pedido/${uid()}`);
    const body = await response.json<any>();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("module_disabled");
    expect(body.error.message).toMatch(/Vendas/);
    await setModule(f.profile, "erp-compras", false, f.admin.id);
    const purchase = await (await post(`/compra/${uid()}/enviar`, { para: "f@fornecedor.exemplo.com" })).json<any>();
    expect(purchase.error.message).toMatch(/Compras/);
    expect(state.calls).toBe(0);
    expect(sent).toEqual([]);
    // ERP inteiro desligado: o portão do módulo recusa antes.
    await setModule(f.profile, "erp", false, f.admin.id);
    expect((await call("")).status).toBe(409);
  });

  it("pedido: sugere o e-mail do cadastro, usa o modelo das Preferências e envia PDF, cópias, remetente e responder-para; registra e reenvia", async () => {
    const { call, post } = await setup();
    const id = uid();
    state.doc = order(id);
    state.prefs["vendas-vendas"] = {
      "vendas.email_assunto": "Seu pedido {numero}", "vendas.email_mensagem": "Oi {cliente}, segue o pedido {numero} de {valor}.\n{empresa}",
      "vendas.email_copia": "vendas@loja.exemplo.com.br", "vendas.email_remetente": "Vendas Loja", "vendas.email_resposta": "",
    };
    const prep = await (await call(`/pedido/${id}`)).json<any>();
    expect(prep).toMatchObject({ para: "maria@cliente.exemplo.com.br", copias: ["vendas@loja.exemplo.com.br"], responder_para: "contato@loja.exemplo.com.br", remetente: "Vendas Loja",
      modelo: { assunto: "Seu pedido {numero}" }, previa: { assunto: "Seu pedido 77", mensagem: "Oi Maria Souza, segue o pedido 77 de R$ 150,00.\nLoja Exemplo" } });
    expect(prep.anexos).toEqual([{ nome: "Pedido-de-venda-77.pdf", tipo: "application/pdf", tamanho: pdf.byteLength }]);
    expect(prep.email.configurado).toBe(true);

    const key = uid();
    const response = await post(`/pedido/${id}/enviar`, { para: "maria@cliente.exemplo.com.br", copias: ["vendas@loja.exemplo.com.br", "gerente@loja.exemplo.com.br"] }, key);
    const result = await response.json<any>();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`);
    expect(sent[0]!.body).toEqual({
      to: "maria@cliente.exemplo.com.br", from: { address: "nao-responda@loja.exemplo.com.br", name: "Vendas Loja" }, subject: "Seu pedido 77",
      text: "Oi Maria Souza, segue o pedido 77 de R$ 150,00.\nLoja Exemplo", cc: ["vendas@loja.exemplo.com.br", "gerente@loja.exemplo.com.br"],
      reply_to: "contato@loja.exemplo.com.br",
      attachments: [{ content: base64(pdf), filename: "Pedido-de-venda-77.pdf", type: "application/pdf", disposition: "attachment" }],
    });
    expect(result.envio).toMatchObject({ estado: "enviado", para: "maria@cliente.exemplo.com.br", copias: ["vendas@loja.exemplo.com.br", "gerente@loja.exemplo.com.br"], automatico: false });
    expect(result.envio.resumo).toMatch(/^Enviado por e-mail a maria@cliente\.exemplo\.com\.br \(e 2 cópias\) por .+ em \d{2}\/\d{2} às \d{2}:\d{2}$/);
    const log = await one(env, "SELECT purpose,module_id,status FROM email_log WHERE key=?", `erp-email:${result.envio.id}`);
    expect(log).toEqual({ purpose: "erp.email.pedido", module_id: "erp-vendas", status: "sent" });

    // A mesma chave não envia de novo.
    const again = await (await post(`/pedido/${id}/enviar`, { para: "maria@cliente.exemplo.com.br" }, key)).json<any>();
    expect(again.repetido).toBe(true);
    expect(sent).toHaveLength(1);

    const resent = await (await post(`/pedido/${id}/envios/${result.envio.id}/reenviar`, {})).json<any>();
    expect(resent.envio).toMatchObject({ estado: "enviado", reenvio_de: result.envio.id, para: "maria@cliente.exemplo.com.br" });
    expect(resent.envio.resumo).toMatch(/^Reenviado por e-mail/);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.subject).toBe("Seu pedido 77");
    const history = await (await call(`/pedido/${id}/envios`)).json<any>();
    expect(history.envios.map((item: any) => item.id)).toEqual([resent.envio.id, result.envio.id]);
  });

  it("endereço digitado fica registrado como fora do cadastro; assunto e texto editados com variáveis", async () => {
    const { post } = await setup();
    const id = uid();
    state.doc = order(id);
    const result = await (await post(`/pedido/${id}/enviar`, { para: "Outro@Exemplo.com", assunto: "Pedido {numero} pronto", mensagem: "Olá, {cliente}!" })).json<any>();
    expect(result.envio.resumo).toMatch(/a outro@exemplo\.com \(endereço fora do cadastro\)/);
    expect(sent[0]!.body).toMatchObject({ to: "outro@exemplo.com", subject: "Pedido 77 pronto", text: "Olá, Maria Souza!" });
    const bad = await post(`/pedido/${id}/enviar`, { para: "sem-arroba" });
    expect(bad.status).toBe(400);
    expect((await bad.json<any>()).error.message).toMatch(/E-mail do destinatário inválido/);
  });

  it("NF-e: vai ao e-mail de NF-e do cadastro com DANFE e XML; falha do provedor fica no registro", async () => {
    const { post, call } = await setup();
    const id = uid();
    state.doc = invoice(id);
    state.prefs["notas-nfe"] = { "nfe.email_copia": "contador@escritorio.exemplo.com" };
    const prep = await (await call(`/nota/${id}`)).json<any>();
    expect(prep.para).toBe("fiscal@cliente.exemplo.com.br");
    expect(prep.copias).toEqual(["contador@escritorio.exemplo.com"]);
    expect(prep.previa.mensagem).toMatch(/DANFE \(PDF\) e o arquivo XML/);
    await post(`/nota/${id}/enviar`, { para: prep.para, copias: prep.copias });
    expect(sent[0]!.body.attachments.map((file: any) => [file.filename, file.type])).toEqual([["DANFE-123.pdf", "application/pdf"], ["NF-e-123.xml", "application/xml"]]);
    expect(sent[0]!.body.subject).toBe("Nota fiscal nº 123 - Loja Exemplo");

    reply = () => Response.json({ success: false, errors: [{ code: 10202, message: "simulado" }], messages: [] }, { status: 400 });
    const failed = await post(`/nota/${id}/enviar`, { para: prep.para });
    expect(failed.status).toBe(400);
    const history = await (await call(`/nota/${id}/envios`)).json<any>();
    expect(history.envios[0]).toMatchObject({ estado: "falhou", estado_rotulo: "Falhou" });
    expect(history.envios[0].motivo).toMatch(/recusou o remetente ou o destinatário/);
  });

  it("envio automático da NF-e ao autorizar: só com a preferência ligada e uma vez por nota", async () => {
    const { f } = await setup();
    const { autoSendInvoiceEmail } = await import("../src/erp/email/service");
    const id = uid();
    state.doc = invoice(id);
    const actor = { ...f.admin, kind: "user" } as any;
    // Desligada por padrão: nada sai.
    expect(await autoSendInvoiceEmail(env, f.profile, actor, id)).toBeNull();
    expect(sent).toEqual([]);
    state.prefs["notas-nfe"] = { "nfe.email_automatico": true, "nfe.email_assunto": "NF-e {numero}" };
    const row = await autoSendInvoiceEmail(env, f.profile, actor, id);
    expect(row).toMatchObject({ status: "enviado", auto: 1, to_address: "fiscal@cliente.exemplo.com.br", subject: "NF-e 123" });
    expect(sent).toHaveLength(1);
    expect(await autoSendInvoiceEmail(env, f.profile, actor, id)).toBeNull();
    expect(sent).toHaveLength(1);
    // Sem e-mail no cadastro: não envia e o motivo fica no registro da nota.
    const other = uid();
    state.doc = { ...invoice(other), contact: { email: null, nfe_email: null } };
    const missing = await autoSendInvoiceEmail(env, f.profile, actor, other);
    expect(missing).toMatchObject({ status: "falhou", auto: 1 });
    expect(missing!.error).toMatch(/não tem e-mail para NF-e/);
    expect(sent).toHaveLength(1);
    expect(await all(env, "SELECT id FROM erp_email_sends WHERE profile_id=? AND auto=1", f.profile)).toHaveLength(2);
  });

  it("pelo bot: operações nominais, enviar e reenviar sensíveis; sem a concessão, recusa", async () => {
    const op = ERP_BOT_OPERATIONS.find(item => item.id === "erp.email.enviar")!;
    expect(op).toMatchObject({ method: "POST", path: "erp-email/:tipo/:id/enviar", sensitive: true, group: "email" });
    expect(op.description).toMatch(/o bot propõe e a pessoa confirma/);
    expect(ERP_BOT_OPERATIONS.find(item => item.id === "erp.email.reenviar")).toMatchObject({ sensitive: true, group: "email" });
    const inventory = erpBotInventory({ erp: true });
    expect(inventory.groups.find(group => group.id === "email")).toMatchObject({ title: "Enviar documentos por e-mail" });
    const { f } = await setup();
    const { erpEmailRoute } = await import("../src/erp/email/routes");
    state.doc = order(uid());
    const request = new Request(`https://test/api/v1/profiles/${f.profile}/erp-email/pedido/${state.doc.id}/enviar`, {
      method: "POST", body: JSON.stringify({ para: "maria@cliente.exemplo.com.br" }), headers: { "Content-Type": "application/json", "Idempotency-Key": uid() } });
    await expect(erpEmailRoute(env, request, f.profile, { ...f.admin, kind: "user", via: { bot_id: uid(), run_id: uid() } } as any))
      .rejects.toMatchObject({ status: 403, code: "erp_bot_grant_required" });
    expect(state.calls).toBe(0);
    expect(sent).toEqual([]);
  });
});
