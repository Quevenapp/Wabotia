/** Adoção revisada dos cadastros do acervo (fatia B1). Contrato puro: tela,
 * Worker, objeto e bots usam os mesmos nomes, entradas e saídas. Importar não
 * faz I/O. Nada aqui escreve no Bling. */
import { z } from "zod";
import { ERP_PART_MODULES, ERP_PART_NAMES, type ErpModuleId, type ErpPartKey, type ErpParts } from "../parts.ts";

/** Ordem de execução: dependências primeiro (categorias antes de produtos,
 * contatos antes de vendedores); depósitos e formas de pagamento independem. */
export const BLING_ADOPTION_ENTITIES = [
  "product_categories", "contacts", "sellers", "products", "warehouses",
  "payment_methods", "financial_categories", "ledger_accounts",
] as const;
export type BlingAdoptionEntity = typeof BLING_ADOPTION_ENTITIES[number];

/** Parte do ERP de que cada entidade depende. Base = Cadastros. */
export const BLING_ADOPTION_PARTS: Readonly<Record<BlingAdoptionEntity, ErpPartKey>> = Object.freeze({
  product_categories: "products", contacts: "customers", sellers: "customers", products: "products",
  warehouses: "stock", payment_methods: "customers", financial_categories: "finance", ledger_accounts: "finance",
});

export const BLING_ADOPTION_LABELS: Readonly<Record<BlingAdoptionEntity, string>> = Object.freeze({
  product_categories: "Categorias de produtos", contacts: "Contatos (clientes, fornecedores e transportadoras)",
  sellers: "Vendedores", products: "Produtos e serviços", warehouses: "Depósitos", payment_methods: "Formas de pagamento",
  financial_categories: "Categorias financeiras", ledger_accounts: "Contas financeiras",
});

/** Entidades em que "usar a do Bling" pode atualizar um cadastro já existente.
 * Nas demais, a do Bling cria um cadastro novo ou se liga ao existente. */
export const BLING_ADOPTION_UPDATABLE: ReadonlySet<BlingAdoptionEntity> = new Set<BlingAdoptionEntity>([
  "product_categories", "contacts", "products", "warehouses", "financial_categories",
]);

export function adoptionModule(entity: BlingAdoptionEntity): ErpModuleId { return ERP_PART_MODULES[BLING_ADOPTION_PARTS[entity]]; }
export function adoptionEnabled(entity: BlingAdoptionEntity, parts: Readonly<ErpParts> | null | undefined): boolean {
  return !!parts?.customers && !!parts[BLING_ADOPTION_PARTS[entity]];
}
/** Frase para a entidade com a parte desligada: diz qual módulo ligar. */
export function adoptionPartOffMessage(entity: BlingAdoptionEntity): string {
  return `Para adotar ${BLING_ADOPTION_LABELS[entity].toLowerCase()}, ligue o módulo ${ERP_PART_NAMES[adoptionModule(entity)]} em Gestão → Módulos.`;
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
const counts = z.object({ processed: count, adopted: count, linked: count, pending: count, skipped: count }).strict();
export const adoptionJobSchema = z.object({
  state: z.enum(["idle", "running", "paused", "done"]), entities: z.array(adoptionEntitySchema).max(8),
  current: adoptionEntitySchema.nullable(), counts, revision: z.string().regex(/^(0|[1-9]\d{0,15})$/),
  started_at: z.string().nullable(), updated_at: z.string().nullable(), finished_at: z.string().nullable(),
  stop: z.object({ code: z.enum(Object.keys(BLING_ADOPTION_STOPS) as [BlingAdoptionStop, ...BlingAdoptionStop[]]), message: z.string().max(300) }).strict().nullable(),
}).strict();
export type BlingAdoptionJob = z.infer<typeof adoptionJobSchema>;
export const adoptionEntityStatusSchema = z.object({
  entity: adoptionEntitySchema, label: z.string().max(100), module: z.string().max(40), module_name: z.string().max(60),
  enabled: z.boolean(), part_off_message: z.string().max(300).nullable(), updatable: z.boolean(),
  collected: count, waiting: count, adopted: count, pending: count, ignored: count,
}).strict();
export const adoptionStatusSchema = z.object({
  available: z.boolean(), unavailable_message: z.string().max(300).nullable(),
  job: adoptionJobSchema, entities: z.array(adoptionEntityStatusSchema).max(8),
}).strict();
export type BlingAdoptionStatus = z.infer<typeof adoptionStatusSchema>;
export const adoptionCandidateSchema = z.object({ record_id: z.string().max(200), summary: adoptionSummarySchema }).strict();
export const adoptionReviewSchema = z.object({
  entity: adoptionEntitySchema, source_id: sourceId, state: z.enum(["pending", "ignored"]),
  reason: z.enum(BLING_ADOPTION_REASON_KEYS as [BlingAdoptionReason, ...BlingAdoptionReason[]]), reason_text: z.string().max(300),
  detail: z.string().max(200).nullable(), source_version: z.string().regex(/^[1-9]\d{0,15}$/),
  /** null quando o registro não está mais no acervo. */
  bling: adoptionSummarySchema.nullable(), erp: z.array(adoptionCandidateSchema).max(5),
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

export const BLING_ADOPTION_OPERATION_NAMES = [
  "erp_bling_adoption_status", "erp_bling_adoption_reviews", "erp_bling_adoption_links",
  "erp_bling_adoption_start", "erp_bling_adoption_pause", "erp_bling_adoption_resolve", "erp_bling_adoption_unlink",
] as const;
export type BlingAdoptionOperationName = typeof BLING_ADOPTION_OPERATION_NAMES[number];

export const adoptionInputs = {
  erp_bling_adoption_status: z.object({}).strict(),
  erp_bling_adoption_reviews: z.object({ entity: adoptionEntitySchema, state: z.enum(["pending", "ignored"]).optional(), ...pageInput }).strict(),
  erp_bling_adoption_links: z.object({ entity: adoptionEntitySchema, ...pageInput }).strict(),
  erp_bling_adoption_start: z.object({ ...command, entities: z.array(adoptionEntitySchema).min(1).max(8) }).strict()
    .refine(v => new Set(v.entities).size === v.entities.length),
  erp_bling_adoption_pause: z.object(command).strict(),
  erp_bling_adoption_resolve: z.object({ ...command, entity: adoptionEntitySchema, source_id: sourceId,
    action: z.enum(["use_bling", "keep_erp", "ignore"]), record_id: uuid.optional() }).strict()
    .refine(v => v.action !== "keep_erp" || !!v.record_id, "Manter a do ERP exige o cadastro escolhido.")
    .refine(v => v.action !== "ignore" || !v.record_id),
  erp_bling_adoption_unlink: z.object({ ...command, entity: adoptionEntitySchema, source_id: sourceId }).strict(),
} as const;
export const adoptionOutputs = {
  erp_bling_adoption_status: adoptionStatusSchema,
  erp_bling_adoption_reviews: z.object({ items: z.array(adoptionReviewSchema).max(50), next_cursor: z.string().nullable() }).strict(),
  erp_bling_adoption_links: z.object({ items: z.array(adoptionLinkSchema).max(50), next_cursor: z.string().nullable() }).strict(),
  erp_bling_adoption_start: z.object({ job: adoptionJobSchema, receipt }).strict(),
  erp_bling_adoption_pause: z.object({ job: adoptionJobSchema, receipt }).strict(),
  erp_bling_adoption_resolve: z.object({ outcome: z.enum(["adopted", "linked", "updated", "ignored"]), record_id: z.string().nullable(), receipt }).strict(),
  erp_bling_adoption_unlink: z.object({ record_id: z.string(), receipt }).strict(),
} as const;
export interface BlingAdoptionOperationMap {
  erp_bling_adoption_status: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_status>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_status> };
  erp_bling_adoption_reviews: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_reviews>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_reviews> };
  erp_bling_adoption_links: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_links>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_links> };
  erp_bling_adoption_start: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_start>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_start> };
  erp_bling_adoption_pause: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_pause>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_pause> };
  erp_bling_adoption_resolve: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_resolve>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_resolve> };
  erp_bling_adoption_unlink: { input: z.infer<typeof adoptionInputs.erp_bling_adoption_unlink>; output: z.infer<typeof adoptionOutputs.erp_bling_adoption_unlink> };
}

export interface BlingAdoptionOperationDescriptor {
  name: BlingAdoptionOperationName; method: "GET" | "POST"; path: string; summary: string; description: string; sensitive: boolean;
}
const op = (name: BlingAdoptionOperationName, method: "GET" | "POST", path: string, summary: string, description: string, sensitive: boolean): BlingAdoptionOperationDescriptor =>
  Object.freeze({ name, method, path, summary, description, sensitive });
/** Nomes estáveis para tela e bots. Todas exigem administrador do ERP; as
 * sensíveis seguem proposta e confirmação da pessoa quando vêm de um bot. */
export const BLING_ADOPTION_OPERATIONS: Readonly<Record<BlingAdoptionOperationName, BlingAdoptionOperationDescriptor>> = Object.freeze({
  erp_bling_adoption_status: op("erp_bling_adoption_status", "GET", "/adotar", "Consultar a adoção de cadastros do Bling",
    "Mostra, por entidade, quantos registros foram coletados, adotados, estão pendentes de revisão ou ignorados, o progresso do lote e qual módulo ligar quando uma parte está desligada.", false),
  erp_bling_adoption_reviews: op("erp_bling_adoption_reviews", "GET", "/adotar/pendencias", "Listar pendências de revisão da adoção",
    "Lista os registros que não puderam ser adotados sozinhos, com o motivo e as duas versões lado a lado: a do Bling e a do ERP. Contém dados pessoais dos cadastros.", true),
  erp_bling_adoption_links: op("erp_bling_adoption_links", "GET", "/adotar/vinculos", "Listar cadastros adotados do Bling",
    "Lista os cadastros do ERP ligados a registros do Bling, com a versão coletada de onde vieram.", true),
  erp_bling_adoption_start: op("erp_bling_adoption_start", "POST", "/adotar/iniciar", "Adotar em lote os cadastros coletados",
    "Agenda a adoção das entidades escolhidas em unidades pequenas e retomáveis no alarme. Cria ou liga cadastros do ERP pelas mesmas regras das telas; nada é escrito no Bling.", true),
  erp_bling_adoption_pause: op("erp_bling_adoption_pause", "POST", "/adotar/pausar", "Pausar a adoção em lote",
    "Pausa o lote no fim da unidade em andamento; o que já foi adotado continua adotado. Pedir a adoção de novo retoma de onde parou.", true),
  erp_bling_adoption_resolve: op("erp_bling_adoption_resolve", "POST", "/adotar/pendencias/resolver", "Resolver uma pendência da adoção",
    "Decide uma pendência: usar a do Bling (cria ou atualiza o cadastro), manter a do ERP e ligar, ou ignorar o registro.", true),
  erp_bling_adoption_unlink: op("erp_bling_adoption_unlink", "POST", "/adotar/desligar", "Desligar um cadastro do Bling",
    "Remove só o vínculo entre o cadastro do ERP e o registro do Bling. O cadastro do ERP continua como está.", true),
});
export function getAdoptionOperation(name: string): BlingAdoptionOperationDescriptor | null {
  return Object.hasOwn(BLING_ADOPTION_OPERATIONS, name) ? BLING_ADOPTION_OPERATIONS[name as BlingAdoptionOperationName] : null;
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
  return Object.values(BLING_ADOPTION_OPERATIONS).find(item => item.method === method && item.path === path) ?? null;
}

/** Envelope privado da chamada de um bot (Worker → objeto). Nunca vem do navegador. */
export const adoptionAuthorizationSchema = z.object({
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  bot: z.object({ id, operation: z.enum(BLING_ADOPTION_OPERATION_NAMES) }).strict(),
  delegation: z.object({ run_id: id, proposal_id: id.optional() }).strict(),
  confirmed: z.boolean(),
}).strict();
export type BlingAdoptionAuthorization = z.infer<typeof adoptionAuthorizationSchema>;
