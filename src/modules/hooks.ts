// Ganchos que os módulos registram ao carregar (src/modules/runtime.ts). Este
// arquivo não importa nada de propósito: o núcleo (service, engine, web-steps)
// consulta os ganchos sem criar ciclo de importação com os módulos.
import type { Answers } from "../web-steps";

type Hook = (...args: any[]) => Promise<any>;

const webStepHooks = new Map<string, Hook>();
const menuHandlers = new Map<string, Hook>();
const conversationActions = new Map<string, Hook>();
const settingsValidators = new Map<string, (value: unknown) => unknown>();

/** Conclusão de um passo web do módulo: (env, profile, step, answers). */
export function registerWebStepHook(
  module: string,
  hook: (
    env: any,
    profile: string,
    step: any,
    answers: Answers,
  ) => Promise<void | string | false>,
) {
  webStepHooks.set(module, hook);
}
export const webStepHook = (module: string) => webStepHooks.get(module);

/**
 * Antes de concluir um passo web do módulo: (env, profile, step, answers) →
 * texto do motivo para recusar (loja fechou, item esgotou) ou nada.
 */
const webStepValidators = new Map<string, Hook>();
export function registerWebStepValidator(
  module: string,
  validator: (
    env: any,
    profile: string,
    step: any,
    answers: Answers,
  ) => Promise<string | null | void>,
) {
  webStepValidators.set(module, validator);
}
export const webStepValidator = (module: string) =>
  webStepValidators.get(module);

/**
 * Página de acompanhamento (spec.page "track") aberta pelo cliente:
 * (env, profile, step) → o que mostrar (src/web-track.ts, TrackView).
 */
const webStepPages = new Map<string, Hook>();
export function registerWebStepPage(
  module: string,
  hook: (env: any, profile: string, step: any) => Promise<any>,
) {
  webStepPages.set(module, hook);
}
export const webStepPageHook = (module: string) => webStepPages.get(module);

/**
 * QR do módulo lido pelo app (credencial por QR, src/module-credentials.ts):
 * (env, profile, credential) → dados da resposta ao app; lançar recusa.
 */
const credentialHooks = new Map<string, Hook>();
export function registerCredentialHook(
  module: string,
  hook: (env: any, profile: string, credential: any) => Promise<any>,
) {
  credentialHooks.set(module, hook);
}
export const credentialHook = (module: string) => credentialHooks.get(module);

/** Item de menu do WhatsApp escolhido: (env, conversation, item, rowId). */
export function registerMenuHandler(
  type: string,
  handler: (env: any, c: any, item: any, rowId: string) => Promise<void>,
) {
  menuHandlers.set(type, handler);
}
export const menuHandler = (type: string) => menuHandlers.get(type);

/** Ação de conversa (POST /conversations/:id/actions, action=<nome>). */
export function registerConversationAction(
  action: string,
  handler: (
    env: any,
    actor: any,
    c: any,
    data: any,
    requestId: string,
  ) => Promise<any>,
) {
  conversationActions.set(action, handler);
}
export const conversationAction = (action: string) =>
  conversationActions.get(action);

/**
 * Conteúdo estruturado recebido do WhatsApp ("order", "flow_reply"):
 * (env, conversation, content, rowId) → true quando o módulo tratou.
 */
const inboundHandlers = new Map<string, Hook[]>();
export function registerInboundHandler(
  type: string,
  handler: (env: any, c: any, content: any, rowId: string) => Promise<boolean>,
) {
  inboundHandlers.set(type, [...(inboundHandlers.get(type) || []), handler]);
}
export const inboundHandlersFor = (type: string) =>
  inboundHandlers.get(type) || [];

/** Cobrança do módulo mudou de estado: (env, profile, payment, previous). */
const paymentHooks = new Map<string, Hook>();
export function registerPaymentHook(
  module: string,
  hook: (
    env: any,
    profile: string,
    payment: any,
    previous: string,
  ) => Promise<void>,
) {
  paymentHooks.set(module, hook);
}
export const paymentHook = (module: string) => paymentHooks.get(module);

/** Tarefa periódica do módulo: (env, profile, now). Ver src/modules/schedule.ts. */
const schedules = new Map<string, Hook>();
export function registerSchedule(
  module: string,
  handler: (env: any, profile: string, now: number) => Promise<void>,
) {
  schedules.set(module, handler);
}
export const scheduledModules = () => [...schedules.entries()];

/**
 * Próxima mensagem do cliente (texto, botão ou lista), antes do menu e do bot:
 * (env, conversation, turn) → true quando o módulo tratou.
 */
const turnHandlers: [string, Hook][] = [];
export function registerTurnHandler(
  module: string,
  handler: (
    env: any,
    c: any,
    turn: { text: string; replyId: string | null; rowId: string },
  ) => Promise<boolean>,
) {
  const index = turnHandlers.findIndex(([id]) => id === module);
  if (index >= 0) turnHandlers[index] = [module, handler];
  else turnHandlers.push([module, handler]);
}
export const turnHandlersList = () => [...turnHandlers];

/**
 * Passagem automática para humano (menu, palavra-chave, bot…):
 * (env, conversation, request) → "hold" quando o módulo segura a conversa.
 * O núcleo consulta na ordem de `modules` (registry.ts).
 */
const handoffGates: [string, Hook][] = [];
/** Módulos cujo gancho segura a passagem quando falha (revisão B1). */
const failClosedGates = new Set<string>();
export function registerHandoffGate(
  module: string,
  gate: (env: any, c: any, request: any) => Promise<"allow" | "hold">,
  options: { failClosed?: boolean } = {},
) {
  const index = handoffGates.findIndex(([id]) => id === module);
  if (index >= 0) handoffGates[index] = [module, gate];
  else handoffGates.push([module, gate]);
  if (options.failClosed) failClosedGates.add(module);
  else failClosedGates.delete(module);
}
export const handoffGatesList = () => [...handoffGates];
export const gateFailsClosed = (module: string) => failClosedGates.has(module);

/** Ferramenta MCP declarada por um módulo (traduzida para a API v1). */
export interface ModuleMcpTool {
  module: string;
  name: string;
  description: string;
  /** Parâmetros (JSON Schema simples); profile é acrescentado pelo núcleo. */
  input: Record<string, any>;
  required?: string[];
  /** Escrita: o núcleo acrescenta idempotency_key. */
  write?: boolean;
  call: (
    args: Record<string, any>,
    profile: string,
  ) => {
    method?: "GET" | "POST" | "PATCH" | "PUT";
    path: string;
    query?: Record<string, any>;
    body?: Record<string, any>;
  };
}
const mcpTools: ModuleMcpTool[] = [];
export function registerMcpTool(tool: ModuleMcpTool) {
  const index = mcpTools.findIndex((t) => t.name === tool.name);
  if (index >= 0) mcpTools[index] = tool;
  else mcpTools.push(tool);
}
export const moduleMcpTools = () => [...mcpTools];

/** Comando de escrita (Coordinator): (env, actor, profile, data, requestId). */
const commands = new Map<string, Hook>();
export function registerCommand(
  op: string,
  handler: (
    env: any,
    actor: any,
    profile: string,
    data: any,
    requestId: string,
  ) => Promise<any>,
) {
  commands.set(op, handler);
}
export const moduleCommandHandler = (op: string) => commands.get(op);

export interface ModuleWriteRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Depois de /api/v1/profiles/:profile/, com :id opcional. */
  path: string;
  op: string;
}
export interface ModuleReadRoute {
  path: string;
  handler: (
    env: any,
    actor: any,
    profile: string,
    request: { params: Record<string, string>; query: Record<string, string> },
  ) => Promise<any>;
}
/**
 * Telemetria: POST fora do Coordinator, sem Idempotency-Key nem recibo, para
 * dados idempotentes por natureza (posições com horário). Uma escrita por
 * chamada, decidida pelo módulo.
 */
export interface ModuleTelemetryRoute {
  path: string;
  handler: (
    env: any,
    actor: any,
    profile: string,
    request: { params: Record<string, string>; body: any },
  ) => Promise<any>;
}
const writeRoutes: ModuleWriteRoute[] = [];
const readRoutes: ModuleReadRoute[] = [];
const telemetryRoutes: ModuleTelemetryRoute[] = [];
export function registerWriteRoute(route: ModuleWriteRoute) {
  writeRoutes.push(route);
}
export function registerReadRoute(route: ModuleReadRoute) {
  readRoutes.push(route);
}
export function registerTelemetryRoute(route: ModuleTelemetryRoute) {
  telemetryRoutes.push(route);
}
/** Rotas declaradas pelos módulos, montadas por src/index.ts. */
export const moduleRoutes = () => ({
  write: [...writeRoutes],
  read: [...readRoutes],
  telemetry: [...telemetryRoutes],
});

/** Validação estrita de uma chave das configurações (PUT /settings). */
export function registerSettingsValidator(
  key: string,
  validate: (value: unknown) => unknown,
) {
  settingsValidators.set(key, validate);
}
export const settingsValidator = (key: string) => settingsValidators.get(key);
