// Multiempresa: mais de um CNPJ na mesma conta. Cada empresa é uma área de
// atendimento com o ERP dela (um objeto erp: por área); este serviço fica por
// cima: lista as empresas que a pessoa alcança (o seletor do topo do painel),
// junta o resumo de cada ERP lado a lado (Todas as empresas), copia cadastros
// de uma empresa para outra e cria uma empresa nova.
//
// Rotas em /api/v1/profiles/:profile/erp-empresas (./routes.ts). A área da rota
// é a empresa aberta: na cópia, é a empresa que RECEBE os cadastros.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// (Gestão › Empresas), para a API e para o inventário de concessões dos bots
// (src/modules/erp/bot-access.ts, assunto Várias empresas). Ver as empresas e o
// consolidado é leitura; a prévia da cópia traz nomes de clientes (leitura
// sensível); copiar cadastros é escrita sensível. Criar empresa é só pela tela.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker. */
export const ERP_EMPRESAS_ROUTE = "erp-empresas";
/** Multiempresa é da Base do ERP (cada cadastro confere a parte dele). */
export const ERP_EMPRESAS_PART: ErpModuleId = "erp";

/** Limite de empresas lidas numa tela (seletor e consolidado): uma consulta por empresa. */
export const MAX_COMPANIES = 12;
/** Limite de empresas com nome fantasia e CNPJ lidos no seletor (as demais aparecem pelo nome da área). */
export const MAX_SELECTOR = 20;
/** Limite de registros de um tipo numa cópia (acima disso a cópia recusa e explica). */
export const MAX_COPY_RECORDS = 3000;
/** Linhas por lote da importação existente (erp_preferences_import_batch aceita até 50). */
export const IMPORT_BATCH = 50;

/** Cadastros que se copiam, na ordem em que são gravados no destino. */
export const COPY_KINDS = ["formas_pagamento", "categorias_financeiras", "naturezas", "produtos", "contatos"] as const;
export type CopyKind = (typeof COPY_KINDS)[number];
export const COPY_KIND_LABELS: Readonly<Record<CopyKind, string>> = Object.freeze({
  produtos: "Produtos (com categorias e listas de preços)",
  contatos: "Contatos (clientes e fornecedores)",
  formas_pagamento: "Formas de pagamento",
  categorias_financeiras: "Categorias financeiras",
  naturezas: "Naturezas de operação",
});
/** Parte do ERP de cada cadastro (desligada na origem ou no destino: a cópia recusa dizendo o que ligar). */
export const COPY_KIND_PARTS: Readonly<Record<CopyKind, ErpModuleId>> = Object.freeze({
  produtos: "erp-produtos",
  contatos: "erp",
  formas_pagamento: "erp-financeiro",
  categorias_financeiras: "erp-financeiro",
  naturezas: "erp-fiscal",
});

/** Períodos do consolidado (os mesmos do Início do ERP). */
export const CONSOLIDATED_PERIODS = ["hoje", "7d", "30d", "3m", "6m", "12m"] as const;

export interface ErpCompanyOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_EMPRESAS_ROUTE;
export const ERP_COMPANY_OPERATIONS: readonly ErpCompanyOperation[] = Object.freeze([
  {
    name: "erp.empresas.listar", method: "GET", path: R, sensitive: false,
    summary: "Ver as empresas",
    description: "Lista as empresas (CNPJs) da conta em que a pessoa tem papel no ERP, com nome fantasia, razão social, CNPJ e a empresa aberta. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.empresas.consolidado", method: "GET", path: `${R}/consolidado`, sensitive: false,
    summary: "Ver todas as empresas lado a lado",
    description: "Vendas do período, contas a receber e a pagar em aberto (e as vencidas) e o saldo das contas de cada empresa lado a lado, com o total. Só para quem é administrador do ERP em todas as empresas mostradas. Só consulta.",
    query: ["periodo", "empresas"], body: [], required: [],
  },
  {
    name: "erp.empresas.copiar_previa", method: "GET", path: `${R}/copiar/previa`, sensitive: true,
    summary: "Prévia da cópia de cadastros de outra empresa",
    description: "Mostra o que viria de outra empresa para esta (produtos com categorias e listas de preços, contatos, formas de pagamento, categorias financeiras e naturezas): o que é novo, o que já existe e fica como está (produto pelo código, contato pelo CPF/CNPJ) e o que não dá para copiar. Traz nomes de clientes: o bot propõe e a pessoa confirma. Nada é gravado.",
    query: ["origem", "cadastros"], body: [], required: ["origem", "cadastros"],
  },
  {
    name: "erp.empresas.copiar", method: "POST", path: `${R}/copiar`, sensitive: true,
    summary: "Copiar cadastros de outra empresa para esta",
    description: "Copia de outra empresa para esta os cadastros escolhidos, sem duplicar: o que já existe aqui fica como está. Usa a importação do ERP. Só o administrador do ERP nas duas empresas; pelo bot, só com a proposta confirmada pela pessoa.",
    query: [], body: ["origem", "cadastros", "comando"], required: ["origem", "cadastros"],
  },
  {
    name: "erp.empresas.nova", method: "POST", path: `${R}/nova`, sensitive: true, bot: false,
    summary: "Adicionar empresa",
    description: "Cria uma área nova já com o ERP ligado (os mesmos módulos do ERP desta empresa), os dados da empresa (CNPJ, IE, regime, endereço) e as pessoas de acesso escolhidas. Só o administrador da conta, pela tela.",
    query: [], body: ["nome_fantasia", "razao_social", "cnpj", "ie", "regime", "endereco", "telefone", "email", "pessoas"], required: ["nome_fantasia", "razao_social", "cnpj", "regime"],
  },
]);

/** A operação do método e do caminho (depois de /profiles/:profile/). */
export function erpCompanyOperationFor(method: string, path: string): ErpCompanyOperation | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const clean = path.replace(/\/+$/, "");
  return ERP_COMPANY_OPERATIONS.find((op) => op.method === verb && op.path === clean) ?? null;
}

/** Parâmetros da operação para o catálogo dos bots (JSON Schema simples). */
export function erpCompanyParams(op: ErpCompanyOperation) {
  const describe: Record<string, any> = {
    periodo: { type: "string", enum: [...CONSOLIDATED_PERIODS], description: "Período das vendas (padrão: 30d)." },
    empresas: { type: "string", description: "Ids das áreas (empresas) separados por vírgula (vazio: todas, até " + MAX_COMPANIES + ")." },
    origem: { type: "string", description: "Id da área (empresa) de onde vêm os cadastros." },
    cadastros: op.method === "GET"
      ? { type: "string", description: "Cadastros separados por vírgula: " + COPY_KINDS.join(", ") + "." }
      : { type: "array", items: { type: "string", enum: [...COPY_KINDS] }, description: "Cadastros a copiar." },
  };
  const keys = [...op.query, ...op.body.filter((k) => k !== "comando")];
  return { type: "object" as const, properties: Object.fromEntries(keys.map((k) => [k, describe[k] ?? { type: "string" }])), required: [...op.required] };
}

/** Regime tributário na tela → CRT do ERP. */
export const REGIMES: Readonly<Record<string, { crt: string; label: string }>> = Object.freeze({
  simples: { crt: "1", label: "Simples Nacional" },
  simples_excesso: { crt: "2", label: "Simples Nacional com excesso de sublimite" },
  normal: { crt: "3", label: "Regime normal (lucro presumido ou real)" },
  mei: { crt: "4", label: "MEI" },
});
