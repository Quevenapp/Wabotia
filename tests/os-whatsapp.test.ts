import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runModuleSchedules } from "../src/modules/schedule";
import {
  createOrder,
  handleQuoteReply,
  loadOrder,
  moveOrder,
  quoteReplies,
  saveQuote,
  sendQuote,
} from "../src/modules/os/store";
import { runDue } from "../src/modules/os/reminders";
import {
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const ORIGIN = "https://atendimento.example.com";
const DAY = 86_400_000;
const menus = [
  { id: "abrir", label: "Abrir ordem de serviço", type: "os_open" },
  { id: "acompanhar", label: "Acompanhar ordem", type: "os_track" },
  { id: "humano", label: "Falar com atendente", type: "human" },
];

async function setup() {
  const f = await fixture();
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "os", enabled: true },
    uid(),
  );
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
  await configure(f, { menus });
  return { f, ctx: modulesApi(env, f.profile, "os") };
}
async function say(f: Fixture, text: string, phone: string, line = f.line) {
  const c = await receive(f, line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const submit = (code: string, body: Record<string, string>) =>
  SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: new URLSearchParams(body).toString(),
  });
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));

/** Ordem ligada à conversa, com orçamento enviado. */
async function quoted(
  f: Fixture,
  ctx: ReturnType<typeof modulesApi>,
  phone: string,
  line = f.line,
) {
  const c = await say(f, "bom dia", phone, line);
  const { order } = await createOrder(ctx, {
    conversation: c,
    item: "Celular",
    problem: "Tela",
    source: "agent",
    sourceKey: "t:" + uid(),
    actor: f.member.id,
  });
  await saveQuote(
    ctx,
    order,
    { items: [{ description: "Tela", unit_cents: 30000 }] },
    f.member.id,
  );
  const sent = await sendQuote(
    ctx,
    await loadOrder(ctx, order.id),
    f.member.id,
  );
  return { c: await conversation(env, c.id, f.profile), order: sent };
}

describe("ordem de serviço pelo WhatsApp", () => {
  // Simula o gancho de resposta do núcleo (botões e 1/2).
  beforeEach(() => {
    quoteReplies.wired = true;
  });
  afterEach(() => {
    quoteReplies.wired = false;
  });
  it("cliente abre pelo menu: passo web com item, problema e aceite dos termos", async () => {
    const { f } = await setup();
    await say(f, "oi", "5511961000001");
    const c = await say(f, "1", "5511961000001");
    const link = await latest(c.id);
    expect(link.text).toContain("Para abrir a ordem de serviço");
    expect(link.content.interactive).toMatchObject({ type: "cta_url" });
    const code = codeIn(link.text);
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(page).toContain("Termos do serviço");
    expect(page).toContain("Li e aceito os termos do serviço");
    // Sem aceite, a página recusa e nada é aberto.
    const missing = await submit(code, {
      f_item: "Notebook",
      f_problem: "Não liga",
    });
    expect(missing.status).toBe(422);
    expect(
      await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile),
    ).toHaveLength(0);
    const done = await submit(code, {
      f_item: "Notebook Lenovo",
      f_problem: "Não liga depois da queda",
      f_terms: "on",
    });
    expect(done.status).toBe(200);
    const [order] = await all(
      env,
      "SELECT * FROM os_orders WHERE profile_id=?",
      f.profile,
    );
    expect(order).toMatchObject({
      number: 1,
      status: "received",
      source: "customer",
      conversation_id: c.id,
      phone: "5511961000001",
      item: "Notebook Lenovo",
      problem: "Não liga depois da queda",
      created_by: "customer",
    });
    expect(order.terms_text).toContain(
      "nenhum serviço será feito sem a minha aprovação",
    );
    expect(order.terms_accepted_at).toBeGreaterThan(0);
    const texts = (await outbox(c.id)).map((m) => m.text);
    expect(texts).toContain("Recebemos os dados da sua ordem de serviço.");
    expect(texts.at(-1)).toContain(
      "Ordem de serviço nº 1 aberta para Notebook Lenovo",
    );
    // Link usado: segunda tentativa não abre outra ordem.
    expect(
      (await submit(code, { f_item: "x", f_problem: "y", f_terms: "on" }))
        .status,
    ).not.toBe(200);
    expect(
      await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile),
    ).toHaveLength(1);
    expect((await events(f, "os.opened"))[0]).toMatchObject({
      source: "customer",
      number: 1,
    });
  });

  it("acompanhar mostra as ordens abertas do telefone e liga as do balcão à conversa", async () => {
    const { f, ctx } = await setup();
    const phone = "5511961000002";
    await createOrder(ctx, {
      phone: "(11) 96100-0002",
      item: "Bicicleta",
      problem: "Freio",
      source: "panel",
      sourceKey: uid(),
      actor: f.member.id,
    });
    const ready = await createOrder(ctx, {
      phone,
      item: "Relógio",
      problem: "Parado",
      source: "panel",
      sourceKey: uid(),
      actor: f.member.id,
    });
    const done = await createOrder(ctx, {
      phone,
      item: "Terno",
      problem: "Ajuste",
      source: "panel",
      sourceKey: uid(),
      actor: f.member.id,
    });
    await moveOrder(ctx, ready.order, "in_progress", f.member.id);
    await moveOrder(
      ctx,
      await loadOrder(ctx, ready.order.id),
      "ready",
      f.member.id,
    );
    await moveOrder(ctx, done.order, "cancelled", f.member.id);
    await say(f, "oi", phone);
    const c = await say(f, "2", phone);
    const text = (await latest(c.id)).text as string;
    expect(text).toContain("Suas 2 ordens de serviço abertas:");
    expect(text).toContain("Nº 1 — Bicicleta\nEstado: Recebida");
    expect(text).toContain(
      "Nº 2 — Relógio\nEstado: Pronta\nPronta para retirada desde",
    );
    expect(text).not.toContain("Terno");
    expect(
      (
        await all(
          env,
          "SELECT conversation_id FROM os_orders WHERE profile_id=?",
          f.profile,
        )
      ).every((r) => r.conversation_id === c.id),
    ).toBe(true);
    // Outro telefone não vê nada.
    await say(f, "oi", "5511961000099");
    const other = await say(f, "2", "5511961000099");
    expect((await latest(other.id)).text).toBe(
      "Não encontramos ordens de serviço abertas para este número.",
    );
  });

  it("aprova pelo botão e recusa pelo texto numerado; registra quem e quando", async () => {
    const { f, ctx } = await setup();
    const official = await quoted(f, ctx, "5511961000003");
    expect(
      await handleQuoteReply(ctx, official.c, {
        text: "Aprovar",
        replyId: `os:${official.order.id}:${official.order.quote_version}:approve`,
        rowId: uid(),
      }),
    ).toBe(true);
    const approved = await loadOrder(ctx, official.order.id);
    expect(approved).toMatchObject({
      status: "approved",
      decision: "approved",
      decided_by: "customer:5511961000003",
      decided_via: "whatsapp",
    });
    expect(approved.decided_at).toBeGreaterThan(0);
    expect((await latest(official.c.id)).text).toContain(
      "Orçamento da ordem nº 1 aprovado",
    );
    // Botão repetido depois de aprovado: avisa, não muda.
    await handleQuoteReply(ctx, official.c, {
      text: "Aprovar",
      replyId: `os:${official.order.id}:${official.order.quote_version}:approve`,
      rowId: uid(),
    });
    expect((await latest(official.c.id)).text).toContain(
      "não tem orçamento aguardando resposta",
    );

    // QR: texto numerado, sem botões.
    const qr = await quoted(f, ctx, "5511961000004", f.qr);
    const message = await latest(qr.c.id);
    expect(message.content).toBeUndefined();
    expect(message.text).toContain(
      "Para aprovar, responda 1. Para recusar, responda 2.",
    );
    expect(await handleQuoteReply(ctx, qr.c, { text: "2", rowId: uid() })).toBe(
      true,
    );
    expect(await loadOrder(ctx, qr.order.id)).toMatchObject({
      status: "declined",
      decided_via: "whatsapp",
    });
    expect((await latest(qr.c.id)).text).toContain("recusado");
    // Sem orçamento pendente, "1" não é da Ordem de Serviço.
    expect(await handleQuoteReply(ctx, qr.c, { text: "1", rowId: uid() })).toBe(
      false,
    );
    expect((await events(f, "os.approved"))[0]).toMatchObject({
      via: "whatsapp",
      by: "customer:5511961000003",
    });
    expect(await events(f, "os.declined")).toHaveLength(1);
  });

  it("APROVAR com número, botão de versão antiga e menu aberto depois do orçamento", async () => {
    const { f, ctx } = await setup();
    const { c, order } = await quoted(f, ctx, "5511961000005");
    // Orçamento reenviado: o botão da versão 1 deixa de valer.
    await saveQuote(
      ctx,
      order,
      { items: [{ description: "Tela", unit_cents: 28000 }] },
      f.member.id,
    );
    const resent = await sendQuote(
      ctx,
      await loadOrder(ctx, order.id),
      f.member.id,
    );
    expect(resent.quote_version).toBe(2);
    await handleQuoteReply(ctx, c, {
      text: "Aprovar",
      replyId: `os:${order.id}:1:approve`,
      rowId: uid(),
    });
    expect((await latest(c.id)).text).toContain("foi atualizado");
    expect((await loadOrder(ctx, order.id)).status).toBe("quoted");
    // Menu aberto depois do orçamento: "1" é do menu.
    const withMenu = await say(f, "menu", "5511961000005");
    expect(
      await handleQuoteReply(ctx, withMenu, { text: "1", rowId: uid() }),
    ).toBe(false);
    // Palavra com número vale sempre.
    expect(
      await handleQuoteReply(ctx, withMenu, {
        text: "aprovar nº 1",
        rowId: uid(),
      }),
    ).toBe(true);
    expect((await loadOrder(ctx, order.id)).status).toBe("approved");
    // Botão de outra área ou ordem inexistente.
    expect(
      await handleQuoteReply(ctx, withMenu, {
        text: "x",
        replyId: "wmenu:abc:1",
        rowId: uid(),
      }),
    ).toBe(false);
    expect(
      await handleQuoteReply(ctx, withMenu, {
        text: "RECUSAR 99",
        rowId: uid(),
      }),
    ).toBe(true);
    expect((await latest(c.id)).text).toBe(
      "Não encontramos a ordem de serviço nº 99 para este número.",
    );
  });

  it("orçamento vencido não é aprovado pelo WhatsApp", async () => {
    const { f, ctx } = await setup();
    const { c, order } = await quoted(f, ctx, "5511961000006");
    await exec(
      env,
      "UPDATE os_orders SET quote_valid_until=? WHERE id=?",
      now() - 1,
      order.id,
    );
    expect(await handleQuoteReply(ctx, c, { text: "1", rowId: uid() })).toBe(
      true,
    );
    expect((await latest(c.id)).text).toContain("venceu em");
    expect((await loadOrder(ctx, order.id)).status).toBe("quoted");
    expect(await events(f, "os.approved")).toHaveLength(0);
  });

  it("avisa o cliente nas mudanças relevantes, também com a janela de 24 h fechada", async () => {
    const { f, ctx } = await setup();
    await configure(f, {
      menus,
      service_orders: {
        texts: { in_progress: "Começamos o serviço da ordem {numero}." },
      },
    });
    const c = await say(f, "bom dia", "5511961000007");
    const { order } = await createOrder(ctx, {
      conversation: c,
      item: "Máquina de lavar",
      problem: "Vaza",
      source: "agent",
      sourceKey: uid(),
      actor: f.member.id,
    });
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 3 * DAY,
      c.id,
    );
    const progress = await moveOrder(ctx, order, "in_progress", f.member.id);
    await moveOrder(ctx, progress, "ready", f.member.id);
    const rows = await all(
      env,
      "SELECT kind,payload FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
      c.id,
    );
    const tail = rows.slice(-2);
    expect(tail.map((r) => r.kind)).toEqual(["notification", "notification"]);
    expect(json(tail[0].payload).text).toBe("Começamos o serviço da ordem 1.");
    expect(json(tail[1].payload).text).toContain(
      "Máquina de lavar está pronto para retirada",
    );
    // Texto vazio não envia: "Em análise" não tem mensagem.
    const before = (await outbox(c.id)).length;
    const second = await createOrder(ctx, {
      conversation: c,
      item: "Ferro",
      problem: "Não esquenta",
      source: "agent",
      sourceKey: uid(),
      actor: f.member.id,
      notify: false,
    });
    await moveOrder(ctx, second.order, "analyzing", f.member.id);
    expect((await outbox(c.id)).length).toBe(before);
  });

  it("lembra a retirada e avisa ordens paradas uma vez por período", async () => {
    const { f, ctx } = await setup();
    const c = await say(f, "bom dia", "5511961000008");
    const ready = await createOrder(ctx, {
      conversation: c,
      item: "Notebook",
      problem: "Tela",
      source: "agent",
      sourceKey: uid(),
      actor: f.member.id,
      notify: false,
    });
    await moveOrder(
      ctx,
      await moveOrder(ctx, ready.order, "in_progress", f.member.id),
      "ready",
      f.member.id,
    );
    const idle = await createOrder(ctx, {
      phone: "11961000009",
      item: "Rádio",
      problem: "Chiado",
      source: "panel",
      sourceKey: uid(),
      actor: f.member.id,
    });
    const start = now();
    // Ainda no prazo: nada.
    expect(await runDue(ctx, start + DAY)).toEqual({ reminded: 0, stale: 0 });
    // 3 dias pronta: lembrete. 7 dias sem mudança: os.stale para as duas.
    const later = start + 8 * DAY;
    expect(await runDue(ctx, later)).toEqual({ reminded: 1, stale: 2 });
    expect((await latest(c.id)).text).toContain(
      "Lembrete: Notebook (ordem de serviço nº 1) está pronto para retirada desde",
    );
    const stale = await events(f, "os.stale");
    expect(stale.map((e) => e.number).sort()).toEqual([1, 2]);
    expect(stale.find((e) => e.number === 2)).toMatchObject({
      status: "received",
      days: 8,
    });
    // Rodada repetida (e pelo gancho do núcleo): nada de novo.
    expect(await runDue(ctx, later + DAY)).toEqual({ reminded: 0, stale: 0 });
    expect(
      await runModuleSchedules(env, f.profile, later + 2 * DAY),
    ).toContainEqual({ module: "os", ok: true });
    expect(await events(f, "os.stale")).toHaveLength(2);
    // Mudança de estado zera o aviso.
    await moveOrder(ctx, idle.order, "analyzing", f.member.id);
    const moved = await loadOrder(ctx, idle.order.id);
    expect(moved.stale_notified_at).toBeNull();
    expect(await runDue(ctx, moved.updated + 8 * DAY)).toMatchObject({
      stale: 1,
    });
    // Módulo desligado: o gancho do núcleo não roda o módulo.
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: false },
      uid(),
    );
    expect(
      await runModuleSchedules(env, f.profile, later + 30 * DAY),
    ).not.toContainEqual(expect.objectContaining({ module: "os" }));
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM events WHERE profile_id=? AND kind='os.stale'",
        f.profile,
      ),
    ).toEqual({ n: 3 });
  });
});

describe("orçamento por link (sem o gancho de resposta do núcleo)", () => {
  it("cliente aprova e recusa pela página do orçamento", async () => {
    const { f, ctx } = await setup();
    expect(quoteReplies.wired).toBe(false);
    const approve = await quoted(f, ctx, "5511962000001");
    const link = await latest(approve.c.id);
    expect(link.text).toContain(
      "Orçamento da ordem de serviço nº 1: total R$ 300,00, válido até",
    );
    expect(link.content.interactive).toMatchObject({ type: "cta_url" });
    const code = codeIn(link.text);
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(page).toContain("• Tela: R$ 300,00");
    expect(page).toContain("Aprovar o orçamento");
    expect(
      (await submit(code, { f_decision: "Aprovar o orçamento" })).status,
    ).toBe(200);
    expect(await loadOrder(ctx, approve.order.id)).toMatchObject({
      status: "approved",
      decided_by: "customer:5511962000001",
      decided_via: "web_step",
    });
    expect((await latest(approve.c.id)).text).toContain(
      "Orçamento da ordem nº 1 aprovado",
    );

    // QR recebe o link no texto; recusa.
    const decline = await quoted(f, ctx, "5511962000002", f.qr);
    const qrLink = await latest(decline.c.id);
    expect(qrLink.content).toBeUndefined();
    expect(
      (
        await submit(codeIn(qrLink.text), {
          f_decision: "Recusar o orçamento",
        })
      ).status,
    ).toBe(200);
    expect((await loadOrder(ctx, decline.order.id)).status).toBe("declined");
    expect((await events(f, "os.declined"))[0]).toMatchObject({
      via: "web_step",
    });
  });

  it("link de orçamento vencido ou substituído não aprova", async () => {
    const { f, ctx } = await setup();
    const { c, order } = await quoted(f, ctx, "5511962000003");
    const first = codeIn((await latest(c.id)).text);
    // Reenvio: o link da versão 1 deixa de valer.
    const resent = await sendQuote(
      ctx,
      await loadOrder(ctx, order.id),
      f.member.id,
    );
    const second = codeIn((await latest(c.id)).text);
    expect(second).not.toBe(first);
    expect(
      (await submit(first, { f_decision: "Aprovar o orçamento" })).status,
    ).toBe(200);
    expect((await latest(c.id)).text).toContain("foi atualizado");
    expect((await loadOrder(ctx, order.id)).status).toBe("quoted");
    // Vencido: o link responde, a ordem não muda e o cliente é avisado.
    await exec(
      env,
      "UPDATE os_orders SET quote_valid_until=? WHERE id=?",
      now() - 1,
      resent.id,
    );
    expect(
      (await submit(second, { f_decision: "Aprovar o orçamento" })).status,
    ).toBe(200);
    expect((await latest(c.id)).text).toContain("venceu em");
    expect((await loadOrder(ctx, order.id)).status).toBe("quoted");
    expect(await events(f, "os.approved")).toHaveLength(0);
  });
});
