// Catálogo de operações que o bot da conversa interna pode usar em nome da
// pessoa (docs/API.md "Ações pelo bot"). Nada é escrito à mão: sai do que os
// módulos já declaram (rotas onRead e onRoute, e o OpenAPI de cada módulo) e
// é filtrado pelo que a pessoa alcança. Módulo ajusta em `definition.bot`.
// As rotas do ERP que são repasse sem registro saem do inventário de
// concessões (src/modules/erp/bot-access.ts), só para o bot que as tem.
import { openapi } from "../openapi";
import { moduleRoutes } from "../modules/hooks";
import { moduleForRoute, moduleStates } from "../modules/registry";
import { requireOperationAccess, requireRouteAccess } from "../access";
import { ApiError, type Actor, type Env } from "../types";
import { ERP_BOT_OPERATIONS, ERP_BOT_SCHEMAS, erpBotGrants, erpBotModules, type ErpBotOperation } from "../modules/erp/bot-access";
import { AREA_BOT_MODULES, areaGrantsFor, areaKind, type AreaBotModule, type AreaBotOperation } from "./area";

export interface CatalogOperation {
  /** Nome usado nas ferramentas: a op da escrita ("os.create") ou "consulta:<caminho>". */
  name: string;
  kind: "read" | "write";
  module: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Caminho depois de /profiles/:profile/, com :parâmetros. */
  path: string;
  summary: string;
  description: string;
  /** JSON Schema dos parâmetros (caminho, consulta ou corpo), num objeto só. */
  params: { type: "object"; properties: Record<string, any>; required: string[] };
  sensitive: boolean;
  /** Escopo exigido de uma aplicação (documentação; a pessoa não usa). */
  scope: string;
  /** Operação de módulo de área (Saúde, Ensino, Jurídico, Condomínio) liberada ao bot. */
  area?: true;
  /** Escrita de módulo de área que o administrador liberou sem confirmação. */
  direct?: boolean;
}

const PREFIX = "/profiles/{profile}/";
const toRoute = (path: string) =>
  path.slice(PREFIX.length).replace(/\{(\w+)\}/g, ":$1");

let built: CatalogOperation[] | null = null;
let specs: Map<string, CatalogOperation["params"]> | null = null;
/** Testes que mudam `definition.bot` refazem o catálogo. */
export const resetCatalogCache = () => {
  built = null;
  specs = null;
};

/** Resolve $ref do OpenAPI (até 3 níveis) e tira o que só pesa no contexto. */
function resolve(schema: any, components: any, depth = 0): any {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").pop()!;
    const target = components?.[name];
    if (!target || depth > 2) return { type: "object" };
    return resolve(target, components, depth + 1);
  }
  if (Array.isArray(schema)) return schema.map((s) => resolve(s, components, depth));
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "readOnly" || key === "example" || key === "examples") continue;
    out[key] = resolve(value, components, depth);
  }
  return out;
}

/** Leitura do ERP marcada como sensível: entra no catálogo como "exige proposta". */
export const erpSensitiveRead = (route: string) =>
  ERP_BOT_OPERATIONS.some((op) => op.sensitive && op.method === "GET" && op.path === route);

/** Todas as operações das rotas de módulos, uma vez por isolado. */
export function fullCatalog(): CatalogOperation[] {
  if (built) return built;
  const spec = openapi("https://wabotia.invalid");
  const components = spec.components?.schemas || {};
  const routes = moduleRoutes();
  const out: CatalogOperation[] = [];
  const params = new Map<string, CatalogOperation["params"]>();
  for (const [path, item] of Object.entries<any>(spec.paths || {})) {
    if (!path.startsWith(PREFIX)) continue;
    const route = toRoute(path);
    const owner = moduleForRoute(route.split("/")[0]);
    if (!owner) continue;
    for (const [method, entry] of Object.entries<any>(item)) {
      const upper = method.toUpperCase() as CatalogOperation["method"];
      let name: string;
      let kind: CatalogOperation["kind"];
      if (upper === "GET") {
        if (!routes.read.some((r) => r.path === route) && !routes.binary.some((r) => r.method === "GET" && r.path === route)) continue;
        kind = "read";
        name = `consulta:${route}`;
      } else {
        const write = routes.write.find(
          (r) => r.path === route && r.method === upper,
        );
        if (!write) continue;
        kind = "write";
        name = write.op;
      }
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const p of entry.parameters || []) {
        if (p.in === "header" || p.name === "profile") continue;
        properties[p.name] = {
          ...resolve(p.schema || { type: "string" }, components),
          ...(p.description ? { description: p.description } : {}),
        };
        if (p.required) required.push(p.name);
      }
      const body = entry.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        const resolved = resolve(body, components);
        Object.assign(properties, resolved.properties || {});
        for (const r of resolved.required || [])
          if (!required.includes(r)) required.push(r);
      }
      const scope = /Permissão: ([\w:]+)/.exec(entry.description || "")?.[1] || "";
      const bot = owner.bot || {};
      const hint = bot.hints?.[name] ?? bot.hints?.[route];
      // Leitura sensível do ERP (arquivo de cobrança, registro de atividades)
      // exige proposta, salvo a opção autônoma do administrador.
      const sensitive =
        (kind === "write" &&
          (scope === "billing:write" ||
            (bot.sensitive || []).some((p) => name.startsWith(p)))) ||
        (kind === "read" && erpSensitiveRead(route));
      // Também das rotas fora do catálogo comum: os módulos de área usam.
      params.set(`${upper} ${route}`, { type: "object", properties, required });
      if ((bot.deny || []).some((p) => name.startsWith(p) || route.startsWith(p)))
        continue;
      out.push({
        name,
        kind,
        module: owner.id,
        method: upper,
        path: route,
        summary: hint || entry.summary || name,
        description: String(entry.description || "").slice(0, 600),
        params: { type: "object", properties, required },
        sensitive,
        scope,
      });
    }
  }
  built = out;
  specs = params;
  return out;
}

/** Operação nominal do ERP que não sai das rotas dos módulos (repasse sem
 * registro): entra só pela concessão do bot. Leitura sensível liberada como
 * autônoma pelo administrador vai direto; as demais seguem a proposta. */
export function erpCatalogOperation(op: ErpBotOperation, autonomous = false): CatalogOperation {
  const kind = op.method === "GET" ? "read" : "write";
  return {
    name: op.id,
    kind,
    module: "erp",
    method: op.method as CatalogOperation["method"],
    path: op.path,
    summary: op.summary,
    description: op.description.slice(0, 600),
    params: resolve(op.params, ERP_BOT_SCHEMAS),
    sensitive: op.sensitive && !(kind === "read" && autonomous),
    scope: kind === "read" ? "erp:read" : "erp:write",
  };
}

/** Operações que a pessoa alcança agora na área: módulo ligado e acesso dela. */
export async function catalogFor(env: Env, actor: Actor, profile: string) {
  const states = await moduleStates(env, profile);
  const reachable = (op: CatalogOperation) => {
    if (!states[op.module]) return false;
    try {
      requireRouteAccess(actor, op.path.split("/")[0]);
      // O ERP confere o papel da pessoa na própria rota (erpIdentity).
      if (op.kind === "write" && op.module !== "erp") requireOperationAccess(actor, op.name);
      return true;
    } catch (error) {
      if (error instanceof ApiError) return false;
      throw error;
    }
  };
  const catalog = fullCatalog();
  const available = catalog.filter(reachable);
  if (!actor.via) return available;
  // Concessão nominal do administrador para este bot nesta área, relida agora.
  const { operations: granted, autonomous } = await erpBotGrants(env, actor, profile);
  const contract = (op: { method: string; path: string }) =>
    ERP_BOT_OPERATIONS.find(entry => entry.method === op.method && entry.path === op.path);
  const listed = available.filter(op => {
    if (!op.path.startsWith("erp-comercial-nfe/")) return true;
    const entry = contract(op);
    return !!entry && granted.includes(entry.id);
  });
  const erp = ERP_BOT_OPERATIONS
    .filter(op => granted.includes(op.id) && !catalog.some(entry => entry.method === op.method && entry.path === op.path) &&
      erpBotModules(op).every(id => states[id]))
    .map(op => erpCatalogOperation(op, autonomous.includes(op.id)))
    .filter(reachable);
  // Módulos de área: só o que o administrador ligou para este bot, com o
  // módulo ligado na área e o acesso da pessoa (src/bot-actions/area.ts).
  const area = await areaGrantsFor(env, actor, profile);
  const fromArea = AREA_BOT_MODULES.flatMap(module => states[module.module]
    ? module.operations.filter(op => area.operations.has(op.id)).map(op => areaCatalogOperation(module, op, area.direct.has(op.id)))
    : []).filter(reachable);
  return [...listed, ...erp, ...fromArea];
}

/** Parâmetros de uma rota de módulo no OpenAPI (inclusive as fora do catálogo comum). */
function specParams(method: string, route: string) {
  if (!specs) fullCatalog();
  return specs?.get(`${method} ${route}`);
}

/** Operação de módulo de área como o bot a vê. Escrita é sensível (proposta
 * e segundo fator), salvo a execução direta liberada pelo administrador. */
export function areaCatalogOperation(module: AreaBotModule, op: AreaBotOperation, direct = false): CatalogOperation {
  const kind = areaKind(op);
  const fromSpec = specParams(op.method, op.path);
  const pathParams = [...op.path.matchAll(/:(\w+)/g)].map(match => match[1]);
  const properties: Record<string, any> = { ...(fromSpec?.properties ?? {}) };
  for (const key of pathParams) properties[key] ??= { type: "string" };
  for (const key of op.fields ?? []) properties[key] ??= {};
  const required = [...new Set([...pathParams, ...(fromSpec?.required ?? [])])];
  return {
    name: op.id,
    kind,
    module: module.module,
    method: op.method,
    path: op.path,
    summary: `${module.title}: ${op.title}`,
    description: op.description.slice(0, 600),
    params: { type: "object", properties, required },
    sensitive: kind === "write" && !direct,
    scope: kind === "read" ? "conversations:read" : "conversations:write",
    area: true,
    direct: kind === "write" && direct,
  };
}

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Busca em português: palavras do pedido no resumo, módulo, caminho e op. */
export function searchCatalog(
  ops: CatalogOperation[],
  text: string,
  options: { kind?: "read" | "write"; limit?: number } = {},
) {
  const words = fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const scored = ops
    .filter((op) => !options.kind || op.kind === options.kind)
    .map((op) => {
      const hay = fold(
        `${op.summary} ${op.module} ${op.path} ${op.name} ${op.description}`,
      );
      const score = words.length
        ? words.filter((w) => hay.includes(w)).length
        : 1;
      return { op, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.op.name.localeCompare(b.op.name));
  return scored.slice(0, options.limit ?? 10).map((s) => s.op);
}

const compactParams = (op: CatalogOperation) =>
  ({ type: "object", description: "Esquema grande: informe só os campos citados no resumo.", required: op.params.required });

/** Visão de uma operação para o modelo (sem o que não ajuda a chamar). */
export function operationView(op: CatalogOperation) {
  const params = JSON.stringify(op.params);
  return {
    operacao: op.name,
    tipo: op.kind === "read" ? "consulta" : "acao",
    modulo: op.module,
    resumo: op.summary,
    ...(op.sensitive ? { exige_segundo_fator: true } : {}),
    ...(op.kind === "read" && op.sensitive ? { exige_proposta: true } : {}),
    ...(op.direct ? { execucao_direta: true } : {}),
    parametros: params.length <= 2500 ? op.params : compactParams(op),
  };
}

/** Visões que cabem juntas em `budget` caracteres: compacta primeiro os
 * esquemas maiores, para a resposta nunca sair cortada (JSON inválido). */
export function operationViews(ops: CatalogOperation[], budget: number) {
  const views = ops.map(operationView);
  const size = () => JSON.stringify(views).length;
  const largest = views
    .map((view, i) => ({ i, length: JSON.stringify(view.parametros).length }))
    .sort((a, b) => b.length - a.length);
  for (const { i } of largest) {
    if (size() <= budget) break;
    views[i] = { ...views[i], parametros: compactParams(ops[i]) };
  }
  return views;
}
