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
