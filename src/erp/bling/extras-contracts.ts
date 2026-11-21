/** Fatia D do Bling: o que o coletor passou a ler (listas de preços, naturezas
 * de operação, campos customizados e seus valores, contratos, NFS-e, lotes e
 * fornecedores de produto) e a adoção revisada de cada um. Contrato puro, no
 * mesmo registro da adoção (adoption-contracts.ts junta): tela, Worker,
 * objeto e bots usam os mesmos nomes. Importar não faz I/O.
 *
 * Consultar é leitura (grupo bling); adotar é sensível (o bot propõe e a
 * pessoa confirma). Criar o contrato de manutenção, ligar a mão dupla e ligar
 * um contrato a um que já existe são só do administrador, pela tela. */
import { z } from "zod";
import type { ErpPartKey } from "../parts.ts";

/** Entidades da adoção da fatia D, na ordem do lote (dependências primeiro). */
export const BLING_EXTRAS_ENTITIES = [
  "custom_fields", "custom_field_values", "price_lists", "product_suppliers", "product_lots", "operation_natures", "contracts", "service_invoices",
] as const;
export type BlingExtrasEntity = typeof BLING_EXTRAS_ENTITIES[number];
/** Adotadas pelo lote (prévia → adotar). Contratos têm passo próprio; NFS-e só consulta. */
export const BLING_EXTRAS_BATCH = ["custom_fields", "custom_field_values", "price_lists", "product_suppliers", "product_lots", "operation_natures"] as const;
export type BlingExtrasBatchEntity = typeof BLING_EXTRAS_BATCH[number];
export const isExtrasBatch = (value: string): value is BlingExtrasBatchEntity => (BLING_EXTRAS_BATCH as readonly string[]).includes(value);

export const BLING_EXTRAS_LABELS: Readonly<Record<BlingExtrasEntity, string>> = Object.freeze({
  custom_fields: "Campos customizados (definições de produto e de contato)", custom_field_values: "Valores dos campos customizados",
  price_lists: "Listas de preços", product_suppliers: "Fornecedores de produto", product_lots: "Lotes de produto",
  operation_natures: "Naturezas de operação", contracts: "Contratos", service_invoices: "Notas de serviço (NFS-e)",
});
/** De onde vem cada uma no acervo: valores saem dos produtos e contatos coletados. */
export const BLING_EXTRAS_SOURCE: Readonly<Record<BlingExtrasEntity, string>> = Object.freeze({
  custom_fields: "custom_fields", custom_field_values: "products,contacts", price_lists: "price_lists", product_suppliers: "product_suppliers",
  product_lots: "product_lots", operation_natures: "operation_natures", contracts: "contracts", service_invoices: "service_invoices",
});
/** Partes do ERP de cada uma (todas também exigem a Base). Contratos pedem o módulo
 * Ordem de Serviço do Wabotia, conferido no Worker. Campos de produto pedem
 * Produtos e serviços, conferido por registro. */
export const BLING_EXTRAS_PARTS: Readonly<Record<BlingExtrasEntity, readonly ErpPartKey[]>> = Object.freeze({
  custom_fields: ["customers"], custom_field_values: ["customers"], price_lists: ["products"],
  // O cadastro do produto só grava fornecedores com Compras e Estoque ligados.
  product_suppliers: ["products", "purchases", "stock"], product_lots: ["products", "stock"],
  operation_natures: ["fiscal"], contracts: ["customers"], service_invoices: ["fiscal"],
});

/** Mão dupla da fatia D: só listas de preços e as definições de campos. */
export const BLING_EXTRAS_TWO_WAY = ["price_lists", "custom_fields_products", "custom_fields_contacts"] as const;
export type BlingExtrasTwoWayEntity = typeof BLING_EXTRAS_TWO_WAY[number];
export const BLING_EXTRAS_TWO_WAY_LABELS: Readonly<Record<BlingExtrasTwoWayEntity, string>> = Object.freeze({
  price_lists: "Listas de preços", custom_fields_products: "Campos customizados de produto", custom_fields_contacts: "Campos customizados de contato",
});
export const BLING_EXTRAS_TWO_WAY_PARTS: Readonly<Record<BlingExtrasTwoWayEntity, readonly ErpPartKey[]>> = Object.freeze({
  price_lists: ["products"], custom_fields_products: ["products"], custom_fields_contacts: ["customers"],
});

export const BLING_EXTRAS_TEXTS = Object.freeze({
  intro: "Outros dados do Bling: listas de preços, naturezas de operação, campos customizados, fornecedores e lotes de produto, contratos e notas de serviço. Primeiro a coleta (cada recurso tem a sua seleção na Configuração, desligada e marcada como não confirmada até você conferir numa coleta real); depois a prévia mostra o que vai acontecer com cada registro, e só então você adota.",
  collect: "Coleta: estes recursos ficam desligados e não confirmados até o dono conferir o caminho, os campos e as permissões na documentação do Bling e numa coleta real. Quando um registro vem num formato que ainda não foi conferido, ele não é adotado: vira pendência com o motivo.",
  natures: "Naturezas de operação entram ativas, sem trocar a natureza padrão do Fiscal. Elas nunca voltam ao Bling.",
  lots: "Lotes entram com a validade e o saldo do Bling na data de corte. Se o estoque de abertura do depósito já foi gravado, o lote entra sem saldo (senão somaria de novo) e a tela avisa.",
  suppliers: "O fornecedor do produto é o mesmo vínculo que a compra pela nota usa: código e preço de custo do fornecedor.",
  contracts: "Contratos viram contrato de manutenção da Ordem de Serviço depois de conferidos aqui. A cobrança recorrente nasce desligada: ligue na tela do contrato quando quiser cobrar. Contratos nunca voltam ao Bling.",
  invoices: "Notas de serviço emitidas no Bling (só consulta). Não viram emissão, não podem ser canceladas nem corrigidas por aqui e nunca voltam ao Bling.",
  two_way: "Listas de preços e campos customizados podem entrar na mão dupla, com um interruptor por sentido, todos desligados. Naturezas, notas de serviço e contratos não voltam ao Bling.",
  switch_warning_outbound: "Ao ligar, as mudanças feitas daqui para a frente nos registros adotados serão gravadas na sua conta do Bling. O formato de escrita destes recursos ainda precisa ser conferido: confira um registro no Bling depois do primeiro envio. Confirme que entendeu.",
  switch_warning_inbound: "Ao ligar, as mudanças vindas do Bling daqui para a frente serão aplicadas no ERP sozinhas, e os registros novos serão adotados pelas mesmas regras. Confirme que entendeu.",
});

/** Motivos de pendência, em palavras. */
export const BLING_EXTRAS_REASONS = {
  unknown_format: "O registro veio do Bling num formato que ainda não foi conferido. Nada foi adotado: confira o registro no acervo.",
  missing_name: "O registro do Bling está sem nome ou descrição.",
  source_deleted: "O registro foi excluído no Bling.",
  dependency: "Este registro usa outro que ainda não foi adotado (produto, contato, depósito ou campo).",
  divergent: "Já existe um registro parecido no ERP, mas os dados são diferentes.",
  ambiguous: "Há mais de um registro no ERP que pode ser este.",
  invalid_data: "Algum dado vindo do Bling não passa nas regras do ERP.",
  duplicate: "O ERP avisou que já existe um registro com o mesmo nome.",
  limit: "O ERP chegou ao limite deste tipo de cadastro.",
  lot_control_off: "O produto não controla lotes no ERP. Ligue o controle de lotes no cadastro do produto e tente de novo.",
  needs_cutover: "Lotes entram com o saldo na data de corte. Confirme primeiro a data de corte em Passar a operar aqui.",
  conflict: "O registro mudou no ERP e no Bling desde a adoção. Nada foi sobrescrito: escolha qual versão vale.",
  failed: "A adoção deste registro falhou. Tente de novo ou ignore.",
  unlinked: "Foi desligado do Bling por uma pessoa. O que está no ERP ficou; o lote não liga de novo sozinho.",
} as const;
export type BlingExtrasReason = keyof typeof BLING_EXTRAS_REASONS;
export const BLING_EXTRAS_REASON_KEYS = Object.keys(BLING_EXTRAS_REASONS) as BlingExtrasReason[];
/** O que a prévia diz que vai acontecer com cada registro. */
export const BLING_EXTRAS_OUTCOMES = {
  create: "Vai criar no ERP", link: "Vai ligar ao que já existe no ERP", pending: "Fica pendente de revisão", adopted: "Já adotado",
  ignored: "Ignorado", consult: "Só consulta", contract: "Vira contrato de manutenção depois de conferido",
} as const;
export type BlingExtrasOutcome = keyof typeof BLING_EXTRAS_OUTCOMES;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const sourceId = z.string().regex(/^[1-9]\d{0,39}$/);
/** Valores de campo: "products:123" ou "contacts:123" (o registro que traz os valores). */
const extrasKey = z.string().regex(/^(?:(?:products|contacts):)?[1-9]\d{0,39}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const iso = z.string().max(40).nullable();
const summary = z.record(z.string().max(40), z.string().max(400).nullable());
const receipt = z.object({ command_id: id, operation: z.string().max(60), replayed: z.boolean() }).strict();
const entitySchema = z.enum(BLING_EXTRAS_ENTITIES);
const batchSchema = z.enum(BLING_EXTRAS_BATCH);
const twoWaySchema = z.enum(BLING_EXTRAS_TWO_WAY);
const direction = z.enum(["inbound", "outbound"]);
const pageCursor = z.string().regex(/^(?:(?:products|contacts):)?[1-9]\d{0,39}$/);

const entityStatus = z.object({
  entity: entitySchema, label: z.string().max(100), module_names: z.array(z.string().max(60)).max(4), enabled: z.boolean(),
  part_off_message: z.string().max(300).nullable(), proposed_path: z.string().max(200), doubt: z.string().max(300),
  collected: count, adopted: count, pending: count, ignored: count, waiting: count,
}).strict();
const switchState = z.object({ enabled: z.boolean(), since: iso }).strict();
const twoWayStatus = z.object({
  entity: twoWaySchema, label: z.string().max(100), enabled: z.boolean(), part_off_message: z.string().max(300).nullable(),
  inbound: switchState, outbound: switchState, queued: count, uncertain: count, failed: count,
}).strict();
const auditItem = z.object({ at: z.string().max(40), by: z.string().max(200), entity: twoWaySchema, direction, enabled: z.boolean(), detail: z.string().max(600) }).strict();
export const extrasStatusSchema = z.object({
  available: z.boolean(), unavailable_message: z.string().max(300).nullable(), cutover_on: day.nullable(),
  entities: z.array(entityStatus).max(BLING_EXTRAS_ENTITIES.length),
  two_way: z.array(twoWayStatus).max(BLING_EXTRAS_TWO_WAY.length), audit: z.array(auditItem).max(20),
  texts: z.record(z.string().max(40), z.string().max(700)),
}).strict();
export type BlingExtrasStatus = z.infer<typeof extrasStatusSchema>;
export const extrasPreviewItemSchema = z.object({
  source_id: extrasKey, label: z.string().max(200), outcome: z.enum(Object.keys(BLING_EXTRAS_OUTCOMES) as [BlingExtrasOutcome, ...BlingExtrasOutcome[]]),
  outcome_text: z.string().max(80), reason_text: z.string().max(600).nullable(), bling: summary, erp: summary.nullable(), record_id: z.string().max(200).nullable(),
}).strict();
export type BlingExtrasPreviewItem = z.infer<typeof extrasPreviewItemSchema>;
export const extrasReviewSchema = z.object({
  entity: entitySchema, source_id: extrasKey, state: z.enum(["pending", "ignored"]),
  reason: z.enum(BLING_EXTRAS_REASON_KEYS as [BlingExtrasReason, ...BlingExtrasReason[]]), reason_text: z.string().max(300), detail: z.string().max(600).nullable(),
  bling: summary.nullable(), erp: z.array(z.object({ record_id: z.string().max(200), summary }).strict()).max(5),
}).strict();
export type BlingExtrasReview = z.infer<typeof extrasReviewSchema>;
export const extrasInvoiceSchema = z.object({
  source_id: sourceId, number: z.string().max(60).nullable(), series: z.string().max(20).nullable(), issued_on: day.nullable(),
  customer: z.string().max(200).nullable(), total: z.string().max(40).nullable(), situation: z.string().max(80).nullable(), version: z.string().regex(/^[1-9]\d{0,15}$/),
}).strict();
export type BlingExtrasInvoice = z.infer<typeof extrasInvoiceSchema>;
const period = z.enum(["month", "quarter", "year"]);
export const extrasContractDraftSchema = z.object({
  source_id: sourceId, version: z.string().regex(/^[1-9]\d{0,15}$/), number: z.string().max(60).nullable(), description: z.string().max(400).nullable(),
  customer: z.object({ name: z.string().max(200).nullable(), document: z.string().max(40).nullable(), phone: z.string().max(40).nullable(), email: z.string().max(200).nullable() }).strict(),
  starts_on: day.nullable(), ends_on: day.nullable(), value: z.string().max(40).nullable(), periodicity: z.string().max(60).nullable(), period: period.nullable(),
  situation: z.string().max(60).nullable(), problems: z.array(z.string().max(300)).max(10),
  link: z.object({ contract_id: z.string().max(200), number: z.string().max(40).nullable(), linked_at: z.string().max(40) }).strict().nullable(),
}).strict();
export type BlingExtrasContractDraft = z.infer<typeof extrasContractDraftSchema>;

export const BLING_EXTRAS_OUTBOX_STATES = {
  pending: "Na fila", sending: "Enviando", uncertain: "Não deu para confirmar no Bling", done: "Gravado no Bling", failed: "Recusado", superseded: "Substituído por mudança mais nova",
} as const;
export type BlingExtrasOutboxState = keyof typeof BLING_EXTRAS_OUTBOX_STATES;
export const extrasOutboxItemSchema = z.object({
  id, entity: twoWaySchema, label: z.string().max(200), state: z.enum(Object.keys(BLING_EXTRAS_OUTBOX_STATES) as [BlingExtrasOutboxState, ...BlingExtrasOutboxState[]]),
  state_text: z.string().max(80), attempts: count, error_text: z.string().max(600).nullable(), updated_at: iso,
  actions: z.array(z.object({ action: z.enum(["confirm_sent", "resend", "discard"]), label: z.string().max(60) }).strict()).max(3),
}).strict();
export type BlingExtrasOutboxItem = z.infer<typeof extrasOutboxItemSchema>;

export const BLING_EXTRAS_OPERATION_NAMES = [
  "erp_bling_extras_status", "erp_bling_extras_preview", "erp_bling_extras_reviews", "erp_bling_extras_adopt", "erp_bling_extras_resolve",
  "erp_bling_extras_unlink", "erp_bling_extras_invoices", "erp_bling_extras_contracts", "erp_bling_extras_contract_options",
  "erp_bling_extras_outbox", "erp_bling_extras_outbox_resolve",
] as const;
/** Só do administrador, pela tela: fora do inventário dos bots. */
export const BLING_EXTRAS_ADMIN_OPERATION_NAMES = ["erp_bling_extras_contract_create", "erp_bling_extras_contract_link", "erp_bling_extras_switch"] as const;
export type BlingExtrasOperationName = typeof BLING_EXTRAS_OPERATION_NAMES[number] | typeof BLING_EXTRAS_ADMIN_OPERATION_NAMES[number];
/** Rodam no Worker (precisam do módulo Ordem de Serviço do Wabotia); o objeto do ERP recusa. */
export const BLING_EXTRAS_WORKER_OPERATIONS: ReadonlySet<string> = new Set(["erp_bling_extras_contract_options", "erp_bling_extras_contract_create"]);

const page = { cursor: pageCursor.optional(), limit: z.number().int().min(1).max(50).optional() };
export const extrasInputs = {
  erp_bling_extras_status: z.object({}).strict(),
  erp_bling_extras_preview: z.object({ entity: batchSchema, ...page }).strict(),
  erp_bling_extras_reviews: z.object({ entity: entitySchema, state: z.enum(["pending", "ignored"]).optional(), ...page }).strict(),
  erp_bling_extras_adopt: z.object({ command_id: id, entity: batchSchema, source_ids: z.array(extrasKey).min(1).max(25).optional() }).strict()
    .refine(v => !v.source_ids || new Set(v.source_ids).size === v.source_ids.length),
  erp_bling_extras_resolve: z.object({ command_id: id, entity: batchSchema, source_id: extrasKey, action: z.enum(["use_bling", "keep_erp", "ignore"]), record_id: uuid.optional() }).strict()
    .refine(v => v.action !== "keep_erp" || !!v.record_id, "Manter a do ERP exige o registro escolhido.").refine(v => v.action !== "ignore" || !v.record_id),
  erp_bling_extras_unlink: z.object({ command_id: id, entity: batchSchema, source_id: extrasKey }).strict(),
  erp_bling_extras_invoices: z.object({ q: z.string().trim().min(1).max(80).optional(), from: day.optional(), to: day.optional(), cursor: sourceId.optional(), limit: z.number().int().min(1).max(50).optional() }).strict()
    .refine(v => !v.from || !v.to || v.from <= v.to, "A data inicial vem antes da final."),
  erp_bling_extras_contracts: z.object({ cursor: sourceId.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_extras_contract_options: z.object({ source_id: sourceId, q: z.string().trim().min(1).max(80).optional() }).strict(),
  erp_bling_extras_outbox: z.object({ state: z.enum(["open", "done", "all"]).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_extras_outbox_resolve: z.object({ command_id: id, id, action: z.enum(["confirm_sent", "resend", "discard"]) }).strict(),
  erp_bling_extras_contract_create: z.object({ command_id: id, source_id: sourceId, version: z.string().regex(/^[1-9]\d{0,15}$/), contact_id: uuid, plan_id: uuid,
    visits_per_period: z.number().int().min(1).max(999), period }).strict(),
  erp_bling_extras_contract_link: z.object({ command_id: id, source_id: sourceId, version: z.string().regex(/^[1-9]\d{0,15}$/), contract_id: uuid, number: z.string().max(40).optional() }).strict(),
  erp_bling_extras_switch: z.object({ command_id: id, entity: twoWaySchema, direction, enabled: z.boolean(), acknowledged: z.boolean().optional() }).strict()
    .refine(v => !v.enabled || v.acknowledged === true, "Ligar pede o aviso confirmado."),
} as const;
const counts = z.object({ processed: count, adopted: count, linked: count, pending: count, skipped: count }).strict();
export const extrasOutputs = {
  erp_bling_extras_status: extrasStatusSchema,
  erp_bling_extras_preview: z.object({ items: z.array(extrasPreviewItemSchema).max(50), next_cursor: pageCursor.nullable(), notice: z.string().max(700) }).strict(),
  erp_bling_extras_reviews: z.object({ items: z.array(extrasReviewSchema).max(50), next_cursor: pageCursor.nullable() }).strict(),
  erp_bling_extras_adopt: z.object({ counts, more: z.boolean(), messages: z.array(z.string().max(300)).max(25), receipt }).strict(),
  erp_bling_extras_resolve: z.object({ outcome: z.enum(["adopted", "linked", "updated", "ignored"]), record_id: z.string().max(200).nullable(), receipt }).strict(),
  erp_bling_extras_unlink: z.object({ record_id: z.string().max(200), receipt }).strict(),
  erp_bling_extras_invoices: z.object({ items: z.array(extrasInvoiceSchema).max(50), next_cursor: sourceId.nullable(), read_only_message: z.string().max(400) }).strict(),
  erp_bling_extras_contracts: z.object({ items: z.array(extrasContractDraftSchema).max(50), next_cursor: sourceId.nullable() }).strict(),
  erp_bling_extras_contract_options: z.object({
    draft: extrasContractDraftSchema,
    modules: z.object({ os: z.boolean(), mensalidade: z.boolean() }).strict(), missing: z.string().max(300).nullable(),
    plans: z.array(z.object({ id: z.string().max(200), name: z.string().max(200), amount_cents: count, period_label: z.string().max(80) }).strict()).max(200),
    contacts: z.array(z.object({ id: z.string().max(200), name: z.string().max(200), phone: z.string().max(40).nullable() }).strict()).max(20),
  }).strict(),
  erp_bling_extras_outbox: z.object({ items: z.array(extrasOutboxItemSchema).max(50) }).strict(),
  erp_bling_extras_outbox_resolve: z.object({ outcome: z.enum(["confirmed", "queued", "discarded"]), message: z.string().max(400), receipt }).strict(),
  erp_bling_extras_contract_create: z.object({ outcome: z.enum(["created", "linked"]), contract_id: z.string().max(200), number: z.string().max(40).nullable(), message: z.string().max(400) }).strict(),
  erp_bling_extras_contract_link: z.object({ record_id: z.string().max(200), receipt }).strict(),
  erp_bling_extras_switch: z.object({ entity: twoWaySchema, direction, enabled: z.boolean(), since: iso, receipt }).strict(),
} as const;
type IO<K extends BlingExtrasOperationName> = { input: z.infer<typeof extrasInputs[K]>; output: z.infer<typeof extrasOutputs[K]> };
export type BlingExtrasOperationMap = { [K in BlingExtrasOperationName]: IO<K> };

type Descriptor = { name: BlingExtrasOperationName; method: "GET" | "POST"; path: string; summary: string; description: string; sensitive: boolean };
const op = (name: BlingExtrasOperationName, method: "GET" | "POST", path: string, summary: string, description: string, sensitive: boolean): Descriptor =>
  Object.freeze({ name, method, path, summary, description, sensitive });
/** Operações que os bots podem receber (grupo bling). */
export const BLING_EXTRAS_OPERATIONS = Object.freeze({
  erp_bling_extras_status: op("erp_bling_extras_status", "GET", "/outros", "Consultar os outros dados do Bling",
    "Mostra, para listas de preços, naturezas de operação, campos customizados, fornecedores e lotes de produto, contratos e notas de serviço, quantos foram coletados, adotados, estão pendentes ou ignorados, qual módulo ligar quando falta, e como está a mão dupla das listas e dos campos. Só consulta.", false),
  erp_bling_extras_preview: op("erp_bling_extras_preview", "GET", "/outros/previa", "Ver a prévia da adoção de outros dados do Bling",
    "Mostra, registro a registro, o que a adoção vai fazer (criar, ligar ao que já existe ou deixar pendente, com o motivo), com o registro do Bling e o do ERP lado a lado. Nada é gravado. Pode conter nomes de contatos.", true),
  erp_bling_extras_reviews: op("erp_bling_extras_reviews", "GET", "/outros/pendencias", "Listar pendências da adoção de outros dados do Bling",
    "Lista os registros que não puderam ser adotados sozinhos, com o motivo em palavras e as duas versões lado a lado. Pode conter dados pessoais.", true),
  erp_bling_extras_adopt: op("erp_bling_extras_adopt", "POST", "/outros/adotar", "Adotar outros dados do Bling",
    "Adota os registros conferidos na prévia (ou o próximo pedaço, até 25) pelas mesmas funções das telas do ERP: listas de preços, naturezas de operação (sem trocar a padrão), campos customizados e seus valores, fornecedores e lotes de produto. Não duplica: repetir não cria de novo. Nada é escrito no Bling.", true),
  erp_bling_extras_resolve: op("erp_bling_extras_resolve", "POST", "/outros/pendencias/resolver", "Resolver uma pendência de outros dados do Bling",
    "Decide uma pendência: usar a do Bling (cria ou atualiza no ERP), manter a do ERP e ligar, ou ignorar o registro.", true),
  erp_bling_extras_unlink: op("erp_bling_extras_unlink", "POST", "/outros/desligar", "Desligar um registro adotado do Bling",
    "Remove só o vínculo entre o registro do ERP e o do Bling. O que está no ERP continua como está.", true),
  erp_bling_extras_invoices: op("erp_bling_extras_invoices", "GET", "/outros/nfse", "Consultar notas de serviço emitidas no Bling",
    "Lista as NFS-e coletadas do Bling por período, número ou tomador, só para consulta: não viram emissão nem podem ser canceladas por aqui. Contém nomes de clientes.", true),
  erp_bling_extras_contracts: op("erp_bling_extras_contracts", "GET", "/outros/contratos", "Listar contratos coletados do Bling",
    "Lista os contratos do Bling como vieram (cliente, vigência, valor e periodicidade), o que falta conferir e se já viraram contrato de manutenção. Contém dados de clientes.", true),
  erp_bling_extras_contract_options: op("erp_bling_extras_contract_options", "GET", "/outros/contratos/opcoes", "Preparar um contrato de manutenção a partir do Bling",
    "Mostra o contrato do Bling conferido, se os módulos Ordem de Serviço e Mensalidade estão ligados, os planos da Mensalidade e os clientes do atendimento com o mesmo telefone ou nome. Nada é gravado.", true),
  erp_bling_extras_outbox: op("erp_bling_extras_outbox", "GET", "/outros/mao-dupla/fila", "Listar a fila de saída das listas e dos campos",
    "Lista o que está na fila para ser gravado no Bling (listas de preços e campos customizados), com a situação de cada envio e o motivo quando o Bling recusou.", true),
  erp_bling_extras_outbox_resolve: op("erp_bling_extras_outbox_resolve", "POST", "/outros/mao-dupla/fila/resolver", "Resolver um envio das listas e dos campos",
    "Num envio que não deu para confirmar, diz se entrou no Bling ou manda de novo; num envio recusado, manda de novo ou deixa como está. Envio incerto nunca é repetido sozinho.", true),
} satisfies Record<typeof BLING_EXTRAS_OPERATION_NAMES[number], Descriptor>);
export const BLING_EXTRAS_ADMIN_OPERATIONS = Object.freeze({
  erp_bling_extras_contract_create: op("erp_bling_extras_contract_create", "POST", "/outros/contratos/criar", "Criar o contrato de manutenção a partir do Bling",
    "Cria, pela função do módulo Ordem de Serviço, o contrato de manutenção do contrato do Bling conferido: cliente, vigência, plano da Mensalidade e cobertura. A cobrança recorrente nasce desligada. Só o administrador, pela tela.", true),
  erp_bling_extras_contract_link: op("erp_bling_extras_contract_link", "POST", "/outros/contratos/vincular", "Ligar um contrato do Bling a um contrato de manutenção",
    "Liga o contrato do Bling a um contrato de manutenção que já existe, sem criar outro. Só o administrador, pela tela.", true),
  erp_bling_extras_switch: op("erp_bling_extras_switch", "POST", "/outros/mao-dupla/interruptor", "Ligar ou desligar a mão dupla das listas e dos campos",
    "Liga ou desliga, para listas de preços ou campos customizados e um sentido, o recebimento das mudanças do Bling ou a escrita de volta no Bling. Ligar pede o aviso confirmado e fica registrado. Só o administrador, pela tela.", true),
} satisfies Record<typeof BLING_EXTRAS_ADMIN_OPERATION_NAMES[number], Descriptor>);

const command = { type: "string", description: "Identificador único do pedido, para repetir sem duplicar." };
const batchParam = { type: "string", enum: [...BLING_EXTRAS_BATCH], description: "Tipo de registro." };
const keyParam = { type: "string", pattern: "^((products|contacts):)?[1-9][0-9]{0,39}$", description: "Id no Bling (valores de campo: products:id ou contacts:id)." };
const pageParams = { cursor: { type: "string", description: "Continuação da página anterior." }, limit: { type: "integer", minimum: 1, maximum: 50 } };
type Params = { type: "object"; properties: Record<string, unknown>; required: string[] };
const params = (properties: Record<string, unknown>, required: string[] = []): Params => Object.freeze({ type: "object" as const, properties, required });
export const BLING_EXTRAS_PARAMS: Readonly<Record<BlingExtrasOperationName, Params>> = Object.freeze({
  erp_bling_extras_status: params({}),
  erp_bling_extras_preview: params({ entity: batchParam, ...pageParams }, ["entity"]),
  erp_bling_extras_reviews: params({ entity: { type: "string", enum: [...BLING_EXTRAS_ENTITIES] }, state: { type: "string", enum: ["pending", "ignored"] }, ...pageParams }, ["entity"]),
  erp_bling_extras_adopt: params({ command_id: command, entity: batchParam, source_ids: { type: "array", items: keyParam, minItems: 1, maxItems: 25, description: "Os conferidos na prévia; sem a lista, o próximo pedaço." } }, ["command_id", "entity"]),
  erp_bling_extras_resolve: params({ command_id: command, entity: batchParam, source_id: keyParam, action: { type: "string", enum: ["use_bling", "keep_erp", "ignore"] },
    record_id: { type: "string", format: "uuid", description: "Registro do ERP escolhido (manter a do ERP)." } }, ["command_id", "entity", "source_id", "action"]),
  erp_bling_extras_unlink: params({ command_id: command, entity: batchParam, source_id: keyParam }, ["command_id", "entity", "source_id"]),
  erp_bling_extras_invoices: params({ q: { type: "string", maxLength: 80, description: "Número ou nome do tomador." }, from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, ...pageParams }),
  erp_bling_extras_contracts: params({ ...pageParams }),
  erp_bling_extras_contract_options: params({ source_id: { type: "string", pattern: "^[1-9][0-9]{0,39}$" }, q: { type: "string", maxLength: 80, description: "Nome ou telefone para achar o cliente." } }, ["source_id"]),
  erp_bling_extras_outbox: params({ state: { type: "string", enum: ["open", "done", "all"] }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  erp_bling_extras_outbox_resolve: params({ command_id: command, id: { type: "string", description: "Id do envio, como veio na fila." }, action: { type: "string", enum: ["confirm_sent", "resend", "discard"] } }, ["command_id", "id", "action"]),
  // Só do administrador: descritas para o contrato, fora do inventário dos bots.
  erp_bling_extras_contract_create: params({ command_id: command, source_id: { type: "string" }, version: { type: "string" }, contact_id: { type: "string", format: "uuid" }, plan_id: { type: "string", format: "uuid" },
    visits_per_period: { type: "integer", minimum: 1, maximum: 999 }, period: { type: "string", enum: ["month", "quarter", "year"] } }, ["command_id", "source_id", "version", "contact_id", "plan_id", "visits_per_period", "period"]),
  erp_bling_extras_contract_link: params({ command_id: command, source_id: { type: "string" }, version: { type: "string" }, contract_id: { type: "string", format: "uuid" }, number: { type: "string" } }, ["command_id", "source_id", "version", "contract_id"]),
  erp_bling_extras_switch: params({ command_id: command, entity: { type: "string", enum: [...BLING_EXTRAS_TWO_WAY] }, direction: { type: "string", enum: ["inbound", "outbound"] },
    enabled: { type: "boolean" }, acknowledged: { type: "boolean", description: "Aviso confirmado (obrigatório para ligar)." } }, ["command_id", "entity", "direction", "enabled"]),
});
