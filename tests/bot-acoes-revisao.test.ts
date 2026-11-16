// Correções da revisão de segurança do bot agindo pela pessoa e no
// atendimento ao cliente (sessão A): segundo fator na confirmação, texto da
// proposta montado no servidor, CONFIRMAR digitado só com uma proposta e
// depois dos módulos, e decisão de aprovação que travou em `deciding`.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { sha } from "../src/security";
import { requireFinancialAal } from "../src/mfa";
import {
  botActionContext,
  newToolState,
  runBotTool,
} from "../src/bot-actions/actions";
import {
  customerToolContext,
  runCustomerTool,
} from "../src/bot-actions/customer";
import { resetCatalogCache } from "../src/bot-actions/catalog";
import { moduleById } from "../src/modules/registry";
import { describeFields } from "../src/bot-actions/describe";
import {
  DECIDING_TTL,
  decideApproval,
  expireApprovals,
} from "../src/approvals";
import { onConversationTurn } from "../src/modules/api";
import { agendaSetup, at, future } from "./agenda-fixture";
import {
  api,
  bearer,
  bot,
  drain,
  fixture,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

async function policy(value: string) {
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    value,
    now(),
  );
}
const restores: (() => void)[] = [];
afterEach(async () => {
  await policy("off");
  for (const restore of restores.splice(0)) restore();
  resetCatalogCache();
});
/**
 * Tira a marca `sensitive` do módulo durante o teste (a Mensalidade e o
 * Suporte marcam todas as escritas), para provar o guarda do núcleo sozinho.
 */
function unmarked(id: string) {
  const def = moduleById(id) as any;
  const mark = def.bot;
  def.bot = undefined;
  restores.push(() => {
    def.bot = mark;
  });
  resetCatalogCache();
}

/** A pessoa escreve ao bot na conversa interna; devolve a execução. */
async function ask(f: Fixture, person: Actor, botId: string, text: string) {
  const chat = await perform(
    env,
    person,
    f.profile,
    "internal.create",
    { peer_id: `bot:${botId}` },
    uid(),
  );
  const message = await perform(
    env,
    person,
    f.profile,
    "internal.send",
    { id: chat.id, text },
    uid(),
  );
  return {
    chat,
    run: await one(env, "SELECT * FROM bot_runs WHERE id=?", message.run_id),
  };
}
async function propose(
  run: any,
  operacao: string,
  parametros: any,
  resumo: string,
) {
  const ctx = await botActionContext(env, run);
  expect(ctx, "contexto da pessoa").toBeTruthy();
  return JSON.parse(
    await runBotTool(ctx!, newToolState(), "propor_acao", {
      operacao,
      parametros,
      resumo,
    }),
  );
}
const confirm = (token: string, f: Fixture, chat: string, id: string) =>
  api(
    token,
    `/profiles/${f.profile}/internal-chats/${chat}/proposals/${id}/confirm`,
    "POST",
    {},
  );
/** Sobe a sessão do token para aal2, como o desafio do código faz. */
const raise = async (token: string) =>
  exec(
    env,
    "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?",
    now(),
    await sha(token),
  );

describe("segundo fator na confirmação da proposta", () => {
  it("política financial: confirmar em aal1 operação da Mensalidade sem `sensitive` pede o código", async () => {
    const f = await fixture();
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "mensalidade", enabled: true },
      uid(),
    );
    unmarked("mensalidade");
    const botId = await bot(f);
    const admin = await bearer(f.admin);
    const { chat, run } = await ask(
      f,
      f.admin,
      botId,
      "Crie o plano Mensal de R$ 50",
    );
    const proposed = await propose(
      run,
      "mensalidade.plan.create",
      { name: "Mensal", amount_cents: 5000 },
      "Criar plano",
    );
    expect(proposed.proposta, JSON.stringify(proposed)).toBeTruthy();
    expect(
      (
        await one(
          env,
          "SELECT sensitive FROM bot_proposals WHERE id=?",
          proposed.proposta,
        )
      ).sensitive,
    ).toBe(0);
    await policy("financial");
    const denied = await confirm(admin, f, chat.id, proposed.proposta);
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe("mfa_required");
    // Nada rodou e a proposta segue aberta para depois do código.
    expect(
      (
        await one(
          env,
          "SELECT status FROM bot_proposals WHERE id=?",
          proposed.proposta,
        )
      ).status,
    ).toBe("pending");
    expect(
      await all(
        env,
        "SELECT id FROM mensalidade_plans WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(0);
    // Com o código (aal2), a mesma proposta roda.
    await raise(admin);
    const done = await (
      await confirm(admin, f, chat.id, proposed.proposta)
    ).json<any>();
    expect(done.status, JSON.stringify(done)).toBe("done");
    expect(
      await all(
        env,
        "SELECT id FROM mensalidade_plans WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(1);
    // Política off: aal1 basta.
    await policy("off");
    const other = await propose(
      run,
      "mensalidade.plan.create",
      { name: "Anual", amount_cents: 50000 },
      "Criar plano",
    );
    expect(
      (
        await (
          await confirm(await bearer(f.admin), f, chat.id, other.proposta)
        ).json<any>()
      ).status,
    ).toBe("done");
  });

  it("política financial: ação do Suporte pelo bot em aal1 também pede o código", async () => {
    const f = await fixture();
    for (const id of ["mensalidade", "suporte"])
      await perform(
        env,
        f.admin,
        f.profile,
        "module.set",
        { id, enabled: true },
        uid(),
      );
    unmarked("suporte");
    const c = await receive(f, f.line, "oi", "5511933330003");
    await drain(f);
    const botId = await bot(f);
    const admin = await bearer(f.admin);
    const { chat, run } = await ask(f, f.admin, botId, "Dê uma cortesia");
    const proposed = await propose(
      run,
      "suporte.courtesy",
      { id: c.id, reason: "Cliente antigo" },
      "Cortesia",
    );
    expect(proposed.proposta, JSON.stringify(proposed)).toBeTruthy();
    await policy("financial");
    const denied = await confirm(admin, f, chat.id, proposed.proposta);
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe("mfa_required");
  });

  it("ator do bot sem a política no ator falha fechado", () => {
    const actor: Actor = {
      id: uid(),
      kind: "user",
      name: "P",
      role: "admin",
      profiles: [],
      scopes: [],
      bots: [],
      rate: 1,
      runLimit: 1,
      via: { kind: "bot", bot_id: "b", run_id: "r", masked: true },
    };
    expect(() => requireFinancialAal(actor)).toThrow();
    expect(() => requireFinancialAal({ ...actor, aal: 2 })).not.toThrow();
    // Sem via e sem sessão (ator interno): segue como antes.
    expect(() =>
      requireFinancialAal({ ...actor, via: undefined }),
    ).not.toThrow();
  });
});

describe("texto da proposta montado no servidor", () => {
  it("equipe: o cartão mostra os parâmetros reais; o resumo do modelo vai à parte", async () => {
    const f = await fixture();
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: true },
      uid(),
    );
    const botId = await bot(f);
    const member = await bearer(f.member);
    const { chat, run } = await ask(f, f.member, botId, "Abra uma OS");
    const proposed = await propose(
      run,
      "os.create",
      { item: "Geladeira", problem: "Não gela", phone: "5511966660009" },
      "Abrir OS do notebook",
    );
    const detail = await (
      await api(member, `/profiles/${f.profile}/internal-chats/${chat.id}`)
    ).json<any>();
    const message = detail.messages.find((m: any) => m.kind === "proposal");
    const proposal = message.payload.proposal;
    expect(proposal.description).toContain("item: Geladeira");
    expect(proposal.description).not.toContain("notebook");
    expect(proposal.summary).toBe("Abrir OS do notebook");
    expect(message.text).toContain("item: Geladeira");
    expect(message.text).toContain(
      "Texto do bot (não conferido): Abrir OS do notebook",
    );
  });

  it("cliente: o botão traz o serviço, a data e o valor da Agenda, não o texto do modelo", async () => {
    const s = await agendaSetup();
    const botId = await bot(s.f);
    const c = await receive(s.f, s.f.line, "oi", "5511944440004");
    await drain(s.f);
    const run = await customerRunFor(s.f, botId, c.id);
    const ctx = (await customerToolContext(env, run))!;
    const starts = at(future(), "10:00");
    const proposed = JSON.parse(
      await runCustomerTool(ctx, newToolState(), "agenda_agendar", {
        service_id: s.corte.id,
        starts,
        resumo: "Agendar corte GRÁTIS amanhã",
      }),
    );
    const text = (await outbox(c.id)).at(-1).text as string;
    expect(text).toContain(`Agendar: ${s.corte.name}`);
    expect(text).toContain("Quando:");
    expect(text).not.toContain("GRÁTIS");
    expect(
      (
        await one(
          env,
          "SELECT description FROM bot_proposals WHERE id=?",
          proposed.proposta,
        )
      ).description,
    ).toContain(s.corte.name);
  });

  it("sem descrição do módulo: a ação e os campos, com centavos em reais", () => {
    const text = describeFields("Criar plano", {
      name: "Mensal",
      amount_cents: 5000,
    });
    expect(text).toContain("• name: Mensal");
    expect(text).toContain("R$");
  });
});

async function customerRunFor(
  f: Fixture,
  botId: string,
  conversationId: string,
) {
  await exec(
    env,
    "UPDATE conversations SET state='ai' WHERE id=?",
    conversationId,
  );
  const c = await conversation(env, conversationId, f.profile);
  const id = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,?,?,?, 'running','{}', 'attendant','{}',?,?)",
    id,
    f.profile,
    botId,
    "bot:attendant",
    conversationId,
    c.epoch,
    now(),
    now(),
  );
  return one(env, "SELECT * FROM bot_runs WHERE id=?", id);
}

describe("resposta digitada do cliente", () => {
  async function pending(phone: string) {
    const s = await agendaSetup();
    const botId = await bot(s.f);
    const c = await receive(s.f, s.f.line, "oi", phone);
    await drain(s.f);
    const run = await customerRunFor(s.f, botId, c.id);
    const ctx = (await customerToolContext(env, run))!;
    const book = async (hour: string) =>
      JSON.parse(
        await runCustomerTool(ctx, newToolState(), "agenda_agendar", {
          service_id: s.corte.id,
          starts: at(future(), hour),
          resumo: "Agendar",
        }),
      ).proposta as string;
    const say = async (text: string) => {
      await receive(s.f, s.f.line, text, phone);
      await drain(s.f);
    };
    const status = async (id: string) =>
      (await one(env, "SELECT status FROM bot_proposals WHERE id=?", id))
        .status;
    return { s, c, book, say, status };
  }

  it("'sim' solto não confirma; CONFIRMAR com uma só proposta confirma", async () => {
    const t = await pending("5511955550005");
    const id = await t.book("10:00");
    for (const word of ["sim", "SIM", "Confirmo", "não"]) await t.say(word);
    expect(await t.status(id)).toBe("pending");
    // As mensagens acima passaram pela fila (sem bot de verdade aqui): a
    // conversa volta ao bot, como estaria no atendimento.
    await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", t.c.id);
    await t.say("Confirmar");
    const row = await one(
      env,
      "SELECT status,error FROM bot_proposals WHERE id=?",
      id,
    );
    expect(row.status, String(row.error)).toBe("done");
  });

  it("com duas propostas abertas, CONFIRMAR digitado não escolhe nenhuma", async () => {
    const t = await pending("5511955550006");
    const first = await t.book("10:00");
    const second = await t.book("11:00");
    await t.say("CONFIRMAR");
    expect(await t.status(first)).toBe("pending");
    expect(await t.status(second)).toBe("pending");
    expect((await outbox(t.c.id)).at(-1).text).toContain(
      "mais de um pedido aberto",
    );
    // CANCELAR também não escolhe.
    await t.say("CANCELAR");
    expect(await t.status(first)).toBe("pending");
  });

  it("o gancho do módulo trata a mensagem antes da proposta", async () => {
    const t = await pending("5511955550007");
    const id = await t.book("10:00");
    // Um módulo com pergunta em aberto nesta conversa trata o CONFIRMAR.
    let handled = 0;
    onConversationTurn("agenda", async (_ctx, c, turn) => {
      if (c.id !== t.c.id || turn.text.trim().toUpperCase() !== "CONFIRMAR")
        return false;
      handled++;
      return true;
    });
    await t.say("CONFIRMAR");
    expect(handled).toBe(1);
    expect(await t.status(id)).toBe("pending");
  });
});

describe("aprovação travada em deciding", () => {
  async function stuck(f: Fixture, expiresIn: number) {
    const c = await receive(f, f.line, "oi", "5511966670007");
    await drain(f);
    const id = uid();
    await exec(
      env,
      "INSERT INTO approvals(id,profile_id,module_id,kind,conversation_id,title,fields,approvers,status,decided_by,expires_at,source_key,created,updated) VALUES(?,?,?,?,?,?,'[]','{\"admin\":true}','deciding',?,?,?,?,?)",
      id,
      f.profile,
      "teste",
      "pedido",
      c.id,
      "Pedido de teste",
      f.other.id,
      now() + expiresIn,
      `teste:${id}`,
      now() - DECIDING_TTL - 1000,
      now() - DECIDING_TTL - 1000,
    );
    return id;
  }

  it("volta a pendente depois do prazo; outra pessoa decide", async () => {
    const f = await fixture();
    const id = await stuck(f, 3600000);
    // Ainda em deciding, mas vencido o prazo: a decisão retoma direto.
    const decided = await decideApproval(
      env,
      f.admin,
      f.profile,
      id,
      { decision: "decline" },
      uid(),
    );
    expect(decided.status).toBe("declined");
    expect(decided.decided_by).toBe(f.admin.id);
  });

  it("a rodada periódica devolve a pendente, ou vence se o prazo do pedido passou", async () => {
    const f = await fixture();
    const live = await stuck(f, 3600000);
    const late = await stuck(f, -1000);
    await expireApprovals(env, f.profile);
    expect(
      await one(
        env,
        "SELECT status,decided_by FROM approvals WHERE id=?",
        live,
      ),
    ).toMatchObject({ status: "pending", decided_by: null });
    expect(
      (await one(env, "SELECT status FROM approvals WHERE id=?", late)).status,
    ).toBe("expired");
  });

  it("decisão em andamento recente continua protegida", async () => {
    const f = await fixture();
    const id = await stuck(f, 3600000);
    await exec(env, "UPDATE approvals SET updated=? WHERE id=?", now(), id);
    await expect(
      decideApproval(
        env,
        f.admin,
        f.profile,
        id,
        { decision: "decline" },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "approval_closed" });
    await expireApprovals(env, f.profile);
    expect(
      (await one(env, "SELECT status FROM approvals WHERE id=?", id)).status,
    ).toBe("deciding");
  });
});
