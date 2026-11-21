// Boleto registrado pela API do banco (Banco Inter, Sicoob, Banco do Brasil e
// Itaú): o contrato leve, sem banco e sem rede (os testes do Node importam
// este arquivo). Operações com nome estável e descrição em português: as
// mesmas para a tela do ERP, para a API e para o inventário de concessões dos
// bots (src/modules/erp/bot-access.ts). Consultar (o boleto gravado e a
// situação no banco) é leitura; registrar, alterar o vencimento, baixar e
// confirmar a baixa são sensíveis (o bot propõe e a pessoa confirma). O PDF,
// os interruptores e a conta financeira ficam só na tela. As rotas do Worker ficam em ./routes.ts.
// Só sintaxe TypeScript apagável.

/** Segmento das rotas no Worker (/api/v1/profiles/:profile/erp-boleto). */
export const ERP_BOLETO_ROUTE = "erp-boleto";
/** Parte do ERP dona do boleto pelo banco: a Cobrança bancária (que depende do Financeiro). */
export const ERP_BOLETO_PART = "erp-cobranca" as const;

export type BoletoBank = "inter" | "sicoob" | "bb" | "itau";
export const BOLETO_BANKS: readonly BoletoBank[] = Object.freeze(["inter", "sicoob", "bb", "itau"]);

/** Campo que a pessoa digita na configuração da conta financeira. */
export interface BoletoBankField {
  key: string;
  label: string;
  /** Segredo: vai para o cofre do núcleo e nunca volta nas leituras. */
  secret: boolean;
  required: boolean;
  /** Validação do valor (texto, sem espaços nas pontas). */
  pattern?: string;
  hint?: string;
  multiline?: boolean;
}

export interface BoletoBankInfo {
  id: BoletoBank;
  /** Código de compensação (3 dígitos). */
  code: string;
  name: string;
  /** O banco exige certificado (mTLS) nas chamadas. */
  certificate: "obrigatorio" | "producao" | "nao";
  /** O banco tem ambiente de homologação/sandbox. */
  sandbox: boolean;
  /** O banco avisa a liquidação por webhook (senão, só pela consulta periódica). */
  webhook: boolean;
  /** Boleto híbrido (boleto com Pix) oferecido pelo banco. */
  hybrid: "sempre" | "opcional" | "nao";
  fields: readonly BoletoBankField[];
}

const CERT: readonly BoletoBankField[] = [
  { key: "certificado", label: "Certificado da API (arquivo .crt ou .pem, em texto)", secret: true, required: true, multiline: true,
    hint: "Abra o arquivo do certificado num editor de texto e cole tudo, de -----BEGIN CERTIFICATE----- até -----END CERTIFICATE-----." },
  { key: "chave_privada", label: "Chave privada do certificado (arquivo .key, em texto)", secret: true, required: true, multiline: true,
    hint: "Cole de -----BEGIN PRIVATE KEY----- até -----END PRIVATE KEY-----." },
];
const OAUTH: readonly BoletoBankField[] = [
  { key: "client_id", label: "Client ID", secret: true, required: true },
  { key: "client_secret", label: "Client Secret", secret: true, required: true },
];

export const BOLETO_BANK_INFO: Readonly<Record<BoletoBank, BoletoBankInfo>> = Object.freeze({
  inter: {
    id: "inter", code: "077", name: "Banco Inter", certificate: "obrigatorio", sandbox: true, webhook: true, hybrid: "sempre",
    fields: [...OAUTH, ...CERT,
      { key: "conta_corrente", label: "Conta corrente no Inter (só números, com o dígito)", secret: false, required: false, pattern: "^\\d{1,20}$",
        hint: "Só quando a aplicação do Inter atende mais de uma conta." }],
  },
  sicoob: {
    id: "sicoob", code: "756", name: "Sicoob", certificate: "producao", sandbox: true, webhook: false, hybrid: "opcional",
    fields: [{ key: "client_id", label: "Client ID", secret: true, required: true }, ...CERT.map(field => ({ ...field, required: false })),
      { key: "token_sandbox", label: "Token do sandbox (só na homologação)", secret: true, required: false },
      { key: "numero_cliente", label: "Número do cliente (código do beneficiário no Sicoob)", secret: false, required: true, pattern: "^\\d{1,10}$" },
      { key: "conta_corrente", label: "Número da conta corrente", secret: false, required: true, pattern: "^\\d{1,12}$" },
      { key: "modalidade", label: "Modalidade de cobrança", secret: false, required: false, pattern: "^\\d{1,2}$", hint: "1 = simples com registro (o padrão)." }],
  },
  bb: {
    id: "bb", code: "001", name: "Banco do Brasil", certificate: "producao", sandbox: true, webhook: true, hybrid: "opcional",
    fields: [...OAUTH, { key: "chave_desenvolvedor", label: "Chave do desenvolvedor (gw-dev-app-key)", secret: true, required: true },
      ...CERT.map(field => ({ ...field, required: false })),
      { key: "convenio", label: "Número do convênio de cobrança (7 dígitos)", secret: false, required: true, pattern: "^\\d{7}$" },
      { key: "carteira", label: "Carteira", secret: false, required: true, pattern: "^\\d{1,3}$", hint: "Normalmente 17." },
      { key: "variacao", label: "Variação da carteira", secret: false, required: true, pattern: "^\\d{1,3}$", hint: "Normalmente 35." }],
  },
  itau: {
    id: "itau", code: "341", name: "Itaú", certificate: "obrigatorio", sandbox: true, webhook: true, hybrid: "opcional",
    fields: [...OAUTH, ...CERT,
      { key: "beneficiario", label: "Id do beneficiário (agência com 4 dígitos, conta com 7 e o dígito: 12 números)", secret: false, required: true, pattern: "^\\d{12}$" },
      { key: "carteira", label: "Carteira", secret: false, required: true, pattern: "^\\d{3}$", hint: "Normalmente 109." }],
  },
});

/** Banco pelo código de compensação da instituição da conta financeira. */
export const bankByCode = (code: unknown): BoletoBank | null =>
  BOLETO_BANKS.find(id => BOLETO_BANK_INFO[id].code === String(code ?? "").padStart(3, "0").slice(-3)) ?? null;

/** Situação do boleto no Wabotia (migrations/0260_erp_boleto_api.sql). */
export type BoletoStatus = "registrando" | "incerto" | "registrado" | "pago" | "baixado" | "falhou";
export const BOLETO_STATUS_LABELS: Readonly<Record<BoletoStatus, string>> = Object.freeze({
  registrando: "Registrando no banco", incerto: "Sem resposta do banco: confira",
  registrado: "Registrado no banco", pago: "Pago no banco", baixado: "Baixado (cancelado) no banco", falhou: "O banco recusou o registro",
});
/** O que falta fazer no Financeiro, como na cobrança por Pix ou link (src/erp/conversa/charges.ts). */
export type BoletoSettleState = "aguardando" | "baixar" | "sugestao" | "baixada" | "pendencia" | "encerrada";
export const BOLETO_SETTLE_LABELS: Readonly<Record<BoletoSettleState, string>> = Object.freeze({
  aguardando: "Aguardando pagamento", baixar: "Pago: baixando a conta", sugestao: "Pago: confirme a baixa",
  baixada: "Pago e baixado", pendencia: "Pago: confira a conta", encerrada: "Encerrado sem pagamento",
});

export interface ErpBoletoOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela (configuração do administrador), fora do inventário dos bots. */
  bot?: boolean;
  /** Só o administrador da área. */
  admin?: boolean;
}

export const ERP_BOLETO_OPERATIONS: readonly ErpBoletoOperation[] = Object.freeze([
  {
    name: "erp.boleto.bancos", method: "GET", path: `${ERP_BOLETO_ROUTE}/bancos`, sensitive: false, bot: false,
    summary: "Ver os bancos de boleto por API e os interruptores",
    description: "Mostra os bancos que registram boleto pela API (Banco Inter, Sicoob, Banco do Brasil e Itaú), se cada um está ligado na área e em qual ambiente (homologação ou produção). Só consulta.",
    body: [], required: [],
  },
  {
    name: "erp.boleto.bancos.salvar", method: "POST", path: `${ERP_BOLETO_ROUTE}/bancos/:banco`, sensitive: true, bot: false, admin: true,
    summary: "Ligar ou desligar um banco de boleto por API",
    description: "Liga ou desliga o registro de boleto pela API de um banco na área e escolhe homologação ou produção. Nasce desligado. Só o administrador; ligar em produção pede a confirmação do aviso.",
    body: ["ligado", "ambiente", "confirmo"], required: [],
  },
  {
    name: "erp.boleto.conta_financeira", method: "GET", path: `${ERP_BOLETO_ROUTE}/contas-financeiras/:conta`, sensitive: false, bot: false,
    summary: "Ver como a conta financeira emite boleto (API ou CNAB)",
    description: "Mostra se a conta financeira emite boleto pela API do banco ou pela remessa CNAB, o banco, os dados guardados (os segredos aparecem só como guardados) e o endereço do aviso de pagamento. Só consulta.",
    body: [], required: [],
  },
  {
    name: "erp.boleto.conta_financeira.salvar", method: "POST", path: `${ERP_BOLETO_ROUTE}/contas-financeiras/:conta`, sensitive: true, bot: false, admin: true,
    summary: "Escolher API ou CNAB na conta financeira e guardar as credenciais do banco",
    description: "Escolhe se a conta financeira emite boleto pela API do banco ou pela remessa CNAB e guarda as credenciais e o certificado digitados no cofre de segredos. Só o administrador.",
    body: ["modo", "banco", "campos", "hibrido", "testar"], required: [],
  },
  {
    name: "erp.boleto.ver", method: "GET", path: `${ERP_BOLETO_ROUTE}/conta/:id`, sensitive: false,
    summary: "Consultar o boleto de uma conta a receber",
    description: "Mostra o boleto registrado pela API do banco para a conta a receber: banco, nosso número, linha digitável, código de barras, Pix do boleto híbrido, vencimento, situação no banco e a baixa no Financeiro (aguardando, sugestão de baixa, baixada ou pendência). Só consulta, sem chamar o banco.",
    body: [], required: [],
  },
  {
    name: "erp.boleto.registrar", method: "POST", path: `${ERP_BOLETO_ROUTE}/conta/:id/registrar`, sensitive: true,
    summary: "Registrar no banco o boleto de uma conta a receber",
    description: "Registra a conta a receber em aberto como boleto pela API do banco da conta financeira escolhida, com o saldo e o vencimento da conta, e grava no título a linha digitável, o código de barras e o Pix do boleto híbrido. Registrar de novo a mesma conta devolve o mesmo boleto. O bot propõe e a pessoa confirma.",
    body: ["conta_financeira"], required: [],
  },
  {
    name: "erp.boleto.consultar_banco", method: "GET", path: `${ERP_BOLETO_ROUTE}/conta/:id/banco`, sensitive: false,
    summary: "Perguntar ao banco a situação do boleto",
    description: "Consulta na API do banco a situação do boleto da conta a receber (em aberto, pago ou baixado) e atualiza a linha digitável e o Pix. Pago no banco vira a sugestão de baixa no Financeiro (ou a baixa automática, se o administrador ligou a opção). Só consulta: não muda nada no banco.",
    body: [], required: [],
  },
  {
    name: "erp.boleto.vencimento", method: "POST", path: `${ERP_BOLETO_ROUTE}/conta/:id/vencimento`, sensitive: true,
    summary: "Alterar no banco o vencimento do boleto",
    description: "Pede ao banco a nova data de vencimento do boleto registrado da conta a receber. A conta no Financeiro não muda. O bot propõe e a pessoa confirma.",
    body: ["vencimento"], required: ["vencimento"],
  },
  {
    name: "erp.boleto.baixar", method: "POST", path: `${ERP_BOLETO_ROUTE}/conta/:id/baixar`, sensitive: true,
    summary: "Baixar (cancelar) no banco o boleto",
    description: "Pede ao banco a baixa do boleto registrado da conta a receber: o cliente não consegue mais pagar. A conta no Financeiro continua em aberto. O bot propõe e a pessoa confirma.",
    body: ["motivo"], required: ["motivo"],
  },
  {
    name: "erp.boleto.confirmar_baixa", method: "POST", path: `${ERP_BOLETO_ROUTE}/conta/:id/confirmar-baixa`, sensitive: true,
    summary: "Confirmar a sugestão de baixa de uma conta paga por boleto",
    description: "Baixa a conta a receber pelo pagamento do boleto que o banco confirmou, na conta financeira do boleto, com o comprovante do banco na observação. Exige o papel de baixar contas a receber no ERP. Se a conta foi baixada ou mudada à mão depois do registro, não baixa e avisa. O bot propõe e a pessoa confirma.",
    body: [], required: [],
  },
  {
    name: "erp.boleto.pdf", method: "GET", path: `${ERP_BOLETO_ROUTE}/conta/:id/pdf`, sensitive: false, bot: false,
    summary: "Baixar o PDF do boleto de uma conta a receber",
    description: "Devolve o PDF do boleto da conta a receber (layout de ficha de compensação, com o código de barras desenhado), a partir dos dados registrados no banco. Sem os dados suficientes, diz o que falta. Só consulta.",
    body: [], required: [],
  },
]);

const propertySchemas: Record<string, Record<string, unknown>> = {
  id: { type: "string", format: "uuid", description: "Conta a receber no ERP." },
  conta_financeira: { type: ["string", "null"], format: "uuid", description: "Conta financeira do ERP que emite o boleto pela API (sem ela, a conta padrão de boletos)." },
  vencimento: { type: "string", format: "date", description: "Nova data de vencimento (AAAA-MM-DD), de hoje em diante." },
  motivo: { type: "string", minLength: 3, maxLength: 200, description: "Por que o boleto está sendo baixado no banco." },
};

/** Parâmetros (caminho e corpo) num objeto, para o catálogo do bot. */
export function erpBoletoParams(operation: ErpBoletoOperation) {
  const path = (operation.path.match(/:[a-z_]+/g) ?? []).map(key => key.slice(1));
  const keys = [...path, ...operation.body];
  return { type: "object" as const, properties: Object.fromEntries(keys.map(key => [key, propertySchemas[key] ?? { type: "string" }])), required: [...path, ...operation.required] };
}

/** Contrato leve do módulo erp-cobranca: a rota (desligada, 409 module_disabled antes de tudo) e o catálogo dos bots. */
export const ERP_BOLETO_MODULE_CONTRACT = {
  routes: [ERP_BOLETO_ROUTE], operations: ["erp.boleto."],
  definition: { bot: { sensitive: ERP_BOLETO_OPERATIONS.filter(op => op.sensitive && op.bot !== false).map(op => op.name),
    hints: Object.fromEntries(ERP_BOLETO_OPERATIONS.filter(op => op.bot !== false).map(op => [op.name, op.summary])) } },
};

/** A operação de uma rota do Worker (caminho depois de /api/v1/profiles/:profile/). */
export function erpBoletoOperationFor(method: string, path: string): { operation: ErpBoletoOperation; params: Record<string, string> } | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const parts = path.replace(/\/$/, "").split("/");
  for (const operation of ERP_BOLETO_OPERATIONS) {
    if (operation.method !== verb) continue;
    const pattern = operation.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((segment, index) => segment.startsWith(":") ? (params[segment.slice(1)] = parts[index]!, parts[index] !== "") : segment === parts[index]))
      return { operation, params };
  }
  return null;
}
