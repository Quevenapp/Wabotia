/** Mão dupla com o Bling, depois do corte: o que muda no Bling entra no ERP
 * pela coleta incremental (pelas mesmas funções da adoção) e o que muda no ERP
 * volta ao Bling por uma fila retomável no alarme. Contrato puro, no mesmo
 * registro das operações de adoção e do corte (adoption-contracts.ts junta):
 * tela, Worker, objeto e bots usam os mesmos nomes. Importar não faz I/O.
 *
 * Interruptor por entidade e sentido, todos desligados por padrão. Nota
 * fiscal e ordem de serviço nunca vão ao Bling (não estão na lista). Ligar
 * ou desligar e o ritmo são só do administrador e não vão para os bots. */
import { z } from "zod";
import type { ErpPartKey } from "../parts.ts";

/** Entidades da mão dupla, na ordem de envio (cadastros antes dos documentos). */
export const BLING_TWO_WAY_ENTITIES = [
  "contacts", "products", "sales_proposals", "sales_orders", "purchase_orders", "receivables", "payables", "stock_balances",
] as const;
export type BlingTwoWayEntity = typeof BLING_TWO_WAY_ENTITIES[number];
export const BLING_TWO_WAY_DIRECTIONS = ["inbound", "outbound"] as const;
export type BlingTwoWayDirection = typeof BLING_TWO_WAY_DIRECTIONS[number];
/** Nunca escritos no Bling, em nenhuma hipótese. */
export const BLING_TWO_WAY_NEVER = Object.freeze(["nfe", "nfce", "service_orders"] as const);
export const isTwoWayEntity = (value: string): value is BlingTwoWayEntity => (BLING_TWO_WAY_ENTITIES as readonly string[]).includes(value);

export const BLING_TWO_WAY_LABELS: Readonly<Record<BlingTwoWayEntity, string>> = Object.freeze({
  contacts: "Contatos (clientes, fornecedores e transportadoras)", products: "Produtos e serviços", sales_proposals: "Propostas comerciais",
  sales_orders: "Pedidos de venda", purchase_orders: "Pedidos de compra", receivables: "Contas a receber (com baixas)",
  payables: "Contas a pagar (com baixas)", stock_balances: "Saldos de estoque",
});
export const BLING_TWO_WAY_SINGULAR: Readonly<Record<BlingTwoWayEntity, string>> = Object.freeze({
  contacts: "contato", products: "produto", sales_proposals: "proposta comercial", sales_orders: "pedido de venda",
  purchase_orders: "pedido de compra", receivables: "conta a receber", payables: "conta a pagar", stock_balances: "saldo de estoque",
});
/** Partes do ERP de que cada entidade depende (todas também exigem a Base). */
export const BLING_TWO_WAY_PARTS: Readonly<Record<BlingTwoWayEntity, readonly ErpPartKey[]>> = Object.freeze({
  contacts: ["customers"], products: ["products"], sales_proposals: ["sales", "products"], sales_orders: ["sales", "products"],
  purchase_orders: ["purchases", "products"], receivables: ["finance"], payables: ["finance"], stock_balances: ["products", "stock"],
});
/** Prioridade na fila de saída: o que é citado vai antes de quem cita. */
export const BLING_TWO_WAY_PRIORITY: Readonly<Record<BlingTwoWayEntity, number>> = Object.freeze({
  contacts: 1, products: 2, sales_proposals: 3, sales_orders: 3, purchase_orders: 3, receivables: 4, payables: 4, stock_balances: 6,
});

/** Textos fixos da tela (o que cada interruptor faz e o que nunca acontece). */
export const BLING_TWO_WAY_TEXTS = Object.freeze({
  intro: "Mão dupla mantém o ERP e o Bling iguais depois do corte: o que muda no Bling entra no ERP, e o que muda no ERP volta ao Bling. Cada tipo de registro tem dois interruptores, um para cada sentido, e todos começam desligados.",
  inbound: "Receber do Bling: a coleta continua pelo que mudou desde a última rodada e aplica no ERP as mudanças dos registros já adotados, e adota os novos, pelas mesmas regras da adoção.",
  outbound: "Escrever no Bling: o que você muda aqui num registro adotado, ou cria depois do corte, vai para a fila de saída e é gravado no Bling. Ligar afeta a sua conta do Bling (marketplace e loja virtual usam esses dados).",
  never: "Notas fiscais e ordens de serviço nunca são escritas no Bling por aqui.",
  uncertain: "Quando o Bling não responde a tempo, o envio nunca é repetido às cegas: o sistema confere no Bling se a mudança entrou antes de tentar de novo.",
  conflict: "Quando o mesmo registro mudou nos dois lados desde a última sincronização, nada é sobrescrito: vira pendência com os dois valores lado a lado e você escolhe. Sem conflito, vale a mudança mais recente.",
  not_sent: "Exclusões, cancelamentos, estornos de baixa e mudança de situação de documentos não são enviados ao Bling por estes interruptores: faça também no Bling. A situação, o rastreio e a nota dos pedidos que vieram do Bling têm interruptores próprios, em Volta ao Bling.",
  switch_warning_outbound: "Ao ligar, as mudanças feitas daqui para a frente nos registros escolhidos serão gravadas na sua conta do Bling. O que já está igual não é reenviado. Confirme que entendeu.",
  switch_warning_inbound: "Ao ligar, as mudanças vindas do Bling daqui para a frente serão aplicadas no ERP sozinhas, e os registros novos do Bling serão adotados. Confirme que entendeu.",
  no_cutover: "A mão dupla só funciona depois do corte. Confirme a data de corte em Passar a operar aqui.",
});

export const BLING_TWO_WAY_OPS = { create: "Criar no Bling", update: "Atualizar no Bling", settle: "Baixa no Bling", stock: "Igualar saldo no Bling",
  // Volta ao Bling do pedido que veio de lá (versão 32, returns.ts).
  invoice: "Nota no pedido do Bling", status: "Situação no Bling", tracking: "Rastreio no Bling" } as const;
export type BlingTwoWayOp = keyof typeof BLING_TWO_WAY_OPS;
export const BLING_TWO_WAY_STATES = {
  pending: "Na fila", sending: "Enviando", uncertain: "Conferindo no Bling", held: "Parado por conflito",
  done: "Gravado no Bling", failed: "Recusado", superseded: "Substituído por mudança mais nova",
} as const;
export type BlingTwoWayState = keyof typeof BLING_TWO_WAY_STATES;
export const BLING_TWO_WAY_ISSUE_KINDS = {
  conflict: "Mudou nos dois lados", failed: "O Bling recusou", uncertain: "Não deu para confirmar no Bling", blocked: "Falta algo para enviar",
} as const;
export type BlingTwoWayIssueKind = keyof typeof BLING_TWO_WAY_ISSUE_KINDS;
/** Ações possíveis numa pendência, ditas na tela. */
export const BLING_TWO_WAY_ACTIONS = {
  use_bling: "Usar a do Bling", use_erp: "Usar a do ERP", retry: "Tentar de novo", discard: "Deixar como está",
  confirm_sent: "Entrou no Bling", resend: "Não entrou: enviar de novo",
} as const;
export type BlingTwoWayAction = keyof typeof BLING_TWO_WAY_ACTIONS;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const sourceId = z.string().regex(/^[1-9]\d{0,39}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const iso = z.string().max(40).nullable();
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const receipt = z.object({ command_id: id, operation: z.string().max(60), replayed: z.boolean() }).strict();
const entitySchema = z.enum(BLING_TWO_WAY_ENTITIES);
const directionSchema = z.enum(BLING_TWO_WAY_DIRECTIONS);
const summary = z.record(z.string().max(40), z.string().max(400).nullable());
const issueKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

const switchSchema = z.object({ enabled: z.boolean(), since: iso }).strict();
const entityStatusSchema = z.object({
  entity: entitySchema, label: z.string().max(100), module_name: z.string().max(60), enabled: z.boolean(), part_off_message: z.string().max(300).nullable(),
  inbound: switchSchema, outbound: switchSchema, queued: count, uncertain: count, failed: count, issues: count,
}).strict();
const roundSchema = z.object({ at: iso, counts: z.record(z.string().max(30), count) }).strict();
const auditSchema = z.object({ at: z.string().max(40), by: z.string().max(200), entity: entitySchema.nullable(), direction: directionSchema.nullable(),
  enabled: z.boolean().nullable(), detail: z.string().max(600) }).strict();
/** Volta ao Bling (versão 32): o que o pedido que veio do Bling viveu aqui. */
export const BLING_RETURN_KINDS = ["invoice", "status", "webhook"] as const;
export type BlingReturnKind = typeof BLING_RETURN_KINDS[number];
/** Etapas do pedido aqui que viram situação no Bling, na ordem de precedência inversa. */
export const BLING_RETURN_STAGES = ["separated", "invoiced", "shipped", "delivered", "cancelled"] as const;
export type BlingReturnStage = typeof BLING_RETURN_STAGES[number];
export const BLING_RETURN_STAGE_LABELS: Readonly<Record<BlingReturnStage, string>> = Object.freeze({
  separated: "Separado", invoiced: "Faturado", shipped: "Enviado", delivered: "Entregue", cancelled: "Cancelado",
});
export const BLING_RETURN_TEXTS = Object.freeze({
  intro: "Para quem vende no marketplace pelo Bling: o pedido nasce no Bling, é atendido aqui, e o marketplace precisa da nota e do rastreio. Estes interruptores devolvem ao pedido do Bling o que aconteceu aqui. Todos começam desligados e só valem para pedidos que vieram do Bling.",
  invoice: "Nota de volta: quando a NF-e de um pedido que veio do Bling é autorizada aqui, a chave de acesso, o número e a série vão para as observações internas do pedido no Bling.",
  invoice_limit: "Limite: a API do Bling não aceita receber uma NF-e emitida fora dele (o XML não entra como nota do Bling). Por isso a nota vai escrita no pedido, e o marketplace que só lê a nota emitida pelo Bling pode precisar dela informada à mão lá.",
  status: "Situação e rastreio de volta: quando o pedido muda de etapa aqui (separado, faturado, enviado, entregue, cancelado), o pedido no Bling vai para a situação que você escolher para cada etapa; o código de rastreio da Expedição vai para o volume do pedido no Bling (e para as observações internas, se o pedido não tiver volume).",
  status_map: "No Bling cada situação tem um número (Preferências → Situações). As padrão são 6 Em aberto, 9 Atendido, 12 Cancelado e 15 Em andamento; separado, enviado e entregue costumam ser situações que você cria lá. Etapa sem número escolhido não muda a situação no Bling.",
  status_warning: "Atenção: em algumas contas, levar o pedido do Bling para Atendido ou Cancelado lança ou estorna estoque e contas lá. Escolha as situações sabendo o que elas fazem na sua conta.",
  webhook: "Aviso do Bling (webhook): o Bling avisa na hora quando um pedido, produto, estoque ou nota muda, e a coleta daquele tipo de registro roda logo, em vez de esperar o ritmo. A consulta periódica continua como reserva, mais espaçada.",
  webhook_setup: "No cadastro do aplicativo no Bling, em Webhooks, informe o endereço abaixo e marque os recursos (pedidos de venda, produtos, estoques, notas fiscais). O Bling assina cada aviso com o segredo do aplicativo; aviso sem assinatura certa é recusado.",
  switch_warning_invoice: "Ao ligar, cada NF-e autorizada daqui para a frente num pedido que veio do Bling será escrita no pedido do Bling. Confirme que entendeu.",
  switch_warning_status: "Ao ligar, as mudanças de etapa e os rastreios daqui para a frente nos pedidos que vieram do Bling mudam o pedido no Bling, inclusive a situação. Confirme que entendeu.",
  switch_warning_webhook: "Ao ligar, os avisos do Bling para esta área adiantam a coleta. Cadastre o endereço no aplicativo do Bling. Confirme que entendeu.",
  never: "A nota fiscal em si nunca é criada nem emitida no Bling por aqui: só a chave, o número e a série vão escritos no pedido.",
});
const situationId = z.string().regex(/^[1-9]\d{0,19}$/).nullable();
const returnSwitch = z.object({ enabled: z.boolean(), since: iso }).strict();
export const returnsStatusSchema = z.object({
  available: z.boolean(),
  invoice: returnSwitch,
  status: returnSwitch.extend({ situations: z.record(z.enum(BLING_RETURN_STAGES), situationId) }).strict(),
  webhook: returnSwitch.extend({ path: z.string().max(300), last_event_at: iso, events: count, entities: z.array(z.string().max(40)).max(10) }).strict(),
  stages: z.array(z.object({ stage: z.enum(BLING_RETURN_STAGES), label: z.string().max(40) }).strict()).max(BLING_RETURN_STAGES.length),
  queue: z.object({ pending: count, uncertain: count, failed: count, done: count }).strict(),
  part_off_message: z.string().max(300).nullable(),
  scopes: z.object({ read: z.array(z.string().max(80)).max(40), write: z.array(z.string().max(80)).max(40), note: z.string().max(300) }).strict(),
  texts: z.record(z.string().max(40), z.string().max(600)),
}).strict();
export type BlingReturnsStatus = z.infer<typeof returnsStatusSchema>;

export const twoWayStatusSchema = z.object({
  available: z.boolean(), unavailable_message: z.string().max(300).nullable(),
  cutover: z.object({ confirmed: z.boolean(), cutover_on: day.nullable() }).strict(),
  pace_minutes: z.number().int().min(5).max(1440),
  entities: z.array(entityStatusSchema).max(BLING_TWO_WAY_ENTITIES.length),
  last_in: roundSchema, last_out: roundSchema,
  queue: z.record(z.enum(Object.keys(BLING_TWO_WAY_STATES) as [BlingTwoWayState, ...BlingTwoWayState[]]), count),
  issues: z.object({ open: count, conflicts: count }).strict(),
  audit: z.array(auditSchema).max(20),
  texts: z.record(z.string().max(40), z.string().max(600)),
  /** Volta ao Bling (versão 32): nota, situação e rastreio, e o webhook. Ausente em esquema antigo. */
  returns: returnsStatusSchema.optional(),
}).strict();
export type BlingTwoWayStatus = z.infer<typeof twoWayStatusSchema>;
export const twoWayQueueItemSchema = z.object({
  id, entity: entitySchema, label: z.string().max(200), op: z.enum(Object.keys(BLING_TWO_WAY_OPS) as [BlingTwoWayOp, ...BlingTwoWayOp[]]), op_text: z.string().max(60),
  state: z.enum(Object.keys(BLING_TWO_WAY_STATES) as [BlingTwoWayState, ...BlingTwoWayState[]]), state_text: z.string().max(60),
  attempts: count, checks: count, not_before: iso, sent_at: iso, updated_at: iso, remote_id: z.string().max(200).nullable(), error_text: z.string().max(600).nullable(),
}).strict();
export type BlingTwoWayQueueItem = z.infer<typeof twoWayQueueItemSchema>;
export const twoWayIssueSchema = z.object({
  key: issueKey, kind: z.enum(Object.keys(BLING_TWO_WAY_ISSUE_KINDS) as [BlingTwoWayIssueKind, ...BlingTwoWayIssueKind[]]), kind_text: z.string().max(60),
  entity: entitySchema, label: z.string().max(200), reason: z.string().max(600), state: z.enum(["open", "resolved"]),
  erp: summary.nullable(), bling: summary.nullable(),
  actions: z.array(z.object({ action: z.enum(Object.keys(BLING_TWO_WAY_ACTIONS) as [BlingTwoWayAction, ...BlingTwoWayAction[]]), label: z.string().max(60) }).strict()).max(6),
  created_at: iso, resolution: z.string().max(60).nullable(),
}).strict();
export type BlingTwoWayIssue = z.infer<typeof twoWayIssueSchema>;

const cursor = z.string().regex(/^\d{1,16}\.[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const BLING_TWO_WAY_OPERATION_NAMES = ["erp_bling_twoway_status", "erp_bling_twoway_queue", "erp_bling_twoway_issues", "erp_bling_twoway_resolve"] as const;
/** Só do administrador, na tela: não vão para os bots. */
export const BLING_TWO_WAY_ADMIN_OPERATION_NAMES = ["erp_bling_twoway_switch", "erp_bling_twoway_pace", "erp_bling_twoway_return_switch"] as const;
export type BlingTwoWayOperationName = typeof BLING_TWO_WAY_OPERATION_NAMES[number] | typeof BLING_TWO_WAY_ADMIN_OPERATION_NAMES[number];

export const twoWayInputs = {
  erp_bling_twoway_status: z.object({}).strict(),
  erp_bling_twoway_queue: z.object({ state: z.enum(["open", "done", "all"]).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_twoway_issues: z.object({ state: z.enum(["open", "resolved"]).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  erp_bling_twoway_resolve: z.object({ command_id: id, key: issueKey, action: z.enum(Object.keys(BLING_TWO_WAY_ACTIONS) as [BlingTwoWayAction, ...BlingTwoWayAction[]]),
    remote_id: sourceId.optional() }).strict()
    .refine(v => v.action === "confirm_sent" || !v.remote_id, "O id no Bling só vale para dizer que entrou."),
  erp_bling_twoway_switch: z.object({ command_id: id, entity: entitySchema, direction: directionSchema, enabled: z.boolean(), acknowledged: z.boolean().optional() }).strict()
    .refine(v => !v.enabled || v.acknowledged === true, "Ligar pede o aviso confirmado."),
  erp_bling_twoway_pace: z.object({ command_id: id, minutes: z.number().int().min(5).max(1440) }).strict(),
  erp_bling_twoway_return_switch: z.object({ command_id: id, kind: z.enum(BLING_RETURN_KINDS), enabled: z.boolean(), acknowledged: z.boolean().optional(),
    situations: z.object(Object.fromEntries(BLING_RETURN_STAGES.map(stage => [stage, situationId.optional()])) as Record<BlingReturnStage, z.ZodOptional<typeof situationId>>).strict().optional() }).strict()
    .refine(v => !v.enabled || v.acknowledged === true, "Ligar pede o aviso confirmado.")
    .refine(v => !v.situations || v.kind === "status", "As situações só valem para a situação e o rastreio."),
} as const;
export const twoWayOutputs = {
  erp_bling_twoway_status: twoWayStatusSchema,
  erp_bling_twoway_queue: z.object({ items: z.array(twoWayQueueItemSchema).max(50), next_cursor: cursor.nullable() }).strict(),
  erp_bling_twoway_issues: z.object({ items: z.array(twoWayIssueSchema).max(50), next_cursor: cursor.nullable(), total: count }).strict(),
  erp_bling_twoway_resolve: z.object({ outcome: z.enum(["applied", "queued", "kept", "confirmed", "retrying", "discarded"]), message: z.string().max(400), receipt }).strict(),
  erp_bling_twoway_switch: z.object({ entity: entitySchema, direction: directionSchema, enabled: z.boolean(), since: iso, receipt }).strict(),
  erp_bling_twoway_pace: z.object({ minutes: z.number().int().min(5).max(1440), receipt }).strict(),
  erp_bling_twoway_return_switch: z.object({ kind: z.enum(BLING_RETURN_KINDS), enabled: z.boolean(), since: iso,
    situations: z.record(z.enum(BLING_RETURN_STAGES), situationId), receipt }).strict(),
} as const;
type IO<K extends BlingTwoWayOperationName> = { input: z.infer<typeof twoWayInputs[K]>; output: z.infer<typeof twoWayOutputs[K]> };
export interface BlingTwoWayOperationMap {
  erp_bling_twoway_status: IO<"erp_bling_twoway_status">;
  erp_bling_twoway_queue: IO<"erp_bling_twoway_queue">;
  erp_bling_twoway_issues: IO<"erp_bling_twoway_issues">;
  erp_bling_twoway_resolve: IO<"erp_bling_twoway_resolve">;
  erp_bling_twoway_switch: IO<"erp_bling_twoway_switch">;
  erp_bling_twoway_pace: IO<"erp_bling_twoway_pace">;
  erp_bling_twoway_return_switch: IO<"erp_bling_twoway_return_switch">;
}

type Descriptor = { name: BlingTwoWayOperationName; method: "GET" | "POST"; path: string; summary: string; description: string; sensitive: boolean };
const op = (name: BlingTwoWayOperationName, method: "GET" | "POST", path: string, summary: string, description: string, sensitive: boolean): Descriptor =>
  Object.freeze({ name, method, path, summary, description, sensitive });
/** Operações que os bots podem receber (grupo bling). */
export const BLING_TWO_WAY_OPERATIONS = Object.freeze({
  erp_bling_twoway_status: op("erp_bling_twoway_status", "GET", "/mao-dupla", "Consultar a mão dupla com o Bling",
    "Mostra, por tipo de registro, se o ERP recebe as mudanças do Bling e se escreve de volta no Bling, a última rodada em cada sentido, quantos envios estão na fila, em conferência ou recusados, e quantas pendências e conflitos esperam decisão. Só consulta.", false),
  erp_bling_twoway_queue: op("erp_bling_twoway_queue", "GET", "/mao-dupla/fila", "Listar a fila de saída para o Bling",
    "Lista o que está na fila para ser gravado no Bling (contatos, produtos, propostas, pedidos, contas, baixas e saldos), com a situação de cada envio e o motivo quando o Bling recusou. Contém nomes de clientes e fornecedores.", true),
  erp_bling_twoway_issues: op("erp_bling_twoway_issues", "GET", "/mao-dupla/pendencias", "Listar pendências e conflitos da mão dupla",
    "Lista os conflitos (o mesmo registro mudou no ERP e no Bling) com os dois valores lado a lado, os envios que o Bling recusou, com o motivo em palavras, e os que não deu para confirmar. Contém dados pessoais.", true),
  erp_bling_twoway_resolve: op("erp_bling_twoway_resolve", "POST", "/mao-dupla/pendencias/resolver", "Resolver uma pendência da mão dupla",
    "Decide uma pendência: num conflito, usar a versão do Bling (aplica no ERP) ou a do ERP (vai para a fila de saída); num envio recusado, tentar de novo ou deixar como está; num envio que não deu para confirmar, dizer se entrou no Bling ou mandar de novo.", true),
} satisfies Record<typeof BLING_TWO_WAY_OPERATION_NAMES[number], Descriptor>);
/** Só do administrador, pela tela. */
export const BLING_TWO_WAY_ADMIN_OPERATIONS = Object.freeze({
  erp_bling_twoway_switch: op("erp_bling_twoway_switch", "POST", "/mao-dupla/interruptor", "Ligar ou desligar a mão dupla de um tipo de registro",
    "Liga ou desliga, para um tipo de registro e um sentido, o recebimento das mudanças do Bling ou a escrita de volta no Bling. Ligar pede o aviso confirmado e fica registrado com quem e quando. Só o administrador, pela tela.", true),
  erp_bling_twoway_pace: op("erp_bling_twoway_pace", "POST", "/mao-dupla/ritmo", "Mudar o ritmo da coleta contínua",
    "Define de quantos em quantos minutos a coleta procura o que mudou no Bling (de 5 minutos a 24 horas), dentro do limite de chamadas por dia. Só o administrador, pela tela.", true),
  erp_bling_twoway_return_switch: op("erp_bling_twoway_return_switch", "POST", "/mao-dupla/retorno", "Ligar ou desligar a volta ao Bling e o aviso do Bling",
    "Liga ou desliga a nota de volta ao Bling (chave, número e série da NF-e no pedido do Bling), a situação e o rastreio de volta ao Bling (com o número de situação do Bling para cada etapa) ou o aviso do Bling (webhook) que adianta a coleta. Ligar pede o aviso confirmado e fica registrado. Só o administrador, pela tela.", true),
} satisfies Record<typeof BLING_TWO_WAY_ADMIN_OPERATION_NAMES[number], Descriptor>);

const command = { type: "string", description: "Identificador único do pedido, para repetir sem duplicar." };
const page = { cursor: { type: "string", description: "Continuação da página anterior." }, limit: { type: "integer", minimum: 1, maximum: 50 } };
type Params = { type: "object"; properties: Record<string, unknown>; required: string[] };
const params = (properties: Record<string, unknown>, required: string[] = []): Params => Object.freeze({ type: "object" as const, properties, required });
export const BLING_TWO_WAY_PARAMS: Readonly<Record<BlingTwoWayOperationName, Params>> = Object.freeze({
  // Só do administrador: descritas para o contrato, mas fora do inventário dos bots.
  erp_bling_twoway_switch: params({ command_id: command, entity: { type: "string", enum: [...BLING_TWO_WAY_ENTITIES] }, direction: { type: "string", enum: [...BLING_TWO_WAY_DIRECTIONS] },
    enabled: { type: "boolean" }, acknowledged: { type: "boolean", description: "Aviso confirmado (obrigatório para ligar)." } }, ["command_id", "entity", "direction", "enabled"]),
  erp_bling_twoway_pace: params({ command_id: command, minutes: { type: "integer", minimum: 5, maximum: 1440 } }, ["command_id", "minutes"]),
  erp_bling_twoway_return_switch: params({ command_id: command, kind: { type: "string", enum: [...BLING_RETURN_KINDS] }, enabled: { type: "boolean" },
    acknowledged: { type: "boolean", description: "Aviso confirmado (obrigatório para ligar)." },
    situations: { type: "object", description: "Número da situação no Bling para cada etapa (só para a situação e o rastreio).",
      properties: Object.fromEntries(BLING_RETURN_STAGES.map(stage => [stage, { type: ["string", "null"], pattern: "^[1-9][0-9]{0,19}$" }])) } },
    ["command_id", "kind", "enabled"]),
  erp_bling_twoway_status: params({}),
  erp_bling_twoway_queue: params({ state: { type: "string", enum: ["open", "done", "all"], description: "Em aberto (padrão), gravados ou todos." }, ...page }),
  erp_bling_twoway_issues: params({ state: { type: "string", enum: ["open", "resolved"] }, ...page }),
  erp_bling_twoway_resolve: params({ command_id: command, key: { type: "string", description: "Chave da pendência, como veio na lista." },
    action: { type: "string", enum: Object.keys(BLING_TWO_WAY_ACTIONS) }, remote_id: { type: "string", pattern: "^[1-9][0-9]{0,39}$", description: "Id no Bling, ao dizer que entrou (criação)." } },
    ["command_id", "key", "action"]),
});
