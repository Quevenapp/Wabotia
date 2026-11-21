// Conciliação bancária e de cartões do ERP (parte Financeiro), em
// /api/v1/profiles/:profile/erp-conciliacao.
//
// Operações com nome estável e descrição em português: as mesmas para as telas
// Financeiro › Conciliação bancária e Conciliação de cartões, para a API e para
// o inventário de concessões dos bots (src/modules/erp/bot-access.ts, assunto
// Conciliação). Consultar as pendências é leitura comum; conciliar uma linha
// do extrato e receber o cartão na conta (baixas) são sensíveis: o bot propõe
// e a pessoa confirma. Importar arquivos, regras, modelos e taxas são só da
// tela. As rotas ficam em ./routes.ts; com o Financeiro desligado a rota
// responde 409 module_disabled dizendo o que ligar.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp-financeiro). */
export const ERP_CONCILIACAO_ROUTE = "erp-conciliacao";
/** A parte dona (Financeiro, que depende de Cadastros). */
export const ERP_CONCILIACAO_PART: ErpModuleId = "erp-financeiro";

export interface ErpReconciliationOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  sensitive: boolean;
  rpc: string;
  /** O RPC só lê (a prévia do arquivo vem por POST, mas não grava). */
  read?: boolean;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  /** false: só pela tela, fora do inventário dos bots. */
  bot?: boolean;
}

const R = ERP_CONCILIACAO_ROUTE;
export const ERP_RECONCILIATION_OPERATIONS: readonly ErpReconciliationOperation[] = Object.freeze([
  {
    name: "erp.conciliacao.resumo", method: "GET", path: `${R}/resumo`, sensitive: false, rpc: "erp_reconciliation_overview",
    summary: "Ver as contas a conciliar",
    description: "Lista as contas financeiras com quantas linhas do extrato estão pendentes, conciliadas e ignoradas, e a data do último lançamento importado; também as regras salvas, os modelos de planilha e as taxas de cartão contratadas. Só consulta.",
    query: [], body: [], required: [],
  },
  {
    name: "erp.conciliacao.banco", method: "GET", path: `${R}/banco/:conta`, sensitive: false, rpc: "erp_reconciliation_bank_lines",
    summary: "Ver as pendências do extrato de uma conta",
    description: "Mostra as linhas do extrato bancário de uma conta (pendentes, conciliadas, ignoradas ou todas), cada pendente com as sugestões e o grau de confiança (baixa, lançamento ou transferência já registrados, conta em aberto pelo valor, vencimento e nome, recebimento de cartão ou regra salva), e o saldo do banco x saldo do sistema por dia com a diferença. Só consulta.",
    query: ["situacao", "de", "ate", "busca"], body: [], required: ["conta"],
  },
  {
    name: "erp.conciliacao.banco.candidatos", method: "GET", path: `${R}/banco/linhas/:id/candidatos`, sensitive: false, rpc: "erp_reconciliation_bank_candidates", bot: false,
    summary: "Procurar lançamentos e contas para uma linha do extrato",
    description: "Lançamentos ainda não conciliados e contas em aberto perto da data da linha, para conciliar à mão. Pela tela.",
    query: ["busca", "de", "ate"], body: [], required: ["id"],
  },
  {
    name: "erp.conciliacao.previa", method: "POST", path: `${R}/previa`, sensitive: false, rpc: "erp_reconciliation_preview", read: true, bot: false,
    summary: "Conferir um arquivo antes de importar",
    description: "Lê o OFX ou a planilha do banco, ou a planilha da adquirente, sem gravar: as colunas achadas, o período, os totais e as primeiras linhas. Pela tela.",
    query: [], body: ["alvo", "tipo", "formato", "conteudo", "modelo", "colunas"], required: ["alvo", "conteudo"],
  },
  {
    name: "erp.conciliacao.banco.importar", method: "POST", path: `${R}/banco/:conta/importar`, sensitive: true, rpc: "erp_reconciliation_bank_import", bot: false,
    summary: "Importar o extrato do banco",
    description: "Importa o extrato OFX ou a planilha (com o modelo de colunas do banco) na conta; cada lançamento vira uma linha a conciliar. O mesmo arquivo de novo, ou a mesma linha em outro arquivo, não duplica. Pela tela.",
    query: [], body: ["formato", "arquivo", "conteudo", "modelo", "colunas", "salvar_modelo", "comando"], required: ["formato", "conteudo"],
  },
  {
    name: "erp.conciliacao.banco.conciliar", method: "POST", path: `${R}/banco/linhas/:id`, sensitive: true, rpc: "erp_reconciliation_bank_action",
    summary: "Conciliar uma linha do extrato",
    description: "Confirma o casamento sugerido (ou escolhido), baixa a conta em aberto pela linha do extrato, cria o lançamento pela regra ou pela categoria escolhida, ignora a linha com o motivo, volta a linha ignorada para a fila ou desfaz a conciliação (com ou sem estornar a baixa). O bot propõe e a pessoa confirma.",
    query: [], body: ["acao", "versao", "vinculos", "contas", "regra", "categoria", "contato", "observacao", "motivo", "estornar", "comando"], required: ["acao", "versao"],
  },
  {
    name: "erp.conciliacao.regra.salvar", method: "POST", path: `${R}/regras`, sensitive: true, rpc: "erp_reconciliation_rule_save", bot: false,
    summary: "Salvar uma regra de conciliação",
    description: "Grava o texto procurado na descrição do extrato (por exemplo \"tarifa\"), se vale para entradas, saídas ou as duas, a conta (ou todas) e a categoria do lançamento (por exemplo Despesas bancárias). Pela tela.",
    query: [], body: ["id", "versao", "nome", "texto", "direcao", "conta", "categoria", "contato", "observacao", "ativa", "comando"], required: ["texto", "categoria"],
  },
  {
    name: "erp.conciliacao.modelo.salvar", method: "POST", path: `${R}/modelos`, sensitive: true, rpc: "erp_reconciliation_layout_save", bot: false,
    summary: "Salvar um modelo de planilha",
    description: "Grava qual coluna da planilha é cada informação (data, descrição, valor, crédito, débito, saldo; ou, na adquirente, data da venda, pagamento, bandeira, parcelas, bruto, taxa, líquido, NSU), por banco ou por adquirente. Pela tela.",
    query: [], body: ["id", "versao", "tipo", "nome", "adquirente", "conta", "colunas", "ativo", "comando"], required: ["tipo", "nome", "colunas"],
  },
  {
    name: "erp.conciliacao.cartao", method: "GET", path: `${R}/cartao`, sensitive: false, rpc: "erp_reconciliation_card_lines",
    summary: "Ver a conciliação de cartões",
    description: "Lista as vendas e os recebíveis importados da adquirente com a venda do PDV ou do pedido casada (e a confiança), a taxa cobrada x a contratada, o prazo, o que já foi recebido, o que ainda vai cair por dia e as contas de cartão em aberto. Só consulta.",
    query: ["tipo", "situacao", "adquirente", "de", "ate", "busca", "divergentes"], body: [], required: [],
  },
  {
    name: "erp.conciliacao.cartao.candidatos", method: "GET", path: `${R}/cartao/linhas/:id/candidatos`, sensitive: false, rpc: "erp_reconciliation_card_candidates", bot: false,
    summary: "Procurar vendas para uma linha da adquirente",
    description: "As vendas no cartão (PDV e pedidos) mais parecidas com a linha, para casar à mão. Pela tela.",
    query: [], body: [], required: ["id"],
  },
  {
    name: "erp.conciliacao.cartao.importar", method: "POST", path: `${R}/cartao/importar`, sensitive: true, rpc: "erp_reconciliation_card_import", bot: false,
    summary: "Importar o extrato da adquirente",
    description: "Importa a planilha de vendas ou de recebíveis da adquirente (com o modelo de colunas salvo) e procura a venda de cada linha. O mesmo arquivo de novo não duplica. Pela tela.",
    query: [], body: ["adquirente", "tipo", "arquivo", "conteudo", "modelo", "colunas", "salvar_modelo", "comando"], required: ["adquirente", "tipo", "conteudo"],
  },
  {
    name: "erp.conciliacao.cartao.acao", method: "POST", path: `${R}/cartao/linhas/:id`, sensitive: true, rpc: "erp_reconciliation_card_action", bot: false,
    summary: "Casar, ignorar ou desfazer uma linha da adquirente",
    description: "Confirma a venda sugerida, casa com outra venda, desfaz o casamento, ignora com motivo, volta para a fila ou desfaz o recebimento. Pela tela.",
    query: [], body: ["acao", "versao", "conta_receber", "grupo", "motivo", "comando"], required: ["acao", "versao"],
  },
  {
    name: "erp.conciliacao.cartao.lote", method: "POST", path: `${R}/cartao/lote`, sensitive: true, rpc: "erp_reconciliation_card_action", bot: false,
    summary: "Confirmar as sugestões ou procurar de novo",
    description: "Confirma de uma vez as vendas sugeridas com confiança alta, ou procura de novo a venda das linhas pendentes (vendas lançadas depois da importação). Pela tela.",
    query: [], body: ["acao", "confianca_minima", "comando"], required: ["acao"],
  },
  {
    name: "erp.conciliacao.cartao.receber", method: "POST", path: `${R}/cartao/receber`, sensitive: true, rpc: "erp_reconciliation_card_receive",
    summary: "Receber vendas de cartão na conta",
    description: "Baixa as contas das vendas escolhidas pelo valor bruto, com a taxa da adquirente, na conta e na data do pagamento (o líquido entra na conta); se informada a linha do extrato do banco com a soma dos líquidos, já concilia. O bot propõe e a pessoa confirma.",
    query: [], body: ["linhas", "conta", "data", "linha_banco", "versao_linha_banco", "comando"], required: ["linhas", "conta"],
  },
  {
    name: "erp.conciliacao.cartao.taxa", method: "POST", path: `${R}/cartao/taxas`, sensitive: true, rpc: "erp_reconciliation_card_rate_save", bot: false,
    summary: "Cadastrar a taxa contratada do cartão",
    description: "Grava a taxa (percentual e valor fixo) e o prazo de pagamento por adquirente, bandeira, débito ou crédito e faixa de parcelas. Pela tela.",
    query: [], body: ["id", "versao", "adquirente", "bandeira", "modalidade", "parcelas_de", "parcelas_ate", "taxa", "tarifa_fixa", "prazo", "ativa", "comando"],
    required: ["adquirente", "bandeira", "modalidade", "taxa"],
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpReconciliationOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_RECONCILIATION_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const date = { type: "string", format: "date" };
const uuid = { type: "string", format: "uuid" };
const cents = (what: string) => ({ type: "string", pattern: "^[0-9]{1,15}$", description: `${what} em centavos.` });
/** Esquema de cada parâmetro (consulta, caminho e corpo). */
export const ERP_RECONCILIATION_PARAM_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  id: uuid, conta: uuid, de: date, ate: date, comando: uuid, data: date, linha_banco: uuid, versao: { type: "integer", minimum: 0 }, versao_linha_banco: { type: "integer", minimum: 0 },
  situacao: { type: "string", enum: ["pendentes", "conciliadas", "ignoradas", "todas"], description: "No cartão também: casadas, recebidas, abertas." },
  busca: { type: "string", maxLength: 100, description: "Parte da descrição, do valor ou do NSU." },
  acao: { type: "string", enum: ["confirmar", "baixar", "lancar_regra", "lancar", "ignorar", "voltar", "desfazer"],
    description: "Linha do extrato: confirmar (o casamento em vinculos), baixar (as contas em contas), lancar_regra (regra), lancar (categoria), ignorar (motivo), voltar ou desfazer (estornar)." },
  vinculos: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", required: ["tipo", "id"], properties: { tipo: { type: "string", enum: ["lancamento", "movimento"] }, id: uuid } },
    description: "Os lançamentos sugeridos (campo links da sugestão: kind entry = lancamento, movement = movimento)." },
  contas: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", required: ["id"], properties: { id: uuid, versao: { type: "integer" }, valor: cents("Valor baixado") } } },
  regra: uuid, categoria: uuid, contato: uuid, observacao: { type: "string", maxLength: 500 }, motivo: { type: "string", minLength: 3, maxLength: 500 },
  estornar: { type: "boolean", description: "Ao desfazer: estorna também a baixa, o lançamento ou a transferência criados pela conciliação." },
  tipo: { type: "string", description: "Cartão: venda, recebivel ou todos; importação: vendas ou recebiveis; modelo: banco ou cartao." },
  adquirente: { type: "string", maxLength: 30, description: "cielo, rede, stone, getnet, pagseguro, mercadopago, safrapay, sumup, infinitepay, ton ou outra." },
  divergentes: { type: "boolean", description: "Só as linhas com taxa acima da contratada ou pagas depois do prazo." },
  linhas: { type: "array", minItems: 1, maxItems: 200, items: uuid, description: "Linhas da adquirente (recebíveis casados com a conta do cartão)." },
  conteudo: { type: "string", description: "O texto do arquivo (OFX ou CSV)." },
});

/** Parâmetros (caminho, consulta e corpo) num objeto, para o inventário dos bots. */
export function erpReconciliationParams(operation: ErpReconciliationOperation) {
  const path = (operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1));
  const keys = [...path, ...operation.query, ...operation.body];
  return {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, ERP_RECONCILIATION_PARAM_SCHEMAS[key] ?? { type: "string" }])),
    required: [...new Set([...path, ...operation.required])],
  };
}

export const ERP_CONCILIACAO_MODULE_CONTRACT = {
  routes: [ERP_CONCILIACAO_ROUTE], operations: ["erp.conciliacao."],
  definition: { bot: { sensitive: ERP_RECONCILIATION_OPERATIONS.filter((op) => op.sensitive).map((op) => op.name),
    hints: Object.fromEntries(ERP_RECONCILIATION_OPERATIONS.map((op) => [op.name, op.summary])) } },
};
