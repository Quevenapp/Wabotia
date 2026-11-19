import { createHash } from "node:crypto";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import type { CommercialSettings, ConfigSaveInput } from "../../../commercial-nfe/contracts.ts";
import { com1Authority, requireCom1Access } from "./access.ts";

/** Resultado público conferido pelo servidor; não inclui URL com credenciais ou chave. */
export interface CommercialConnectionCheck {
  fingerprint: string;
  provider: "nfapi";
  origin: string;
  issuer_cnpj: string;
  version: string;
  /** Microssegundos UTC em texto decimal, igual aos timestamps de contracts.ts. */
  checked_at: string;
  compatible: boolean;
  company_matches: boolean;
  company_complete: boolean;
  environments: ("homologacao" | "producao")[];
  series: { environment: "homologacao" | "producao"; series: number }[];
}

let connectionFor: (ctx: RpcContext) => CommercialConnectionCheck | null = () => null;

/** Instalar na costura com prova já obtida do cofre. Não faz I/O na transação. */
export function installCommercialConnectionResolver(resolver: typeof connectionFor): () => void {
  const previous = connectionFor;
  connectionFor = resolver;
  return () => { connectionFor = previous; };
}

export const COMMERCIAL_CHECKLIST = Object.freeze([
  { code: "vault_certificate", message: "Configure certificado e senha diretamente no cofre." },
  { code: "vault_connection", message: "Confira conexão HTTPS, versão e ambiente permitido do cofre." },
  { code: "issuer", message: "Confira CNPJ, CRT, inscrição estadual e endereço da empresa." },
  { code: "series", message: "Confira a série de NF-e disponibilizada pelo cofre." },
  { code: "recipient", message: "Confira documento, endereço, município e condição de IE do cliente." },
  { code: "products", message: "Confira NCM, origem, unidade e demais dados dos produtos." },
  { code: "nature", message: "Revise natureza e regras tributárias de todos os itens." },
  { code: "accountant", message: "O contador deve conferir a operação e os limites, inclusive a omissão de IBS/CBS/IS." },
  { code: "totals", message: "Confira pagamentos, parcelas e total fiscal." },
  { code: "transport", message: "Confira a modalidade e os dados de transporte." },
  { code: "effects", message: "Escolha as políticas de estoque e financeiro e confira seus responsáveis e pendências." },
  { code: "homologation", message: "Use área de ensaio: homologação pode movimentar estoque, títulos e recebimentos comerciais reais." },
]);

function current(ctx: RpcContext): CommercialSettings {
  const row = one(ctx.db, `SELECT *, CAST(production_enabled_at AS TEXT) production_enabled_at,
    CAST(tax_limits_acknowledged_at AS TEXT) tax_limits_acknowledged_at, CAST(updated_at AS TEXT) updated_at
    FROM erp_fiscal_vault__commercial_settings WHERE id=1`);
  if (!row) return {
    id: 1, version: 1, environment: "homologacao", stock_timing: "existing", finance_timing: "existing",
    series_homologacao: null, series_producao: null, connection_fingerprint: null, connection_public: null,
    production_enabled_at: null, production_enabled_by: null, tax_limits_acknowledged_at: null,
    tax_limits_acknowledged_by: null, updated_at: null, updated_by: null,
  };
  return { ...row, connection_public: row.connection_public === null ? null : JSON.parse(String(row.connection_public)) } as unknown as CommercialSettings;
}

/** Leitura interna sem privilégio adicional para políticas de efeitos já autorizadas. */
export const readCommercialSettings = current;

export function getCommercialSettings(ctx: RpcContext) {
  requireCom1Access(ctx, "read");
  return { ...current(ctx), checklist: COMMERCIAL_CHECKLIST };
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fields = new Set(["command_id", "expected_version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "acknowledge_tax_limits", "enable_production"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validate(input: ConfigSaveInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key)) ||
    !UUID.test(input.command_id) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 1 ||
    !["homologacao", "producao"].includes(input.environment) ||
    !["existing", "on_authorization"].includes(input.stock_timing) || !["existing", "on_authorization"].includes(input.finance_timing))
    raise("22023", "fiscal_invalid_request");
  for (const key of ["series_homologacao", "series_producao"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 889)) raise("22023", "fiscal_series_invalid");
  }
  for (const key of ["acknowledge_tax_limits", "enable_production"] as const)
    if (input[key] !== undefined && typeof input[key] !== "boolean") raise("22023", "fiscal_invalid_request");
}

/** Comando atômico, repetível, sem segredo. A transação é a do RPC. */
export function saveCommercialSettings(ctx: RpcContext, input: ConfigSaveInput): CommercialSettings {
  const actor = requireCom1Access(ctx, "configure");
  validate(input);
  const normalized = Object.fromEntries([...fields].filter(key => Object.hasOwn(input, key)).sort().map(key => [key, input[key as keyof ConfigSaveInput]]));
  const argsHash = hash(normalized);
  const receipt = one(ctx.db, "SELECT action,person_id,args_hash,result FROM erp_fiscal_vault__order_command WHERE id=?", input.command_id);
  if (receipt) {
    if (receipt.action !== "config_save" || receipt.person_id !== actor.user_id || receipt.args_hash !== argsHash) raise("40001", "fiscal_command_conflict");
    if (!receipt.result) raise("40001", "fiscal_command_pending");
    return JSON.parse(String(receipt.result)) as CommercialSettings;
  }
  const before = current(ctx);
  if (before.version !== input.expected_version) raise("40001", "fiscal_config_conflict");
  const connection = connectionFor(ctx);
  const time = String(ctx.clock.next());
  const after: CommercialSettings = {
    ...before, version: before.version + 1, environment: input.environment, stock_timing: input.stock_timing,
    finance_timing: input.finance_timing, updated_at: time, updated_by: actor.user_id,
    series_homologacao: input.series_homologacao === undefined ? before.series_homologacao : input.series_homologacao,
    series_producao: input.series_producao === undefined ? before.series_producao : input.series_producao,
  };
  if (input.acknowledge_tax_limits) {
    after.tax_limits_acknowledged_at = time;
    after.tax_limits_acknowledged_by = actor.user_id;
  }
  if (connection) {
    let url: URL;
    try { url = new URL(connection.origin); } catch { return raise("22023", "fiscal_connection_invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      connection.provider !== "nfapi" || !/^[0-9A-Z]{12}[0-9]{2}$/.test(connection.issuer_cnpj) ||
      !/^[a-f0-9]{64}$/.test(connection.fingerprint) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(connection.version) ||
      !/^\d+$/.test(connection.checked_at) || !Array.isArray(connection.environments) ||
      connection.environments.some(environment => !["homologacao", "producao"].includes(environment)) ||
      !Array.isArray(connection.series) || connection.series.some(series => !["homologacao", "producao"].includes(series.environment) ||
        !Number.isSafeInteger(series.series) || series.series < 0 || series.series > 889)) raise("22023", "fiscal_connection_invalid");
    after.connection_fingerprint = connection.fingerprint;
    after.connection_public = { provider: connection.provider, origin: url.origin, issuer_cnpj: connection.issuer_cnpj,
      version: connection.version, checked_at: connection.checked_at, compatible: connection.compatible,
      environments: [...connection.environments], series: connection.series.map(series => ({ environment: series.environment, series: series.series })) };
  }
  for (const environment of ["homologacao", "producao"] as const) {
    const selection = after[environment === "homologacao" ? "series_homologacao" : "series_producao"];
    if (selection !== null && (!connection || !connection.series.some(s => s.environment === environment && s.series === selection)))
      raise("55000", "fiscal_series_required");
  }
  if (input.enable_production) {
    if (!connection) raise("55000", "fiscal_provider_not_configured");
    if (!connection.compatible) raise("55000", "fiscal_provider_incompatible");
    if (!connection.environments.includes("producao")) raise("55000", "fiscal_environment_not_allowed");
    if (!connection.company_matches) raise("55000", "fiscal_issuer_mismatch");
    if (!connection.company_complete) raise("55000", "fiscal_issuer_incomplete");
    if (!after.tax_limits_acknowledged_at) raise("55000", "fiscal_tax_limits_not_acknowledged");
    const series = connection.series.filter(s => s.environment === "producao");
    if (series.length !== 1 && after.series_producao === null) raise("55000", "fiscal_series_required");
    after.production_enabled_at = time;
    after.production_enabled_by = actor.user_id;
  }
  if (connection && before.connection_fingerprint && before.connection_fingerprint !== connection.fingerprint && !input.enable_production) {
    after.production_enabled_at = null;
    after.production_enabled_by = null;
  }
  if (after.environment === "producao" && (!after.production_enabled_at || !connection || !connection.environments.includes("producao")))
    raise("55000", "fiscal_production_not_enabled");
  if (after.environment === "producao" && connection) {
    if (!connection.compatible) raise("55000", "fiscal_provider_incompatible");
    if (!connection.company_matches) raise("55000", "fiscal_issuer_mismatch");
    if (!connection.company_complete) raise("55000", "fiscal_issuer_incomplete");
    if (!after.tax_limits_acknowledged_at) raise("55000", "fiscal_tax_limits_not_acknowledged");
  }
  const authority = com1Authority(ctx);
  ctx.db.exec(`INSERT INTO erp_fiscal_vault__commercial_settings
    (id,version,environment,stock_timing,finance_timing,series_homologacao,series_producao,connection_fingerprint,connection_public,
     production_enabled_at,production_enabled_by,tax_limits_acknowledged_at,tax_limits_acknowledged_by,updated_at,updated_by)
    VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    version=excluded.version,environment=excluded.environment,stock_timing=excluded.stock_timing,finance_timing=excluded.finance_timing,
    series_homologacao=excluded.series_homologacao,series_producao=excluded.series_producao,connection_fingerprint=excluded.connection_fingerprint,
    connection_public=excluded.connection_public,production_enabled_at=excluded.production_enabled_at,production_enabled_by=excluded.production_enabled_by,
    tax_limits_acknowledged_at=excluded.tax_limits_acknowledged_at,tax_limits_acknowledged_by=excluded.tax_limits_acknowledged_by,
    updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    after.version, after.environment, after.stock_timing, after.finance_timing, after.series_homologacao, after.series_producao,
    after.connection_fingerprint, after.connection_public ? JSON.stringify(after.connection_public) : null,
    after.production_enabled_at, after.production_enabled_by, after.tax_limits_acknowledged_at, after.tax_limits_acknowledged_by,
    after.updated_at, after.updated_by);
  ctx.db.exec(`INSERT INTO erp_fiscal_vault__order_command
    (id,action,person_id,session_id,args_hash,state,result,proposed_by,confirmed_by,created_at,updated_at)
    VALUES(?,'config_save',?,?,?,'completed',?,?,?,?,?)`, input.command_id, actor.user_id, actor.session_id, argsHash,
    JSON.stringify(after), authority.proposed_by ?? null, authority.confirmed_by ?? null, time, time);
  const summary = (s: CommercialSettings) => JSON.stringify({ version: s.version, environment: s.environment, stock_timing: s.stock_timing,
    finance_timing: s.finance_timing, production_enabled: !!s.production_enabled_at, tax_limits_acknowledged: !!s.tax_limits_acknowledged_at });
  ctx.db.exec(`INSERT INTO erp_fiscal_vault__order_audit
    (id,person_id,session_id,proposed_by,confirmed_by,command_id,environment,action,before_summary,after_summary,"references",created_at)
    VALUES(?,?,?,?,?,?,?,'config_save',?,?,?,?)`, crypto.randomUUID(), actor.user_id, actor.session_id,
    authority.proposed_by ?? null, authority.confirmed_by ?? null, input.command_id, after.environment,
    summary(before), summary(after), JSON.stringify({ connection_fingerprint: after.connection_fingerprint }), time);
  return after;
}
