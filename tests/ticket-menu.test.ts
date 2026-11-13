import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Run } from "../src/types";
import { setSecret } from "../src/security";
import { decideInterpretation } from "../src/jev";
import {
  conversation,
  handoff,
  inbound,
  perform,
  requestSurvey,
} from "../src/service";
import { processInbox, processRun } from "../src/engine";
import { availableMenus } from "../src/line-service";
import { TICKET_PROMPT_MS } from "../src/ticket-flow";
import { defaultTicketQuestion } from "../src/protocols";
import {
  bot,
  claim,
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  tickets,
  type Fixture,
} from "./service-center-fixture";

const PHONE = "5511999998888";
const fresh = (f: Fixture, id: string) => conversation(env, id, f.profile);
/** Someone is present, so an ordinary handoff does not open its own protocol. */
const present = (f: Fixture) =>
  exec(
    env,
    "INSERT INTO presence(profile_id,actor,present,updated) VALUES(?,?,1,?)",
    f.profile,
    f.admin.id,
    now(),
  );
async function say(f: Fixture, text: string, line = f.line, content: any = {}) {
  const c = await receive(f, line, text, PHONE, content);
  await drain(f);
  return fresh(f, c.id);
}
const categories = [
  { id: "printher", name: "Printher" },
  { id: "vinki", name: "Vinki", enabled: false },
];

describe("palavra PROTOCOLO", () => {
  it("pergunta a descrição, abre o protocolo sem fila nem responsável e confirma", async () => {
    const f = await fixture();
    let c = await say(f, "Protocolo");
    const question = await latest(c.id);
    expect(question.text).toContain(defaultTicketQuestion);
    expect(question.text).toContain("Para cancelar, envie MENU.");
    expect(c.ticket_prompt_expires_at).toBeGreaterThan(
      now() + TICKET_PROMPT_MS - 60000,
    );
    expect(c.ticket_prompt_expires_at).toBeLessThanOrEqual(
      now() + TICKET_PROMPT_MS,
    );
    expect(c).toMatchObject({ state: "ai", owner: null });
    expect(await tickets(c.id)).toHaveLength(0);

    const description =
      "O aplicativo fecha sozinho\nquando abro   o relatório.\nJá reinstalei.";
    c = await say(f, description);
    const [ticket] = await tickets(c.id);
    expect(ticket).toMatchObject({
      title:
        "O aplicativo fecha sozinho quando abro o relatório. Já reinstalei.",
      status: "open",
      owner: null,
      category: null,
    });
    expect(ticket.response_due_at).toBeGreaterThan(now());
    expect(ticket.source_key).toMatch(/^inbox:/);
    // The full text is the first public update.
    expect(
      await all(
        env,
        "SELECT actor,text,internal FROM ticket_updates WHERE ticket_id=?",
        ticket.id,
      ),
    ).toEqual([{ actor: "customer", text: description, internal: 0 }]);
    const confirmation = await latest(c.id);
    expect(confirmation.text).toContain("Sua solicitação foi registrada.");
    expect(confirmation.text).toContain(`Protocolo: ${ticket.number}`);
    expect(confirmation.text).toContain(`Assunto: ${ticket.title}`);
    expect(confirmation.text).toContain("Primeira resposta da equipe: até ");
    expect(confirmation.text).not.toContain("Aplicativo:");
    expect(confirmation.text).toContain("MEUS PROTOCOLOS");
    // Asynchronous analysis: not queued, nobody responsible, prompt closed.
    expect(c).toMatchObject({
      state: "ai",
      owner: null,
      department_id: null,
      ticket_prompt_expires_at: null,
    });
    expect(await outbox(c.id)).toHaveLength(2);
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM events WHERE profile_id=? AND kind='ticket.created' AND resource_id=?",
          f.profile,
          ticket.id,
        )
      ).n,
    ).toBe(1);
  });
  it("aceita as três formas sem diferenciar maiúsculas, acentos e pontuação", async () => {
    for (const word of ["PROTOCOLO", "abrir protocolo", "Novo Protocolo!"]) {
      const f = await fixture();
      const c = await say(f, word);
      expect(c.ticket_prompt_expires_at).toBeTruthy();
      expect((await latest(c.id)).text).toContain(defaultTicketQuestion);
    }
  });
  it("mantém MEUS PROTOCOLOS, CONSULTAR PROTOCOLO e o número como consulta", async () => {
    const f = await fixture();
    for (const word of ["MEUS PROTOCOLOS", "consultar protocolo"]) {
      const c = await say(f, word);
      expect(c.ticket_prompt_expires_at).toBeNull();
      expect((await latest(c.id)).text).toContain("Ainda não há protocolos");
    }
    // A sentence that merely mentions the word goes to the normal service.
    await present(f);
    const c = await say(f, "qual o protocolo para trocar de plano?");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect(await tickets(c.id)).toHaveLength(0);
  });
  it("corta o título em 300 caracteres e guarda o texto completo", async () => {
    const f = await fixture();
    await say(f, "protocolo");
    const long = "relato ".repeat(80).trim();
    const c = await say(f, long);
    const [ticket] = await tickets(c.id);
    expect(Array.from(ticket.title)).toHaveLength(300);
    expect(
      (
        await one(
          env,
          "SELECT text FROM ticket_updates WHERE ticket_id=?",
          ticket.id,
        )
      ).text,
    ).toBe(long);
  });
  it("abre sempre um protocolo novo, mesmo com outro ativo na conversa", async () => {
    const f = await fixture();
    await say(f, "protocolo");
    await say(f, "Primeiro pedido");
    await say(f, "abrir protocolo");
    const c = await say(f, "Segundo pedido");
    expect((await tickets(c.id)).map((t) => t.title)).toEqual([
      "Primeiro pedido",
      "Segundo pedido",
    ]);
  });
  it("não muda o responsável nem o estado de uma conversa em atendimento humano", async () => {
    const f = await fixture();
    await present(f);
    let c = await say(f, "preciso de ajuda");
    await claim(f, f.member, c.id);
    c = await say(f, "protocolo");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    c = await say(f, "Erro ao emitir nota");
    const [ticket] = await tickets(c.id);
    expect(ticket).toMatchObject({ title: "Erro ao emitir nota", owner: null });
    expect(c).toMatchObject({ state: "human", owner: f.member.id });
  });
});

describe("cancelamento, expiração e repetição", () => {
  it("MENU cancela sem abrir protocolo", async () => {
    const f = await fixture();
    await present(f);
    await say(f, "protocolo");
    let c = await say(f, "Menu");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect((await latest(c.id)).text).toBe("Abertura de protocolo cancelada.");
    // The next message is ordinary service again, not a description.
    c = await say(f, "quero saber o preço");
    expect(await tickets(c.id)).toHaveLength(0);
  });
  it("VOLTAR cancela e reapresenta o nível de menu em que o cliente estava", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        { id: "ajuda", label: "Ajuda", type: "submenu" },
        {
          id: "abrir",
          label: "Abrir protocolo",
          type: "ticket",
          parent_id: "ajuda",
        },
        {
          id: "dica",
          label: "Dicas",
          type: "content",
          content: "Reinicie o aplicativo.",
          parent_id: "ajuda",
        },
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
    });
    await say(f, "Olá");
    await say(f, "1");
    let c = await say(f, "1");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    c = await say(f, "voltar");
    expect(c.ticket_prompt_expires_at).toBeNull();
    const sent = await outbox(c.id);
    expect(sent.at(-2).text).toBe("Abertura de protocolo cancelada.");
    expect(sent.at(-1).text).toContain("Abrir protocolo");
    expect(sent.at(-1).text).toContain("Dicas");
    expect(c.menu_parent).toBe("ajuda");
    expect(await tickets(c.id)).toHaveLength(0);
    // MENU after a new attempt goes to the main menu.
    await say(f, "1");
    c = await say(f, "MENU");
    expect(c.menu_parent).toBeNull();
    expect((await latest(c.id)).text).toContain("Horário");
    expect(await tickets(c.id)).toHaveLength(0);
  });
  it("depois de 30 minutos a mensagem volta a ser atendimento comum", async () => {
    const f = await fixture();
    await present(f);
    let c = await say(f, "protocolo");
    await exec(
      env,
      "UPDATE conversations SET ticket_prompt_expires_at=? WHERE id=?",
      now() - 1000,
      c.id,
    );
    c = await say(f, "Descrição que chegou tarde");
    expect(await tickets(c.id)).toHaveLength(0);
    // Without a bot the ordinary flow hands the conversation to the team.
    expect(c.state).toBe("waiting");
  });
  it("uma pergunta de sessão anterior não captura a nova conversa", async () => {
    const f = await fixture();
    await present(f);
    let c = await say(f, "protocolo");
    await exec(env, "UPDATE conversations SET state='closed' WHERE id=?", c.id);
    c = await say(f, "Voltei com outro assunto");
    expect(c.session).not.toBe(c.ticket_prompt_session);
    expect(await tickets(c.id)).toHaveLength(0);
  });
  it("reprocessar a descrição não cria um segundo protocolo nem outra confirmação", async () => {
    const f = await fixture();
    await say(f, "protocolo");
    const prompt = await one(
      env,
      "SELECT ticket_prompt_expires_at e,ticket_prompt_session s,ticket_prompt_source o FROM conversations WHERE profile_id=?",
      f.profile,
    );
    const message = uid();
    const send = () =>
      inbound(
        env,
        f.profile,
        {
          external_id: PHONE,
          phone: PHONE,
          message_id: message,
          text: "Não consigo entrar",
        },
        `channel:${f.line}`,
        f.line,
      );
    const first = await send();
    await drain(f);
    const c = first.conversation_id;
    expect(await tickets(c)).toHaveLength(1);
    const sent = (await outbox(c)).length;
    // 1. The provider delivers the same webhook again.
    expect((await send()).duplicate).toBe(true);
    await drain(f);
    // 2. The engine is interrupted after the work and runs the row again.
    await exec(
      env,
      "UPDATE inbox SET status='pending' WHERE conversation_id=? AND event_key LIKE ?",
      c,
      `%:${message}`,
    );
    await drain(f);
    // 3. Interrupted between opening the protocol and leaving the question.
    await exec(
      env,
      "UPDATE conversations SET ticket_prompt_expires_at=?,ticket_prompt_session=?,ticket_prompt_source=? WHERE id=?",
      prompt.e,
      prompt.s,
      prompt.o,
      c,
    );
    await exec(
      env,
      "UPDATE inbox SET status='pending' WHERE conversation_id=? AND event_key LIKE ?",
      c,
      `%:${message}`,
    );
    await drain(f);
    expect(await tickets(c)).toHaveLength(1);
    expect((await outbox(c)).length).toBe(sent);
    expect((await fresh(f, c)).ticket_prompt_expires_at).toBeNull();
    expect(
      await all(
        env,
        "SELECT id FROM ticket_updates WHERE ticket_id=?",
        (await tickets(c))[0].id,
      ),
    ).toHaveLength(1);
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM events WHERE profile_id=? AND kind='ticket.created'",
          f.profile,
        )
      ).n,
    ).toBe(1);
  });
  it("reprocessar a mensagem que fez a pergunta não vira descrição", async () => {
    const f = await fixture();
    await present(f);
    await configure(f, {
      menus: [
        { id: "abrir", label: "Abrir protocolo", type: "ticket" },
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
    });
    // By keyword.
    let c = await say(f, "protocolo");
    await exec(
      env,
      "UPDATE inbox SET status='pending' WHERE conversation_id=?",
      c.id,
    );
    await drain(f);
    expect(await tickets(c.id)).toHaveLength(0);
    expect((await fresh(f, c.id)).ticket_prompt_expires_at).toBeTruthy();
    expect(await outbox(c.id)).toHaveLength(1);
    await say(f, "menu");
    // By menu option: the replayed "1" must not become a protocol titled "1".
    c = await say(f, "1");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    const row = await one(
      env,
      "SELECT id FROM inbox WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
      c.id,
    );
    expect(c.ticket_prompt_source).toBe(row.id);
    await exec(env, "UPDATE inbox SET status='pending' WHERE id=?", row.id);
    await processInbox(env, f.profile);
    // (The replayed choice itself is no longer selectable and follows the
    // ordinary service; what matters is that it is not read as a description.)
    expect(await tickets(c.id)).toHaveLength(0);
  });
});

describe("o que responde e o que não responde à pergunta", () => {
  it("PROTOCOLO de novo repete a pergunta; a consulta e um botão deixam a pergunta", async () => {
    const f = await fixture();
    await configure(f, {
      ticket_categories: categories,
      menus: [
        {
          id: "abrir",
          label: "Abrir protocolo",
          type: "ticket",
          category_id: "printher",
        },
        {
          id: "horario",
          label: "Horário",
          type: "content",
          content: "9h às 18h",
        },
      ],
    });
    await say(f, "Olá");
    let c = await say(f, "1");
    expect(c.ticket_prompt_category).toBe("printher");
    // Asked again: same category, no protocol titled "protocolo".
    c = await say(f, "protocolo");
    expect(c.ticket_prompt_category).toBe("printher");
    expect(await tickets(c.id)).toHaveLength(0);
    // An explicit lookup is answered and leaves the question.
    c = await say(f, "meus protocolos");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect((await latest(c.id)).text).toContain("Ainda não há protocolos");
    // A button pressed while the question is open is never a description. The
    // menu it belongs to was already answered, so the customer is sent to MENU.
    await say(f, "menu");
    c = await say(f, "1");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    c = await say(f, "Horário", f.line, {
      interactive_reply_id: `wmenu:${c.menu_token}:horario`,
    });
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect((await latest(c.id)).text).toContain("não está mais disponível");
    expect(await tickets(c.id)).toHaveLength(0);
  });
  it("uma mensagem sem texto mantém a pergunta aberta", async () => {
    const f = await fixture();
    await say(f, "protocolo");
    let c = await say(f, "   ");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    expect((await latest(c.id)).text).toContain("mensagem de texto");
    expect(await tickets(c.id)).toHaveLength(0);
    c = await say(f, "Agora sim: tela branca ao abrir");
    expect(await tickets(c.id)).toHaveLength(1);
  });
  it("uma descrição que começa com número não vira nota de pesquisa", async () => {
    const f = await fixture();
    await present(f);
    let c = await say(f, "oi, tudo bem com vocês?");
    const survey = await requestSurvey(env, c, uid(), f.admin.id);
    await say(f, "protocolo");
    expect(
      (
        await one(
          env,
          "SELECT status FROM surveys WHERE id=?",
          survey.survey_id,
        )
      ).status,
    ).toBe("cancelled");
    c = await say(f, "3 dias sem acesso ao aplicativo");
    expect((await tickets(c.id)).map((t) => t.title)).toEqual([
      "3 dias sem acesso ao aplicativo",
    ]);
  });
  it("uma pesquisa pedida depois, ou uma pessoa assumindo, encerram a pergunta", async () => {
    const f = await fixture();
    let c = await say(f, "protocolo");
    const survey = await requestSurvey(env, c, uid(), f.admin.id);
    expect((await fresh(f, c.id)).ticket_prompt_expires_at).toBeNull();
    c = await say(f, "4 gostei");
    expect(await tickets(c.id)).toHaveLength(0);
    expect(
      await one(
        env,
        "SELECT score,status FROM surveys WHERE id=?",
        survey.survey_id,
      ),
    ).toMatchObject({ score: 4, status: "answered" });
    c = await say(f, "protocolo");
    expect(c.ticket_prompt_expires_at).toBeTruthy();
    await claim(f, f.member, c.id);
    c = await say(f, "Falo com você então");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect(await tickets(c.id)).toHaveLength(0);
  });
});

describe("destino de menu Abrir protocolo", () => {
  it("usa a pergunta e a categoria do destino e mostra o aplicativo na confirmação", async () => {
    const f = await fixture();
    await configure(f, {
      ticket_categories: categories,
      menus: [
        {
          id: "abrir",
          label: "Abrir protocolo",
          type: "ticket",
          category_id: "printher",
          content: "Conte o que aconteceu com a impressão.",
        },
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
    });
    await say(f, "Olá");
    let c = await say(f, "1");
    expect((await latest(c.id)).text).toContain(
      "Conte o que aconteceu com a impressão.",
    );
    expect(c).toMatchObject({ menu_active: 0, state: "ai" });
    c = await say(f, "A etiqueta sai cortada");
    const [ticket] = await tickets(c.id);
    expect(ticket).toMatchObject({
      title: "A etiqueta sai cortada",
      category: "printher",
      owner: null,
    });
    const text = (await latest(c.id)).text;
    expect(text).toContain("Aplicativo: Printher");
    expect(text.indexOf("Protocolo:")).toBeLessThan(
      text.indexOf("Aplicativo:"),
    );
    expect(c.state).toBe("ai");
  });
  it("abre sem categoria quando ela foi desabilitada depois", async () => {
    const f = await fixture();
    await configure(f, {
      ticket_categories: categories,
      menus: [
        {
          id: "abrir",
          label: "Abrir protocolo",
          type: "ticket",
          category_id: "vinki",
        },
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
    });
    await say(f, "Olá");
    await say(f, "1");
    const c = await say(f, "Não sincroniza");
    expect((await tickets(c.id))[0].category).toBeNull();
    expect((await latest(c.id)).text).not.toContain("Aplicativo:");
  });
  it("valida o destino ao salvar", async () => {
    const f = await fixture();
    await expect(
      configure(f, {
        ticket_categories: categories,
        menus: [
          { id: "abrir", label: "Abrir", type: "ticket", category_id: "outra" },
        ],
      }),
    ).rejects.toThrow("Categoria do menu");
    await expect(
      configure(f, {
        menus: [
          {
            id: "abrir",
            label: "Abrir",
            type: "ticket",
            content: "x".repeat(3501),
          },
        ],
      }),
    ).rejects.toThrow("3500");
    // Removing a category still used by a destination is refused.
    await configure(f, {
      ticket_categories: categories,
      menus: [
        {
          id: "abrir",
          label: "Abrir",
          type: "ticket",
          category_id: "printher",
        },
      ],
    });
    await expect(configure(f, { ticket_categories: [] })).rejects.toThrow(
      "Categoria do menu",
    );
  });
  it("não existe em grupos nem em linhas sem permissão de serviço", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        { id: "abrir", label: "Abrir protocolo", type: "ticket" },
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
    });
    const ids = async (line: string, chat = "direct") =>
      (await availableMenus(env, f.profile, line, null, false, chat)).map(
        (item: any) => item.id,
      );
    expect(await ids(f.line)).toEqual(["abrir", "horario"]);
    expect(await ids(f.line, "group")).toEqual(["horario"]);
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ number_policy: { service: false } }),
      f.second,
    );
    expect(await ids(f.second)).toEqual([]);
  });
});

describe("grupos e política da linha", () => {
  it("PROTOCOLO em grupo não inicia o fluxo", async () => {
    const f = await fixture();
    await present(f);
    const c = await receive(f, f.qr, "oi", "grupo-1");
    await drain(f);
    await exec(
      env,
      "UPDATE conversations SET chat_type='group',bot_policy='all',title='Clientes' WHERE id=?",
      c.id,
    );
    await receive(f, f.qr, "PROTOCOLO", "grupo-1");
    await drain(f);
    const after = await fresh(f, c.id);
    expect(after.ticket_prompt_expires_at).toBeNull();
    expect(
      (await outbox(c.id)).some((m) => m.text.includes(defaultTicketQuestion)),
    ).toBe(false);
    // Even a stale question left on the row is ignored in a group.
    await exec(
      env,
      "UPDATE conversations SET ticket_prompt_expires_at=?,ticket_prompt_session=session,ticket_prompt_source='x' WHERE id=?",
      now() + 60000,
      c.id,
    );
    await receive(f, f.qr, "isto não é uma descrição", "grupo-1");
    await drain(f);
    expect(
      (await tickets(c.id)).some((t) => t.source_key?.startsWith("inbox:")),
    ).toBe(false);
  });
  it("linha sem mensagens de serviço não pergunta, não abre e não responde", async () => {
    const f = await fixture();
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ number_policy: { service: false } }),
      f.line,
    );
    let c = await say(f, "protocolo");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect(await outbox(c.id)).toHaveLength(0);
    // A question asked before the restriction is not answered after it.
    await exec(
      env,
      "UPDATE conversations SET ticket_prompt_expires_at=?,ticket_prompt_session=session,ticket_prompt_source='x' WHERE id=?",
      now() + 60000,
      c.id,
    );
    c = await say(f, "Descrição com a linha restrita");
    expect(await tickets(c.id)).toHaveLength(0);
    expect(await outbox(c.id)).toHaveLength(0);
  });
  it("linha só de integração (sem menus nem bots) também não inicia o fluxo", async () => {
    const f = await fixture();
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ number_policy: { menu: false, bots: false } }),
      f.line,
    );
    const c = await say(f, "protocolo");
    expect(c.ticket_prompt_expires_at).toBeNull();
    expect(await outbox(c.id)).toHaveLength(0);
  });
  it("com a automação pausada a palavra não inicia o fluxo, mas a pergunta já feita é respondida", async () => {
    const f = await fixture();
    let c = await say(f, "protocolo");
    await exec(env, "UPDATE profiles SET enabled=0 WHERE id=?", f.profile);
    c = await say(f, "Pedido feito antes da pausa");
    expect(await tickets(c.id)).toHaveLength(1);
    c = await say(f, "protocolo");
    expect(c.ticket_prompt_expires_at).toBeNull();
  });
});

describe("confirmação nas outras aberturas", () => {
  it("na ausência da equipe as instruções vêm antes da confirmação e o protocolo ativo é reaproveitado", async () => {
    const f = await fixture();
    await configure(f, {
      absence_instructions: "Estamos fora do horário.",
      ticket_categories: categories,
    });
    const c = await receive(f, f.line, "quero falar com atendente");
    await drain(f);
    const [ticket] = await tickets(c.id);
    expect(ticket.source_key).toBeNull();
    const text = (await latest(c.id)).text;
    expect(text.startsWith("Estamos fora do horário.\n\nSua solicitação")).toBe(
      true,
    );
    expect(text).toContain(`Protocolo: ${ticket.number}`);
    expect(text).toContain("Assunto: Cliente solicitou atendimento humano.");
    expect(text).toContain("Primeira resposta da equipe: até ");
    expect(text).not.toContain("Aplicativo:");
    expect((await fresh(f, c.id)).state).toBe("waiting");
    // Second automatic opening: the active protocol is cited, not confirmed again.
    await exec(
      env,
      "UPDATE conversations SET session=? WHERE id=?",
      uid(),
      c.id,
    );
    await handoff(env, await fresh(f, c.id), "De novo");
    expect(await tickets(c.id)).toHaveLength(1);
    const again = (await latest(c.id)).text;
    expect(again).toContain(`Protocolo: ${ticket.number}.`);
    expect(again).not.toContain("Sua solicitação foi registrada.");
  });
  it("protocolo aberto por atendente não envia confirmação", async () => {
    const f = await fixture();
    await present(f);
    const c = await say(f, "preciso de ajuda");
    await claim(f, f.member, c.id);
    const before = (await outbox(c.id)).length;
    const ticket = await perform(
      env,
      f.member,
      f.profile,
      "ticket.create",
      { conversation_id: c.id, title: "Troca de plano" },
      uid(),
    );
    expect(ticket).toMatchObject({ owner: f.member.id, source_key: null });
    expect((await outbox(c.id)).length).toBe(before);
  });
});

describe("ação ticket do bot", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("com JEV ligado a abertura só é uma opção quando o bot propõe ticket com descrição", async () => {
    const decide = async (proposal: any) => {
      const run = { id: uid(), profile_id: uid(), phase: "attendant" } as Run;
      await setSecret(env, `jev:${run.profile_id}`, { key: "test-jev-only" });
      let criteria: Record<string, string> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, options: RequestInit) => {
          criteria = JSON.parse(String(options.body)).questions.route.criteria;
          return Response.json({
            model: "jev-latest",
            answers: {
              route: {
                type: "choice",
                choice: "ticket",
                confidence: 0.95,
                probabilities: { ticket: 0.95 },
              },
            },
          });
        }),
      );
      const decided = await decideInterpretation(
        env,
        run,
        {
          interpretation: {
            intent: "registrar problema",
            summary: "O cliente pediu para registrar que o aplicativo trava.",
            missing_information: [],
          },
          ...proposal,
        },
        { request: "Pode registrar?", sources: [] },
        { jev_enabled: true },
        [],
      );
      return { criteria: Object.keys(criteria).sort(), action: decided.action };
    };
    expect(
      await decide({ action: "ticket", text: "Aplicativo trava ao abrir." }),
    ).toEqual({ criteria: ["clarify", "human", "ticket"], action: "ticket" });
    // Not offered for another proposal or without a description: the answer
    // "ticket" is then outside the options and the conversation goes to a person.
    expect(await decide({ action: "ticket", text: " " })).toEqual({
      criteria: ["clarify", "human"],
      action: "human",
    });
    expect(await decide({ action: "protocols" })).toEqual({
      criteria: ["clarify", "human", "protocols"],
      action: "human",
    });
  });
  async function run(f: Fixture, c: any, botId: string, result: any) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,input,phase,context,status,result,remote_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      f.profile,
      botId,
      "bot:attendant",
      c.id,
      c.epoch,
      "{}",
      "attendant",
      JSON.stringify({ request: "pedido", sources: [], session: c.session }),
      "completed",
      JSON.stringify(result),
      "run_remote",
      now(),
      now(),
    );
    const again = async () =>
      processRun(
        env,
        (await one(env, "SELECT * FROM bot_runs WHERE id=?", id))!,
      );
    await again();
    return { id, again };
  }
  it("abre o protocolo com categoria, confirma e mantém a conversa com o bot", async () => {
    const f = await fixture(),
      botId = await bot(f);
    await configure(f, { attendant_bot: botId, ticket_categories: categories });
    let c = await receive(
      f,
      f.line,
      "meu Printher não imprime, pode registrar?",
    );
    const handled = await run(f, c, botId, {
      action: "ticket",
      text: "Printher não imprime etiquetas desde ontem.",
      category_id: "printher",
    });
    c = await fresh(f, c.id);
    const [ticket] = await tickets(c.id);
    expect(ticket).toMatchObject({
      title: "Printher não imprime etiquetas desde ontem.",
      category: "printher",
      owner: null,
      status: "open",
      source_key: "run:" + handled.id,
    });
    expect(
      await one(
        env,
        "SELECT actor,internal FROM ticket_updates WHERE ticket_id=?",
        ticket.id,
      ),
    ).toEqual({ actor: "bot:" + botId, internal: 0 });
    const text = (await latest(c.id)).text;
    expect(text).toContain(`Protocolo: ${ticket.number}`);
    expect(text).toContain("Aplicativo: Printher");
    expect(c).toMatchObject({ state: "ai", owner: null });
    // The result is handled again after an interruption: still one protocol.
    await exec(
      env,
      "UPDATE bot_runs SET completion_handled=0 WHERE id=?",
      handled.id,
    );
    await handled.again();
    expect(await tickets(c.id)).toHaveLength(1);
    expect(
      (await outbox(c.id)).filter((m) => m.text.includes("Protocolo:")),
    ).toHaveLength(1);
  });
  it("ignora categoria desconhecida e encaminha quando falta a descrição", async () => {
    const f = await fixture(),
      botId = await bot(f);
    await configure(f, { attendant_bot: botId, ticket_categories: categories });
    await present(f);
    let c = await receive(f, f.line, "registra pra mim");
    await run(f, c, botId, {
      action: "ticket",
      text: "Erro ao sincronizar",
      category_id: "inexistente",
    });
    expect((await tickets(c.id))[0]).toMatchObject({
      title: "Erro ao sincronizar",
      category: null,
    });
    const other = await receive(f, f.line, "outro", "5511999997777");
    await run(f, other, botId, { action: "ticket", text: "  " });
    expect(await tickets(other.id)).toHaveLength(0);
    expect((await fresh(f, other.id)).state).toBe("waiting");
    // The bot is told about the action and the categories it may use.
    c = await receive(
      f,
      f.line,
      "tenho uma dúvida sobre o relatório",
      "5511999996666",
    );
    await drain(f);
    const queued = await one(
      env,
      "SELECT input FROM bot_runs WHERE conversation_id=? AND status='queued'",
      c.id,
    );
    expect(JSON.parse(queued.input).categories).toEqual([
      { id: "printher", name: "Printher" },
    ]);
  });
});
