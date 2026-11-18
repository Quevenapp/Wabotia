// F0 — fixture comum CONGELADA. Filhas estendem localmente, sem editar este arquivo.
import { env } from "cloudflare:test";
import { modulesApi } from "../src/modules/api";
import { perform } from "../src/service";
import { uid } from "../src/types";
import type { CustomWorkType } from "../src/modules/os/contracts";
import { bearer, fixture } from "./service-center-fixture";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const MOTOR_SENTINEL = "F0_SIGILO_EXCLUSIVO_4c81f65d";
export const MOTOR_WORK_TYPE: CustomWorkType = freeze({
  schema_version: 1,
  kind: "custom",
  id: "projeto",
  revision: 1,
  archived: false,
  labels: {
    singular: "Projeto",
    plural: "Projetos",
    item: "Objeto",
    problem: "Escopo",
    customer_singular: "Cliente",
    customer_plural: "Clientes",
  },
  number_prefix: "PROJ",
  terms: null,
  fields: [
    {
      id: "referencia",
      label: "Referência",
      help: "",
      required: false,
      client_visible: true,
      sensitive: false,
      kind: "text",
      multiline: false,
      max_length: 80,
    },
    {
      id: "segredo",
      label: "Restrito",
      help: "",
      required: false,
      client_visible: false,
      sensitive: true,
      kind: "text",
      multiline: true,
      max_length: 200,
    },
  ],
  retired_field_ids: [],
  retired_stage_ids: [],
  initial_stage: "entrada",
  stages: [
    { id: "entrada", label: "Entrada", base_status: "received", message: "" },
    {
      id: "execucao",
      label: "Execução",
      base_status: "in_progress",
      message: "",
    },
    {
      id: "revisao",
      label: "Revisão",
      base_status: "in_progress",
      message: "",
    },
    {
      id: "entregue",
      label: "Entregue",
      base_status: "delivered",
      message: "",
    },
    {
      id: "cancelado",
      label: "Cancelado",
      base_status: "cancelled",
      message: "",
    },
  ],
  transitions: [
    {
      id: "iniciar",
      from: "entrada",
      to: "execucao",
      label: "Iniciar",
      kind: "manual",
    },
    {
      id: "revisar",
      from: "execucao",
      to: "revisao",
      label: "Revisar",
      kind: "manual",
    },
    {
      id: "entregar",
      from: "revisao",
      to: "entregue",
      label: "Entregar",
      kind: "manual",
    },
    {
      id: "cancelar_entrada",
      from: "entrada",
      to: "cancelado",
      label: "Cancelar",
      kind: "manual",
    },
    {
      id: "cancelar_execucao",
      from: "execucao",
      to: "cancelado",
      label: "Cancelar",
      kind: "manual",
    },
    {
      id: "cancelar_revisao",
      from: "revisao",
      to: "cancelado",
      label: "Cancelar",
      kind: "manual",
    },
  ],
  features: {
    customer_open: true,
    tasks: true,
    people: true,
    documents: true,
    entries: true,
    quote: null,
    warranty_days: 0,
    pickup_reminder_days: 0,
    stale_days: 0,
  },
  pickup_reminder_text: "",
});
/** Cópia editável para cenários locais; nunca alterar MOTOR_WORK_TYPE. */
export const motorWorkType = (): CustomWorkType =>
  structuredClone(MOTOR_WORK_TYPE);

export async function motorFixture(options: { enabled?: boolean } = {}) {
  const f = await fixture();
  if (options.enabled !== false)
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: true },
      uid(),
    );
  return {
    ...f,
    ctx: modulesApi(env, f.profile, "os"),
    token: await bearer(f.member),
    adminToken: await bearer(f.admin),
  };
}
export type MotorFixture = Awaited<ReturnType<typeof motorFixture>>;
/** Criação legada, sem mensagens/efeitos de canal; custom depende de M. */
export function motorOrder(
  f: MotorFixture,
  data: Record<string, unknown> = {},
) {
  return perform(
    env,
    f.member,
    f.profile,
    "os.create",
    {
      phone: "5511960010203",
      item: "Equipamento",
      problem: "Conferir funcionamento",
      notify: false,
      ...data,
    },
    uid(),
  );
}
