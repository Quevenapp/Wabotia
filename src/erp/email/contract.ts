// Documentos do ERP por e-mail: proposta, pedido de venda, pedido de compra
// ao fornecedor, NF-e autorizada (DANFE e XML), NFC-e quando o cliente pede e
// conta a receber (boleto, Pix ou link), pelo e-mail da instalação (o mesmo
// do pacote do contador, src/email.ts).
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP, para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts). Enviar e reenviar são sensíveis: o bot
// propõe e a pessoa confirma. As rotas do Worker ficam em ./routes.ts.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { erpRequirement, type ErpModuleId, type ErpRequirement } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp: desligado, 409 module_disabled). */
export const ERP_EMAIL_ROUTE = "erp-email";

export type ErpEmailDocType = "proposta" | "pedido" | "compra" | "nota" | "nfce" | "conta";
export const ERP_EMAIL_DOC_TYPES: readonly ErpEmailDocType[] = Object.freeze(["proposta", "pedido", "compra", "nota", "nfce", "conta"]);

/** Parte do ERP dona de cada documento (src/erp/parts.ts). */
export const ERP_EMAIL_PARTS: Readonly<Record<ErpEmailDocType, ErpModuleId>> = Object.freeze({
  proposta: "erp-vendas", pedido: "erp-vendas", compra: "erp-compras", nota: "erp-fiscal", nfce: "erp-fiscal", conta: "erp-financeiro",
});
/** Tudo o que o documento precisa ligado (NFC-e: Fiscal e Caixa / PDV). */
export function erpEmailRequirement(type: ErpEmailDocType): ErpRequirement {
  return type === "nfce" ? erpRequirement("erp-fiscal", "erp-pdv") : erpRequirement(ERP_EMAIL_PARTS[type]);
}

export const ERP_EMAIL_DOC_LABELS: Readonly<Record<ErpEmailDocType, string>> = Object.freeze({
  proposta: "proposta comercial", pedido: "pedido de venda", compra: "pedido de compra", nota: "nota fiscal (NF-e)", nfce: "cupom fiscal (NFC-e)", conta: "conta a receber",
});

export interface ErpEmailOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  body: readonly string[];
  required: readonly string[];
  query: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

export const ERP_EMAIL_OPERATIONS: readonly ErpEmailOperation[] = Object.freeze([
  {
    name: "erp.email.situacao", method: "GET", path: ERP_EMAIL_ROUTE, sensitive: false,
    summary: "Ver se a instalação envia documentos do ERP por e-mail",
    description: "Diz se o e-mail da instalação está configurado (sem ele, onde o administrador configura: Gestão → Sistema → E-mail) e o remetente que aparece para o cliente. Só consulta.",
    body: [], required: [], query: [],
  },
  {
    name: "erp.email.preparar", method: "GET", path: `${ERP_EMAIL_ROUTE}/:tipo/:id`, sensitive: false,
    summary: "Preparar o envio de um documento do ERP por e-mail",
    description: "Mostra o destinatário sugerido pelo e-mail do cadastro (o de NF-e para notas), as cópias e o responder-para das Preferências, o assunto e o texto do modelo de e-mail do tipo de documento, os anexos (PDF igual ao da impressão, DANFE e XML da nota, boleto) e os envios anteriores. Tipos: proposta, pedido, compra, nota, nfce e conta. Só consulta, sem enviar nada.",
    body: [], required: [], query: ["pagamento"],
  },
  {
    name: "erp.email.envios", method: "GET", path: `${ERP_EMAIL_ROUTE}/:tipo/:id/envios`, sensitive: false,
    summary: "Ver os envios de um documento do ERP por e-mail",
    description: "Lista quando o documento foi enviado por e-mail, para quem (e cópias), por quem e a situação (enviado, na fila do provedor, devolvido ou falhou e por quê). Só consulta.",
    body: [], required: [], query: [],
  },
  {
    name: "erp.email.enviar", method: "POST", path: `${ERP_EMAIL_ROUTE}/:tipo/:id/enviar`, sensitive: true,
    summary: "Enviar um documento do ERP por e-mail",
    description: "Envia por e-mail, pelo e-mail da instalação com o nome da empresa como remetente, a proposta ou o pedido de venda (PDF igual ao da impressão), o pedido de compra ao fornecedor, a nota fiscal autorizada (DANFE e XML, como manda a regra da NF-e), o cupom fiscal NFC-e e a cobrança da conta a receber em aberto (boleto em PDF, Pix ou link). Destinatário e cópias editáveis; assunto e texto do modelo das Preferências, editáveis. Exige poder ver o documento no ERP. Fica registrado no documento. Pelo bot, o bot propõe e a pessoa confirma.",
    body: ["para", "copias", "assunto", "mensagem", "xml", "pagamento"], required: ["para"], query: [],
  },
  {
    name: "erp.email.reenviar", method: "POST", path: `${ERP_EMAIL_ROUTE}/:tipo/:id/envios/:envio/reenviar`, sensitive: true,
    summary: "Reenviar um e-mail de documento do ERP",
    description: "Envia de novo, aos mesmos destinatários e com o mesmo assunto e texto, um envio anterior do documento; os anexos são lidos de novo do ERP (a nota continua a mesma). Fica registrado como reenvio. Pelo bot, o bot propõe e a pessoa confirma.",
    body: [], required: [], query: [],
  },
]);

const emailItem = { type: "string", format: "email", maxLength: 254 };
const propertySchemas: Record<string, Record<string, unknown>> = {
  tipo: { type: "string", enum: [...ERP_EMAIL_DOC_TYPES], description: "proposta, pedido (de venda), compra (pedido de compra), nota (NF-e), nfce (cupom fiscal) ou conta (conta a receber)." },
  id: { type: "string", format: "uuid", description: "Documento no ERP (nota: a emissão da NF-e; nfce: a venda do caixa)." },
  envio: { type: "string", minLength: 1, maxLength: 64, description: "Envio anterior do documento (id devolvido no envio)." },
  para: { ...emailItem, description: "E-mail do destinatário. Fora do cadastro fica registrado como tal." },
  copias: { type: "array", maxItems: 5, items: emailItem, description: "Endereços em cópia (até 5)." },
  assunto: { type: "string", minLength: 1, maxLength: 200, description: "Assunto; sem ele, o do modelo das Preferências." },
  mensagem: { type: "string", minLength: 1, maxLength: 20000, description: "Texto; sem ele, o do modelo das Preferências." },
  xml: { type: "boolean", description: "NFC-e: anexar também o XML (na NF-e o XML vai sempre)." },
  pagamento: { type: "string", enum: ["pix", "link", "boleto", "sem"], description: "Conta a receber: como o cliente paga (Pix ou link da Cobrança; boleto em PDF, se a conta tem boleto; sem: só o aviso)." },
};

/** Parâmetros (caminho, consulta e corpo) num objeto, para o catálogo do bot. */
export function erpEmailParams(operation: ErpEmailOperation) {
  const path = (operation.path.match(/:[a-z_]+/g) ?? []).map(key => key.slice(1));
  const keys = [...path, ...operation.query, ...operation.body];
  return { type: "object" as const, properties: Object.fromEntries(keys.map(key => [key, propertySchemas[key]])), required: [...path, ...operation.required] };
}

export const erpEmailOperation = (name: string) => ERP_EMAIL_OPERATIONS.find(operation => operation.name === name) ?? null;

/** A operação de uma rota do Worker (caminho depois de /api/v1/profiles/:profile/). */
export function erpEmailOperationFor(method: string, path: string): { operation: ErpEmailOperation; params: Record<string, string> } | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const parts = path.replace(/\/$/, "").split("/");
  for (const operation of ERP_EMAIL_OPERATIONS) {
    if (operation.method !== verb) continue;
    const pattern = operation.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((segment, index) => segment.startsWith(":") ? (params[segment.slice(1)] = parts[index]!, parts[index] !== "") : segment === parts[index]))
      return { operation, params };
  }
  return null;
}

/** Contrato leve: rotas e operações do módulo erp, catálogo dos bots e OpenAPI. */
export const ERP_EMAIL_MODULE_CONTRACT = {
  routes: [ERP_EMAIL_ROUTE], operations: ["erp.email."],
  definition: { bot: { sensitive: ERP_EMAIL_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(ERP_EMAIL_OPERATIONS.map(op => [op.name, op.summary])) } },
  openapi: { paths: Object.fromEntries([...new Set(ERP_EMAIL_OPERATIONS.map(op => op.path))].map(path => [
    `/profiles/{profile}/${path.replace(/:([a-z_]+)/g, "{$1}")}`,
    Object.fromEntries(ERP_EMAIL_OPERATIONS.filter(op => op.path === path).map(op => [op.method.toLowerCase(), {
      operationId: op.name, summary: op.summary,
      description: `${op.description} Permissão: erp e a parte do ERP do documento. ${op.sensitive ? "Categoria sensível; por padrão o bot propõe e a pessoa confirma." : "Leitura comum."}`,
      parameters: [{ name: "profile", in: "path", required: true, schema: { type: "string" } },
        ...(path.match(/:[a-z_]+/g) ?? []).map(key => ({ name: key.slice(1), in: "path", required: true, schema: propertySchemas[key.slice(1)] })),
        ...op.query.map(name => ({ name, in: "query", required: false, schema: propertySchemas[name] }))],
      ...(op.method === "GET" ? {} : { requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(op.body.map(key => [key, propertySchemas[key]])), required: [...op.required] } } } } }),
      responses: { "200": { description: "Resultado" }, "403": { description: "Sem permissão no ERP ou dado restrito" },
        "404": { description: "Documento não encontrado" }, "409": { description: "Parte desligada, documento que não sai ou e-mail não configurado na instalação" } },
    }])),
  ])) },
};
