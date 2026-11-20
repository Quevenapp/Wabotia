// ERP pela conversa (src/erp/conversa): regras puras do envio pelo WhatsApp da
// área. Sem banco e sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideSend, deliveryState, erpPath, formatPhone, maskPhone, messageText, money, sendSummary, withLink, WINDOW_MS, FILE_LIMIT,
} from "../../../src/erp/conversa/rules.ts";
import { ERP_CONVERSA_OPERATIONS, ERP_CONVERSA_MODULE_CONTRACT, erpConversaOperationFor, erpConversaParams } from "../../../src/erp/conversa/contract.ts";
import { documentPdf } from "../../../src/erp/conversa/pdf.ts";

const NOW = Date.parse("2026-11-20T18:02:00Z");
const official = { id: "l1", name: "Oficial", kind: "zernio", number: "5511900000000", managed: false, human: true, templates: true };
const qr = { ...official, id: "l2", kind: "qr" };
const open = { id: "c1", last_customer: NOW - 60_000, owner: null, state: "ai" };
const closed = { ...open, last_customer: NOW - WINDOW_MS - 1 };
const base = { line: official, conversation: open, now: NOW, files: [{ size: 1000 }], notifications: { enabled: true, template: "aviso" }, consent: true, purpose: "order" };

test("dentro da janela de 24 horas vai a mensagem com o arquivo; grande demais vira link", () => {
  assert.equal(decideSend(base).mode, "arquivo");
  assert.equal(decideSend({ ...base, files: [] }).mode, "mensagem");
  const big = decideSend({ ...base, files: [{ size: FILE_LIMIT + 1 }] });
  assert.equal(big.mode, "link");
  assert.match(big.reason, /link seguro/);
  assert.equal(decideSend(base).window, "aberta");
});

test("fora da janela só pelo modelo aprovado, com consentimento; sem modelo, diz o que falta e oferece copiar o link", () => {
  const model = decideSend({ ...base, conversation: closed });
  assert.equal(model.mode, "modelo");
  assert.equal(model.template, "aviso");
  const noTemplate = decideSend({ ...base, conversation: closed, notifications: { enabled: false, template: null } });
  assert.equal(noTemplate.mode, "bloqueado");
  assert.match(noTemplate.reason, /modelo de aviso/);
  assert.equal(noTemplate.can_copy_link, true);
  const noConsent = decideSend({ ...base, conversation: closed, consent: false, purpose: "billing" });
  assert.equal(noConsent.mode, "bloqueado");
  assert.match(noConsent.reason, /autorizou avisos de cobranças/);
  const managed = decideSend({ ...base, conversation: closed, line: { ...official, managed: true } });
  assert.equal(managed.mode, "bloqueado");
  assert.match(managed.reason, /roteador/);
  const noTemplates = decideSend({ ...base, conversation: closed, line: { ...official, templates: false } });
  assert.equal(noTemplates.mode, "bloqueado");
});

test("número que nunca escreveu: conversa nova na linha oficial, fora da janela; pelo QR não abre", () => {
  const fresh = decideSend({ ...base, conversation: null, consent: false });
  assert.equal(fresh.new_conversation, true);
  assert.equal(fresh.window, "fechada");
  assert.equal(fresh.mode, "bloqueado");
  assert.equal(fresh.can_copy_link, true);
  const viaQr = decideSend({ ...base, line: qr, conversation: null });
  assert.equal(viaQr.mode, "bloqueado");
  assert.equal(viaQr.can_copy_link, false);
  assert.match(viaQr.reason, /QR/);
  // Linha pelo QR com conversa: sem janela.
  assert.deepEqual([decideSend({ ...base, line: qr, conversation: closed }).mode, decideSend({ ...base, line: qr, conversation: closed }).window], ["arquivo", "sem_janela"]);
});

test("linha sem envio por atendentes não envia", () => {
  const denied = decideSend({ ...base, line: { ...official, human: false } });
  assert.equal(denied.mode, "bloqueado");
  assert.match(denied.reason, /Conexões/);
});

test("textos: valor, vencimento, Pix e o link no fim", () => {
  assert.equal(money("123456"), "R$ 1.234,56");
  assert.equal(money("5"), "R$ 0,05");
  assert.equal(formatPhone("5511987654321"), "(11) 98765-4321");
  assert.equal(maskPhone("5511987654321"), "(11) 9…-4321");
  const proposal = messageText({ type: "proposta", label: "proposta comercial nº 12", customer: "Maria Souza", total_cents: "150000", valid_until: "2026-11-30", attachments: 1 });
  assert.match(proposal, /^Olá, Maria! Segue a sua proposta comercial nº 12, no valor de R\$ 1\.500,00, válida até 30\/11\/2026\./);
  const charge = messageText({ type: "conta", label: "x", customer: null, total_cents: "9990", due_on: "2026-12-05", description: "Mensalidade", pix: "000201PIX", attachments: 0 });
  assert.match(charge, /^Olá! Segue a cobrança de Mensalidade, no valor de R\$ 99,90, com vencimento em 05\/12\/2026\./);
  assert.match(charge, /Pix copia e cola:\n000201PIX/);
  assert.match(withLink("Oi", "https://x/api/w/abc"), /Veja o documento: https:\/\/x\/api\/w\/abc$/);
  assert.equal(erpPath("pedido", "id1"), "/documentos-empresa?tipo=sales_orders&documento=id1");
  assert.equal(erpPath("nota", "id2"), "/historico-fiscal?modelo=55&emissao=id2");
  assert.equal(erpPath("conta", "id3"), "/financeiro-empresa?area=receivable&titulo=id3");
});

test("registro no documento: a quem, por quem, quando e o estado de entrega", () => {
  const summary = sendSummary({ phone: "5511987654321", actor_name: "Fulano", created: NOW, mode: "arquivo", outside_record: 1 });
  assert.equal(summary, "Enviado pelo WhatsApp a (11) 9…-4321 (número fora do cadastro) por Fulano em 20/11 às 15:02");
  const record = { status: "enviado", mode: "arquivo", error: null };
  assert.equal(deliveryState(record, []).state, "na_fila");
  assert.equal(deliveryState(record, [{ status: "pending", error: "Aguardando nova mensagem do cliente (janela de 24h)", delivery_status: null }]).reason, "Aguardando nova mensagem do cliente (janela de 24h)");
  assert.equal(deliveryState(record, [{ status: "sent", error: null, delivery_status: "read" }, { status: "sent", error: null, delivery_status: "delivered" }]).state, "entregue");
  assert.equal(deliveryState(record, [{ status: "sent", error: null, delivery_status: "read" }]).state, "lido");
  const failed = deliveryState(record, [{ status: "failed", error: "Número sem WhatsApp", delivery_status: null }]);
  assert.deepEqual(failed, { state: "falhou", reason: "Número sem WhatsApp" });
  assert.equal(deliveryState(record, [{ status: "sent", error: null, delivery_status: "failed" }]).state, "falhou");
  assert.equal(deliveryState({ status: "link", mode: "link_copiado", error: null }, []).state, "link");
  assert.deepEqual(deliveryState({ status: "falhou", mode: "arquivo", error: "Linha desconectada" }, []), { state: "falhou", reason: "Linha desconectada" });
});

test("operações com nome estável e descrição; enviar é sensível; rotas reconhecidas", () => {
  assert.deepEqual(ERP_CONVERSA_OPERATIONS.map(op => op.name), ["erp.conversa.linhas", "erp.conversa.preparar", "erp.conversa.envios", "erp.conversa.enviar"]);
  for (const op of ERP_CONVERSA_OPERATIONS) assert.ok(op.description.length > 40, op.name);
  assert.deepEqual(ERP_CONVERSA_OPERATIONS.filter(op => op.sensitive).map(op => op.name), ["erp.conversa.enviar"]);
  assert.deepEqual(ERP_CONVERSA_MODULE_CONTRACT.definition.bot.sensitive, ["erp.conversa.enviar"]);
  assert.equal(erpConversaOperationFor("POST", "erp-conversa/pedido/abc/enviar").operation.name, "erp.conversa.enviar");
  assert.deepEqual(erpConversaOperationFor("GET", "erp-conversa/nota/abc").params, { tipo: "nota", id: "abc" });
  assert.equal(erpConversaOperationFor("GET", "erp-conversa").operation.name, "erp.conversa.linhas");
  assert.equal(erpConversaOperationFor("GET", "erp-conversa/pedido/abc/envios").operation.name, "erp.conversa.envios");
  assert.equal(erpConversaOperationFor("DELETE", "erp-conversa/pedido/abc"), null);
  const params = erpConversaParams(ERP_CONVERSA_OPERATIONS[3]);
  assert.deepEqual(params.required, ["tipo", "id", "telefone", "linha"]);
  assert.deepEqual(Object.keys(params.properties), ["tipo", "id", "telefone", "linha", "xml", "acao"]);
  assert.ok(Object.keys(ERP_CONVERSA_MODULE_CONTRACT.openapi.paths).includes("/profiles/{profile}/erp-conversa/{tipo}/{id}/enviar"));
});

test("PDF da proposta: arquivo PDF com o título, o cliente e o total, sem observação interna", () => {
  const pdf = documentPdf({ title: "Proposta comercial", number: "12", status: "Em aberto", date: "2026-11-20", valid_until: "2026-11-30",
    company: { name: "Loja Fictícia", document: "CNPJ 00.000.000/0001-00", contact: null, city: "São Paulo / SP" },
    customer: { name: "Maria Souza", document: null, city: null },
    items: Array.from({ length: 70 }, (_, i) => ({ code: `P${i}`, description: `Produto ${i}`, unit: "UN", quantity: "2", unit_price: "10.00", total: "20.00" })),
    totals: { subtotal: "1400.00", discount: "0.00", freight: null, total: "1400.00" }, payment_terms: "30 dias", delivery_terms: null, notes: null,
    installments: [{ due_date: "2026-12-20", amount: "1400.00" }] });
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /Proposta comercial n\\272 12/);
  assert.match(text, /Maria Souza/);
  assert.match(text, /R\$ 1\.400,00/);
  assert.match(text, /\/Count [2-9]/, "muitos itens quebram a página");
  assert.doesNotMatch(text, /internal/);
});
