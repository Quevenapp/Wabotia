import {
  Activity,
  BookOpen,
  Bot,
  Cloud,
  Code2,
  FileText,
  Headphones,
  LayoutDashboard,
  LayoutTemplate,
  Link2,
  Menu,
  MessageCircle,
  Phone,
  Plug,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Users,
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
  ["contacts", "Contatos", BookOpen],
  ["users", "Pessoas e acessos", Users],
  ["presence", "Disponibilidade", Headphones],
  ["team", "Conversa interna", MessageCircle],
  ["bots", "Atendente e especialistas", Bot],
  ["menus", "Menus e ações", Menu],
  ["templates", "Modelos de atendimento", LayoutTemplate],
  ["knowledge", "Conhecimento", BookOpen],
  ["settings", "Regras de atendimento", Settings],
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
  | "contacts"
  | "admin";

/** Onde mora hoje cada página conhecida pelo assistente e pelos atalhos. */
export const pageArea: Partial<Record<PageId, AreaId>> = {
  conversations: "conversations",
  tickets: "tickets",
  calls: "calls",
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
    id: "automation",
    label: "Automação",
    icon: Bot,
    pages: ["bots", "menus", "templates", "knowledge", "settings"],
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
  { id: "system", label: "Sistema", icon: Cloud, pages: ["system"] },
  { id: "people", label: "Pessoas e acessos", icon: Users, pages: ["users"] },
  { id: "setup", label: "Configuração guiada", icon: Zap, pages: ["setup"] },
] as const;

const adminPages: ReadonlySet<string> = new Set([
  "setup",
  "settings",
  "menus",
  "templates",
  "lines",
  "connections",
  "router",
  "users",
  "applications",
  "webhook-deliveries",
  "system",
]);

export function canOpenPage(page: string, role: string) {
  return (
    sections.some(([id]) => id === page) &&
    (role === "admin" || !adminPages.has(page))
  );
}

export function visibleGroups(role: string) {
  return workspaceGroups
    .map((group) => ({
      ...group,
      pages: group.pages.filter((page) =>
        canOpenPage(page, role),
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
  router:
    "Configure a Integração Zernio, encontre seus telefones e configure a distribuição de mensagens.",
  lines: "Escolha o bot ou a equipe responsável por cada telefone conectado.",
  connections:
    "Conecte o Hermes ou um provedor de IA e confira o funcionamento dos canais.",
  applications: "Gerencie o acesso de sistemas como Vinki e Fagoo ao Wabotia.",
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
};
