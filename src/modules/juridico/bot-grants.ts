// Jurídico para bots: categoria sensível, tudo desligado por padrão. O
// administrador liga operação por operação, para cada bot, com o aviso
// abaixo (src/bot-actions/area.ts). Memória de cálculo e identificação do
// processo são campos sensíveis: só saem com "incluir campos sensíveis".
import type { AreaBotModule } from "../../bot-actions/area-types";

const read = (path: string, title: string, description: string, fields?: string[]) =>
  ({ id: `consulta:${path}`, method: "GET" as const, path, title, description, ...(fields ? { fields } : {}) });

export const JURIDICO_BOT_GRANTS: AreaBotModule = {
  module: "juridico",
  title: "Jurídico",
  warning:
    "São processos e documentos de clientes do escritório: prazos, partes, cálculos e identificação dos processos. Ao ligar, o bot pode ler ou propor estas operações e os dados vão ao provedor de IA. A pessoa que conversa com o bot continua precisando do papel de advogado ou curador e do acesso sensível.",
  direct_warning:
    "O bot vai executar esta operação nos prazos sem o advogado confirmar antes. Prazo errado pode fazer o cliente perder o processo. Libere só se você confia no bot para isso.",
  sensitive_warning:
    "A memória de cálculo dos prazos, a identificação dos processos e os documentos dos clientes vão ao provedor de IA.",
  sensitive_label: "memória de cálculo, identificação do processo e documentos",
  sensitive_keys: ["memory", "process_label", "calendar_changes", "document", "documents"],
  operations: [
    read("juridico/deadlines", "Listar prazos", "Lista os prazos da área, com vencimento, responsável e conferência.", ["status", "cursor", "limit"]),
    read("juridico/deadlines/:id", "Ver um prazo", "Mostra o prazo com a memória de cálculo (campo sensível) e as mudanças do calendário."),
    read("juridico/alerts", "Listar alertas de prazo", "Lista os alertas de prazo vencendo."),
    read("juridico/calendars", "Listar calendários forenses", "Lista os calendários forenses (feriados e suspensões) da área."),
    read("juridico/assignees", "Listar advogados", "Lista quem pode ser responsável por prazos."),
    { id: "juridico.preview", method: "POST", path: "juridico/preview", title: "Simular um prazo",
      description: "Calcula o vencimento de um prazo sem gravar, com a memória de cálculo.", fields: ["calendar_id", "rule"] },
    { id: "juridico.deadline.create", method: "POST", path: "juridico/deadlines", title: "Criar prazo",
      description: "Cria um prazo no processo (ordem de serviço), calculado pelo calendário forense. Fica para o advogado conferir.",
      fields: ["order_id", "calendar_id", "calendar_revision", "assignee", "title", "rule"] },
    { id: "juridico.deadline.confirm", method: "POST", path: "juridico/deadlines/:id/confirm", title: "Conferir prazo",
      description: "Marca o prazo como conferido pelo advogado.", fields: ["version", "task_version", "checked"] },
    { id: "juridico.deadline.complete", method: "POST", path: "juridico/deadlines/:id/complete", title: "Cumprir prazo",
      description: "Marca o prazo como cumprido.", fields: ["version"] },
    { id: "juridico.alert.acknowledge", method: "POST", path: "juridico/alerts/:id/acknowledge", title: "Dar ciência no alerta",
      description: "Registra que o alerta de prazo foi visto." },
    { id: "juridico.calendar.save", method: "POST", path: "juridico/calendars", title: "Cadastrar calendário forense",
      description: "Cadastra um calendário forense com feriados e suspensões." },
    { id: "juridico.calendar.update", method: "PUT", path: "juridico/calendars/:id", title: "Revisar calendário forense",
      description: "Revisa um calendário forense; os prazos ligados são recalculados." },
    { id: "juridico.customer.link", method: "PUT", path: "juridico/works/:order_id/contact", title: "Ligar processo ao cliente",
      description: "Liga o processo (ordem de serviço) a um contato do cadastro.", fields: ["contact_id"] },
  ],
};
