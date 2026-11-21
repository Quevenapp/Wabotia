// Documentos do ERP por e-mail: regras puras (src/erp/email/templates.ts) e o
// contrato das operações (src/erp/email/contract.ts). Sem banco e sem rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TEMPLATES, TEMPLATE_KEYS, addressList, composeEmail, maskAddress, renderTemplate, sendSummary, stateFromProvider, suggestRecipients, tidySubject,
} from "../../../src/erp/email/templates.ts";
import { ERP_EMAIL_DOC_TYPES, ERP_EMAIL_OPERATIONS, erpEmailOperationFor, erpEmailParams, erpEmailRequirement } from "../../../src/erp/email/contract.ts";

test("variáveis do modelo: {cliente}, {{numero}}, acento e maiúsculas; desconhecida fica", () => {
  const values = { cliente: "Maria", numero: "77", valor: "R$ 150,00", vencimento: "10/12/2026", link: "https://pagar.exemplo/x", empresa: "Loja" };
  assert.equal(renderTemplate("Olá {cliente}, pedido {{numero}} de {VALOR} vence {vencimento} {link} - {Empresa} {outra}", values),
    "Olá Maria, pedido 77 de R$ 150,00 vence 10/12/2026 https://pagar.exemplo/x - Loja {outra}");
  assert.equal(renderTemplate("Nº {número}", values), "Nº 77");
  assert.equal(renderTemplate("{cliente}", {}), "");
});

test("assunto numa linha, sem link e até 200 caracteres; o link vai no corpo", () => {
  assert.equal(tidySubject("Pedido\n77 https://x.exemplo/a -"), "Pedido 77");
  assert.equal(tidySubject("a".repeat(300)).length, 200);
  const mail = composeEmail("conta", { subject: "Cobrança {numero} {link}", body: "Olá {cliente}.\n\n\n\nObrigado." },
    { cliente: "Ana", numero: "Mensalidade", link: "Pague pelo link: https://pagar.exemplo/abc" });
  assert.equal(mail.subject, "Cobrança Mensalidade");
  // Modelo sem {link}: o meio de pagar vai no fim do texto.
  assert.equal(mail.body, "Olá Ana.\n\nObrigado.\n\nPague pelo link: https://pagar.exemplo/abc");
});

test("sem modelo nas Preferências valem os padrões; NF-e cita DANFE e XML", () => {
  const mail = composeEmail("nota", { subject: "", body: null }, { cliente: "Maria", numero: "123", valor: "R$ 10,00", empresa: "Loja" });
  assert.equal(mail.subject, "Nota fiscal nº 123 - Loja");
  assert.match(mail.body, /DANFE \(PDF\) e o arquivo XML/);
  for (const type of ERP_EMAIL_DOC_TYPES) assert.ok(DEFAULT_TEMPLATES[type].subject && DEFAULT_TEMPLATES[type].body, type);
});

test("modelos vêm das preferências já existentes de cada tipo", () => {
  assert.equal(TEMPLATE_KEYS.proposta.page, "vendas-propostas");
  assert.equal(TEMPLATE_KEYS.proposta.subject, "propostas.email_assunto");
  assert.equal(TEMPLATE_KEYS.pedido.body, "vendas.email_mensagem");
  assert.equal(TEMPLATE_KEYS.compra.cc, "compras.email_copia");
  assert.equal(TEMPLATE_KEYS.nota.reply, "nfe.email_resposta");
  assert.equal(TEMPLATE_KEYS.conta.subject, "financas.cobranca_boleto_assunto");
});

test("destinatário sugerido: nota pelo e-mail de NF-e; cobrança pela preferência; demais pelo principal", () => {
  const contact = { email: "Maria@Exemplo.com.br", nfe_email: "fiscal@exemplo.com.br; nfe2@exemplo.com.br" };
  assert.deepEqual(suggestRecipients("nota", contact), { to: "fiscal@exemplo.com.br", cc: ["nfe2@exemplo.com.br"] });
  assert.deepEqual(suggestRecipients("pedido", contact), { to: "maria@exemplo.com.br", cc: [] });
  assert.deepEqual(suggestRecipients("conta", contact, "nfe"), { to: "fiscal@exemplo.com.br", cc: ["nfe2@exemplo.com.br"] });
  assert.deepEqual(suggestRecipients("conta", { email: null, nfe_email: "f@x.com" }, "principal"), { to: null, cc: [] });
  assert.deepEqual(suggestRecipients("nota", { email: "m@x.com", nfe_email: "" }), { to: "m@x.com", cc: [] });
  assert.deepEqual(addressList("a@x.com, b@ , A@X.com;c@y.com.br"), ["a@x.com", "c@y.com.br"]);
});

test("registro: resumo, situação do provedor e endereço mascarado", () => {
  const created = Date.UTC(2026, 10, 3, 17, 20);
  assert.equal(sendSummary({ to_address: "m@x.com", cc_count: 2, actor_name: "Ana", created, auto: false, resend: false, outside_record: false }),
    "Enviado por e-mail a m@x.com (e 2 cópias) por Ana em 03/11 às 14:20");
  assert.match(sendSummary({ to_address: "m@x.com", cc_count: 0, actor_name: "Ana", created, auto: true, resend: false, outside_record: false }), /automaticamente, ao autorizar a nota/);
  assert.match(sendSummary({ to_address: "o@x.com", cc_count: 1, actor_name: "Ana", created, auto: false, resend: true, outside_record: true }), /^Reenviado .*fora do cadastro\) \(e 1 cópia\)/);
  assert.equal(stateFromProvider("sent"), "enviado");
  assert.equal(stateFromProvider("queued"), "na_fila");
  assert.equal(stateFromProvider("bounced"), "devolvido");
  assert.equal(maskAddress("maria@exemplo.com.br"), "ma***@exemplo.com.br");
});

test("operações: enviar e reenviar são sensíveis; partes por documento", () => {
  const byName = Object.fromEntries(ERP_EMAIL_OPERATIONS.map(op => [op.name, op]));
  assert.equal(byName["erp.email.enviar"].sensitive, true);
  assert.equal(byName["erp.email.reenviar"].sensitive, true);
  assert.equal(byName["erp.email.preparar"].sensitive, false);
  assert.deepEqual(erpEmailParams(byName["erp.email.enviar"]).required, ["tipo", "id", "para"]);
  assert.deepEqual(erpEmailOperationFor("POST", "erp-email/nota/abc/envios/e1/reenviar")?.params, { tipo: "nota", id: "abc", envio: "e1" });
  assert.equal(erpEmailOperationFor("GET", "erp-email/pedido/abc")?.operation.name, "erp.email.preparar");
  assert.equal(erpEmailOperationFor("GET", "erp-email")?.operation.name, "erp.email.situacao");
  assert.equal(erpEmailOperationFor("DELETE", "erp-email/pedido/abc"), null);
  assert.ok(erpEmailRequirement("nfce").all.includes("erp-pdv"));
  assert.ok(erpEmailRequirement("compra").all.includes("erp-compras"));
  assert.ok(erpEmailRequirement("conta").all.includes("erp-financeiro"));
});
