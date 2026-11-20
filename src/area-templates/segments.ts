// "Qual é o seu negócio?": os ramos em cartões agrupados, cada um apontando
// para um modelo de área do catálogo. Dados puros, compartilhados pelo painel
// (configuração guiada e Gestão → Sistema → Modelos de área) e pelo servidor,
// que confere o ramo informado ao registrar a escolha.

export const SEGMENT_GROUPS = [
  { id: "servicos_tecnicos", label: "Serviços técnicos" },
  { id: "saude", label: "Saúde e bem-estar" },
  { id: "juridico", label: "Jurídico e consultoria" },
  { id: "alimentacao", label: "Alimentação" },
  { id: "comercio", label: "Comércio" },
  { id: "educacao", label: "Educação" },
  { id: "imoveis", label: "Imóveis e condomínios" },
  { id: "eventos", label: "Eventos" },
  { id: "outro", label: "Outro" },
] as const;
export type SegmentGroupId = typeof SEGMENT_GROUPS[number]["id"];

export interface Segment {
  id: string;
  group: SegmentGroupId;
  /** Como o dono se apresenta: "Oficina mecânica". */
  label: string;
  /** Uma linha do que o ramo faz no dia a dia. */
  hint: string;
  /** Modelo de área aplicado; null em "Outro" (monta pelos módulos). */
  template_id: string | null;
  /** Palavras que a busca reconhece, além do nome e da dica. */
  keywords: string[];
}

export const SEGMENTS: readonly Segment[] = [
  { id: "oficina", group: "servicos_tecnicos", label: "Oficina mecânica", hint: "Conserto e revisão de carros e motos.", template_id: "oficina_mecanica", keywords: ["mecanico", "carro", "moto", "veiculo", "auto", "funilaria", "auto center"] },
  { id: "assistencia", group: "servicos_tecnicos", label: "Assistência técnica", hint: "Conserto de celulares, eletrônicos e eletrodomésticos.", template_id: "assistencia_tecnica", keywords: ["celular", "conserto", "eletronico", "eletrodomestico", "informatica", "computador", "notebook", "reparo"] },
  { id: "lavanderia", group: "servicos_tecnicos", label: "Lavanderia e costura", hint: "Lavagem, ajustes e consertos de roupas.", template_id: "lavanderia_costura", keywords: ["lavanderia", "costureira", "ajuste", "roupa", "tinturaria"] },
  { id: "grafica", group: "servicos_tecnicos", label: "Gráfica", hint: "Impressos, comunicação visual e personalizados.", template_id: "grafica", keywords: ["impressao", "grafica", "banner", "adesivo", "personalizado", "comunicacao visual"] },
  { id: "servicos", group: "servicos_tecnicos", label: "Prestador de serviços", hint: "Serviços em geral, com ordem de serviço e acompanhamento.", template_id: "servicos", keywords: ["servico", "manutencao", "instalacao", "eletricista", "encanador", "limpeza", "dedetizacao", "jardinagem"] },
  { id: "engenharia", group: "servicos_tecnicos", label: "Engenharia", hint: "Projetos, laudos e acompanhamento de obras.", template_id: "engenharia", keywords: ["engenheiro", "laudo", "art", "projeto", "vistoria"] },
  { id: "arquitetura", group: "servicos_tecnicos", label: "Arquitetura", hint: "Projetos de arquitetura e interiores.", template_id: "arquitetura", keywords: ["arquiteto", "interiores", "decoracao", "projeto"] },
  { id: "construtora", group: "servicos_tecnicos", label: "Construtora e reformas", hint: "Obras, reformas e pós-obra.", template_id: "construtora", keywords: ["obra", "reforma", "construcao", "empreiteira", "pedreiro"] },
  { id: "despachante", group: "servicos_tecnicos", label: "Despachante", hint: "Documentos de veículos e processos em órgãos públicos.", template_id: "despachante", keywords: ["documento", "detran", "licenciamento", "transferencia", "cnh"] },
  { id: "locacao", group: "servicos_tecnicos", label: "Locação de equipamentos ou veículos", hint: "Aluguel com reserva, contrato e cobrança mensal.", template_id: "locacao", keywords: ["aluguel", "locadora", "equipamento", "andaime", "carro", "veiculo", "maquina", "locacao"] },
  { id: "clinica", group: "saude", label: "Clínica ou consultório", hint: "Consultas, retornos e prontuário.", template_id: "clinica_medica", keywords: ["medico", "medica", "dentista", "odontologia", "psicologo", "fisioterapia", "nutricionista", "consultorio", "saude", "estetica"] },
  { id: "veterinaria", group: "saude", label: "Clínica veterinária", hint: "Consultas, vacinas e internação de animais.", template_id: "clinica_veterinaria", keywords: ["veterinario", "pet", "animal", "cachorro", "gato", "petshop", "banho e tosa"] },
  { id: "advogado", group: "juridico", label: "Advogado (atuo sozinho)", hint: "Consultas, processos e honorários.", template_id: "advogados", keywords: ["advogado", "advogada", "advocacia", "juridico", "processo", "direito", "oab"] },
  { id: "escritorio_advocacia", group: "juridico", label: "Escritório de advocacia", hint: "Equipe com vários advogados e áreas.", template_id: "escritorio_advocacia", keywords: ["escritorio", "advogados", "advocacia", "juridico", "direito", "socios"] },
  { id: "consultoria", group: "juridico", label: "Consultoria", hint: "Reuniões, projetos e contrato mensal.", template_id: "consultoria", keywords: ["consultor", "consultoria", "assessoria", "contabilidade", "contador", "marketing", "mentoria", "coach"] },
  { id: "restaurante", group: "alimentacao", label: "Restaurante, lanchonete ou delivery", hint: "Cardápio, pedidos e entregas.", template_id: "restaurante", keywords: ["restaurante", "lanchonete", "pizzaria", "hamburgueria", "delivery", "bar", "cafe", "padaria", "marmita", "comida"] },
  { id: "comercio", group: "comercio", label: "Loja ou comércio", hint: "Venda de produtos, estoque, caixa e pedidos.", template_id: "comercio", keywords: ["loja", "comercio", "varejo", "mercado", "venda", "produto", "roupa", "boutique", "atacado", "distribuidora", "farmacia", "materiais"] },
  { id: "escola", group: "educacao", label: "Escola ou curso", hint: "Matrículas, turmas, boletim e mensalidades.", template_id: "escolas", keywords: ["escola", "colegio", "curso", "creche", "ensino", "matricula", "idiomas"] },
  { id: "professor", group: "educacao", label: "Professor particular", hint: "Aulas avulsas ou em pacotes.", template_id: "professores", keywords: ["professor", "professora", "aula", "reforco", "tutor", "musica", "idioma"] },
  { id: "condominio", group: "imoveis", label: "Condomínio ou administradora", hint: "Moradores, portaria, ocorrências e taxa condominial.", template_id: "condominios", keywords: ["condominio", "sindico", "administradora", "portaria", "morador", "predio"] },
  { id: "imobiliaria", group: "imoveis", label: "Imobiliária", hint: "Venda e aluguel de imóveis, visitas e contratos.", template_id: "imobiliaria", keywords: ["imovel", "imobiliaria", "corretor", "aluguel", "venda de imovel"] },
  { id: "eventos", group: "eventos", label: "Festas e eventos", hint: "Orçamentos, contratos e o dia do evento.", template_id: "festas_eventos", keywords: ["festa", "evento", "buffet", "casamento", "aniversario", "decoracao", "salao"] },
  { id: "outro", group: "outro", label: "Outro tipo de negócio", hint: "Comece do zero e ligue só os módulos que usar.", template_id: null, keywords: ["outro", "nenhum", "nao sei"] },
];

export const segmentById = (id: unknown) => SEGMENTS.find((segment) => segment.id === id) ?? null;
export const segmentOfTemplate = (templateId: unknown) => SEGMENTS.find((segment) => segment.template_id === templateId) ?? null;

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
/** Busca por palavra: "advogado", "mecânico", "pet". Vazio devolve todos. */
export function searchSegments(query: string, list: readonly Segment[] = SEGMENTS): Segment[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((segment) => {
    const group = SEGMENT_GROUPS.find((entry) => entry.id === segment.group)?.label ?? "";
    const haystack = fold([segment.label, segment.hint, group, ...segment.keywords].join(" "));
    return words.every((word) => haystack.includes(word));
  });
}
