import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json, uid } from "../src/types";
import {
  commitSettingsPlan,
  perform,
  planSettings,
  settingsRevision,
} from "../src/service";
import {
  onBinaryRead,
  onBinaryUpload,
  onRead,
  onRoute,
  onSettingsChange,
  registerAdminExtension,
  type ModuleContext,
} from "../src/modules/api";
import {
  moduleRoutes,
  orderedRoutes,
  routeData,
  registerSchedule,
  registerScheduleExtension,
  scheduledModules,
} from "../src/modules/hooks";
import { moduleStates, planModuleStates } from "../src/modules/registry";
import { binaryCommand, readBinaryContent } from "../src/modules/binary";
import { runExtensionsDue } from "../src/modules/os/extension-runtime";
import type { DueRequest, OsExtension } from "../src/modules/os/extensions";
import { SCHEDULE_INTERVAL_MS } from "../src/modules/schedule";
import { authorizedOrder, resolveWorkType } from "../src/modules/os/public";
import {
  projectOrderForBot,
  projectOrderForStaff,
  mayReadSensitive,
} from "../src/modules/os/privacy";
import { api, receive } from "./service-center-fixture";
import {
  MOTOR_SENTINEL,
  MOTOR_WORK_TYPE,
  motorFixture,
  motorOrder,
  motorWorkType,
} from "./os-motor-fixture";

// Rotas apenas deste isolado de teste, antes de importar a entrada HTTP.
onRoute("os", {
  method: "PATCH",
  path: "service-orders/:id/f0-tasks/:task_id",
  op: "os.f0.update",
});
onRead("os", "service-orders/f0-static", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return { static: true };
});
onBinaryRead(
  "os",
  "service-orders/:id/f0-download",
  async (ctx, actor, { params }) => {
    await authorizedOrder(ctx, actor, params.id);
    return {
      body: new Uint8Array([0, 255, 128]).buffer,
      headers: { "Content-Type": "application/octet-stream" },
    };
  },
);

describe("F0: planejamento de configuração compartilhado", () => {
  it("aceita menu antigo e embutido explícito; recusa referência inexistente sem gravar", async () => {
    const f = await motorFixture();
    for (const reference of [{}, { type_id: "service_order" }]) {
      const response = await api(
        f.adminToken,
        `/profiles/${f.profile}/settings`,
        "PUT",
        {
          menus: [
            { id: "abrir", label: "Abrir", type: "os_open", ...reference },
          ],
          service_orders: { warranty_days: 12 },
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json<any>();
      expect(body.service_orders).toEqual({ warranty_days: 12 });
      expect(body.menus[0]).toMatchObject(reference);
    }
    const before = await settingsRevision(env, f.profile);
    const bad = await api(
      f.adminToken,
      `/profiles/${f.profile}/settings`,
      "PUT",
      {
        menus: [
          {
            id: "abrir",
            label: "Abrir",
            type: "os_open",
            type_id: "inexistente",
          },
        ],
      },
    );
    expect(bad.status).toBe(400);
    expect(await settingsRevision(env, f.profile)).toBe(before);
  });

  it("confere revisão completa e chama o gancho anterior/seguinte, sem persistir revisão", async () => {
    const f = await motorFixture();
    const seen: unknown[] = [];
    const remove = onSettingsChange("os", (previous, next, context) => {
      seen.push({ previous, next, context });
      if (
        next.service_orders?.warranty_days <
        (previous.service_orders?.warranty_days ?? 0)
      )
        throw new ApiError(
          409,
          "test_revision_rule",
          "Regra de revisão de teste.",
        );
    });
    try {
      const revision = await settingsRevision(env, f.profile);
      await perform(
        env,
        f.admin,
        f.profile,
        "settings",
        {
          settings_revision: revision,
          service_orders: { warranty_days: 12 },
        },
        uid(),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        context: { changed_keys: ["service_orders"], modules: { os: true } },
      });
      await expect(
        planSettings(env, f.admin, f.profile, {
          settings_revision: revision,
          menu_greeting: "concorrente",
        }),
      ).rejects.toMatchObject({ status: 409, code: "settings_conflict" });
      await expect(
        planSettings(env, f.admin, f.profile, {
          service_orders: { warranty_days: 1 },
        }),
      ).rejects.toMatchObject({ code: "test_revision_rule" });
      const saved = json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      );
      expect(saved).not.toHaveProperty("settings_revision");
      expect(saved.service_orders).toEqual({ warranty_days: 12 });
    } finally {
      remove();
    }
  });

  it("prévia não grava; confirma módulo inicialmente desligado, menu e procedência juntos", async () => {
    const f = await motorFixture({ enabled: false });
    const before = await settingsRevision(env, f.profile);
    const plan = await planSettings(
      env,
      f.admin,
      f.profile,
      {
        menus: [{ id: "abrir", label: "Abrir", type: "os_open" }],
      },
      { modules: { os: true }, expected_revision: before },
    );
    expect((await moduleStates(env, f.profile)).os).toBe(false);
    expect(await settingsRevision(env, f.profile)).toBe(before);
    const key = `f0:${f.profile}`;
    const result = await commitSettingsPlan(env, f.admin, plan, [
      [
        "INSERT INTO instance_settings(key,value,updated) VALUES(?,?,?)",
        [key, "procedencia", 1],
      ],
    ]);
    expect(result.settings_revision).toBe(plan.settings_revision);
    expect((await moduleStates(env, f.profile)).os).toBe(true);
    expect(
      (await one(env, "SELECT value FROM instance_settings WHERE key=?", key))
        .value,
    ).toBe("procedencia");
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ).menus[0].id,
    ).toBe("abrir");
  });

  it("falha de procedência reverte configuração e módulos; plano antigo é recusado", async () => {
    const f = await motorFixture({ enabled: false });
    const before = await settingsRevision(env, f.profile);
    const plan = await planSettings(
      env,
      f.admin,
      f.profile,
      { menu_greeting: "modelo" },
      { modules: { os: true } },
    );
    await expect(
      commitSettingsPlan(env, f.admin, plan, [
        [
          "INSERT INTO profiles(id,name,created) VALUES(?,?,?)",
          [f.profile, "duplicado", 1],
        ],
      ]),
    ).rejects.toThrow();
    expect(await settingsRevision(env, f.profile)).toBe(before);
    expect((await moduleStates(env, f.profile)).os).toBe(false);
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='module.changed'",
        f.profile,
      ),
    ).toHaveLength(0);
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { menu_greeting: "manual" },
      uid(),
    );
    await expect(commitSettingsPlan(env, f.admin, plan)).rejects.toMatchObject({
      code: "settings_conflict",
    });
  });

  it("valida dependências finais e registra comandos administrativos fora de os", async () => {
    expect(() =>
      planModuleStates({ os: false }, { inexistente: true }),
    ).toThrow();
    expect(() =>
      planModuleStates({ suporte: true, mensalidade: false }, {}),
    ).toThrow();
    const f = await motorFixture({ enabled: false });
    registerAdminExtension({
      id: "area-templates",
      reads: [],
      writes: [],
      commands: [
        {
          op: "area-template.f0-test",
          handler: async (e, actor, profile) => {
            const plan = await planSettings(
              e,
              actor,
              profile,
              {},
              { modules: { os: true } },
            );
            return commitSettingsPlan(e, actor, plan);
          },
        },
      ],
    });
    await expect(
      perform(env, f.member, f.profile, "area-template.f0-test", {}, uid()),
    ).rejects.toMatchObject({ status: 403 });
    await perform(env, f.admin, f.profile, "area-template.f0-test", {}, uid());
    expect((await moduleStates(env, f.profile)).os).toBe(true);
  });

  it("recusa mudança de módulos entre planejamento e confirmação", async () => {
    const f = await motorFixture({ enabled: false });
    const plan = await planSettings(env, f.admin, f.profile, {}, { modules: { os: true } });
    await perform(env, f.admin, f.profile, "module.set", { id: "queue", enabled: false }, uid());
    expect(await settingsRevision(env, f.profile)).toBe(plan.base_revision);
    await expect(commitSettingsPlan(env, f.admin, plan)).rejects.toMatchObject({ code: "settings_conflict" });
    expect((await moduleStates(env, f.profile)).os).toBe(false);
  });
});

describe("F0: rotas filhas e transporte binário", () => {
  it("a entrada HTTP despacha filhos, prioriza a rota estática e preserva o binário", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    const worker = (await import("../src/index")).default;
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
    const call = async (suffix: string, method = "GET", body?: unknown) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(
          `https://test/api/v1/profiles/${f.profile}/service-orders/${suffix}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${f.token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": uid(),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        ),
        { ...env, COORDINATOR: coordinator } as any,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    const response = await call(`${order.id}/f0-tasks/tarefa`, "PATCH", {
      id: "outro",
      task_id: "outro",
      profile: "intruso",
      version: 2,
    });
    expect(response.status).toBe(200);
    expect(requests[0]).toMatchObject({
      profile: f.profile,
      operation: "os.f0.update",
      data: { id: order.id, task_id: "tarefa", version: 2 },
    });
    expect(requests[0].data).not.toHaveProperty("profile");
    expect(await (await call("f0-static")).json()).toEqual({ static: true });
    const downloaded = await call(`${order.id}/f0-download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Cache-Control")).toBe("no-store");
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([
      0, 255, 128,
    ]);
  });

  it("IDs de caminho prevalecem e profile do corpo nunca vira dado de comando", () => {
    expect(
      routeData(
        { profile: "intruso", id: "outro", task_id: "outro", version: 3 },
        {
          profile: "area",
          id: "ordem",
          task_id: "tarefa",
        },
      ),
    ).toEqual({ id: "ordem", task_id: "tarefa", version: 3 });
    const paths = orderedRoutes([
      { path: "service-orders/:id" },
      { path: "queue/:id" },
      { path: "service-orders/types" },
      { path: "service-orders/conversation/:id" },
    ]).map((r) => r.path);
    expect(paths.indexOf("service-orders/types")).toBeLessThan(
      paths.indexOf("service-orders/:id"),
    );
    expect(paths.indexOf("service-orders/conversation/:id")).toBeLessThan(
      paths.indexOf("service-orders/:id"),
    );
  });

  it("download devolve bytes sem JSON, no-store, e autoriza antes de ler conteúdo", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    const path = "service-orders/:id/f0-content";
    const read = vi.fn(() => new Uint8Array([0, 255, 10, 13]).buffer);
    onBinaryRead("os", path, async (ctx, actor, { params }) => {
      await authorizedOrder(ctx, actor, params.id);
      return {
        body: read(),
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "public",
        },
      };
    });
    const route = moduleRoutes().binary.find(
      (r) => r.path === path && r.method === "GET",
    )!;
    const request = {
      params: { id: order.id },
      query: {},
      request: new Request("https://test/content"),
    };
    const response = await route.handler(env, f.member, f.profile, request);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      0, 255, 10, 13,
    ]);
    const stranger = await motorFixture();
    await expect(
      route.handler(env, stranger.member, f.profile, request),
    ).rejects.toMatchObject({ status: 404 });
    const app = { ...f.member, kind: "app" as const, scopes: [] };
    await expect(
      route.handler(env, app, f.profile, request),
    ).rejects.toMatchObject({ status: 403 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("upload valida versão, chave e tamanho real; não entrega bytes antes da autorização", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    const uploaded = vi.fn();
    const path = "service-orders/:id/documents/:document_id/f0-content";
    onBinaryUpload("os", path, {
      operations: ["os.f0.upload.reserve"],
      authorize: async (ctx, actor, { params }) => {
        await authorizedOrder(ctx, actor, params.id, { write: true });
      },
      upload: async (_ctx, _actor, request) => {
        const content = await request.content();
        uploaded(content);
        return {
          id: request.params.document_id,
          version: request.version,
          byte_length: content.byte_length,
          sha256: content.sha256,
        };
      },
    });
    const route = moduleRoutes().binary.find(
      (r) => r.path === path && r.method === "PUT",
    )!;
    const request = (headers: Record<string, string> = {}) => ({
      params: { id: order.id, document_id: "documento" },
      query: {},
      request: new Request("https://test/content", {
        method: "PUT",
        body: new Uint8Array([0, 255, 1]),
        headers: {
          "Idempotency-Key": "f0-upload",
          "Upload-Version": "1",
          ...headers,
        },
      }),
    });
    const response = await route.handler(env, f.member, f.profile, request());
    expect(await response.json()).toMatchObject({
      id: "documento",
      version: 1,
      byte_length: 3,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      route.handler(
        env,
        f.member,
        f.profile,
        request({ "Upload-Version": "1.5" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(
        env,
        f.member,
        f.profile,
        request({ "Idempotency-Key": "" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const foreign = await motorFixture();
    await expect(
      route.handler(env, foreign.member, f.profile, request()),
    ).rejects.toMatchObject({ status: 404 });
    expect(uploaded).toHaveBeenCalledTimes(1);
    await expect(
      readBinaryContent(
        new Request("https://test", {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
          headers: { "Content-Length": "1" },
        }),
        2,
      ),
    ).rejects.toMatchObject({ status: 413, code: "document_too_large" });
  });

  it("metadados do upload passam pelo Coordinator com escopo e chave estáveis", async () => {
    const f = await motorFixture();
    const sent: any[] = [];
    const coordinator = {
      idFromName: (name: string) => {
        expect(name).toBe(f.profile);
        return name;
      },
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string);
          sent.push(body);
          return Response.json({ id: body.data.document_id, version: 2 });
        },
      }),
    };
    const command = binaryCommand(
      { ...env, COORDINATOR: coordinator } as any,
      f.member,
      f.profile,
      { id: "ordem", document_id: "documento" },
      ["os.f0.reserve"],
      "chave-estavel",
    );
    await command("os.f0.reserve", {
      id: "intruso",
      document_id: "intruso",
      profile: "outra-area",
      version: 1,
    });
    expect(sent[0]).toMatchObject({
      profile: f.profile,
      key: "chave-estavel",
      actor: { id: f.member.id },
      data: { id: "ordem", document_id: "documento", version: 1 },
    });
    expect(sent[0].data).not.toHaveProperty("profile");
    await expect(command("settings", {})).rejects.toThrow(/não declarado/);
    expect(sent).toHaveLength(1);
  });

  it("resolve anexos pela mensagem/conversa e só copia documento compartilhável para mídia comum", async () => {
    const f = await motorFixture();
    const c = await receive(f, f.line, "DOCUMENTO 1", "5511960020304");
    const other = await receive(f, f.line, "oi", "5511960020305");
    const media = uid(),
      message = uid(),
      key = `f0/${f.profile}/${media}`;
    await env.MEDIA.put(key, new Uint8Array([1, 2, 3]));
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
      media,
      f.profile,
      "entrada.pdf",
      "application/pdf",
      3,
      key,
      "transport",
      1,
    );
    await exec(
      env,
      "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,created) VALUES(?,?,?,'customer','customer','',?,?)",
      message,
      f.profile,
      c.id,
      JSON.stringify([media]),
      1,
    );
    const attachments = await f.ctx.inboundAttachments(c, message);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: media,
      byte_length: 3,
      mime_type: "application/pdf",
    });
    expect(attachments[0]).not.toHaveProperty("object_key");
    expect(await f.ctx.inboundAttachments(other, message)).toEqual([]);
    expect(await f.ctx.inboundAttachments(c, media)).toEqual([]);
    expect([
      ...new Uint8Array(await (await attachments[0].open()).arrayBuffer()),
    ]).toEqual([1, 2, 3]);
    const input = () => ({
      name: "saida.pdf",
      mime_type: "application/pdf",
      byte_length: 3,
      body: new Response(new Uint8Array([4, 5, 6])).body!,
      key: `document:${media}:v1`,
      client_visible: true,
      sensitive: false,
    });
    await expect(
      f.ctx.outgoingAttachment(f.admin, c, { ...input(), sensitive: true }),
    ).rejects.toMatchObject({ code: "document_not_shareable" });
    await expect(
      f.ctx.outgoingAttachment(f.admin, c, {
        ...input(),
        client_visible: false,
      }),
    ).rejects.toMatchObject({ code: "document_not_shareable" });
    const id = await f.ctx.outgoingAttachment(f.admin, c, input());
    expect(await f.ctx.outgoingAttachment(f.admin, c, input())).toBe(id);
    expect(
      await all(
        env,
        "SELECT id FROM media WHERE id=? AND profile_id=?",
        id,
        f.profile,
      ),
    ).toHaveLength(1);
  });
});

describe("F0: agregador e API interna congelada", () => {
  it("falha parcial conserva orçamento, executa o próximo filho e solicita continuação sem expor o erro", async () => {
    const f = await motorFixture();
    const wake = vi.fn(async () => {});
    const next = vi.fn(async (_ctx: ModuleContext, request: DueRequest) => {
      expect(request.budget.remaining).toBe(163);
      request.budget.consume(3);
      return { processed: 1, has_more: false };
    });
    const extensions: OsExtension[] = [
      {
        id: "tasks", reads: [], writes: [], commands: [],
        runDue: async (_ctx, { budget }) => {
          budget.consume(37);
          throw new Error(MOTOR_SENTINEL);
        },
      },
      { id: "documents", reads: [], writes: [], commands: [], runDue: next },
    ];
    await expect(runExtensionsDue({ ...f.ctx, wake }, 1234, extensions))
      .rejects.toThrow("Falha no agendamento da extensão tasks.");
    expect(next).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledExactlyOnceWith({ modules: true });
  });

  it("falha que esgota orçamento conserva a pendência sem executar mais SQL", async () => {
    const f = await motorFixture();
    const wake = vi.fn(async () => {}), next = vi.fn();
    await expect(runExtensionsDue({ ...f.ctx, wake }, 1234, [
      {
        id: "tasks", reads: [], writes: [], commands: [],
        runDue: async (_ctx, { budget }) => {
          budget.consume(200);
          throw new Error(MOTOR_SENTINEL);
        },
      },
      { id: "documents", reads: [], writes: [], commands: [], runDue: next },
    ])).rejects.toThrow("Falha no agendamento da extensão tasks.");
    expect(next).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledExactlyOnceWith({ modules: true });
  });

  it("falha do gancho legado não impede o agregado e continua visível ao agendador", async () => {
    const id = `f0-schedule-${uid()}`;
    const failure = new Error("falha do lembrete");
    const next = vi.fn(async () => {});
    registerSchedule(id, async () => { throw failure; });
    registerScheduleExtension(id, next);
    const handler = scheduledModules().find(([module]) => module === id)![1];
    await expect(handler(env, "area", 1234)).rejects.toBe(failure);
    expect(next).toHaveBeenCalledExactlyOnceWith(env, "area", 1234);
  });

  it("onze documentos continuam após um alarme antecipado, respeitando o minuto e a área", async () => {
    const f = await motorFixture();
    await perform(env, f.admin, f.profile, "settings", {
      settings_revision: await settingsRevision(env, f.profile),
      os_work_types: [motorWorkType()],
    }, uid());
    const order = await motorOrder(f, { type_id: "projeto" });
    const foreign = await motorFixture();
    const other = await motorOrder(foreign);
    for (const [profile, parent, count] of [
      [f.profile, order.id, 11], [foreign.profile, other.id, 1],
    ] as const) {
      for (let i = 0; i < count; i++)
        await exec(env,
          `INSERT INTO os_documents(id,profile_id,order_id,name,mime_type,expected_bytes,
            upload_expires_at,created_by,created,updated) VALUES(?,?,?,'Expirado','text/plain',1,1,?,1,1)`,
          uid(), profile, parent, f.admin.id);
    }
    const pending = async (profile: string) => (await one(env,
      "SELECT count(*) n FROM os_documents WHERE profile_id=? AND state='pending'", profile))!.n;
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await runInDurableObject(stub, async (instance: any, state) => {
        await state.storage.put("profile", f.profile);
        await state.storage.deleteAlarm();
        await instance.alarm();
        expect(await pending(f.profile)).toBe(1);
        expect(await state.storage.get("modules_pending")).toBe(true);
        expect(await state.storage.getAlarm()).toBe(at + SCHEDULE_INTERVAL_MS);
      });
      clock.mockReturnValue(at + 1000);
      // Outro estímulo antecipa o alarme, mas não pode consumir a continuação.
      await f.ctx.wake();
      await runInDurableObject(stub, async (instance: any, state) => {
        await state.storage.deleteAlarm();
        await instance.alarm();
        expect(await pending(f.profile)).toBe(1);
        expect(await state.storage.get("modules_tick")).toBe(at);
        expect(await state.storage.get("modules_pending")).toBe(true);
        expect(await state.storage.getAlarm()).toBe(at + SCHEDULE_INTERVAL_MS);
      });
      clock.mockReturnValue(at + SCHEDULE_INTERVAL_MS);
      await runInDurableObject(stub, async (instance: any, state) => {
        await state.storage.deleteAlarm();
        await instance.alarm();
        expect(await pending(f.profile)).toBe(0);
        expect(await pending(foreign.profile)).toBe(1);
        expect(await state.storage.get("modules_pending")).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      });
    } finally {
      clock.mockRestore();
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it("o agregador conserva o lembrete legado de paralisação, sem duplicar evento", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    await exec(
      env,
      "UPDATE os_orders SET updated=1,stale_notified_at=NULL WHERE id=? AND profile_id=?",
      order.id,
      f.profile,
    );
    const handler = scheduledModules().find(([id]) => id === "os")![1];
    const at = 30 * 86400000;
    await handler(env, f.profile, at);
    await handler(env, f.profile, at);
    expect(
      (
        await one(
          env,
          "SELECT stale_notified_at FROM os_orders WHERE id=? AND profile_id=?",
          order.id,
          f.profile,
        )
      ).stale_notified_at,
    ).toBe(at);
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='os.stale'",
        f.profile,
      ),
    ).toHaveLength(1);
  });

  it("preserva um único agendador de os e compartilha limites entre extensões", async () => {
    const f = await motorFixture();
    expect(scheduledModules().filter(([id]) => id === "os")).toHaveLength(1);
    const calls: unknown[] = [];
    const extensions: OsExtension[] = ["tasks", "documents"].map((id) => ({
      id: id as OsExtension["id"],
      reads: [],
      writes: [],
      commands: [],
      runDue: async (_ctx, request) => {
        calls.push([id, request.now, request.limit, request.budget.remaining]);
        request.budget.consume(100);
        return { processed: 5, has_more: id === "documents" };
      },
    }));
    const wake = vi.fn(async () => {});
    expect(
      await runExtensionsDue({ ...f.ctx, wake }, 1234, extensions),
    ).toEqual({ processed: 10, has_more: true });
    expect(calls).toEqual([
      ["tasks", 1234, 10, 200],
      ["documents", 1234, 5, 100],
    ]);
    expect(wake).toHaveBeenCalledOnce();
    await expect(
      runExtensionsDue(f.ctx, 1, [
        {
          ...extensions[0],
          runDue: async (_ctx, r) => {
            r.budget.consume(201);
            return { processed: 0, has_more: false };
          },
        },
      ]),
    ).rejects.toThrow(/Orçamento/);
  });

  it("embutido usa definições atuais; preserva projeção antiga e não escreve ao resolver", async () => {
    const f = await motorFixture();
    const original = await motorOrder(f, { notes: MOTOR_SENTINEL });
    const order = await authorizedOrder(f.ctx, f.member, original.id);
    const view = projectOrderForStaff(f.ctx, f.member, order);
    for (const [key, value] of Object.entries(original))
      expect(view[key as keyof typeof view]).toEqual(value);
    expect(view).toMatchObject({
      type_id: "service_order",
      stage: "received",
      type_number: original.number,
      version: 1,
      extra: {},
    });
    expect(
      JSON.stringify(projectOrderForBot(f.ctx, f.member, order)),
    ).not.toContain(MOTOR_SENTINEL);
    expect(
      await all(
        env,
        "SELECT id FROM os_history WHERE order_id=? AND profile_id=?",
        original.id,
        f.profile,
      ),
    ).toHaveLength(1);
    await expect(resolveWorkType(f.ctx)).resolves.toMatchObject({
      id: "service_order",
      kind: "builtin",
      revision: 1,
    });
  });

  it("confere titular da conversa e não concede sigilo ao administrador nem ao bot", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    const c = await receive(f, f.line, "oi", "5511960010203");
    await expect(
      authorizedOrder(f.ctx, f.member, order.id, { conversation_id: c.id }),
    ).resolves.toHaveProperty("row.id", order.id);
    const other = await receive(f, f.line, "oi", "5511960010204");
    await expect(
      authorizedOrder(f.ctx, f.member, order.id, { conversation_id: other.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await mayReadSensitive(f.ctx, f.admin)).toBe(false);
    const human = { ...f.member, access: ["os:sensitive"] };
    expect(await mayReadSensitive(f.ctx, human)).toBe(true);
    expect(await mayReadSensitive(f.ctx, { ...human, id: "bot:teste" })).toBe(
      false,
    );
    expect(
      await mayReadSensitive(f.ctx, {
        ...human,
        via: { kind: "bot", bot_id: "b", run_id: "r", masked: false },
      }),
    ).toBe(false);
    expect(Object.isFrozen(MOTOR_WORK_TYPE.fields[0])).toBe(true);
    const copy = motorWorkType();
    copy.labels.singular = "Local";
    expect(MOTOR_WORK_TYPE.labels.singular).toBe("Projeto");
  });
});
