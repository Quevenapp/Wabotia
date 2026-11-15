import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation } from "../src/service";
import { now } from "../src/types";
import { modulesApi, onWebStepValidate } from "../src/modules/api";
import { drain, fixture, receive } from "./service-center-fixture";

// O gancho vale para o processo todo: só age nas áreas marcadas aqui.
const refuse = new Map<string, string | "throw">();
onWebStepValidate("forms", async (ctx) => {
  const rule = refuse.get(ctx.profile);
  if (rule === "throw") throw new Error("falha do módulo");
  return rule || null;
});

async function setup() {
  const f = await fixture();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://x.example.com',?)",
    now(),
  );
  const r = await receive(f, f.line, "oi", "5511990007777");
  await drain(f);
  const c = await conversation(env, r.id, f.profile);
  const opened = await modulesApi(env, f.profile, "forms").openWebStep(c, {
    kind: "form",
    ref: "inscricao",
    trigger: "module",
    actor: "system",
    sourceKey: "inscricao-1",
    spec: {
      title: "Inscrição",
      fields: [{ id: "nome", type: "text", label: "Nome", required: true }],
    },
  });
  const url = opened.url!.replace("https://x.example.com", "https://test");
  return { f, url, step: opened.step };
}
const submit = (url: string) =>
  SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "f_nome=Ana",
  });
const status = async (id: string) =>
  (await one(env, "SELECT status FROM web_steps WHERE id=?", id)).status;

describe("onWebStepValidate: o módulo recusa antes de concluir", () => {
  it("mostra o motivo na página e deixa o link aberto; depois conclui", async () => {
    const { f, url, step } = await setup();
    refuse.set(f.profile, "As inscrições fecharam às 18h.");
    const refused = await submit(url);
    expect(refused.status).toBe(409);
    const page = await refused.text();
    expect(page).toContain("As inscrições fecharam às 18h.");
    expect(page).toContain('value="Ana"');
    expect(await status(step.id)).not.toBe("completed");

    refuse.delete(f.profile);
    const done = await submit(url);
    expect(done.status).toBe(200);
    expect(await status(step.id)).toBe("completed");
  });

  it("erro no gancho recusa com aviso genérico, sem concluir", async () => {
    const { f, url, step } = await setup();
    refuse.set(f.profile, "throw");
    const refused = await submit(url);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(
      "Não foi possível concluir agora. Tente de novo em instantes.",
    );
    expect(await status(step.id)).not.toBe("completed");
  });
});
