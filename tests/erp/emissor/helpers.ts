import { env } from "cloudflare:test";
import { setSecret } from "../../../src/security";
import { exec } from "../../../src/db";
import { type Actor, now, uid } from "../../../src/types";
import type { FiscalContext } from "../../../src/erp/emissor/provider.ts";
import { createFakeVault, type FakeVaultOptions } from "./fake-vault";

export const VAULT_URL = "https://nfapi-cofre.exemplo.workers.dev";

export function actor(role: Actor["role"] = "admin", profiles: string[] = []): Actor {
  return { id: uid(), kind: "user", name: "Pessoa", role, profiles, scopes: [], bots: [], rate: 300, runLimit: 10 };
}

/**
 * Ator gravado em users (D1), para as rotas que passam pelo ERP: o envelope
 * de identidade lê as pessoas da área de lá. `access`: lista de acessos
 * (ex.: ["erp:consulta"]); o administrador já vale erp:admin.
 */
export async function member(role: Actor["role"], profile: string, access: string[] | null = null): Promise<Actor> {
  const a = actor(role, [profile]);
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,?,?,?,?,?,?)",
    a.id,
    `${a.id}@example.test`,
    a.name,
    "test",
    role,
    JSON.stringify([profile]),
    access === null ? null : JSON.stringify(access),
    now(),
  );
  return { ...a, access };
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
