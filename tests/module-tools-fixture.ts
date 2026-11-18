// Exercita os ganchos onMcpTool em processo, sem servidor MCP HTTP.
import { env } from "cloudflare:test";
import { authenticate } from "../src/security";
import { internalCall } from "../src/internal-api";
import { moduleMcpTools } from "../src/modules/hooks";
import { moduleStates } from "../src/modules/registry";
import { uid } from "../src/types";
import { application, type Fixture } from "./service-center-fixture";
import "../src/modules/runtime";

export async function botKey(f: Fixture) {
  return (await application(f, ["conversations:read", "conversations:write"]))
    .token;
}
async function actorOf(token: string) {
  return authenticate(
    env,
    new Request("https://test/api/v1/profiles", {
      headers: { Authorization: "Bearer " + token },
    }),
  );
}
export async function toolDefinitions(token: string) {
  const actor = await actorOf(token);
  const states = await moduleStates(env, actor.profiles[0]);
  return moduleMcpTools().filter((tool) => states[tool.module]);
}
export async function toolNames(token: string) {
  return (await toolDefinitions(token)).map((tool) => tool.name);
}
export async function tool(token: string, name: string, args: any = {}) {
  try {
    const actor = await actorOf(token);
    const profile = args.profile || actor.profiles[0];
    let call;
    if (name === "claim_conversation")
      call = {
        method: "POST",
        path: `/profiles/${profile}/conversations/${args.conversation_id}/actions`,
        body: { action: "claim" },
      };
    else if (name === "get_conversation")
      call = {
        path: `/profiles/${profile}/conversations/${args.conversation_id}`,
      };
    else {
      const definition = moduleMcpTools().find((tool) => tool.name === name);
      if (!definition) throw new Error("Ferramenta indisponível.");
      for (const key of definition.required || [])
        if (args[key] === undefined) throw new Error(`Informe ${key}.`);
      const input = Object.fromEntries(
        Object.keys(definition.input)
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      );
      call = definition.call(input, profile);
    }
    const response = await internalCall(
      env,
      actor,
      call,
      args.idempotency_key || uid(),
    );
    const data = await response.json<any>();
    return response.ok
      ? { ok: true, data, error: null }
      : {
          ok: false,
          data: null,
          error: `${response.status} ${JSON.stringify(data)}`,
        };
  } catch (error) {
    return { ok: false, data: null, error: String(error) };
  }
}
