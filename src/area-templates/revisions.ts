// Revisões publicadas dos modelos de área.
//
// Por que fora de models/: os testes de cada ramo importam os arquivos de
// modelo diretamente e fixam suas versões, módulos e menus como registro da
// publicação anterior. A revisão é declarada aqui como patch sobre a base
// publicada e o catálogo expõe só o resultado, com a versão incrementada.
import type { AreaTemplate, AreaTemplateMenu } from "./validation";
import { assistenciaTecnicaTemplate } from "./models/assistencia-tecnica";
import { servicosTemplate } from "./models/servicos";
import { oficinaMecanicaTemplate } from "./models/oficina-mecanica";
import { lavanderiaCosturaTemplate } from "./models/lavanderia-costura";
import { graficaTemplate, despachanteTemplate, imobiliariaTemplate } from "./models/exemplos";
import { engenheirosTemplate } from "./models/engenheiros";
import { arquitetosTemplate } from "./models/arquitetos";
import { construtorasTemplate } from "./models/construtoras";
import { advogadosTemplate } from "./models/advogados";
import { escritorioAdvocaciaTemplate } from "./models/escritorio-advocacia";
import { clinicaMedicaTemplate } from "./models/clinica-medica";
import { clinicaVeterinariaTemplate } from "./models/clinica-veterinaria";
import { escolasTemplate } from "./models/escolas";
import { professoresTemplate } from "./models/professores";
import { condominiosTemplate } from "./models/condominios";
import { restauranteTemplate } from "./models/restaurante";
import { festasEventosTemplate } from "./models/festas-eventos";

export type TemplateRevision = {
  /** Módulos ligados pela revisão; os requisitos transitivos vêm declarados. */
  enable_modules?: string[];
  /** Menus retirados, por id local. */
  remove_menus?: string[];
  /** Substitui, na mesma posição, o menu de id local pela lista informada. */
  replace_menus?: Record<string, AreaTemplateMenu[]>;
  /** Menus acrescentados ao fim. */
  add_menus?: AreaTemplateMenu[];
  texts?: Partial<AreaTemplate["texts"]>;
  /** Troca (ou retira, com null) o passo manual que começa pelo texto informado. */
  replace_manual_steps?: { starts_with: string; with: string | null }[];
  add_manual_steps?: string[];
};

/** Aplica o patch sem alterar a base; a nova versão é sempre base + 1. */
export function reviseTemplate(base: AreaTemplate, patch: TemplateRevision): AreaTemplate {
  const next = structuredClone(base) as AreaTemplate;
  const fail = (what: string) => { throw new Error(`Revisão de ${base.id}: ${what}`); };
  next.version = base.version + 1;
  next.modules = { ...next.modules };
  for (const id of patch.enable_modules ?? []) next.modules[id] = true;
  const ids = new Set(next.menus.map((menu) => menu.id));
  for (const id of [...(patch.remove_menus ?? []), ...Object.keys(patch.replace_menus ?? {})])
    if (!ids.has(id)) fail(`menu ${id} inexistente`);
  next.menus = next.menus
    .filter((menu) => !patch.remove_menus?.includes(menu.id))
    .flatMap((menu) => patch.replace_menus && Object.hasOwn(patch.replace_menus, menu.id)
      ? structuredClone(patch.replace_menus[menu.id]) : [menu]);
  next.menus.push(...structuredClone(patch.add_menus ?? []));
  if (patch.texts) next.texts = { ...next.texts, ...patch.texts };
  let steps = [...next.manual_steps];
  for (const { starts_with, with: replacement } of patch.replace_manual_steps ?? []) {
    const index = steps.findIndex((step) => step.startsWith(starts_with));
    if (index < 0) fail(`passo manual "${starts_with}" inexistente`);
    steps = replacement === null ? steps.filter((_, i) => i !== index) : steps.map((step, i) => i === index ? replacement : step);
  }
  next.manual_steps = [...steps, ...(patch.add_manual_steps ?? [])];
  return next;
}

const agenda = (id: string, label: string): AreaTemplateMenu => ({ id, label, type: "agenda" });
const agendaMine = (id: string, label: string): AreaTemplateMenu => ({ id, label, type: "agenda_mine" });
const mensalidadeList = (id: string, label: string): AreaTemplateMenu => ({ id, label, type: "mensalidade_list" });
const mensalidadeCopy = (id: string, label: string): AreaTemplateMenu => ({ id, label, type: "mensalidade_copy" });
const SERVICE_ERP = ["erp", "erp-financeiro"];
const erpStep = (subject: string) =>
  `Revisar na prévia Cadastros e Financeiro. A ponte operacional ${subject} para o financeiro ainda não está entregue: registrar honorários, recebimentos e despesas manualmente no Financeiro, evitando duplicidade. Ligar os módulos não concede papéis.`;

// Advocacia: os menus de agenda e mensalidade passam a abrir os módulos reais.
const advocacia: TemplateRevision = {
  enable_modules: ["agenda", "mensalidade"],
  replace_menus: {
    advocacia_agendar: [agenda("advocacia_agendar", "Agendar conversa")],
    advocacia_agendamentos: [agendaMine("advocacia_agendamentos", "Meus agendamentos")],
    advocacia_mensalidades: [
      mensalidadeList("advocacia_mensalidades", "Minhas mensalidades"),
      mensalidadeCopy("advocacia_segunda_via", "Segunda via da mensalidade"),
    ],
  },
  replace_manual_steps: [
    { starts_with: "Revisar na prévia Cadastros, Financeiro, Fiscal, Ordens de serviço e Jurídico.", with: "Revisar na prévia Cadastros, Financeiro, Fiscal, Ordens de serviço, Jurídico, Agenda e Mensalidades. Jurídico exige os; os processos permanecem como tipos de trabalho. O modelo não concede papéis nem segundo fator de autenticação." },
    { starts_with: "Agenda, Mensalidades, Formulários, Pagamentos, Reservas", with: "Formulários, Pagamentos, Reservas e outras partes ERP são independentes. Configurar os passos dessas extensões somente se forem ativadas. Selecionar uma opção false propõe desligá-la; ativá-la exige Módulos ou manifesto revisado. Escolhas não selecionadas e alterações locais nas reaplicações são preservadas." },
    { starts_with: "Substituir os encaminhamentos de primeiro atendimento, agenda e mensalidades", with: "Configurar Agenda e Mensalidades antes de publicar os menus Agendar conversa, Meus agendamentos, Minhas mensalidades e Segunda via da mensalidade, que abrem as telas desses módulos. O primeiro atendimento continua encaminhado à recepção até configurar Formulários." },
  ],
};

export const templateRevisions: Readonly<Record<string, TemplateRevision>> = {
  servicos: {
    enable_modules: SERVICE_ERP,
    replace_menus: {
      horarios: [
        agenda("agendar", "Agendar horário"),
        agendaMine("meus_horarios", "Meus agendamentos"),
        mensalidadeList("parcelas", "Minhas parcelas"),
        mensalidadeCopy("segunda_via", "Segunda via"),
      ],
    },
    replace_manual_steps: [
      { starts_with: "Adicionar no editor comum os menus da Agenda", with: "Configurar Agenda e Mensalidades antes de publicar os menus Agendar horário, Meus agendamentos, Minhas parcelas e Segunda via. O menu de preparação continua no editor comum." },
    ],
    add_manual_steps: [erpStep("dos serviços em os")],
  },
  oficina_mecanica: {
    enable_modules: ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"],
    add_manual_steps: [
      "Revisar na prévia Cadastros, Produtos e serviços, Vendas, Estoque e Financeiro. A ponte operacional dos serviços em os para estoque e financeiro ainda não está entregue: registrar venda e baixa de peças e recebimentos manualmente no ERP, evitando duplicidade. Fiscal, PDV e Cobrança bancária ficam fora desta proposta.",
    ],
  },
  lavanderia_costura: { enable_modules: SERVICE_ERP, add_manual_steps: [erpStep("dos serviços em os")] },
  grafica: { enable_modules: SERVICE_ERP, add_manual_steps: [erpStep("das produções em os")] },
  despachante: {
    enable_modules: SERVICE_ERP,
    replace_menus: {
      agendar: [agenda("agendar", "Agendar atendimento"), agendaMine("meus_agendamentos", "Meus agendamentos")],
    },
    replace_manual_steps: [
      { starts_with: "Cadastrar atendimento documental de 30 min na Agenda", with: "Cadastrar atendimento documental de 30 min na Agenda com lembrete de 24 h antes de publicar os menus Agendar atendimento e Meus agendamentos, que abrem a Agenda." },
    ],
    add_manual_steps: [erpStep("das solicitações em os")],
  },
  imobiliaria: {
    enable_modules: SERVICE_ERP,
    replace_menus: {
      agendar: [agenda("agendar", "Agendar visita"), agendaMine("meus_agendamentos", "Meus agendamentos")],
    },
    replace_manual_steps: [
      { starts_with: "Cadastrar corretores e horários", with: "Cadastrar corretores e horários, conversa inicial de 30 min e visita de 60 min na Agenda, com lembrete de 24 h, antes de publicar os menus Agendar visita e Meus agendamentos, que abrem a Agenda." },
    ],
    add_manual_steps: [erpStep("dos atendimentos em os")],
  },
  engenharia: {
    enable_modules: ["agenda"],
    replace_menus: {
      engenharia_agendar: [agenda("engenharia_agendar", "Agendar atendimento")],
      engenharia_agendamentos: [agendaMine("engenharia_agendamentos", "Meus agendamentos")],
    },
    replace_manual_steps: [
      { starts_with: "Agenda, Formulários, Pagamentos, Mensalidades, Reservas", with: "Formulários, Pagamentos, Mensalidades, Reservas e outras partes ERP são independentes. Configurar os passos dessas extensões somente se forem ativadas. Selecionar uma opção false propõe desligá-la; ativá-la exige Módulos ou manifesto revisado. Escolhas não selecionadas e alterações locais nas reaplicações são preservadas." },
      { starts_with: "Após configurar Agenda e Formulários", with: "Configurar a Agenda antes de publicar os menus Agendar atendimento e Meus agendamentos, que abrem a Agenda. Após configurar Formulários, acrescentar o menu nativo de formulário; até lá, Informações do projeto encaminha à equipe." },
    ],
  },
  arquitetura: {
    enable_modules: SERVICE_ERP,
    replace_menus: {
      arquitetura_agendar: [agenda("arquitetura_agendar", "Agendar atendimento")],
      arquitetura_agendamentos: [agendaMine("arquitetura_agendamentos", "Meus agendamentos")],
    },
    replace_manual_steps: [
      { starts_with: "Após configurar Agenda e Formulários", with: "Configurar a Agenda antes de publicar os menus Agendar atendimento e Meus agendamentos, que abrem a Agenda. Após configurar Formulários, acrescentar o menu nativo de formulário; até lá, Necessidades do projeto encaminha à equipe." },
    ],
    add_manual_steps: [erpStep("dos projetos em os")],
  },
  construtora: {
    enable_modules: ["erp-financeiro"],
    replace_menus: {
      construtora_agendar: [agenda("construtora_agendar", "Agendar visita")],
      construtora_agendamentos: [agendaMine("construtora_agendamentos", "Meus agendamentos")],
    },
    replace_manual_steps: [
      { starts_with: "Após configurar Agenda e Formulários", with: "Configurar a Agenda antes de publicar os menus Agendar visita e Meus agendamentos, que abrem a Agenda. Após configurar Formulários, acrescentar o menu nativo de formulário; até lá, Informações para visita encaminha à equipe." },
    ],
    add_manual_steps: [erpStep("das obras e chamados em os")],
  },
  advogados: advocacia,
  escritorio_advocacia: advocacia,
  clinica_medica: {
    enable_modules: ["saude", ...SERVICE_ERP],
    replace_menus: {
      agendar: [agenda("agendar", "Agendar")],
      horarios: [agendaMine("horarios", "Meus horários")],
    },
    replace_manual_steps: [
      { starts_with: "Revisar todos os textos da Agenda", with: "Revisar todos os textos da Agenda, inclusive os montados pelo sistema, para não expor serviço clínico, especialidade, motivo ou dados pessoais. Os menus Agendar e Meus horários abrem a Agenda; publicá-los somente depois dessa revisão." },
    ],
    add_manual_steps: [
      "Revisar o módulo Saúde, que exige Ordens de serviço, e conceder seus acessos somente à equipe clínica autorizada. A ativação não importa prontuários nem libera uso clínico antes da validação técnica e normativa.",
      erpStep("dos atendimentos em os"),
    ],
  },
  clinica_veterinaria: {
    enable_modules: ["saude", ...SERVICE_ERP],
    replace_menus: {
      agendar: [agenda("agendar", "Agendar")],
      horarios: [agendaMine("horarios", "Meus horários")],
    },
    replace_manual_steps: [
      { starts_with: "Revisar todos os textos da Agenda", with: "Revisar todos os textos da Agenda, inclusive os montados pelo sistema, para não expor serviço clínico, especialidade, motivo ou dados pessoais. Os menus Agendar e Meus horários abrem a Agenda; publicá-los somente depois dessa revisão." },
    ],
    add_manual_steps: [
      "Revisar o módulo Saúde, que exige Ordens de serviço, e conceder seus acessos somente à equipe veterinária autorizada. A ativação não importa prontuários nem libera uso clínico antes de validar as exigências do CFMV.",
      erpStep("dos atendimentos em os"),
    ],
  },
  escolas: {
    enable_modules: ["ensino", ...SERVICE_ERP],
    replace_menus: {
      agendar_visita: [agenda("agendar_visita", "Agendar visita"), agendaMine("meus_agendamentos", "Meus agendamentos")],
      mensalidades: [mensalidadeList("mensalidades", "Mensalidades"), mensalidadeCopy("segunda_via", "Segunda via")],
    },
    replace_manual_steps: [
      { starts_with: "Liberar operação com menores somente após", with: "O módulo Ensino é ligado por este modelo, mas a ativação não importa alunos, vínculos de responsáveis, turmas, frequência, notas ou boletins. Liberar operação com menores somente após configurar e validar os controles do Ensino." },
      { starts_with: "Após configurar Agenda e Mensalidade", with: "Configurar Agenda e Mensalidade antes de publicar os menus Agendar visita, Meus agendamentos, Mensalidades e Segunda via, que abrem esses módulos. O boletim do Ensino fica fora do menu do modelo; acrescentá-lo no editor após validar turmas e responsáveis." },
    ],
    add_manual_steps: [erpStep("das matrículas e solicitações em os")],
  },
  professores: {
    enable_modules: ["ensino"],
    remove_menus: ["conversa_inicial"],
    replace_menus: {
      aulas_horarios: [agenda("aulas_horarios", "Agendar aula ou conversa"), agendaMine("meus_horarios", "Meus horários")],
      mensalidades: [mensalidadeList("mensalidades", "Mensalidades"), mensalidadeCopy("segunda_via", "Segunda via")],
    },
    texts: {
      menu_greeting: "Olá! Escolha Quero começar, Agendar aula ou conversa, Mensalidades ou Falar com o professor. Para consultar saldo ou pedir reposição, use Pacote e reposições.",
    },
    replace_manual_steps: [
      { starts_with: "Atender menores somente após", with: "O módulo Ensino é ligado por este modelo, mas a ativação não importa alunos, turmas, frequência, notas ou boletins. Atender menores somente após configurar e validar os controles de identidade, vínculo e sigilo do Ensino." },
      { starts_with: "Acrescentar menus de Agenda e Mensalidade", with: "Configurar Agenda e Mensalidade antes de publicar os menus Agendar aula ou conversa, Meus horários, Mensalidades e Segunda via, que abrem esses módulos. Agendamento e pagamento não criam nem consomem créditos do pacote." },
    ],
  },
  condominios: {
    enable_modules: ["condominio", ...SERVICE_ERP],
    replace_menus: {
      menu_visitas: [
        { id: "menu_visitas", label: "Minhas visitas", type: "os_track", type_id: "visitante" },
        { id: "menu_unidade", label: "Minha unidade", type: "cond_unit" },
      ],
      menu_taxas: [mensalidadeList("menu_taxas", "Minhas taxas"), mensalidadeCopy("menu_segunda_via", "Segunda via da taxa")],
      menu_espacos: [
        { id: "menu_espacos", label: "Reservar espaço", type: "reserva" },
        { id: "menu_reservas", label: "Minhas reservas", type: "reserva_mine" },
      ],
    },
    replace_manual_steps: [
      { starts_with: "Após revisar configurações e permissões, acrescente manualmente menus", with: "Configure Reserva, Mensalidade e Condomínio antes de publicar os menus Reservar espaço, Minhas reservas, Minhas taxas, Segunda via da taxa e Minha unidade, que abrem esses módulos. Menus de Formulários continuam no editor comum." },
      { starts_with: "Publique regimento e convenção vigentes", with: "Publique regimento e convenção vigentes por canal apropriado. Revise procedimentos de visitas, retiradas, obras, mudanças e urgências; aviso de privacidade, finalidades de contato e guarda. Configure unidades, moradores, comunicados e assembleias no módulo Condomínio antes de divulgá-los; a ativação não importa cadastros nem abre votações." },
    ],
    add_manual_steps: [erpStep("das taxas e solicitações")],
  },
  festas_eventos: { enable_modules: SERVICE_ERP, add_manual_steps: [erpStep("dos serviços em os")] },
};

const revise = (base: AreaTemplate) => {
  const patch = templateRevisions[base.id];
  return patch ? reviseTemplate(base, patch) : base;
};

// Mesma ordem do catálogo anterior. Assistência técnica e Restaurante já ligam
// o necessário e seguem sem revisão (mesmo objeto publicado).
export const revisedAreaTemplates: readonly AreaTemplate[] = [
  assistenciaTecnicaTemplate,
  servicosTemplate,
  oficinaMecanicaTemplate,
  lavanderiaCosturaTemplate,
  graficaTemplate,
  despachanteTemplate,
  imobiliariaTemplate,
  // A parte 2 publicou Engenharia 3 (objeto Imóvel); o manifesto já traz a versão.
  engenheirosTemplate,
  arquitetosTemplate,
  construtorasTemplate,
  // Publicados como versão 2 antes desta revisão.
  { ...advogadosTemplate, version: 2 },
  { ...escritorioAdvocaciaTemplate, version: 2 },
  clinicaMedicaTemplate,
  clinicaVeterinariaTemplate,
  escolasTemplate,
  professoresTemplate,
  condominiosTemplate,
  restauranteTemplate,
  festasEventosTemplate,
].map(revise);
