// Configuração do emissor fiscal de uma área: endereço do cofre NFapi e chave
// de API, num segredo do núcleo (tabela `secrets`, AES-GCM com a MASTER_KEY,
// src/security.ts), como a Cobrança guarda o token do Mercado Pago.
//
// Por que no núcleo e não na configuração do módulo ou no banco do ERP
// (README.md desta pasta, "Onde mora a configuração"):
// - a configuração dos módulos é texto puro e volta inteira para o painel;
// - o SQLite do objeto erp:<área> vai para o backup lógico no R2
//   (/erp-backup): a chave sairia junto, decifrável por quem tem o backup;
// - o segredo do núcleo é cifrado, nunca devolvido e sai junto quando a área
//   é removida.
// Sem migração: um registro por área, id `erp-emissor:<área>`.
import { exec } from "../../db";
import { admin, secret, setSecret } from "../../security";
import { ApiError, type Actor, type Env, now } from "../../types";
import { compatibleVersion, contractDiff, type OpenApi } from "./contract/generate.ts";
import { CONTRACT_VERSION } from "./contract/types.generated.ts";
import { NfapiClient, olderThan } from "./nfapi.ts";
import { fiscalError, NFAPI_PROVIDER_ID, stateFromCofre } from "./nfapi-provider.ts";
import { FiscalError, type FiscalProviderState, type FiscalSeries } from "./provider.ts";
import { vaultReformCapability, type VaultReformCapability } from "./reform-capability.ts";

const secretId = (profile: string) => `erp-emissor:${profile}`;

export interface EmissorCheck {
  /** Quando o teste rodou (ms). */
  at: number;
  ok: boolean;
  error: { code: string; message: string; provider_code: string | null } | null;
  state: FiscalProviderState | null;
  series: FiscalSeries[] | null;
  contract: {
    /** Versão do contrato com que o Vinki foi escrito. */
    pinned: string;
    /** Versão do contrato servida pelo cofre (null se não leu). */
    vault: string | null;
    compatible: boolean | null;
    /** Diferenças de forma para a cópia versionada (até 50). */
    differences: string[];
  } | null;
  /**
   * O que o cofre aceita da reforma tributária (grupo IBS/CBS, Imposto
   * Seletivo e finalidades), lido do contrato que ele serve. null: não leu o
   * contrato; ausente: teste anterior a esta leitura (teste de novo).
   */
  reform?: VaultReformCapability | null;
}

interface Stored {
  provider: string;
  url: string;
  api_key: string;
  updated: number;
  updated_by: string;
  checked: EmissorCheck | null;
}

async function stored(env: Env, profile: string): Promise<Stored | null> {
  const value = (await secret(env, secretId(profile))) as Partial<Stored>;
  if (!value || typeof value.url !== "string" || !value.url) return null;
  return {
    provider: value.provider || NFAPI_PROVIDER_ID,
    url: value.url,
    api_key: typeof value.api_key === "string" ? value.api_key : "",
    updated: Number(value.updated) || 0,
    updated_by: String(value.updated_by || ""),
    checked: value.checked ?? null,
  };
}

/** Conexão para o provedor (com a chave). Só código do servidor usa. */
export async function emissorConnection(env: Env, profile: string) {
  const value = await stored(env, profile);
  if (!value || !value.api_key) return null;
  return { provider: value.provider, url: value.url, api_key: value.api_key };
}

/**
 * Origem https do cofre. Recusa http, credenciais na URL, caminho, consulta e
 * fragmento: a chave de API só vai para a origem informada.
 */
export function normalizeVaultUrl(value: unknown): string {
  const invalid = (message: string) => new ApiError(400, "fiscal_invalid_url", message);
  if (typeof value !== "string" || !value.trim()) throw invalid("Informe o endereço do cofre (https://...).");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid("Endereço do cofre inválido.");
  }
  if (url.protocol !== "https:") throw invalid("O endereço do cofre precisa começar com https://.");
  if (url.username || url.password) throw invalid("O endereço do cofre não pode ter usuário ou senha.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    throw invalid("Informe só o endereço do cofre, sem caminho (ex.: https://nfapi-cofre.sua-conta.workers.dev).");
  if (!url.hostname.includes(".")) throw invalid("Endereço do cofre inválido.");
  return url.origin;
}

/** Identidade pública da conexão: rotação de chave não muda o cofre nem o emitente. */
export async function fiscalConnectionFingerprint(input: { provider: string; url: string; issuer_document: string }): Promise<string> {
  const issuer = input.issuer_document.replace(/[.\/\-\s]/g, "").toUpperCase();
  if (!input.provider || !issuer)
    throw new FiscalError(409, "fiscal_provider_not_configured", "Confira o provedor e o emitente do cofre antes de continuar.");
  const publicIdentity = JSON.stringify([input.provider, normalizeVaultUrl(input.url), issuer]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicIdentity)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const API_KEY = /^nfapi_[A-Za-z0-9_-]{8,200}$/;

const DAY = 86_400_000;
export const CERTIFICATE_WARNING_DAYS = 30;
export const CHECK_STALE_MS = DAY;

export interface EmissorAlert {
  code:
    | "never_checked"
    | "check_failed"
    | "check_stale"
    | "vault_outdated"
    | "certificate_missing"
    | "certificate_expired"
    | "certificate_expiring"
    | "contract_incompatible"
    | "contract_changed"
    | "production_blocked"
    | "key_homologation_only"
    | "vault_feature_outdated"
    | "contingency_pending"
    | "logo_missing";
  level: "error" | "warning" | "info";
  message: string;
  days_left?: number;
  version?: string | null;
  /** vault_feature_outdated: o recurso (FEATURE_MIN_VERSION). */
  feature?: string;
  /** contingency_pending: notas a transmitir. */
  pending_notes?: number;
}

/**
 * Versão mínima do cofre por recurso, para o alerta "cofre desatualizado
 * para X". Cofre mais antigo atende o resto; a operação do recurso responde
 * 409 vault_outdated (nfapi.ts, OPERATION_MIN_VERSION, por operação).
 */
export const FEATURE_MIN_VERSION = [
  { feature: "emission", label: "emitir notas (NF-e, NFC-e e NFS-e com IBS, CBS e IS)", version: "0.8.0" },
  { feature: "documents", label: "DANFE, DANFE NFC-e, cupom e contingência da NFC-e", version: "0.8.0" },
  { feature: "received", label: "NF-e recebidas e manifestação", version: "0.9.0" },
  { feature: "reports", label: "relatórios e exportação dos XML", version: "0.11.0" },
  { feature: "nfse_cancellation_check", label: "conferência de cancelamento externo de NFS-e", version: "0.12.0" },
] as const;

/**
 * Versão mais antiga do cofre que este cliente atende: a mínima da emissão
 * (EMISSION_MIN_VERSION). Abaixo dela o contrato é incompatível e a emissão
 * responde 409 vault_outdated antes de enviar.
 */
export const OLDEST_SUPPORTED_VAULT = "0.8.0";

/** Dias até o certificado vencer, pela data (o número do teste envelhece). */
export function certificateDaysLeft(validUntil: string, at = now()) {
  const end = Date.parse(validUntil);
  return Number.isFinite(end) ? Math.floor((end - at) / DAY) : null;
}

export function emissorAlerts(checked: EmissorCheck | null, at = now()): EmissorAlert[] {
  const alerts: EmissorAlert[] = [];
  if (!checked) return [{ code: "never_checked", level: "warning", message: "Teste a conexão com o cofre." }];
  if (!checked.ok)
    alerts.push({
      code: "check_failed",
      level: "error",
      message: checked.error?.message || "O último teste de conexão falhou.",
    });
  if (at - checked.at > CHECK_STALE_MS)
    alerts.push({ code: "check_stale", level: "info", message: "O último teste de conexão tem mais de um dia." });
  const state = checked.state;
  if (state) {
    if (state.update.pending)
      alerts.push({
        code: "vault_outdated",
        level: "warning",
        message: `Há uma versão nova do cofre${state.update.published ? ` (${state.update.published})` : ""}. Atualize pelo painel do cofre.`,
        version: state.update.published,
      });
    if (!state.certificate)
      alerts.push({ code: "certificate_missing", level: "error", message: "O cofre não tem certificado digital A1 instalado." });
    else {
      const days = certificateDaysLeft(state.certificate.valid_until, at) ?? state.certificate.days_left;
      if (days < 0)
        alerts.push({ code: "certificate_expired", level: "error", message: "O certificado digital venceu.", days_left: days });
      else if (days <= CERTIFICATE_WARNING_DAYS)
        alerts.push({
          code: "certificate_expiring",
          level: "warning",
          message: days === 0 ? "O certificado digital vence hoje." : `O certificado digital vence em ${days} ${days === 1 ? "dia" : "dias"}.`,
          days_left: days,
        });
    }
    if (!state.production_released)
      alerts.push({
        code: "production_blocked",
        level: "info",
        message: "O cofre só emite em homologação (a produção é liberada no painel do cofre).",
      });
    if (state.key.scope === "homologacao")
      alerts.push({ code: "key_homologation_only", level: "info", message: "A chave de API só opera em homologação." });
    for (const f of FEATURE_MIN_VERSION)
      if (state.version && olderThan(state.version, f.version))
        alerts.push({
          code: "vault_feature_outdated",
          level: f.feature === "emission" ? "error" : "warning",
          message: `Cofre desatualizado para ${f.label}: precisa da versão ${f.version} (instalada: ${state.version}).`,
          version: f.version,
          feature: f.feature,
        });
    const pending = state.contingency?.pending_notes ?? 0;
    if (pending > 0)
      alerts.push({
        code: "contingency_pending",
        level: "warning",
        message: `${pending} ${pending === 1 ? "NFC-e emitida" : "NFC-e emitidas"} em contingência ainda sem transmissão. O cofre transmite quando a SEFAZ voltar; o prazo legal é o fim do primeiro dia útil seguinte.`,
        pending_notes: pending,
      });
    if (state.logo === false)
      alerts.push({
        code: "logo_missing",
        level: "info",
        message: "O cofre não tem logotipo: o DANFE sai sem a marca da empresa (envie pelo painel do cofre).",
      });
  }
  const contract = checked.contract;
  if (contract && contract.compatible === false)
    alerts.push({
      code: "contract_incompatible",
      level: "error",
      message: `O cofre usa o contrato ${contract.vault ?? "?"}; este Vinki foi escrito para o ${contract.pinned}.`,
      version: contract.vault,
    });
  else if (contract && contract.differences.length)
    alerts.push({
      code: "contract_changed",
      level: "info",
      message: `O contrato do cofre (${contract.vault ?? "?"}) tem ${contract.differences.length} diferença(s) para o do Vinki (${contract.pinned}).`,
      version: contract.vault,
    });
  return alerts;
}

/** Visão para o painel, sem a chave. */
export async function emissorView(env: Env, profile: string, at = now()) {
  const value = await stored(env, profile);
  if (!value)
    return {
      configured: false,
      provider: null,
      url: null,
      api_key_set: false,
      contract_version: CONTRACT_VERSION,
      updated: null,
      checked: null,
      alerts: [] as EmissorAlert[],
    };
  const certificate = value.checked?.state?.certificate;
  return {
    configured: !!value.api_key,
    provider: value.provider,
    url: value.url,
    api_key_set: !!value.api_key,
    contract_version: CONTRACT_VERSION,
    updated: value.updated || null,
    checked: value.checked
      ? {
          ...value.checked,
          state: value.checked.state && {
            ...value.checked.state,
            certificate: certificate && {
              ...certificate,
              days_left: certificateDaysLeft(certificate.valid_until, at) ?? certificate.days_left,
            },
          },
        }
      : null,
    alerts: emissorAlerts(value.checked, at),
  };
}

/**
 * Salva endereço e chave. A chave só é trocada quando informada; trocar o
 * endereço exige informar a chave de novo (ela nunca vai para outro host).
 */
export async function saveEmissor(env: Env, actor: Actor, profile: string, data: any) {
  admin(actor);
  const old = await stored(env, profile);
  const provider = data?.provider ?? old?.provider ?? NFAPI_PROVIDER_ID;
  if (provider !== NFAPI_PROVIDER_ID)
    throw new ApiError(400, "fiscal_invalid_provider", "Emissor desconhecido: esta instalação só aceita o emissor de notas padrão.");
  const url = data?.url === undefined && old ? old.url : normalizeVaultUrl(data?.url);
  const key = data?.api_key;
  if (key !== undefined && (typeof key !== "string" || !API_KEY.test(key.trim())))
    throw new ApiError(400, "fiscal_invalid_api_key", "Chave de API inválida: ela começa com nfapi_ e é criada na tela /setup do cofre.");
  const changedUrl = !old || old.url !== url;
  if (changedUrl && key === undefined)
    throw new ApiError(400, "fiscal_api_key_required", "Informe a chave de API do cofre (ao trocar o endereço, ela é pedida de novo).");
  const apiKey = key !== undefined ? key.trim() : old!.api_key;
  await setSecret(env, secretId(profile), {
    provider,
    url,
    api_key: apiKey,
    updated: now(),
    updated_by: actor.id,
    // Endereço ou chave novos invalidam o último teste.
    checked: changedUrl || key !== undefined ? null : (old?.checked ?? null),
  } satisfies Stored);
  return emissorView(env, profile);
}

export async function removeEmissor(env: Env, actor: Actor, profile: string) {
  admin(actor);
  await exec(env, "DELETE FROM secrets WHERE id=?", secretId(profile));
  return emissorView(env, profile);
}

/**
 * O cliente atende o contrato fixado e os cofres mais antigos desde
 * OLDEST_SUPPORTED_VAULT (as operações novas respondem vault_outdated e o
 * painel mostra vault_feature_outdated). Minor mais nova da mesma major
 * continua compatível; outra major ou versão ilegível é recusada.
 */
function servedCompatible(vault: string) {
  return compatibleVersion(CONTRACT_VERSION, vault) && !olderThan(vault, OLDEST_SUPPORTED_VAULT);
}

/**
 * "Testar conexão": GET /v1/cofre, GET /v1/series e GET /v1/openapi.json.
 * Guarda o resultado (sem segredos) para o painel e devolve a visão.
 */
export async function testEmissor(
  env: Env,
  actor: Actor,
  profile: string,
  options: { fetch?: typeof fetch } = {},
) {
  admin(actor);
  const value = await stored(env, profile);
  if (!value || !value.api_key)
    throw new FiscalError(409, "fiscal_provider_not_configured", "Informe o endereço do cofre e a chave de API antes de testar.");
  const api = new NfapiClient({ url: value.url, apiKey: value.api_key, fetch: options.fetch, readTimeoutMs: 15_000 });
  // 134 KB: só avaliado no teste de conexão.
  const pinned = (await import("./contract/openapi.json")).default as unknown as OpenApi;
  let checked: EmissorCheck;
  try {
    const state = stateFromCofre((await api.cofre()).body);
    const series = (await api.series()).body.map((s) => ({
      kind: s.modelo ?? "nfe",
      environment: s.ambiente ?? "homologacao",
      series: s.serie ?? 0,
      next_number: s.proximoNumero ?? 1,
      description: s.descricao ?? null,
      cnpj: s.cnpj ?? "",
    }));
    let contract: EmissorCheck["contract"] = {
      pinned: CONTRACT_VERSION,
      vault: null,
      compatible: servedCompatible(state.version) ? null : false,
      differences: [],
    };
    let reform: VaultReformCapability | null = null;
    try {
      const served = (await api.openapi()).body as OpenApi;
      if (served && typeof served === "object" && served.info && served.paths && served.components) {
        reform = vaultReformCapability(served);
        const differences = contractDiff(pinned, served);
        const vault = String(served.info.version);
        contract = {
          pinned: CONTRACT_VERSION,
          vault,
          compatible: servedCompatible(state.version) && servedCompatible(vault),
          differences: differences.slice(0, 50),
        };
      }
    } catch {
      // Cofre sem /v1/openapi.json legível: fica a comparação pela versão.
    }
    checked = { at: now(), ok: true, error: null, state, series, contract, reform };
  } catch (error) {
    const e = fiscalError(error);
    if (!(e instanceof FiscalError)) throw e;
    checked = {
      at: now(),
      ok: false,
      error: { code: e.code, message: e.message, provider_code: e.details.provider_code },
      state: null,
      series: null,
      contract: null,
    };
  }
  await setSecret(env, secretId(profile), { ...value, checked } satisfies Stored);
  return emissorView(env, profile);
}
