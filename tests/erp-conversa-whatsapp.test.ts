// ERP pela conversa (src/erp/conversa): enviar orçamento, pedido, nota e
// cobrança pelo WhatsApp da própria área. A leitura do documento no ERP é
// simulada (loadDocument); a rota, a regra da janela, a conversa, a fila de
// envio, o registro e o link público são os de verdade. Nada sai para a rede:
// o teste lê o outbox, não entrega.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { all, exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { bearer, drain, fixture, receive } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { ERP_BOT_OPERATIONS, erpBotInventory } from "../src/modules/erp/bot-access";
import type { LoadedDocument } from "../src/erp/conversa/documents";

const state: { doc: LoadedDocument | null; calls: number } = { doc: null, calls: 0 };
vi.mock("../src/erp/conversa/documents", () => ({
  loadDocument: async () => {
    state.calls++;
    if (!state.doc) throw new Error("documento não preparado no teste");
    return state.doc;
  },
}));

const ORIGIN = "https://erp-conversa.example.test";
const CLIENT = "5511999998888";
const pdf = new TextEncoder().encode("%PDF-1.4\n% teste\n");
function order(id: string): LoadedDocument {
  return {
    type: "pedido", id, title: "Pedido de venda nº 77", contact_id: "30000000-0000-4000-8000-000000000001", customer_name: "Maria Souza",
    phones: [CLIENT], purpose: "order",
    facts: { type: "pedido", label: "pedido de venda nº 77", customer: "Maria Souza", total_cents: "15000", attachments: 1 },
    files: [{ name: "Pedido-de-venda-77.pdf", type: "application/pdf", bytes: pdf }],
    page: { title: "Pedido de venda nº 77", status_label: "Em aberto", headline: "Total: R$ 150,00", lines: ["1 item"] },
    erp_path: `/documentos-empresa?tipo=sales_orders&documento=${id}`, ttl_minutes: 60 * 24,
  };
}

async function setup() {
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)", ORIGIN, now());
  const token = await bearer(f.admin);
  const send = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const call = (path: string, init: RequestInit = {}) => send(new Request(`https://test/api/v1/profiles/${f.profile}/erp-conversa${path}`, {
    ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers ?? {}) } }));
  const post = (path: string, body: unknown, key = uid()) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } });
  return { f, send, call, post };
}

beforeEach(() => { state.doc = null; state.calls = 0; });

describe("ERP pela conversa", () => {
  it("lista as linhas de WhatsApp da área; sem linha, diz para conectar uma em Conexões", async () => {
    const { f, call } = await setup();
    const listed = await (await call("")).json<any>();
    expect(listed.linhas.map((line: any) => line.id).sort()).toEqual([f.line, f.second, f.qr].sort());
    expect(listed.conectar).toBeNull();
    await exec(env, "UPDATE connections SET status='inactive' WHERE profile_id=?", f.profile);
    const none = await (await call("")).json<any>();
    expect(none).toEqual({ linhas: [], conectar: "Conecte uma linha de WhatsApp em Conexões" });
  });

  it("documento de parte desligada recusa com o código de parte desligada e diz qual ligar", async () => {
    const { f, call } = await setup();
    await setModule(f.profile, "erp-vendas", false, f.admin.id);
    const response = await call(`/pedido/${uid()}`);
    const body = await response.json<any>();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("module_disabled");
    expect(body.error.message).toMatch(/Vendas/);
    expect(state.calls).toBe(0);
    // ERP inteiro desligado: o portão do módulo recusa antes.
    await setModule(f.profile, "erp", false, f.admin.id);
    expect((await call("")).status).toBe(409);
  });

  it("dentro da janela vai a mensagem com o PDF na conversa existente, com registro nos dois lados", async () => {
    const { f, call, post } = await setup();
    const c = await receive(f, f.line, "oi, quero o pedido", CLIENT);
    await drain(f);
    const id = uid();
    state.doc = order(id);
    const prep = await (await call(`/pedido/${id}?linha=${f.line}`)).json<any>();
    expect(prep.documento).toMatchObject({ titulo: "Pedido de venda nº 77", cliente: "Maria Souza" });
    expect(prep.telefones).toEqual([{ digitos: CLIENT, numero: "(11) 99999-8888" }]);
    expect(prep.destino).toMatchObject({ janela: "aberta", modo: "arquivo", fora_do_cadastro: false, conversa: { id: c.id } });
    expect(prep.previa.texto).toMatch(/^Olá, Maria! Segue o seu pedido de venda nº 77, no valor de R\$ 150,00\./);
    expect(prep.previa.anexos).toEqual([{ nome: "Pedido-de-venda-77.pdf", tipo: "application/pdf", tamanho: pdf.byteLength }]);

    const key = uid();
    const response = await post(`/pedido/${id}/enviar`, { telefone: CLIENT, linha: f.line }, key);
    const sent = await response.json<any>();
    expect(response.status, JSON.stringify(sent)).toBe(200);
    expect(sent.envio).toMatchObject({ modo: "arquivo", fora_do_cadastro: false, conversa: c.id, estado: "na_fila" });
    expect(sent.envio.resumo).toMatch(/^Enviado pelo WhatsApp a \(11\) 9…-8888 por .+ em \d{2}\/\d{2} às \d{2}:\d{2}$/);
    const rows = await all(env, "SELECT dedupe,payload,conversation_id FROM outbox WHERE profile_id=? AND dedupe LIKE 'erp-conversa:%' ORDER BY dedupe", f.profile);
    expect(rows.map(row => row.dedupe.replace(/^erp-conversa:[0-9a-f]+/, ""))).toEqual([":media:0", ":text"]);
    expect(rows.every(row => row.conversation_id === c.id)).toBe(true);
    const media = JSON.parse(rows[0].payload).media_id;
    expect(await one(env, "SELECT name,type,size FROM media WHERE id=?", media)).toEqual({ name: "Pedido-de-venda-77.pdf", type: "application/pdf", size: pdf.byteLength });
    const note = await one(env, "SELECT text FROM messages WHERE conversation_id=? AND direction='note' ORDER BY created DESC LIMIT 1", c.id);
    expect(note.text).toContain(`Abrir no ERP: ${ORIGIN}/app/erp/documentos-empresa?tipo=sales_orders&documento=${id}`);

    // Repetir a mesma chave não envia de novo.
    const again = await (await post(`/pedido/${id}/enviar`, { telefone: CLIENT, linha: f.line }, key)).json<any>();
    expect(again.repetido).toBe(true);
    expect((await all(env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe LIKE 'erp-conversa:%'", f.profile)).length).toBe(2);
    const history = await (await call(`/pedido/${id}/envios`)).json<any>();
    expect(history.envios).toHaveLength(1);
    expect(history.envios[0].resumo).toBe(sent.envio.resumo);
  });

  it("fora da janela sem modelo não envia; copiar o link abre a conversa, atribui a quem enviou e a página mostra só o documento", async () => {
    const { f, call, post, send } = await setup();
    const id = uid();
    state.doc = order(id);
    const stranger = "5511977776666";
    const prep = await (await call(`/pedido/${id}?linha=${f.line}&telefone=${stranger}`)).json<any>();
    expect(prep.destino).toMatchObject({ modo: "bloqueado", janela: "fechada", conversa_nova: true, pode_copiar_link: true, fora_do_cadastro: true });
    expect(prep.destino.motivo).toMatch(/nunca escreveu.*modelo/);
    const refused = await post(`/pedido/${id}/enviar`, { telefone: stranger, linha: f.line });
    expect(refused.status).toBe(409);
    expect((await refused.json<any>()).error.code).toBe("erp_conversa_blocked");

    const copied = await (await post(`/pedido/${id}/enviar`, { telefone: stranger, linha: f.line, acao: "copiar_link" })).json<any>();
    expect(copied.envio).toMatchObject({ modo: "link_copiado", fora_do_cadastro: true, estado: "link" });
    expect(copied.envio.resumo).toMatch(/^Link copiado para \(11\) 9…-6666 \(número fora do cadastro\) por /);
    expect(copied.url).toMatch(new RegExp(`^${ORIGIN}/api/w/[2-9A-HJ-NP-Za-km-np-z]{16}$`));
    const opened = await one(env, "SELECT owner,state,connection_id FROM conversations WHERE id=?", copied.envio.conversa);
    expect(opened).toEqual({ owner: f.admin.id, state: "human", connection_id: f.line });
    // Nada foi para a fila do cliente.
    expect(await all(env, "SELECT id FROM outbox WHERE conversation_id=? AND kind<>'team'", copied.envio.conversa)).toEqual([]);

    const code = copied.url.split("/").pop();
    const page = await send(new Request(`https://test/api/w/${code}`));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Pedido de venda nº 77");
    expect(html).toContain("Total: R$ 150,00");
    expect(html).toContain(`/api/w/${code}/arquivo/0`);
    expect(html).not.toContain("Maria");
    expect(html).not.toContain("6666");
    const file = await send(new Request(`https://test/api/w/${code}/arquivo/0`));
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toMatch(/application\/pdf/);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
    expect((await send(new Request(`https://test/api/w/${code}/arquivo/1`))).status).toBe(404);
    // Com a parte desligada, o link deixa de mostrar o documento.
    await setModule(f.profile, "erp-vendas", false, f.admin.id);
    expect((await send(new Request(`https://test/api/w/${code}/arquivo/0`))).status).toBe(404);
    expect((await send(new Request(`https://test/api/w/${code}`))).status).toBe(410);
  });

  it("outra pessoa atendendo a conversa: recusa dizendo quem atende", async () => {
    const { f, post } = await setup();
    const c = await receive(f, f.line, "oi", CLIENT);
    await drain(f);
    await exec(env, "UPDATE conversations SET state='human',owner=? WHERE id=?", f.member.id, c.id);
    const id = uid();
    state.doc = order(id);
    const memberToken = await bearer(f.other);
    const response = await worker.fetch(new Request(`https://test/api/v1/profiles/${f.profile}/erp-conversa/pedido/${id}/enviar`, {
      method: "POST", body: JSON.stringify({ telefone: CLIENT, linha: f.line }),
      headers: { Authorization: "Bearer " + memberToken, "Content-Type": "application/json", "Idempotency-Key": uid() } }), env as any, createExecutionContext());
    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body.error.code).toBe("already_claimed");
    expect(body.error.message).toMatch(/está atendendo esta conversa/);
  });

  it("pelo bot: operação nominal e sensível no inventário; sem a concessão, recusa", async () => {
    const op = ERP_BOT_OPERATIONS.find(item => item.id === "erp.conversa.enviar")!;
    expect(op).toMatchObject({ method: "POST", path: "erp-conversa/:tipo/:id/enviar", sensitive: true, group: "conversa" });
    expect(op.description).toMatch(/o bot propõe e a pessoa confirma/);
    expect(op.params.required).toEqual(["tipo", "id", "telefone", "linha"]);
    const inventory = erpBotInventory({ erp: true });
    expect(inventory.groups.find(group => group.id === "conversa")).toMatchObject({ title: "Enviar documentos pelo WhatsApp" });
    const { f } = await setup();
    const { erpConversaRoute } = await import("../src/erp/conversa/routes");
    state.doc = order(uid());
    const request = new Request(`https://test/api/v1/profiles/${f.profile}/erp-conversa/pedido/${state.doc.id}/enviar`, {
      method: "POST", body: JSON.stringify({ telefone: CLIENT, linha: f.line }), headers: { "Content-Type": "application/json", "Idempotency-Key": uid() } });
    await expect(erpConversaRoute(env, request, f.profile, { ...f.admin, via: { bot_id: uid(), run_id: uid() } } as any))
      .rejects.toMatchObject({ status: 403, code: "erp_bot_grant_required" });
    expect(state.calls).toBe(0);
  });
});
