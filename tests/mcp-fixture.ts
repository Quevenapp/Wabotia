// Chamadas MCP nos testes das ferramentas dos módulos (bot com chave de
// aplicação, como o Hermes).
import { SELF } from "cloudflare:test";
import { uid } from "../src/types";
import { application, type Fixture } from "./service-center-fixture";

export async function botKey(f: Fixture) {
  return (await application(f, ["conversations:read", "conversations:write"]))
    .token;
}

export async function mcp(token: string, method: string, params: any = {}) {
  const response = await SELF.fetch("https://test/api/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: uid(), method, params }),
  });
  return response.json<any>();
}

/** tools/call: {ok, data} com o JSON da resposta, ou {ok:false, error}. */
export async function tool(token: string, name: string, args: any = {}) {
  const body = await mcp(token, "tools/call", { name, arguments: args });
  if (body.error) return { ok: false, error: body.error.message, data: null };
  const text = body.result.content[0].text as string;
  if (body.result.isError) return { ok: false, error: text, data: null };
  return { ok: true, error: null, data: JSON.parse(text) };
}

export async function toolNames(token: string) {
  const body = await mcp(token, "tools/list");
  return (body.result.tools as { name: string }[]).map((t) => t.name);
}
