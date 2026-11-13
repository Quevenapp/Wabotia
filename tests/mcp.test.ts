import { env, SELF } from "cloudflare:test";
import { it, expect, describe } from "vitest";
import { exec, one } from "../src/db";
import { uid, now, defaults } from "../src/types";
import { sha } from "../src/security";
import { tools } from "../src/mcp";

async function fixture(
  scopes = [
    "conversations:read",
    "conversations:write",
    "tickets:read",
    "tickets:write",
    "bots:read",
    "bots:invoke",
    "events:read",
  ],
  profiles = 1,
) {
  const ids: string[] = [],
    id = uid(),
    token = "wab_" + uid();
  for (let i = 0; i < profiles; i++) {
    const p = uid();
    ids.push(p);
    await exec(
      env,
      "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
      p,
      "Área " + (i + 1),
      JSON.stringify(defaults),
      now(),
    );
  }
  await exec(
    env,
    "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)",
    id,
    "Hermes",
    JSON.stringify(ids),
    JSON.stringify(scopes),
    "[]",
    now(),
  );
  await exec(
    env,
    "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
    uid(),
    id,
    await sha(token),
    token.slice(0, 12),
    now() + 600000,
    now(),
  );
  return { p: ids[0], profiles: ids, id, token };
}
let seq = 0;
function rpc(method: string, params?: any, id: any = ++seq) {
  return { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params };
}
async function post(token: string | null, body: any, init: RequestInit = {}) {
  return SELF.fetch("https://test/api/mcp", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(init.headers as any),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function call(token: string, name: string, args: any = {}) {
  const r = await post(token, rpc("tools/call", { name, arguments: args }));
  expect(r.status).toBe(200);
  const body: any = await r.json();
  return body;
}
const text = (body: any) => body.result.content[0].text;
const parsed = (body: any) => JSON.parse(text(body));

describe("MCP transport", () => {
  it("rejects non-POST like a stateless Streamable HTTP server", async () => {
    for (const method of ["GET", "HEAD", "DELETE"]) {
      const r = await SELF.fetch("https://test/api/mcp", { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("Allow")).toBe("POST");
    }
  });
  it("requires an application key", async () => {
    expect((await post(null, rpc("initialize", {}))).status).toBe(401);
    expect((await post("wab_nope", rpc("initialize", {}))).status).toBe(401);
  });
  it("refuses user sessions", async () => {
    const user = uid(),
      token = "wabu_" + uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,role,password,profiles,created) VALUES(?,?,?,?,?,?,?)",
      user,
      user + "@example.com",
      "Pessoa",
      "admin",
      "x",
      "[]",
      now(),
    );
    await exec(
      env,
      "INSERT INTO sessions(hash,user_id,kind,expires,created) VALUES(?,?,?,?,?)",
      await sha(token),
      user,
      "bearer",
      now() + 600000,
      now(),
    );
    const r = await post(token, rpc("initialize", {}));
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("app_key_required");
  });
  it("negotiates initialize, accepts notifications and answers ping", async () => {
    const f = await fixture();
    const r = await post(
      f.token,
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "hermes", version: "1" },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    const init: any = await r.json();
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("wabotia");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toContain("claim_conversation");
    const future = await post(
      f.token,
      rpc("initialize", { protocolVersion: "2099-01-01" }),
    );
    expect(((await future.json()) as any).result.protocolVersion).toBe(
      "2025-06-18",
    );
    const n = await post(
      f.token,
      rpc("notifications/initialized", undefined, null),
    );
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    const ping: any = await (await post(f.token, rpc("ping"))).json();
    expect(ping.result).toEqual({});
    const unknown: any = await (
      await post(f.token, rpc("server/discover"))
    ).json();
    expect(unknown.error.code).toBe(-32601);
  });
  it("rejects malformed JSON and invalid envelopes", async () => {
    const f = await fixture();
    const bad = await post(f.token, "{");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe(-32700);
    const envelope: any = await (
      await post(f.token, { id: 1, method: "ping" })
    ).json();
    expect(envelope.error.code).toBe(-32600);
    const empty = await post(f.token, []);
    expect(empty.status).toBe(400);
  });
  it("lists tools with JSON Schema inputs", async () => {
    const f = await fixture();
    const list: any = await (await post(f.token, rpc("tools/list"))).json();
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_profiles");
    expect(names).toContain("reply_conversation");
    expect(names).toContain("send_router_message");
    expect(new Set(names).size).toBe(tools.length);
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.name).toMatch(/^[a-z_]+$/);
    }
  });
  it("answers batches in order", async () => {
    const f = await fixture();
    const r = await post(f.token, [
      rpc("ping", undefined, "a"),
      rpc("ping", undefined, "b"),
    ]);
    const body: any = await r.json();
    expect(body.map((m: any) => m.id)).toEqual(["a", "b"]);
  });
});

describe("MCP tools", () => {
  it("runs a full service flow through the v1 API", async () => {
    const f = await fixture();
    const profiles = parsed(await call(f.token, "list_profiles"));
    expect(profiles.map((p: any) => p.id)).toEqual([f.p]);
    const started = await call(f.token, "start_conversation", {
      external_id: "cliente-mcp",
      text: "Preciso de ajuda",
      idempotency_key: "mcp-start-" + f.id,
    });
    expect(started.result.isError).toBeUndefined();
    const conversationId = started.result.structuredContent.conversation_id;
    expect(conversationId).toBeTruthy();
    // Same idempotency key replays the same result instead of creating another.
    const again = await call(f.token, "start_conversation", {
      external_id: "cliente-mcp",
      text: "Preciso de ajuda",
      idempotency_key: "mcp-start-" + f.id,
    });
    expect(again.result.structuredContent.conversation_id).toBe(conversationId);
    expect(
      (
        await call(f.token, "claim_conversation", {
          conversation_id: conversationId,
        })
      ).result.isError,
    ).toBeUndefined();
    const reply = await call(f.token, "reply_conversation", {
      conversation_id: conversationId,
      text: "Como posso ajudar?",
    });
    expect(reply.result.isError).toBeUndefined();
    await call(f.token, "add_internal_note", {
      conversation_id: conversationId,
      text: "nota interna",
    });
    const inbound = await call(f.token, "receive_inbound_message", {
      conversation_id: conversationId,
      external_id: "cliente-mcp",
      text: "Segunda mensagem",
    });
    expect(inbound.result.isError).toBeUndefined();
    const full = await call(f.token, "get_conversation", {
      conversation_id: conversationId,
    });
    expect(full.result.structuredContent.conversation.id).toBe(conversationId);
    const total = full.result.structuredContent.messages.length;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(full.result.structuredContent.messages_omitted).toBeUndefined();
    const texts = full.result.structuredContent.messages.map(
      (m: any) => m.text,
    );
    expect(texts).toContain("Segunda mensagem");
    expect(texts.join(" ")).not.toContain("nota interna");
    const detail = await call(f.token, "get_conversation", {
      conversation_id: conversationId,
      last_messages: 1,
    });
    expect(detail.result.structuredContent.messages).toHaveLength(1);
    expect(detail.result.structuredContent.messages[0].text).toBe(
      "Segunda mensagem",
    );
    expect(detail.result.structuredContent.messages_omitted).toBe(total - 1);
    const listed = parsed(
      await call(f.token, "list_conversations", {
        limit: "10",
        state: "human",
      }),
    );
    expect(listed.data.map((c: any) => c.id)).toContain(conversationId);
    const ticket = await call(f.token, "create_ticket", {
      conversation_id: conversationId,
      title: "Solicitação",
    });
    expect(ticket.result.structuredContent.number).toMatch(/^WA-/);
    const got = await call(f.token, "get_ticket", {
      ticket_id: ticket.result.structuredContent.id,
    });
    expect(got.result.structuredContent.ticket.conversation_id).toBe(
      conversationId,
    );
    const updated = await call(f.token, "update_ticket", {
      ticket_id: ticket.result.structuredContent.id,
      status: "in_progress",
      text: "Em análise",
    });
    expect(updated.result.isError).toBeUndefined();
    const overdue = parsed(
      await call(f.token, "list_tickets", {
        status: "in_progress",
        overdue: "false",
      }),
    );
    expect(overdue.data.map((t: any) => t.id)).toContain(
      ticket.result.structuredContent.id,
    );
    const waiting = await call(f.token, "update_ticket", {
      ticket_id: ticket.result.structuredContent.id,
      status: "waiting_customer",
    });
    expect(waiting.result.isError).toBeUndefined();
    const active = parsed(
      await call(f.token, "list_tickets", {
        status: "waiting_customer,waiting_third",
        active: true,
      }),
    );
    expect(active.data.map((t: any) => t.status)).toEqual(["waiting_customer"]);
    const invalid = await call(f.token, "update_ticket", {
      ticket_id: ticket.result.structuredContent.id,
      status: "done",
    });
    expect(invalid.error.code).toBe(-32602);
  });
  it("reports API errors as tool errors and keeps protocol errors separate", async () => {
    const f = await fixture(["conversations:read"]);
    const denied = await call(f.token, "list_contacts", {});
    expect(denied.result.isError).toBe(true);
    expect(text(denied)).toContain("403");
    expect(text(denied)).toContain("contacts:read");
    const missing = await call(f.token, "get_conversation", {});
    expect(missing.error.code).toBe(-32602);
    expect(missing.error.message).toContain("conversation_id");
    const typed = await call(f.token, "list_conversations", {
      limit: "muitos",
    });
    expect(typed.error.code).toBe(-32602);
    const unknown = await call(f.token, "delete_everything", {});
    expect(unknown.error.code).toBe(-32602);
    const notFound = await call(f.token, "get_conversation", {
      conversation_id: "nope",
    });
    expect(notFound.result.isError).toBe(true);
    expect(text(notFound)).toContain("404");
    const bots = await call(f.token, "list_bots", {});
    expect(bots.result.isError).toBe(true);
  });
  it("requires profile only when the key reaches several areas", async () => {
    const f = await fixture(undefined, 2);
    const ambiguous = await call(f.token, "list_bots", {});
    expect(ambiguous.error.code).toBe(-32602);
    expect(ambiguous.error.message).toContain(f.profiles[1]);
    const explicit = await call(f.token, "list_bots", {
      profile: f.profiles[1],
    });
    expect(explicit.result.isError).toBeUndefined();
    const foreign = await call(f.token, "list_bots", { profile: "outra" });
    expect(foreign.result.isError).toBe(true);
    expect(text(foreign)).toContain("404");
  });
  it("counts one request per tool call against the application rate", async () => {
    const f = await fixture();
    await call(f.token, "list_profiles");
    await call(f.token, "list_bots");
    const row = await one(
      env,
      "SELECT sum(count) total FROM rate_limits WHERE key LIKE ?",
      `app:${f.id}:%`,
    );
    expect(row.total).toBe(2);
  });
  it("never trusts the internal actor header from outside", async () => {
    const r = await SELF.fetch("https://test/api/v1/profiles", {
      headers: { "X-Wabotia-Internal-Actor": "forjado" },
    });
    expect(r.status).toBe(401);
  });
});
