import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, createTicket, perform } from "../src/service";
import { json, now, uid, type Actor } from "../src/types";
import {
  expireWebSteps,
  newWebStepCode,
  validateAnswers,
  webStepCode,
} from "../src/web-steps";
import { tools } from "../src/mcp";
import {
  api,
  application,
  bearer,
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

const ORIGIN = "https://atendimento.example.com";
const cadastro = {
  id: "cadastro",
  name: "Cadastro de cliente",
  title: "Cadastro",
  intro: "Leva menos de um minuto.",
  fields: [
    { id: "nome", type: "text", label: "Nome completo" },
    {
      id: "plano",
      type: "choice",
      label: "Plano",
      options: ["Mensal", "Anual"],
    },
    { id: "nascimento", type: "date", label: "Data de nascimento" },
    {
      id: "termos",
      type: "accept",
      label: "Li e aceito os termos de uso",
    },
    { id: "obs", type: "text", label: "Observações", required: false },
  ],
  return_text: "Cadastro recebido! Já vamos analisar.",
  done_text: "Tudo certo, pode voltar ao WhatsApp.",
};
const menus = [
  {
    id: "form",
    label: "Preencher cadastro",
    type: "form",
    form_id: "cadastro",
  },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const valid = {
  f_nome: "Maria da Silva",
  f_plano: "Anual",
  f_nascimento: "1990-04-21",
  f_termos: "on",
};

const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup(extra: any = {}) {
  const f = await fixture();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900001111" }),
    f.line,
    f.qr,
  );
  await configure(f, { forms: [{ ...cadastro, ...extra }], menus });
  return f;
}
async function say(f: Fixture, text: string, phone: string, line = f.line) {
  const c = await receive(f, line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const page = (code: string) => SELF.fetch(`https://test/api/w/${code}`);
const submit = (code: string, body: Record<string, string>) =>
  SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: new URLSearchParams(body).toString(),
  });
const step = (conversationId: string) =>
  one(
    env,
    "SELECT * FROM web_steps WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
    conversationId,
  );
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT * FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  );
/** Abre o formulário pelo menu e devolve conversa e código do link. */
async function openByMenu(f: Fixture, phone: string, line = f.line) {
  await say(f, "oi", phone, line);
  const c = await say(f, "1", phone, line);
  const sent = await latest(c.id);
  return { c, sent, code: codeIn(sent.text) };
}

describe("passo web: código e respostas", () => {
  it("gera códigos curtos sem caracteres ambíguos", () => {
    const codes = new Set(Array.from({ length: 200 }, newWebStepCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(webStepCode);
    expect([...codes].join("")).not.toMatch(/[01OIl]/);
  });

  it("valida texto, escolha, data e aceite", () => {
    const fields: any[] = cadastro.fields.map((f: any) => ({
      required: true,
      ...f,
    }));
    const bad = validateAnswers(fields, {
      nome: "",
      plano: "Semanal",
      nascimento: "2026-02-30",
    });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual([
      "nascimento",
      "nome",
      "plano",
      "termos",
    ]);
    const good = validateAnswers(fields, {
      nome: " Ana ",
      plano: "Mensal",
      nascimento: "2000-01-31",
      termos: "on",
    });
    expect(good).toMatchObject({
      ok: true,
      answers: { nome: "Ana", plano: "Mensal", termos: true, obs: "" },
    });
  });
});

describe("passo web: ciclo pelo item de menu", () => {
  it("cria, abre, recusa resposta incompleta, conclui e recusa reuso do link", async () => {
    const f = await setup();
    const { c, sent, code } = await openByMenu(f, "5511940000001");
    // Linha oficial: botão com URL; o texto leva o link para linhas sem botão.
    expect(code).toMatch(webStepCode);
    expect(sent.text).toContain(`${ORIGIN}/api/w/${code}`);
    expect(sent.content.interactive).toMatchObject({
      type: "cta_url",
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Abrir formulário",
          url: `${ORIGIN}/api/w/${code}`,
        },
      },
    });
    let row = await step(c.id);
    expect(row).toMatchObject({
      status: "sent",
      module_id: "forms",
      kind: "form",
      ref_id: "cadastro",
      trigger: "menu",
    });
    // Só o hash do código fica guardado.
    expect(JSON.stringify(row)).not.toContain(code);
    expect(await events(f, "web_step.sent")).toHaveLength(1);

    // Abrir: página leve, sem cache e sem referer.
    const opened = await page(code);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("Content-Type")).toContain("text/html");
    expect(opened.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(opened.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    const html = await opened.text();
    expect(html).toContain("Cadastro");
    expect(html).toContain("Nome completo");
    expect(html).toContain('type="date"');
    expect(html).not.toContain("<script");
    expect((await step(c.id)).status).toBe("opened");
    await page(code);
    expect(await events(f, "web_step.opened")).toHaveLength(1);

    // Resposta incompleta: a página volta com os erros e o link continua.
    const incomplete = await submit(code, { f_nome: "Maria" });
    expect(incomplete.status).toBe(422);
    const again = await incomplete.text();
    expect(again).toContain("Preencha este campo");
    expect(again).toContain('value="Maria"');
    expect((await step(c.id)).status).toBe("opened");

    // Concluir.
    const done = await submit(code, valid);
    expect(done.status).toBe(200);
    const donePage = await done.text();
    expect(donePage).toContain("Tudo certo, pode voltar ao WhatsApp.");
    expect(donePage).toContain('href="https://wa.me/5511900001111"');
    expect(donePage).toContain("Voltar ao WhatsApp");
    row = await step(c.id);
    expect(row.status).toBe("completed");
    expect(json(row.result)).toEqual({
      nome: "Maria da Silva",
      plano: "Anual",
      nascimento: "1990-04-21",
      termos: true,
      obs: "",
    });
    // Evento interno, evento do módulo, nota para a equipe e retorno.
    const [completed] = await events(f, "web_step.completed");
    expect(json(completed.payload)).toMatchObject({
      conversation_id: c.id,
      module_id: "forms",
      answers: { plano: "Anual" },
    });
    const [submitted] = await events(f, "form.submitted");
    expect(json(submitted.payload)).toMatchObject({
      form_id: "cadastro",
      module_id: "forms",
    });
    const note = await one(
      env,
      "SELECT * FROM messages WHERE conversation_id=? AND direction='note' ORDER BY created DESC LIMIT 1",
      c.id,
    );
    expect(note.text).toContain("Plano: Anual");
    expect(note.text).toContain("Data de nascimento: 21/04/1990");
    const back = await one(
      env,
      "SELECT kind,payload FROM outbox WHERE conversation_id=? AND dedupe=?",
      c.id,
      `web-step-done:${row.id}`,
    );
    expect(back.kind).toBe("notification");
    expect(json(back.payload).text).toBe(
      "Cadastro recebido! Já vamos analisar.",
    );

    // Reuso: o mesmo link não aceita outra resposta.
    const reuse = await submit(code, { ...valid, f_nome: "Outra pessoa" });
    expect(reuse.status).toBe(410);
    expect(await reuse.text()).toContain("Este link já foi usado");
    expect(json((await step(c.id)).result).nome).toBe("Maria da Silva");
    expect(await events(f, "web_step.completed")).toHaveLength(1);
    expect(await (await page(code)).text()).toContain("Este link já foi usado");
  });

  it("linha QR recebe o link no texto, sem botão", async () => {
    const f = await setup();
    const { sent, code } = await openByMenu(f, "5511940000002", f.qr);
    expect(code).toMatch(webStepCode);
    expect(sent.content).toBeUndefined();
  });

  it("link desconhecido ou adulterado", async () => {
    await setup();
    expect((await page("ZZZZZZZZZZZZZZZZ")).status).toBe(404);
    expect((await page("curto")).status).toBe(404);
    expect((await submit("ZZZZZZZZZZZZZZZZ", valid)).status).toBe(404);
  });
});

describe("passo web: contato, protocolo e janela de 24 horas", () => {
  it("anexa as respostas ao contato vinculado e ao protocolo ativo", async () => {
    const f = await setup();
    const { c, code } = await openByMenu(f, "5511940000003");
    const contact = uid();
    await exec(
      env,
      "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'panel','Maria','maria','panel','test','test',?,?)",
      contact,
      f.profile,
      now(),
      now(),
    );
    await exec(
      env,
      "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      c.id,
      f.profile,
      contact,
      "test",
      now(),
    );
    const { ticket } = await createTicket(env, c, "Dúvida sobre plano");
    expect((await submit(code, valid)).status).toBe(200);
    const row = await step(c.id);
    expect(row).toMatchObject({ contact_id: contact, ticket_id: ticket.id });
    const update = await one(
      env,
      "SELECT * FROM ticket_updates WHERE ticket_id=? AND id=?",
      ticket.id,
      "web-step:" + row.id,
    );
    expect(update.text).toContain("Nome completo: Maria da Silva");
    // O retorno informa o protocolo.
    expect(
      json(
        (
          await one(
            env,
            "SELECT payload FROM outbox WHERE dedupe=?",
            `web-step-done:${row.id}`,
          )
        ).payload,
      ).text,
    ).toContain(`Protocolo: ${ticket.number}`);
    // Detalhe do contato traz as respostas.
    const detail = await (
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/contacts/${contact}`,
      )
    ).json<any>();
    expect(detail.web_steps).toHaveLength(1);
    expect(detail.web_steps[0]).toMatchObject({
      status: "completed",
      answers: { nome: "Maria da Silva" },
    });
  });

  it("abre protocolo quando o formulário pede e não há um ativo", async () => {
    const f = await setup({ ticket: "open" });
    const { c, code } = await openByMenu(f, "5511940000004");
    expect((await submit(code, valid)).status).toBe(200);
    const tickets = await all(
      env,
      "SELECT * FROM tickets WHERE conversation_id=?",
      c.id,
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe("Cadastro");
    expect((await step(c.id)).ticket_id).toBe(tickets[0].id);
  });

  it("janela fechada: o retorno sai como notificação (modelo configurado)", async () => {
    const f = await setup({ ticket: "none" });
    const { c, code } = await openByMenu(f, "5511940000005");
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86400000,
      c.id,
    );
    expect((await submit(code, valid)).status).toBe(200);
    const row = await step(c.id);
    expect(row.ticket_id).toBeNull();
    const back = await one(
      env,
      "SELECT kind FROM outbox WHERE dedupe=?",
      `web-step-done:${row.id}`,
    );
    // Fora da janela, enqueue classifica a notificação como modelo.
    expect(back.kind).toBe("notification");
    const quota = await all(
      env,
      "SELECT * FROM outbox WHERE dedupe=?",
      `web-step-done:${row.id}`,
    );
    expect(quota).toHaveLength(1);
  });
});

describe("passo web: expiração, cancelamento e gatilhos", () => {
  it("expira pelo tempo (página e alarme) e recusa resposta", async () => {
    const f = await setup();
    const { c, code } = await openByMenu(f, "5511940000006");
    await exec(
      env,
      "UPDATE web_steps SET expires_at=? WHERE conversation_id=?",
      now() - 1000,
      c.id,
    );
    const expired = await submit(code, valid);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("Este link expirou");
    expect((await step(c.id)).status).toBe("expired");
    expect(await events(f, "web_step.expired")).toHaveLength(1);

    // Outro link vence sem ninguém abrir: o alarme da área marca.
    const second = await openByMenu(f, "5511940000007");
    await exec(
      env,
      "UPDATE web_steps SET expires_at=? WHERE conversation_id=?",
      now() - 1000,
      second.c.id,
    );
    await expireWebSteps(env, f.profile);
    expect((await step(second.c.id)).status).toBe("expired");
    expect((await page(second.code)).status).toBe(410);
  });

  it(
    "atendente envia pela conversa e cancela; estado aparece na conversa",
    { timeout: 30000 },
    async () => {
      const f = await setup();
      const c = await say(f, "bom dia", "5511940000008");
      const token = await bearer(f.member);
      const action = (body: any) =>
        api(
          token,
          `/profiles/${f.profile}/conversations/${c.id}/actions`,
          "POST",
          body,
        );
      // Sem assumir a conversa, recusa.
      let response = await action({ action: "form", form_id: "cadastro" });
      expect(response.status).toBe(400);
      await action({ action: "claim" });
      response = await action({ action: "form", form_id: "cadastro" });
      expect(response.status).toBe(200);
      const created = await response.json<any>();
      expect(created).toMatchObject({
        status: "sent",
        trigger: "agent",
        actor: f.member.id,
      });
      // Formulário inexistente.
      expect((await action({ action: "form", form_id: "nada" })).status).toBe(
        400,
      );

      const detail = await (
        await api(token, `/profiles/${f.profile}/conversations/${c.id}`)
      ).json<any>();
      expect(detail.web_steps.map((s: any) => s.status)).toEqual(["sent"]);
      const listed = await (
        await api(
          token,
          `/profiles/${f.profile}/conversations/${c.id}/web-steps`,
        )
      ).json<any>();
      expect(listed.data[0].id).toBe(created.id);

      const cancel = await api(
        token,
        `/profiles/${f.profile}/web-steps/${created.id}/cancel`,
        "POST",
        {},
      );
      expect(cancel.status).toBe(200);
      expect((await cancel.json<any>()).status).toBe("cancelled");
      const code = codeIn((await latest(c.id)).text);
      expect((await page(code)).status).toBe(410);
      expect((await submit(code, valid)).status).toBe(410);
      expect(
        (
          await api(
            token,
            `/profiles/${f.profile}/web-steps/${created.id}/cancel`,
            "POST",
            {},
          )
        ).status,
      ).toBe(409);
    },
  );

  it("ferramenta do bot: send_form pelo MCP envia com gatilho bot", async () => {
    const f = await setup();
    const c = await say(f, "bom dia", "5511940000009");
    const app = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    // A aplicação assume a conversa, como o Hermes faz antes de responder.
    await api(
      app.token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      {
        action: "claim",
      },
    );
    const mcp = (name: string, args: any) =>
      SELF.fetch("https://test/api/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }).then((r) => r.json<any>());
    const forms = await mcp("list_forms", { profile: f.profile });
    expect(forms.result.structuredContent.data[0]).toMatchObject({
      id: "cadastro",
      title: "Cadastro",
    });
    const sent = await mcp("send_form", {
      profile: f.profile,
      conversation_id: c.id,
      form_id: "cadastro",
    });
    expect(sent.result.isError).toBeFalsy();
    expect(sent.result.structuredContent).toMatchObject({
      status: "sent",
      trigger: "bot",
    });
    const steps = await mcp("list_web_steps", {
      profile: f.profile,
      conversation_id: c.id,
    });
    expect(steps.result.structuredContent.data).toHaveLength(1);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_forms", "send_form", "list_web_steps"]),
    );
  });

  it("módulo Formulários desligado: some do menu, rota recusa, link fica indisponível", async () => {
    const f = await setup();
    const { code } = await openByMenu(f, "5511940000010");
    await run(f, f.admin, "module.set", { id: "forms", enabled: false });
    const c = await say(f, "oi", "5511940000011");
    expect((await latest(c.id)).text).not.toContain("Preencher cadastro");
    const token = await bearer(f.admin);
    expect((await api(token, `/profiles/${f.profile}/forms`)).status).toBe(409);
    const blocked = await page(code);
    expect(blocked.status).toBe(410);
    expect(await blocked.text()).toContain("Link indisponível");
    expect((await submit(code, valid)).status).toBe(410);
  });

  it("valida formulários e recusa item de menu apontando para formulário inexistente", async () => {
    const f = await setup();
    await expect(
      configure(f, { forms: [{ id: "x", name: "X", fields: [] }] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      configure(f, {
        forms: [
          {
            id: "x",
            name: "X",
            fields: [{ id: "a", type: "choice", label: "A", options: ["só"] }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // Excluir o formulário usado no menu é recusado.
    await expect(configure(f, { forms: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      configure(f, {
        menus: [{ id: "m", label: "Outro", type: "form", form_id: "nada" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
