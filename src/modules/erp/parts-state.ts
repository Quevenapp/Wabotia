import { all, exec } from "../../db";
import { ApiError, type Env } from "../../types";
import { erpFetch } from "../../erp/hub.ts";
import { ERP_PART_KEYS, ERP_PART_MODULES, ERP_PARTS_TTL_MS, normalizeErpParts, readErpPartsSnapshot as validateSnapshot, type ErpPartsSnapshot } from "../../erp/parts.ts";
import { resolveStates, type ModuleStates } from "../registry";

export interface ErpSyncState { revision: string; delivered_revision: string; status: "pending" | "applied" }
export const erpSyncState = (revision: string, delivered_revision: string): ErpSyncState => ({
  revision, delivered_revision, status: revision === delivered_revision ? "applied" : "pending",
});
/** Um SELECT, sem cache: linhas e revisão pertencem à mesma fotografia D1. */
export const ERP_PARTS_STATE_SQL = `SELECT m.module_id,m.enabled,m.updated,m.updated_by,
  CAST(COALESCE(r.revision,0) AS TEXT) revision,
  CAST(COALESCE(r.delivered_revision,0) AS TEXT) delivered_revision
  FROM (SELECT ? profile_id) p
  LEFT JOIN profile_erp_revision r ON r.profile_id=p.profile_id
  LEFT JOIN profile_modules m ON m.profile_id=p.profile_id`;
/** Também decodifica a leitura consistente adiantada no lote de autenticação. */
export function erpPartsStateOf(profile: string, rows: any[], readAt: number) {
  const revision = String(rows[0]?.revision ?? "0");
  const delivered = String(rows[0]?.delivered_revision ?? "0");
  const states: ModuleStates = resolveStates(Object.fromEntries(rows.filter(r => r.module_id).map(r => [r.module_id, r.enabled])));
  if (revision === "0") for (const id of Object.values(ERP_PART_MODULES)) states[id] = false;
  const parts = normalizeErpParts(Object.fromEntries(ERP_PART_KEYS.map(key => [key, revision !== "0" && states[ERP_PART_MODULES[key]] === true])));
  const snapshot: ErpPartsSnapshot = Object.freeze({ profile, revision, expires_at: readAt + ERP_PARTS_TTL_MS, parts });
  return { rows, states, snapshot, erp_sync: erpSyncState(revision, delivered) };
}
export async function readErpPartsState(env: Env, profile: string) {
  const readAt = Date.now();
  const rows = await all(env, ERP_PARTS_STATE_SQL, profile).catch(() => {
    throw new ApiError(503, "erp_parts_unavailable", "Estado das partes indisponível.");
  });
  return erpPartsStateOf(profile, rows, readAt);
}
export const readErpPartsSnapshot = async (env: Env, profile: string): Promise<ErpPartsSnapshot> => (await readErpPartsState(env, profile)).snapshot;
/** ACK antigo só confirma a própria revisão; nunca a revisão corrente por acidente. */
export async function acknowledgeErpParts(env: Env, profile: string, revision: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) throw new Error("erp_parts_revision_invalid");
  await exec(env, `UPDATE profile_erp_revision SET delivered_revision=CAST(? AS INTEGER)
    WHERE profile_id=? AND delivered_revision<CAST(? AS INTEGER) AND revision>=CAST(? AS INTEGER)`, revision, profile, revision, revision);
}
export async function deliverErpParts(env: Env, snapshot: ErpPartsSnapshot): Promise<boolean> {
  try {
    const response = await erpFetch(env, snapshot.profile, "/erp-parts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot),
    });
    if (!response.ok) return false;
    const ack = await response.json<{ profile?: string; revision?: string }>();
    if (ack.profile !== snapshot.profile || ack.revision !== snapshot.revision) return false;
    await acknowledgeErpParts(env, snapshot.profile, snapshot.revision);
    return true;
  } catch { return false; } // A revisão D1 continua pendente, inclusive após perda do ACK.
}
export async function syncErpParts(env: Env, profile: string): Promise<ErpSyncState> {
  const { snapshot } = await readErpPartsState(env, profile);
  await deliverErpParts(env, snapshot);
  return (await readErpPartsState(env, profile)).erp_sync;
}
export async function erpPartsEnvelope(env: Env, profile: string, snapshot = undefined as ErpPartsSnapshot | undefined) {
  snapshot ??= await readErpPartsSnapshot(env, profile);
  if (!validateSnapshot(snapshot, profile)) throw new ApiError(503, "erp_parts_unavailable", "Estado das partes indisponível.");
  // O próprio RPC aplica a fotografia no KV antes de executar. A entrega
  // separada e seu ACK ficam nos comandos/modelos/cron, sem duas idas ao
  // objeto nem uma escrita D1 adicional em cada leitura autenticada.
  const { parts, ...partsControl } = snapshot;
  return { parts, partsControl };
}
