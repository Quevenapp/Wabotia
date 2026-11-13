export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  SETUP_TOKEN: string;
  APP_NAME?: string;
  WABOTIA_ACCOUNT_ID?: string;
  WABOTIA_WORKER_NAME?: string;
  WABOTIA_INSTALLATION_ID?: string;
  WABOTIA_UPDATE_TOKEN?: string;
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
  rate: number;
  runLimit: number;
}
export type Bindings = {
  Bindings: Env;
  Variables: { actor: Actor; requestId: string };
};
export interface Profile {
  id: string;
  name: string;
  settings: string;
  enabled: number;
  created: number;
}
export interface Conversation {
  department_id?: string | null;
  ticket_prompt_expires_at?: number | null;
  ticket_prompt_category?: string | null;
  ticket_prompt_session?: string | null;
  ticket_prompt_source?: string | null;
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
  protocol_response_hours: 24,
  protocol_response_unit: "hours",
  protocol_response_days: 3,
  business_hours: defaultBusinessHours,
  ticket_categories: [],
  protocol_confirmation: defaultProtocolConfirmation,
  // Opening text of the main menu. Empty keeps "Como podemos ajudar?".
  menu_greeting: "",
  telegram_group: "",
  telegram_connection: "",
  reply_mode: "command",
  names: {},
  team: [],
  capabilities: [],
  departments: [],
  menus: [],
  apps: [],
  surveys_enabled: false,
  jev_enabled: false,
  notifications: { enabled: false, template_name: "", language: "pt_BR" },
};
