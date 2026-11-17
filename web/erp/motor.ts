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
  // Cadastros: contatos, depósitos, vendedores, campos customizados e taxonomias.
  { path: "/cadastros-reais", query: ["cadastro", ["contacts", "warehouses"]] },
  { path: "/vendedores-empresa" },
  { path: "/campos-customizados" },
  { path: "/categorias-produtos" },
  { path: "/grupos-produtos" },
  { path: "/tags" },
  { path: "/grupos-tags" },
  { path: "/importar-contatos" },
  { path: "/numeracao-contatos" },
  // Documentos: pedidos, propostas, OS, compras, checkout e relatórios.
  { path: "/documentos-empresa" },
  // Fiscal: notas, eventos, naturezas, rascunhos, numeração e o certificado
  // (as preferências de NF-e e NFC-e já respondem).
  { path: "/historico-fiscal" },
  { path: "/notas-entrada" },
  { path: "/notas-recebidas" },
  { path: "/naturezas-operacao" },
  { path: "/inutilizacoes-nfe" },
  { path: "/cartas-correcao" },
  { path: "/numeracao-fiscal" },
  { path: "/emissor-fiscal" },
  { path: "/preferencias/certificado", under: true },
  { path: "/preferencias/importacoes/notas-fiscais" },
  // Frente de caixa.
  { path: "/frente-caixa-empresa" },
  // Cobrança operacional e retornos operacionais (a cobrança bancária, as
  // remessas e os retornos do financeiro já respondem).
  { path: "/cobranca-operacional" },
  { path: "/retornos-operacionais" },
  // Estoque: conferência.
  { path: "/conferencia-estoque-empresa" },
  // Sistema: registro de atividades e consulta de exclusões (mesmo RPC).
  { path: "/preferencias/sistema/registro-atividades" },
  { path: "/preferencias/sistema/consulta-exclusoes" },
];

/** Telas que já funcionam contra o motor, para a tela de "em implantação". */
export const MOTOR_READY: readonly { label: string; to: string }[] = [
  { label: "Início", to: "/acesso" },
  { label: "Produtos", to: "/cadastros-reais?cadastro=products" },
  { label: "Contas a receber", to: "/financeiro-empresa?area=receivable" },
  { label: "Contas a pagar", to: "/financeiro-empresa?area=payable" },
  { label: "Caixas e bancos", to: "/financeiro-empresa?area=accounts" },
  { label: "Lançamentos de estoque", to: "/estoque-empresa" },
  { label: "Preferências", to: "/preferencias" },
];

/**
 * Leituras auxiliares sem motor ainda, em telas que já funcionam (a sonda
 * confere cada uma). Contra o motor, o controlador responde por elas sem ir à
 * rede (501 ERP_NOT_PORTED), e a tela segue com a ausência como já trata hoje:
 * os filtros de Produtos ficam sem as opções de categoria e tags. (A sacola de
 * vendas já responde, mas fica escondida enquanto os documentos estiverem em
 * implantação: o uso dela é gerar o pedido.)
 */
export const MOTOR_PENDING_READS: readonly RegExp[] = [
  /^\/v1\/cadastros\/taxonomias\/(categorias-produtos|grupos-produtos|tags|grupos-tags)(\?|$)/,
];

let real = false;
/** mount.tsx: true contra o motor; false na demonstração e com a API simulada. */
export function setMotorReal(next: boolean) {
  real = next;
}

/** A leitura (caminho da API do ERP, como /v1/…) ainda não tem motor? */
export const readPendingInMotor = (path: string) =>
  real && MOTOR_PENDING_READS.some((pattern) => pattern.test(path));

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
