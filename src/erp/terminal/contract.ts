// Maquininha integrada ao caixa (pagamento enviado pela nuvem ao terminal):
// o contrato leve, sem banco e sem rede (os testes do Node importam este
// arquivo). Operações com nome estável e descrição em português: as mesmas
// para a tela do PDV, para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts). Consultar os pagamentos da maquininha é
// leitura; enviar a cobrança ao terminal, cancelar, reenviar e configurar
// ficam só na tela, porque exigem uma pessoa no caixa. As rotas do Worker
// ficam em ./routes.ts. Só sintaxe TypeScript apagável.

/** Segmento das rotas no Worker (/api/v1/profiles/:profile/erp-maquininha). */
export const ERP_TERMINAL_ROUTE = "erp-maquininha";
/** Parte do ERP dona da maquininha: o Caixa / PDV (que traz Vendas, Financeiro e Estoque). */
export const ERP_TERMINAL_PART = "erp-pdv" as const;

export type TerminalProviderId = "mercadopago";
export const TERMINAL_PROVIDERS: readonly TerminalProviderId[] = Object.freeze(["mercadopago"]);
export const TERMINAL_PROVIDER_INFO: Readonly<Record<TerminalProviderId, { id: TerminalProviderId; name: string; device: string; acquirer: string }>> = Object.freeze({
  mercadopago: { id: "mercadopago", name: "Mercado Pago", device: "Point (Smart, Pro ou Mini)", acquirer: "mercadopago" },
});

/** Como o cliente paga na maquininha. */
export type TerminalCardKind = "debito" | "credito";
export const TERMINAL_KIND_LABELS: Readonly<Record<TerminalCardKind, string>> = Object.freeze({ debito: "Débito", credito: "Crédito" });
/** Parcelado no cartão: quem paga os juros (a loja, sem juros para o cliente; ou o cliente). */
export type TerminalInstallmentsCost = "loja" | "cliente";
export const TERMINAL_MAX_INSTALLMENTS = 12;

/** Situação do pagamento no Vinki (migrations/0270_erp_maquininha.sql). */
export type TerminalStatus = "enviando" | "aguardando" | "processando" | "aprovado" | "recusado" | "cancelado" | "incerto" | "erro";
export const TERMINAL_STATUS_LABELS: Readonly<Record<TerminalStatus, string>> = Object.freeze({
  enviando: "Enviando para a maquininha", aguardando: "Aguardando pagamento na maquininha", processando: "A maquininha está processando o cartão",
  aprovado: "Pagamento aprovado", recusado: "Pagamento recusado", cancelado: "Cobrança cancelada", incerto: "Sem resposta da maquininha: conferindo",
  erro: "A cobrança não foi para a maquininha",
});
/** Situações em que a cobrança ainda pode virar pagamento: nunca se envia outra por cima. */
export const TERMINAL_OPEN_STATUSES: readonly TerminalStatus[] = Object.freeze(["enviando", "aguardando", "processando", "incerto"]);

export interface ErpTerminalOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela (pessoa no caixa ou o administrador), fora do inventário dos bots. */
  bot?: boolean;
  /** Só o administrador da área. */
  admin?: boolean;
}

export const ERP_TERMINAL_OPERATIONS: readonly ErpTerminalOperation[] = Object.freeze([
  {
    name: "erp.maquininha.configuracao", method: "GET", path: `${ERP_TERMINAL_ROUTE}/configuracao`, sensitive: false, bot: false,
    summary: "Ver a configuração da maquininha integrada ao caixa",
    description: "Mostra se a maquininha integrada está ligada, o provedor, se a credencial está guardada (os segredos aparecem só como guardados), as formas de pagamento de débito e crédito e o terminal de cada caixa. Só consulta.",
    body: [], required: [],
  },
  {
    name: "erp.maquininha.configuracao.salvar", method: "POST", path: `${ERP_TERMINAL_ROUTE}/configuracao`, sensitive: true, bot: false, admin: true,
    summary: "Ligar a maquininha integrada e guardar a credencial",
    description: "Liga ou desliga a maquininha integrada ao caixa (nasce desligada), escolhe a credencial (a mesma conta do Mercado Pago da Cobrança ou um Access Token próprio, guardado no cofre de segredos), as formas de pagamento de débito e crédito e o parcelamento. Só o administrador.",
    body: ["ligado", "provedor", "credencial", "access_token", "webhook_secret", "forma_debito", "forma_credito", "parcelas_max", "juros_parcelado"], required: [],
  },
  {
    name: "erp.maquininha.terminais", method: "GET", path: `${ERP_TERMINAL_ROUTE}/terminais`, sensitive: false, bot: false, admin: true,
    summary: "Listar as maquininhas da conta no provedor",
    description: "Pergunta ao provedor quais maquininhas estão ligadas à conta e em que modo cada uma está. Só o administrador.",
    body: [], required: [],
  },
  {
    name: "erp.maquininha.caixa.salvar", method: "POST", path: `${ERP_TERMINAL_ROUTE}/caixas/:caixa`, sensitive: true, bot: false, admin: true,
    summary: "Escolher a maquininha de um caixa",
    description: "Liga a maquininha escolhida ao caixa (loja) do PDV, ou tira a maquininha do caixa. Quando o provedor pede, põe a maquininha no modo integrado. Só o administrador.",
    body: ["terminal", "nome"], required: [],
  },
  {
    name: "erp.maquininha.cobrar", method: "POST", path: `${ERP_TERMINAL_ROUTE}/cobrar`, sensitive: true, bot: false,
    summary: "Enviar a cobrança da venda para a maquininha do caixa",
    description: "Envia para a maquininha do caixa o valor das parcelas da venda na forma de débito ou crédito configurada (débito, crédito à vista ou parcelado). Se já há uma cobrança desta venda em andamento ou sem resposta, consulta antes e devolve a mesma, sem enviar outra. Exige pessoa no caixa: não é exposto aos bots.",
    body: ["venda", "caixa", "tipo", "parcelas", "comando"], required: ["venda", "caixa", "tipo"],
  },
  {
    name: "erp.maquininha.pagamentos", method: "GET", path: `${ERP_TERMINAL_ROUTE}/pagamentos`, sensitive: false,
    summary: "Consultar os pagamentos feitos na maquininha",
    description: "Lista os pagamentos enviados à maquininha integrada ao caixa (de uma venda ou de um período): valor, débito ou crédito, parcelas, bandeira, autorização, NSU, situação e o motivo da recusa. Só consulta.",
    body: [], required: [],
  },
  {
    name: "erp.maquininha.pagamento", method: "GET", path: `${ERP_TERMINAL_ROUTE}/pagamentos/:id`, sensitive: false,
    summary: "Consultar um pagamento da maquininha",
    description: "Mostra um pagamento enviado à maquininha e, se ele ainda está em andamento, pergunta a situação ao provedor (aguardando, aprovado, recusado ou cancelado). Só consulta: não envia nem cancela nada.",
    body: [], required: [],
  },
  {
    name: "erp.maquininha.cancelar", method: "POST", path: `${ERP_TERMINAL_ROUTE}/pagamentos/:id/cancelar`, sensitive: true, bot: false,
    summary: "Cancelar a cobrança que ainda espera na maquininha",
    description: "Tira da maquininha a cobrança que ainda não foi paga. Se o cliente já está passando o cartão, a maquininha não deixa: cancele na própria maquininha. Só pela tela do caixa.",
    body: [], required: [],
  },
  {
    name: "erp.maquininha.reenviar", method: "POST", path: `${ERP_TERMINAL_ROUTE}/pagamentos/:id/reenviar`, sensitive: true, bot: false,
    summary: "Enviar de novo a cobrança que não apareceu na maquininha",
    description: "Depois de uma resposta incerta, consulta o provedor de novo e, só se a cobrança não estiver lá e a pessoa confirmar que não apareceu na maquininha, envia outra vez. Só pela tela do caixa.",
    body: ["confirmo"], required: ["confirmo"],
  },
  {
    name: "erp.maquininha.venda_concluida", method: "POST", path: `${ERP_TERMINAL_ROUTE}/pagamentos/:id/venda-concluida`, sensitive: true, bot: false,
    summary: "Registrar que a venda paga na maquininha foi finalizada",
    description: "Confere que a venda do pagamento aprovado foi finalizada e põe o pagamento na conciliação de cartões já casado com a venda. Só pela tela do caixa.",
    body: [], required: [],
  },
]);

const propertySchemas: Record<string, Record<string, unknown>> = {
  id: { type: "string", format: "uuid", description: "Pagamento da maquininha no Vinki." },
};

/** Parâmetros (caminho e corpo) num objeto, para o catálogo do bot. */
export function erpTerminalParams(operation: ErpTerminalOperation) {
  const path = (operation.path.match(/:[a-z_]+/g) ?? []).map(key => key.slice(1));
  const keys = [...path, ...operation.body];
  const properties: Record<string, Record<string, unknown>> = Object.fromEntries(keys.map(key => [key, propertySchemas[key] ?? { type: "string" }]));
  if (operation.name === "erp.maquininha.pagamentos") {
    properties.venda = { type: "string", format: "uuid", description: "Venda do PDV (opcional)." };
    properties.desde = { type: "string", format: "date", description: "Primeiro dia (AAAA-MM-DD, opcional)." };
    properties.ate = { type: "string", format: "date", description: "Último dia (AAAA-MM-DD, opcional)." };
  }
  return { type: "object" as const, properties, required: [...path, ...operation.required] };
}

/** Contrato leve do módulo erp-pdv: a rota (desligada, 409 module_disabled antes de tudo) e o catálogo dos bots. */
export const ERP_TERMINAL_MODULE_CONTRACT = {
  routes: [ERP_TERMINAL_ROUTE], operations: ["erp.maquininha."],
  definition: { bot: { sensitive: ERP_TERMINAL_OPERATIONS.filter(op => op.sensitive && op.bot !== false).map(op => op.name),
    hints: Object.fromEntries(ERP_TERMINAL_OPERATIONS.filter(op => op.bot !== false).map(op => [op.name, op.summary])) } },
};

/** A operação de uma rota do Worker (caminho depois de /api/v1/profiles/:profile/). */
export function erpTerminalOperationFor(method: string, path: string): { operation: ErpTerminalOperation; params: Record<string, string> } | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const parts = path.replace(/\/$/, "").split("/");
  for (const operation of ERP_TERMINAL_OPERATIONS) {
    if (operation.method !== verb) continue;
    const pattern = operation.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((segment, index) => segment.startsWith(":") ? (params[segment.slice(1)] = parts[index]!, parts[index] !== "") : segment === parts[index]))
      return { operation, params };
  }
  return null;
}

/** Bandeira do cartão como a conciliação de cartões conhece (erp_reconciliation__card_line.brand). */
export type TerminalBrand = "visa" | "mastercard" | "elo" | "amex" | "hipercard" | "diners" | "cabal" | "outros";
export const TERMINAL_BRAND_LABELS: Readonly<Record<TerminalBrand, string>> = Object.freeze({
  visa: "Visa", mastercard: "Mastercard", elo: "Elo", amex: "American Express", hipercard: "Hipercard", diners: "Diners", cabal: "Cabal", outros: "Outra bandeira",
});

/** Texto curto gravado na observação da parcela da venda (bandeira, parcelas, autorização e NSU). */
export function terminalPaymentNote(input: { provider: TerminalProviderId; kind: TerminalCardKind; installments: number; brand: TerminalBrand | null;
  authorization: string | null; nsu: string | null; last4?: string | null }): string {
  const parts = [`Maquininha ${TERMINAL_PROVIDER_INFO[input.provider].name}`,
    `${input.brand ? `${TERMINAL_BRAND_LABELS[input.brand]} ` : ""}${input.kind === "debito" ? "débito" : input.installments > 1 ? `crédito ${input.installments}x` : "crédito à vista"}`];
  if (input.last4) parts.push(`final ${input.last4}`);
  if (input.authorization) parts.push(`autorização ${input.authorization}`);
  if (input.nsu) parts.push(`NSU ${input.nsu}`);
  return parts.join(" · ").slice(0, 2000);
}
