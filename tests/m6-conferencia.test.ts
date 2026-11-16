// Conferência M6 (resíduos médios): com só conversations:read, a busca da
// Mensalidade virava oráculo documento → cliente; o documento do check-in
// saía pelo passo web e pelos eventos; e qualquer atendente exportava os
// documentos pelas listas de assinaturas e de reservas.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { now, uid } from "../src/types";
import { api, application, bearer, receive } from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import { CPF_EM_DIA, payerEmDia, setupSuporte } from "./suporte-fixture";
import { future, reservaSetup } from "./reserva-fixture";

useMercadoPago();

const READ = ["conversations:read", "events:read"];
const FULL = [...READ, "contacts:read", "notes:read"];
const json = async (r: Response) => {
  expect(r.status).toBe(200);
  return r.json<any>();
};

describe("conferência M6: resíduos", () => {
  it("Mensalidade: busca por documento não é oráculo e atendente vê documento mascarado", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await payerEmDia(s, "5511986100001", CPF_EM_DIA);
    const token = (await application(f, READ)).token;
    const root = `/profiles/${f.profile}/mensalidade/subscriptions`;
    const known = await json(await api(token, `${root}?q=52998224725`));
    const unknown = await json(await api(token, `${root}?q=11144477735`));
    expect(known.data.length).toBe(unknown.data.length);
    expect(JSON.stringify(known)).not.toContain("52998224725");
    expect(JSON.stringify(known)).not.toContain("529.982.247-25");
    // Atendente: lista com documento mascarado.
    const member = await json(await api(await bearer(f.member), root));
    expect(JSON.stringify(member)).not.toContain("529.982.247-25");
    // Administrador vê completo.
    const admin = await json(await api(await bearer(f.admin), root));
    expect(JSON.stringify(admin)).toContain("529.982.247-25");
  });

  it("Reserva: documento do check-in não sai pelo passo web, pelos eventos nem pela lista do atendente", async () => {
    const s = await reservaSetup();
    const c = await receive(s.f, s.f.line, "oi", "5511986100002");
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(9),
      nights: 1,
      conversation_id: c.id,
    });
    const answers = { documento: "123.456.789-09" };
    const step = uid();
    await exec(
      env,
      "INSERT INTO web_steps(id,profile_id,conversation_id,module_id,kind,ref_id,code_hash,status,title,spec,trigger,actor,source_key,expires_at,result,completed_at,created,updated) VALUES(?,?,?,'reserva','checkin',?,?,'completed','Check-in','{}','agent','x',?,?,?,?,?,?)",
      step,
      s.f.profile,
      c.id,
      b.id,
      uid(),
      uid(),
      now() + 86400000,
      JSON.stringify(answers),
      now(),
      now(),
      now(),
    );
    await exec(
      env,
      "UPDATE reserva_bookings SET checkin_answers=?,checkin_step_id=?,checkin_status='completed' WHERE id=?",
      JSON.stringify(answers),
      step,
      b.id,
    );
    await s.run("reserva.change", { id: b.id, guests: 2 });
    const p = s.f.profile;
    const reader = (await application(s.f, READ)).token;
    const booking = await json(
      await api(reader, `/profiles/${p}/reserva/bookings/${b.id}`),
    );
    expect(booking.checkin_step_id).toBeUndefined();
    const steps = await json(
      await api(reader, `/profiles/${p}/conversations/${c.id}/web-steps`),
    );
    expect(JSON.stringify(steps)).not.toContain("123.456.789-09");
    const one = await json(
      await api(reader, `/profiles/${p}/web-steps/${step}`),
    );
    expect(one.answers).toBeNull();
    const events = await json(await api(reader, `/profiles/${p}/events`));
    expect(
      (events.data || events).filter((e: any) =>
        String(e.kind).startsWith("reserva."),
      ),
    ).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("123.456.789-09");
    // Com contacts:read, a aplicação vê.
    const full = (await application(s.f, FULL)).token;
    const fullStep = await json(
      await api(full, `/profiles/${p}/web-steps/${step}`),
    );
    expect(fullStep.answers).toEqual(answers);
    const fullEvents = await json(await api(full, `/profiles/${p}/events`));
    expect(
      (fullEvents.data || fullEvents).some((e: any) =>
        String(e.kind).startsWith("reserva."),
      ),
    ).toBe(true);
    // Atendente: a lista não traz os documentos; o detalhe traz.
    const member = await bearer(s.f.member);
    const list = await json(
      await api(member, `/profiles/${p}/reserva/bookings`),
    );
    expect(JSON.stringify(list)).not.toContain("123.456.789-09");
    const detail = await json(
      await api(member, `/profiles/${p}/reserva/bookings/${b.id}`),
    );
    expect(detail.checkin_answers).toEqual(answers);
  });
});
