import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { it } from "vitest";
import { integrationHarness } from "./os-integration-fixture";
import { budgetScenario } from "./os-integration-scenarios";

it("I: cada invocação Worker/Coordinator e o alarme inteiro cabem nos tetos D1", async () => {
  const h = integrationHarness(env, {
    context: createExecutionContext,
    drain: waitOnExecutionContext,
    inside: (stub, fn) => (runInDurableObject as any)(stub, fn),
  });
  // Conta instruções de todos os batches, autenticação, recibos, auditoria,
  // mensagens/eventos e ramos de repetição/conflito; não soma invocações distintas.
  const report = await budgetScenario(h);
  console.info("OS_D1_BUDGET", JSON.stringify(report));
}, 120000);
