// Exemplos que um modelo de área monta além da configuração: horário e
// serviços da Agenda e um plano da Mensalidade. Dados puros, compartilhados
// com o painel (prévia em linguagem de dono). Tudo vem marcado como exemplo,
// só é criado quando o módulo faz parte do modelo e a área ainda não tem
// cadastros daquele tipo, e sai no "Desfazer este modelo" se ninguém mexeu.

export const EXAMPLE_MARK = "(exemplo)";
export const EXAMPLE_NOTE = "Exemplo criado pelo modelo de área. Pode editar ou apagar.";

export interface AgendaServiceExample { name: string; duration_minutes: number; price_cents: number | null }
export interface TemplateExamples {
  agenda?: {
    professional: string;
    /** Segunda a sexta (1 a 5) e, se houver, sábado (6); minutos desde a meia-noite. */
    hours: Array<{ weekday: number; start_minute: number; end_minute: number }>;
    services: AgendaServiceExample[];
  };
  mensalidade?: { name: string; amount_cents: number; due_day: number };
}

const WEEK = (start: number, end: number, saturday?: [number, number]) => [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: start * 60, end_minute: end * 60 })),
  ...(saturday ? [{ weekday: 6, start_minute: saturday[0] * 60, end_minute: saturday[1] * 60 }] : []),
];

const SERVICES: Record<string, AgendaServiceExample[]> = {
  clinica_medica: [{ name: "Consulta", duration_minutes: 30, price_cents: null }, { name: "Retorno", duration_minutes: 20, price_cents: null }],
  clinica_veterinaria: [{ name: "Consulta veterinária", duration_minutes: 30, price_cents: null }, { name: "Vacinação", duration_minutes: 15, price_cents: null }],
  advogados: [{ name: "Primeira consulta", duration_minutes: 60, price_cents: null }],
  escritorio_advocacia: [{ name: "Primeira consulta", duration_minutes: 60, price_cents: null }],
  professores: [{ name: "Aula particular", duration_minutes: 60, price_cents: null }, { name: "Aula experimental", duration_minutes: 30, price_cents: 0 }],
  escolas: [{ name: "Visita à escola", duration_minutes: 45, price_cents: 0 }],
  consultoria: [{ name: "Reunião de diagnóstico", duration_minutes: 60, price_cents: null }, { name: "Reunião de acompanhamento", duration_minutes: 45, price_cents: null }],
  oficina_mecanica: [{ name: "Revisão", duration_minutes: 120, price_cents: null }, { name: "Avaliação", duration_minutes: 30, price_cents: 0 }],
  assistencia_tecnica: [{ name: "Avaliação do aparelho", duration_minutes: 30, price_cents: 0 }],
  festas_eventos: [{ name: "Reunião de planejamento", duration_minutes: 60, price_cents: 0 }],
};
const PLANS: Record<string, { name: string; amount_cents: number }> = {
  escolas: { name: "Mensalidade escolar", amount_cents: 80000 },
  professores: { name: "Pacote mensal de aulas", amount_cents: 40000 },
  condominios: { name: "Taxa condominial", amount_cents: 50000 },
  advogados: { name: "Assessoria mensal", amount_cents: 150000 },
  escritorio_advocacia: { name: "Assessoria mensal", amount_cents: 200000 },
  consultoria: { name: "Consultoria mensal", amount_cents: 300000 },
  locacao: { name: "Locação mensal", amount_cents: 100000 },
};

/** Exemplos do modelo, conforme os módulos que ele liga. */
export function templateExamples(template: { id: string; modules: Partial<Record<string, boolean>> }): TemplateExamples {
  const result: TemplateExamples = {};
  if (template.modules.agenda === true)
    result.agenda = {
      professional: `Profissional ${EXAMPLE_MARK}`,
      hours: WEEK(8, 18, [8, 12]),
      services: (SERVICES[template.id] ?? [{ name: "Atendimento", duration_minutes: 60, price_cents: null }, { name: "Retorno", duration_minutes: 30, price_cents: null }])
        .slice(0, 2).map((service) => ({ ...service, name: `${service.name} ${EXAMPLE_MARK}` })),
    };
  if (template.modules.mensalidade === true) {
    const plan = PLANS[template.id] ?? { name: "Plano mensal", amount_cents: 10000 };
    result.mensalidade = { name: `${plan.name} ${EXAMPLE_MARK}`, amount_cents: plan.amount_cents, due_day: 10 };
  }
  return result;
}

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
/** Frases da prévia: "o horário de funcionamento (seg. a sex. 8h–18h, sáb. 8h–12h) e 2 serviços de exemplo na Agenda". */
export function examplePhrases(examples: TemplateExamples): string[] {
  const phrases: string[] = [];
  if (examples.agenda) {
    const n = examples.agenda.services.length;
    phrases.push(`o horário de funcionamento (seg. a sex. 8h às 18h, sáb. 8h às 12h) e ${n} ${n === 1 ? "serviço" : "serviços"} de exemplo na Agenda`);
  }
  if (examples.mensalidade) phrases.push(`um plano de exemplo na Mensalidade (${examples.mensalidade.name.replace(` ${EXAMPLE_MARK}`, "")}, ${money(examples.mensalidade.amount_cents)} por mês)`);
  return phrases;
}
