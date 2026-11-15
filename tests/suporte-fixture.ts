// Área com Mensalidade, Suporte pago e Cobrança (Mercado Pago simulado em
// ./mensalidade-mp.ts) para os testes do Suporte.
import { env } from "cloudflare:test";
import { all, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { runDue } from "../src/modules/mensalidade/due";
import {
  createPlan,
  createSubscription,
  loadSubscription,
  setSubscriptionStatus,
} from "../src/modules/mensalidade/store";
import { addDays, today } from "../src/modules/mensalidade/model";
import {
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";
import { configurePayments } from "./mensalidade-mp";

export const CPF_EM_DIA = "529.982.247-25";
export const CPF_NOVO = "111.444.777-35";
export const CNPJ = "11.222.333/0001-81";

export const PACKAGES = [
  {
    id: "avulso",
    name: "Atendimento avulso",
    price_cents: 4900,
    mode: "ticket",
  },
  {
    id: "dia",
    name: "Suporte 24 horas",
    price_cents: 9000,
    mode: "hours",
    hours: 24,
  },
];

export const turnModule = (f: Fixture, id: string, enabled: boolean) =>
  perform(env, f.admin, f.profile, "module.set", { id, enabled }, uid());

export async function setupSuporte(rules: any = {}) {
  const f = await fixture();
  await turnModule(f, "mensalidade", true);
  await turnModule(f, "suporte", true);
  const account = await configurePayments(f);
  const mctx = modulesApi(env, f.profile, "mensalidade");
  const sctx = modulesApi(env, f.profile, "suporte");
  const plan = await createPlan(
    mctx,
    {
      name: "Suporte Mensal",
      amount_cents: 9900,
      sellable: true,
      description: "Atendimento humano em horário comercial",
    },
    f.admin.id,
  );
  await configure(f, { suporte: { packages: PACKAGES, ...rules } });
  return { f, account, mctx, sctx, plan };
}
export type Suporte = Awaited<ReturnType<typeof setupSuporte>>;

/** Cliente escreve; devolve a conversa atualizada. */
export async function talk(
  f: Fixture,
  text: string,
  phone: string,
  content: any = {},
) {
  const c = await receive(f, f.line, text, phone, content);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
export const tap = (f: Fixture, phone: string, id: string, title = "x") =>
  talk(f, title, phone, { interactive_reply_id: id });

/** Pagador em dia: assinatura que começa hoje, sem parcela vencida. */
export async function payerEmDia(
  s: Suporte,
  phone: string,
  document = CPF_EM_DIA,
) {
  return createSubscription(
    s.mctx,
    {
      plan_id: s.plan.id,
      customer_name: "Empresa Alfa",
      phone,
      document,
      start_date: today(now()),
      due_day: Number(addDays(today(now()), 10).slice(8)),
    },
    s.f.admin.id,
  );
}

/** Pagador com uma parcela vencida há 5 dias. */
export async function payerEmAtraso(
  s: Suporte,
  phone: string,
  document = CNPJ,
) {
  const day = today(now());
  const sub = await createSubscription(
    s.mctx,
    {
      plan_id: s.plan.id,
      customer_name: "Contabilidade Beta",
      phone,
      document,
      start_date: addDays(day, -12),
      due_day: Number(addDays(day, -5).slice(8)),
    },
    s.f.admin.id,
  );
  await runDue(s.mctx, now(), { notices: false });
  return sub;
}

/** Pagador sem assinatura ativa (a dele foi encerrada). */
export async function payerSemAssinatura(
  s: Suporte,
  phone: string,
  document = CPF_EM_DIA,
) {
  const sub = await payerEmDia(s, phone, document);
  await setSubscriptionStatus(
    s.mctx,
    await loadSubscription(s.mctx, sub.id),
    "ended",
    s.f.admin.id,
  );
  return sub;
}

export async function texts(conversationId: string) {
  return (
    await all(
      env,
      "SELECT payload FROM outbox WHERE conversation_id=? AND kind!='team' ORDER BY created,rowid",
      conversationId,
    )
  ).map((row) => json(row.payload));
}
export const lastText = async (conversationId: string) =>
  ((await texts(conversationId)).at(-1)?.text as string) || "";

export const releases = (conversationId: string) =>
  all(
    env,
    "SELECT * FROM suporte_releases WHERE conversation_id=? ORDER BY created",
    conversationId,
  );

export const eventsOf = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));

export const paymentFor = (ref: string) =>
  one(
    env,
    "SELECT * FROM payments WHERE ref_id=? ORDER BY created DESC LIMIT 1",
    ref,
  );
