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
