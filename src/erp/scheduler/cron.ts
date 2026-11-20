// Renova a autorização em cada cron de cinco minutos, inclusive desligamentos pendentes.
import { all, exec } from "../../db";
import type { Env } from "../../types";
import { deliverErpParts, readErpPartsState } from "../../modules/erp/parts-state";
import type { ErpPartsSnapshot } from "../parts.ts";

/** Mantido para consumidores antigos: todo disparo do cron renova. */
export const isErpCronSlot = (_scheduledTime: number) => true;

export const ERP_CRON_MAX_AREAS = 100;
export const ERP_CRON_CONCURRENCY = 4;
export const ERP_CRON_BUDGET_MS = 45_000;
const ATTEMPT_PREFIX = "erp_parts_attempt:";
/**
 * Continuação durável: com mais áreas que um lote, as restantes da mesma
 * janela seguem em invocações próprias (alarme da instância "erp-cron" do
 * Coordinator, sem classe nova), um lote de no máximo ERP_CRON_MAX_AREAS por
 * invocação, até todas terem sido tentadas depois do início da janela.
 */
export const ERP_CRON_INSTANCE = "erp-cron";

/**
 * No máximo 1 + 3N instruções (seleção, tentativa, leitura e ACK), ou
 * 2 + 4N contando a repetição única de SELECT do helper D1: até 402.
 * Deixa orçamento para o restante de scheduled. A ordem durável inclui
 * tentativas com erro, para que uma área defeituosa não monopolize o lote.
 */
async function pendingAreas(env: Env, before: number | null = null) {
  // `before`: só as ainda não tentadas desde o início da janela (continuação).
  return all<{ profile_id: string }>(env, `SELECT r.profile_id FROM profile_erp_revision r
    LEFT JOIN instance_settings s ON s.key=?||r.profile_id
    WHERE (r.revision>r.delivered_revision OR r.profile_id IN
      (SELECT profile_id FROM profile_modules WHERE module_id='erp' AND enabled=1))
      AND (? IS NULL OR COALESCE(s.updated,0)<?)
    ORDER BY COALESCE(s.updated,0),r.profile_id LIMIT ?`, ATTEMPT_PREFIX, before, before, ERP_CRON_MAX_AREAS);
}

/** Compatibilidade de inspeção; a passagem de produção entrega sem coletar fotografias. */
export async function erpAreas(env: Env): Promise<ErpPartsSnapshot[]> {
  const rows = await pendingAreas(env);
  const areas: ErpPartsSnapshot[] = [];
  for (const row of rows) {
    // Leitura consistente e fresca por área; erro de uma não impede as demais.
    try { areas.push((await readErpPartsState(env, String(row.profile_id))).snapshot); } catch { /* Próximo cron tenta de novo. */ }
  }
  return areas;
}

/** A entrega reconcilia o alarme no objeto; falhas de entrega/ACK ficam pendentes no D1. */
export async function wakeErpAreas(env: Env, _scheduledTime: number): Promise<number> {
  const windowStart = Date.now();
  const { attempted, full } = await deliverBatch(env, null);
  // Lote cheio: pode haver mais áreas nesta janela. A continuação roda em
  // outra invocação, logo, dentro da validade da fotografia.
  if (full) await requestErpCronContinuation(env, windowStart);
  return attempted;
}

/** Uma invocação da continuação: o próximo lote de áreas ainda não tentadas na janela. */
export async function continueErpAreas(env: Env, windowStart: number): Promise<{ attempted: number; more: boolean }> {
  const { attempted, full } = await deliverBatch(env, windowStart);
  return { attempted, more: full };
}

/** Pede a continuação à instância dedicada. O corpo vazio e a janela na URL. */
export async function requestErpCronContinuation(env: Env, windowStart: number): Promise<boolean> {
  try {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(ERP_CRON_INSTANCE), { locationHint: "sam" });
    const response = await stub.fetch(`https://coordinator/erp-cron-continue?window=${windowStart}`, { method: "POST" });
    return response.ok;
  } catch { return false; } // O próximo cron recomeça pelas áreas mais antigas.
}

async function deliverBatch(env: Env, before: number | null): Promise<{ attempted: number; full: boolean }> {
  const controller = new AbortController();
  const { signal } = controller;
  let attempted = 0, full = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, ERP_CRON_BUDGET_MS);
  });
  const run = async () => {
    const rows = await pendingAreas(env, before);
    full = rows.length >= ERP_CRON_MAX_AREAS;
    let index = 0;
    const worker = async () => {
      while (!signal.aborted && index < rows.length) {
        const profile = rows[index++].profile_id;
        try {
          // Avança somente quem começou. A próxima passagem retoma quem
          // ficou de fora, inclusive se este Worker cair antes da entrega.
          await exec(env, `INSERT INTO instance_settings(key,value,updated) VALUES(?,?,?)
            ON CONFLICT(key) DO UPDATE SET updated=MAX(instance_settings.updated+1,excluded.updated)`,
          ATTEMPT_PREFIX + profile, profile, Date.now());
          if (signal.aborted) return;
          const { snapshot } = await readErpPartsState(env, profile);
          if (signal.aborted) return;
          attempted++;
          await deliverErpParts(env, snapshot, signal);
        } catch { /* Uma leitura/tentativa com erro não segura as demais. */ }
      }
    };
    await Promise.allSettled(Array.from({ length: ERP_CRON_CONCURRENCY }, worker));
  };
  try {
    // D1 não oferece cancelamento. Uma operação que terminar após o prazo
    // não inicia outra: no máximo quatro ficam em voo, sem iniciar entregas
    // depois do prazo. Uma chamada já enviada pode ter sido aplicada no objeto.
    await Promise.race([run(), deadline]);
    // Prazo encerrado no meio do lote: as que ficaram de fora seguem na continuação.
    return { attempted, full: full || signal.aborted };
  } finally { clearTimeout(timer!); }
}
