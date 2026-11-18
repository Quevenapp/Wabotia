import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { exec } from "../src/db";
import { now, uid, type Actor } from "../src/types";
import { perform, settingsRevision } from "../src/service";
import { sha } from "../src/security";
import { CREDENTIAL_PREFIX } from "../src/module-credentials";
import { modulesApi } from "../src/modules/api";
import { modules } from "../src/modules/registry";
import type { ModuleDefinition } from "../src/modules/types";
import { condominioModule } from "../src/modules/condominio/definition";
import { registerCondominio } from "../src/modules/condominio/condominio";
import { cadastro } from "../src/modules/condominio/cadastro";
import { workTypes } from "../src/modules/condominio/works";
import { osModule } from "../src/modules/os/definition";
import { MOTOR_EVENTS } from "../src/modules/os/motor-routes";
import { configure, drain, fixture, receive } from "./service-center-fixture";
import { motorWorkType } from "./os-motor-fixture";

// Registros reservados ao integrador, apenas no isolado deste teste.
beforeAll(() => {
  if (!modules.some((m) => m.id === "condominio")) {
    (modules as ModuleDefinition[]).push(condominioModule);
    registerCondominio();
  }
  for (const e of MOTOR_EVENTS)
    if (!osModule.events.includes(e)) osModule.events.push(e);
});
export async function condFixture() {
  const f = await fixture();
  f.admin.access = ["condominio:admin", "condominio:mesa"];
  f.member.access = ["condominio:portaria"];
  f.other.access = ["condominio:mesa"];
  for (const actor of [f.admin, f.member, f.other])
    await exec(
      env,
      "UPDATE users SET access=? WHERE id=?",
      JSON.stringify(actor.access),
      actor.id,
    );
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "os", enabled: true },
    uid(),
  );
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "condominio", enabled: true },
    uid(),
  );
  const types = Object.values(workTypes).map((id, i) => {
    const t = motorWorkType();
    t.id = id;
    t.number_prefix = ["OC", "ENC", "VIS"][i];
    t.fields.push({
      id: "unidade",
      label: "Unidade",
      help: "",
      kind: "text",
      max_length: 120,
      multiline: false,
      required: true,
      sensitive: false,
      client_visible: true,
    });
    return t;
  });
  await configure(f, {
    os_work_types: types,
    settings_revision: await settingsRevision(env, f.profile),
  });
  const c = await receive(f, f.line, "Olá", "5511960010203");
  await drain(f);
  // Chamadas diretas são determinísticas: os testes disparam o lote de envio.
  const ctx = {
    ...modulesApi(env, f.profile, "condominio"),
    wake: async () => {},
  };
  const create = (action: string, data: any, key = uid()) =>
    cadastro(ctx, f.admin, action, data, key);
  const block = (await create("block", { name: "Bloco A" })).id;
  const unit = (
    await create("unit", {
      block_id: block,
      number: "101",
      fraction_ppb: 600000000,
    })
  ).id;
  const unit2 = (
    await create("unit", {
      block_id: block,
      number: "102",
      fraction_ppb: 400000000,
    })
  ).id;
  const person = (await create("person", { name: "Ana" })).id;
  const membership = (
    await create("membership", {
      person_id: person,
      unit_id: unit,
      role: "proprietario",
      starts_at: now() - 10000,
      notices: true,
    })
  ).id;
  const phone = (
    await create("phone", {
      person_id: person,
      conversation_id: c.id,
      confirmed: true,
    })
  ).id;
  const accessId = uid();
  await exec(
    env,
    "INSERT INTO cond_access(profile_id,id,conversation_id,phone,person_id,expires_at) VALUES(?,?,?,?,?,?)",
    f.profile,
    accessId,
    c.id,
    "5511960010203",
    person,
    now() + 3600000,
  );
  const credentialId = uid();
  const customer: Actor = {
    id: `cred:${credentialId}`,
    kind: "app",
    name: "Morador",
    role: "service",
    profiles: [f.profile],
    scopes: [],
    bots: [],
    rate: 100,
    runLimit: 0,
    credential: { id: credentialId, module: "condominio", subject: accessId },
  };
  return {
    ...f,
    ctx,
    c,
    create,
    block,
    unit,
    unit2,
    person,
    membership,
    phone,
    accessId,
    customer,
  };
}
export async function residentToken(
  f: Awaited<ReturnType<typeof condFixture>>,
) {
  const token = CREDENTIAL_PREFIX + uid() + uid();
  await exec(
    env,
    `INSERT INTO module_credentials(id,profile_id,module_id,subject,status,claim_hash,claim_expires,ttl_minutes,expires,created_by,created,token_hash)
    VALUES(?,?,'condominio',?,'active',?,?,60,?,?,?,?)`,
    f.customer.credential!.id,
    f.profile,
    f.accessId,
    await sha(uid()),
    now() + 60000,
    now() + 3600000,
    f.admin.id,
    now(),
    await sha(token),
  );
  return token;
}
