import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { perform } from "../src/service";
import { uid } from "../src/types";
import {
  brasiliaDate,
  clockOf,
  defaultAgendaConfig,
} from "../src/modules/agenda/config";
import { freeSlots } from "../src/modules/agenda/availability";
import { book } from "../src/modules/agenda/appointments";
import type { Professional, Service } from "../src/modules/agenda/catalog";
import { api, bearer } from "./service-center-fixture";
import { agendaSetup, at, future } from "./agenda-fixture";

const corte: Service = {
  id: "corte",
  name: "Corte",
  description: "",
  duration_minutes: 30,
  price_cents: null,
  active: true,
  position: 0,
};
const pro = (id: string, hours: any[], services = ["corte"]): Professional => ({
  id,
  name: id,
  user_id: null,
  active: true,
  position: 0,
  service_ids: services,
  hours,
});
// 17/11/2026 é uma terça-feira (2).
const DAY = "2026-11-17";
const NOW = at("2026-11-16", "10:00");
const base = {
  date: DAY,
  service: corte,
  professionals: [
    pro("ana", [{ weekday: 2, start: "09:00", end: "11:00" }]),
    pro("bia", [{ weekday: 2, start: "10:00", end: "12:00" }]),
  ],
  busy: [],
  blocks: [],
  config: defaultAgendaConfig,
  holidays: [],
  now: NOW,
};
const times = (slots: { starts: number }[]) =>
  slots.map((s) => clockOf(s.starts));

describe("agenda: cálculo de horários livres (puro)", () => {
  it("junta profissionais, respeita duração e intervalo", () => {
    const slots = freeSlots(base);
    expect(times(slots)).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(
      slots.find((s) => clockOf(s.starts) === "10:00")!.professional_ids,
    ).toEqual(["ana", "bia"]);
    expect(times(freeSlots({ ...base, professionalId: "bia" }))).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    // Serviço de 60 min não cabe nos últimos 30 min do intervalo.
    expect(
      times(
        freeSlots({
          ...base,
          service: { ...corte, duration_minutes: 60 },
          professionalId: "ana",
        }),
      ),
    ).toEqual(["09:00", "09:30", "10:00"]);
    expect(
      times(
        freeSlots({
          ...base,
          config: { ...defaultAgendaConfig, slot_step_minutes: 60 },
          professionalId: "ana",
        }),
      ),
    ).toEqual(["09:00", "10:00"]);
    // Dia sem expediente (segunda) e serviço que a pessoa não atende.
    expect(freeSlots({ ...base, date: "2026-11-16" })).toEqual([]);
    expect(freeSlots({ ...base, service: { ...corte, id: "barba" } })).toEqual(
      [],
    );
    expect(
      freeSlots({ ...base, service: { ...corte, active: false } }),
    ).toEqual([]);
  });

  it("folga, bloqueio e horário cheio", () => {
    const folga = {
      id: "b",
      professional_id: "ana",
      starts: at(DAY, "00:00"),
      ends: at("2026-11-18", "00:00"),
      reason: "",
      created_by: "",
      created: 0,
    };
    expect(times(freeSlots({ ...base, blocks: [folga] }))).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    const casa = {
      ...folga,
      professional_id: null,
      starts: at(DAY, "10:15"),
      ends: at(DAY, "11:00"),
    };
    expect(times(freeSlots({ ...base, blocks: [casa] }))).toEqual([
      "09:00",
      "09:30",
      "11:00",
      "11:30",
    ]);
    const busy = [
      {
        professional_id: "ana",
        starts: at(DAY, "09:00"),
        ends: at(DAY, "10:30"),
      },
      {
        professional_id: "bia",
        starts: at(DAY, "10:00"),
        ends: at(DAY, "12:00"),
      },
    ];
    const slots = freeSlots({ ...base, busy });
    expect(times(slots)).toEqual(["10:30"]);
    expect(slots[0].professional_ids).toEqual(["ana"]);
    // Tudo ocupado: dia cheio.
    expect(
      freeSlots({
        ...base,
        busy: [
          ...busy,
          {
            professional_id: "ana",
            starts: at(DAY, "10:30"),
            ends: at(DAY, "11:00"),
          },
        ],
      }),
    ).toEqual([]);
    // Feriado da área fecha a agenda (ou não, se configurado).
    expect(freeSlots({ ...base, holidays: [DAY] })).toEqual([]);
    expect(
      freeSlots({
        ...base,
        holidays: [DAY],
        config: { ...defaultAgendaConfig, close_on_holidays: false },
      }).length,
    ).toBe(6);
  });

  it("antecedência mínima e máxima; a equipe ignora as duas", () => {
    const now = at(DAY, "09:20");
    expect(times(freeSlots({ ...base, now }))).toEqual([
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(
      times(freeSlots({ ...base, now, rules: { staff: true } })),
    ).toHaveLength(6);
    const far = {
      ...base,
      config: { ...defaultAgendaConfig, max_days_ahead: 1 },
      now: at("2026-11-16", "09:00"),
    };
    expect(times(freeSlots(far))).toEqual(["09:00"]);
    expect(freeSlots({ ...far, rules: { staff: true } })).toHaveLength(6);
  });

  it("virada de dia: o dia e a semana são os de Brasília, não os do UTC", () => {
    // 23:00 de terça em Brasília já é quarta (02:00) em UTC.
    const night = pro("nina", [
      { weekday: 2, start: "22:00", end: "24:00" },
      { weekday: 3, start: "00:00", end: "01:00" },
    ]);
    const slots = freeSlots({
      ...base,
      professionals: [night],
      now: at(DAY, "21:00"),
      config: { ...defaultAgendaConfig, min_notice_minutes: 0 },
    });
    expect(times(slots)).toEqual(["22:00", "22:30", "23:00", "23:30"]);
    expect(new Date(slots[2].starts).getUTCDay()).toBe(3);
    expect(slots.every((s) => brasiliaDate(s.starts) === DAY)).toBe(true);
    // O último horário termina exatamente à meia-noite de Brasília.
    expect(slots[3].ends).toBe(at("2026-11-18", "00:00"));
    // A quarta começa à meia-noite de Brasília, com o intervalo da quarta.
    const wednesday = freeSlots({
      ...base,
      date: "2026-11-18",
      professionals: [night],
      now: at(DAY, "23:50"),
      config: { ...defaultAgendaConfig, min_notice_minutes: 0 },
    });
    expect(times(wednesday)).toEqual(["00:00", "00:30"]);
    // Às 23:50 de terça (02:50 UTC de quarta) não sobra horário na terça.
    expect(
      freeSlots({ ...base, professionals: [night], now: at(DAY, "23:50") }),
    ).toEqual([]);
  });
});

describe("agenda: reserva pelo comando serializado", () => {
  it("reserva, recusa o mesmo horário, repete a Idempotency-Key e libera ao cancelar", async () => {
    const { f, corte: service, ana } = await agendaSetup();
    const token = await bearer(f.member);
    const day = future(4);
    const starts = at(day, "09:00");
    const key = "book-" + uid();
    const body = {
      service_id: service.id,
      professional_id: ana.id,
      starts,
      customer_name: "Maria",
      customer_phone: "(11) 99999-0000",
    };
    const first = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments`,
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const booked = await first.json<any>();
    expect(booked).toMatchObject({
      status: "booked",
      service_name: "Corte",
      professional_name: "Ana",
      date: day,
      time: "09:00",
      customer_phone: "11999990000",
      source: "panel",
      price_cents: 5000,
    });
    const replay = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments`,
      "POST",
      body,
      key,
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json<any>()).id).toBe(booked.id);
    const taken = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments`,
      "POST",
      body,
    );
    expect(taken.status).toBe(409);
    expect((await taken.json<any>()).error.code).toBe("slot_unavailable");
    expect(
      await all(
        env,
        "SELECT id FROM agenda_appointments WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(1);

    // Disponibilidade reflete o horário ocupado.
    const free = await (
      await api(
        token,
        `/profiles/${f.profile}/agenda/availability?service_id=${service.id}&professional_id=${ana.id}&date=${day}`,
      )
    ).json<any>();
    expect(free.days[0].slots.slice(0, 3).map((s: any) => s.time)).toEqual([
      "08:00",
      "08:30",
      "09:30",
    ]);

    // "Qualquer um" fica com a Bia às 09:00.
    const any = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments`,
      "POST",
      { ...body, professional_id: null },
    );
    const anyView = await any.json<any>();
    expect(anyView.professional_name).toBe("Bia");

    // Cancelar libera; confirmar e ausência seguem as regras.
    const cancelled = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${booked.id}/cancel`,
      "POST",
      { reason: "Pediu" },
    );
    expect(await cancelled.json<any>()).toMatchObject({
      status: "cancelled",
      cancel_reason: "Pediu",
    });
    const again = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments`,
      "POST",
      body,
    );
    expect(again.status).toBe(200);
    const second = await again.json<any>();
    const early = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${second.id}/no-show`,
      "POST",
      {},
    );
    expect(early.status).toBe(400);
    const confirmed = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${second.id}/confirm`,
      "POST",
      {},
    );
    expect((await confirmed.json<any>()).status).toBe("confirmed");
    const closed = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${booked.id}/confirm`,
      "POST",
      {},
    );
    expect(closed.status).toBe(409);

    // Remarcar para um horário ocupado é recusado; para um livre, vale.
    const blocked = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${second.id}/move`,
      "POST",
      { starts: at(day, "09:00"), professional_id: anyView.professional_id },
    );
    expect(blocked.status).toBe(409);
    const moved = await api(
      token,
      `/profiles/${f.profile}/agenda/appointments/${second.id}/move`,
      "POST",
      { starts: at(day, "15:00") },
    );
    expect(await moved.json<any>()).toMatchObject({
      time: "15:00",
      status: "booked",
      moves: 1,
      confirmed_at: null,
    });

    const events = await all(
      env,
      "SELECT kind FROM events WHERE profile_id=? AND kind LIKE 'agenda.%' ORDER BY id",
      f.profile,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "agenda.booked",
      "agenda.booked",
      "agenda.cancelled",
      "agenda.booked",
      "agenda.confirmed",
      "agenda.rescheduled",
    ]);
    const list = await (
      await api(
        token,
        `/profiles/${f.profile}/agenda/appointments?from=${at(day, "00:00")}&to=${at(day, "23:59")}&status=booked,confirmed`,
      )
    ).json<any>();
    expect(list.data.map((a: any) => a.time)).toEqual(["09:00", "15:00"]);
  });

  it("dois pedidos simultâneos para o mesmo horário: só um fica", async () => {
    const { f, ctx, corte: service, ana } = await agendaSetup();
    const token = await bearer(f.member);
    const day = future(6);
    const starts = at(day, "10:00");
    const body = {
      service_id: service.id,
      professional_id: ana.id,
      starts,
      customer_name: "Cliente",
    };
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        api(token, `/profiles/${f.profile}/agenda/appointments`, "POST", body),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    // Mesmo sem o Coordinator (chamadas diretas em paralelo), o banco recusa.
    const later = at(day, "11:00");
    const direct = await Promise.allSettled(
      [1, 2].map(() =>
        book(ctx, defaultAgendaConfig, {
          service_id: service.id,
          professional_id: ana.id,
          starts: later,
          source: "api",
          actor: "t",
          rules: { staff: true },
        }),
      ),
    );
    expect(direct.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await all(
        env,
        "SELECT id FROM agenda_appointments WHERE profile_id=? AND professional_id=?",
        f.profile,
        ana.id,
      ),
    ).toHaveLength(2);
    // Encaixe pela equipe fora do horário, sem sobrepor.
    const night = await perform(
      env,
      f.member,
      f.profile,
      "agenda.book",
      { ...body, starts: at(day, "21:00"), force: true },
      uid(),
    );
    expect(night.time).toBe("21:00");
    await expect(
      perform(
        env,
        f.member,
        f.profile,
        "agenda.book",
        { ...body, starts: at(day, "21:15"), force: true },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "slot_taken" });
  });
});
