// Frete: a configuração dos provedores de uma área e os ajustes do frete.
// - interruptor (desligado por padrão), sandbox/produção, opções não secretas
//   e o último teste: tabela erp_frete_providers (migração 0255);
// - credenciais digitadas na tela: um segredo do núcleo por provedor e área
//   (tabela secrets, AES-GCM com a MASTER_KEY, id erp-frete:<provedor>:<área>),
//   como o emissor fiscal e a Cobrança guardam as delas. Nunca voltam para a
//   tela, nunca vão para log nem para o backup do ERP;
// - aviso pelo WhatsApp (desligado por padrão) e CEP de origem: erp_frete_settings.
import { all, exec, one } from "../../db";
import { secret, setSecret } from "../../security";
import { ApiError, now, type Env } from "../../types";
import { FREIGHT_PROVIDERS, isFreightProvider, postalCode, type FreightConnection, type FreightProviderId } from "./provider.ts";
import { FREIGHT_PROVIDER_ADAPTERS } from "./providers.ts";

export const freightSecretId = (provider: FreightProviderId, profile: string) => `erp-frete:${provider}:${profile}`;

export interface ProviderRow {
  provider: FreightProviderId; enabled: boolean; sandbox: boolean; options: Record<string, string>;
  checked_at: number | null; check_ok: boolean | null; check_message: string | null; updated: number | null; updated_by: string | null;
}
const parseOptions = (v: unknown): Record<string, string> => {
  try {
    const o = typeof v === "string" ? JSON.parse(v) : {};
    return o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, x]) => typeof x === "string")) as Record<string, string> : {};
  } catch { return {}; }
};
const rowOf = (provider: FreightProviderId, r: any): ProviderRow => ({
  provider, enabled: Number(r?.enabled) === 1, sandbox: r ? Number(r.sandbox) === 1 : true, options: parseOptions(r?.options),
  checked_at: r?.checked_at ?? null, check_ok: r?.check_ok === null || r?.check_ok === undefined ? null : Number(r.check_ok) === 1,
  check_message: r?.check_message ?? null, updated: r?.updated ?? null, updated_by: r?.updated_by ?? null,
});

export async function providerRows(env: Env, profile: string): Promise<ProviderRow[]> {
  const rows = await all(env, "SELECT * FROM erp_frete_providers WHERE profile_id=?", profile);
  return FREIGHT_PROVIDERS.map((id) => rowOf(id, rows.find((r: any) => r.provider === id)));
}
export async function providerRow(env: Env, profile: string, provider: FreightProviderId) {
  return rowOf(provider, await one(env, "SELECT * FROM erp_frete_providers WHERE profile_id=? AND provider=?", profile, provider));
}

async function credentials(env: Env, profile: string, provider: FreightProviderId): Promise<Record<string, string>> {
  const value = await secret(env, freightSecretId(provider, profile)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => typeof v === "string" && v)) as Record<string, string>;
}

/** Conexão para o adaptador (com as credenciais). Só código do servidor usa. */
export async function freightConnection(env: Env, profile: string, provider: FreightProviderId): Promise<FreightConnection> {
  const row = await providerRow(env, profile, provider);
  return { sandbox: row.sandbox, credentials: await credentials(env, profile, provider), options: row.options };
}

/** Os provedores na tela: ligado, modo, opções, quais credenciais já estão no cofre (sem o valor) e o último teste. */
export async function providersView(env: Env, profile: string) {
  const rows = await providerRows(env, profile);
  const settings = await freightSettings(env, profile);
  return {
    scope: "freight_providers",
    providers: await Promise.all(rows.map(async (r) => {
      const adapter = FREIGHT_PROVIDER_ADAPTERS[r.provider];
      const saved = await credentials(env, profile, r.provider);
      return {
        id: r.provider, name: adapter.name, enabled: r.enabled, sandbox: r.sandbox, sandbox_available: adapter.sandbox, options: r.options,
        secret_fields: adapter.secretFields.map((f) => ({ ...f, saved: !!saved[f.key] })), option_fields: adapter.optionFields,
        ready: adapter.secretFields.every((f) => !!saved[f.key]),
        check: r.checked_at ? { at: r.checked_at, ok: r.check_ok, message: r.check_message } : null, updated: r.updated,
      };
    })),
    settings,
  };
}

const text = (v: unknown, name: string, max: number) => {
  if (typeof v !== "string") throw new ApiError(400, "invalid_request", `${name}: use texto.`);
  const t = v.trim();
  if (t.length > max || /[\u0000-\u001f\u007f]/.test(t)) throw new ApiError(400, "invalid_request", `${name}: até ${max} caracteres, sem quebra de linha.`);
  return t;
};

/**
 * Grava o provedor: interruptor, modo, opções e as credenciais digitadas.
 * Credencial vazia mantém a guardada; null apaga. Ligar exige todas as
 * credenciais no cofre e as opções obrigatórias.
 */
export async function saveProvider(env: Env, profile: string, actor: string, provider: unknown, input: Record<string, unknown>) {
  if (!isFreightProvider(provider)) throw new ApiError(404, "not_found", "Provedor de frete desconhecido. Use correios ou melhorenvio.");
  const adapter = FREIGHT_PROVIDER_ADAPTERS[provider];
  const current = await providerRow(env, profile, provider);
  for (const key of ["ligado", "sandbox"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new ApiError(400, "invalid_request", `${key}: use verdadeiro ou falso.`);
  const sentCredentials = input.credenciais ?? {}, sentOptions = input.opcoes ?? {};
  if (!sentCredentials || typeof sentCredentials !== "object" || Array.isArray(sentCredentials)) throw new ApiError(400, "invalid_request", "credenciais: use um objeto.");
  if (!sentOptions || typeof sentOptions !== "object" || Array.isArray(sentOptions)) throw new ApiError(400, "invalid_request", "opcoes: use um objeto.");
  const secretKeys = adapter.secretFields.map((f) => f.key), optionKeys = adapter.optionFields.map((f) => f.key);
  for (const key of Object.keys(sentCredentials)) if (!secretKeys.includes(key)) throw new ApiError(400, "invalid_request", `credenciais: use só ${secretKeys.join(", ")}.`);
  for (const key of Object.keys(sentOptions)) if (!optionKeys.includes(key)) throw new ApiError(400, "invalid_request", `opcoes: use só ${optionKeys.join(", ")}.`);
  const saved = await credentials(env, profile, provider);
  const next = { ...saved };
  let changedSecret = false;
  for (const [key, value] of Object.entries(sentCredentials as Record<string, unknown>)) {
    if (value === null) { delete next[key]; changedSecret = true; continue; }
    const v = text(value, key, 500);
    if (v) { next[key] = v; changedSecret = true; }
  }
  const options = { ...current.options };
  for (const [key, value] of Object.entries(sentOptions as Record<string, unknown>)) {
    if (value === null || value === "") delete options[key];
    else options[key] = text(value, key, 300);
  }
  const enabled = typeof input.ligado === "boolean" ? input.ligado : current.enabled;
  const sandbox = typeof input.sandbox === "boolean" ? input.sandbox && adapter.sandbox : current.sandbox;
  if (enabled) {
    const missing = adapter.secretFields.filter((f) => !next[f.key]).map((f) => f.label);
    const optionMissing = adapter.optionFields.filter((f) => f.required && !options[f.key]).map((f) => f.label);
    if (missing.length || optionMissing.length)
      throw new ApiError(400, "freight_provider_incomplete", `Para ligar ${adapter.name}, preencha: ${[...missing, ...optionMissing].join(", ")}.`);
  }
  if (changedSecret) await setSecret(env, freightSecretId(provider, profile), next);
  // Credencial ou modo novo: o teste anterior não vale mais.
  const stale = changedSecret || sandbox !== current.sandbox;
  await exec(env, `INSERT INTO erp_frete_providers(profile_id,provider,enabled,sandbox,options,checked_at,check_ok,check_message,updated,updated_by)
    VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?)
    ON CONFLICT(profile_id,provider) DO UPDATE SET enabled=excluded.enabled, sandbox=excluded.sandbox, options=excluded.options,
      checked_at=CASE WHEN ? THEN NULL ELSE erp_frete_providers.checked_at END, check_ok=CASE WHEN ? THEN NULL ELSE erp_frete_providers.check_ok END,
      check_message=CASE WHEN ? THEN NULL ELSE erp_frete_providers.check_message END, updated=excluded.updated, updated_by=excluded.updated_by`,
  profile, provider, enabled ? 1 : 0, sandbox ? 1 : 0, JSON.stringify(options), now(), actor, stale ? 1 : 0, stale ? 1 : 0, stale ? 1 : 0);
  return providersView(env, profile);
}

export async function recordCheck(env: Env, profile: string, provider: FreightProviderId, ok: boolean, message: string) {
  await exec(env, `INSERT INTO erp_frete_providers(profile_id,provider,enabled,sandbox,options,checked_at,check_ok,check_message,updated,updated_by)
    VALUES(?,?,0,1,'{}',?,?,?,?,'sistema')
    ON CONFLICT(profile_id,provider) DO UPDATE SET checked_at=excluded.checked_at, check_ok=excluded.check_ok, check_message=excluded.check_message`,
  profile, provider, now(), ok ? 1 : 0, message.slice(0, 300), now());
}

export interface FreightSettings { notify_whatsapp: boolean; origin_postal_code: string | null; updated: number | null }
export async function freightSettings(env: Env, profile: string): Promise<FreightSettings> {
  const r = await one(env, "SELECT * FROM erp_frete_settings WHERE profile_id=?", profile);
  return { notify_whatsapp: Number(r?.notify_whatsapp) === 1, origin_postal_code: r?.origin_postal_code ?? null, updated: r?.updated ?? null };
}
export async function saveSettings(env: Env, profile: string, actor: string, input: Record<string, unknown>) {
  const current = await freightSettings(env, profile);
  if (input.avisar_whatsapp !== undefined && typeof input.avisar_whatsapp !== "boolean") throw new ApiError(400, "invalid_request", "avisar_whatsapp: use verdadeiro ou falso.");
  let origin = current.origin_postal_code;
  if (input.cep_origem !== undefined) {
    if (input.cep_origem === null || input.cep_origem === "") origin = null;
    else {
      origin = postalCode(input.cep_origem);
      if (!origin) throw new ApiError(400, "invalid_request", "CEP de origem: informe os 8 números do CEP (ex.: 01001-000), ou deixe vazio para usar o da empresa.");
    }
  }
  const notify = typeof input.avisar_whatsapp === "boolean" ? input.avisar_whatsapp : current.notify_whatsapp;
  await exec(env, `INSERT INTO erp_frete_settings(profile_id,notify_whatsapp,origin_postal_code,updated,updated_by) VALUES(?,?,?,?,?)
    ON CONFLICT(profile_id) DO UPDATE SET notify_whatsapp=excluded.notify_whatsapp, origin_postal_code=excluded.origin_postal_code, updated=excluded.updated, updated_by=excluded.updated_by`,
  profile, notify ? 1 : 0, origin, now(), actor);
  return freightSettings(env, profile);
}

/** Provedores ligados e com credenciais, para cotar. */
export async function enabledProviders(env: Env, profile: string): Promise<FreightProviderId[]> {
  return (await providerRows(env, profile)).filter((r) => r.enabled).map((r) => r.provider);
}
