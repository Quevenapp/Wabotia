// Proprietário e requisitos completos das nove partes do ERP.

import { pendingInMotor } from "./motor.ts";
import { ERP_MODULES, requirementsEnabled, requirementOf, erpPartEnabled } from "./modules.ts";
import { portedTarget, portedUrl, hiddenPortedTarget } from "../management/ported-policy.ts";
export { blockOf } from "./modules.ts";

export type ErpBlock = import("./modules.ts").ErpModule;
export { requirementOf } from "./modules.ts";
import { ERP_PART_MODULES, erpRequirement, type ErpRequirement } from "../../src/erp/parts.ts";
import { erpFieldRequirement, erpEntityRequirement, erpOperationRequirement, type ErpOperation } from "../../src/erp/parts-requirements.ts";

export const ERP_BLOCK_LABELS: Record<ErpBlock, string> = {
  erp: "Cadastro de clientes",
  "erp-produtos": "Produtos e serviços", "erp-vendas": "Vendas", "erp-compras": "Compras",
  "erp-estoque": "Estoque", "erp-financeiro": "Financeiro",
  "erp-fiscal": "Fiscal",
  "erp-cobranca": "Cobrança bancária",
  "erp-pdv": "Caixa / PDV",
};

/**
 * Telas do Fagoo que o Wabotia já faz pelo núcleo e que ficam escondidas:
 * a atualização da instalação (o painel atualiza) e o pareamento com o
 * próprio Wabotia.
 */
export const hiddenInWabotia = hiddenPortedTarget;

/** Blocos ligados na área; sem registro (testes do Fagoo), todos ligados. */
let enabled: Partial<Record<ErpBlock, boolean>> | null = null;
export function setErpBlocks(next: Partial<Record<ErpBlock, boolean>> | null) {
  enabled = next;
}
// O hospedeiro anterior ainda publica quatro chaves; o contexto completo da casca tem precedência.
let contextModules: Readonly<Record<string, boolean>> | null = null;
export function setErpModuleContext(next: Readonly<Record<string, boolean>> | null) { contextModules = next; }
/** Sem hospedeiro, mantém o contrato do controlador portado; no painel há sempre contexto explícito. */
export const hasErpModuleContext = () => contextModules !== null || enabled !== null;
export const currentErpModules = () => contextModules ?? Object.fromEntries(ERP_MODULES.map(key => [key, !enabled || enabled[key] !== false]));
export const requirementEnabled = (requirement: ErpRequirement | null) => requirementsEnabled(requirement, currentErpModules());
export const fieldEnabled = (field: string) => requirementEnabled(erpFieldRequirement(fieldAliases[field] ?? field));
export const entityEnabled = (entity: string) => requirementEnabled(erpEntityRequirement(entity));
export const operationEnabled = (operation: ErpOperation) => requirementEnabled(erpOperationRequirement(operation));
/** Metadados de ausência não autorizam operações; servem somente para validar o DTO. */
export function responseModules(raw: unknown): Readonly<Record<string, boolean>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Resposta inválida.');
  const unavailable = (raw as { unavailable_parts?: unknown }).unavailable_parts;
  if (unavailable !== undefined && (!Array.isArray(unavailable) || new Set(unavailable).size !== unavailable.length || unavailable.some(key => typeof key !== 'string' || !Object.hasOwn(ERP_PART_MODULES, key)))) throw new Error('Partes indisponíveis inválidas.');
  return Object.fromEntries(Object.entries(ERP_PART_MODULES).map(([key, id]) => [id, !(unavailable as string[] | undefined)?.includes(key)]));
}
export function withoutUnavailableParts(raw: unknown): unknown {
  responseModules(raw);
  const { unavailable_parts, ...value } = raw as Record<string, unknown>;
  return value;
}
const accessChecks = new Map<symbol, (target: string) => boolean>();
export function installErpTargetAccess(check: (target: string) => boolean) {
  const owner = Symbol("erp-target-access");
  accessChecks.set(owner, check);
  return () => { accessChecks.delete(owner); };
}
export const blockEnabled = (block: ErpBlock) => requirementEnabled(erpRequirement(block));
export const targetEnabled = (target: string) => {
  const known = portedTarget(target);
  const url = portedUrl(target);
  return !!known && !hiddenInWabotia(target) &&
    !!url && erpPartEnabled(known.part, currentErpModules(), target) && !pendingInMotor(url.pathname + url.search) &&
    ([...accessChecks.values()].at(-1)?.(target) ?? (!enabled || !known.readPermission));
};

/** Omite vínculos suspensos no envio, sem modificar o rascunho nem limpar valores salvos. */
const fieldAliases: Readonly<Record<string, string>> = {
  payment_account_id: "account_id", financial_category_id: "category_id", finance_category_id: "category_id", fee_amount: "fee", commission_fee_amount: "commission",
  commission_percentage: "commission", credit_limit_mode: "credit_limit", operation_nature_id: "fiscal_emission", received_amount: "fee", stock_min: "stock", stock_max: "stock", lot_control: "stock",
};
export function availablePayload<T>(value: T, owner?: ErpBlock): T {
  if (Array.isArray(value)) return value.map(item => availablePayload(item, owner)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => requirementEnabled(erpFieldRequirement(fieldAliases[key] ?? key, owner)))
    .map(([key, item]) => [key, availablePayload(item, owner)])) as T;
}
export const REENABLED_AUTOMATION_NOTICE = "Religar uma parte não refaz ações anteriores. Ao salvar, alterar a situação ou lançar novamente, esta nova ação pode executar a automação configurada nas preferências atuais.";
