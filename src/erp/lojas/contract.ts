// Lojas e filiais do ERP (cadastro da Base, parte erp), em
// /api/v1/profiles/:profile/erp-lojas.
//
// Operações com nome estável e descrição em português: as mesmas para a tela
// do ERP (Cadastros › Lojas), para a API e para o inventário de concessões dos
// bots (src/modules/erp/bot-access.ts, assunto Lojas). Consultar as lojas e o
// relatório por loja é leitura comum; a lista de operações de uma loja traz
// nomes de clientes e é leitura sensível. Gravar (cadastro, limite da pessoa,
// loja em uso, mudar a loja de um registro) é só pela tela. As rotas ficam em
// ./routes.ts. Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker. */
export const ERP_LOJAS_ROUTE = "erp-lojas";
/** Lojas é cadastro da Base: cada seção do relatório confere a parte dela no motor. */
export const ERP_LOJAS_PART: ErpModuleId = "erp";

export interface ErpStoreOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_LOJAS_ROUTE;
export const ERP_STORE_OPERATIONS: readonly ErpStoreOperation[] = Object.freeze([
  {
    name: "erp.lojas.listar", method: "GET", path: R, sensitive: false, rpc: "erp_store_overview",
    summary: "Ver as lojas",
    description: "Lista as lojas da empresa (nome, endereço, telefone, CNPJ da filial, depósitos e caixas), a loja em uso e as lojas que a pessoa pode ver. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.lojas.relatorio", method: "GET", path: `${R}/relatorio`, sensitive: false, rpc: "erp_store_report",
    summary: "Comparar as lojas no período",
    description: "Vendas (pedidos, total, tíquete médio e o que veio do caixa), caixa (entradas, saídas, saldo e sessões), estoque (quantidade, custo e valor de venda) e o DRE gerencial de cada loja lado a lado, com o total. Cada parte só com o módulo ligado e o papel que a vê. Só consulta.",
    query: ["de", "ate", "lojas", "regime"], body: [], required: ["de", "ate"],
  },
  {
    name: "erp.lojas.operacoes", method: "GET", path: `${R}/operacoes`, sensitive: true, rpc: "erp_store_operations",
    summary: "Ver as operações de uma loja",
    description: "Lista pedidos de venda, propostas, pedidos de compra, contas a pagar e receber, movimentações de estoque ou vendas do caixa de uma loja (ou de todas as que a pessoa vê), com filtro de período. Traz nomes de clientes: o bot propõe e a pessoa confirma.",
    query: ["tipo", "loja", "de", "ate", "pagina", "limite"], body: [], required: ["tipo"],
  },
  {
    name: "erp.lojas.salvar", method: "POST", path: R, sensitive: true, rpc: "erp_store_save", bot: false,
    summary: "Cadastrar ou alterar uma loja",
    description: "Cria ou altera a loja: nome, endereço, telefone, CNPJ da filial, série das notas, depósitos e caixas dela e o depósito padrão. Só o administrador, pela tela.",
    query: [], body: ["id", "versao", "nome", "endereco", "telefone", "cnpj", "serie", "ativa", "depositos", "contas", "deposito_padrao", "comando"], required: [],
  },
  {
    name: "erp.lojas.pessoa", method: "POST", path: `${R}/pessoas`, sensitive: true, rpc: "erp_store_person_set", bot: false,
    summary: "Limitar uma pessoa a algumas lojas",
    description: "Define as lojas que a pessoa vê e opera (lista vazia: todas). O administrador vê todas sempre. Só o administrador, pela tela.",
    query: [], body: ["pessoa", "lojas", "comando"], required: ["pessoa", "lojas"],
  },
  {
    name: "erp.lojas.em_uso", method: "POST", path: `${R}/em-uso`, sensitive: false, rpc: "erp_store_select", bot: false,
    summary: "Escolher a loja em uso",
    description: "A loja em uso estreita listas e relatórios e é a loja do que a pessoa cria (vazio: todas as lojas da pessoa). Pela tela.",
    query: [], body: ["loja"], required: [],
  },
  {
    name: "erp.lojas.vincular", method: "POST", path: `${R}/vincular`, sensitive: true, rpc: "erp_store_assign", bot: false,
    summary: "Mudar a loja de um documento ou conta",
    description: "Passa um documento (pedido, proposta, compra) ou uma conta a pagar ou receber para outra loja. A pessoa precisa ver as duas lojas. Pela tela.",
    query: [], body: ["registro", "id", "loja", "comando"], required: ["registro", "id", "loja"],
  },
]);

/** A operação do método e do caminho (depois de /profiles/:profile/). */
export function erpStoreOperationFor(method: string, path: string): ErpStoreOperation | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const clean = path.replace(/\/+$/, "");
  return ERP_STORE_OPERATIONS.find((op) => op.method === verb && op.path === clean) ?? null;
}

/** Parâmetros da operação para o catálogo dos bots (JSON Schema simples). */
export function erpStoreParams(op: ErpStoreOperation) {
  const describe: Record<string, any> = {
    de: { type: "string", description: "Data inicial (AAAA-MM-DD)." },
    ate: { type: "string", description: "Data final (AAAA-MM-DD)." },
    lojas: { type: "string", description: "Ids das lojas separados por vírgula (vazio: todas as que a pessoa vê)." },
    regime: { type: "string", enum: ["caixa", "competencia"], description: "Regime do DRE (padrão: caixa)." },
    tipo: { type: "string", enum: ["pedidos", "propostas", "compras", "contas", "estoque", "caixa"], description: "O que listar." },
    loja: { type: "string", description: "Id da loja (vazio: todas as que a pessoa vê)." },
    pagina: { type: "integer", minimum: 1 },
    limite: { type: "integer", minimum: 1, maximum: 100 },
  };
  const keys = [...op.query, ...op.body.filter((k) => k !== "comando")];
  return { type: "object" as const, properties: Object.fromEntries(keys.map((k) => [k, describe[k] ?? { type: "string" }])), required: [...op.required] };
}

/** Tipo da lista em português → o do motor. */
export const STORE_OPERATION_KINDS: Readonly<Record<string, string>> = Object.freeze({
  pedidos: "sales_orders", propostas: "sales_proposals", compras: "purchase_orders", contas: "titles", estoque: "stock_moves", caixa: "pos_sales",
});
