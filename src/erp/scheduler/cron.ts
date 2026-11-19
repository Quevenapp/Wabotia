// Renova a autorização em cada cron de cinco minutos, inclusive desligamentos pendentes.
import { all } from "../../db";
import type { Env } from "../../types";
import { deliverErpParts, readErpPartsState } from "../../modules/erp/parts-state";
import type { ErpPartsSnapshot } from "../parts.ts";

/** Mantido para consumidores antigos: todo disparo do cron renova. */
export const isErpCronSlot = (_scheduledTime: number) => true;

/** Revisão pendente inclui a área cuja última linha de módulo foi excluída. */
export async function erpAreas(env: Env): Promise<ErpPartsSnapshot[]> {
  const rows = await all(env, `SELECT profile_id FROM profile_erp_revision
    WHERE revision>delivered_revision OR profile_id IN
      (SELECT profile_id FROM profile_modules WHERE module_id='erp' AND enabled=1)`);
  const areas: ErpPartsSnapshot[] = [];
  for (const row of rows) {
    // Leitura consistente e fresca por área; erro de uma não impede as demais.
    try { areas.push((await readErpPartsState(env, String(row.profile_id))).snapshot); } catch { /* Próximo cron tenta de novo. */ }
  }
  return areas;
}

/** A entrega reconcilia o alarme no objeto; falhas de entrega/ACK ficam pendentes no D1. */
export async function wakeErpAreas(env: Env, _scheduledTime: number): Promise<number> {
  const areas = await erpAreas(env);
  await Promise.allSettled(areas.map(snapshot => deliverErpParts(env, snapshot)));
  return areas.length;
}
