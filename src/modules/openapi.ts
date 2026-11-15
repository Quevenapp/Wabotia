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
  ...serviceOrderSchemas(),
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
    "/profiles/{profile}/capabilities",
    "Capacidades de uma área (mesma resposta, com modules no topo)",
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
  [
    "get",
    "/profiles/{profile}/service-orders",
    "Ordens de serviço: lista com filtro por estado e busca",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/service-orders",
    "Abrir ordem de serviço",
    "conversations:write",
    "ServiceOrderCreate",
  ],
  [
    "get",
    "/profiles/{profile}/service-orders/{id}",
    "Ordem de serviço com histórico",
    "conversations:read",
  ],
  [
    "patch",
    "/profiles/{profile}/service-orders/{id}",
    "Alterar dados da ordem de serviço",
    "conversations:write",
    "ServiceOrderUpdate",
  ],
  [
    "post",
    "/profiles/{profile}/service-orders/{id}/status",
    "Mudar o estado da ordem de serviço",
    "conversations:write",
    "ServiceOrderStatus",
  ],
  [
    "put",
    "/profiles/{profile}/service-orders/{id}/quote",
    "Salvar o orçamento da ordem de serviço",
    "conversations:write",
    "ServiceOrderQuote",
  ],
  [
    "post",
    "/profiles/{profile}/service-orders/{id}/quote/send",
    "Enviar o orçamento ao cliente",
    "conversations:write",
    "ServiceOrderQuoteSend",
  ],
  [
    "post",
    "/profiles/{profile}/service-orders/{id}/decision",
    "Registrar aprovação ou recusa do orçamento",
    "conversations:write",
    "ServiceOrderDecision",
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
  if (path.includes("/service-orders"))
    return describeServiceOrderOperation(path, method, entry, success);
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
  if (path === "/profiles/{profile}/capabilities") {
    entry.description =
      "Igual a GET /capabilities?profile={profile}, com a lista de módulos ligados repetida em modules no topo da resposta. Aceita sessão de pessoa e chave de aplicação (aparelho pareado); 404 se a credencial não alcançar a área.";
    success.content["application/json"].schema = {
      allOf: [
        ref("Capabilities"),
        {
          type: "object",
          properties: {
            modules: { type: "array", items: ref("ModuleSummary") },
          },
        },
      ],
    };
    return;
  }
  if (path === "/capabilities") {
    entry.description =
      "Aceita qualquer credencial válida: sessão de pessoa (cookie ou token wabu_) e chave de aplicação, inclusive a de um aparelho pareado. Lista só as áreas que a credencial alcança; profile=<id> restringe a uma área (404 se não alcançar). Os aplicativos consultam antes de mostrar telas de módulo.";
    entry.parameters.push(
      { in: "query", name: "profile", schema: { type: "string" } },
      {
        in: "query",
        name: "profile_id",
        schema: { type: "string" },
        description: "Sinônimo de profile.",
      },
    );
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

// --- Ordem de Serviço (módulo "os", docs/ORDEM-DE-SERVICO.md) ---------------
function serviceOrderSchemas() {
  const statuses = [
    "received",
    "analyzing",
    "quoted",
    "approved",
    "declined",
    "in_progress",
    "ready",
    "delivered",
    "cancelled",
  ];
  const quoteItem = {
    type: "object",
    required: ["description", "unit_cents"],
    properties: {
      description: { type: "string", minLength: 1, maxLength: 200 },
      quantity: { type: "integer", minimum: 1, maximum: 999, default: 1 },
      unit_cents: {
        type: "integer",
        minimum: 0,
        maximum: 100000000,
        description: "Valor unitário em centavos.",
      },
    },
  };
  return {
    ServiceOrder: {
      type: "object",
      description:
        "Ordem de serviço. Valores em centavos, datas em milissegundos Unix. notes são observações internas (nunca enviadas ao cliente).",
      properties: {
        id: { type: "string" },
        number: {
          type: "integer",
          description: "Sequencial por área de atendimento.",
        },
        status: { enum: statuses },
        status_label: { type: "string", example: "Orçamento enviado" },
        customer: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: {
              type: "string",
              description: "Só dígitos, com DDI.",
              example: "5511999998888",
            },
            contact_id: { type: ["string", "null"] },
            conversation_id: { type: ["string", "null"] },
          },
        },
        item: { type: "string" },
        problem: { type: "string" },
        notes: { type: "string" },
        assignee: { type: ["string", "null"] },
        due_at: { type: ["integer", "null"] },
        source: { enum: ["agent", "panel", "customer", "api"] },
        terms: {
          type: ["object", "null"],
          description: "Termos aceitos pelo cliente na abertura pelo WhatsApp.",
          properties: {
            text: { type: "string" },
            accepted_at: { type: "integer" },
          },
        },
        quote: {
          type: ["object", "null"],
          properties: {
            items: { type: "array", items: quoteItem },
            total_cents: { type: "integer" },
            note: { type: "string" },
            valid_days: { type: ["integer", "null"] },
            valid_until: { type: ["integer", "null"] },
            sent_at: { type: ["integer", "null"] },
            version: {
              type: "integer",
              description:
                "Sobe a cada envio; respostas a versões antigas não valem.",
            },
            expired: { type: "boolean" },
          },
        },
        decision: {
          type: ["object", "null"],
          properties: {
            decision: { enum: ["approved", "declined"] },
            at: { type: "integer" },
            by: {
              type: "string",
              description: "Pessoa, aplicação ou customer:<telefone>.",
            },
            via: { enum: ["whatsapp", "web_step", "panel", "api"] },
          },
        },
        ready_at: { type: ["integer", "null"] },
        delivered_at: { type: ["integer", "null"] },
        warranty_until: { type: ["integer", "null"] },
        next_statuses: {
          type: "array",
          items: { enum: statuses },
          description:
            "Próximos estados possíveis. quoted só por quote/send; approved e declined só por decision.",
        },
        history: {
          type: "array",
          description: "Só no detalhe.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { enum: ["opened", "status", "quote", "edit"] },
              from_status: { type: ["string", "null"] },
              to_status: { type: ["string", "null"] },
              actor: { type: "string" },
              note: { type: "string" },
              created: { type: "integer" },
            },
          },
        },
        created_by: { type: "string" },
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    ServiceOrderCreate: {
      type: "object",
      required: ["item", "problem"],
      description: "Informe conversation_id ou phone.",
      properties: {
        conversation_id: { type: "string" },
        phone: { type: "string", maxLength: 40 },
        customer_name: { type: "string", maxLength: 120 },
        item: { type: "string", minLength: 1, maxLength: 200 },
        problem: { type: "string", minLength: 1, maxLength: 2000 },
        notes: { type: "string", maxLength: 4000 },
        assignee: { type: ["string", "null"] },
        due_at: { type: ["integer", "null"] },
        notify: {
          type: "boolean",
          default: true,
          description: "Avisa o cliente na conversa.",
        },
      },
    },
    ServiceOrderUpdate: {
      type: "object",
      properties: {
        phone: { type: "string", maxLength: 40 },
        customer_name: { type: "string", maxLength: 120 },
        item: { type: "string", minLength: 1, maxLength: 200 },
        problem: { type: "string", minLength: 1, maxLength: 2000 },
        notes: { type: "string", maxLength: 4000 },
        assignee: { type: ["string", "null"] },
        due_at: { type: ["integer", "null"] },
      },
    },
    ServiceOrderStatus: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          enum: ["analyzing", "in_progress", "ready", "delivered", "cancelled"],
        },
        note: { type: "string", maxLength: 500 },
      },
    },
    ServiceOrderQuote: {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", minItems: 1, maxItems: 50, items: quoteItem },
        valid_days: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 90,
          description: "Em branco usa a validade padrão da área.",
        },
        note: { type: "string", maxLength: 600 },
      },
    },
    ServiceOrderQuoteSend: {
      type: "object",
      properties: {
        notify: {
          type: "boolean",
          default: true,
          description:
            "false: só registra o envio (orçamento passado por outro meio).",
        },
      },
    },
    ServiceOrderDecision: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { enum: ["approve", "decline"] },
        note: { type: "string", maxLength: 500 },
      },
    },
  };
}

function describeServiceOrderOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  const ref = { $ref: "#/components/schemas/ServiceOrder" };
  entry.description +=
    " Módulo Ordem de Serviço (os); desligado, 409 module_disabled.";
  if (path.endsWith("/service-orders") && method === "get") {
    entry.description +=
      " Ordena por número decrescente; next_cursor vai em cursor. counts traz o total por estado da área.";
    entry.parameters.push(
      ...[
        "status",
        "open",
        "q",
        "phone",
        "conversation_id",
        "limit",
        "cursor",
      ].map((name) => ({ in: "query", name, schema: { type: "string" } })),
    );
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        data: { type: "array", items: ref },
        next_cursor: { type: ["string", "null"] },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    };
    return;
  }
  if (path.endsWith("/status"))
    entry.description +=
      " Transições: recebida → em análise, em execução ou cancelada; em análise → em execução ou cancelada; orçamento enviado → em análise ou cancelada; aprovada → em execução ou cancelada; recusada → em análise, pronta ou cancelada; em execução → pronta ou cancelada; pronta → entregue, em execução ou cancelada. Outras: 409 invalid_transition. Avisa o cliente com o texto configurado do estado.";
  if (path.endsWith("/quote"))
    entry.description +=
      " Só em recebida, em análise, orçamento enviado ou recusada. Alterar um orçamento já enviado volta a ordem para em análise.";
  if (path.endsWith("/quote/send"))
    entry.description +=
      " Fixa a validade (fim do dia, horário de Brasília), sobe quote.version e muda para quoted. O cliente recebe os itens e responde pelo WhatsApp; fora da janela de 24 h sai pelo modelo de notificação.";
  if (path.endsWith("/decision"))
    entry.description +=
      " Resposta do cliente registrada pela equipe ou integração. 409 quote_expired com o orçamento vencido e 409 quote_not_pending fora de quoted.";
  success.content["application/json"].schema = ref;
}
