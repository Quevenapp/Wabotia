// Trecho do OpenAPI dos módulos embutidos (docs/MODULOS.md).
export const moduleSchemas = {
  ModuleSummary: {
    type: "object",
    required: ["id", "name", "version"],
    properties: {
      id: { type: "string", example: "queue" },
      name: { type: "string", example: "Fila presencial" },
      version: { type: "string", example: "1.0.0" },
    },
  },
  Capabilities: {
    type: "object",
    required: [
      "capabilities_version",
      "server",
      "features",
      "actor",
      "profiles",
    ],
    properties: {
      capabilities_version: { type: "integer", enum: [1] },
      server: {
        type: "object",
        properties: {
          service: { type: "string", enum: ["wabotia"] },
          version: { type: "string", example: "0.20.0" },
          commit: { type: "string" },
        },
      },
      features: {
        type: "array",
        items: { type: "string" },
        description:
          "Recursos do núcleo presentes neste servidor (por exemplo modules e web_steps).",
      },
      actor: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { enum: ["user", "app"] },
          role: { enum: ["admin", "operator", "service"] },
        },
      },
      profiles: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "enabled", "modules"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            modules: {
              type: "array",
              description: "Somente os módulos ligados na área.",
              items: { $ref: "#/components/schemas/ModuleSummary" },
            },
          },
        },
      },
    },
  },
  Module: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
      description: { type: "string" },
      builtin: { type: "boolean" },
      enabled: { type: "boolean" },
      default_enabled: { type: "boolean" },
      navigation: { type: "array", items: { type: "object" } },
      menu_item_types: { type: "array", items: { type: "object" } },
      events: { type: "array", items: { type: "string" } },
      settings: { type: "array", items: { type: "object" } },
      scopes: { type: "array", items: { type: "string" } },
      updated: { type: ["integer", "null"] },
      updated_by: { type: ["string", "null"] },
    },
  },
  ModuleState: {
    type: "object",
    required: ["enabled"],
    properties: { enabled: { type: "boolean" } },
  },
  FormSend: {
    type: "object",
    required: ["conversation_id"],
    properties: { conversation_id: { type: "string" } },
  },
  WebStep: {
    type: "object",
    description:
      "Passo web: link curto de uso único enviado na conversa. O código do link nunca é devolvido pela API.",
    properties: {
      id: { type: "string" },
      conversation_id: { type: "string" },
      module_id: { type: "string", example: "forms" },
      kind: { type: "string", example: "form" },
      ref_id: {
        type: ["string", "null"],
        description: "Ex.: ID do formulário.",
      },
      title: { type: "string" },
      status: {
        enum: ["sent", "opened", "completed", "expired", "cancelled"],
      },
      trigger: { enum: ["menu", "agent", "bot", "module"] },
      actor: { type: "string" },
      expires_at: { type: "integer" },
      opened_at: { type: ["integer", "null"] },
      completed_at: { type: ["integer", "null"] },
      ticket_id: { type: ["string", "null"] },
      contact_id: { type: ["string", "null"] },
      answers: {
        type: ["object", "null"],
        description:
          "Respostas por ID de campo: texto, escolha e data (AAAA-MM-DD) como string; aceite como boolean.",
      },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { enum: ["text", "choice", "date", "accept"] },
            label: { type: "string" },
          },
        },
      },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
};

export const moduleOperations: [string, string, string, string?, string?][] = [
  [
    "get",
    "/capabilities",
    "Versão do servidor e módulos ligados em cada área autorizada",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/modules",
    "Módulos da área e estado ligado/desligado",
    "",
  ],
  [
    "put",
    "/profiles/{profile}/modules/{id}",
    "Ligar ou desligar um módulo na área",
    "",
    "ModuleState",
  ],
  [
    "get",
    "/profiles/{profile}/conversations/{id}/web-steps",
    "Passos web da conversa e estado de cada link",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/web-steps/{id}",
    "Consultar um passo web",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/web-steps/{id}/cancel",
    "Cancelar um link ainda não respondido",
    "conversations:write",
  ],
  [
    "get",
    "/profiles/{profile}/forms",
    "Formulários ativos da área (módulo Formulários)",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/forms/{id}/send",
    "Enviar o link de um formulário numa conversa",
    "conversations:write",
    "FormSend",
  ],
];

export function describeModuleOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  if (!moduleOperations.some(([m, p]) => p === path && m === method)) return;
  entry.tags = ["Módulos"];
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  if (path.includes("web-steps")) {
    entry.description +=
      " O cliente abre o link em /api/w/{código} (página pública, sem autenticação). Estados: sent (enviado), opened (aberto), completed (concluído, com answers), expired (venceu sem resposta) e cancelled. Cada mudança publica web_step.sent, web_step.opened, web_step.completed, web_step.expired ou web_step.cancelled com conversation_id.";
    if (path.endsWith("/cancel"))
      entry.description +=
        " Só cancela links em sent ou opened; os demais retornam 409 web_step_closed.";
    success.content["application/json"].schema = path.endsWith("/web-steps")
      ? {
          type: "object",
          properties: { data: { type: "array", items: ref("WebStep") } },
        }
      : ref("WebStep");
    return;
  }
  if (path.endsWith("/forms/{id}/send")) {
    entry.description +=
      " Mesmo envio da ação form da conversa, como recurso: exige conversa assumida pela credencial (ou administrador) e janela de 24 horas aberta nas linhas oficiais. Responde com o WebStep criado; repetir a Idempotency-Key devolve o mesmo passo. Com o módulo Formulários desligado, 409 module_disabled.";
    success.content["application/json"].schema = ref("WebStep");
    return;
  }
  if (path.endsWith("/forms")) {
    entry.description +=
      ' Lista os formulários ativos com ID, título e campos (sem textos internos). Envie com POST /conversations/{id}/actions e {"action":"form","form_id":"..."}. Com o módulo Formulários desligado, responde 409 module_disabled.';
    return;
  }
  if (path === "/capabilities") {
    entry.description =
      "Aceita qualquer credencial válida: sessão de pessoa (cookie ou token wabu_) e chave de aplicação, inclusive a de um aparelho pareado. Lista só as áreas que a credencial alcança; profile=<id> restringe a uma área (404 se não alcançar). Os aplicativos consultam antes de mostrar telas de módulo.";
    entry.parameters.push({
      in: "query",
      name: "profile",
      schema: { type: "string" },
    });
    success.content["application/json"].schema = ref("Capabilities");
    return;
  }
  if (method === "get") {
    entry.description =
      "Pessoas e aplicações com acesso à área. Sem registro salvo, vale default_enabled.";
    success.content["application/json"].schema = {
      type: "object",
      properties: { data: { type: "array", items: ref("Module") } },
    };
    return;
  }
  entry.description =
    "Exige administrador. Desligado, o módulo some da navegação do painel e do menu do WhatsApp (os itens ficam guardados e voltam ao religar) e suas rotas e operações respondem 409 module_disabled. Publica module.changed quando o estado muda.";
}
