/** Fatia C, o corte: a pessoa escolhe a data a partir da qual o ERP passa a
 * valer, e as etapas que fecham a passagem (contas parciais, saldos de
 * abertura, estoque de abertura, notas emitidas no Bling, pacote do contador,
 * conferência final e conflitos depois do corte). Contrato puro, no mesmo
 * registro das operações de adoção (adoption-contracts.ts junta os dois):
 * tela, Worker, objeto e bots usam os mesmos nomes. Nada aqui escreve no Bling. */
import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const sourceId = z.string().regex(/^[1-9]\d{0,39}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cents = z.string().regex(/^-?\d{1,18}$/);
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const text = (max: number) => z.string().max(max);
const maybe = (max: number) => z.string().max(max).nullable();
const iso = z.string().max(40).nullable();
const receipt = z.object({ command_id: id, operation: z.string().max(60), replayed: z.boolean() }).strict();
const command = { command_id: id };
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Avisos fixos da tela (o que cada etapa não faz). */
export const BLING_CUTOVER_TEXTS = Object.freeze({
  date: "A partir da data de corte o ERP passa a valer: o que estava em aberto no Bling nesse dia vira documento, conta, saldo ou estoque do ERP; o que já estava encerrado fica no histórico, só para consulta. A conta do Bling continua viva em paralelo e nada é escrito nela.",
  partials: "Contas com baixa parcial entram no ERP pelo saldo que falta pagar ou receber. O valor original, o que já foi pago e a origem ficam anotados na conta; as baixas antigas não são recriadas.",
  balances: "O saldo de abertura de cada conta financeira entra uma vez só, como um lançamento de saldo inicial na data de corte. Confira ou corrija o valor antes de gravar.",
  stock: "O estoque de abertura entra como um lançamento de abertura por depósito, com o saldo observado no Bling. Movimentos antigos, lotes e reservas do Bling não são recriados.",
  invoices: "Notas emitidas no Bling (só consulta). Elas não viram emissão nova, não podem ser canceladas nem corrigidas por aqui. Use a chave de acesso para devoluções e para o contador.",
  package: "O pacote do contador junta os XML das notas do mês e uma planilha (CSV) com chave, número, série, data, valor e situação. Ele é montado aos poucos e fica guardado para download pelo administrador.",
  report: "A conferência compara o Bling e o ERP entidade por entidade e em dinheiro. O corte só fica concluído quando cada diferença está resolvida ou justificada por escrito.",
  conflicts: "Depois do corte, o que mudar no Bling num registro já adotado não muda o ERP sozinho: aparece aqui para você decidir.",
});

export const BLING_CUTOVER_STEPS = ["adoption", "partials", "balances", "stock", "invoices", "package", "report"] as const;
export type BlingCutoverStep = typeof BLING_CUTOVER_STEPS[number];

// ---------------------------------------------------------------------------
// Saídas

export const cutoverStateSchema = z.object({
  state: z.enum(["none", "confirmed", "concluded"]), cutover_on: day.nullable(), confirmed_at: iso, concluded_at: iso,
  revision: z.string().regex(/^(0|[1-9]\d{0,15})$/),
  /** A data ainda pode mudar: nenhuma etapa gravou nada no ERP. */
  can_change_date: z.boolean(),
}).strict();
export type BlingCutoverState = z.infer<typeof cutoverStateSchema>;
const stepSchema = z.object({
  key: z.enum(BLING_CUTOVER_STEPS), label: text(100), module_name: text(60), enabled: z.boolean(), part_off_message: maybe(300),
  done: z.boolean(), summary: text(300),
}).strict();
const missingSchema = z.object({
  entity: text(40), label: text(100), enabled: z.boolean(), part_off_message: maybe(300), waiting: count, pending: count, ignored: count,
}).strict();
const checkSchema = z.object({ key: text(40), label: text(200), ok: z.boolean(), message: text(400) }).strict();
export const cutoverStatusSchema = z.object({
  cutover: cutoverStateSchema, proposed_on: day.nullable(), today: day,
  missing: z.array(missingSchema).max(20), steps: z.array(stepSchema).max(10), checks: z.array(checkSchema).max(20),
  conflicts: count, texts: z.record(z.string().max(40), z.string().max(600)),
}).strict();
export type BlingCutoverStatus = z.infer<typeof cutoverStatusSchema>;

const scope = z.enum(["paid", "cancelled", "returned", "other"]);
const accountEntity = z.enum(["receivables", "payables"]);
export const cutoverAccountsSummarySchema = z.object({
  rows: z.array(z.object({ entity: accountEntity, month: month.nullable(), category: text(200), scope, count, total_cents: cents }).strict()).max(3000),
  totals: z.array(z.object({ entity: accountEntity, scope, count, total_cents: cents }).strict()).max(20),
  /** Os mesmos totais contados direto do acervo: precisam bater com o resumo. */
  acervo: z.array(z.object({ entity: accountEntity, scope, count, total_cents: cents }).strict()).max(20),
  matches: z.boolean(), truncated: z.boolean(),
  partials: z.array(z.object({ entity: accountEntity, count, balance_cents: cents, adopted: count, pending: count, waiting: count }).strict()).max(2),
}).strict();
const partialItem = z.object({
  entity: accountEntity, source_id: sourceId, number: maybe(150), contact_name: maybe(200), due_on: day.nullable(),
  amount_cents: cents.nullable(), paid_cents: cents.nullable(), balance_cents: cents.nullable(),
  state: z.enum(["waiting", "adopted", "pending"]), detail: maybe(300), record_id: maybe(200),
}).strict();
export type BlingCutoverPartial = z.infer<typeof partialItem>;
const balanceItem = z.object({
  source_id: sourceId, record_id: text(200), name: maybe(200),
  computed_cents: cents.nullable(), computed_entries: count, computed_note: text(300),
  erp_cents_at_cutover: cents, state: z.enum(["waiting", "posted"]),
  posted_cents: cents.nullable(), entry_cents: cents.nullable(), posted_on: day.nullable(), posted_at: iso,
}).strict();
export type BlingCutoverBalance = z.infer<typeof balanceItem>;
const issue = z.enum(["no_product", "no_warehouse", "negative", "unsupported", "difference", "invalid"]);
const warehouseItem = z.object({
  source_id: sourceId, record_id: maybe(200), name: maybe(200), products: count, ready: count,
  without_product: count, negatives: count, differences: count, unsupported: count,
  valued_cents: cents.nullable(), state: z.enum(["waiting", "partial", "posted", "blocked"]), posted_lines: count,
  preview_hash: hash, movements: z.array(text(200)).max(500),
}).strict();
export type BlingCutoverWarehouse = z.infer<typeof warehouseItem>;
const stockLine = z.object({
  product_source_id: sourceId, product_id: maybe(200), name: maybe(200), code: maybe(100), target: text(40), erp_now: maybe(40), delta: maybe(40),
  unit_cost: maybe(40), issue: issue.nullable(), issue_text: maybe(300), state: z.enum(["waiting", "posted", "skipped"]),
}).strict();
export type BlingCutoverStockLine = z.infer<typeof stockLine>;
const invoiceItem = z.object({
  entity: z.enum(["nfe", "nfce"]), source_id: sourceId, number: maybe(40), series: maybe(10), access_key: maybe(60), issued_on: day.nullable(),
  contact_name: maybe(200), contact_document: maybe(40), total_cents: cents.nullable(), situation: maybe(120), direction: maybe(40), has_xml: z.boolean(),
}).strict();
export type BlingCutoverInvoice = z.infer<typeof invoiceItem>;
const packageItem = z.object({
  month, state: z.enum(["running", "done", "failed"]), notes: count, with_xml: count, without_xml: count, bytes: count, parts: count,
  updated_at: iso, error: maybe(300), filename: maybe(120),
}).strict();
export type BlingCutoverPackage = z.infer<typeof packageItem>;
const justification = z.object({ text: text(2000), by: text(200), at: text(40) }).strict();
const difference = z.object({
  key: text(200), kind: text(40), label: text(300), count, cents: cents.nullable(), explanation: text(600),
  justified: z.boolean(), justification: justification.nullable(),
  items: z.array(z.object({ key: text(200), label: text(300), detail: maybe(300), justified: z.boolean() }).strict()).max(20),
}).strict();
export type BlingCutoverDifference = z.infer<typeof difference>;
const conflictItem = z.object({
  entity: text(40), source_id: sourceId, label: text(200), from_version: text(20), to_version: text(20), changed_at: iso,
  record_id: text(200), bling: z.record(z.string().max(40), z.string().max(400).nullable()).nullable(),
  erp: z.record(z.string().max(40), z.string().max(400).nullable()).nullable(), can_use_bling: z.boolean(),
}).strict();
export type BlingCutoverConflict = z.infer<typeof conflictItem>;

// ---------------------------------------------------------------------------
// Operações

export const BLING_CUTOVER_OPERATION_NAMES = [
  "erp_bling_cutover_status", "erp_bling_cutover_confirm",
  "erp_bling_cutover_accounts_summary", "erp_bling_cutover_partials", "erp_bling_cutover_partials_adopt",
  "erp_bling_cutover_balances", "erp_bling_cutover_balance_post",
  "erp_bling_cutover_stock", "erp_bling_cutover_stock_post",
  "erp_bling_cutover_invoices", "erp_bling_cutover_invoice_get",
  "erp_bling_cutover_packages", "erp_bling_cutover_package_start", "erp_bling_cutover_package_download",
  "erp_bling_cutover_report", "erp_bling_cutover_justify", "erp_bling_cutover_conclude",
  "erp_bling_cutover_conflicts", "erp_bling_cutover_conflict_resolve",
] as const;
export type BlingCutoverOperationName = typeof BLING_CUTOVER_OPERATION_NAMES[number];

const historyLike = z.string().regex(/^(\d{4}-\d{2}-\d{2}|0)\.[1-9]\d{0,39}$/);
const conflictCursor = z.string().regex(/^[a-z_]{1,40}:[1-9]\d{0,39}$/);
export const cutoverInputs = {
  erp_bling_cutover_status: z.object({ cutover_on: day.optional() }).strict(),
  erp_bling_cutover_confirm: z.object({ ...command, cutover_on: day, acknowledged: z.literal(true) }).strict(),
  erp_bling_cutover_accounts_summary: z.object({}).strict(),
  erp_bling_cutover_partials: z.object({ entity: accountEntity, state: z.enum(["waiting", "adopted", "pending"]).optional(),
    cursor: sourceId.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_cutover_partials_adopt: z.object(command).strict(),
  erp_bling_cutover_balances: z.object({}).strict(),
  erp_bling_cutover_balance_post: z.object({ ...command, source_id: sourceId, confirmed_cents: cents, computed_cents: cents.nullable() }).strict(),
  erp_bling_cutover_stock: z.object({ warehouse: sourceId.optional(), only_issues: z.enum(["sim", "nao"]).optional(),
    cursor: sourceId.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_cutover_stock_post: z.object({ ...command, warehouse: sourceId, preview_hash: hash }).strict(),
  erp_bling_cutover_invoices: z.object({ entity: z.enum(["nfe", "nfce"]).optional(), q: z.string().trim().min(1).max(80).optional(),
    from: day.optional(), to: day.optional(), cursor: historyLike.optional(), limit: z.number().int().min(1).max(50).optional() }).strict()
    .refine(v => !v.from || !v.to || v.from <= v.to, "A data inicial vem antes da final."),
  erp_bling_cutover_invoice_get: z.object({ entity: z.enum(["nfe", "nfce"]), source_id: sourceId }).strict(),
  erp_bling_cutover_packages: z.object({}).strict(),
  erp_bling_cutover_package_start: z.object({ ...command, month }).strict(),
  erp_bling_cutover_package_download: z.object({ month }).strict(),
  erp_bling_cutover_report: z.object({}).strict(),
  erp_bling_cutover_justify: z.object({ ...command, key: z.string().min(3).max(200).regex(/^[a-z_]+(:[A-Za-z0-9_.-]+)*$/), text: z.string().trim().min(5).max(2000) }).strict(),
  erp_bling_cutover_conclude: z.object(command).strict(),
  erp_bling_cutover_conflicts: z.object({ cursor: conflictCursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_cutover_conflict_resolve: z.object({ ...command, entity: z.string().regex(/^[a-z_]{1,40}$/), source_id: sourceId, action: z.enum(["keep_erp", "use_bling"]) }).strict(),
} as const;

export const cutoverOutputs = {
  erp_bling_cutover_status: cutoverStatusSchema,
  erp_bling_cutover_confirm: z.object({ cutover: cutoverStateSchema, receipt }).strict(),
  erp_bling_cutover_accounts_summary: cutoverAccountsSummarySchema,
  erp_bling_cutover_partials: z.object({ items: z.array(partialItem).max(50), next_cursor: z.string().nullable() }).strict(),
  erp_bling_cutover_partials_adopt: z.object({ processed: count, adopted: count, pending: count, remaining: count, receipt }).strict(),
  erp_bling_cutover_balances: z.object({ cutover_on: day, items: z.array(balanceItem).max(500) }).strict(),
  erp_bling_cutover_balance_post: z.object({ item: balanceItem, receipt }).strict(),
  erp_bling_cutover_stock: z.object({ cutover_on: day, negative_allowed: z.boolean(), warehouses: z.array(warehouseItem).max(500),
    lines: z.object({ warehouse: sourceId, items: z.array(stockLine).max(50), next_cursor: z.string().nullable() }).strict().nullable() }).strict(),
  erp_bling_cutover_stock_post: z.object({ warehouse: warehouseItem, posted_lines: count, remaining: count, movement_id: z.string().max(200).nullable(), receipt }).strict(),
  erp_bling_cutover_invoices: z.object({ items: z.array(invoiceItem).max(50), next_cursor: historyLike.nullable(), read_only_message: text(400) }).strict(),
  erp_bling_cutover_invoice_get: z.object({ item: invoiceItem, fields: z.record(z.string().max(60), z.string().max(400).nullable()), read_only_message: text(400),
    xml: z.object({ available: z.boolean(), text: z.string().max(2_000_000).nullable(), sha256: z.string().max(64).nullable(), filename: maybe(120), note: maybe(300) }).strict() }).strict(),
  erp_bling_cutover_packages: z.object({ items: z.array(packageItem).max(400) }).strict(),
  erp_bling_cutover_package_start: z.object({ package: packageItem, receipt }).strict(),
  /** O download devolve o arquivo compactado, não JSON. */
  erp_bling_cutover_package_download: z.never(),
  erp_bling_cutover_report: z.object({
    cutover: cutoverStateSchema,
    entities: z.array(z.object({ key: text(40), label: text(100), bling: count, adopted: count, history: count, pending: count, ignored: count, waiting: count }).strict()).max(30),
    money: z.array(z.object({ key: text(40), label: text(100), bling_cents: cents, erp_cents: cents, difference_cents: cents, explanation: text(600) }).strict()).max(10),
    differences: z.array(difference).max(60), blocking: count, can_conclude: z.boolean(),
  }).strict(),
  erp_bling_cutover_justify: z.object({ key: text(200), receipt }).strict(),
  erp_bling_cutover_conclude: z.object({ cutover: cutoverStateSchema, receipt }).strict(),
  erp_bling_cutover_conflicts: z.object({ items: z.array(conflictItem).max(50), next_cursor: z.string().nullable(), total: count }).strict(),
  erp_bling_cutover_conflict_resolve: z.object({ outcome: z.enum(["kept", "updated"]), receipt }).strict(),
} as const;
export type BlingCutoverOperationMap = {
  [K in BlingCutoverOperationName]: { input: z.infer<typeof cutoverInputs[K]>; output: z.infer<typeof cutoverOutputs[K]> };
};

export interface BlingCutoverOperationDescriptor {
  name: BlingCutoverOperationName; method: "GET" | "POST"; path: string; summary: string; description: string; sensitive: boolean;
}
const op = (name: BlingCutoverOperationName, method: "GET" | "POST", path: string, summary: string, description: string, sensitive: boolean): BlingCutoverOperationDescriptor =>
  Object.freeze({ name, method, path, summary, description, sensitive });
/** Todas exigem administrador do ERP; só a consulta do andamento não é sensível. */
export const BLING_CUTOVER_OPERATIONS: Readonly<Record<BlingCutoverOperationName, BlingCutoverOperationDescriptor>> = Object.freeze({
  erp_bling_cutover_status: op("erp_bling_cutover_status", "GET", "/corte", "Consultar a passagem para operar no ERP",
    "Mostra a data de corte (proposta ou confirmada), o que ainda falta adotar do Bling, a conferência antes de confirmar e o andamento de cada etapa do corte, com o módulo a ligar quando uma parte está desligada.", false),
  erp_bling_cutover_confirm: op("erp_bling_cutover_confirm", "POST", "/corte/confirmar", "Confirmar a data de corte",
    "Confirma a data a partir da qual o ERP passa a valer. Sem ela nenhuma etapa do corte roda. Enquanto nenhuma etapa gravou nada, a data pode ser confirmada de novo com outro dia.", true),
  erp_bling_cutover_accounts_summary: op("erp_bling_cutover_accounts_summary", "GET", "/corte/contas/resumo", "Resumo das contas pagas e canceladas do Bling",
    "Soma, por mês e por categoria, as contas a receber e a pagar que ficaram no histórico (pagas, canceladas, devolvidas) e confere com os totais do acervo; mostra também as contas parciais.", true),
  erp_bling_cutover_partials: op("erp_bling_cutover_partials", "GET", "/corte/contas/parciais", "Listar contas parciais do Bling",
    "Lista as contas com baixa parcial no Bling: valor original, quanto já foi pago, o saldo que falta e se já entrou no ERP. Contém nomes de clientes e fornecedores.", true),
  erp_bling_cutover_partials_adopt: op("erp_bling_cutover_partials_adopt", "POST", "/corte/contas/parciais/adotar", "Adotar contas parciais pelo saldo",
    "Cria no ERP, pela tela de contas, um título pelo saldo que falta de cada conta parcial, com o valor original, o pago e a origem anotados. Não recria baixas antigas. Repetir não duplica.", true),
  erp_bling_cutover_balances: op("erp_bling_cutover_balances", "GET", "/corte/saldos", "Saldos de abertura das contas financeiras",
    "Para cada conta financeira adotada, o saldo na data de corte calculado dos lançamentos de caixa coletados (quando houver) e o saldo do ERP nessa data.", true),
  erp_bling_cutover_balance_post: op("erp_bling_cutover_balance_post", "POST", "/corte/saldos/gravar", "Gravar o saldo de abertura de uma conta",
    "Grava, uma vez só, o lançamento de saldo inicial da conta na data de corte com o valor confirmado ou corrigido pela pessoa.", true),
  erp_bling_cutover_stock: op("erp_bling_cutover_stock", "GET", "/corte/estoque", "Prévia do estoque de abertura",
    "Mostra, por depósito, o saldo observado no Bling de cada produto, os produtos sem cadastro adotado, saldos negativos, diferenças com o ERP e o estoque valorizado pelo custo quando o acervo tem.", true),
  erp_bling_cutover_stock_post: op("erp_bling_cutover_stock_post", "POST", "/corte/estoque/gravar", "Gravar o estoque de abertura de um depósito",
    "Lança o estoque de abertura do depósito na data de corte, pela mesma regra dos lançamentos de estoque do ERP. Não recria movimentos antigos, lotes nem reservas. Repetir não duplica.", true),
  erp_bling_cutover_invoices: op("erp_bling_cutover_invoices", "GET", "/corte/notas", "Notas emitidas no Bling",
    "Lista as NF-e e NFC-e emitidas no Bling, só para consulta, por período, número, chave de acesso e destinatário. Contém dados de clientes.", true),
  erp_bling_cutover_invoice_get: op("erp_bling_cutover_invoice_get", "GET", "/corte/notas/nota", "Abrir uma nota emitida no Bling",
    "Mostra o resumo e o XML de uma nota emitida no Bling. Só consulta: não pode ser cancelada nem corrigida por aqui.", true),
  erp_bling_cutover_packages: op("erp_bling_cutover_packages", "GET", "/corte/contador", "Pacotes do contador",
    "Lista os pacotes mensais de XML do período antigo para o contador, com o andamento e o tamanho.", true),
  erp_bling_cutover_package_start: op("erp_bling_cutover_package_start", "POST", "/corte/contador/gerar", "Gerar o pacote do contador de um mês",
    "Monta, aos poucos, um arquivo compactado com os XML das notas do mês e uma planilha índice, e guarda para download do administrador. Pedir de novo refaz o pacote.", true),
  erp_bling_cutover_package_download: op("erp_bling_cutover_package_download", "GET", "/corte/contador/arquivo", "Baixar o pacote do contador",
    "Baixa o arquivo compactado do mês (XML e planilha índice).", true),
  erp_bling_cutover_report: op("erp_bling_cutover_report", "GET", "/corte/conferencia", "Conferência final do corte",
    "Relatório do corte: por entidade, quantos no Bling, adotados, no histórico e pendentes; totais em dinheiro dos dois lados e as diferenças explicadas item a item, com as justificativas.", true),
  erp_bling_cutover_justify: op("erp_bling_cutover_justify", "POST", "/corte/conferencia/justificar", "Justificar uma diferença do corte",
    "Registra, com texto, por que uma diferença da conferência pode ficar como está.", true),
  erp_bling_cutover_conclude: op("erp_bling_cutover_conclude", "POST", "/corte/concluir", "Concluir o corte",
    "Conclui o corte quando não há diferença sem justificativa. Guarda a fotografia da conferência.", true),
  erp_bling_cutover_conflicts: op("erp_bling_cutover_conflicts", "GET", "/corte/conflitos", "Mudanças no Bling depois do corte",
    "Lista registros já adotados que mudaram no Bling depois da adoção, com as duas versões lado a lado. O ERP não muda sozinho.", true),
  erp_bling_cutover_conflict_resolve: op("erp_bling_cutover_conflict_resolve", "POST", "/corte/conflitos/resolver", "Decidir uma mudança do Bling",
    "Mantém o ERP como está ou, nos cadastros que aceitam, aplica a versão nova do Bling pela tela do cadastro.", true),
});

const id40 = { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "Id do registro no Bling." };
const commandParam = { type: "string", description: "Identificador único do pedido, para repetir sem duplicar." };
const dateParam = { type: "string", format: "date" };
const monthParam = { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$", description: "Mês no formato AAAA-MM." };
const centsParam = { type: "string", pattern: "^-?[0-9]{1,18}$", description: "Valor em centavos." };
const limit = { type: "integer", minimum: 1, maximum: 50 };
type Params = { type: "object"; properties: Record<string, unknown>; required: string[] };
const params = (properties: Record<string, unknown>, required: string[] = []): Params => Object.freeze({ type: "object" as const, properties, required });
/** Parâmetros no formato do inventário dos bots. */
export const BLING_CUTOVER_PARAMS: Readonly<Record<BlingCutoverOperationName, Params>> = Object.freeze({
  erp_bling_cutover_status: params({ cutover_on: dateParam }),
  erp_bling_cutover_confirm: params({ command_id: commandParam, cutover_on: dateParam, acknowledged: { type: "boolean", const: true } }, ["command_id", "cutover_on", "acknowledged"]),
  erp_bling_cutover_accounts_summary: params({}),
  erp_bling_cutover_partials: params({ entity: { type: "string", enum: ["receivables", "payables"] }, state: { type: "string", enum: ["waiting", "adopted", "pending"] }, cursor: { type: "string" }, limit }, ["entity"]),
  erp_bling_cutover_partials_adopt: params({ command_id: commandParam }, ["command_id"]),
  erp_bling_cutover_balances: params({}),
  erp_bling_cutover_balance_post: params({ command_id: commandParam, source_id: id40, confirmed_cents: centsParam, computed_cents: { ...centsParam, nullable: true } }, ["command_id", "source_id", "confirmed_cents", "computed_cents"]),
  erp_bling_cutover_stock: params({ warehouse: id40, only_issues: { type: "string", enum: ["sim", "nao"] }, cursor: { type: "string" }, limit }),
  erp_bling_cutover_stock_post: params({ command_id: commandParam, warehouse: id40, preview_hash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["command_id", "warehouse", "preview_hash"]),
  erp_bling_cutover_invoices: params({ entity: { type: "string", enum: ["nfe", "nfce"] }, q: { type: "string", maxLength: 80, description: "Número, chave de acesso ou destinatário." }, from: dateParam, to: dateParam, cursor: { type: "string" }, limit }),
  erp_bling_cutover_invoice_get: params({ entity: { type: "string", enum: ["nfe", "nfce"] }, source_id: id40 }, ["entity", "source_id"]),
  erp_bling_cutover_packages: params({}),
  erp_bling_cutover_package_start: params({ command_id: commandParam, month: monthParam }, ["command_id", "month"]),
  erp_bling_cutover_package_download: params({ month: monthParam }, ["month"]),
  erp_bling_cutover_report: params({}),
  erp_bling_cutover_justify: params({ command_id: commandParam, key: { type: "string", maxLength: 200, description: "Diferença (grupo ou item) da conferência." }, text: { type: "string", minLength: 5, maxLength: 2000 } }, ["command_id", "key", "text"]),
  erp_bling_cutover_conclude: params({ command_id: commandParam }, ["command_id"]),
  erp_bling_cutover_conflicts: params({ cursor: { type: "string" }, limit }),
  erp_bling_cutover_conflict_resolve: params({ command_id: commandParam, entity: { type: "string" }, source_id: id40, action: { type: "string", enum: ["keep_erp", "use_bling"] } }, ["command_id", "entity", "source_id", "action"]),
});
export const isCutoverOperation = (name: string): name is BlingCutoverOperationName => (BLING_CUTOVER_OPERATION_NAMES as readonly string[]).includes(name);
