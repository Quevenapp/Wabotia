// Catálogo de operações que o bot da conversa interna pode usar em nome da
// pessoa (docs/API.md "Ações pelo bot"). Nada é escrito à mão: sai do que os
// módulos já declaram (rotas onRead e onRoute, e o OpenAPI de cada módulo) e
// é filtrado pelo que a pessoa alcança. Módulo ajusta em `definition.bot`.
import { openapi } from "../openapi";
import { moduleRoutes } from "../modules/hooks";
import { moduleForRoute, moduleStates } from "../modules/registry";
import { requireOperationAccess, requireRouteAccess } from "../access";
import { ApiError, type Actor, type Env } from "../types";

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
}

const PREFIX = "/profiles/{profile}/";
const toRoute = (path: string) =>
  path.slice(PREFIX.length).replace(/\{(\w+)\}/g, ":$1");

let built: CatalogOperation[] | null = null;
/** Testes que mudam `definition.bot` refazem o catálogo. */
export const resetCatalogCache = () => {
  built = null;
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

/** Todas as operações das rotas de módulos, uma vez por isolado. */
export function fullCatalog(): CatalogOperation[] {
  if (built) return built;
  const spec = openapi("https://wabotia.invalid");
  const components = spec.components?.schemas || {};
  const routes = moduleRoutes();
  const out: CatalogOperation[] = [];
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
        if (!routes.read.some((r) => r.path === route)) continue;
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
      const sensitive =
        kind === "write" &&
        (scope === "billing:write" ||
          (bot.sensitive || []).some((p) => name.startsWith(p)));
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
  return out;
}

/** Operações que a pessoa alcança agora na área: módulo ligado e acesso dela. */
export async function catalogFor(env: Env, actor: Actor, profile: string) {
  const states = await moduleStates(env, profile);
  return fullCatalog().filter((op) => {
    if (!states[op.module]) return false;
    try {
      requireRouteAccess(actor, op.path.split("/")[0]);
      if (op.kind === "write") requireOperationAccess(actor, op.name);
      return true;
    } catch (error) {
      if (error instanceof ApiError) return false;
      throw error;
    }
  });
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

/** Visão de uma operação para o modelo (sem o que não ajuda a chamar). */
export function operationView(op: CatalogOperation) {
  const params = JSON.stringify(op.params);
  return {
    operacao: op.name,
    tipo: op.kind === "read" ? "consulta" : "acao",
    modulo: op.module,
    resumo: op.summary,
    ...(op.sensitive ? { exige_segundo_fator: true } : {}),
    parametros:
      params.length <= 2500
        ? op.params
        : { type: "object", description: "Esquema grande: informe só os campos citados no resumo.", required: op.params.required },
  };
}
