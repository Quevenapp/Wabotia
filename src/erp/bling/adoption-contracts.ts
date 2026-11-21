/** Adoção revisada do acervo do Bling: cadastros (fatia B1), documentos e
 * contas em aberto e o espelho histórico dos encerrados (fatia B2). Contrato
 * puro: tela, Worker, objeto e bots usam os mesmos nomes, entradas e saídas.
 * Importar não faz I/O. Nada aqui escreve no Bling. */
import { z } from "zod";
import { ERP_PART_MODULES, ERP_PART_NAMES, erpRequirement, erpRequirementMet, type ErpModuleId, type ErpPartKey, type ErpParts } from "../parts.ts";
import { BLING_HISTORY_SCOPES, type BlingHistoryScope } from "./adoption-situations.ts";
import {
  BLING_CUTOVER_OPERATIONS, BLING_CUTOVER_OPERATION_NAMES, BLING_CUTOVER_PARAMS, cutoverInputs, cutoverOutputs, type BlingCutoverOperationMap,
} from "./cutover-contracts.ts";
import {
  BLING_TWO_WAY_ADMIN_OPERATIONS, BLING_TWO_WAY_ADMIN_OPERATION_NAMES, BLING_TWO_WAY_OPERATIONS, BLING_TWO_WAY_OPERATION_NAMES, BLING_TWO_WAY_PARAMS,
  twoWayInputs, twoWayOutputs, type BlingTwoWayOperationMap,
} from "./two-way-contracts.ts";
import {
  BLING_EXTRAS_ADMIN_OPERATIONS, BLING_EXTRAS_ADMIN_OPERATION_NAMES, BLING_EXTRAS_OPERATIONS, BLING_EXTRAS_OPERATION_NAMES, BLING_EXTRAS_PARAMS,
  extrasInputs, extrasOutputs, type BlingExtrasOperationMap,
} from "./extras-contracts.ts";

/** Cadastros (B1). Ordem de execução: dependências primeiro (categorias antes
 * de produtos, contatos antes de vendedores). */
export const BLING_ADOPTION_RECORD_ENTITIES = [
  "product_categories", "contacts", "sellers", "products", "warehouses",
  "payment_methods", "financial_categories", "ledger_accounts",
] as const;
/** Documentos (B2): em aberto viram documento do ERP; encerrados, histórico. */
export const BLING_ADOPTION_DOCUMENT_ENTITIES = ["sales_proposals", "sales_orders", "purchase_orders"] as const;
/** Contas (B2): em aberto e inteiras viram título do ERP; o resto, histórico. */
export const BLING_ADOPTION_ACCOUNT_ENTITIES = ["receivables", "payables"] as const;
export const BLING_ADOPTION_B2_ENTITIES = [...BLING_ADOPTION_DOCUMENT_ENTITIES, ...BLING_ADOPTION_ACCOUNT_ENTITIES] as const;
/** Todas, na ordem do lote: cadastros antes dos documentos que os usam. */
export const BLING_ADOPTION_ENTITIES = [...BLING_ADOPTION_RECORD_ENTITIES, ...BLING_ADOPTION_B2_ENTITIES] as const;
export type BlingAdoptionEntity = typeof BLING_ADOPTION_ENTITIES[number];
export type BlingAdoptionRecordEntity = typeof BLING_ADOPTION_RECORD_ENTITIES[number];
export type BlingAdoptionB2Entity = typeof BLING_ADOPTION_B2_ENTITIES[number];
export type BlingAdoptionDocumentEntity = typeof BLING_ADOPTION_DOCUMENT_ENTITIES[number];
export type BlingAdoptionAccountEntity = typeof BLING_ADOPTION_ACCOUNT_ENTITIES[number];
export const isAdoptionB2 = (entity: string): entity is BlingAdoptionB2Entity => (BLING_ADOPTION_B2_ENTITIES as readonly string[]).includes(entity);
export const isAdoptionDocument = (entity: string): entity is BlingAdoptionDocumentEntity => (BLING_ADOPTION_DOCUMENT_ENTITIES as readonly string[]).includes(entity);
export const isAdoptionAccount = (entity: string): entity is BlingAdoptionAccountEntity => (BLING_ADOPTION_ACCOUNT_ENTITIES as readonly string[]).includes(entity);

/** Grupo da entidade na tela (mesma tabela, com um título por grupo). */
export const BLING_ADOPTION_GROUPS = Object.freeze({ records: "Cadastros", documents: "Documentos (propostas e pedidos)", accounts: "Contas a receber e a pagar" });
export type BlingAdoptionGroup = keyof typeof BLING_ADOPTION_GROUPS;
export const adoptionGroup = (entity: BlingAdoptionEntity): BlingAdoptionGroup => isAdoptionDocument(entity) ? "documents" : isAdoptionAccount(entity) ? "accounts" : "records";

/** Parte do ERP de que cada entidade depende. Base = Cadastros. */
export const BLING_ADOPTION_PARTS: Readonly<Record<BlingAdoptionEntity, ErpPartKey>> = Object.freeze({
  product_categories: "products", contacts: "customers", sellers: "customers", products: "products",
  warehouses: "stock", payment_methods: "customers", financial_categories: "finance", ledger_accounts: "finance",
  sales_proposals: "sales", sales_orders: "sales", purchase_orders: "purchases", receivables: "finance", payables: "finance",
});

export const BLING_ADOPTION_LABELS: Readonly<Record<BlingAdoptionEntity, string>> = Object.freeze({
  product_categories: "Categorias de produtos", contacts: "Contatos (clientes, fornecedores e transportadoras)",
  sellers: "Vendedores", products: "Produtos e serviços", warehouses: "Depósitos", payment_methods: "Formas de pagamento",
  financial_categories: "Categorias financeiras", ledger_accounts: "Contas financeiras",
  sales_proposals: "Propostas comerciais", sales_orders: "Pedidos de venda", purchase_orders: "Pedidos de compra",
  receivables: "Contas a receber", payables: "Contas a pagar",
});
/** Nome de um registro avulso da entidade (para frases como "o pedido de venda nº 12"). */
export const BLING_ADOPTION_SINGULAR: Readonly<Record<BlingAdoptionEntity, string>> = Object.freeze({
  product_categories: "categoria de produto", contacts: "contato", sellers: "vendedor", products: "produto", warehouses: "depósito",
  payment_methods: "forma de pagamento", financial_categories: "categoria financeira", ledger_accounts: "conta financeira",
  sales_proposals: "proposta comercial", sales_orders: "pedido de venda", purchase_orders: "pedido de compra",
  receivables: "conta a receber", payables: "conta a pagar",
});
/** Texto da tela para o que ficou no espelho histórico. */
export const BLING_HISTORY_READONLY = "Já encerrado no Bling (só consulta). Este registro não pode ser faturado, cancelado nem editado no ERP: ele só mostra como veio do Bling.";
export { BLING_HISTORY_SCOPES, type BlingHistoryScope };

/** Entidades em que "usar a do Bling" pode atualizar um cadastro já existente.
 * Nas demais, a do Bling cria um cadastro novo ou se liga ao existente. */
export const BLING_ADOPTION_UPDATABLE: ReadonlySet<BlingAdoptionEntity> = new Set<BlingAdoptionEntity>([
  "product_categories", "contacts", "products", "warehouses", "financial_categories",
]);

export function adoptionModule(entity: BlingAdoptionEntity): ErpModuleId { return ERP_PART_MODULES[BLING_ADOPTION_PARTS[entity]]; }
export function adoptionEnabled(entity: BlingAdoptionEntity, parts: Readonly<ErpParts> | null | undefined): boolean {
  if (!parts?.customers || !parts[BLING_ADOPTION_PARTS[entity]]) return false;
  // Documentos e contas: o módulo e os de que ele depende (Vendas e Compras precisam de Produtos).
  return !isAdoptionB2(entity) || erpRequirementMet(parts, erpRequirement(adoptionModule(entity)));
}
/** Frase para a entidade com a parte desligada: diz qual módulo ligar. */
export function adoptionPartOffMessage(entity: BlingAdoptionEntity, parts?: Readonly<ErpParts> | null): string {
  const module = adoptionModule(entity);
  const on = (id: ErpModuleId) => (Object.entries(ERP_PART_MODULES) as [ErpPartKey, ErpModuleId][]).some(([key, value]) => value === id && !!parts?.[key]);
  const off = parts && isAdoptionB2(entity) ? erpRequirement(module).all.filter(id => !on(id)) : [];
  const names = (off.length ? off : [module]).map(id => ERP_PART_NAMES[id]);
  const spoken = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
  return `Para adotar ${BLING_ADOPTION_LABELS[entity].toLowerCase()}, ligue ${names.length > 1 ? "os módulos" : "o módulo"} ${spoken} em Gestão → Módulos.`;
}

/** Motivos de pendência, sempre explicados em palavras na tela. */
export const BLING_ADOPTION_REASONS = {
  divergent: "Já existe um cadastro parecido no ERP, mas os dados são diferentes.",
  ambiguous: "Há mais de um cadastro no ERP que pode ser este.",
  suggestion: "Não há CPF/CNPJ para conferir. Achamos um cadastro com o mesmo e-mail ou nome: confira antes de ligar.",
  invalid_document: "O CPF ou CNPJ vindo do Bling não é válido.",
  duplicate_warning: "O ERP avisou que o código, o GTIN ou o documento já estão em uso em outro cadastro.",
  invalid_data: "Algum dado vindo do Bling não passa nas regras do ERP.",
  missing_name: "O registro do Bling está sem nome ou descrição.",
  source_deleted: "O registro foi excluído no Bling.",
  dependency: "Este registro depende de outro que ainda não foi adotado.",
  unsupported: "Este tipo de registro do Bling não tem correspondente no ERP.",
  failed: "A adoção deste registro falhou. Tente de novo ou ignore.",
  unlinked: "Foi desligado do Bling por uma pessoa. O cadastro do ERP ficou; o lote não liga de novo sozinho.",
  missing_records: "Falta adotar um cadastro que este documento usa. Adote o cadastro e depois tente de novo.",
  possible_duplicate: "Já existe no ERP um registro com o mesmo número, contato e valor: confira antes de criar outro.",
  unknown_situation: "A situação vinda do Bling não é conhecida. Não dá para saber se está em aberto ou encerrada.",
  effects_blocked: "Adotar agora geraria efeitos no ERP (por exemplo, contas automáticas pelas Preferências). Nada foi criado.",
} as const;
export type BlingAdoptionReason = keyof typeof BLING_ADOPTION_REASONS;
export const BLING_ADOPTION_REASON_KEYS = Object.keys(BLING_ADOPTION_REASONS) as BlingAdoptionReason[];

/** Por que o trabalho em lote parou sozinho (não é pendência de um registro). */
export const BLING_ADOPTION_STOPS = {
  permission: "Quem pediu a adoção não tem mais permissão para cadastrar. Um administrador precisa pedir de novo.",
  module_disabled: "Um módulo necessário foi desligado. Ligue o módulo e peça a adoção de novo.",
  archive_unavailable: "O acervo do Bling não está disponível (sem conta vinculada ou em apagamento).",
} as const;
export type BlingAdoptionStop = keyof typeof BLING_ADOPTION_STOPS;

export const BLING_ADOPTION_ERROR_CODES = [
  "BLING_ADOPTION_ADMIN_REQUIRED", "BLING_ADOPTION_SCOPE_REQUIRED", "BLING_ADOPTION_DISABLED", "BLING_ADOPTION_PART_DISABLED",
  "BLING_ADOPTION_INVALID", "BLING_ADOPTION_NOT_FOUND", "BLING_ADOPTION_CONFLICT", "BLING_ADOPTION_COMMAND_CONFLICT",
  "BLING_ADOPTION_RECORD_REFUSED", "BLING_ADOPTION_UNAVAILABLE",
] as const;
export type BlingAdoptionErrorCode = typeof BLING_ADOPTION_ERROR_CODES[number];
const MESSAGES: Record<BlingAdoptionErrorCode, string> = {
  BLING_ADOPTION_ADMIN_REQUIRED: "Adotar cadastros do Bling exige um administrador do ERP.",
  BLING_ADOPTION_SCOPE_REQUIRED: "Este bot não tem permissão para esta operação, ou a pessoa ainda não confirmou a proposta.",
  BLING_ADOPTION_DISABLED: "O módulo Cadastros está desligado. Ligue-o em Gestão → Módulos.",
  BLING_ADOPTION_PART_DISABLED: "O módulo necessário para esta entidade está desligado. Ligue-o em Gestão → Módulos.",
  BLING_ADOPTION_INVALID: "Os dados enviados não estão no formato esperado. Atualize a tela e tente de novo.",
  BLING_ADOPTION_NOT_FOUND: "Este registro não está mais no acervo ou na lista de pendências. Atualize a tela.",
  BLING_ADOPTION_CONFLICT: "A situação mudou enquanto você decidia. Atualize a tela e confira de novo.",
  BLING_ADOPTION_COMMAND_CONFLICT: "Este pedido já foi usado para outra solicitação. Atualize a tela e tente de novo.",
  BLING_ADOPTION_RECORD_REFUSED: "O ERP recusou o cadastro. Confira os dados e tente de novo ou ignore o registro.",
  BLING_ADOPTION_UNAVAILABLE: "O acervo do Bling não está disponível nesta área (sem conta vinculada ou em apagamento).",
};
export interface BlingAdoptionFailure { code: BlingAdoptionErrorCode; message: string; detail?: string }
export class BlingAdoptionError extends Error {
  readonly code: BlingAdoptionErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 503;
  /** Motivo do domínio, em palavras (nunca exceção crua). */
  readonly detail?: string;
  constructor(code: BlingAdoptionErrorCode, detail?: string) {
    super(MESSAGES[code]); this.name = "BlingAdoptionError"; this.code = code; this.detail = detail;
    this.status = code === "BLING_ADOPTION_ADMIN_REQUIRED" || code === "BLING_ADOPTION_SCOPE_REQUIRED" ? 403
      : code === "BLING_ADOPTION_INVALID" ? 400 : code === "BLING_ADOPTION_NOT_FOUND" ? 404
      : code === "BLING_ADOPTION_UNAVAILABLE" ? 503 : 409;
  }
  toJSON(): BlingAdoptionFailure { return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }; }
}
export function adoptionErrorMessage(code: BlingAdoptionErrorCode): string { return MESSAGES[code]; }

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const sourceId = z.string().regex(/^[1-9]\d{0,39}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const adoptionEntitySchema = z.enum(BLING_ADOPTION_ENTITIES);
const field = z.string().max(400).nullable();
/** Resumo comparável, lado a lado: as mesmas chaves para o Bling e o ERP. */
export const adoptionSummarySchema = z.record(z.string().max(40), field);
export type BlingAdoptionSummary = z.infer<typeof adoptionSummarySchema>;
const counts = z.object({ processed: count, adopted: count, linked: count, pending: count, skipped: count, history: count.optional() }).strict();
const ENTITY_MAX = BLING_ADOPTION_ENTITIES.length;
export const adoptionJobSchema = z.object({
  state: z.enum(["idle", "running", "paused", "done"]), entities: z.array(adoptionEntitySchema).max(ENTITY_MAX),
  current: adoptionEntitySchema.nullable(), counts, revision: z.string().regex(/^(0|[1-9]\d{0,15})$/),
  started_at: z.string().nullable(), updated_at: z.string().nullable(), finished_at: z.string().nullable(),
  stop: z.object({ code: z.enum(Object.keys(BLING_ADOPTION_STOPS) as [BlingAdoptionStop, ...BlingAdoptionStop[]]), message: z.string().max(300) }).strict().nullable(),
}).strict();
export type BlingAdoptionJob = z.infer<typeof adoptionJobSchema>;
export const adoptionEntityStatusSchema = z.object({
  entity: adoptionEntitySchema, label: z.string().max(100), module: z.string().max(40), module_name: z.string().max(60),
  enabled: z.boolean(), part_off_message: z.string().max(300).nullable(), updatable: z.boolean(),
  collected: count, waiting: count, adopted: count, pending: count, ignored: count,
  /** Documentos e contas: quantos ficaram no espelho histórico (só consulta). */
  history: count.optional(),
  /** Documentos e contas: o que ficou de fora, por motivo, com o total em centavos. */
  outside: z.array(z.object({ scope: z.enum(Object.keys(BLING_HISTORY_SCOPES) as [BlingHistoryScope, ...BlingHistoryScope[]]), label: z.string().max(200),
    count, total_cents: z.string().regex(/^-?\d{1,18}$/) }).strict()).max(10).optional(),
}).strict();
export const adoptionStatusSchema = z.object({
  available: z.boolean(), unavailable_message: z.string().max(300).nullable(),
  job: adoptionJobSchema, entities: z.array(adoptionEntityStatusSchema).max(ENTITY_MAX),
}).strict();
export type BlingAdoptionStatus = z.infer<typeof adoptionStatusSchema>;
export type BlingAdoptionEntityStatus = z.infer<typeof adoptionEntityStatusSchema>;
export const adoptionCandidateSchema = z.object({ record_id: z.string().max(200), summary: adoptionSummarySchema }).strict();
/** Cadastro que falta adotar para o documento ou a conta, com o atalho. */
export const adoptionMissingSchema = z.object({
  entity: z.enum(BLING_ADOPTION_RECORD_ENTITIES), source_id: sourceId, label: z.string().max(200).nullable(),
  /** waiting: ainda não processado; pending/ignored: está nas pendências; absent: não foi coletado. */
  state: z.enum(["waiting", "pending", "ignored", "absent"]).optional(),
}).strict();
export type BlingAdoptionMissing = z.infer<typeof adoptionMissingSchema>;
export const adoptionReviewSchema = z.object({
  entity: adoptionEntitySchema, source_id: sourceId, state: z.enum(["pending", "ignored"]),
  reason: z.enum(BLING_ADOPTION_REASON_KEYS as [BlingAdoptionReason, ...BlingAdoptionReason[]]), reason_text: z.string().max(300),
  detail: z.string().max(200).nullable(), source_version: z.string().regex(/^[1-9]\d{0,15}$/),
  /** null quando o registro não está mais no acervo. */
  bling: adoptionSummarySchema.nullable(), erp: z.array(adoptionCandidateSchema).max(5),
  /** Documentos e contas: cadastros que faltam adotar. */
  missing: z.array(adoptionMissingSchema).max(20).optional(),
}).strict();
export type BlingAdoptionReview = z.infer<typeof adoptionReviewSchema>;
export const adoptionLinkSchema = z.object({
  entity: adoptionEntitySchema, source_id: sourceId, record_id: z.string().max(200), mode: z.enum(["created", "linked", "updated"]),
  source_version: z.string(), adopted_at: z.string(), summary: adoptionSummarySchema.nullable(),
}).strict();
export type BlingAdoptionLink = z.infer<typeof adoptionLinkSchema>;
const pageInput = { cursor: z.string().regex(/^[1-9]\d{0,39}$/).optional(), limit: z.number().int().min(1).max(50).optional() };
const command = { command_id: id };
const receipt = z.object({ command_id: id, operation: z.string().max(60), replayed: z.boolean() }).strict();

// Espelho histórico (B2): documentos e contas encerrados no Bling, só consulta.
const b2Entity = z.enum(BLING_ADOPTION_B2_ENTITIES);
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
/** Cursor da lista do histórico: data (ou 0 sem data) e id no Bling. */
const historyCursor = z.string().regex(/^(\d{4}-\d{2}-\d{2}|0)\.[1-9]\d{0,39}$/);
const cents = z.string().regex(/^-?\d{1,18}$/);
export const adoptionHistoryItemSchema = z.object({
  entity: b2Entity, source_id: sourceId, number: z.string().max(80).nullable(), contact_name: z.string().max(200).nullable(),
  issued_on: day.nullable(), situation: z.string().max(120).nullable(),
  scope: z.enum(Object.keys(BLING_HISTORY_SCOPES) as [BlingHistoryScope, ...BlingHistoryScope[]]), scope_text: z.string().max(200),
  total_cents: cents.nullable(), source_version: z.string().regex(/^[1-9]\d{0,15}$/),
}).strict();
export type BlingAdoptionHistoryItem = z.infer<typeof adoptionHistoryItemSchema>;
const shown = z.string().max(400).nullable();
export const adoptionHistoryDocumentSchema = z.object({
  item: adoptionHistoryItemSchema, read_only_message: z.string().max(300),
  fields: z.record(z.string().max(60), shown),
  lines: z.array(z.object({ description: shown, code: shown, quantity: shown, unit_price: shown, total: shown }).strict()).max(250),
  installments: z.array(z.object({ due_on: shown, amount: shown, method: shown, note: shown }).strict()).max(120),
  /** O registro como veio do Bling (texto com a precisão recebida). */
  payload_text: z.string().max(262144),
}).strict();
export type BlingAdoptionHistoryDocument = z.infer<typeof adoptionHistoryDocumentSchema>;

export const BLING_ADOPTION_OPERATION_NAMES = [
  "erp_bling_adoption_status", "erp_bling_adoption_reviews", "erp_bling_adoption_links",
  "erp_bling_adoption_start", "erp_bling_adoption_pause", "erp_bling_adoption_resolve", "erp_bling_adoption_unlink",
  "erp_bling_adoption_adopt_one", "erp_bling_adoption_history", "erp_bling_adoption_history_get",
  // Fatia C (corte): mesmo registro, mesmo despacho, mesmas regras.
  ...BLING_CUTOVER_OPERATION_NAMES,
  // Mão dupla: as quatro dos bots e as duas só do administrador.
  ...BLING_TWO_WAY_OPERATION_NAMES, ...BLING_TWO_WAY_ADMIN_OPERATION_NAMES,
  // Fatia D (outros dados do Bling): as dos bots e as só do administrador.
  ...BLING_EXTRAS_OPERATION_NAMES, ...BLING_EXTRAS_ADMIN_OPERATION_NAMES,
] as const;
export type BlingAdoptionOperationName = typeof BLING_ADOPTION_OPERATION_NAMES[number];

export const adoptionInputs = {
  erp_bling_adoption_status: z.object({}).strict(),
  erp_bling_adoption_reviews: z.object({ entity: adoptionEntitySchema, state: z.enum(["pending", "ignored"]).optional(), ...pageInput }).strict(),
  erp_bling_adoption_links: z.object({ entity: adoptionEntitySchema, ...pageInput }).strict(),
  erp_bling_adoption_start: z.object({ ...command, entities: z.array(adoptionEntitySchema).min(1).max(ENTITY_MAX) }).strict()
    .refine(v => new Set(v.entities).size === v.entities.length),
  erp_bling_adoption_pause: z.object(command).strict(),
  erp_bling_adoption_resolve: z.object({ ...command, entity: adoptionEntitySchema, source_id: sourceId,
    action: z.enum(["use_bling", "keep_erp", "ignore"]), record_id: uuid.optional() }).strict()
    .refine(v => v.action !== "keep_erp" || !!v.record_id, "Manter a do ERP exige o cadastro escolhido.")
    .refine(v => v.action !== "ignore" || !v.record_id),
  erp_bling_adoption_unlink: z.object({ ...command, entity: adoptionEntitySchema, source_id: sourceId }).strict(),
  erp_bling_adoption_adopt_one: z.object({ ...command, entity: adoptionEntitySchema, source_id: sourceId }).strict(),
  erp_bling_adoption_history: z.object({ entity: b2Entity, q: z.string().trim().min(1).max(80).optional(), from: day.optional(), to: day.optional(),
    cursor: historyCursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict()
    .refine(v => !v.from || !v.to || v.from <= v.to, "A data inicial vem antes da final."),
  erp_bling_adoption_history_get: z.object({ entity: b2Entity, source_id: sourceId }).strict(),
  ...cutoverInputs,
  ...twoWayInputs,
  ...extrasInputs,
} as const;
export const adoptionOutputs = {
  erp_bling_adoption_status: adoptionStatusSchema,
  erp_bling_adoption_reviews: z.object({ items: z.array(adoptionReviewSchema).max(50), next_cursor: z.string().nullable() }).strict(),
  erp_bling_adoption_links: z.object({ items: z.array(adoptionLinkSchema).max(50), next_cursor: z.string().nullable() }).strict(),
  erp_bling_adoption_start: z.object({ job: adoptionJobSchema, receipt }).strict(),
  erp_bling_adoption_pause: z.object({ job: adoptionJobSchema, receipt }).strict(),
  erp_bling_adoption_resolve: z.object({ outcome: z.enum(["adopted", "linked", "updated", "ignored"]), record_id: z.string().nullable(), receipt }).strict(),
  erp_bling_adoption_unlink: z.object({ record_id: z.string(), receipt }).strict(),
  erp_bling_adoption_adopt_one: z.object({ outcome: z.enum(["adopted", "linked", "pending", "skipped", "history"]), record_id: z.string().nullable(),
    message: z.string().max(400), receipt }).strict(),
  erp_bling_adoption_history: z.object({ items: z.array(adoptionHistoryItemSchema).max(50), next_cursor: historyCursor.nullable() }).strict(),
  erp_bling_adoption_history_get: adoptionHistoryDocumentSchema,
  ...cutoverOutputs,
  ...twoWayOutputs,
  ...extrasOutputs,
} as const;
export interface BlingAdoptionOperationMap extends BlingCutoverOperationMap, BlingTwoWayOperationMap, BlingExtrasOperationMap {
  erp_bling_adoption_status: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_status>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_status> };
  erp_bling_adoption_reviews: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_reviews>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_reviews> };
  erp_bling_adoption_links: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_links>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_links> };
  erp_bling_adoption_start: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_start>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_start> };
  erp_bling_adoption_pause: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_pause>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_pause> };
  erp_bling_adoption_resolve: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_resolve>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_resolve> };
  erp_bling_adoption_unlink: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_unlink>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_unlink> };
  erp_bling_adoption_adopt_one: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_adopt_one>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_adopt_one> };
  erp_bling_adoption_history: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_history>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_history> };
  erp_bling_adoption_history_get: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_history_get>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_history_get> };
}

export interface BlingAdoptionOperationDescriptor {
  name: BlingAdoptionOperationName; method: "GET" | "POST"; path: string; summary: string; description: string; sensitive: boolean;
}
const op = (name: BlingAdoptionOperationName, method: "GET" | "POST", path: string, summary: string, description: string, sensitive: boolean): BlingAdoptionOperationDescriptor =>
  Object.freeze({ name, method, path, summary, description, sensitive });
/** Nomes estáveis para tela e bots. Todas exigem administrador do ERP; as
 * sensíveis seguem proposta e confirmação da pessoa quando vêm de um bot. */
/** Operações só do administrador, pela tela: ficam fora do inventário dos bots. */
export type BlingAdoptionAdminOperationName = typeof BLING_TWO_WAY_ADMIN_OPERATION_NAMES[number] | typeof BLING_EXTRAS_ADMIN_OPERATION_NAMES[number];
export type BlingAdoptionBotOperationName = Exclude<BlingAdoptionOperationName, BlingAdoptionAdminOperationName>;
export const BLING_ADOPTION_ADMIN_OPERATIONS: Readonly<Record<BlingAdoptionAdminOperationName, BlingAdoptionOperationDescriptor>> = Object.freeze({ ...BLING_TWO_WAY_ADMIN_OPERATIONS, ...BLING_EXTRAS_ADMIN_OPERATIONS });
export const isAdoptionAdminOnly = (name: string): name is BlingAdoptionAdminOperationName => Object.hasOwn(BLING_ADOPTION_ADMIN_OPERATIONS, name);
export const BLING_ADOPTION_OPERATIONS: Readonly<Record<BlingAdoptionBotOperationName, BlingAdoptionOperationDescriptor>> = Object.freeze({
  erp_bling_adoption_status: op("erp_bling_adoption_status", "GET", "/adotar", "Consultar a adoção de cadastros do Bling",
    "Mostra, por entidade (cadastros, propostas, pedidos e contas), quantos registros foram coletados, adotados, estão pendentes de revisão, ignorados ou ficaram no histórico por já estarem encerrados no Bling, o progresso do lote e qual módulo ligar quando uma parte está desligada.", false),
  erp_bling_adoption_reviews: op("erp_bling_adoption_reviews", "GET", "/adotar/pendencias", "Listar pendências de revisão da adoção",
    "Lista os registros que não puderam ser adotados sozinhos, com o motivo e as duas versões lado a lado: a do Bling e a do ERP. Contém dados pessoais dos cadastros.", true),
  erp_bling_adoption_links: op("erp_bling_adoption_links", "GET", "/adotar/vinculos", "Listar cadastros adotados do Bling",
    "Lista os cadastros do ERP ligados a registros do Bling, com a versão coletada de onde vieram.", true),
  erp_bling_adoption_start: op("erp_bling_adoption_start", "POST", "/adotar/iniciar", "Adotar em lote os cadastros coletados",
    "Agenda a adoção das entidades escolhidas em unidades pequenas e retomáveis no alarme. Cria ou liga cadastros do ERP pelas mesmas regras das telas; propostas, pedidos e contas em aberto viram documentos e títulos do ERP sem baixar estoque, gerar contas ou emitir nota, e os encerrados vão para o histórico. Nada é escrito no Bling.", true),
  erp_bling_adoption_pause: op("erp_bling_adoption_pause", "POST", "/adotar/pausar", "Pausar a adoção em lote",
    "Pausa o lote no fim da unidade em andamento; o que já foi adotado continua adotado. Pedir a adoção de novo retoma de onde parou.", true),
  erp_bling_adoption_resolve: op("erp_bling_adoption_resolve", "POST", "/adotar/pendencias/resolver", "Resolver uma pendência da adoção",
    "Decide uma pendência: usar a do Bling (cria ou atualiza o cadastro; num documento ou conta, tenta adotar de novo depois de adotados os cadastros que faltavam), manter a do ERP e ligar, ou ignorar o registro.", true),
  erp_bling_adoption_unlink: op("erp_bling_adoption_unlink", "POST", "/adotar/desligar", "Desligar um cadastro do Bling",
    "Remove só o vínculo entre o cadastro, documento ou conta do ERP e o registro do Bling. O que está no ERP continua como está.", true),
  erp_bling_adoption_adopt_one: op("erp_bling_adoption_adopt_one", "POST", "/adotar/um", "Adotar um registro do Bling agora",
    "Adota na hora um único registro coletado (por exemplo, o contato ou o produto que falta para um pedido), pelas mesmas regras do lote. Em aberto vira cadastro, documento ou conta do ERP sem baixar estoque, gerar contas ou emitir nota; encerrado vai para o histórico; com problema vira pendência. Nada é escrito no Bling.", true),
  erp_bling_adoption_history: op("erp_bling_adoption_history", "GET", "/adotar/historico", "Buscar no histórico do Bling",
    "Lista propostas, pedidos e contas já encerrados no Bling (atendidos, cancelados, faturados, pagos), só para consulta, com busca por número, contato e período. Contém nomes de clientes e fornecedores.", true),
  erp_bling_adoption_history_get: op("erp_bling_adoption_history_get", "GET", "/adotar/historico/documento", "Abrir um documento do histórico do Bling",
    "Mostra um documento ou conta encerrado no Bling como veio: cabeçalho, itens, parcelas e o registro recebido. Só consulta: não pode ser faturado, cancelado nem editado.", true),
  ...BLING_CUTOVER_OPERATIONS,
  ...BLING_TWO_WAY_OPERATIONS,
  ...BLING_EXTRAS_OPERATIONS,
});
const id40 = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "Id do registro no Bling." };
const entityParam = { type: "string", enum: [...BLING_ADOPTION_ENTITIES], description: "Entidade do Bling." };
const b2Param = { type: "string", enum: [...BLING_ADOPTION_B2_ENTITIES], description: "Propostas, pedidos ou contas." };
const commandParam = { type: "string", description: "Identificador único do pedido, para repetir sem duplicar." };
const pageParams = { cursor: { type: "string", description: "Continuação da página anterior." }, limit: { type: "integer", minimum: 1, maximum: 50 } };
type AdoptionParams = { type: "object"; properties: Record<string, unknown>; required: string[] };
const params = (properties: Record<string, unknown>, required: string[] = []): AdoptionParams => Object.freeze({ type: "object" as const, properties, required });
/** Parâmetros de cada operação, no formato do inventário dos bots. */
export const BLING_ADOPTION_PARAMS: Readonly<Record<BlingAdoptionOperationName, AdoptionParams>> = Object.freeze({
  erp_bling_adoption_status: params({}),
  erp_bling_adoption_reviews: params({ entity: entityParam, state: { type: "string", enum: ["pending", "ignored"] }, ...pageParams }, ["entity"]),
  erp_bling_adoption_links: params({ entity: entityParam, ...pageParams }, ["entity"]),
  erp_bling_adoption_start: params({ command_id: commandParam, entities: { type: "array", items: entityParam, minItems: 1, maxItems: BLING_ADOPTION_ENTITIES.length } }, ["command_id", "entities"]),
  erp_bling_adoption_pause: params({ command_id: commandParam }, ["command_id"]),
  erp_bling_adoption_resolve: params({ command_id: commandParam, entity: entityParam, source_id: id40, action: { type: "string", enum: ["use_bling", "keep_erp", "ignore"] },
    record_id: { type: "string", format: "uuid", description: "Registro do ERP escolhido (manter a do ERP)." } }, ["command_id", "entity", "source_id", "action"]),
  erp_bling_adoption_unlink: params({ command_id: commandParam, entity: entityParam, source_id: id40 }, ["command_id", "entity", "source_id"]),
  erp_bling_adoption_adopt_one: params({ command_id: commandParam, entity: entityParam, source_id: id40 }, ["command_id", "entity", "source_id"]),
  erp_bling_adoption_history: params({ entity: b2Param, q: { type: "string", maxLength: 80, description: "Número ou nome do contato." },
    from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["entity"]),
  erp_bling_adoption_history_get: params({ entity: b2Param, source_id: id40 }, ["entity", "source_id"]),
  ...BLING_CUTOVER_PARAMS,
  ...BLING_TWO_WAY_PARAMS,
  ...BLING_EXTRAS_PARAMS,
});
/** Todas as operações do despacho (as dos bots e as só do administrador). */
export function getAdoptionOperation(name: string): BlingAdoptionOperationDescriptor | null {
  if (Object.hasOwn(BLING_ADOPTION_OPERATIONS, name)) return BLING_ADOPTION_OPERATIONS[name as BlingAdoptionBotOperationName];
  return isAdoptionAdminOnly(name) ? BLING_ADOPTION_ADMIN_OPERATIONS[name] : null;
}
export function isAdoptionOperation(name: string): name is BlingAdoptionOperationName { return getAdoptionOperation(name) !== null; }
export function parseAdoptionInput<K extends BlingAdoptionOperationName>(name: K, input: unknown): BlingAdoptionOperationMap[K]["input"] {
  const parsed = adoptionInputs[name].safeParse(input);
  if (!parsed.success) throw new BlingAdoptionError("BLING_ADOPTION_INVALID");
  return parsed.data as BlingAdoptionOperationMap[K]["input"];
}
/** Casa método e caminho relativos a /v1/receber-bling. */
export function matchAdoptionRoute(method: string, relative: string): BlingAdoptionOperationDescriptor | null {
  const path = relative.replace(/\/$/, "") || "/";
  return [...Object.values(BLING_ADOPTION_OPERATIONS), ...Object.values(BLING_ADOPTION_ADMIN_OPERATIONS)].find(item => item.method === method && item.path === path) ?? null;
}

/** Envelope privado da chamada de um bot (Worker → objeto). Nunca vem do navegador. */
export const adoptionAuthorizationSchema = z.object({
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  bot: z.object({ id, operation: z.enum(BLING_ADOPTION_OPERATION_NAMES) }).strict(),
  delegation: z.object({ run_id: id, proposal_id: id.optional() }).strict(),
  confirmed: z.boolean(),
}).strict();
export type BlingAdoptionAuthorization = z.infer<typeof adoptionAuthorizationSchema>;
