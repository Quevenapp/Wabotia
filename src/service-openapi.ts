const id = { type: "string", minLength: 1 };
const lineIds = { type: "array", maxItems: 200, uniqueItems: true, items: id };
export const serviceSchemas = {
  LineService: {
    type: "object",
    properties: {
      mode: { enum: ["inherit", "human", "bot"] },
      bot_id: { type: ["string", "null"] },
      menu_mode: { enum: ["automatic", "manual", "off"] },
    },
  },
  LineUpdate: {
    type: "object",
    properties: {
      service: { $ref: "#/components/schemas/LineService" },
      number_policy: { $ref: "#/components/schemas/NumberPolicy" },
    },
  },
  ServiceLine: {
    type: "object",
    properties: {
      id,
      name: { type: "string" },
      number: { type: "string" },
      status: { type: "string" },
      kind: { type: "string" },
      service: { $ref: "#/components/schemas/LineService" },
      number_policy: { $ref: "#/components/schemas/NumberPolicy" },
    },
  },
  MenuItem: {
    type: "object",
    required: ["id", "label", "type"],
    properties: {
      id,
      label: { type: "string", minLength: 1, maxLength: 100 },
      type: {
        enum: [
          "human",
          "bot",
          "app",
          "submenu",
          "link",
          "content",
          "protocols",
          "survey",
          "ticket",
        ],
        description:
          "ticket (Abrir protocolo) pergunta a descrição ao cliente e abre um protocolo gratuito, sem mover a conversa para a fila humana. Como protocols e survey, exige permissão de serviço na linha e não existe em grupos.",
      },
      category_id: {
        type: ["string", "null"],
        description:
          "Destino ticket: categoria de ticket_categories gravada no protocolo aberto. Opcional.",
      },
      parent_id: {
        type: ["string", "null"],
        description:
          "ID de um submenu da mesma lista; null coloca a opção no menu principal. Ciclos e pais inexistentes são recusados.",
      },
      bot_id: id,
      app_id: id,
      department_id: {
        type: ["string", "null"],
        description: "Setor humano. Sem setor, encaminha para a fila geral.",
      },
      url: {
        type: "string",
        format: "uri",
        description: "Endereço público HTTPS para destino link.",
      },
      content: {
        type: "string",
        maxLength: 3500,
        description:
          "Mensagem do destino content (obrigatória), texto do link (até 3000) ou pergunta do destino ticket (opcional).",
      },
      question: {
        type: "string",
        maxLength: 300,
        description: "Pergunta opcional da avaliação de 1 a 5.",
      },
      enabled: { type: "boolean" },
      line_ids: {
        ...lineIds,
        description:
          "Vazio permite todas as linhas autorizadas pelos menus ancestrais.",
      },
      trigger: { enum: ["automatic", "manual"], default: "automatic" },
    },
  },
  MenuSettings: {
    type: "object",
    dependentRequired: { menus_revision: ["menus"] },
    properties: {
      menus: {
        type: "array",
        maxItems: 200,
        items: { $ref: "#/components/schemas/MenuItem" },
        description:
          "Lista completa de itens. A posição na lista define a ordem entre irmãos; parent_id define a hierarquia. Preserve os IDs ao reordenar ou mover um ramo e envie menus_revision para detectar conflitos.",
      },
      menus_revision: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description:
          "Opcional: revision retornada pelo GET /menus sem filtro. Ao substituir menus, recusa com 409 menus_changed se outra alteração já foi salva. Não é persistida nas configurações. Clientes antigos podem omitir, sem proteção contra sobrescrita concorrente.",
      },
      departments: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/components/schemas/ServiceDepartment" },
      },
      protocol_response_hours: {
        type: ["number", "null"],
        exclusiveMinimum: 0,
        maximum: 8760,
      },
      protocol_response_unit: {
        enum: ["hours", "business_days"],
        default: "hours",
        description:
          "Como contar o prazo da primeira resposta: horas corridas (protocol_response_hours) ou dias úteis (protocol_response_days e business_hours). Alterar não recalcula protocolos já abertos.",
      },
      protocol_response_days: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        default: 3,
      },
      business_hours: { $ref: "#/components/schemas/BusinessHours" },
      ticket_categories: {
        type: "array",
        maxItems: 50,
        items: { $ref: "#/components/schemas/TicketCategory" },
        description:
          "Categorias de protocolo (aplicativo ou assunto). Remover uma categoria não altera protocolos antigos.",
      },
      menu_greeting: {
        type: "string",
        maxLength: 900,
        description:
          "Texto de abertura do menu principal. Vazio usa “Como podemos ajudar?”. Submenus continuam usando o próprio título.",
      },
      protocol_confirmation: {
        type: "string",
        maxLength: 1500,
        description:
          "Mensagem enviada ao cliente quando um protocolo é aberto para ele. Marcadores {numero}, {assunto}, {aplicativo} e {prazo}; a linha cujo marcador não tem valor é omitida. Vazio restaura o texto padrão.",
      },
      surveys_enabled: { type: "boolean" },
      jev_enabled: { type: "boolean" },
    },
  },
  BusinessHours: {
    type: "object",
    description:
      "Atendimento humano no horário de Brasília (UTC-3). Campos omitidos preservam o valor salvo.",
    properties: {
      days: {
        type: "array",
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
        items: { type: "integer", minimum: 0, maximum: 6 },
        default: [1, 2, 3, 4, 5],
        description: "0 = domingo … 6 = sábado.",
      },
      start: {
        type: "string",
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        default: "09:00",
      },
      end: {
        type: "string",
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        default: "18:00",
      },
      holidays: {
        type: "array",
        maxItems: 100,
        uniqueItems: true,
        items: { type: "string", format: "date" },
        default: [],
      },
    },
  },
  ServiceTemplate: {
    type: "object",
    properties: {
      id,
      name: { type: "string" },
      description: { type: "string" },
      summary: { type: "string", description: "Resumo em uma frase." },
      settings: {
        type: "object",
        description:
          "Conteúdo completo, com as mesmas chaves de PUT /settings: departments, ticket_categories, menus, protocol_response_unit, protocol_response_days, business_hours, instructions e protocol_confirmation. Destinos de bot trazem bot_id null e fallback_content, a mensagem usada quando a área não tem bot.",
      },
      manual_steps: {
        type: "array",
        items: { type: "string" },
        description: "O que o modelo não configura.",
      },
    },
  },
  ServiceTemplateApply: {
    type: "object",
    properties: {
      mode: {
        enum: ["merge", "replace"],
        default: "merge",
        description:
          "merge acrescenta setores, categorias e ramos de menu que ainda não existem (por id) e só grava textos e prazo que ainda estão no padrão. replace substitui menus, setores, categorias, prazo, horário e textos; pessoas já colocadas em um setor do modelo e os feriados são mantidos.",
      },
      bot_id: {
        ...id,
        description:
          "Bot dos destinos de bot. Sem ele: o atendente da área, senão o primeiro bot habilitado; sem bot nenhum, os destinos viram mensagens informativas.",
      },
    },
  },
  ServiceTemplateGroups: {
    type: "object",
    properties: {
      departments: { type: "array", items: id },
      categories: { type: "array", items: id },
      menus: { type: "array", items: id },
      settings: {
        type: "array",
        items: { type: "string" },
        description: "Nomes dos campos de configuração.",
      },
    },
  },
  ServiceTemplateResult: {
    type: "object",
    properties: {
      template_id: id,
      mode: { enum: ["merge", "replace"] },
      bot_id: { type: ["string", "null"] },
      created: { $ref: "#/components/schemas/ServiceTemplateGroups" },
      kept: { $ref: "#/components/schemas/ServiceTemplateGroups" },
      replaced: { $ref: "#/components/schemas/ServiceTemplateGroups" },
      removed: { $ref: "#/components/schemas/ServiceTemplateGroups" },
      skipped: { $ref: "#/components/schemas/ServiceTemplateGroups" },
      pending: {
        type: "array",
        description: "O que ainda precisa de ação do administrador.",
        items: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            department_id: { type: "string" },
            bot_id: { type: "string" },
          },
        },
      },
    },
  },
  ServiceDepartment: {
    type: "object",
    required: ["id", "name", "members"],
    properties: {
      id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
      name: { type: "string", minLength: 1, maxLength: 100 },
      members: { type: "array", maxItems: 100, uniqueItems: true, items: id },
      enabled: { type: "boolean", default: true },
    },
  },
  BotLineUpdate: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      line_ids: {
        ...lineIds,
        type: ["array", "null"],
        description:
          "null: todas as linhas; []: somente interno; lista: linhas autorizadas. As demais permissões também são aplicadas.",
      },
    },
  },
  TeamContact: {
    type: "object",
    properties: {
      id: { ...id, description: "ID de pessoa ou bot:<id>." },
      kind: { enum: ["user", "bot"] },
      name: { type: "string" },
      online: { type: "boolean" },
      bot_id: id,
    },
  },
  InternalChatCreate: {
    type: "object",
    required: ["peer_id"],
    properties: {
      peer_id: { ...id, description: "Outro contato retornado por GET /team." },
    },
  },
  InternalMessageCreate: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 60000 } },
  },
  InternalMessage: {
    type: "object",
    properties: {
      id,
      author: id,
      text: { type: "string" },
      created: { type: "integer" },
      status: { type: "string" },
      run_id: { type: ["string", "null"] },
    },
  },
  InternalChat: {
    type: "object",
    properties: {
      id,
      updated: { type: "integer" },
      peer: { $ref: "#/components/schemas/TeamContact" },
      messages: {
        type: "array",
        maxItems: 500,
        items: { $ref: "#/components/schemas/InternalMessage" },
      },
    },
  },
};
export const serviceOperations: [string, string, string, string?, string?][] = [
  [
    "get",
    "/profiles/{profile}/lines",
    "Linhas e responsáveis pelo atendimento",
    "conversations:read",
  ],
  [
    "put",
    "/profiles/{profile}/lines/{id}",
    "Configurar atendimento de uma linha (administrador)",
    "conversations:write",
    "LineUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/menus",
    "Menus e submenus da área de atendimento",
    "conversations:read",
  ],
  [
    "put",
    "/profiles/{profile}/settings",
    "Atualizar menus e configurações (administrador)",
    undefined,
    "MenuSettings",
  ],
  ["get", "/service-templates", "Modelos de central de atendimento"],
  [
    "post",
    "/profiles/{profile}/service-templates/{id}/apply",
    "Aplicar um modelo de central (administrador)",
    undefined,
    "ServiceTemplateApply",
  ],
  [
    "patch",
    "/profiles/{profile}/bots/{id}",
    "Habilitação e linhas de um bot (administrador)",
    undefined,
    "BotLineUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/team",
    "Contatos internos e disponibilidade",
    "presence:read",
  ],
  [
    "get",
    "/profiles/{profile}/internal-chats",
    "Histórico interno do usuário autenticado",
    "presence:read",
  ],
  [
    "post",
    "/profiles/{profile}/internal-chats",
    "Abrir conversa interna com pessoa ou bot",
    "presence:read",
    "InternalChatCreate",
  ],
  [
    "get",
    "/profiles/{profile}/internal-chats/{id}",
    "Últimas mensagens de uma conversa interna",
    "presence:read",
  ],
  [
    "post",
    "/profiles/{profile}/internal-chats/{id}/messages",
    "Enviar mensagem interna (não usa WhatsApp)",
    "presence:read",
    "InternalMessageCreate",
  ],
];
export function describeServiceOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  if (!serviceOperations.some(([m, p]) => p === path && m === method)) return;
  entry.tags = ["Linhas e equipe"];
  if (path.includes("/service-templates")) {
    const apply = method === "post";
    entry.description = apply
      ? "Exige administrador com sessão de pessoa. Preenche menus, setores, categorias, prazo e textos de uma vez, pela mesma validação de PUT /settings. Conversas e protocolos existentes não são tocados. A resposta resume o que foi criado, mantido, substituído ou removido e lista em pending o que ainda precisa de ação manual. Modelo desconhecido retorna 404."
      : "Exige sessão de pessoa (cookie ou token wabu_); chaves de aplicação recebem 403. Lista os modelos com o conteúdo completo para pré-visualização.";
    success.content["application/json"].schema = apply
      ? { $ref: "#/components/schemas/ServiceTemplateResult" }
      : {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/ServiceTemplate" },
            },
          },
        };
    return;
  }
  if (!path.endsWith("/menus"))
    entry.description +=
      " Exige sessão de pessoa (cookie ou token wabu_). Conversas internas são visíveis apenas aos participantes, inclusive para administradores.";
  if (
    path.endsWith("/settings") ||
    path.endsWith("/bots/{id}") ||
    (path.includes("/lines/") && method === "put")
  )
    entry.description +=
      " Exige administrador. Campos omitidos preservam a configuração atual.";
  if (path.endsWith("/menus"))
    entry.parameters.push({
      name: "connection_id",
      in: "query",
      required: false,
      schema: id,
      description: "Filtra pelas linhas do menu e de seus ancestrais.",
    });
  const list =
    method === "get" &&
    ["/lines", "/menus", "/team", "/internal-chats"].some((suffix) =>
      path.endsWith(suffix),
    );
  const model = path.includes("/lines")
    ? "ServiceLine"
    : path.endsWith("/menus")
      ? "MenuItem"
      : path.endsWith("/team")
        ? "TeamContact"
        : path.endsWith("/messages")
          ? "InternalMessage"
          : path.includes("/internal-chats")
            ? "InternalChat"
            : null;
  if (model)
    success.content["application/json"].schema = list
      ? {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: `#/components/schemas/${model}` },
            },
          },
        }
      : { $ref: `#/components/schemas/${model}` };
  if (path.endsWith("/menus") && method === "get") {
    entry.description +=
      " Sem connection_id, retorna a lista completa para edição, inclusive submenus vazios. A revision representa a lista inteira, mesmo quando a consulta é filtrada. O atendimento omite ramos sem opções executáveis na linha e modo atuais.";
    success.content["application/json"].schema.properties.revision = {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      description:
        "Use como menus_revision ao salvar a lista completa de menus.",
    };
  }
  if (path.endsWith("/settings") && method === "put")
    entry.description +=
      " Envie apenas campos alterados. Para menus, envie a lista completa e menus_revision obtida em GET /menus sem filtro. Conflito retorna 409 menus_changed sem alterar a configuração; recarregue e revise antes de salvar novamente.";
}
