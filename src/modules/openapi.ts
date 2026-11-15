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
  PaymentAccountInput: {
    type: "object",
    properties: {
      provider: { enum: ["mercadopago"] },
      access_token: {
        type: "string",
        writeOnly: true,
        description: "Access Token de produção. Omitido, mantém o guardado.",
      },
      webhook_secret: {
        type: "string",
        writeOnly: true,
        description:
          "Assinatura secreta do webhook. Omitida, mantém a guardada.",
      },
      payer_email: { type: "string", format: "email" },
      enabled: { type: "boolean" },
    },
  },
  Payment: {
    type: "object",
    properties: {
      id: { type: "string" },
      conversation_id: { type: "string" },
      provider: { type: "string", example: "mercadopago" },
      method: { enum: ["pix", "link"] },
      module_id: { type: ["string", "null"] },
      ref_id: { type: ["string", "null"] },
      description: { type: "string" },
      amount_cents: { type: "integer" },
      currency: { type: "string", example: "BRL" },
      status: { enum: ["created", "paid", "expired", "cancelled", "refunded"] },
      provider_status: { type: ["string", "null"] },
      pix_code: { type: ["string", "null"], description: "Pix copia e cola." },
      url: {
        type: ["string", "null"],
        description: "Página de pagamento do provedor.",
      },
      trigger: { enum: ["agent", "bot", "module", "menu"] },
      expires_at: { type: "integer" },
      paid_at: { type: ["integer", "null"] },
      created: { type: "integer" },
    },
  },
  FormSend: {
    type: "object",
    required: ["conversation_id"],
    properties: { conversation_id: { type: "string" } },
  },
  ...mensalidadeSchemas(),
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
    "get",
    "/profiles/{profile}/payments/account",
    "Conta de pagamento da área (sem segredos)",
    "",
  ],
  [
    "put",
    "/profiles/{profile}/payments/account",
    "Configurar a conta do Mercado Pago da área",
    "",
    "PaymentAccountInput",
  ],
  [
    "get",
    "/profiles/{profile}/payments/account/check",
    "Conferir as credenciais no provedor",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/payments",
    "Cobranças de uma conversa (conversation_id)",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/payments/{id}",
    "Consultar uma cobrança (com o QR do Pix)",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/payments/{id}/cancel",
    "Cancelar uma cobrança aberta",
    "conversations:write",
  ],
  [
    "post",
    "/profiles/{profile}/forms/{id}/send",
    "Enviar o link de um formulário numa conversa",
    "conversations:write",
    "FormSend",
  ],
  ...mensalidadeOperations(),
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
  if (path.includes("/mensalidade/"))
    return describeMensalidadeOperation(path, method, entry, success);
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
  if (path.includes("/payments")) {
    if (path.includes("/account"))
      entry.description =
        "Exige administrador. Credenciais ficam cifradas e nunca voltam nas leituras (access_token_set e webhook_secret_set dizem se estão guardadas). webhook_url é o endereço a cadastrar no Mercado Pago. Veja docs/COBRANCA.md.";
    else {
      entry.description +=
        ' Estados: created, paid, expired, cancelled e refunded. Só o webhook assinado do provedor, seguido da consulta do pagamento na API, marca paid ou refunded; mensagens do cliente nunca mudam o estado. Cada mudança publica payment.<estado> com conversation_id. Para cobrar, use POST /conversations/{id}/actions com {"action":"charge","method":"pix|link","amount_cents":1250,"description":"…"} (conversa assumida).';
      if (path.endsWith("/payments"))
        entry.parameters.push({
          in: "query",
          name: "conversation_id",
          required: true,
          schema: { type: "string" },
        });
      success.content["application/json"].schema = path.endsWith("/payments")
        ? {
            type: "object",
            properties: { data: { type: "array", items: ref("Payment") } },
          }
        : ref("Payment");
    }
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

// --- Mensalidade (módulo "mensalidade", docs/MENSALIDADE.md) ----------------
function mensalidadeOperations(): [string, string, string, string?, string?][] {
  const base = "/profiles/{profile}/mensalidade";
  return [
    ["get", `${base}/plans`, "Mensalidade: planos", "conversations:read"],
    [
      "post",
      `${base}/plans`,
      "Mensalidade: criar plano",
      "conversations:write",
      "MensalidadePlanInput",
    ],
    [
      "patch",
      `${base}/plans/{id}`,
      "Mensalidade: alterar plano",
      "conversations:write",
      "MensalidadePlanInput",
    ],
    [
      "delete",
      `${base}/plans/{id}`,
      "Mensalidade: excluir plano sem assinaturas",
      "conversations:write",
    ],
    [
      "get",
      `${base}/subscriptions`,
      "Mensalidade: assinaturas com filtro e busca",
      "conversations:read",
    ],
    [
      "post",
      `${base}/subscriptions`,
      "Mensalidade: criar assinatura",
      "conversations:write",
      "MensalidadeSubscriptionInput",
    ],
    [
      "post",
      `${base}/subscriptions/import`,
      "Mensalidade: importar vários clientes",
      "conversations:write",
      "MensalidadeImport",
    ],
    [
      "get",
      `${base}/subscriptions/{id}`,
      "Mensalidade: assinatura com parcelas",
      "conversations:read",
    ],
    [
      "patch",
      `${base}/subscriptions/{id}`,
      "Mensalidade: alterar assinatura",
      "conversations:write",
      "MensalidadeSubscriptionInput",
    ],
    [
      "post",
      `${base}/subscriptions/{id}/pause`,
      "Mensalidade: pausar assinatura",
      "conversations:write",
    ],
    [
      "post",
      `${base}/subscriptions/{id}/resume`,
      "Mensalidade: retomar assinatura",
      "conversations:write",
    ],
    [
      "post",
      `${base}/subscriptions/{id}/end`,
      "Mensalidade: encerrar assinatura",
      "conversations:write",
    ],
    [
      "get",
      `${base}/installments`,
      "Mensalidade: parcelas por mês e estado",
      "conversations:read",
    ],
    [
      "get",
      `${base}/installments/{id}`,
      "Mensalidade: uma parcela",
      "conversations:read",
    ],
    [
      "post",
      `${base}/installments/{id}/charge`,
      "Mensalidade: reenviar a cobrança da parcela",
      "conversations:write",
    ],
    [
      "post",
      `${base}/installments/{id}/pay`,
      "Mensalidade: baixa manual",
      "conversations:write",
      "MensalidadePay",
    ],
    [
      "post",
      `${base}/installments/{id}/waive`,
      "Mensalidade: isentar parcela",
      "conversations:write",
      "MensalidadeWaive",
    ],
    [
      "get",
      `${base}/summary`,
      "Mensalidade: resumo do mês",
      "conversations:read",
    ],
    [
      "get",
      `${base}/delinquents`,
      "Mensalidade: inadimplentes",
      "conversations:read",
    ],
    [
      "post",
      `${base}/generate`,
      "Mensalidade: gerar parcelas agora",
      "conversations:write",
    ],
  ];
}

function mensalidadeSchemas() {
  const period = {
    enum: ["monthly", "quarterly", "yearly"],
    description: "Mensal, trimestral ou anual.",
  };
  const dueDay = {
    type: "integer",
    minimum: 1,
    maximum: 31,
    description: "Dia de vencimento; no mês curto vale o último dia.",
  };
  const date = { type: "string", format: "date", example: "2026-12-10" };
  const nullableDate = { type: ["string", "null"], format: "date" };
  const centsField = (description: string) => ({
    type: "integer",
    minimum: 0,
    maximum: 10000000,
    description: description + " Em centavos (inteiro).",
  });
  return {
    MensalidadePlan: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        amount_cents: centsField("Valor por período."),
        period,
        period_label: { type: "string", example: "Mensal" },
        due_day: dueDay,
        active: { type: "boolean" },
        subscriptions: {
          type: "integer",
          description: "Assinaturas ativas ou pausadas (só na lista).",
        },
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    MensalidadePlanInput: {
      type: "object",
      required: ["name", "amount_cents"],
      description: "No PATCH, todos os campos são opcionais.",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        amount_cents: { type: "integer", minimum: 1, maximum: 10000000 },
        period: { ...period, default: "monthly" },
        due_day: { ...dueDay, default: 10 },
        active: { type: "boolean" },
      },
    },
    MensalidadeSubscription: {
      type: "object",
      properties: {
        id: { type: "string" },
        plan_id: { type: "string" },
        plan_name: { type: ["string", "null"] },
        customer: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: {
              type: "string",
              description: "Só dígitos, com DDI.",
              example: "5511987650001",
            },
            contact_id: { type: ["string", "null"] },
            conversation_id: {
              type: ["string", "null"],
              description:
                "Conversa usada para avisar e cobrar; preenchida quando o cliente escreve ou é encontrada pelo telefone.",
            },
          },
        },
        period,
        period_label: { type: "string" },
        amount_cents: centsField("Valor sem desconto."),
        discount_cents: centsField("Desconto."),
        charge_cents: centsField("Valor de cada parcela."),
        due_day: dueDay,
        start_date: date,
        end_date: nullableDate,
        status: { enum: ["active", "paused", "ended"] },
        status_label: { type: "string", example: "Ativa" },
        notes: { type: "string" },
        paused_at: { type: ["integer", "null"] },
        ended_at: { type: ["integer", "null"] },
        open_count: { type: "integer", description: "Só na lista." },
        overdue_count: { type: "integer", description: "Só na lista." },
        overdue_cents: { type: "integer", description: "Só na lista." },
        installments: {
          type: "array",
          description: "Só no detalhe (até 120, mais recentes primeiro).",
          items: { $ref: "#/components/schemas/MensalidadeInstallment" },
        },
        created_by: { type: "string" },
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    MensalidadeSubscriptionInput: {
      type: "object",
      required: ["plan_id"],
      description:
        "Informe conversation_id ou phone (e customer_name). Valor, dia e periodicidade vêm do plano quando omitidos. No PATCH, todos os campos são opcionais; start_date e conversation_id não mudam.",
      properties: {
        plan_id: { type: "string" },
        conversation_id: { type: "string" },
        customer_name: { type: "string", maxLength: 120 },
        phone: { type: "string", maxLength: 40 },
        amount_cents: { type: "integer", minimum: 1, maximum: 10000000 },
        discount_cents: { type: "integer", minimum: 0, maximum: 10000000 },
        due_day: dueDay,
        start_date: { ...date, description: "Padrão: hoje (Brasília)." },
        end_date: nullableDate,
        notes: { type: "string", maxLength: 1000 },
      },
    },
    MensalidadeImport: {
      type: "object",
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 300,
          items: {
            type: "object",
            required: ["phone"],
            properties: {
              customer_name: { type: "string" },
              phone: { type: "string" },
              plan_id: { type: "string" },
              plan: {
                type: "string",
                description: "Nome do plano (sem acento e caixa).",
              },
              amount_cents: { type: "integer" },
              discount_cents: { type: "integer" },
              due_day: dueDay,
              start_date: date,
              notes: { type: "string" },
            },
          },
        },
      },
    },
    MensalidadeInstallment: {
      type: "object",
      description:
        "Parcela de uma competência (period_key AAAA-MM). Datas de vencimento AAAA-MM-DD no horário de Brasília; instantes em milissegundos.",
      properties: {
        id: { type: "string" },
        subscription_id: { type: "string" },
        period_key: { type: "string", example: "2026-11" },
        period_label: { type: "string", example: "nov/2026" },
        due_date: date,
        amount_cents: centsField("Valor da parcela."),
        status: { enum: ["open", "paid", "overdue", "cancelled", "waived"] },
        status_label: { type: "string", example: "Vencida" },
        customer: {
          type: "object",
          description: "Na lista e no detalhe da parcela.",
          properties: { name: { type: "string" }, phone: { type: "string" } },
        },
        plan_name: { type: ["string", "null"] },
        payment: {
          type: ["object", "null"],
          description: "Cobrança em uso (módulo Cobrança).",
          properties: {
            id: { type: "string" },
            status: {
              enum: ["created", "paid", "expired", "cancelled", "refunded"],
            },
            expires_at: { type: ["integer", "null"] },
            pix_code: {
              type: ["string", "null"],
              description: "Pix copia e cola.",
            },
            url: { type: ["string", "null"] },
            charged_at: { type: ["integer", "null"] },
          },
        },
        notices: {
          type: "object",
          properties: {
            before_at: { type: ["integer", "null"] },
            due_at: { type: ["integer", "null"] },
            overdue: {
              type: "integer",
              description: "Avisos de atraso enviados.",
            },
            overdue_at: { type: ["integer", "null"] },
            error: {
              type: ["string", "null"],
              description: "Último motivo de aviso ou cobrança que não saiu.",
            },
          },
        },
        paid_at: { type: ["integer", "null"] },
        paid_via: { enum: ["pix", "link", "manual", null] },
        paid_by: {
          type: ["string", "null"],
          description:
            "provider (webhook) ou a pessoa/aplicação que deu baixa.",
        },
        paid_note: { type: "string" },
        waived_at: { type: ["integer", "null"] },
        waived_by: { type: ["string", "null"] },
        cancelled_at: { type: ["integer", "null"] },
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    MensalidadePay: {
      type: "object",
      properties: {
        note: { type: "string", maxLength: 300 },
        paid_at: {
          description:
            "AAAA-MM-DD ou milissegundos; padrão agora. Não pode ser futura.",
          oneOf: [{ type: "string", format: "date" }, { type: "integer" }],
        },
        notify: {
          type: "boolean",
          default: true,
          description: "Envia o comprovante ao cliente pelo WhatsApp.",
        },
      },
    },
    MensalidadeWaive: {
      type: "object",
      properties: { note: { type: "string", maxLength: 300 } },
    },
    MensalidadeSummary: {
      type: "object",
      properties: {
        month: { type: "string", example: "2026-11" },
        expected_cents: {
          type: "integer",
          description: "Abertas + pagas + vencidas da competência.",
        },
        received_cents: { type: "integer" },
        overdue_cents: { type: "integer" },
        open_cents: { type: "integer" },
        waived_cents: { type: "integer" },
        counts: { type: "object", additionalProperties: { type: "integer" } },
        received_in_month: {
          type: "object",
          description:
            "Pagas dentro do mês pela data do pagamento, de qualquer competência.",
          properties: {
            count: { type: "integer" },
            cents: { type: "integer" },
          },
        },
        overdue_total: {
          type: "object",
          description: "Todas as vencidas da área, de qualquer mês.",
          properties: {
            count: { type: "integer" },
            cents: { type: "integer" },
            subscriptions: { type: "integer" },
          },
        },
        payments_ready: {
          type: "boolean",
          description:
            "Cobrança ligada e com conta configurada. false: avisos sem Pix e baixa manual.",
        },
      },
    },
  };
}

function describeMensalidadeOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const list = (name: string, extra: Record<string, any> = {}) => ({
    type: "object",
    properties: {
      data: { type: "array", items: ref(name) },
      ...extra,
    },
  });
  const query = (...names: string[]) =>
    entry.parameters.push(
      ...names.map((name) => ({
        in: "query",
        name,
        schema: { type: "string" },
      })),
    );
  entry.description +=
    " Módulo Mensalidade (mensalidade); desligado, 409 module_disabled.";
  const adminOnly =
    /\/plans/.test(path) && method !== "get"
      ? true
      : /\/(import|pause|resume|end|pay|waive)$|\/generate$/.test(path);
  if (adminOnly)
    entry.description +=
      " Pessoas: só administradores (403 admin_required). Aplicações: com conversations:write.";
  if (path.endsWith("/plans")) {
    if (method === "get")
      success.content["application/json"].schema = list("MensalidadePlan");
    else success.content["application/json"].schema = ref("MensalidadePlan");
    return;
  }
  if (path.endsWith("/plans/{id}")) {
    if (method === "delete")
      entry.description +=
        " Com assinaturas: 409 plan_in_use (desative com active=false).";
    else {
      entry.description +=
        " Não muda assinaturas existentes (valor e periodicidade copiados na criação).";
      success.content["application/json"].schema = ref("MensalidadePlan");
    }
    return;
  }
  if (path.endsWith("/subscriptions") && method === "get") {
    query(
      "status",
      "plan_id",
      "q",
      "phone",
      "conversation_id",
      "limit",
      "cursor",
    );
    entry.description +=
      " status=active,paused,ended; counts por estado da área.";
    success.content["application/json"].schema = list(
      "MensalidadeSubscription",
      {
        next_cursor: { type: ["string", "null"] },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    );
    return;
  }
  if (path.endsWith("/subscriptions/import")) {
    entry.description +=
      " Linhas com erro voltam em errors (line começa em 1) sem impedir as outras; telefone com assinatura não encerrada no mesmo plano vai para skipped.";
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        created: { type: "array", items: ref("MensalidadeSubscription") },
        skipped: { type: "array", items: { type: "object" } },
        errors: { type: "array", items: { type: "object" } },
      },
    };
    return;
  }
  if (/\/subscriptions\/\{id\}\/(pause|resume|end)$/.test(path)) {
    entry.description +=
      " Pausar e encerrar cancelam as parcelas abertas que ainda não venceram (as vencidas continuam devidas); retomar volta a gerar a partir de hoje, sem cobrar a pausa. Transição inválida: 409 invalid_transition.";
    success.content["application/json"].schema = ref("MensalidadeSubscription");
    return;
  }
  if (path.includes("/subscriptions")) {
    success.content["application/json"].schema = ref("MensalidadeSubscription");
    return;
  }
  if (path.endsWith("/installments")) {
    query("month", "status", "subscription_id", "q", "limit", "cursor");
    entry.description +=
      " month=AAAA-MM (competência; padrão o mês atual em Brasília, dispensado com subscription_id); status=open,overdue,paid,waived,cancelled. counts por estado do mês.";
    success.content["application/json"].schema = list(
      "MensalidadeInstallment",
      {
        month: { type: ["string", "null"] },
        next_cursor: { type: ["string", "null"] },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    );
    return;
  }
  if (path.endsWith("/charge"))
    entry.description +=
      " Reenvia o Pix ou link que ainda vale (mensagem do módulo) ou cria outra cobrança (o núcleo entrega). 409 no_conversation sem conversa para o telefone, 409 payments_not_configured sem Cobrança, 409 installment_not_payable fora de open/overdue.";
  if (path.endsWith("/pay"))
    entry.description +=
      " Baixa manual (dinheiro, transferência): registra paid_by e paid_note e, com notify, envia o comprovante. Fora de open/overdue: 409 installment_not_payable. A parcela também fica paga sozinha pelo webhook do provedor; nunca por mensagem do cliente.";
  if (path.endsWith("/waive"))
    entry.description += " Isenta parcela aberta, vencida ou cancelada.";
  if (path.endsWith("/summary")) {
    query("month");
    success.content["application/json"].schema = ref("MensalidadeSummary");
    return;
  }
  if (path.endsWith("/delinquents")) {
    entry.description +=
      " Assinaturas com parcelas vencidas: overdue_count, overdue_cents, oldest_due_date e notices_sent.";
    return;
  }
  if (path.endsWith("/generate")) {
    entry.description +=
      " Faz agora a geração do gancho periódico (sem avisos): {created, overdue}.";
    return;
  }
  success.content["application/json"].schema = ref("MensalidadeInstallment");
}
