const schemas = {
  Error: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          request_id: { type: "string" },
        },
      },
    },
  },
  Inbound: {
    type: "object",
    required: ["external_id", "message_id", "text"],
    properties: {
      external_id: {
        type: "string",
        description: "Identificador do cliente no namespace desta aplicação.",
      },
      message_id: { type: "string" },
      text: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
    },
  },
  Action: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        enum: [
          "claim",
          "reply",
          "note",
          "transfer",
          "resolve",
          "resume",
          "tags",
        ],
      },
      text: { type: "string" },
      target: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  BotRun: {
    type: "object",
    required: ["profile_id", "bot_id", "input"],
    properties: {
      profile_id: { type: "string" },
      bot_id: { type: "string" },
      input: { type: "string", maxLength: 60000 },
    },
  },
  Ticket: {
    type: "object",
    required: ["conversation_id", "title"],
    properties: {
      conversation_id: { type: "string" },
      title: { type: "string", maxLength: 300 },
    },
  },
  TicketUpdate: {
    type: "object",
    properties: {
      text: { type: "string" },
      status: { enum: ["open", "in_progress", "closed"] },
      owner: { type: "string" },
      response_due_at: {
        type: ["integer", "null"],
        description:
          "Unix em milissegundos; somente antes da primeira resposta.",
      },
    },
  },
  Knowledge: {
    type: "object",
    required: ["title", "kind"],
    properties: {
      title: { type: "string" },
      kind: { enum: ["text", "url", "file", "youtube"] },
      text: { type: "string" },
      url: { type: "string", format: "uri" },
      media_id: { type: "string" },
    },
  },
  Webhook: {
    type: "object",
    required: ["url", "events"],
    properties: {
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
    },
  },
  RunResult: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: {
        enum: [
          "queued",
          "starting",
          "running",
          "cancelling",
          "cancelled",
          "completed",
          "failed",
          "unknown",
        ],
      },
      result: { type: ["string", "null"] },
      attachments: {
        type: "array",
        items: { type: "string" },
        description:
          "IDs de mídias autorizadas, obtidos pela rota de conteúdo do perfil.",
      },
      error: { type: ["string", "null"] },
    },
  },
};
const operations: [string, string, string, string?, string?][] = [
  ["get", "/profiles", "Listar perfis autorizados"],
  ["get", "/profiles/{profile}/bots", "Listar bots", "bots:read"],
  [
    "get",
    "/profiles/{profile}/conversations",
    "Listar conversas",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/conversations",
    "Iniciar conversa",
    "conversations:write",
    "Inbound",
  ],
  [
    "post",
    "/profiles/{profile}/inbound",
    "Receber mensagem do sistema externo",
    "conversations:write",
    "Inbound",
  ],
  [
    "get",
    "/profiles/{profile}/conversations/{id}",
    "Consultar conversa e histórico",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/conversations/{id}/actions",
    "Operar atendimento",
    "conversations:write",
    "Action",
  ],
  [
    "get",
    "/profiles/{profile}/tickets",
    "Consultar protocolos",
    "tickets:read",
  ],
  [
    "post",
    "/profiles/{profile}/tickets",
    "Abrir protocolo",
    "tickets:write",
    "Ticket",
  ],
  [
    "patch",
    "/profiles/{profile}/tickets/{id}",
    "Atualizar protocolo",
    "tickets:write",
    "TicketUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/knowledge",
    "Consultar conhecimento",
    "knowledge:read",
  ],
  [
    "post",
    "/profiles/{profile}/knowledge",
    "Importar fonte",
    "knowledge:write",
    "Knowledge",
  ],
  [
    "delete",
    "/profiles/{profile}/knowledge/{id}",
    "Excluir fonte",
    "knowledge:write",
  ],
  ["get", "/profiles/{profile}/media", "Listar arquivos", "media:read"],
  [
    "post",
    "/profiles/{profile}/media",
    "Enviar arquivo de até 20 MB",
    "media:write",
  ],
  [
    "get",
    "/profiles/{profile}/media/{id}/content",
    "Baixar arquivo autorizado",
    "media:read",
  ],
  ["get", "/profiles/{profile}/reports", "Consultar relatório", "reports:read"],
  [
    "get",
    "/profiles/{profile}/presence",
    "Consultar presença",
    "presence:read",
  ],
  [
    "get",
    "/profiles/{profile}/consents",
    "Consultar consentimentos",
    "conversations:read",
  ],
  ["post", "/bot-runs", "Executar bot autorizado", "bots:invoke", "BotRun"],
  ["get", "/bot-runs/{id}", "Consultar resultado de execução", "bots:invoke"],
  [
    "post",
    "/profiles/{profile}/bot-runs/{id}/cancel",
    "Cancelar execução",
    "bots:invoke",
  ],
  [
    "get",
    "/profiles/{profile}/events",
    "Consultar eventos incrementais",
    "events:read",
  ],
  [
    "get",
    "/profiles/{profile}/webhook-subscriptions",
    "Listar webhooks",
    "webhooks:manage",
  ],
  [
    "post",
    "/profiles/{profile}/webhook-subscriptions",
    "Cadastrar webhook",
    "webhooks:manage",
    "Webhook",
  ],
  [
    "delete",
    "/profiles/{profile}/webhook-subscriptions/{id}",
    "Desativar webhook",
    "webhooks:manage",
  ],
  [
    "get",
    "/profiles/{profile}/webhook-deliveries",
    "Histórico de entregas",
    "webhooks:manage",
  ],
  [
    "post",
    "/profiles/{profile}/webhook-deliveries/{id}/retry",
    "Repetir entrega",
    "webhooks:manage",
  ],
];
export function openapi(origin: string) {
  const paths: any = {};
  for (const [method, path, summary, scope, schema] of operations) {
    const mutation = method !== "get";
    const parameters: any[] = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      in: "path",
      name: m[1],
      required: true,
      schema: { type: "string" },
    }));
    if (mutation)
      parameters.push({
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { type: "string", maxLength: 200 },
      });
    if (path.endsWith("/conversations") && method === "get")
      parameters.push(
        ...["cursor", "state", "q", "limit"].map((name) => ({
          in: "query",
          name,
          schema: { type: "string" },
        })),
      );
    if (path.endsWith("/events"))
      parameters.push({
        in: "query",
        name: "after",
        schema: { type: "integer", default: 0 },
      });
    if (path.endsWith("/reports"))
      parameters.push(
        ...["section", "start", "end", "format", "cursor", "limit"].map(
          (name) => ({
            in: "query",
            name,
            schema: { type: "string" },
          }),
        ),
      );
    const paginated =
      method === "get" &&
      /\/(bots|tickets|knowledge|media|surveys|consents|deliveries|webhook-deliveries|bot-runs)$/.test(
        path,
      );
    if (paginated)
      parameters.push(
        { in: "query", name: "cursor", schema: { type: "string" } },
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
      );
    const entry: any = {
      summary,
      description: scope
        ? `Permissão: ${scope}. Datas no formato Unix em milissegundos.`
        : "Retorna somente perfis autorizados.",
      operationId: method + "_" + path.replace(/[^a-zA-Z]+/g, "_"),
      parameters,
      security: [{ BearerAuth: [] }],
      responses: {
        [path === "/bot-runs" ? "202" : "200"]: {
          description: "Operação aceita ou concluída",
          content: {
            "application/json": {
              schema: path.includes("bot-runs")
                ? { $ref: "#/components/schemas/RunResult" }
                : { type: "object" },
            },
          },
        },
        "400": { description: "Requisição inválida" },
        "401": { description: "Chave inválida ou expirada" },
        "403": { description: "Permissão insuficiente" },
        "409": { description: "Conflito de responsabilidade ou idempotência" },
        "429": { description: "Limite atingido; respeite Retry-After" },
      },
    };
    if (schema)
      entry.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schema}` },
          },
        },
      };
    if (path.endsWith("/media") && method === "post")
      entry.requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: { file: { type: "string", format: "binary" } },
            },
          },
        },
      };
    for (const [status, description] of Object.entries({
      400: "Requisição inválida",
      401: "Chave expirada, revogada ou inválida",
      403: "Permissão insuficiente",
      404: "Recurso ausente ou fora do acesso",
      409: "Conflito de responsabilidade ou idempotência",
      413: "Arquivo acima do limite",
      429: "Limite atingido; respeite Retry-After",
      502: "Serviço externo indisponível",
    })) {
      entry.responses[status] = {
        description,
        headers: {
          "X-Request-Id": { schema: { type: "string" } },
          ...(status === "429"
            ? {
                "Retry-After": {
                  schema: { type: "integer" },
                  description: "Segundos até nova tentativa",
                },
              }
            : {}),
        },
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    }
    const success = entry.responses[path === "/bot-runs" ? "202" : "200"];
    success.headers = {
      "X-Request-Id": { schema: { type: "string" } },
      ...(mutation
        ? {
            "Idempotency-Replayed": {
              schema: { type: "string", enum: ["true"] },
            },
          }
        : {}),
    };
    if (paginated || (path.endsWith("/conversations") && method === "get"))
      success.content["application/json"].schema = {
        type: "object",
        required: ["data", "next_cursor"],
        properties: {
          data: { type: "array", items: { type: "object" } },
          next_cursor: { type: ["string", "null"] },
        },
      };
    if (path.endsWith("/events"))
      success.content["application/json"].schema = {
        type: "object",
        properties: {
          data: { type: "array", items: { type: "object" } },
          cursor: { type: "integer" },
        },
      };
    if (
      method === "get" &&
      [
        "/profiles",
        "/profiles/{profile}/presence",
        "/profiles/{profile}/webhook-subscriptions",
      ].includes(path)
    )
      success.content["application/json"].schema = {
        type: "array",
        items: { type: "object" },
      };
    if (path.endsWith("/content"))
      success.content = {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      };
    if (path.endsWith("/reports"))
      success.content["application/x-ndjson"] = {
        schema: { type: "string" },
        description: "Uma linha JSON por registro; formato por streaming.",
      };
    (paths[path] ??= {})[method] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Wabotia API",
      version: "1.0.0",
      description:
        "Atendimento e bots Hermes. Integrações servidor-servidor cadastradas pelo administrador. Nunca exponha sua chave em JavaScript público. Webhooks são entregues ao menos uma vez; deduplique por ID. Assinatura HMAC-SHA256 sobre timestamp.corpo_original.",
    },
    servers: [{ url: origin + "/api/v1" }],
    components: {
      securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
      schemas,
    },
    paths,
  };
}
