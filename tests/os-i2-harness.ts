import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { integrationHarness } from "./os-integration-fixture";
export const i2Harness = () => integrationHarness(env, {
  context: createExecutionContext,
  drain: waitOnExecutionContext,
  inside: (stub, fn) => (runInDurableObject as any)(stub, fn),
});
