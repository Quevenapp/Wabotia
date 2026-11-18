import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { onBinaryRead, onRead, onRoute } from "../src/modules/api";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { motorFixture } from "./os-motor-fixture";

async function call(
  profile: string,
  token: string,
  suffix: string,
  options: { method?: string; body?: unknown; bindings?: typeof env } = {},
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://test/api/v1/profiles/${profile}/${suffix}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": uid(),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
    options.bindings || env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("F0: registro de rotas após carregar a entrada HTTP", () => {
  it("atualiza o despacho após uma requisição, preserva IDs e prioriza estáticas entre JSON e binário", async () => {
    const f = await motorFixture();
    expect((await call(f.profile, f.token, "service-orders")).status).toBe(200);

    const prefix = `service-orders/f0-late-${uid()}`;
    const requests: any[] = [];
    const coordinator = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string);
          requests.push(body);
          return Response.json(body.data);
        },
      }),
    };
    onRoute("os", {
      method: "PATCH",
      path: `${prefix}/:id/tasks/:task_id`,
      op: "os.f0.late-update",
    });
    // Registra a genérica binária primeiro: a estática JSON deve prevalecer.
    onBinaryRead("os", `${prefix}/:id`, async () => ({
      body: new Uint8Array([0, 255, 128]).buffer,
      headers: { "Content-Type": "application/octet-stream" },
    }));
    const edited = await call(
      f.profile,
      f.token,
      `${prefix}/ordem/tasks/tarefa%20um`,
      {
        method: "PATCH",
        body: { profile: "intruso", id: "outro", task_id: "outro", version: 2 },
        bindings: { ...env, COORDINATOR: coordinator } as any,
      },
    );
    expect(edited.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      profile: f.profile,
      operation: "os.f0.late-update",
      data: { id: "ordem", task_id: "tarefa um", version: 2 },
    });
    expect(requests[0].data).not.toHaveProperty("profile");

    // Uma segunda rodada de registros também deve invalidar o índice.
    onRead("os", `${prefix}/catalog`, async (ctx, actor) => {
      ctx.access(actor, "conversations:read");
      return { static: true };
    });
    const catalog = await call(f.profile, f.token, `${prefix}/catalog`);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ static: true });
    const binary = await call(f.profile, f.token, `${prefix}/arquivo`);
    expect(binary.status).toBe(200);
    expect(binary.headers.get("Cache-Control")).toBe("no-store");
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([
      0, 255, 128,
    ]);
    expect((await call(f.profile, f.token, "status")).status).toBe(200);
    expect((await call(f.profile, f.token, "f0-route-missing")).status).toBe(
      404,
    );
  });

  it("mantém isolamento e bloqueio de módulo nas rotas registradas depois", async () => {
    const f = await motorFixture();
    const stranger = await motorFixture();
    expect((await call(f.profile, f.token, "service-orders")).status).toBe(200);
    let handled = 0;
    const path = `service-orders/f0-guard-${uid()}`;
    onRead("os", path, async (ctx, actor) => {
      ctx.access(actor, "conversations:read");
      handled++;
      return { ok: true };
    });
    expect((await call(f.profile, stranger.token, path)).status).toBe(404);
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: false },
      uid(),
    );
    expect((await call(f.profile, f.token, path)).status).toBe(409);
    expect(handled).toBe(0);
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: true },
      uid(),
    );
    expect((await call(f.profile, f.token, path)).status).toBe(200);
    expect(handled).toBe(1);
  });
});
