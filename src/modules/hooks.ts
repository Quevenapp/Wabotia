// Ganchos que os módulos registram ao carregar (src/modules/runtime.ts). Este
// arquivo não importa implementações dos módulos: o núcleo (service, engine,
// web-steps) consulta os ganchos sem criar ciclo com elas.
import type { Answers } from "../web-steps";
import { TrieRouter } from "hono/router/trie-router";
import { tryDecodeURIComponent } from "hono/utils/url";
// Só o erro da API (src/types.ts não importa módulos: sem ciclo).
import { ApiError, type Actor, type Env } from "../types";

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
// Um registro por módulo. O integrador acrescenta trabalho ao agregador;
// extensões de OS não chamam registerSchedule/onSchedule novamente.
const scheduleExtensions = new Map<string, Hook>();
export function registerScheduleExtension(module: string, handler: Hook) {
  scheduleExtensions.set(module, handler);
}
export const scheduledModules = (): [string, Hook][] => [...schedules.entries()].map(
  ([module, handler]) => [module, async (...args: any[]) => {
    try {
      await handler(...args);
    } finally {
      // Mesmo se o lembrete legado falhar, executar os filhos e sua continuação.
      await scheduleExtensions.get(module)?.(...args);
    }
  }],
);

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
const turnExtensions = new Map<string, Hook>();
/** Complementa o turno legado; não o substitui ao integrar documentos. */
export function registerTurnExtension(module: string, handler: Hook) {
  turnExtensions.set(module, handler);
}
export const turnHandlersList = (): [string, Hook][] => turnHandlers.map(
  ([module, handler]) => [module, async (...args: any[]) => {
    if (await handler(...args)) return true;
    return await turnExtensions.get(module)?.(...args) || false;
  }],
);

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
  /**
   * Bot do provedor de IA direto atendendo o cliente no WhatsApp
   * (src/bot-actions/customer.ts). Padrão: leitura vira consulta direta;
   * escrita vira proposta que o cliente confirma por botão. `false`: fora
   * do atendimento ao cliente. `"read"`: escrita sem efeito de compra ou
   * cobrança nova (segunda via), sem confirmação.
   */
  customer?: false | "read" | "propose";
  /**
   * Texto que o cliente confirma (modo cliente, src/bot-actions/describe.ts):
   * montado pelo módulo com dados lidos por código (itens, valores, datas),
   * nunca pelo modelo. `input` já vem com o conversation_id da execução. Sem
   * ele, o núcleo lista a ação e os campos do pedido.
   */
  describe?: (
    env: any,
    profile: string,
    input: Record<string, any>,
  ) => Promise<string | null>;
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

/**
 * Credencial por QR (wabx_) numa rota do módulo: negada por padrão. A rota
 * que aceita declara `credential: true` e o núcleo confere que o parâmetro
 * `credentialParam` (padrão "id") é o registro da credencial (`subject`).
 * Sem esse parâmetro no caminho, a rota não pode aceitar credencial.
 */
export interface CredentialRouteOptions {
  credential?: boolean;
  credentialParam?: string;
}

/** Recusa a credencial numa rota que não a aceita ou de outro registro. */
export function credentialGate(
  actor: any,
  route: { path: string } & CredentialRouteOptions,
  params: Record<string, string>,
) {
  if (!actor?.credential) return;
  const param = route.credentialParam || "id";
  if (
    !route.credential ||
    !route.path.split("/").includes(":" + param) ||
    params[param] !== actor.credential.subject
  )
    throw new ApiError(
      403,
      "credential_scope",
      "Este acesso vale só para o registro do QR.",
    );
}

export interface ModuleWriteRoute extends CredentialRouteOptions {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Depois de /api/v1/profiles/:profile/, com parâmetros nomeados opcionais. */
  path: string;
  op: string;
}
export interface ModuleReadRoute extends CredentialRouteOptions {
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
export interface ModuleTelemetryRoute extends CredentialRouteOptions {
  path: string;
  handler: (
    env: any,
    actor: any,
    profile: string,
    request: { params: Record<string, string>; body: any },
  ) => Promise<any>;
}
export interface BinaryRouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  request: Request;
}
export interface ModuleBinaryRoute extends CredentialRouteOptions {
  method: "GET" | "PUT";
  path: string;
  handler: (env: Env, actor: Actor, profile: string, request: BinaryRouteRequest) => Promise<Response>;
}
const writeRoutes: ModuleWriteRoute[] = [];
const readRoutes: ModuleReadRoute[] = [];
const telemetryRoutes: ModuleTelemetryRoute[] = [];
const binaryRoutes: ModuleBinaryRoute[] = [];
let routesRevision = 0;
export function registerWriteRoute(route: ModuleWriteRoute) {
  writeRoutes.push(route);
  routesRevision++;
}
export function registerReadRoute(route: ModuleReadRoute) {
  readRoutes.push(route);
  routesRevision++;
}
export function registerTelemetryRoute(route: ModuleTelemetryRoute) {
  telemetryRoutes.push(route);
}
export function registerBinaryRoute(route: ModuleBinaryRoute) {
  binaryRoutes.push(route);
  routesRevision++;
}
/** Campos do caminho prevalecem; profile é exclusivamente o contexto autenticado. */
export function routeData(body: unknown, params: Record<string, string>): Record<string, unknown> {
  const data = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const { profile: _bodyProfile, ...safeBody } = data as Record<string, unknown>;
  const { profile: _pathProfile, ...safeParams } = params;
  return { ...safeBody, ...safeParams };
}
/** Prioridade lexical por segmento: estático antes de parâmetro, estável nos empates. */
export function orderedRoutes<T extends { path: string }>(routes: readonly T[]): T[] {
  return [...routes].sort((a, b) => {
    const left = a.path.split("/"), right = b.path.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const difference = Number(left[i].startsWith(":")) - Number(right[i].startsWith(":"));
      if (difference) return difference;
      if (left[i] !== right[i]) return left[i].localeCompare(right[i]);
    }
    return left.length - right.length;
  });
}
/** Rotas declaradas pelos módulos, montadas por src/index.ts. */
export const moduleRoutes = () => ({
  write: orderedRoutes(writeRoutes),
  read: orderedRoutes(readRoutes),
  telemetry: orderedRoutes(telemetryRoutes),
  binary: orderedRoutes(binaryRoutes),
});

type DispatchRoute =
  | (ModuleWriteRoute & { kind: "write" })
  | (ModuleReadRoute & { kind: "read"; method: "GET" })
  | (ModuleBinaryRoute & { kind: "binary" });
let routeMatcher: TrieRouter<DispatchRoute> | undefined;
let matchedRevision = -1;

/**
 * O registro pode terminar depois do carregamento da entrada HTTP. Recria o
 * índice somente quando ele muda, sem acrescentar rotas a um Hono já usado.
 * A prioridade estática vale também entre leituras JSON e binárias.
 */
export function matchModuleRoute(method: string, path: string) {
  if (!routeMatcher || matchedRevision !== routesRevision) {
    const routes: DispatchRoute[] = [
      ...writeRoutes.map((route) => ({ ...route, kind: "write" as const })),
      ...binaryRoutes.map((route) => ({ ...route, kind: "binary" as const })),
      ...readRoutes.map((route) => ({ ...route, kind: "read" as const, method: "GET" as const })),
    ];
    routeMatcher = new TrieRouter<DispatchRoute>();
    for (const route of orderedRoutes(routes))
      routeMatcher.add(route.method, `/api/v1/profiles/:profile/${route.path}`, route);
    matchedRevision = routesRevision;
  }
  const result = routeMatcher.match(method === "HEAD" ? "GET" : method, path);
  const match = result[0][0];
  if (!match) return null;
  const [route, rawParams] = match;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    const raw = result[1] ? result[1][Number(value)] : String(value);
    params[key] = tryDecodeURIComponent(raw);
  }
  return { route, params };
}

/**
 * Pedido de aprovação à equipe (src/approvals.ts): o módulo confere o ajuste
 * e aplica o efeito da decisão. (env, profile, approval, decision).
 */
export interface ApprovalHook {
  validate?: (
    env: any,
    profile: string,
    approval: any,
    decision: any,
  ) => Promise<void>;
  decided?: (
    env: any,
    profile: string,
    approval: any,
    decision: any,
  ) => Promise<void>;
}
const approvalHooks = new Map<string, ApprovalHook>();
export function registerApprovalHook(
  module: string,
  kind: string,
  hook: ApprovalHook,
) {
  approvalHooks.set(`${module}:${kind}`, hook);
}
export const approvalHook = (module: string, kind: string) =>
  approvalHooks.get(`${module}:${kind}`);

/** Validação estrita de uma chave das configurações (PUT /settings). */
export function registerSettingsValidator(
  key: string,
  validate: (value: unknown) => unknown,
) {
  settingsValidators.set(key, validate);
}
export const settingsValidator = (key: string) => settingsValidators.get(key);

export interface SettingsChangeContext {
  changed_keys: readonly string[];
  modules: Readonly<Record<string, boolean>>;
}
export type SettingsChangeValidator = (
  previous: Readonly<Record<string, any>>,
  next: Readonly<Record<string, any>>,
  context: SettingsChangeContext,
) => void;
const settingsChangeValidators = new Map<string, SettingsChangeValidator>();
/** Gancho puro: recebe a configuração completa, inclusive menus ocultos. */
export function registerSettingsChangeValidator(module: string, validate: SettingsChangeValidator) {
  const previous = settingsChangeValidators.get(module);
  settingsChangeValidators.set(module, validate);
  return () => {
    if (settingsChangeValidators.get(module) !== validate) return;
    if (previous) settingsChangeValidators.set(module, previous);
    else settingsChangeValidators.delete(module);
  };
}
export function validateSettingsChange(
  previous: Readonly<Record<string, any>>, next: Readonly<Record<string, any>>, context: SettingsChangeContext,
) {
  for (const validate of settingsChangeValidators.values()) validate(previous, next, context);
}
