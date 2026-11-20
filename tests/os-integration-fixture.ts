// Cenários de I compartilham esta fixture local; a fixture congelada de F0 fica intacta.
import assert from "node:assert/strict";
import worker from "../src/index";
import { all, exec, one } from "../src/db";
import { defaults, json, now, uid, type Actor, type Env } from "../src/types";
import { sha, MOBILE_TOKEN_PREFIX } from "../src/security";
import { inbound, perform } from "../src/service";
import { areaTemplates } from "../src/area-templates";
import { validateWorkType } from "../src/modules/os/validation";
import { moduleStates } from "../src/modules/registry";
import { countingEnv, type D1Count } from "./d1-counter";
import type {
  AreaTemplate,
  AreaTemplateSelection,
} from "../src/modules/os/contracts";
type WorkerEnv = Env;
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export interface Invocation {
  name: string;
  worker: D1Count;
  coordinators: D1Count[];
}
export interface Runtime {
  context(): ExecutionContext;
  drain(ctx: ExecutionContext): Promise<void>;
  inside<T>(
    stub: DurableObjectStub,
    run: (instance: any, state: DurableObjectState) => Promise<T>,
  ): Promise<T>;
}
export function integrationHarness(env: Env, runtime: Runtime) {
  const report: Invocation[] = [];
  return {
    env,
    report,
    async fetch(
      request: Request,
      name = request.method + " " + new URL(request.url).pathname,
    ) {
      const measured = countingEnv(env),
        coordinators: D1Count[] = [];
      const COORDINATOR = new Proxy(env.COORDINATOR, {
        get(target, property) {
          if (property === "get")
            return (...args: any[]) => {
              const stub = (target.get as any)(...args);
              return new Proxy(stub, {
                get(targetStub, key) {
                  if (key === "fetch")
                    return (input: RequestInfo, init?: RequestInit) =>
                      runtime.inside(stub, async (instance, state) => {
                        const original = instance.env;
                        const counted = countingEnv(original);
                        instance.env = counted.env;
                        try {
                          return await instance.fetch(new Request(input, init));
                        } finally {
                          await Promise.all([
                            ...(instance.closing?.values() ?? []),
                          ]);
                          instance.env = original;
                          await state.storage.deleteAlarm();
                          coordinators.push(counted.count);
                        }
                      });
                  const value = Reflect.get(targetStub, key);
                  return typeof value === "function"
                    ? value.bind(targetStub)
                    : value;
                },
              });
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const context = runtime.context();
      const response = await worker.fetch(
        request,
        { ...measured.env, COORDINATOR },
        context,
      );
      await runtime.drain(context);
      report.push({ name, worker: measured.count, coordinators });
      return response;
    },
    async alarm(profile: string) {
      const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(profile));
      return runtime.inside(stub, async (instance, state) => {
        await state.storage.put("profile", profile);
        await state.storage.delete("modules_tick");
        const original = instance.env,
          counted = countingEnv(original);
        instance.env = counted.env;
        try {
          await instance.alarm();
        } finally {
          instance.env = original;
          await state.storage.deleteAlarm();
        }
        return counted.count;
      });
    },
  };
}
export type IntegrationHarness = ReturnType<typeof integrationHarness>;
export async function integrationFixture(h: IntegrationHarness) {
  const profile = uid(),
    line = uid(),
    id = uid(),
    memberId = uid();
  await exec(
    h.env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Junção I",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    h.env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active','{}',?)",
    line,
    profile,
    "Canal",
    now(),
  );
  for (const [person, role] of [
    [id, "admin"],
    [memberId, "operator"],
  ])
    await exec(
      h.env,
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      person,
      `${person}@example.test`,
      person,
      "test",
      role,
      JSON.stringify([profile]),
      now(),
    );
  const actor: Actor = {
    id,
    name: id,
    kind: "user",
    role: "admin",
    profiles: [profile],
    scopes: [],
    bots: [],
    rate: 100,
    runLimit: 10,
  };
  const token = MOBILE_TOKEN_PREFIX + uid() + uid();
  await exec(
    h.env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used) VALUES(?,?,?,'bearer',?,?,?)",
    await sha(token),
    id,
    now() + 3600000,
    now(),
    "I",
    now(),
  );
  const root = `/api/v1/profiles/${profile}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    key = uid(),
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://test${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "Idempotency-Key": key }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    key = uid(),
    status = 200,
    label?: string,
  ) => {
    const response = await h.fetch(request(path, method, body, key), label);
    const data: any = await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(data)}`,
    );
    return data;
  };
  return { profile, line, actor, memberId, token, root, request, call };
}
export type IntegrationFixture = Awaited<ReturnType<typeof integrationFixture>>;
export function selection(model: AreaTemplate): AreaTemplateSelection {
  return {
    work_type_ids: ["service_order", ...model.work_types.map((t) => t.id)],
    module_ids: Object.keys(
      model.modules,
    ) as AreaTemplateSelection["module_ids"],
    menus: true,
    departments: true,
    ticket_categories: true,
    vocabulary: true,
    texts: true,
    bot_suggestions: true,
  };
}
export async function applyRegisteredTemplate(
  h: IntegrationHarness,
  id: string,
  existing?: IntegrationFixture,
) {
  const f = existing ?? (await integrationFixture(h));
  const model = areaTemplates.find((t) => t.id === id)!;
  assert.equal((await moduleStates(h.env, f.profile)).os, false);
  const catalog = await f.call("/area-templates");
  assert(catalog.data.some((entry: any) => entry.id === id));
  const source = { template_id: id, selection: selection(model) };
  const before = await one(
    h.env,
    "SELECT settings FROM profiles WHERE id=?",
    f.profile,
  );
  const preview = await f.call(
    "/area-templates/preview",
    "POST",
    source,
    uid(),
    200,
    "prévia de modelo",
  );
  assert.equal(
    preview.can_apply,
    true,
    `${id}: ${JSON.stringify(preview.conflicts)}`,
  );
  assert.deepEqual(
    await one(h.env, "SELECT settings FROM profiles WHERE id=?", f.profile),
    before,
  );
  const body = { ...source, preview_hash: preview.preview_hash },
    key = uid();
  const applied = await f.call(
    "/area-templates/apply",
    "POST",
    body,
    key,
    200,
    "aplicação de modelo",
  );
  assert.equal(applied.applied, true);
  assert.deepEqual(
    await f.call(
      "/area-templates/apply",
      "POST",
      body,
      key,
      200,
      "repetição de modelo",
    ),
    applied,
  );
  const settings = json(
    (await one(h.env, "SELECT settings FROM profiles WHERE id=?", f.profile))!
      .settings,
  );
  const states = await moduleStates(h.env, f.profile);
  for (const [module, enabled] of Object.entries(model.modules))
    assert.equal(states[module], enabled, `${id}: módulo ${module}`);
  if (model.modules.os) {
    assert.equal(settings.os_work_types.length, model.work_types.length);
    for (const type of settings.os_work_types)
      assert.deepEqual(validateWorkType(type), type);
    assert.equal(
      settings.os_work_types.some((t: any) => t.id === "service_order"),
      false,
    );
    assert.equal(states.os, true);
  } else {
    // Sem Ordem de Serviço: restaurante e, desde O segmento primeiro, comércio.
    assert.ok(["restaurante", "comercio"].includes(id), id);
    assert.deepEqual(model.work_types, []);
    assert.equal(settings.os_work_types, undefined);
    assert.equal(states.os, false);
    if (id === "restaurante") {
      assert.equal(states.pedido, true);
      assert.equal(states.queue, true);
    }
  }
  const again = await f.call("/area-templates/preview", "POST", source);
  assert.equal(
    (
      await f.call("/area-templates/apply", "POST", {
        ...source,
        preview_hash: again.preview_hash,
      })
    ).applied,
    false,
  );
  return f;
}
export async function customerConversation(
  h: IntegrationHarness,
  f: IntegrationFixture,
  phone = "5511960010203",
) {
  const result = await inbound(
    h.env,
    f.profile,
    { external_id: phone, phone, message_id: uid(), text: "Olá" },
    `channel:${f.line}`,
    f.line,
  );
  // O cenário exercita comandos e agenda, sem processar o menu nesta mensagem.
  await exec(
    h.env,
    "UPDATE inbox SET status='done' WHERE profile_id=?",
    f.profile,
  );
  return result.conversation_id;
}
export async function grantSensitive(
  h: IntegrationHarness,
  f: IntegrationFixture,
) {
  await perform(
    h.env,
    f.actor,
    f.profile,
    "user.update",
    { id: f.actor.id, access: ["*", "os:sensitive", "os:technician"] },
    uid(),
  );
  f.actor.access = ["*", "os:sensitive", "os:technician"];
  // Alterar acesso revoga sessões. Simula nova autenticação com a concessão.
  await exec(
    h.env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used) VALUES(?,?,?,'bearer',?,?,?)",
    await sha(f.token),
    f.actor.id,
    now() + 3600000,
    now(),
    "I",
    now(),
  );
}
export async function messages(h: IntegrationHarness, f: IntegrationFixture) {
  return all(
    h.env,
    "SELECT payload FROM outbox WHERE profile_id=? AND kind!='team' ORDER BY created,rowid",
    f.profile,
  );
}
