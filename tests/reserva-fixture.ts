// Base dos testes da Reserva: área do service-center-fixture com o módulo
// ligado, uma pousada com dois quartos por diária e uma quadra por hora.
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { all, exec } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { loadState } from "../src/modules/reserva/chat";
import { modulesApi } from "../src/modules/api";
import { addDays, atClock, brasiliaDate } from "../src/modules/reserva/config";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

export async function reservaSetup(
  options: { enabled?: boolean; rules?: any } = {},
) {
  const f = await fixture();
  const run = (op: string, data: any = {}, actor: Actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  if (options.enabled !== false)
    await run("module.set", { id: "reserva", enabled: true });
  const ctx = modulesApi(env, f.profile, "reserva");
  if (options.enabled === false) return { f, run, ctx } as any;
  if (options.rules) await configure(f, { reserva: options.rules });
  const mar = await run("reserva.unit.save", {
    name: "Suíte Mar",
    kind: "room",
    mode: "daily",
    capacity: 2,
    price_cents: 30000,
    position: 1,
  });
  const jardim = await run("reserva.unit.save", {
    name: "Chalé Jardim",
    kind: "house",
    mode: "daily",
    capacity: 4,
    price_cents: 45000,
    position: 2,
  });
  const quadra = await run("reserva.unit.save", {
    name: "Quadra de areia",
    kind: "court",
    mode: "hourly",
    capacity: 12,
    price_cents: 8000,
    position: 3,
  });
  return { f, run, ctx, mar, jardim, quadra };
}
export type ReservaSetup = Awaited<ReturnType<typeof reservaSetup>>;

/** Um dia de Brasília daqui a `days` dias (sempre no futuro). */
export const future = (days = 5) => addDays(brasiliaDate(Date.now()), days);
export const at = atClock;
export type { Fixture };

// ---------------------------------------------------------------------------
// Conversa no WhatsApp (menu com os itens da Reserva, origem pública)

export const ORIGIN = "https://pousada.example.com";
export const menus = [
  { id: "reservar", label: "Fazer reserva", type: "reserva" },
  { id: "minhas", label: "Minhas reservas", type: "reserva_mine" },
  { id: "humano", label: "Falar com atendente", type: "human" },
];

export async function chatSetup(rules?: any) {
  const s = await reservaSetup({ rules });
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900002222" }),
    s.f.line,
    s.f.qr,
  );
  await configure(s.f, { menus });
  return s;
}
export async function say(
  s: ReservaSetup,
  text: string,
  phone: string,
  line: string,
) {
  const c = await receive(s.f, line, text, phone);
  await drain(s.f);
  return conversation(env, c.id, s.f.profile);
}
export async function tap(
  s: ReservaSetup,
  row: { id: string; title: string },
  phone: string,
) {
  const c = await receive(s.f, s.f.line, row.title, phone, {
    interactive_reply_id: row.id,
  });
  await drain(s.f);
  return conversation(env, c.id, s.f.profile);
}
/** Número (1, 2…) da opção com o id dado na pergunta aberta. */
export async function pick(
  s: ReservaSetup,
  conversationId: string,
  id: string,
) {
  const options = (await loadState(s.ctx, conversationId))!.data.options!;
  const index = options.findIndex((o) => o.id === id);
  expect(index, `opção ${id}`).toBeGreaterThanOrEqual(0);
  return String(index + 1);
}
export const bookings = (s: ReservaSetup) =>
  all(
    env,
    "SELECT * FROM reserva_bookings WHERE profile_id=? ORDER BY number",
    s.f.profile,
  );

/** Leva o cliente pela linha QR até o resumo de uma diária da Suíte Mar. */
export async function qrToSummary(
  s: ReservaSetup,
  phone: string,
  start: string,
  nights = 2,
) {
  const qr = s.f.qr;
  await say(s, "oi", phone, qr);
  let c = await say(s, "1", phone, qr);
  expect((await latest(c.id)).text).toContain("O que você quer reservar?");
  c = await say(s, await pick(s, c.id, s.mar.id), phone, qr);
  expect((await latest(c.id)).text).toContain(
    "Qual a data de entrada em Suíte Mar?",
  );
  c = await say(s, await pick(s, c.id, start), phone, qr);
  expect((await latest(c.id)).text).toContain("Quantas diárias em Suíte Mar?");
  c = await say(s, await pick(s, c.id, String(nights)), phone, qr);
  expect((await latest(c.id)).text).toContain("Quantas pessoas?");
  c = await say(s, "2", phone, qr);
  return c;
}
