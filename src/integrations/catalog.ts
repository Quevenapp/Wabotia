import { batch, one } from "../db";
import type { Actor, Env } from "../types";
import type { SourceRef, Statement } from "./contracts";
import { humanReferenceRpc, requireIntegrationHuman } from "./policy";
import { integer, IntegrationError, opaque } from "./privacy";
import { integrationCasGuard } from "./outbox";
import { readErpPartsState } from "../modules/erp/parts-state";
import { hash, canonical } from "./keys";

export async function catalogLink(env: Env, source: SourceRef, kind: string, record: string, component = ""): Promise<string | null> {
  if (!(await readErpPartsState(env, source.profile)).snapshot.parts.products) return null;
  const link = await one(env, "SELECT erp_item_id FROM module_erp_catalog_links WHERE profile_id=? AND module_id=? AND record_kind=? AND record_id=? AND component=?", source.profile, source.module, kind, record, component);
  return link?.erp_item_id ?? null;
}
export async function saveCatalogLink(env: Env, actor: Actor, source: SourceRef, kind: string, record: string, component: string, product: string | null, version: number, command: string) {
  requireIntegrationHuman(actor, source.profile); integer(version); opaque(kind); opaque(record);
  const scope = `f3-catalog:${source.profile}:${actor.id}`, fingerprint = hash([source.module, kind, record, component, product, version]);
  const old = await one(env, "SELECT fingerprint,response FROM receipts WHERE scope=? AND key=?", scope, command);
  if (old) { if (old.fingerprint !== fingerprint) throw new IntegrationError("idempotency_conflict", 409); return JSON.parse(old.response); }
  if (!(await readErpPartsState(env, source.profile)).snapshot.parts.products) throw new IntegrationError("part_disabled", 409);
  if (product) {
    opaque(product);
    const response = await humanReferenceRpc(env, actor, source.profile, "erp_catalog_product_get", { p_id: product });
    const item = response.record ?? response;
    if (item.id !== product || item.active !== true) throw new IntegrationError("default_inactive");
  }
  const key = [source.profile, source.module, kind, record, component];
  const result = { erp_item_id: product, version: product ? version + 1 : 0 };
  const statements: Statement[] = [
    product ? version === 0
      ? ["INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,?,?,?,?,?,?,?)", [...key, product, Date.now(), actor.id]]
      : ["UPDATE module_erp_catalog_links SET erp_item_id=?,version=version+1,updated_ms=?,updated_by=? WHERE profile_id=? AND module_id=? AND record_kind=? AND record_id=? AND component=? AND version=?", [product, Date.now(), actor.id, ...key, version]]
      : ["DELETE FROM module_erp_catalog_links WHERE profile_id=? AND module_id=? AND record_kind=? AND record_id=? AND component=? AND version=?", [...key, version]],
    integrationCasGuard,
    ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [scope, command, fingerprint, canonical(result), Date.now()]],
  ];
  if (source.module === "os") {
    if (kind !== "quote_item") throw new IntegrationError("invalid_request", 400);
    const { modulesApi } = await import("../modules/api");
    const { commitWorkCatalogLink } = await import("../modules/os/commercial/routes");
    await commitWorkCatalogLink(modulesApi(env, source.profile, "os"), actor, record, component, product, statements);
  } else await batch(env, statements);
  return result;
}
