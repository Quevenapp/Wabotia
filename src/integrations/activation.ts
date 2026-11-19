import { all } from "../db";
import type { Env } from "../types";
import { ERP_PARTS_STATE_SQL, erpPartsStateOf } from "../modules/erp/parts-state";
import type { IntegrationEvent, IntegrationModule, Statement } from "./contracts";
import { integer, IntegrationError } from "./privacy";

export function activationStatements(profile: string, changes: readonly { module_id: string; enabled: boolean }[], occurred_ms: number): Statement[] {
  integer(occurred_ms);
  return changes.map(({ module_id, enabled }) => [
    `INSERT INTO module_erp_activation(profile_id,module_id,epoch,enabled,first_enabled_ms,enabled_since_ms,updated_ms)
     VALUES(?,?,1,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET
     epoch=module_erp_activation.epoch+1, enabled=excluded.enabled,
     first_enabled_ms=COALESCE(module_erp_activation.first_enabled_ms,excluded.first_enabled_ms),
     enabled_since_ms=excluded.enabled_since_ms, updated_ms=excluded.updated_ms
     WHERE module_erp_activation.enabled<>excluded.enabled`,
    [profile, module_id, enabled ? 1 : 0, enabled ? occurred_ms : null, enabled ? occurred_ms : null, occurred_ms],
  ]);
}
export interface Activation { module_id: string; epoch: number; enabled: number; first_enabled_ms: number | null; enabled_since_ms: number | null; updated_ms: number }
/** Inicialização e leitura no mesmo lote; uma mudança concorrente desfaz o corte. */
export async function readIntegrationActivation(env: Env, profile: string, module: IntegrationModule) {
  const ids = [module, "erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"];
  const at = Date.now();
  // Cortes já inicializados e partes/revisão vêm da mesma fotografia SQL.
  // Não reescreve seis linhas a cada fato e não usa cache entre mutações.
  const rows = await all(env, `SELECT p.*,(SELECT json_group_array(json_object(
    'module_id',module_id,'epoch',epoch,'enabled',enabled,'first_enabled_ms',first_enabled_ms,
    'enabled_since_ms',enabled_since_ms,'updated_ms',updated_ms)) FROM module_erp_activation
    WHERE profile_id=? AND module_id IN (${ids.map(() => "?").join(",")})) activations_json
    FROM (${ERP_PARTS_STATE_SQL}) p`, profile, ...ids, profile).catch(() => { throw new IntegrationError("erp_parts_unavailable", 503); });
  const current = erpPartsStateOf(profile, rows, at);
  const existing = JSON.parse(rows[0]?.activations_json ?? "[]") as Activation[];
  const result = (values: Activation[]) => ({ ...current,
    activations: Object.fromEntries(values.map(r => [r.module_id, { ...r }])), epochs: Object.fromEntries(values.map(r => [r.module_id, r.epoch])) });
  if (existing.length === ids.length) return result(existing);
  const statements: Statement[] = [[
    `INSERT INTO module_erp_activation(profile_id,module_id,epoch,enabled,first_enabled_ms,enabled_since_ms,updated_ms)
     SELECT ?,value ->> '$.id',1,
       CASE WHEN COALESCE((SELECT CAST(revision AS TEXT) FROM profile_erp_revision WHERE profile_id=?),'0')=?
         AND COALESCE((SELECT enabled FROM profile_modules WHERE profile_id=? AND module_id=?),?)=?
       THEN value ->> '$.enabled' ELSE json('integration_activation_changed') END,
       value ->> '$.since',value ->> '$.since',?
     FROM json_each(?) WHERE 1
     ON CONFLICT(profile_id,module_id) DO UPDATE SET module_id=excluded.module_id
     RETURNING module_id,epoch,enabled,first_enabled_ms,enabled_since_ms,updated_ms`,
    [profile, profile, current.snapshot.revision, profile, module, current.states[module] ? 1 : 0, current.states[module] ? 1 : 0, at,
      JSON.stringify(ids.map(id => ({ id, enabled: current.states[id] ? 1 : 0, since: current.states[id] ? at : null })))],
  ]];
  try {
    // Só module_erp_activation muda; profiles/profile_modules são lidos.
    const results = await env.DB.batch(statements.map(([sql, args]) => env.DB.prepare(sql).bind(...args)));
    const rows = results.at(-1)!.results as unknown as Activation[];
    // Retorna também os cortes que outra chamada inicializou desde a leitura,
    // sem alterar sua época ou os instantes já persistidos.
    return result(rows);
  } catch { throw new IntegrationError("erp_parts_unavailable", 503); }
}
export function eventEpochOpen(event: IntegrationEvent, activations: Record<string, Activation>, ids: readonly string[]): boolean {
  return [event.source.module, "erp", ...ids].every(id => {
    const a = activations[id];
    return a?.enabled === 1 && a.epoch === event.epochs[id] && a.enabled_since_ms !== null && event.occurred_ms >= a.enabled_since_ms;
  });
}
export function documentEpochOpen(event: IntegrationEvent, activations: Record<string, Activation>): boolean {
  return event.eligible.document && (eventEpochOpen(event, activations, ["erp-vendas"]) ||
    event.eligible.finance && eventEpochOpen(event, activations, ["erp-financeiro"]) ||
    event.eligible.stock && eventEpochOpen(event, activations, ["erp-produtos", "erp-estoque"]));
}
