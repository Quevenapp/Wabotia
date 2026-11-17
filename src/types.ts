export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  SETUP_TOKEN: string;
  APP_NAME?: string;
  /** Endereço do app na App Store (página do QR do entregador, /c/<código>). */
  IOS_APP_URL?: string;
  WABOTIA_ACCOUNT_ID?: string;
  WABOTIA_WORKER_NAME?: string;
  WABOTIA_INSTALLATION_ID?: string;
  WABOTIA_UPDATE_TOKEN?: string;
  /** "1" only on the official site: turns on the browser installer. */
  WABOTIA_WEB_INSTALLER?: string;
  /**
   * Repositório do código em execução (AGPL-3.0, §13), para quem modificar o
   * Wabotia. Padrão: o repositório oficial. Veja src/source.ts.
   */
  WABOTIA_SOURCE_URL?: string;
}
export interface Actor {
  id: string;
  kind: "user" | "app" | "connector";
  name: string;
  role: "admin" | "operator" | "service";
  profiles: string[];
  scopes: string[];
  bots: string[];
  keyId?: string;
  /** Validade da credencial (sessão ou chave), para fechar sockets abertos. */
  expiresAt?: number;
  /**
   * Pessoa: o que ela acessa (src/access.ts). null = tudo (atendente
   * completo); o administrador e aplicações não usam.
   */
  access?: string[] | null;
  /**
   * Pessoa: nível da sessão (1 só senha, 2 com segundo fator) e o id público
   * da sessão (src/mfa.ts). Aplicações não têm.
   */
  aal?: 1 | 2;
  sessionId?: string;
  /** Pessoa: tem fator ativo e a política da instância (src/mfa.ts). */
  mfa?: { factor: boolean; policy: "off" | "financial" | "all" };
  /**
   * A pessoa agiu pelo bot na conversa interna (src/bot-actions): o núcleo
   * grava `audit.via` e mascara o que vai ao modelo. O segundo fator trata o
   * ator com `via` como pessoa (src/mfa.ts, requireFinancialAal).
   */
  via?: BotVia;
  rate: number;
  runLimit: number;
  /**
   * Credencial de módulo trocada por QR (src/module-credentials.ts): só as
   * rotas do módulo, só o registro `subject` (a entrega). Sem escopos.
   */
  credential?: { id: string; module: string; subject: string };
  /**
   * Ator de módulo (ctx.moduleActor): o módulo `id` age em outros módulos
   * por ctx.read/ctx.run, só nos de `reach`. Nunca vem de uma requisição.
   */
  module?: { id: string; reach: string[] };
}
export interface BotVia {
  kind: "bot";
  bot_id: string;
  run_id: string;
  proposal_id?: string;
  /** Leitura que vai ao modelo de IA: dado pessoal mascarado (padrão). */
  masked: boolean;
}
export type Bindings = {
  Bindings: Env;
  Variables: {
    actor: Actor;
    requestId: string;
    /** Env com as leituras feitas antes da rota (src/index.ts, /api/v1). */
    pre?: Env;
  };
};
export interface Profile {
  id: string;
  name: string;
  settings: string;
  enabled: number;
  created: number;
}
export interface Conversation {
  /** JSON {module, summary, flags, at} da passagem feita por um módulo. */
  handoff?: string | null;
  department_id?: string | null;
  ticket_prompt_expires_at?: number | null;
  ticket_prompt_category?: string | null;
  ticket_prompt_session?: string | null;
  ticket_prompt_source?: string | null;
  queue_prompt_expires_at?: number | null;
  queue_prompt_step?: string | null;
  queue_prompt_queue_id?: string | null;
  queue_prompt_session?: string | null;
  queue_prompt_source?: string | null;
  queue_menu_session?: string | null;
  menu_expires_at?: number | null;
  menu_token?: string | null;
  menu_items?: string;
  assigned_bot_id?: string | null;
  menu_active?: number;
  menu_manual?: number;
  menu_parent?: string | null;
  recipient_id?: string | null;
  chat_type: string;
  title: string;
  bot_policy: string;
  id: string;
  profile_id: string;
  connection_id: string | null;
  external_namespace: string;
  external_id: string;
  phone: string | null;
  state: string;
  owner: string | null;
  epoch: number;
  session: string;
  topic: string | null;
  tags: string;
  last_customer: number;
  created: number;
  updated: number;
}
export interface Run {
  request_body?: string;
  completion_handled?: number;
  id: string;
  profile_id: string;
  bot_id: string;
  actor: string;
  conversation_id: string | null;
  epoch: number | null;
  status: string;
  input: string;
  result: string | null;
  remote_id: string | null;
  error: string | null;
  created: number;
  updated: number;
  phase: string;
  context: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const json = (value: any, fallback: any = {}) => {
  try {
    return JSON.parse(value ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
export function requireValue(value: any, message: string): asserts value {
  if (!value) throw new ApiError(400, "invalid_request", message);
}
// Kept here, without imports, because `defaults` is read while modules load.
export const defaultProtocolConfirmation = `Sua solicitação foi registrada.

Protocolo: {numero}
Aplicativo: {aplicativo}
Assunto: {assunto}

Primeira resposta da equipe: até {prazo}, no horário de Brasília.

Vamos analisar o que você informou. Se precisarmos de mais detalhes, entraremos em contato por este atendimento. A previsão de solução será informada após a análise.

Para acompanhar, envie MEUS PROTOCOLOS.`;
export const defaultBusinessHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  holidays: [] as string[],
};
export const defaults = {
  attendant_bot: "",
  instructions: "",
  absence_instructions:
    "Nossa equipe está ausente. Abrimos um protocolo para acompanhar sua solicitação.",
  // Team absent on a handoff: open a protocol (true) or only tell the customer.
  absence_ticket: true,
  // While a conversation waits with nobody present, the Bot Atendente keeps
  // answering follow-up messages instead of leaving the customer in silence.
  absence_followup: true,
  // Team absent and protocol opened: the conversation leaves the queue and goes
  // back to the Bot Atendente; the team follows the case through the protocol.
  absence_return_to_bot: false,
  // Team absent and protocol opened: ask the customer to rate the service.
  absence_survey: false,
  // After a protocol is opened, ask once for consent to protocol notifications
  // (only when notifications are enabled).
  protocol_consent_prompt: true,
  protocol_response_hours: 24,
  protocol_response_unit: "hours",
  protocol_response_days: 3,
  business_hours: defaultBusinessHours,
  ticket_categories: [],
  protocol_confirmation: defaultProtocolConfirmation,
  // Opening text of the main menu. Empty keeps "Como podemos ajudar?".
  menu_greeting: "",
  // Messages to the customer start with who writes: "Bruno - Humano", "Bia - IA".
  sender_signature: true,
  names: {},
  team: [],
  capabilities: [],
  departments: [],
  menus: [],
  apps: [],
  surveys_enabled: false,
  jev_enabled: false,
  // Modelo do JEV fixado (src/jev-client.ts): limiares ajustados contra uma
  // versão não mudam sozinhos quando o alias jev-latest avança.
  jev_model: "jev-1.14.0",
  // Limiar de probabilidade e confiança do JEV (0,5 a 0,99); por bot em
  // jev_bot_thresholds {bot_id: limiar}. Abaixo dele, a decisão vai para pessoa.
  jev_threshold: 0.8,
  jev_bot_thresholds: {},
  notifications: { enabled: false, template_name: "", language: "pt_BR" },
  // Fila de senhas (src/queue.ts → queueDefaults); merged field by field.
  queue: {},
  // Formulários do módulo "forms" (src/modules/forms).
  forms: [],
};
