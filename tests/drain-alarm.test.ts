// O drain dos testes e o alarme do Coordinator rodam processInbox na mesma
// área. O alarme é agendado 1 s depois de qualquer comando ou passo web feito
// pela API; num teste lento (pedido-whatsapp, "sem a Cobrança…", na suíte
// completa) ele pegou a mesma mensagem do drain, que voltou antes de a
// cobrança terminar. O drain agora cancela o alarme pendente e espera o que
// estiver rodando: só ele processa a caixa de entrada do teste.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { all } from "../src/db";
import {
  api,
  bearer,
  configure,
  drain,
  fixture,
  outbox,
  receive,
} from "./service-center-fixture";

it("drain cancela o alarme pendente do Coordinator antes de processar", async () => {
  const f = await fixture();
  await configure(f, {
    menus: [{ id: "atendente", label: "Falar com atendente", type: "human" }],
  });
  // Comando pela API: o Coordinator guarda a área e agenda o alarme (+1 s).
  const token = await bearer(f.admin);
  await api(token, `/profiles/${f.profile}/settings`, "PUT", {
    menu_greeting: "Olá!",
  });
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  const alarm = () =>
    runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
  expect(await alarm()).not.toBe(null);
  const c = await receive(f, f.line, "oi", "5511970000123");
  await drain(f);
  expect(await alarm()).toBe(null);
  expect(
    (
      await all(env, "SELECT status FROM inbox WHERE profile_id=?", f.profile)
    ).map((r) => r.status),
  ).toEqual(["done"]);
  // Passado o prazo do alarme, nada mais processa a mensagem de novo.
  await new Promise((done) => setTimeout(done, 1200));
  expect((await outbox(c.id)).length).toBe(1);
});
