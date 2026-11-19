// Liga ou desliga um módulo da área direto no D1 (testes do ERP).
import { env } from "cloudflare:test";
import { exec } from "../src/db";
import { now } from "../src/types";

export async function setModule(profile: string, id: string, enabled: boolean, by: string) {
  await exec(
    env,
    "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
    profile,
    id,
    enabled ? 1 : 0,
    now(),
    by,
  );
}

/** Preparação equivalente à migração 0133 para testes do antigo núcleo completo. */
export const ERP_CORE_TEST_MODULES: Readonly<Record<string, boolean>> = Object.freeze({
  erp: true, "erp-produtos": true, "erp-vendas": true,
  "erp-compras": true, "erp-estoque": true, "erp-financeiro": true,
});
export async function enableErpParts(profile: string, by: string) {
  for (const id of Object.keys(ERP_CORE_TEST_MODULES))
    await setModule(profile, id, true, by);
}
