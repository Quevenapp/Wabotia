// Revisão do pedido pelo bot do cliente (sessão A, junção integra/onda4-v2):
// "sim" solto não confirma o pedido montado pelo bot, aprovar desconto pede
// o segundo fator com a política "financial", e a decisão retomada depois de
// travar (DECIDING_TTL) não aplica o desconto duas vezes nem avisa errado.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { newToolState } from "../src/bot-actions/actions";
import {
  customerToolContext,
  runCustomerTool,
} from "../src/bot-actions/customer";
import {
  DECIDING_TTL,
  decideApproval,
  expireApprovals,
} from "../src/approvals";
import {
  bot,
  drain,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";
import { pedidoSetup, seedMenu } from "./pedido-fixture";

const A = "5511977770001";

async function policy(value: string) {
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    value,
    now(),
  );
}
afterEach(() => policy("off"));

async function ordered(confirm = true) {
  const { f } = await pedidoSetup({
    config: { payments: { cash: true, card: true } },
  });
  const menu = await seedMenu(f);
  const botId = await bot(f);
  const c0 = await receive(f, f.line, "oi", A);
  await drain(f);
  await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c0.id);
  const runId = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,?,?,?, 'running','{}', 'attendant','{}',?,?)",
    runId,
    f.profile,
    botId,
    "bot:attendant",
    c0.id,
    (await conversation(env, c0.id, f.profile)).epoch,
    now(),
    now(),
  );
  const ctx = (await customerToolContext(
    env,
    await one(env, "SELECT * FROM bot_runs WHERE id=?", runId),
  ))!;
  const tool = async (name: string, args: any) =>
    JSON.parse(await runCustomerTool(ctx, newToolState(), name, args));
  const draft = await tool("pedido_montar", {
    itens: [
      {
        item_id: menu.xburger.id,
        quantidade: 1,
        escolhas: {
          [menu.ponto.id]: ["mal"],
          [menu.adicionais.id]: ["bacon"],
        },
      },
    ],
  });
  const say = async (text: string, reply?: string) => {
    await receive(
      f,
      f.line,
      text,
      A,
      reply ? { interactive_reply_id: reply } : {},
    );
    await drain(f);
  };
  if (confirm)
    await say("Confirmar pedido", `pedido:bot:sim:${draft.rascunho}`);
  const order = await one(
    env,
    "SELECT * FROM pedido_orders WHERE conversation_id=?",
    c0.id,
  );
  return { f, c: c0, draft, tool, say, order };
}

/** Pessoa com sessão: o nível e a política vêm da sessão (src/mfa.ts). */
const session = (actor: Actor, aal: 1 | 2): Actor => ({
  ...actor,
  aal,
  sessionId: uid(),
  mfa: { factor: true, policy: "financial" },
});

describe("pedido montado pelo bot: resposta digitada", () => {
  it("'sim' solto não confirma; CONFIRMAR confirma", async () => {
    const t = await ordered(false);
    for (const word of ["sim", "Sim", "confirmo", "não"]) await t.say(word);
    const count = async () =>
      (
        await one(
          env,
          "SELECT count(*) n FROM pedido_orders WHERE conversation_id=?",
          t.c.id,
        )
      ).n;
    expect(await count()).toBe(0);
    await t.say("CONFIRMAR");
    expect(await count()).toBe(1);
  });
});

describe("desconto: segundo fator e retomada", () => {
  it("política financial: aprovar em aal1 pede o código; em aal2 aplica", async () => {
    const t = await ordered();
    const asked = await t.tool("pedido_pedir_desconto", { observacao: "?" });
    await policy("financial");
    await expect(
      decideApproval(
        env,
        session(t.f.admin, 1),
        t.f.profile,
        asked.pedido_de_aprovacao,
        { decision: "approve", value: 2 },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "mfa_required" });
    expect(
      (
        await one(
          env,
          "SELECT status FROM approvals WHERE id=?",
          asked.pedido_de_aprovacao,
        )
      ).status,
    ).toBe("pending");
    const done = await decideApproval(
      env,
      session(t.f.admin, 2),
      t.f.profile,
      asked.pedido_de_aprovacao,
      { decision: "approve", value: 2 },
      uid(),
    );
    expect(done.status).toBe("approved");
    // Recusar não é conceder: não pede o código.
  });

  it("decisão retomada depois de travar não aplica de novo nem diz que não aprovou", async () => {
    const t = await ordered();
    const asked = await t.tool("pedido_pedir_desconto", { observacao: "?" });
    const id = asked.pedido_de_aprovacao;
    await decideApproval(
      env,
      t.f.admin,
      t.f.profile,
      id,
      { decision: "approve", value: 2 },
      uid(),
    );
    // Como se o Worker caísse depois do desconto e antes de fechar o pedido.
    const stuck = () =>
      exec(
        env,
        "UPDATE approvals SET status='deciding',decided_at=NULL,updated=? WHERE id=?",
        now() - DECIDING_TTL - 1000,
        id,
      );
    await stuck();
    const again = await decideApproval(
      env,
      t.f.admin,
      t.f.profile,
      id,
      { decision: "approve", value: 2 },
      uid(),
    );
    expect(again.status).toBe("approved");
    const order = await one(
      env,
      "SELECT * FROM pedido_orders WHERE id=?",
      t.order.id,
    );
    expect(order.discount_cents).toBe(200);
    expect(order.total_cents).toBe(3000 - 200);
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM pedido_history WHERE order_id=? AND instr(note,?)>0",
          t.order.id,
          id,
        )
      ).n,
    ).toBe(1);
    // Travada e vencida: vence sem dizer ao cliente que não aprovou.
    await stuck();
    await exec(
      env,
      "UPDATE approvals SET expires_at=? WHERE id=?",
      now() - 1,
      id,
    );
    await expireApprovals(env, t.f.profile);
    expect(
      (await one(env, "SELECT status FROM approvals WHERE id=?", id)).status,
    ).toBe("expired");
    const texts = JSON.stringify(await outbox(t.c.id));
    expect(texts).not.toContain("não respondeu a tempo sobre o desconto");
  });
});
