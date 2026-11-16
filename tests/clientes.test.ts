// Cadastro de clientes (docs/CLIENTES.md): autocadastro pelo link, máscara
// por permissão, auditoria da revelação, exclusão que guarda notas e
// vínculos, e idempotência.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { unseal } from "../src/security";
import { modulesApi, onCustomerErase } from "../src/modules/api";
import { runModuleSchedules } from "../src/modules/schedule";
import {
  fiscalRetentionUntil,
  maskCpf,
  maskEmail,
  maskPhone,
} from "../src/modules/clientes/model";
import {
  api,
  application,
  bearer,
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const ORIGIN = "https://loja.example.com";
const CPF = "529.982.247-25";
const CPF_DIGITS = "52998224725";
const PHONE = "5511987654321";
const OTHER = "5511912340000";

// Módulo de teste (os) que guarda dados do cliente: falha na primeira vez.
const heard: any[] = [];
let failOnce = true;
onCustomerErase("os", async (_ctx, erasure) => {
  heard.push(erasure);
  if (failOnce) {
    failOnce = false;
    throw new Error("banco ocupado");
  }
  return { erased: 2, kept: 1, note: "1 ordem com nota fiscal guardada" };
});

const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const submit = (code: string, body: Record<string, string>) =>
  SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: new URLSearchParams(
      Object.fromEntries(Object.entries(body).map(([k, v]) => [`f_${k}`, v])),
    ).toString(),
  });

async function setup(options: { enabled?: boolean } = {}) {
  const f = await fixture();
  const run = (op: string, data: any = {}, actor: Actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  if (options.enabled !== false)
    await run("module.set", { id: "clientes", enabled: true });
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900002222" }),
    f.line,
    f.qr,
  );
  if (options.enabled !== false)
    await configure(f, {
      menus: [
        { id: "cadastro", label: "Meu cadastro", type: "clientes_cadastro" },
        { id: "excluir", label: "Excluir meus dados", type: "clientes_exclusao" },
        { id: "humano", label: "Falar com atendente", type: "human" },
      ],
    });
  return {
    f,
    run,
    ctx: modulesApi(env, f.profile, "clientes"),
    admin: await bearer(f.admin),
    member: await bearer(f.member),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const root = (s: Setup) => `/profiles/${s.f.profile}/clientes`;

async function say(f: Fixture, text: string, phone = PHONE, line = f.qr) {
  const c = await receive(f, line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
async function tap(f: Fixture, id: string, title: string, phone = PHONE) {
  const c = await receive(f, f.line, title, phone, { interactive_reply_id: id });
  await drain(f);
  return conversation(env, c.id, f.profile);
}

/** Cliente faz o próprio cadastro pelo item de menu, na linha QR. */
async function selfRegister(s: Setup, extra: Record<string, string> = {}) {
  await say(s.f, "oi");
  const c = await say(s.f, "1");
  const text = (await latest(c.id)).text;
  expect(text).toContain("Para fazer o seu cadastro");
  const code = codeIn(text);
  const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
  expect(page).toContain("CPF ou CNPJ");
  const res = await submit(code, {
    tipo: "Pessoa física (CPF)",
    nome: "Maria da Silva",
    documento: CPF,
    email: "maria.silva@gmail.com",
    cep: "01310-100",
    logradouro: "Avenida Paulista",
    numero: "1000",
    bairro: "Bela Vista",
    cidade: "São Paulo",
    uf: "sp",
    ibge: "3550308",
    aceite: "on",
    ...extra,
  });
  expect(res.status).toBe(200);
  await drain(s.f);
  const customer = await one(
    env,
    "SELECT * FROM clientes_customers WHERE profile_id=? AND document=?",
    s.f.profile,
    CPF_DIGITS,
  );
  expect(customer).toBeTruthy();
  return { c, customer, code };
}

describe("clientes: regras puras", () => {
  it("mascara CPF, telefone e e-mail e calcula a guarda fiscal", () => {
    expect(maskCpf(CPF_DIGITS)).toBe("•••.982.247-••");
    expect(maskPhone(PHONE)).toBe("+55 (11) •••••-4321");
    expect(maskEmail("maria.silva@gmail.com")).toBe("m•••@g•••.com");
    // Emitida em 16/11/2026: guarda até 1º/1/2032 (CTN, art. 173, I).
    const until = fiscalRetentionUntil(Date.UTC(2026, 10, 16, 15));
    expect(new Date(until).toISOString()).toBe("2032-01-01T03:00:00.000Z");
    // 31/12 às 23h de Brasília ainda é o mesmo ano.
    expect(
      new Date(fiscalRetentionUntil(Date.UTC(2027, 0, 1, 2))).toISOString(),
    ).toBe("2032-01-01T03:00:00.000Z");
  });
});

describe("clientes: autocadastro pelo link", () => {
  it("cria a ficha com o telefone confirmado, guarda o aceite e não deixa os dados no núcleo", async () => {
    const s = await setup();
    const { c, customer } = await selfRegister(s);
    expect(customer).toMatchObject({
      kind: "pf",
      name: "Maria da Silva",
      document_type: "cpf",
      email: "maria.silva@gmail.com",
      cep: "01310100",
      uf: "SP",
      city_ibge: "3550308",
      source: "self",
      status: "active",
    });
    const phones = await all(env, "SELECT * FROM clientes_phones WHERE customer_id=?", customer.id);
    expect(phones).toMatchObject([{ phone: PHONE, verified: 1 }]);
    const consents = await all(env, "SELECT * FROM clientes_consents WHERE customer_id=?", customer.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ purpose: "cadastro", status: "granted", source: "web_step", terms_version: "1" });
    expect(JSON.parse(consents[0].evidence)).toMatchObject({ conversation_id: c.id, accepted: true });
    // As respostas não ficam no passo, na nota interna nem nos eventos.
    const step = await one(env, "SELECT * FROM web_steps WHERE conversation_id=? AND module_id='clientes'", c.id);
    expect(step.status).toBe("completed");
    expect(step.result).toBeNull();
    const leaked = await one(
      env,
      "SELECT (SELECT count(*) FROM messages WHERE profile_id=?1 AND (text LIKE '%' || ?2 || '%' OR text LIKE '%982.247%')) m, (SELECT count(*) FROM events WHERE profile_id=?1 AND (payload LIKE '%' || ?2 || '%' OR payload LIKE '%maria.silva%')) e",
      s.f.profile,
      CPF_DIGITS,
    );
    expect(leaked).toEqual({ m: 0, e: 0 });
    expect((await latest(c.id)).text).toContain("Cadastro feito!");
  });

  it("corrige pelo mesmo caminho, mantendo o que ficou em branco", async () => {
    const s = await setup();
    const { customer } = await selfRegister(s);
    const c = await say(s.f, "MEU CADASTRO");
    const text = (await latest(c.id)).text;
    expect(text).toContain("corrigir o seu cadastro");
    const code = codeIn(text);
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    // O atual aparece mascarado na ajuda, nunca inteiro.
    expect(page).toContain("•••.982.247-••");
    expect(page).not.toContain("529.982.247-25");
    expect((await submit(code, { email: "maria@empresa.com.br", aceite: "on" })).status).toBe(200);
    await drain(s.f);
    const fresh = await one(env, "SELECT * FROM clientes_customers WHERE id=?", customer.id);
    expect(fresh).toMatchObject({ email: "maria@empresa.com.br", name: "Maria da Silva", document: CPF_DIGITS, version: 2 });
    expect(await all(env, "SELECT id FROM clientes_consents WHERE customer_id=?", customer.id)).toHaveLength(2);
  });

  it("recusa CPF já cadastrado por outro telefone confirmado", async () => {
    const s = await setup();
    await selfRegister(s);
    await say(s.f, "oi", OTHER);
    const c = await say(s.f, "1", OTHER);
    const code = codeIn((await latest(c.id)).text);
    const res = await submit(code, { tipo: "Pessoa física (CPF)", nome: "Outra", documento: CPF, aceite: "on" });
    expect(await res.text()).toContain("já está cadastrado com outro telefone");
    expect(await all(env, "SELECT id FROM clientes_customers WHERE profile_id=?", s.f.profile)).toHaveLength(1);
  });
});

describe("clientes: máscara por permissão e auditoria", () => {
  it("equipe vê mascarado; revelar exige papel e motivo e fica registrado", async () => {
    const s = await setup();
    const { customer } = await selfRegister(s);
    const url = `${root(s)}/customers/${customer.id}`;
    const masked = await (await api(s.member, url)).json<any>();
    expect(masked).toMatchObject({
      masked: true,
      revealable: false,
      document_display: "•••.982.247-••",
      email: "m•••@g•••.com",
      phones: [{ phone: "+55 (11) •••••-4321", verified: true }],
      address: { street: "•••", number: "•••", city: "São Paulo", uf: "SP", cep: "01•••-•••" },
    });
    expect(masked.document).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain(CPF_DIGITS);
    // Lista também sai mascarada; o CPF completo acha a ficha (busca exata).
    const list = await (await api(s.member, `${root(s)}/customers?q=${CPF_DIGITS}`)).json<any>();
    expect(list.data.map((r: any) => r.id)).toEqual([customer.id]);
    expect(JSON.stringify(list)).not.toContain(CPF_DIGITS);
    // Atendente com a regra padrão (admin): 403.
    const denied = await api(s.member, `${url}/reveal?reason=${encodeURIComponent("Emitir nota no balcão")}`);
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe("reveal_forbidden");
    // Administrador sem motivo: 400; com motivo: só os campos pedidos.
    expect((await api(s.admin, `${url}/reveal`)).status).toBe(400);
    const shown = await (
      await api(s.admin, `${url}/reveal?reason=${encodeURIComponent("Conferir CPF para a NF-e")}&fields=document`)
    ).json<any>();
    expect(shown).toMatchObject({ masked: false, document: CPF_DIGITS, document_display: CPF, email: "m•••@g•••.com", revealed: ["document"] });
    // Regra "team": a pessoa da equipe revela.
    await configure(s.f, { clientes: { reveal: "team" } });
    const team = await api(s.member, `${url}/reveal?reason=${encodeURIComponent("Cliente pediu conferência")}`);
    expect(team.status).toBe(200);
    expect((await team.json<any>()).email).toBe("maria.silva@gmail.com");
    // Auditoria: quem, quando, campos e motivo; só administrador lê.
    const log = await (await api(s.admin, `${url}/access-log`)).json<any>();
    expect(log.data.map((r: any) => [r.actor, r.action, r.fields, r.reason])).toEqual([
      [s.f.member.id, "reveal", ["document", "email", "phones", "address", "ie", "im"], "Cliente pediu conferência"],
      [s.f.admin.id, "reveal", ["document"], "Conferir CPF para a NF-e"],
    ]);
    expect(log.data[0].created).toBeGreaterThan(0);
    expect((await api(s.member, `${url}/access-log`)).status).toBe(403);
  });

  it("integração recebe mascarado e sem notas; só revela com contacts:read", async () => {
    const s = await setup();
    const { customer } = await selfRegister(s);
    await perform(env, s.f.admin, s.f.profile, "clientes.customer.update", {
      id: customer.id,
      notes: "Prefere boleto",
      expected_version: 1,
    }, uid());
    const url = `/profiles/${s.f.profile}/clientes/customers/${customer.id}`;
    const plain = await application(s.f, ["conversations:read"]);
    const body = await (await api(plain.token, url)).json<any>();
    expect(body).toMatchObject({ masked: true, revealable: false, document_display: "•••.982.247-••" });
    expect(body.notes).toBeUndefined();
    expect((await api(plain.token, `${url}/reveal?reason=integracao`)).status).toBe(403);
    // Sem contacts:read, os dígitos saem da busca (não vira oráculo).
    const search = await (await api(plain.token, `/profiles/${s.f.profile}/clientes/customers?q=${CPF_DIGITS}`)).json<any>();
    expect(search.data).toHaveLength(1); // q vazio: lista tudo, mascarado
    const reader = await application(s.f, ["conversations:read", "contacts:read", "notes:read"]);
    const detail = await (await api(reader.token, url)).json<any>();
    expect(detail).toMatchObject({ masked: true, revealable: true, notes: "Prefere boleto" });
    const full = await (await api(reader.token, `${url}/reveal?reason=${encodeURIComponent("Emissão pela NFapi")}`)).json<any>();
    expect(full.document).toBe(CPF_DIGITS);
    const fiscal = await (await api(reader.token, `${url}/fiscal-recipient?reason=${encodeURIComponent("NFC-e 123")}`)).json<any>();
    expect(fiscal).toMatchObject({ document: CPF_DIGITS, name: "Maria da Silva", address: { city_code: "3550308", uf: "SP", cep: "01310100" } });
    const log = await all(env, "SELECT actor,actor_kind,action FROM clientes_access_log WHERE customer_id=? ORDER BY created,rowid", customer.id);
    expect(log).toEqual([
      { actor: `app:${reader.id}`, actor_kind: "app", action: "reveal" },
      { actor: `app:${reader.id}`, actor_kind: "app", action: "fiscal" },
    ]);
  });
});

describe("clientes: exclusão a pedido do titular", () => {
  it("só o titular confirma; apaga os dados e guarda notas fiscais e vínculos", async () => {
    heard.length = 0;
    failOnce = true;
    const s = await setup();
    const { c, customer } = await selfRegister(s);
    // Protocolo com texto do cliente e uma nota fiscal emitida.
    const ticket = await perform(env, s.f.admin, s.f.profile, "ticket.create", { conversation_id: c.id, title: `CPF ${CPF} reclamação` }, uid());
    expect(ticket).toBeTruthy();
    await perform(env, s.f.admin, s.f.profile, "clientes.fiscal.link", {
      customer_id: customer.id,
      module_id: "vendas",
      ref_id: "nf-1",
      model: "nfce",
      series: 1,
      number: 321,
      issued_at: Date.UTC(2026, 10, 16, 15),
    }, uid());
    // Equipe pede pelo painel: só sai a confirmação ao titular.
    const asked = await (await api(s.member, `${root(s)}/customers/${customer.id}/erasure`, "POST", {})).json<any>();
    expect(asked).toMatchObject({ status: "awaiting_confirmation", requested_via: "panel" });
    const text = (await latest(c.id)).text;
    expect(text).toContain("Você pediu para excluir seus dados");
    expect(text).toContain("as notas fiscais emitidas para você");
    expect(text).toContain("01/01/2032");
    // Terceiro (outro telefone) tocando no botão do pedido: recusado.
    const intruder = await tap(s.f, `clientes:apagar:${asked.id}`, "Confirmar exclusão", OTHER);
    expect((await latest(intruder.id)).text).toContain("Só o titular");
    expect((await one(env, "SELECT status FROM clientes_erasures WHERE id=?", asked.id)).status).toBe("awaiting_confirmation");
    // Não existe rota para a equipe confirmar.
    expect((await api(s.admin, `${root(s)}/erasures/${asked.id}/confirm`, "POST", {})).status).toBe(404);
    // O titular confirma respondendo 1 na linha QR.
    await say(s.f, "1");
    let erasure = await one(env, "SELECT * FROM clientes_erasures WHERE id=?", asked.id);
    expect(erasure).toMatchObject({ status: "processing", confirmed_via: "text" });
    expect(erasure.error).toContain("os");
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ customer_id: customer.id, phones: [PHONE], document: CPF_DIGITS });
    expect(heard[0].conversation_ids).toContain(c.id);
    expect(heard[0].fiscal_retention_until).toBe(Date.UTC(2032, 0, 1, 3));
    // A confirmação final ainda está na fila: a conversa mantém o destino.
    expect((await outbox(c.id)).at(-1).text).toContain("Pedido confirmado");
    expect((await one(env, "SELECT phone FROM conversations WHERE id=?", c.id)).phone).toBe(PHONE);
    // Mensagem enviada; a rodada periódica repete o módulo que falhou e conclui.
    await exec(env, "UPDATE outbox SET status='sent' WHERE conversation_id=?", c.id);
    await runModuleSchedules(env, s.f.profile, now() + 10 * 60000);
    erasure = await one(env, "SELECT * FROM clientes_erasures WHERE id=?", asked.id);
    expect(erasure.status).toBe("done");
    expect(heard).toHaveLength(2);
    expect(JSON.parse(erasure.modules).os).toMatchObject({ status: "done", erased: 2, kept: 1 });
    // Ficha sem dado pessoal; a linha fica como vínculo.
    const row = await one(env, "SELECT * FROM clientes_customers WHERE id=?", customer.id);
    expect(row).toMatchObject({ status: "erased", name: "", document: null, email: "", street: "", city_ibge: "" });
    expect(await all(env, "SELECT * FROM clientes_phones WHERE customer_id=?", customer.id)).toHaveLength(0);
    // Vínculos: conversa e protocolo existem, sem conteúdo nem telefone.
    const conv = await one(env, "SELECT * FROM conversations WHERE id=?", c.id);
    expect(conv).toMatchObject({ phone: null, external_id: `erased:${c.id}`, state: "closed" });
    expect(await all(env, "SELECT id FROM messages WHERE conversation_id=?", c.id)).toHaveLength(0);
    expect(JSON.parse(erasure.conversation_ids)).toContain(c.id);
    if (ticket) {
      const t = await one(env, "SELECT * FROM tickets WHERE conversation_id=?", c.id);
      expect(t.title).toBe("Dados excluídos a pedido do titular");
      expect(JSON.parse(erasure.ticket_ids)).toContain(t.id);
    }
    // Guarda fiscal: vínculo da nota e destinatário cifrado até o prazo.
    expect(erasure).toMatchObject({ fiscal_documents: 1, fiscal_retention_until: Date.UTC(2032, 0, 1, 3) });
    expect(await all(env, "SELECT ref_id FROM clientes_fiscal_documents WHERE customer_id=?", customer.id)).toEqual([{ ref_id: "nf-1" }]);
    const hold = await one(env, "SELECT * FROM clientes_fiscal_holds WHERE customer_id=?", customer.id);
    expect(hold.sealed).not.toContain(CPF_DIGITS);
    expect((await unseal(env, hold.sealed)).recipient).toMatchObject({ document: CPF_DIGITS, name: "Maria da Silva" });
    // Em lugar nenhum do banco o CPF ou o telefone aparecem em claro.
    for (const [table, column] of [
      ["messages", "text"],
      ["events", "payload"],
      ["web_steps", "result"],
      ["outbox", "payload"],
      ["inbox", "payload"],
      ["clientes_customers", "document"],
      ["contacts", "phone"],
    ])
      expect(
        (await one(env, `SELECT count(*) n FROM ${table} WHERE profile_id=? AND (${column} LIKE ? OR ${column} LIKE ?)`, s.f.profile, `%${CPF_DIGITS}%`, `%${PHONE}%`)).n,
        table,
      ).toBe(0);
    // Escrever de novo começa do zero, em outra conversa.
    const fresh = await say(s.f, "oi");
    expect(fresh.id).not.toBe(c.id);
    // Painel: histórico de exclusões e ficha marcada.
    const history = await (await api(s.admin, `${root(s)}/erasures`)).json<any>();
    expect(history.data[0]).toMatchObject({ id: asked.id, status: "done", kept: { fiscal_documents: 1 } });
    const view = await (await api(s.admin, `${root(s)}/customers/${customer.id}`)).json<any>();
    expect(view).toMatchObject({ status: "erased", revealable: false, phones: [] });
    expect((await api(s.admin, `${root(s)}/customers/${customer.id}/reveal?reason=conferir%20dados`)).status).toBe(409);
  });

  it("pede pela palavra-chave, cancela e vence sem apagar nada", async () => {
    const s = await setup();
    const { c, customer } = await selfRegister(s);
    await say(s.f, "excluir meus dados");
    expect((await latest(c.id)).text).toContain("Para confirmar");
    await say(s.f, "2");
    expect((await latest(c.id)).text).toContain("continuam cadastrados");
    expect(await all(env, "SELECT status FROM clientes_erasures WHERE customer_id=?", customer.id)).toEqual([{ status: "cancelled" }]);
    // Pelo menu, de novo; sem resposta, vence em 48 h.
    await say(s.f, "oi");
    await say(s.f, "2");
    await runModuleSchedules(env, s.f.profile, now() + 49 * 3600000);
    expect(
      (await all(env, "SELECT status,requested_via FROM clientes_erasures WHERE customer_id=? ORDER BY created", customer.id)).map((r) => [r.status, r.requested_via]),
    ).toEqual([
      ["cancelled", "whatsapp"],
      ["expired", "menu"],
    ]);
    expect((await one(env, "SELECT status,document FROM clientes_customers WHERE id=?", customer.id))).toEqual({ status: "active", document: CPF_DIGITS });
  });

  it("confirma pelo link de uso único enviado na conversa", async () => {
    heard.length = 0;
    failOnce = false;
    const s = await setup();
    const { c, customer } = await selfRegister(s);
    const asked = await (await api(s.admin, `${root(s)}/customers/${customer.id}/erasure`, "POST", { channel: "link" })).json<any>();
    const code = codeIn((await latest(c.id)).text);
    expect(code).toBeTruthy();
    expect((await submit(code, { confirmo: "on" })).status).toBe(200);
    await drain(s.f);
    expect(await one(env, "SELECT status,confirmed_via FROM clientes_erasures WHERE id=?", asked.id)).toEqual({ status: "processing", confirmed_via: "link" });
    // Uso único: o segundo envio não faz nada.
    expect(await (await submit(code, { confirmo: "on" })).text()).toContain("já foi usado");
  });
});

describe("clientes: idempotência e módulo desligado", () => {
  it("mesma Idempotency-Key não duplica ficha, link nem pedido", async () => {
    const s = await setup();
    const key = uid();
    const body = { kind: "pj", name: "Padaria Pão Bom Ltda", document: "11.222.333/0001-81", phones: ["11 3333-4444"] };
    const first = await (await api(s.member, `${root(s)}/customers`, "POST", body, key)).json<any>();
    const again = await (await api(s.member, `${root(s)}/customers`, "POST", body, key)).json<any>();
    expect(again.id).toBe(first.id);
    // PJ comum: CNPJ visível; outra chave com o mesmo CNPJ: 409.
    expect(first.document_display).toBe("11.222.333/0001-81");
    const dup = await api(s.member, `${root(s)}/customers`, "POST", body);
    expect(dup.status).toBe(409);
    expect((await dup.json<any>()).error.code).toBe("customer_exists");
    // Edição com versão velha: 409.
    const stale = await api(s.member, `${root(s)}/customers/${first.id}`, "PATCH", { email: "a@b.com", expected_version: 0 });
    expect(stale.status).toBe(409);
    // Link do cadastro pela equipe, repetido com a mesma chave: um só envio.
    const c = await say(s.f, "oi", OTHER);
    const inviteKey = uid();
    await api(s.member, `${root(s)}/invites`, "POST", { conversation_id: c.id }, inviteKey);
    await api(s.member, `${root(s)}/invites`, "POST", { conversation_id: c.id }, inviteKey);
    expect(await all(env, "SELECT id FROM web_steps WHERE conversation_id=? AND module_id='clientes'", c.id)).toHaveLength(1);
    // Pedido de exclusão aberto: repetir devolve o mesmo pedido.
    const { customer } = await selfRegister(s);
    const a = await (await api(s.admin, `${root(s)}/customers/${customer.id}/erasure`, "POST", {})).json<any>();
    const b = await (await api(s.admin, `${root(s)}/customers/${customer.id}/erasure`, "POST", {})).json<any>();
    expect(b.id).toBe(a.id);
    expect(await all(env, "SELECT id FROM clientes_erasures WHERE customer_id=?", customer.id)).toHaveLength(1);
  });

  it("exclusão concluída repetida não muda nada", async () => {
    failOnce = false;
    const s = await setup();
    const { c, customer } = await selfRegister(s);
    await say(s.f, "EXCLUIR MEUS DADOS");
    await say(s.f, "1");
    await exec(env, "UPDATE outbox SET status='sent' WHERE conversation_id=?", c.id);
    await runModuleSchedules(env, s.f.profile, now() + 10 * 60000);
    const done = await one(env, "SELECT * FROM clientes_erasures WHERE customer_id=?", customer.id);
    expect(done.status).toBe("done");
    const events = (await one(env, "SELECT count(*) n FROM events WHERE profile_id=? AND kind='clientes.customer_erased'", s.f.profile)).n;
    await runModuleSchedules(env, s.f.profile, now() + 3 * 3600000);
    const { runErasure } = await import("../src/modules/clientes/erasure");
    await runErasure(s.ctx, done);
    expect(await one(env, "SELECT status,attempts,updated FROM clientes_erasures WHERE id=?", done.id)).toEqual({
      status: "done",
      attempts: done.attempts,
      updated: done.updated,
    });
    expect((await one(env, "SELECT count(*) n FROM events WHERE profile_id=? AND kind='clientes.customer_erased'", s.f.profile)).n).toBe(events);
    expect(events).toBe(1);
  });

  it("desligado: rotas 409 e itens fora do menu", async () => {
    const s = await setup({ enabled: false });
    const res = await api(s.admin, `${root(s)}/customers`);
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe("module_disabled");
    // Palavra de exclusão não é tratada com o módulo desligado.
    const c = await say(s.f, "EXCLUIR MEUS DADOS");
    expect(await all(env, "SELECT id FROM clientes_erasures WHERE profile_id=?", s.f.profile)).toHaveLength(0);
    expect(c.id).toBeTruthy();
  });
});
