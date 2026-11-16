import { env } from "cloudflare:test";
import { setSecret } from "../../../src/security";
import { type Actor, uid } from "../../../src/types";
import type { FiscalContext } from "../../../src/erp/emissor/provider.ts";
import { createFakeVault, type FakeVaultOptions } from "./fake-vault";

export const VAULT_URL = "https://nfapi-cofre.exemplo.workers.dev";

export function actor(role: Actor["role"] = "admin", profiles: string[] = []): Actor {
  return { id: uid(), kind: "user", name: "Pessoa", role, profiles, scopes: [], bots: [], rate: 300, runLimit: 10 };
}

/** Área nova com o emissor apontando para um cofre simulado. */
export async function vaultArea(options: FakeVaultOptions = {}) {
  const vault = createFakeVault(options);
  const profile = uid();
  await setSecret(env, `erp-emissor:${profile}`, {
    provider: "nfapi",
    url: VAULT_URL,
    api_key: vault.apiKey,
    updated: Date.now(),
    updated_by: "teste",
    checked: null,
  });
  const ctx: FiscalContext = { env, profile, fetch: vault.fetch };
  return { vault, profile, ctx };
}

/** Exemplo de pedido do contrato sem a referência (o ERP define). */
export function example<T = any>(value: T): T {
  const copy: any = structuredClone(value);
  delete copy.referencia;
  return copy;
}
