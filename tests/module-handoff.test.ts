import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import {
  api,
  bearer,
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

async function setup() {
  const f: Fixture = await fixture();
  await configure(f, {
    departments: [
      {
        id: "suporte",
        name: "Suporte técnico",
        members: [f.member.id],
        enabled: true,
      },
    ],
  });
  const r = await receive(f, f.line, "quero ajuda", "5511990001111");
  await drain(f);
  const c = await conversation(env, r.id, f.profile);
  return { f, c, ctx: modulesApi(env, f.profile, "forms") };
}
const notes = (id: string) =>
  all(
    env,
    "SELECT author,text FROM messages WHERE conversation_id=? AND direction='note' ORDER BY created,rowid",
    id,
  );

describe("ctx.handoff", () => {
  it("passa para um setor com resumo e marcadores visíveis ao atendente", async () => {
    const { f, c, ctx } = await setup();
    const after = await ctx.handoff(c, {
      target: { department_id: "suporte" },
      summary: "Cliente com assinatura em dia, plano Mensal.",
      flags: ["telefone não vinculado", "CPF informado no chat"],
    });
    expect(after).toMatchObject({ state: "waiting", department_id: "suporte" });
    expect(json(after.handoff)).toMatchObject({
      module: "forms",
      summary: "Cliente com assinatura em dia, plano Mensal.",
      flags: ["telefone não vinculado", "CPF informado no chat"],
    });
    expect(await notes(c.id)).toContainEqual({
      author: "module:forms",
      text: "Formulários: Cliente com assinatura em dia, plano Mensal.\nAtenção: telefone não vinculado; CPF informado no chat",
    });
    // O detalhe da conversa traz a passagem para o painel e os apps.
    const detail = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/conversations/${c.id}`,
      )
    ).json<any>();
    expect(detail.handoff).toMatchObject({
      module: "forms",
      flags: ["telefone não vinculado", "CPF informado no chat"],
    });
    // Encerrar limpa a passagem.
    await perform(
      env,
      f.admin,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    await perform(
      env,
      f.admin,
      f.profile,
      "conversation.action",
      { id: c.id, action: "resolve" },
      uid(),
    );
    expect(
      (await one(env, "SELECT handoff FROM conversations WHERE id=?", c.id))
        .handoff,
    ).toBeNull();
  });

  it("passa para a fila geral e para uma pessoa; com key, não repete", async () => {
    const { f, c, ctx } = await setup();
    const general = await ctx.handoff(c, { key: "k1" });
    expect(general).toMatchObject({ state: "waiting", department_id: null });
    const epoch = general.epoch;
    // Mesma key: nada muda, nenhuma nota a mais.
    const again = await ctx.handoff(general, { key: "k1" });
    expect(again.epoch).toBe(epoch);
    expect(await notes(c.id)).toHaveLength(1);

    const person = await ctx.handoff(again, {
      target: { user_id: f.member.id },
      summary: "Retorno do chamado de ontem.",
      key: "k2",
    });
    expect(person).toMatchObject({ state: "human", owner: f.member.id });
    expect(json(person.handoff).summary).toBe("Retorno do chamado de ontem.");
    const events = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='conversation.updated' AND resource_id=? ORDER BY id",
      f.profile,
      c.id,
    );
    expect(json(events.at(-1)!.payload)).toMatchObject({
      state: "human",
      owner: f.member.id,
      reason: "Encaminhado pelo módulo Formulários.",
    });
  });

  it("ctx.activeTicket: protocolo ativo da conversa, null depois de resolvido", async () => {
    const { f, c, ctx } = await setup();
    const resolve = (id: string) =>
      perform(
        env,
        f.admin,
        f.profile,
        "ticket.update",
        { id, status: "resolved" },
        uid(),
      );
    // A mensagem do setup (sem bot, equipe ausente) já abriu um protocolo.
    const absence = await ctx.activeTicket(c);
    if (absence) await resolve(absence.id);
    expect(await ctx.activeTicket(c)).toBeNull();
    const opened = await perform(
      env,
      f.admin,
      f.profile,
      "ticket.create",
      { conversation_id: c.id, title: "Impressora parada" },
      uid(),
    );
    expect(await ctx.activeTicket(c.id)).toMatchObject({
      id: opened.id,
      title: "Impressora parada",
      status: "open",
    });
    await resolve(opened.id);
    expect(await ctx.activeTicket(c)).toBeNull();
  });

  it("recusa destino inválido e marcadores fora do limite", async () => {
    const { c, ctx } = await setup();
    await expect(
      ctx.handoff(c, { target: { user_id: "ninguem" } }),
    ).rejects.toThrow(/Atendente não autorizado/);
    await expect(
      ctx.handoff(c, { target: { department_id: "nao-existe" } }),
    ).rejects.toThrow(/Setor/);
    await expect(ctx.handoff(c, { flags: ["x".repeat(61)] })).rejects.toThrow(
      /Marcadores/,
    );
    await expect(
      ctx.handoff(c, {
        target: { department_id: "suporte", user_id: "x" },
      }),
    ).rejects.toThrow(/não os dois/);
  });
});
