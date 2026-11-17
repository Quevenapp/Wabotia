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
  // Início e Meu Negócio: o resumo (/v1/inicio) e os painéis de vendas.
  { path: "/acesso" },
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
  // Cobrança bancária e remessas.
  { path: "/cobranca-empresa" },
  { path: "/cobranca-operacional" },
  { path: "/retornos-operacionais" },
  // Financeiro: remessas e retornos, comissões, faturamento agrupado e o relatório de vencimentos.
  {
    path: "/financeiro-empresa",
    query: [
      "area",
      ["remessas", "retornos", "comissoes", "faturamento-agrupado"],
    ],
  },
  { path: "/relatorio-vencimentos" },
  // Estoque: conferência.
  { path: "/conferencia-estoque-empresa" },
  // Sistema: registro de atividades e consulta de exclusões (mesmo RPC).
  { path: "/preferencias/sistema/registro-atividades" },
  { path: "/preferencias/sistema/consulta-exclusoes" },
  // Empresa › Geral: o motor responde 502 ERP_UPSTREAM_INVALID_RESPONSE (padrão de 2 casas na versão 0).
  { path: "/preferencias/empresa/geral" },
];

/** Telas que já funcionam contra o motor, para a tela de "em implantação". */
export const MOTOR_READY: readonly { label: string; to: string }[] = [
  { label: "Produtos", to: "/cadastros-reais?cadastro=products" },
  { label: "Contas a receber", to: "/financeiro-empresa?area=receivable" },
  { label: "Contas a pagar", to: "/financeiro-empresa?area=payable" },
  { label: "Caixas e bancos", to: "/financeiro-empresa?area=accounts" },
  { label: "Lançamentos de estoque", to: "/estoque-empresa" },
  { label: "Preferências", to: "/preferencias" },
];

let real = false;
/** mount.tsx: true contra o motor; false na demonstração e com a API simulada. */
export function setMotorReal(next: boolean) {
  real = next;
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
