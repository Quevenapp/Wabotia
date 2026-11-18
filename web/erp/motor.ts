// Telas que a rota real do ERP ainda não atende (motor em porte por domínio,
// docs/ERP-PORTE.md). A lista vem do que a rota responde de fato: a sonda
// tests/erp-painel-rotas.test.ts lê, como administrador, a primeira leitura de
// cada tela e confere esta lista. Uma tela daqui some do menu e, aberta pelo
// endereço, mostra "em implantação" com os atalhos do que já funciona, nunca o
// erro cru (502 ERP_UPSTREAM_UNAVAILABLE, RPC ainda não portado).
//
// Só vale contra o motor: a demonstração e o desenvolvimento com a API
// simulada (web/erp/demo) mostram todas as telas.

type Pending = { path: string; under?: boolean; query?: [string, string[]] };

/** Telas sem motor ainda, por domínio. */
export const MOTOR_PENDING: readonly Pending[] = [
  // Meu Negócio: os painéis de vendas (o Início, /v1/inicio, já responde).
  { path: "/meu-negocio" },
  // Fiscal: notas, eventos, rascunhos, numeração e o certificado (as
  // naturezas de operação, as preferências de NF-e e NFC-e e o histórico
  // fiscal, pela leitura das notas do F2a, já respondem).
  { path: "/notas-entrada" },
  { path: "/notas-recebidas" },
  { path: "/inutilizacoes-nfe" },
  { path: "/cartas-correcao" },
  { path: "/numeracao-fiscal" },
  { path: "/emissor-fiscal" },
  { path: "/preferencias/certificado", under: true },
  { path: "/preferencias/importacoes/notas-fiscais" },
  // Cobrança operacional e retornos operacionais (a cobrança bancária, as
  // remessas e os retornos do financeiro já respondem).
  { path: "/cobranca-operacional" },
  { path: "/retornos-operacionais" },
  // Sistema: registro de atividades e consulta de exclusões (mesmo RPC).
  { path: "/preferencias/sistema/registro-atividades" },
  { path: "/preferencias/sistema/consulta-exclusoes" },
];

/** Telas que já funcionam contra o motor, para a tela de "em implantação". */
export const MOTOR_READY: readonly { label: string; to: string }[] = [
  { label: "Início", to: "/acesso" },
  { label: "Produtos", to: "/cadastros-reais?cadastro=products" },
  { label: "Clientes e fornecedores", to: "/cadastros-reais?cadastro=contacts" },
  { label: "Importar contatos", to: "/importar-contatos" },
  { label: "Depósitos", to: "/cadastros-reais?cadastro=warehouses" },
  { label: "Categorias de produtos", to: "/categorias-produtos" },
  { label: "Vendedores", to: "/vendedores-empresa" },
  { label: "Campos customizados", to: "/campos-customizados" },
  { label: "Naturezas de operação", to: "/naturezas-operacao" },
  { label: "Frente de caixa", to: "/frente-caixa-empresa" },
  { label: "Contas a receber", to: "/financeiro-empresa?area=receivable" },
  { label: "Contas a pagar", to: "/financeiro-empresa?area=payable" },
  { label: "Caixas e bancos", to: "/financeiro-empresa?area=accounts" },
  { label: "Pedidos de venda", to: "/documentos-empresa?tipo=sales_orders" },
  { label: "Propostas comerciais", to: "/documentos-empresa?tipo=sales_proposals" },
  { label: "Ordens de serviço", to: "/documentos-empresa?tipo=service_orders" },
  { label: "Pedidos de compra", to: "/documentos-empresa?tipo=purchase_orders" },
  { label: "Lançamentos de estoque", to: "/estoque-empresa" },
  { label: "Conferência de estoque", to: "/conferencia-estoque-empresa" },
  { label: "Preferências", to: "/preferencias" },
];

/**
 * Leituras auxiliares sem motor ainda, em telas que já funcionam (a sonda
 * confere cada uma). Contra o motor, o controlador responde por elas sem ir à
 * rede (501 ERP_NOT_PORTED), e a tela segue com a ausência como já trata hoje.
 * Vazia desde o tronco 0c7343a (as taxonomias de Produtos responderam).
 */
export const MOTOR_PENDING_READS: readonly RegExp[] = [];

let real = false;
/** mount.tsx: true contra o motor; false na demonstração e com a API simulada. */
export function setMotorReal(next: boolean) {
  real = next;
}

/** A leitura (caminho da API do ERP, como /v1/…) ainda não tem motor? */
export const readPendingInMotor = (path: string) =>
  real && MOTOR_PENDING_READS.some((pattern) => pattern.test(path));

/**
 * Ação de uma tela que já funciona, mas cujo RPC o motor ainda não tem (0A000:
 * registrar ocorrência no pedido, copiar, lixeira). A erp-api do
 * Fagoo devolve 502 ERP_UPSTREAM_UNAVAILABLE e a tela mostraria só "não foi
 * possível, tente de novo". O controlador (web/erp/app/lib/real-access.ts)
 * avisa aqui a cada escrita recusada assim, e a casca (web/erp/mount.tsx) diz
 * com clareza que a ação está em implantação.
 */
let onActionPending: (() => void) | null = null;
export function setActionPendingNotice(next: (() => void) | null) {
  onActionPending = next;
}
export function writeRefused(status: number, code?: string) {
  if (real && status === 502 && code === "ERP_UPSTREAM_UNAVAILABLE")
    onActionPending?.();
}

/** A tela (caminho sem /app/erp, com ou sem consulta) ainda não tem motor? */
export function pendingInMotor(target: string): boolean {
  if (!real) return false;
  const [path, search = ""] = target.split("?");
  return MOTOR_PENDING.some((item) => {
    const match = item.under
      ? path === item.path || path.startsWith(item.path + "/")
      : path === item.path;
    if (!match) return false;
    if (!item.query) return true;
    const [key, values] = item.query;
    return values.includes(new URLSearchParams(search).get(key) ?? "");
  });
}
