import { one } from "./db";
import { ApiError, type Env, json } from "./types";
import {
  numberPolicy,
  deniedNumberCapability,
  type NumberPolicyFlag,
} from "./number-policy";

export async function getNumberPolicy(env: Env, connection: string | null) {
  const row =
    connection &&
    (await one(
      env,
      "SELECT c.config FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.id=?",
      connection,
    ));
  return numberPolicy(row ? json(row.config) : {});
}
export function numberPolicyError(flag: NumberPolicyFlag) {
  const labels: Record<NumberPolicyFlag, string> = {
    service: "mensagens de atendimento dentro da janela de 24 horas",
    templates: "envio de templates",
    human: "envio por atendentes no painel ou Telegram",
    api: "envio por programas externos",
    menu: "menus e respostas automáticas",
    bots: "atendimento por bots",
    pool: "participação no roteamento por grupos",
  };
  return new ApiError(
    403,
    "number_policy_denied",
    `Este número não permite ${labels[flag]}. Confira Função e permissões no Roteador de números.`,
  );
}
export async function assertNumberDelivery(
  env: Env,
  connection: string | null,
  actor: string,
  kind: string,
  payload: any,
) {
  if (!connection || kind === "team") return;
  const denied = deniedNumberCapability(
    await getNumberPolicy(env, connection),
    actor,
    kind,
    payload,
  );
  if (denied) throw numberPolicyError(denied);
}
