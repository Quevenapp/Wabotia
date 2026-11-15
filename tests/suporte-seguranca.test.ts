// Regressão da revisão de segurança (REVISAO-SEGURANCA.md, casos B a I):
// cada teste refaz o ataque e prova que ele não funciona mais.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { conversation, perform } from "../src/service";
import { startFlow } from "../src/modules/suporte/flow";
import { settleReleases } from "../src/modules/suporte/handoff";
import {
  api,
  bearer,
  claim,
  configure,
  tickets,
} from "./service-center-fixture";
import { approve, remoteStatus, useMercadoPago } from "./mensalidade-mp";
import {
  paymentFor,
  payerEmAtraso,
  payerEmDia,
  releases,
  setupSuporte,
  talk,
  tap,
} from "./suporte-fixture";

useMercadoPago();

const menus = [
  { id: "humano", label: "Falar com atendente", type: "human" },
  { id: "proto", label: "Abrir protocolo", type: "ticket" },
];

const resolve = (f: any, id: string) =>
  perform(
    env,
    f.member,
    f.profile,
    "conversation.action",
    { id, action: "resolve" },
    uid(),
  );

describe("A2: liberação presa ao protocolo e à sessão da conversa", () => {
  it("B: cortesia 'até o protocolo' não revive com um protocolo novo aberto pelo cliente", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000002";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    const res = await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Cortesia única" },
    );
    expect(res.status).toBe(200);
    // A liberação abriu (ou adotou) o protocolo da conversa e ficou presa a ele.
    const [granted] = await releases(c.id);
    expect(granted.ticket_id).toBeTruthy();
    expect(granted.conv_session).toBe(c.session);
    const [ticket] = await tickets(c.id);
    expect(ticket.id).toBe(granted.ticket_id);
    // Atendimento resolvido e protocolo fechado.
    await resolve(f, c.id);
    await exec(
      env,
      "UPDATE tickets SET status='closed' WHERE conversation_id=?",
      c.id,
    );
    // Dias depois o cliente abre um protocolo novo pelo menu e pede humano.
    await talk(f, "oi", phone);
    await talk(f, "2", phone);
    await talk(f, "minha impressora parou de novo", phone);
    expect(
      (await tickets(c.id)).filter((t: any) => t.status !== "closed").length,
    ).toBeGreaterThan(0);
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    const rows = await releases(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ended");
  });

  it("protocolo fechado com a conversa ainda aberta também encerra", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000012";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Teste" },
    );
    await exec(
      env,
      "UPDATE tickets SET status='closed' WHERE conversation_id=?",
      c.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    expect(await settleReleases(s.sctx, now())).toBe(1);
    expect((await releases(c.id))[0]).toMatchObject({
      status: "ended",
      ended_by: "system",
    });
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
  });

  it("prazo máximo absoluto: liberação em horas vencida pelo teto não vale", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000022";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Um mês", hours: 720 },
    );
    const [row] = await releases(c.id);
    expect(row.expires_at).toBeLessThanOrEqual(row.created + 720 * 3_600_000);
    // Passado o teto (simulado), deixa de valer mesmo com valid_until adiante.
    await exec(
      env,
      "UPDATE suporte_releases SET expires_at=?, valid_until=? WHERE id=?",
      now() - 1,
      now() + 3_600_000,
      row.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    expect((await releases(c.id))[0].status).toBe("ended");
  });

  it("assinatura encerrada: a liberação por assinatura acaba no portão", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, {
      menus: [
        {
          id: "pago",
          label: "Atendimento humano (pago)",
          type: "suporte_humano",
        },
        ...menus,
      ],
    });
    const phone = "5511973000032";
    const sub = await payerEmDia(s, phone);
    await talk(f, "oi", phone);
    let c = await talk(f, "1", phone);
    expect(c.state).toBe("waiting");
    const [row] = await releases(c.id);
    expect(row.kind).toBe("subscription");
    // A assinatura acaba com a conversa ainda aberta: a liberação não vale mais.
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET status='ended' WHERE id=?",
      sub.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    await talk(f, "menu", phone);
    c = await talk(f, "2", phone);
    expect(c.state).not.toBe("waiting");
    expect((await releases(c.id))[0].status).toBe("ended");
  });

  it("estorno da mensalidade que liberou encerra a liberação", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511973000042";
    await payerEmAtraso(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=?",
      c.id,
    );
    const payment = await paymentFor(session.installment_id);
    await approve(account.id, payment.id);
    expect((await releases(c.id))[0]).toMatchObject({
      kind: "installment",
      status: "active",
    });
    await remoteStatus(account.id, payment.id, "refunded");
    expect((await releases(c.id))[0]).toMatchObject({
      status: "ended",
      ended_by: "provider",
    });
    c = await conversation(env, c.id, f.profile);
    expect(c.id).toBeTruthy();
  });
});
