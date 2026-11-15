// Revisão de segurança B7: mudanças de estado que ignoravam meta.changes.
// Com remarcação, expiração ou bloqueio concorrente, saía "Confirmado!" com
// o horário antigo, confirmação de reserva já liberada, ou agendamento sobre
// um bloqueio criado entre a consulta e a reserva. Aqui a corrida é simulada
// mudando a linha logo antes da instrução condicionada.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec } from "../src/db";
import { now, uid, type Env } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { book, confirm } from "../src/modules/agenda/appointments";
import { agendaConfig } from "../src/modules/agenda/config";
import { confirmBooking } from "../src/modules/reserva/bookings";
import { reservaConfig } from "../src/modules/reserva/config";
import { agendaSetup, at, future } from "./agenda-fixture";
import { future as reservaDay, reservaSetup } from "./reserva-fixture";

/** Env que roda `before` uma vez antes da primeira instrução com `match`. */
function racing(match: string, before: () => Promise<unknown>): Env {
  const db: any = env.DB;
  let fired = false;
  const wrap = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...args: any[]) => wrap(target.bind(...args), sql);
        if (["run", "first", "all"].includes(prop as string))
          return async (...args: any[]) => {
            if (!fired && sql.includes(match)) {
              fired = true;
              await before();
            }
            return target[prop](...args);
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB } as Env;
}

const events = (profile: string, kind: string) =>
  all(
    env,
    "SELECT id FROM events WHERE profile_id=? AND kind=?",
    profile,
    kind,
  );

describe("corridas nos módulos (revisão B7)", () => {
  it("Agenda: remarcado no meio, a confirmação não sai com o horário antigo", async () => {
    const s = await agendaSetup();
    const a = await s.run("agenda.book", {
      service_id: s.corte.id,
      professional_id: s.ana.id,
      starts: at(future(4), "10:00"),
      customer_name: "Cliente",
    });
    const ctx = modulesApi(
      racing("SET status='confirmed'", () =>
        exec(
          env,
          "UPDATE agenda_appointments SET starts=starts+3600000,ends=ends+3600000 WHERE id=?",
          a.id,
        ),
      ),
      s.f.profile,
      "agenda",
    );
    await expect(confirm(ctx, { id: a.id, actor: "x" })).rejects.toMatchObject({
      status: 409,
      code: "appointment_changed",
    });
    expect(await events(s.f.profile, "agenda.confirmed")).toHaveLength(0);
  });

  it("Agenda: bloqueio criado entre a consulta e a reserva impede o agendamento", async () => {
    const s = await agendaSetup();
    const starts = at(future(5), "11:00");
    const ctx = modulesApi(
      racing("INSERT INTO agenda_appointments", () =>
        exec(
          env,
          "INSERT INTO agenda_blocks(id,profile_id,professional_id,starts,ends,reason,created_by,created) VALUES(?,?,?,?,?,'',?,?)",
          uid(),
          s.f.profile,
          s.ana.id,
          starts - 3600000,
          starts + 3600000,
          "admin",
          now(),
        ),
      ),
      s.f.profile,
      "agenda",
    );
    await expect(
      book(ctx, agendaConfig({}), {
        service_id: s.corte.id,
        professional_id: s.ana.id,
        starts,
        customer_name: "Cliente",
        source: "panel",
        actor: "x",
      }),
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("Reserva: liberada pelo prazo no meio, a confirmação da equipe não sai", async () => {
    const s = await reservaSetup({
      rules: { deposit_type: "percent", deposit_percent: 30 },
    });
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: reservaDay(8),
      nights: 1,
      customer_name: "Hóspede",
      deposit: true,
    });
    // Aguardando o sinal (sem conversa, a cobrança não sai; o estado basta).
    await exec(
      env,
      "UPDATE reserva_bookings SET status='pending_payment' WHERE id=?",
      b.id,
    );
    const confirmedBefore = (await events(s.f.profile, "reserva.confirmed"))
      .length;
    const ctx = modulesApi(
      racing("SET status='confirmed'", () =>
        exec(
          env,
          "UPDATE reserva_bookings SET status='expired' WHERE id=?",
          b.id,
        ),
      ),
      s.f.profile,
      "reserva",
    );
    await expect(
      confirmBooking(ctx, reservaConfig({}), { id: b.id, actor: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await events(s.f.profile, "reserva.confirmed")).toHaveLength(
      confirmedBefore,
    );
  });
});
