import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { now } from "../src/types";
import { api, bearer, drain, latest, receive } from "./service-center-fixture";
import { agendaSetup, at, future } from "./agenda-fixture";
import { agendaDemo } from "../web/modules/agenda/demo";

describe("agenda: ações do atendente na conversa", () => {
  it("Agendar para este cliente e Enviar link para agendar", async () => {
    const s = await agendaSetup();
    await exec(
      env,
      "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://agenda.example.com',?)",
      now(),
    );
    const c = await receive(s.f, s.f.line, "bom dia", "5511950000009");
    await drain(s.f);
    const token = await bearer(s.f.member);
    const action = (body: any) =>
      api(
        token,
        `/profiles/${s.f.profile}/conversations/${c.id}/actions`,
        "POST",
        body,
      );
    const day = future(2);
    const book = {
      action: "agenda",
      service_id: s.corte.id,
      professional_id: s.bia.id,
      starts: at(day, "11:00"),
    };

    // Sem assumir a conversa, não agenda.
    expect((await action(book)).status).toBe(400);
    await action({ action: "claim" });
    const res = await action(book);
    expect(res.status).toBe(200);
    const appointment = await res.json<any>();
    expect(appointment).toMatchObject({
      conversation_id: c.id,
      professional_name: "Bia",
      source: "panel",
      customer_phone: "5511950000009",
    });
    // O cliente recebe a confirmação na conversa.
    expect((await latest(c.id)).text).toContain("Agendado! Corte com Bia");
    const listed = await (
      await api(
        token,
        `/profiles/${s.f.profile}/agenda/appointments?conversation_id=${c.id}&from=${at(day, "00:00")}&to=${at(day, "23:59")}`,
      )
    ).json<any>();
    expect(listed.data.map((a: any) => a.id)).toEqual([appointment.id]);

    // Link para o cliente escolher sozinho (passo web, gatilho da equipe).
    const link = await action({ action: "agenda_link" });
    expect(link.status).toBe(200);
    const sent = await link.json<any>();
    expect(sent.web_step).toMatchObject({
      module_id: "agenda",
      kind: "book",
      trigger: "agent",
    });
    // A origem pública vem das requisições ao painel (aqui, https://test).
    expect((await latest(c.id)).text).toMatch(
      /https:\/\/[^/]+\/api\/w\/[A-Za-z0-9]{16}/,
    );

    // Módulo desligado: a ação responde 409.
    await s.run("module.set", { id: "agenda", enabled: false });
    const off = await action(book);
    expect(off.status).toBe(409);
    expect((await off.json<any>()).error.code).toBe("module_disabled");
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM agenda_appointments WHERE conversation_id=?",
        c.id,
      ),
    ).toMatchObject({ n: 1 });
  });

  it("dados de demonstração respondem às leituras do painel", () => {
    const overview = agendaDemo("agenda", new URLSearchParams());
    expect(overview.services.length).toBeGreaterThan(0);
    expect(overview.professionals.length).toBeGreaterThan(0);
    const today = agendaDemo(
      "agenda/appointments",
      new URLSearchParams({
        from: String(Date.now() - 86400000),
        to: String(Date.now() + 3 * 86400000),
      }),
    );
    expect(today.data.length).toBeGreaterThan(0);
    expect(today.data[0]).toHaveProperty("professional_name");
  });
});
