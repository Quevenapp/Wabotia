import { env } from "cloudflare:test";
import { exec } from "../src/db";
import { modulesApi, onBinaryRead, onBinaryUpload, onCommand, onRoute } from "../src/modules/api";
import { modules, moduleById } from "../src/modules/registry";
import { saudeModule } from "../src/modules/saude/definition";
import { saudeExtension } from "../src/modules/saude/saude";
import { command } from "../src/modules/saude/store";
import { perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { motorFixture, motorOrder } from "./os-motor-fixture";

// Registro só no isolado de teste: os arquivos centrais de produção ficam intactos.
export function registerSaudeTest() {
  if (moduleById("saude")) return;
  (modules as typeof saudeModule[]).push(saudeModule);
  for (const item of saudeExtension.commands) onCommand("saude", item.op, item.handler);
  for (const item of saudeExtension.writes) onRoute("saude", item);
  for (const item of saudeExtension.binaryReads) onBinaryRead("saude", item.path, item.handler);
  for (const item of saudeExtension.binaryUploads) onBinaryUpload("saude", item.path, item.handler);
}
export const SECRET = "CLINICO_NUNCA_EM_CANAL_COMUM_25e6";
export async function saudeFixture() {
  registerSaudeTest();
  const f = await motorFixture();
  await perform(env, f.admin, f.profile, "module.set", { id: "saude", enabled: true }, uid());
  const clinician: Actor = { ...f.member, access: ["*", "os:sensitive", "saude:clinical_read", "saude:clinical_write", "saude:responsible"] };
  await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(clinician.access), clinician.id);
  const ctx = modulesApi(env, f.profile, "saude");
  const order = await motorOrder(f, { item: "Atendimento", problem: "Solicitação administrativa" });
  const patient = await command(ctx, clinician, "subject.create", { kind: "human", name: "Paciente teste" }, uid());
  const episode = await command(ctx, clinician, "episode.create", { subject_id: patient.id, order_id: order.id }, uid());
  const run = (op: string, data: Record<string, unknown> = {}, actor = clinician, key = uid()) =>
    command(ctx, actor, op, { subject_id: patient.id, ...data }, key);
  return { ...f, ctx, clinician, patient, episode, order, run };
}
export type SaudeFixture = Awaited<ReturnType<typeof saudeFixture>>;
