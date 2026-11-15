import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { setSecret } from "../src/security";
import { defaults, now, uid } from "../src/types";
import {
  zernioCreateFlow,
  zernioListFlows,
  zernioPublishFlow,
  zernioSendFlow,
  zernioUploadFlowJson,
} from "../src/whatsapp-flows";
import { flowIdFromToken } from "../src/whatsapp-interactive";

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Flows",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    id,
    profile,
    "WhatsApp",
    JSON.stringify({ account_id: "remote-account" }),
    now(),
  );
  await setSecret(env, `connection:${id}`, {
    api_key: "zernio-test-key",
    webhook_secret: "webhook-test-key",
  });
  return one(env, "SELECT * FROM connections WHERE id=?", id);
}

/** Simulated Zernio: answers one documented request and records it. */
function zernio(reply: any, status = 200) {
  const calls: { method: string; url: string; body: any; key: string }[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("Authorization")).toBe(
        "Bearer zernio-test-key",
      );
      calls.push({
        method: request.method,
        url: request.url,
        body: request.method === "GET" ? null : await request.json(),
        key: request.headers.get("Idempotency-Key") || "",
      });
      return Response.json(reply, { status });
    });
  return { fetch, calls };
}

const flowJson = {
  version: "6.0",
  screens: [
    {
      id: "AGENDA",
      title: "Agendar",
      terminal: true,
      success: true,
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Footer",
            label: "Enviar",
            "on-click-action": { name: "complete", payload: {} },
          },
        ],
      },
    },
  ],
};

it("lista os Flows da conta", async () => {
  const conn = await seed();
  const { calls } = zernio({
    success: true,
    flows: [
      {
        id: "1178094743614213",
        name: "agenda",
        status: "PUBLISHED",
        categories: ["APPOINTMENT_BOOKING"],
        version: 1,
        lineageId: "1178094743614213",
      },
    ],
  });
  const result = await zernioListFlows(env, conn);
  expect(calls[0]).toMatchObject({
    method: "GET",
    url: "https://zernio.com/api/v1/whatsapp/flows?accountId=remote-account",
  });
  expect(result.data[0]).toMatchObject({
    id: "1178094743614213",
    status: "PUBLISHED",
  });
});

it("cria um Flow em rascunho, inclusive nova versão de um publicado", async () => {
  const conn = await seed();
  const { calls } = zernio({
    success: true,
    flow: {
      id: "1178094743614299",
      name: "agenda",
      status: "DRAFT",
      categories: ["APPOINTMENT_BOOKING"],
      version: 2,
      lineageId: "1178094743614213",
    },
  });
  const created = await zernioCreateFlow(
    env,
    conn,
    {
      name: "agenda",
      categories: ["APPOINTMENT_BOOKING"],
      clone_flow_id: "1178094743614213",
      as_version: true,
    },
    "create-1",
  );
  expect(calls[0]).toEqual({
    method: "POST",
    url: "https://zernio.com/api/v1/whatsapp/flows",
    key: "create-1",
    body: {
      accountId: "remote-account",
      name: "agenda",
      categories: ["APPOINTMENT_BOOKING"],
      cloneFlowId: "1178094743614213",
      asVersion: true,
    },
  });
  expect(created).toMatchObject({ id: "1178094743614299", status: "DRAFT" });
  await expect(
    zernioCreateFlow(env, conn, { name: "x", categories: ["BOOKING" as any] }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toHaveLength(1);
});

it("envia o JSON e devolve os erros de validação da Meta", async () => {
  const conn = await seed();
  const { calls } = zernio({
    success: true,
    validation_errors: [
      {
        error: "INVALID_PROPERTY",
        error_type: "JSON_SCHEMA_ERROR",
        message: "Property 'input-type' is invalid",
        line_start: 12,
        line_end: 12,
        column_start: 9,
        column_end: 20,
      },
    ],
  });
  const result = await zernioUploadFlowJson(
    env,
    conn,
    "1178094743614213",
    flowJson,
  );
  expect(calls[0]).toEqual({
    method: "PUT",
    url: "https://zernio.com/api/v1/whatsapp/flows/1178094743614213/json",
    key: "",
    body: { accountId: "remote-account", flow_json: flowJson },
  });
  expect(result.valid).toBe(false);
  expect(result.validation_errors[0].line_start).toBe(12);
  await expect(
    zernioUploadFlowJson(env, conn, "../accounts", flowJson),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toHaveLength(1);
});

it("publica o Flow e repassa a recusa da Zernio", async () => {
  const conn = await seed();
  const { calls } = zernio({ success: true });
  await expect(
    zernioPublishFlow(env, conn, "1178094743614213"),
  ).resolves.toEqual({ published: true });
  expect(calls[0]).toEqual({
    method: "POST",
    url: "https://zernio.com/api/v1/whatsapp/flows/1178094743614213/publish",
    key: "",
    body: { accountId: "remote-account" },
  });
  vi.restoreAllMocks();
  zernio({ error: "Flow has validation errors", code: "invalid" }, 400);
  await expect(
    zernioPublishFlow(env, conn, "1178094743614213"),
  ).rejects.toMatchObject({ status: 400, code: "zernio_rejected" });
});

it("envia um Flow publicado com flow_token para correlacionar a resposta", async () => {
  const conn = await seed();
  const { calls } = zernio({
    success: true,
    messageId: "wamid.flow",
  });
  const sent = await zernioSendFlow(
    env,
    conn,
    "5511999990000",
    {
      flow_id: "1178094743614213",
      flow_cta: "Agendar",
      body: "Escolha data e serviço",
      header: "Barbearia",
      flow_action_payload: { screen: "AGENDA" },
    },
    "flow-1",
  );
  expect(sent.message_id).toBe("wamid.flow");
  expect(sent.flow_token).toMatch(/^1178094743614213:[0-9a-f-]{36}$/);
  expect(flowIdFromToken(sent.flow_token)).toBe("1178094743614213");
  expect(calls[0]).toEqual({
    method: "POST",
    url: "https://zernio.com/api/v1/whatsapp/flows/send",
    key: "flow-1",
    body: {
      accountId: "remote-account",
      to: "+5511999990000",
      flow_id: "1178094743614213",
      flow_cta: "Agendar",
      flow_action: "navigate",
      flow_token: sent.flow_token,
      flow_action_payload: { screen: "AGENDA" },
      body: "Escolha data e serviço",
      header: { type: "text", text: "Barbearia" },
    },
  });
});

it("mantém o flow_token informado e recusa destino sem telefone", async () => {
  const conn = await seed();
  const { calls } = zernio({ success: true, messageId: "wamid.flow" });
  const sent = await zernioSendFlow(env, conn, "+5511999990000", {
    flow_id: "1178094743614213",
    flow_cta: "Agendar",
    body: "Escolha",
    flow_token: "1178094743614213:pedido-7",
  });
  expect(sent.flow_token).toBe("1178094743614213:pedido-7");
  expect(calls[0].body.flow_token).toBe("1178094743614213:pedido-7");
  await expect(
    zernioSendFlow(env, conn, "BR.123456789", {
      flow_id: "1178094743614213",
      flow_cta: "Agendar",
      body: "Escolha",
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    zernioSendFlow(env, conn, "5511999990000", {
      flow_id: "1178094743614213",
      flow_cta: "x".repeat(31),
      body: "Escolha",
    }),
  ).rejects.toMatchObject({ code: "invalid_interactive" });
  expect(calls).toHaveLength(1);
});

it("não confirma envio sem messageId", async () => {
  const conn = await seed();
  zernio({ success: true });
  await expect(
    zernioSendFlow(env, conn, "5511999990000", {
      flow_id: "1178094743614213",
      flow_cta: "Agendar",
      body: "Escolha",
    }),
  ).rejects.toMatchObject({ code: "zernio_unknown" });
});
