import {
  Activity,
  Banknote,
  BedDouble,
  Blocks,
  BookOpen,
  CalendarRange,
  ClipboardList,
  CreditCard,
  Bot,
  CalendarClock,
  CalendarDays,
  Cloud,
  Code2,
  FileText,
  Headphones,
  LayoutDashboard,
  LayoutTemplate,
  Link2,
  Menu,
  MessageCircle,
  Package,
  Phone,
  PiggyBank,
  LifeBuoy,
  Plug,
  Receipt,
  ReceiptText,
  Send,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Star,
  Store,
  Ticket,
  Users,
  UtensilsCrossed,
  Wrench,
  Zap,
} from "lucide-react";

// Each screen has one home. The assistant opens these same screens rather than
// maintaining a second set of connection or service configuration forms.
export const sections = [
  ["overview", "Início", LayoutDashboard],
  ["setup", "Configuração guiada", Zap],
  ["conversations", "Conversas", MessageCircle],
  ["calls", "Ligações", Phone],
  ["groups", "Grupos WhatsApp", Users],
  ["tickets", "Protocolos", FileText],
  ["queue", "Fila de senhas", Ticket],
  ["contacts", "Contatos", BookOpen],
  ["users", "Pessoas e acessos", Users],
  ["presence", "Disponibilidade", Headphones],
  ["team", "Conversa interna", MessageCircle],
  ["bots", "Atendente e especialistas", Bot],
  ["menus", "Menus e ações", Menu],
  ["templates", "Modelos de atendimento", LayoutTemplate],
  ["knowledge", "Conhecimento", BookOpen],
  ["settings", "Regras de atendimento", Settings],
  ["queue-settings", "Filas e guichês", Ticket],
  ["forms", "Formulários", ClipboardList],
  ["payments", "Cobrança", CreditCard],
  ["reserva", "Reservas", BedDouble],
  ["reserva-settings", "Unidades e regras", CalendarRange],
  ["router", "Integração Zernio", Phone],
  ["lines", "Quem atende cada linha", Headphones],
  ["connections", "Hermes e canais", Plug],
  ["surveys", "Avaliações", Star],
  ["reports", "Relatórios", Activity],
  ["consents", "Consentimentos", ShieldCheck],
  ["applications", "Sistemas conectados", Link2],
  ["bot-runs", "Execuções de bots", Bot],
  ["deliveries", "Entregas de mensagens", Send],
  ["webhook-deliveries", "Eventos para sistemas", Zap],
  ["system", "Sistema e atualizações", Cloud],
  ["modules", "Módulos", Blocks],
  ["mensalidades", "Mensalidades", PiggyBank],
  ["mensalidade-settings", "Planos e regras", PiggyBank],
  ["suporte", "Suporte pago", LifeBuoy],
  ["suporte-settings", "Regras do suporte", LifeBuoy],
  ["agenda", "Agenda", CalendarDays],
  ["agenda-settings", "Serviços e horários", CalendarClock],
  ["service-orders", "Ordens de serviço", Wrench],
  ["service-orders-settings", "Ordem de serviço", Wrench],
  ["establishment", "Estabelecimento", Store],
  ["pedidos", "Pedidos", ShoppingBag],
  ["pedidos-cardapio", "Cardápio e loja", UtensilsCrossed],
  ["caixa", "Caixa", Banknote],
  ["vendas", "Vendas e orçamentos", Receipt],
  ["vendas-produtos", "Produtos e estoque", Package],
  ["vendas-config", "Regras e nota fiscal", ReceiptText],
] as const;

export type PageId = (typeof sections)[number][0];

/**
 * Áreas de atendimento do trilho (web/DESIGN.md §2). Cada página antiga do
 * painel continua tendo um lugar: as de atendimento viraram áreas próprias e
 * as demais ficam em Gestão.
 */
export type AreaId =
  | "conversations"
  | "tickets"
  | "team"
  | "calls"
  | "queue"
  | "contacts"
  | "admin";

/** Onde mora hoje cada página conhecida pelo assistente e pelos atalhos. */
export const pageArea: Partial<Record<PageId, AreaId>> = {
  conversations: "conversations",
  tickets: "tickets",
  calls: "calls",
  queue: "queue",
  contacts: "contacts",
  // "Disponibilidade" e "Conversa interna" foram absorvidas por Equipe.
  presence: "team",
  team: "team",
};

export const areaOfPage = (page: PageId): AreaId => pageArea[page] || "admin";

/** Grupos da coluna de Gestão. */
export const workspaceGroups = [
  { id: "home", label: "Início", icon: LayoutDashboard, pages: ["overview"] },
  {
    id: "mensalidades",
    label: "Mensalidades",
    icon: PiggyBank,
    pages: ["mensalidades", "mensalidade-settings"],
  },
  {
    id: "suporte",
    label: "Suporte pago",
    icon: LifeBuoy,
    pages: ["suporte", "suporte-settings"],
  },
  {
    id: "agenda",
    label: "Agenda",
    icon: CalendarDays,
    pages: ["agenda", "agenda-settings"],
  },
  {
    id: "service-orders",
    label: "Ordens de serviço",
    icon: Wrench,
    pages: ["service-orders", "service-orders-settings"],
  },
  {
    id: "pedidos",
    label: "Pedidos",
    icon: ShoppingBag,
    pages: ["pedidos", "pedidos-cardapio"],
  },
  {
    id: "vendas",
    label: "Vendas e caixa",
    icon: ShoppingCart,
    pages: ["caixa", "vendas", "vendas-produtos", "vendas-config"],
  },
  {
    id: "automation",
    label: "Automação",
    icon: Bot,
    pages: [
      "bots",
      "menus",
      "templates",
      "knowledge",
      "settings",
      "queue-settings",
      "forms",
      "payments",
    ],
  },
  {
    id: "reserva",
    label: "Reservas",
    icon: BedDouble,
    pages: ["reserva", "reserva-settings"],
  },
  {
    id: "channels",
    label: "WhatsApp e canais",
    icon: Phone,
    pages: ["router", "lines", "connections", "groups"],
  },
  {
    id: "results",
    label: "Avaliações e relatórios",
    icon: Star,
    pages: ["surveys", "reports", "consents"],
  },
  {
    id: "integrations",
    label: "Integrações",
    icon: Code2,
    pages: ["applications", "bot-runs", "deliveries", "webhook-deliveries"],
  },
  {
    id: "system",
    label: "Sistema",
    icon: Cloud,
    pages: ["establishment", "modules", "system"],
  },
  { id: "people", label: "Pessoas e acessos", icon: Users, pages: ["users"] },
  { id: "setup", label: "Configuração guiada", icon: Zap, pages: ["setup"] },
] as const;

const adminPages: ReadonlySet<string> = new Set([
  "setup",
  "settings",
  "queue-settings",
  "forms",
  "menus",
  "templates",
  "lines",
  "connections",
  "router",
  "users",
  "applications",
  "webhook-deliveries",
  "system",
  "modules",
  "agenda-settings",
  "service-orders-settings",
  "payments",
  "mensalidade-settings",
  "establishment",
  "suporte-settings",
  "reserva-settings",
  "pedidos-cardapio",
  "vendas-config",
]);

/**
 * Páginas de Gestão e áreas do trilho que pertencem a um módulo embutido
 * (src/modules, campo navigation). Com o módulo desligado na área, somem.
 */
export const pageModules: Partial<Record<string, string>> = {
  queue: "queue",
  "queue-settings": "queue",
  forms: "forms",
  agenda: "agenda",
  "agenda-settings": "agenda",
  "service-orders": "os",
  "service-orders-settings": "os",
  payments: "payments",
  mensalidades: "mensalidade",
  "mensalidade-settings": "mensalidade",
  suporte: "suporte",
  "suporte-settings": "suporte",
  reserva: "reserva",
  "reserva-settings": "reserva",
  pedidos: "pedido",
  "pedidos-cardapio": "pedido",
  vendas: "vendas",
  "vendas-produtos": "vendas",
  "vendas-config": "vendas",
  caixa: "caixa",
};
/**
 * Páginas de módulo que também aparecem no trilho principal (computador) e
 * em Mais (celular), além de Gestão. Um módulo acrescenta UMA linha; a página
 * precisa estar em `sections` e em `pageModules`. Abre a página de Gestão.
 */
export const railPages: {
  page: PageId;
  label: string;
  icon: typeof Ticket;
}[] = [
  { page: "agenda", label: "Agenda", icon: CalendarDays },
  { page: "service-orders", label: "Ordens", icon: Wrench },
  { page: "pedidos", label: "Pedidos", icon: ShoppingBag },
  { page: "caixa", label: "Caixa", icon: Banknote },
];

/** Estado dos módulos da área, de GET /status (ausente: ainda carregando). */
export type ModuleStates = Record<string, boolean> | undefined;
export const moduleAllows = (page: string, modules?: ModuleStates) => {
  const owner = pageModules[page];
  return !owner || modules?.[owner] !== false;
};

export function canOpenPage(
  page: string,
  role: string,
  modules?: ModuleStates,
) {
  return (
    sections.some(([id]) => id === page) &&
    (role === "admin" || !adminPages.has(page)) &&
    moduleAllows(page, modules)
  );
}

export function visibleGroups(role: string, modules?: ModuleStates) {
  return workspaceGroups
    .map((group) => ({
      ...group,
      pages: group.pages.filter((page) =>
        canOpenPage(page, role, modules),
      ) as PageId[],
    }))
    .filter((group) => group.pages.length);
}

export const pageDescriptions: Partial<Record<PageId, string>> = {
  overview: "Acompanhe o atendimento e escolha o que precisa fazer agora.",
  setup:
    "Configure um passo de cada vez. Você pode sair e retomar a qualquer momento.",
  conversations:
    "Receba mensagens, assuma conversas e encaminhe para pessoas ou bots.",
  tickets: "Acompanhe solicitações, responsáveis e prazos de resposta.",
  calls:
    "Consulte o histórico de ligações. Áudio pelo navegador indisponível na Zernio.",
  groups: "Sincronize, crie e administre os grupos das linhas conectadas.",
  contacts: "Encontre clientes, organize cadastros e importe sua agenda.",
  users: "Acesso individual, responsabilidade clara.",
  bots: "Escolha quem conversa com o cliente e quais especialistas ajudam internamente.",
  menus:
    "Organize os caminhos do cliente para conteúdo, aplicativos, pessoas e bots.",
  templates:
    "Comece por um modelo pronto: menus, setores, categorias e prazos de uma vez.",
  knowledge: "Informações confiáveis para fundamentar as respostas.",
  settings: "Defina orientações, prazos, avaliações e a participação do JEV.",
  queue: "Chame senhas no guichê, transfira entre filas e acompanhe a espera.",
  "queue-settings":
    "Crie filas e guichês, ligue a fila no WhatsApp, painéis de TV, totens Senhapp e a lista negra.",
  router:
    "Configure a Integração Zernio, encontre seus telefones e configure a distribuição de mensagens.",
  lines: "Escolha o bot ou a equipe responsável por cada telefone conectado.",
  connections:
    "Conecte o Hermes ou um provedor de IA e confira o funcionamento dos canais.",
  applications:
    "Pareie o Senhapp e gerencie o acesso de outros sistemas ao Wabotia.",
  presence: "Informe quando você está disponível para assumir atendimentos.",
  team: "Converse com pessoas e bots da equipe sem enviar mensagens ao cliente.",
  surveys:
    "Acompanhe as notas e os comentários dos clientes após o atendimento.",
  reports: "Consulte e exporte os registros da operação.",
  consents: "Consulte os consentimentos pedidos e concedidos.",
  "bot-runs": "Acompanhe as execuções pedidas aos bots e confira resultados.",
  deliveries: "Confira o envio de cada mensagem ao canal.",
  "webhook-deliveries": "Acompanhe os eventos enviados aos seus sistemas.",
  system: "Verifique versões, instale atualizações e mantenha sua instalação.",
  modules:
    "Ligue e desligue as funções desta área, como a fila presencial e os formulários.",
  forms:
    "Formulários respondidos pelo cliente num link enviado no WhatsApp.",
  agenda:
    "Agenda do dia e da semana por profissional: marque, remarque, confirme e registre faltas.",
  "agenda-settings":
    "Serviços, profissionais, horários de trabalho, folgas e as regras do agendamento pelo WhatsApp.",
  "service-orders":
    "Ordens numeradas com orçamento, aprovação pelo WhatsApp, execução e retirada.",
  "service-orders-settings":
    "Termos, mensagens ao cliente, validade do orçamento, garantia e itens do menu.",
  payments:
    "Pix e link de pagamento pelo Mercado Pago, confirmados pelo webhook.",
  mensalidades:
    "Assinaturas, parcelas do mês, inadimplentes, baixa manual e reenvio da cobrança.",
  "mensalidade-settings":
    "Planos, regras de cobrança e avisos de vencimento e atraso, e itens do menu.",
  suporte:
    "Quem foi liberado para o atendimento humano, como e até quando, e as compras de suporte avulso.",
  "suporte-settings":
    "Setor de destino, identificação, pacotes avulsos, planos oferecidos, formas de pagamento e textos.",
  establishment:
    "Nome fantasia, CPF ou CNPJ, endereço e telefone para cupons, comandas, recibos e páginas do cliente.",
  reserva:
    "Ocupação por unidade, reservas com sinal e check-in: crie, altere, confirme e cancele.",
  "reserva-settings":
    "Quartos, chalés, quadras e salões; bloqueios de datas e as regras de reserva, sinal e check-in.",
  pedidos:
    "Quadro da cozinha com os pedidos em andamento: mude o estado, registre o pagamento e imprima a comanda.",
  "pedidos-cardapio":
    "Cardápio com fotos e adicionais, imagens do WhatsApp, horário, entrega, pagamento e mensagens ao cliente.",
  caixa:
    "Frente de caixa por toque e leitor de código de barras: abertura, venda, troco, sangria, devolução e fechamento.",
  vendas:
    "Vendas com comprovante, devolução e prévia da nota fiscal; orçamentos enviados e aprovados pelo WhatsApp.",
  "vendas-produtos":
    "Produtos com foto, preço, código de barras, estoque e dados fiscais; entradas, saídas e ajustes de inventário.",
  "vendas-config":
    "Validade do orçamento, formas de pagamento, limites da equipe, comprovante e o emitente da nota fiscal.",
};
