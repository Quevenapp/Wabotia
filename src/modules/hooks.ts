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
  ) => Promise<void>,
) {
  webStepHooks.set(module, hook);
}
export const webStepHook = (module: string) => webStepHooks.get(module);

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
const writeRoutes: ModuleWriteRoute[] = [];
const readRoutes: ModuleReadRoute[] = [];
export function registerWriteRoute(route: ModuleWriteRoute) {
  writeRoutes.push(route);
}
export function registerReadRoute(route: ModuleReadRoute) {
  readRoutes.push(route);
}
/** Rotas declaradas pelos módulos, montadas por src/index.ts. */
export const moduleRoutes = () => ({
  write: [...writeRoutes],
  read: [...readRoutes],
});

/** Validação estrita de uma chave das configurações (PUT /settings). */
export function registerSettingsValidator(
  key: string,
  validate: (value: unknown) => unknown,
) {
  settingsValidators.set(key, validate);
}
export const settingsValidator = (key: string) => settingsValidators.get(key);
