import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it } from "vitest";
import { areaTemplates } from "../src/area-templates";
import {
  applyRegisteredTemplate,
  integrationHarness,
} from "./os-integration-fixture";
import {
  deadlinesRegression,
  outgoingAttachmentRegression,
  recoveredChild,
} from "./os-integration-scenarios";

const harness = () =>
  integrationHarness(env, {
    context: createExecutionContext,
    drain: waitOnExecutionContext,
    inside: (stub, fn) => (runInDurableObject as any)(stub, fn),
  });
describe("I: registro e junção reais, sem mocks do motor/filhos", () => {
  it.each(areaTemplates.map((model) => [model.id]))(
    "aplica %s pela API em área limpa e valida todos os tipos",
    async (id) => {
      await applyRegisteredTemplate(harness(), id);
    },
    60000,
  );
  it("modelo, trabalho, aprovação, filhos, cliente/bot, embutido e recuperação após interrupção", async () => {
    await recoveredChild(harness());
  }, 60000);
  it("meus prazos mantém paginação, estado e etapas dos pais reais", async () => {
    await deadlinesRegression(harness());
  });
  it("anexos de saída validam bytes antes de persistir e preservam a idempotência", async () => {
    await outgoingAttachmentRegression(harness());
  });
});
