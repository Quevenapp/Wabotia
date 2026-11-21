// Operações da compra pela nota recebida (/api/v1/profiles/:area/erp-recebidas).
// Nome estável e descrição em português: a rota, o inventário de concessões
// dos bots (src/modules/erp/bot-access.ts) e a tela leem daqui.
import { erpRequirement, type ErpModuleId } from "../parts.ts";

export const RECEBIDAS_ROUTE = "erp-recebidas";

export interface RecebidasOperation {
  name: string;
  method: "GET" | "POST" | "PUT";
  /** Relativo a erp-recebidas/, com :id. */
  path: string;
  summary: string;
  description: string;
  /** Grava ou fala com o cofre: o bot propõe e a pessoa confirma. */
  sensitive: boolean;
  /** Entra no inventário de concessões dos bots. */
  bot: boolean;
  body: string[];
  query: string[];
  /** Partes do ERP que a operação exige antes de chegar ao motor. */
  parts: readonly ErpModuleId[];
}

const C = erpRequirement("erp-compras").all;
const CF = erpRequirement("erp-compras", "erp-fiscal").all;

export const RECEBIDAS_OPERATIONS: readonly RecebidasOperation[] = [
  { name: "recebidas.listar", method: "GET", path: "notas", sensitive: false, bot: true, body: [], query: ["ambiente", "situacao", "pagina"], parts: C,
    summary: "Listar as notas recebidas dos fornecedores",
    description: "Lista as notas fiscais que chegaram para a empresa (buscadas no cofre ou importadas pelo XML): fornecedor, número, data, valor, situação da manifestação e se já deu entrada. Só consulta." },
  { name: "recebidas.conferir", method: "GET", path: "notas/:id", sensitive: false, bot: true, body: [], query: [], parts: C,
    summary: "Conferir uma nota recebida",
    description: "Mostra a conferência de uma nota recebida: fornecedor achado pelo CNPJ, cada item casado com um produto do cadastro, conversão de unidade, pedido de compra em aberto com as diferenças, custo de entrada e parcelas. Só consulta." },
  { name: "recebidas.previa", method: "POST", path: "notas/:id/previa", sensitive: false, bot: false, body: ["escolhas"], query: [], parts: C,
    summary: "Refazer a conferência com as escolhas da pessoa",
    description: "Recalcula a conferência com o produto, a unidade, o lote, o depósito, o pedido e as contas escolhidos na tela, sem gravar nada." },
  { name: "recebidas.buscar", method: "POST", path: "buscar", sensitive: true, bot: true, body: ["ambiente", "autorizacao_producao"], query: [], parts: CF,
    summary: "Buscar no cofre as notas emitidas contra o CNPJ",
    description: "Lê no emissor de notas as notas que outras empresas emitiram contra o CNPJ e guarda o índice e o XML completo na área. Uma busca a cada dois minutos; em produção, só o administrador e com a autorização marcada na própria busca." },
  { name: "recebidas.importar_xml", method: "POST", path: "importar", sensitive: true, bot: true, body: ["xml"], query: [], parts: C,
    summary: "Importar o XML de uma nota do fornecedor",
    description: "Guarda o XML que o fornecedor mandou (até 1 MB), confere que a nota é para o CNPJ da empresa e a coloca na lista para conferência, sem consultar o cofre." },
  { name: "recebidas.cadastrar_fornecedor", method: "POST", path: "notas/:id/fornecedor", sensitive: true, bot: true, body: ["command_id"], query: [], parts: C,
    summary: "Cadastrar o fornecedor da nota",
    description: "Cria o fornecedor no cadastro de contatos com o nome, CNPJ, inscrição estadual e endereço que vieram no XML da nota, quando ele ainda não existe." },
  { name: "recebidas.dar_entrada", method: "POST", path: "notas/:id/entrada", sensitive: true, bot: true, body: ["command_id", "escolhas"], query: [], parts: C,
    summary: "Dar entrada na nota recebida",
    description: "Confirma a conferência e dá entrada: estoque (por depósito, com lote e validade), custo de entrada com o rateio de frete, seguro, despesas e impostos, e contas a pagar pelas duplicatas. Cada parte só age ligada; dar entrada duas vezes não duplica nada." },
  { name: "recebidas.estornar", method: "POST", path: "notas/:id/estorno", sensitive: true, bot: true, body: ["command_id", "motivo"], query: [], parts: C,
    summary: "Estornar a entrada de uma nota recebida",
    description: "Desfaz a entrada da nota com um motivo: estorna o estoque e cancela as contas a pagar pelas regras do Estoque e do Financeiro (conta paga ou em cobrança no banco não é cancelada)." },
  { name: "recebidas.manifestar", method: "POST", path: "notas/:id/manifestar", sensitive: true, bot: true, body: ["command_id", "tipo", "justificativa", "autorizacao_producao", "reenviar"], query: [], parts: CF,
    summary: "Manifestar a nota recebida na SEFAZ",
    description: "Registra pelo cofre a ciência, a confirmação, o desconhecimento ou a operação não realizada (com justificativa). É ato fiscal perante a SEFAZ: só com o interruptor do administrador ligado, sempre proposto pelo bot e confirmado pela pessoa, e resultado incerto nunca é reenviado sem consulta." },
  { name: "recebidas.xml", method: "GET", path: "notas/:id/xml", sensitive: false, bot: false, body: [], query: [], parts: C,
    summary: "Baixar o XML da nota recebida",
    description: "Entrega o XML guardado da nota recebida para a pessoa baixar." },
  { name: "recebidas.configuracao", method: "GET", path: "configuracao", sensitive: false, bot: false, body: [], query: [], parts: C,
    summary: "Ver a configuração das notas recebidas",
    description: "Mostra se o administrador permitiu manifestar notas recebidas." },
  { name: "recebidas.configurar", method: "PUT", path: "configuracao", sensitive: true, bot: false, body: ["expected_version", "manifestar", "ciente_ato_fiscal"], query: [], parts: C,
    summary: "Permitir ou não manifestar notas recebidas",
    description: "Liga ou desliga a manifestação do destinatário. Só o administrador; ligar exige a ciência de que manifestar é ato fiscal perante a SEFAZ." },
];

export function recebidasOperationFor(method: string, path: string): { operation: RecebidasOperation; id?: string } | null {
  const verb = method.toUpperCase();
  for (const operation of RECEBIDAS_OPERATIONS) {
    if (operation.method !== verb) continue;
    const pattern = new RegExp(`^${operation.path.replace(":id", "([^/]+)")}$`);
    const m = pattern.exec(path);
    if (m) return { operation, id: m[1] };
  }
  return null;
}
