// Exemplos que um modelo de área monta além da configuração: horário,
// serviços e o profissional "Atendimento" da Agenda, planos da Mensalidade
// (desativados até a pessoa revisar), o financeiro básico e o catálogo de
// Produtos e serviços no ERP. Dados puros, compartilhados com o painel (prévia
// em linguagem de dono). Tudo vem marcado como exemplo, só é criado quando o
// módulo faz parte do modelo e a área ainda não tem cadastros daquele tipo, e
// sai no "Desfazer este modelo" se ninguém mexeu.

export const EXAMPLE_MARK = "(exemplo)";
export const EXAMPLE_NOTE = "Exemplo criado pelo modelo de área. Pode editar ou apagar.";

export interface AgendaServiceExample { name: string; duration_minutes: number; price_cents: number | null }
export type MensalidadePeriod = "monthly" | "quarterly" | "yearly";
export interface MensalidadePlanExample { name: string; amount_cents: number; period: MensalidadePeriod; due_day: number }
/** Item de Produtos e serviços do ERP: P produto, S serviço; preço em reais com ponto ("32.9"). */
export interface CatalogItemExample { name: string; kind: "P" | "S"; unit: string; price: string }
export interface TemplateExamples {
  agenda?: {
    /** Profissional "Atendimento", ligado ao administrador que aplica o modelo. */
    professional: string;
    /** Segunda a sexta (1 a 5) e, se houver, sábado (6); minutos desde a meia-noite. */
    hours: Array<{ weekday: number; start_minute: number; end_minute: number }>;
    services: AgendaServiceExample[];
  };
  /** O primeiro plano fica também no topo (nome e valor) para a prévia; `plans` traz todos. */
  mensalidade?: MensalidadePlanExample & { plans: MensalidadePlanExample[] };
  /** Financeiro básico no ERP (Financeiro, Vendas ou Caixa / PDV ligados): montado por erp-examples.ts. */
  financeiro?: FinanceExamples;
  /** Catálogo de exemplo no ERP (Produtos e serviços ligado): montado por erp-examples.ts. */
  catalogo?: { items: CatalogItemExample[] };
}
export interface FinanceExamples {
  /** Tipos da forma de pagamento (códigos da NF-e): 01 dinheiro, 17 Pix, 04 débito, 03 crédito, 15 boleto. */
  payment_methods: Array<{ description: string; payment_type: "01" | "03" | "04" | "15" | "17" }>;
  /** Só com o Financeiro ligado (categorias e contas são dele). */
  categories: Array<{ name: string; kind: "receivable" | "payable"; dre_group: string | null }>;
  account: { name: string } | null;
}
/** O que fica registrado para o ERP montar: financeiro e catálogo, cada parte só se o modelo trouxer. */
export interface ErpExamples extends Partial<FinanceExamples> { products?: CatalogItemExample[] }
const FINANCE_PARTS = ["erp-financeiro", "erp-vendas", "erp-pdv"];

const WEEK = (start: number, end: number, saturday?: [number, number]) => [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: start * 60, end_minute: end * 60 })),
  ...(saturday ? [{ weekday: 6, start_minute: saturday[0] * 60, end_minute: saturday[1] * 60 }] : []),
];

const s = (name: string, duration_minutes: number, reais: number): AgendaServiceExample => ({ name, duration_minutes, price_cents: Math.round(reais * 100) });
const ADVOCACIA = [s("Primeira consulta", 60, 300), s("Reunião de acompanhamento", 45, 200), s("Atendimento por vídeo", 30, 150)];
/** Serviços típicos do ramo, com duração e preço de exemplo (0 = sem custo para o cliente). */
const SERVICES: Record<string, AgendaServiceExample[]> = {
  servicos: [s("Visita técnica", 60, 150), s("Orçamento no local", 30, 0), s("Manutenção", 120, 250)],
  despachante: [s("Atendimento documental", 30, 80), s("Transferência de veículo", 45, 250), s("Licenciamento", 30, 120)],
  imobiliaria: [s("Conversa inicial", 30, 0), s("Visita ao imóvel", 60, 0), s("Avaliação de imóvel", 60, 300)],
  engenharia: [s("Reunião de projeto", 60, 200), s("Vistoria técnica", 90, 450), s("Visita à obra", 60, 300)],
  arquitetura: [s("Reunião de briefing", 60, 0), s("Apresentação do projeto", 90, 0), s("Visita técnica", 60, 250)],
  construtora: [s("Visita à obra", 60, 0), s("Reunião de orçamento", 60, 0), s("Vistoria de pós-obra", 60, 0)],
  advogados: ADVOCACIA,
  escritorio_advocacia: ADVOCACIA,
  clinica_medica: [s("Consulta", 30, 250), s("Retorno", 20, 0), s("Exame de rotina", 30, 150)],
  clinica_veterinaria: [s("Consulta veterinária", 30, 180), s("Vacinação", 15, 90), s("Banho e tosa", 90, 100)],
  escolas: [s("Visita à escola", 45, 0), s("Reunião com a coordenação", 30, 0)],
  professores: [s("Aula particular", 60, 100), s("Aula experimental", 30, 0), s("Reposição de aula", 60, 0)],
  consultoria: [s("Reunião de diagnóstico", 60, 500), s("Reunião de acompanhamento", 45, 300), s("Mentoria", 60, 400)],
  oficina_mecanica: [s("Revisão", 120, 350), s("Avaliação", 30, 0)],
  assistencia_tecnica: [s("Avaliação do aparelho", 30, 0), s("Reparo agendado", 60, 150)],
  festas_eventos: [s("Reunião de planejamento", 60, 0), s("Degustação", 60, 0)],
};
const DEFAULT_SERVICES = [s("Atendimento", 60, 100), s("Retorno", 30, 0)];

const p = (name: string, reais: number, period: MensalidadePeriod = "monthly"): MensalidadePlanExample => ({ name, amount_cents: Math.round(reais * 100), period, due_day: 10 });
/** Planos típicos do ramo: o primeiro é o principal. */
const PLANS: Record<string, MensalidadePlanExample[]> = {
  servicos: [p("Contrato de manutenção mensal", 250), p("Contrato de manutenção trimestral", 675, "quarterly")],
  escolas: [p("Mensalidade escolar", 800), p("Matrícula", 500, "yearly")],
  professores: [p("Pacote mensal de aulas", 400), p("Pacote trimestral de aulas", 1080, "quarterly")],
  condominios: [p("Taxa condominial", 500), p("Fundo de reserva", 50)],
  advogados: [p("Assessoria mensal", 1500), p("Assessoria anual", 16200, "yearly")],
  escritorio_advocacia: [p("Assessoria mensal", 2000), p("Assessoria anual", 21600, "yearly")],
  consultoria: [p("Consultoria mensal", 3000), p("Consultoria trimestral", 8100, "quarterly")],
  locacao: [p("Locação mensal", 1000), p("Locação trimestral", 2700, "quarterly")],
};
// Ramo sem planos próprios (academia, escolinha, clube): mensal e trimestral.
const DEFAULT_PLANS = [p("Plano mensal", 100), p("Plano trimestral", 270, "quarterly")];

const c = (kind: "P" | "S", name: string, price: string, unit = "UN"): CatalogItemExample => ({ kind, name, price, unit });
/** Itens típicos do ramo em Produtos e serviços (5 a 10, serviços e produtos). */
const CATALOG: Record<string, CatalogItemExample[]> = {
  assistencia_tecnica: [
    c("S", "Diagnóstico técnico", "50"), c("S", "Troca de tela", "250"), c("S", "Limpeza interna", "80"),
    c("P", "Bateria de celular", "120"), c("P", "Cabo USB", "25"), c("P", "Película de vidro", "30"),
  ],
  oficina_mecanica: [
    c("S", "Troca de óleo", "80"), c("S", "Alinhamento e balanceamento", "120"), c("S", "Revisão completa", "350"),
    c("P", "Óleo de motor 1 litro", "45", "L"), c("P", "Filtro de óleo", "35"), c("P", "Jogo de pastilhas de freio", "150", "JG"),
  ],
  restaurante: [
    c("P", "Prato executivo", "32"), c("P", "Refeição por quilo", "69.9", "KG"), c("P", "Refrigerante lata", "6"),
    c("P", "Suco natural", "9"), c("P", "Sobremesa do dia", "12"), c("S", "Taxa de entrega", "7"),
  ],
  comercio: [
    c("P", "Camiseta", "49.9"), c("P", "Calça jeans", "129.9"), c("P", "Boné", "39.9"),
    c("P", "Sacola reutilizável", "5"), c("S", "Embrulho para presente", "5"), c("S", "Entrega", "10"),
  ],
};
const DEFAULT_CATALOG = [
  c("S", "Serviço avulso", "100"), c("S", "Visita técnica", "150"), c("S", "Hora técnica", "120", "H"),
  c("P", "Produto avulso", "50"), c("P", "Kit de materiais", "80"),
];
const mark = <T extends { name: string }>(item: T): T => ({ ...item, name: `${item.name} ${EXAMPLE_MARK}` });

/** Exemplos do modelo, conforme os módulos que ele liga. */
export function templateExamples(template: { id: string; modules: Partial<Record<string, boolean>> }): TemplateExamples {
  const result: TemplateExamples = {};
  if (template.modules.agenda === true)
    result.agenda = {
      professional: "Atendimento",
      hours: WEEK(8, 18, [8, 12]),
      services: (SERVICES[template.id] ?? DEFAULT_SERVICES).map(mark),
    };
  if (template.modules.mensalidade === true) {
    const plans = (PLANS[template.id] ?? DEFAULT_PLANS).map(mark);
    result.mensalidade = { ...plans[0], plans };
  }
  if (FINANCE_PARTS.some((id) => template.modules[id] === true)) {
    // Vendas sem o Financeiro: só as formas de pagamento (as categorias e a conta são do Financeiro).
    const finance = template.modules["erp-financeiro"] === true || template.modules["erp-pdv"] === true;
    result.financeiro = {
      payment_methods: [
        { description: "Dinheiro", payment_type: "01" }, { description: "Pix", payment_type: "17" },
        { description: "Cartão de débito", payment_type: "04" }, { description: "Cartão de crédito", payment_type: "03" },
        { description: "Boleto", payment_type: "15" },
      ],
      categories: finance ? [
        { name: `Receita de vendas ${EXAMPLE_MARK}`, kind: "receivable", dre_group: "gross_revenue" },
        { name: `Receita de serviços ${EXAMPLE_MARK}`, kind: "receivable", dre_group: "gross_revenue" },
        { name: `Compras ${EXAMPLE_MARK}`, kind: "payable", dre_group: "operating_expenses" },
        { name: `Despesas fixas ${EXAMPLE_MARK}`, kind: "payable", dre_group: "operating_expenses" },
        { name: `Impostos ${EXAMPLE_MARK}`, kind: "payable", dre_group: "revenue_deductions" },
      ] : [],
      account: finance ? { name: "Caixa" } : null,
    };
  }
  if (template.modules["erp-produtos"] === true) result.catalogo = { items: (CATALOG[template.id] ?? DEFAULT_CATALOG).map(mark) };
  return result;
}

export const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const PERIOD_WORDS: Readonly<Record<MensalidadePeriod, string>> = { monthly: "por mês", quarterly: "por trimestre", yearly: "por ano" };
/** Frases da prévia: "o horário de funcionamento (seg. a sex. 8h às 18h, sáb. 8h às 12h) e 3 serviços de exemplo na Agenda". */
export function examplePhrases(examples: TemplateExamples): string[] {
  const phrases: string[] = [];
  if (examples.agenda) {
    const n = examples.agenda.services.length;
    phrases.push(`o horário de funcionamento (seg. a sex. 8h às 18h, sáb. 8h às 12h), o profissional "${examples.agenda.professional}" e ${n} ${n === 1 ? "serviço" : "serviços"} de exemplo na Agenda`);
  }
  if (examples.mensalidade) {
    const plans = examples.mensalidade.plans.map((plan) => `${plan.name.replace(` ${EXAMPLE_MARK}`, "")}, ${money(plan.amount_cents)} ${PERIOD_WORDS[plan.period]}`);
    phrases.push(`${plans.length === 1 ? "um plano" : `${plans.length} planos`} de exemplo na Mensalidade, desativados até você revisar (${plans.join("; ")})`);
  }
  if (examples.financeiro) phrases.push(examples.financeiro.account
    ? "as formas de pagamento básicas (dinheiro, Pix, cartões e boleto), categorias financeiras de exemplo e a conta Caixa no ERP, se ainda não houver"
    : "as formas de pagamento básicas (dinheiro, Pix, cartões e boleto) no ERP, se ainda não houver");
  if (examples.catalogo) phrases.push(`${examples.catalogo.items.length} produtos e serviços de exemplo no ERP, se o catálogo ainda estiver vazio`);
  return phrases;
}
