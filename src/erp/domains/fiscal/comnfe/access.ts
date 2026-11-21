import type { ErpActor } from "../../../engine/identity.ts";
import { raise } from "../../../engine/errors.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import { activeRole, permitted } from "../../access/public.ts";
import { access as posAccess } from "../../pos/internal.ts";
import { com1Model } from "./model.ts";

export type Com1Action = "read" | "configure" | "prepare" | "emit" | "resume" | "cancel" | "effect_stock" | "effect_finance";

/** Evidência da costura autenticada. Nunca aceitar este objeto no corpo público. */
export interface Com1Authority {
  origin: "application" | "external";
  proposed_by?: string | null;
  confirmed_by?: string | null;
  confirmation_id?: string | null;
  /** Concessão já conferida por bot, área, operação e pessoa ∩ bot. */
  autonomous?: boolean;
}

const authorityByContext = new WeakMap<RpcContext, Readonly<Com1Authority>>();
let currentAuthority: Readonly<Com1Authority> | undefined;
let resolveAuthority: (ctx: RpcContext) => Readonly<Com1Authority> = () => currentAuthority ?? { origin: "application" };

/** Escopo estritamente síncrono ao chamar o motor; nunca envolver I/O ou Promise. */
export function runWithCom1Authority<T>(authority: Com1Authority, run: () => T): T {
  const previous = currentAuthority;
  currentAuthority = Object.freeze({ ...authority });
  try { return run(); } finally { currentAuthority = previous; }
}

export const COM1_AUTHORITY_HEADER = "x-erp-com1-authority";

export function readCom1Authority(value: unknown): Com1Authority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["origin", "proposed_by", "confirmed_by", "confirmation_id", "autonomous"].includes(key)) ||
    !["application", "external"].includes(String(input.origin)) ||
    ["proposed_by", "confirmed_by", "confirmation_id"].some(key => input[key] != null &&
      (typeof input[key] !== "string" || !(input[key] as string).length || (input[key] as string).length > 200)) ||
    (input.autonomous !== undefined && typeof input.autonomous !== "boolean")) return null;
  return { ...input } as unknown as Com1Authority;
}

/** Instalação explícita na costura/testes; a função deve resolver somente metadados internos. */
export function installCom1AuthorityResolver(resolver: typeof resolveAuthority): () => void {
  const previous = resolveAuthority;
  resolveAuthority = resolver;
  return () => { resolveAuthority = previous; };
}

export function bindCom1Authority(ctx: RpcContext, authority: Com1Authority): void {
  authorityByContext.set(ctx, Object.freeze({ ...authority }));
}

export function com1Authority(ctx: RpcContext): Readonly<Com1Authority> {
  return authorityByContext.get(ctx) ?? resolveAuthority(ctx);
}

/**
 * Política única da fatia para categorias sensíveis (nota fiscal, administração,
 * estoque e dinheiro). A pessoa que confirmou é a identidade executora. Uma
 * concessão autônoma futura substitui a confirmação, sem contornar papel/portão.
 */
export function requireCom1SensitivePolicy(actor: ErpActor, action: Com1Action, authority: Readonly<Com1Authority>): void {
  if (authority.origin !== "application") raise("42501", "fiscal_external_origin_forbidden");
  if (action === "read") return;
  const confirmed = !!authority.confirmation_id && authority.confirmed_by === actor.user_id && !!actor.session_id;
  if (actor.is_agent || actor.is_technical) {
    if (!confirmed && authority.autonomous !== true) raise("42501", "fiscal_confirmation_required");
  } else if (!actor.session_id && authority.autonomous !== true) {
    raise("42501", "fiscal_session_required");
  }
}

/** Identidade executora desta fatia após a política de delegação. Não inventa
 * sessão, fator, papel ou permissões e não altera a natureza técnica do ator.
 * Remove apenas o veto legado por agente quando a delegação foi autorizada. */
export function com1ExecutionActor(actor: ErpActor, action: Com1Action, authority: Readonly<Com1Authority>): ErpActor {
  requireCom1SensitivePolicy(actor, action, authority);
  const confirmed = !!authority.confirmation_id && authority.confirmed_by === actor.user_id && !!actor.session_id;
  // Consulta pessoal não é ação sensível. O portão decide se a política
  // exige sessão/MFA; o contexto do bot não recebe sessão inventada.
  const delegatedRead = action === "read" && !actor.is_technical;
  return actor.is_agent && (confirmed || authority.autonomous === true || delegatedRead)
    ? { ...actor, is_agent: false } : actor;
}

/** Inventário fechado para a ponte e o endpoint interno aplicarem a mesma
 * política. Evidências usam a capacidade durável e não normalizam identidade. */
export function com1ActionForRpc(name: string, value?: unknown): Com1Action | null {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (["erp_com1_config_get", "erp_com1_get", "erp_com1_list", "erp_com1_nfce_config_get", "erp_com1_nfce_sales",
    "erp_com1_nfse_config_get", "erp_com1_os_notes"].includes(name)) return "read";
  if (name === "erp_com1_config_save" || name === "erp_com1_nfce_config_save" || name === "erp_com1_nfse_config_save") return "configure";
  if (name === "erp_com1_prepare" || name === "erp_com1_nfce_prepare" || name === "erp_com1_os_prepare") return "prepare";
  if (name === "erp_com1_nfce_sale_cancel") return "cancel";
  // Depois da nota autorizada (events.ts): leituras e eventos fiscais (papel fiscal).
  if (["erp_com1_events_get", "erp_com1_void_list", "erp_com1_correction_file", "erp_com1_return_get"].includes(name)) return "read";
  if (["erp_com1_correction_claim", "erp_com1_correction_record", "erp_com1_void_claim", "erp_com1_void_record",
    "erp_com1_return_prepare", "erp_com1_return_claim", "erp_com1_return_record", "erp_com1_return_effects"].includes(name)) return "emit";
  if (name === "erp_com1_claim") return input.action === "emit" || input.action === "resume" ? input.action : null;
  if (name === "erp_com1_cancel_claim") return "cancel";
  if (["erp_com1_effect_apply", "erp_com1_effect_reverse"].includes(name))
    return input.axis === "stock" ? "effect_stock" : input.axis === "finance" ? "effect_finance" : null;
  return null;
}

/** Defesa local: identidade, papel atual e permissão são revalidados na transação. */
export function requireCom1Access(ctx: RpcContext, action: Com1Action, expectedUser?: string): ErpActor {
  const actor = ctx.identity.actor;
  if (!actor || (expectedUser !== undefined && actor.user_id !== expectedUser)) raise("42501", "fiscal_forbidden");
  requireCom1SensitivePolicy(actor, action, com1Authority(ctx));
  const role = activeRole(ctx.db, actor.user_id);
  if (!role || role !== actor.erp_role) raise("42501", "fiscal_forbidden");
  // NFC-e do balcão: quem fecha a venda no caixa pede, consulta e cancela o
  // cupom dela pelas permissões do PDV; fiscal e administrador, pelas da nota.
  if (com1Model() === "nfce" && ["read", "prepare", "emit", "resume", "cancel"].includes(action) &&
      (action === "read" ? ["vendas", "financeiro"] : ["vendas"]).includes(role)) {
    const pdv = posAccess(ctx.db, actor.user_id, action !== "read");
    if (action !== "read" && !pdv.finish) raise("42501", "fiscal_forbidden");
    return actor;
  }
  const allowed = action === "configure" ? ["admin"]
    : action === "read" ? ["admin", "consulta", "fiscal"]
    : action === "effect_stock" ? ["admin", "estoque"]
    : action === "effect_finance" ? ["admin", "financeiro"] : ["admin", "fiscal"];
  if (!allowed.includes(role)) raise("42501", "fiscal_forbidden");
  const permission = action === "configure" ? "outros.dados_empresa.gerenciar"
    : action === "read" ? "vendas.notas_fiscais"
    : action === "effect_stock" ? "suprimentos.controle_estoque.insercao"
    : action === "effect_finance" ? "financas.contas_receber.ie" : "vendas.notas_fiscais.ie";
  if (!permitted(ctx.db, actor.user_id, permission)) raise("42501", "fiscal_forbidden");
  return actor;
}
