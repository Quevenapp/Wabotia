import { erpCommercialOperations } from "./commercial-operations.ts";

const pathOf = (path: string) => "/profiles/{profile}/erp" + path.replace(/:(\w+)/g, "{$1}");
export const erpOperations: [string, string, string, string][] = erpCommercialOperations.map(op =>
  [op.method.toLowerCase(), pathOf(op.path), op.summary, op.method === "GET" ? "erp:read" : "erp:write"]);

/** OpenAPI da mesma rota de repasse que o painel usa. O catálogo de bots ainda
 * exige onRead/onRoute; documentar o repasse não registra um executor novo. */
export function describeErpOperation(path: string, method: string, entry: any, success: any) {
  const op = erpCommercialOperations.find(op => pathOf(op.path) === path && op.method.toLowerCase() === method);
  if (!op) return;
  entry.operationId = op.id;
  entry.tags = ["ERP comercial"];
  entry.description += " " + op.description;
  entry["x-bot-sensitive"] = op.sensitive;
  entry["x-bot-access"] = "Pessoa ∩ configuração do bot; origem externa conserva acesso de cliente. Escritas sensíveis propõem confirmação por padrão; liberação por bot e área depende do administrador.";
  const pathNames = [...op.path.matchAll(/:(\w+)/g)].map(match => match[1]);
  entry.parameters = (entry.parameters ?? []).filter((param: any) => param.name !== "Idempotency-Key");
  for (const param of entry.parameters) if (pathNames.includes(param.name)) param.schema = op.params.properties[param.name];
  const properties = Object.fromEntries(Object.entries(op.params.properties).filter(([key]) => !pathNames.includes(key)));
  const required = op.params.required.filter(key => !pathNames.includes(key));
  if (op.method === "GET") {
    entry.parameters.push(...Object.entries(properties).map(([name, schema]) => ({ in: "query", name, required: required.includes(name), schema })));
  } else {
    entry.requestBody = { required: true, content: { "application/json": { schema: { ...op.params, properties, required } } } };
  }
  success.description = op.result;
  const binary = op.path.includes("/files/remittance/") || op.path.endsWith("/download");
  success.content = binary
    ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
    : { "application/json": { schema: { type: "object", description: op.result } } };
}
