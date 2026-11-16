import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversation, perform } from "../src/service";
import { uid } from "../src/types";
import { drain, receive } from "./service-center-fixture";
import { agendaSetup, at, future } from "./agenda-fixture";
import { botKey, tool, toolNames } from "./mcp-fixture";

async function setup() {
  const s = await agendaSetup();
  const token = await botKey(s.f);
  const talk = async (phone: string) => {
    const r = await receive(s.f, s.f.line, "oi", phone);
    await drain(s.f);
    return conversation(env, r.id, s.f.profile);
  };
  const mine = await talk("5511971110001");
  const other = await talk("5511971110002");
  // O bot assume a conversa em que está (como o Hermes faz).
  expect(
    (await tool(token, "claim_conversation", { conversation_id: mine.id })).ok,
  ).toBe(true);
  return { ...s, token, mine, other };
}

describe("ferramentas do bot: Agenda", () => {
  it("conferência N-7: agenda_agendar respeita o prazo máximo do cliente", async () => {
    const { token, mine, corte, ana } = await setup();
    const far = await tool(token, "agenda_agendar", {
      conversation_id: mine.id,
      service_id: corte.id,
      professional_id: ana.id,
      starts: at(future(200), "10:00"),
      idempotency_key: uid(),
    });
    expect(far.ok).toBe(false);
    // Dentro do prazo, agenda normalmente.
    const near = await tool(token, "agenda_agendar", {
      conversation_id: mine.id,
      service_id: corte.id,
      professional_id: ana.id,
      starts: at(future(5), "10:00"),
      idempotency_key: uid(),
    });
    expect(near.ok).toBe(true);
  });

  it("horários livres, agendar, ver, remarcar e cancelar só do cliente da conversa", async () => {
    const { f, token, mine, other, corte, ana } = await setup();
    const day = future(5);
    const free = await tool(token, "agenda_horarios_livres", {
      service_id: corte.id,
      date: day,
    });
    expect(free.ok).toBe(true);
    const slot = free.data.days[0].slots.find((s: any) => s.time === "09:00");
    expect(slot).toBeTruthy();

    const booked = await tool(token, "agenda_agendar", {
      conversation_id: mine.id,
      service_id: corte.id,
      starts: slot.starts,
      professional_id: ana.id,
      idempotency_key: "agendar-1",
    });
    expect(booked.ok).toBe(true);
    expect(booked.data).toMatchObject({
      time: "09:00",
      conversation_id: mine.id,
    });

    // Outro cliente tem um agendamento (feito pela equipe).
    const theirs = await perform(
      env,
      f.admin,
      f.profile,
      "conversation.action",
      {
        id: other.id,
        action: "agenda",
        service_id: corte.id,
        starts: at(day, "10:00"),
        professional_id: ana.id,
      },
      uid(),
    );

    // "Meus agendamentos": só o do cliente desta conversa, mesmo que o bot
    // tente passar o telefone de outro cliente (parâmetro inexistente).
    const list = await tool(token, "agenda_meus_agendamentos", {
      conversation_id: mine.id,
      phone: "5511971110002",
    });
    expect(list.ok).toBe(true);
    expect(list.data.data.map((a: any) => a.id)).toEqual([booked.data.id]);

    // Remarcar ou cancelar o agendamento de outro cliente: 404.
    const steal = await tool(token, "agenda_remarcar", {
      conversation_id: mine.id,
      appointment_id: theirs.id,
      starts: at(day, "11:00"),
    });
    expect(steal.ok).toBe(false);
    expect(steal.error).toMatch(/404/);
    const kill = await tool(token, "agenda_cancelar", {
      conversation_id: mine.id,
      appointment_id: theirs.id,
    });
    expect(kill.ok).toBe(false);
    expect(kill.error).toMatch(/404/);

    // O do próprio cliente: remarca e cancela, com idempotência.
    const moved = await tool(token, "agenda_remarcar", {
      conversation_id: mine.id,
      appointment_id: booked.data.id,
      starts: at(day, "11:00"),
      idempotency_key: "remarcar-1",
    });
    expect(moved.ok).toBe(true);
    expect(moved.data.time).toBe("11:00");
    const again = await tool(token, "agenda_remarcar", {
      conversation_id: mine.id,
      appointment_id: booked.data.id,
      starts: at(day, "11:00"),
      idempotency_key: "remarcar-1",
    });
    expect(again.data).toEqual(moved.data);
    const cancelled = await tool(token, "agenda_cancelar", {
      conversation_id: mine.id,
      appointment_id: booked.data.id,
      reason: "Cliente pediu pelo bot",
    });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.data.status).toBe("cancelled");
  });

  it("módulo desligado: as ferramentas da Agenda somem da lista", async () => {
    const { f, token } = await setup();
    expect(await toolNames(token)).toContain("agenda_meus_agendamentos");
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "agenda", enabled: false },
      uid(),
    );
    const names = await toolNames(token);
    expect(names.some((n) => n.startsWith("agenda_"))).toBe(false);
    expect(names).toContain("claim_conversation");
  });
});
