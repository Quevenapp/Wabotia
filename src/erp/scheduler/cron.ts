// Rede de segurança do agendador do ERP no cron do Worker (docs/ERP-AGENDADOR.md).
// O alarme do objeto erp:<área> se reagenda sozinho; o cron só acorda, de
// hora em hora, as áreas com o ERP ligado (objeto novo, alarme perdido depois
// das repetições do runtime). Área com o ERP desligado: nada acorda.
//
// A aplica no scheduled do src/index.ts:
//   ctx.waitUntil(wakeErpAreas(env, event.scheduledTime));
import { all } from "../../db";
import { resolveStates } from "../../modules/registry";
import type { Env } from "../../types";
import { erpFetch } from "../hub";

export const ERP_OPTIONAL_BLOCKS = ["erp-fiscal", "erp-cobranca", "erp-pdv"] as const;
const ERP_MODULES = ["erp", ...ERP_OPTIONAL_BLOCKS];

/** Só no primeiro disparo da hora (cron a cada 5 min: minuto 0 a 4). */
export const isErpCronSlot = (scheduledTime: number) => new Date(scheduledTime).getUTCMinutes() < 5;

/** Áreas com o ERP ligado e os blocos de cada uma (estados resolvidos, com as dependências). */
export async function erpAreas(env: Env): Promise<{ profile: string; blocks: Record<string, boolean> }[]> {
  const rows = await all(
    env,
    "SELECT profile_id,module_id,enabled FROM profile_modules WHERE module_id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ERP_MODULES),
  );
  const saved = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const id = String(r.profile_id);
    saved.set(id, { ...(saved.get(id) ?? {}), [String(r.module_id)]: r.enabled });
  }
  const areas: { profile: string; blocks: Record<string, boolean> }[] = [];
  for (const [profile, states] of saved) {
    const resolved = resolveStates(states);
    if (!resolved.erp) continue;
    areas.push({ profile, blocks: Object.fromEntries(ERP_OPTIONAL_BLOCKS.map((b) => [b, !!resolved[b]])) });
  }
  return areas;
}

/** Acorda o alarme do ERP de cada área ligada; devolve quantas. Erro de uma área não para as outras. */
export async function wakeErpAreas(env: Env, scheduledTime: number): Promise<number> {
  if (!isErpCronSlot(scheduledTime)) return 0;
  const areas = await erpAreas(env);
  await Promise.allSettled(
    areas.map(({ profile, blocks }) =>
      erpFetch(env, profile, "/erp-wake", { method: "POST", body: JSON.stringify({ blocks }) }).then((r) => r.body?.cancel()),
    ),
  );
  return areas.length;
}
