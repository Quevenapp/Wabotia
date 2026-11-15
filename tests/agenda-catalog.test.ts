import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { perform, settings } from "../src/service";
import { uid } from "../src/types";
import {
  agendaConfig,
  defaultAgendaConfig,
  validateAgendaConfig,
} from "../src/modules/agenda/config";
import { blockRange } from "../src/modules/agenda/catalog";
import { api, bearer, configure } from "./service-center-fixture";
import { agendaSetup, at, future, week } from "./agenda-fixture";

describe("agenda: módulo desligado", () => {
  it("rotas respondem 409 module_disabled e o padrão é desligado", async () => {
    const { f } = await agendaSetup({ enabled: false });
    const token = await bearer(f.admin);
    for (const [method, path, body] of [
      ["GET", "/agenda", undefined],
      ["GET", "/agenda/appointments", undefined],
      ["POST", "/agenda/services", { name: "Corte", duration_minutes: 30 }],
      ["POST", "/agenda/appointments", { service_id: "x", starts: 1 }],
    ] as const) {
      const res = await api(
        token,
        `/profiles/${f.profile}${path}`,
        method,
        body,
      );
      expect(res.status, path).toBe(409);
      expect((await res.json<any>()).error.code).toBe("module_disabled");
    }
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "agenda.service.save",
        { name: "X", duration_minutes: 30 },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "module_disabled" });
  });
});

describe("agenda: cadastros", () => {
  it("serviços, profissionais e horário pela API, só administrador altera", async () => {
    const { f, corte, ana, bia } = await agendaSetup();
    const admin = await bearer(f.admin);
    const member = await bearer(f.member);
    const overview = await (
      await api(member, `/profiles/${f.profile}/agenda`)
    ).json<any>();
    expect(overview.services.map((s: any) => s.name)).toEqual([
      "Barba",
      "Corte",
    ]);
    expect(overview.config).toEqual(defaultAgendaConfig);
    const anaView = overview.professionals.find((p: any) => p.id === ana.id);
    expect(anaView.hours).toHaveLength(7);
    expect(anaView.hours[0]).toEqual({
      weekday: 0,
      start: "08:00",
      end: "18:00",
    });
    expect(bia.service_ids).toEqual([corte.id]);

    // Operador não altera cadastros.
    const denied = await api(
      member,
      `/profiles/${f.profile}/agenda/services`,
      "POST",
      {
        name: "Escova",
        duration_minutes: 40,
      },
    );
    expect(denied.status).toBe(403);

    // Validações.
    for (const body of [
      { name: "", duration_minutes: 30 },
      { name: "Escova", duration_minutes: 7 },
      { name: "Escova", duration_minutes: 30, price_cents: -1 },
    ]) {
      const res = await api(
        admin,
        `/profiles/${f.profile}/agenda/services`,
        "POST",
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const overlap = await api(
      admin,
      `/profiles/${f.profile}/agenda/professionals`,
      "POST",
      {
        name: "Caio",
        hours: [
          { weekday: 1, start: "08:00", end: "12:00" },
          { weekday: 1, start: "11:00", end: "14:00" },
        ],
      },
    );
    expect(overlap.status).toBe(400);
    const unknown = await api(
      admin,
      `/profiles/${f.profile}/agenda/professionals`,
      "POST",
      {
        name: "Caio",
        service_ids: ["nada"],
      },
    );
    expect(unknown.status).toBe(400);

    // Mesma Idempotency-Key: um serviço só.
    const key = "svc-" + uid();
    const first = await api(
      admin,
      `/profiles/${f.profile}/agenda/services`,
      "POST",
      { name: "Escova", duration_minutes: 45, price_cents: 8000 },
      key,
    );
    const again = await api(
      admin,
      `/profiles/${f.profile}/agenda/services`,
      "POST",
      { name: "Escova", duration_minutes: 45, price_cents: 8000 },
      key,
    );
    expect(first.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const escova = await first.json<any>();
    expect((await again.json<any>()).id).toBe(escova.id);
    expect(
      await all(
        env,
        "SELECT id FROM agenda_services WHERE profile_id=? AND name='Escova'",
        f.profile,
      ),
    ).toHaveLength(1);

    // Edição parcial e exclusão (arquiva e tira dos profissionais).
    const edited = await api(
      admin,
      `/profiles/${f.profile}/agenda/services/${escova.id}`,
      "PUT",
      { active: false },
    );
    expect(await edited.json<any>()).toMatchObject({
      name: "Escova",
      active: false,
      duration_minutes: 45,
    });
    const removed = await api(
      admin,
      `/profiles/${f.profile}/agenda/services/${corte.id}`,
      "DELETE",
      {},
    );
    expect(removed.status).toBe(200);
    const after = await (
      await api(admin, `/profiles/${f.profile}/agenda/professionals`)
    ).json<any>();
    expect(after.data.find((p: any) => p.id === bia.id).service_ids).toEqual(
      [],
    );
    expect(
      (
        await (
          await api(admin, `/profiles/${f.profile}/agenda/services`)
        ).json<any>()
      ).data.map((s: any) => s.name),
    ).toEqual(["Barba", "Escova"]);
  });

  it("folgas e bloqueios por dia, por horário e para todos", async () => {
    const { f, run, ana } = await agendaSetup();
    const day = future(5);
    const folga = await run("agenda.block.save", {
      professional_id: ana.id,
      date: day,
      reason: "Folga",
    });
    expect(folga).toMatchObject({
      professional_id: ana.id,
      starts: at(day, "00:00"),
      ends: at(day, "00:00") + 86400000,
    });
    const almoco = await run("agenda.block.save", {
      date: day,
      start: "12:00",
      end: "13:30",
    });
    expect(almoco).toMatchObject({
      professional_id: null,
      starts: at(day, "12:00"),
      ends: at(day, "13:30"),
    });
    const token = await bearer(f.member);
    const list = await (
      await api(
        token,
        `/profiles/${f.profile}/agenda/blocks?from=${at(day, "00:00")}&to=${at(day, "23:59")}`,
      )
    ).json<any>();
    expect(list.data).toHaveLength(2);
    await run("agenda.block.delete", { id: almoco.id });
    expect(
      await one(env, "SELECT id FROM agenda_blocks WHERE id=?", almoco.id),
    ).toBeNull();
    expect(() => blockRange({ date: day, until: "2000-01-01" })).toThrow();
    expect(() => blockRange({ starts: 10, ends: 5 })).toThrow();
    expect(
      blockRange({ date: day, until: future(6) }).ends - at(day, "00:00"),
    ).toBe(2 * 86400000);
  });

  it("configuração da área pela chave agenda de PUT /settings", async () => {
    const { f } = await agendaSetup();
    await expect(
      configure(f, { agenda: { slot_step_minutes: 3 } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      configure(f, { agenda: { booked_text: "x".repeat(901) } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await configure(f, {
      agenda: {
        slot_step_minutes: 15,
        reminder_hours: 0,
        booked_text: " Até {data}! ",
      },
    });
    const saved = (await settings(env, f.profile)).agenda;
    expect(saved).toMatchObject({
      slot_step_minutes: 15,
      reminder_hours: 0,
      booked_text: "Até {data}!",
      max_days_ahead: 30,
    });
    expect(validateAgendaConfig({})).toEqual(defaultAgendaConfig);
    // Leitura tolerante: valor ruim volta ao padrão.
    expect(
      agendaConfig({ slot_step_minutes: "x", max_days_ahead: 10 }),
    ).toMatchObject({ slot_step_minutes: 30, max_days_ahead: 10 });
    expect(week()).toHaveLength(7);
  });
});
