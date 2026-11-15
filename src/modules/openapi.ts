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
  // Agenda (módulo "agenda", docs/AGENDA.md).
  AgendaService: {
    type: "object",
    required: ["name", "duration_minutes"],
    properties: {
      id: { type: "string", readOnly: true },
      name: { type: "string", maxLength: 80 },
      description: { type: "string", maxLength: 300 },
      duration_minutes: {
        type: "integer",
        minimum: 5,
        maximum: 720,
        multipleOf: 5,
      },
      price_cents: {
        type: ["integer", "null"],
        minimum: 0,
        description: "Preço em centavos; null não mostra preço.",
      },
      active: { type: "boolean" },
      position: { type: "integer", minimum: 0, maximum: 9999 },
    },
  },
  AgendaProfessional: {
    type: "object",
    required: ["name"],
    properties: {
      id: { type: "string", readOnly: true },
      name: { type: "string", maxLength: 80 },
      user_id: {
        type: ["string", "null"],
        description: "Pessoa da equipe com acesso à área.",
      },
      active: { type: "boolean" },
      position: { type: "integer" },
      service_ids: { type: "array", items: { type: "string" } },
      hours: {
        type: "array",
        maxItems: 28,
        description:
          "Intervalos de trabalho no horário de Brasília, sem sobreposição no mesmo dia. Enviado, substitui todos.",
        items: {
          type: "object",
          required: ["weekday", "start", "end"],
          properties: {
            weekday: {
              type: "integer",
              minimum: 0,
              maximum: 6,
              description: "0 = domingo.",
            },
            start: { type: "string", example: "09:00" },
            end: {
              type: "string",
              example: "18:00",
              description: "Até 24:00.",
            },
          },
        },
      },
    },
  },
  AgendaBlock: {
    type: "object",
    description:
      "Folga ou bloqueio: {starts, ends} em ms, ou {date, until?} para dias inteiros de Brasília, ou {date, start, end} para um horário do dia.",
    properties: {
      id: { type: "string", readOnly: true },
      professional_id: {
        type: ["string", "null"],
        description: "null: vale para todos.",
      },
      starts: { type: "integer" },
      ends: { type: "integer" },
      date: { type: "string", format: "date", writeOnly: true },
      until: { type: "string", format: "date", writeOnly: true },
      start: { type: "string", example: "12:00", writeOnly: true },
      end: { type: "string", example: "13:00", writeOnly: true },
      reason: { type: "string", maxLength: 120 },
    },
  },
  AgendaAppointment: {
    type: "object",
    properties: {
      id: { type: "string" },
      service_id: { type: "string" },
      service_name: { type: "string" },
      professional_id: { type: "string" },
      professional_name: { type: "string" },
      starts: { type: "integer" },
      ends: { type: "integer" },
      date: { type: "string", format: "date", description: "Dia de Brasília." },
      time: {
        type: "string",
        example: "09:30",
        description: "Hora de Brasília.",
      },
      status: { enum: ["booked", "confirmed", "cancelled", "no_show"] },
      conversation_id: { type: ["string", "null"] },
      contact_id: { type: ["string", "null"] },
      customer_name: { type: "string" },
      customer_phone: { type: "string" },
      notes: { type: "string" },
      source: { enum: ["whatsapp", "panel", "api"] },
      price_cents: { type: ["integer", "null"] },
      booked_at: { type: "integer" },
      reminded_at: { type: ["integer", "null"] },
      confirmed_at: { type: ["integer", "null"] },
      cancelled_at: { type: ["integer", "null"] },
      cancelled_by: { type: ["string", "null"] },
      cancel_reason: { type: "string" },
      no_show_at: { type: ["integer", "null"] },
      moves: { type: "integer" },
      created_by: { type: "string" },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  AgendaBook: {
    type: "object",
    required: ["service_id", "starts"],
    properties: {
      service_id: { type: "string" },
      professional_id: {
        type: ["string", "null"],
        description:
          "null ou any: qualquer profissional livre (o de menos agendamentos no dia).",
      },
      starts: {
        type: "integer",
        description:
          "Início em ms; um dos slots de /agenda/availability, salvo com force.",
      },
      conversation_id: {
        type: "string",
        description:
          "Liga o cliente da conversa (nome, telefone, contato, confirmação e lembrete).",
      },
      customer_name: {
        type: "string",
        maxLength: 120,
        description: "Obrigatório sem conversation_id.",
      },
      customer_phone: { type: "string" },
      notes: { type: "string", maxLength: 1000 },
      force: {
        type: "boolean",
        description:
          "Encaixe fora do horário de trabalho ou sobre bloqueio; exige professional_id e nunca sobrepõe outro agendamento.",
      },
      notify: {
        type: "boolean",
        description: "false não avisa o cliente da conversa.",
      },
    },
  },
  AgendaMove: {
    type: "object",
    required: ["starts"],
    properties: {
      starts: { type: "integer" },
      professional_id: {
        type: ["string", "null"],
        description: "Ausente: o mesmo; null: qualquer um livre.",
      },
      force: { type: "boolean" },
      notify: { type: "boolean" },
    },
  },
  AgendaCancel: {
    type: "object",
    properties: {
      reason: { type: "string", maxLength: 300 },
      notify: { type: "boolean" },
    },
  },
  Establishment: {
    type: "object",
    required: [
      "name",
      "document",
      "document_type",
      "document_display",
      "address",
      "phone",
      "footer",
      "configured",
    ],
    properties: {
      name: {
        type: "string",
        maxLength: 100,
        description: "Nome fantasia; sem cadastro, o nome da área.",
      },
      document: {
        type: "string",
        description:
          "CPF (11 dígitos) ou CNPJ (14 caracteres, alfanumérico desde 2026), sem pontuação; vazio se não informado.",
      },
      document_type: { type: "string", enum: ["cpf", "cnpj"], nullable: true },
      document_display: {
        type: "string",
        description: "Documento com pontuação, pronto para imprimir.",
      },
      address: { type: "string", maxLength: 300 },
      phone: { type: "string", maxLength: 40 },
      footer: {
        type: "string",
        maxLength: 500,
        description: "Texto livre do rodapé (pode ter quebras de linha).",
      },
      configured: {
        type: "boolean",
        description: "Falso enquanto nenhum campo foi preenchido.",
      },
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
    "/profiles/{profile}/establishment",
    "Dados do estabelecimento da área (cupom, comanda, recibo)",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/people",
    "Pessoas da área (id, nome, papel) para escolher responsável",
    "conversations:read",
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
  // Agenda (módulo "agenda").
  [
    "get",
    "/profiles/{profile}/agenda",
    "Agenda: configuração, serviços e profissionais",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/services",
    "Agenda: serviços",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/services",
    "Agenda: criar serviço",
    "",
    "AgendaService",
  ],
  [
    "put",
    "/profiles/{profile}/agenda/services/{id}",
    "Agenda: alterar serviço",
    "",
    "AgendaService",
  ],
  [
    "delete",
    "/profiles/{profile}/agenda/services/{id}",
    "Agenda: excluir serviço",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/professionals",
    "Agenda: profissionais com serviços e horário",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/professionals",
    "Agenda: criar profissional",
    "",
    "AgendaProfessional",
  ],
  [
    "put",
    "/profiles/{profile}/agenda/professionals/{id}",
    "Agenda: alterar profissional",
    "",
    "AgendaProfessional",
  ],
  [
    "delete",
    "/profiles/{profile}/agenda/professionals/{id}",
    "Agenda: excluir profissional",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/blocks",
    "Agenda: folgas e bloqueios no período",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/blocks",
    "Agenda: criar folga ou bloqueio",
    "",
    "AgendaBlock",
  ],
  [
    "delete",
    "/profiles/{profile}/agenda/blocks/{id}",
    "Agenda: remover folga ou bloqueio",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/availability",
    "Agenda: horários livres por dia",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/appointments",
    "Agenda: agendamentos no período",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/agenda/appointments/{id}",
    "Agenda: consultar agendamento",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/appointments",
    "Agenda: agendar",
    "conversations:write",
    "AgendaBook",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/appointments/{id}/move",
    "Agenda: remarcar",
    "conversations:write",
    "AgendaMove",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/appointments/{id}/cancel",
    "Agenda: cancelar",
    "conversations:write",
    "AgendaCancel",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/appointments/{id}/confirm",
    "Agenda: confirmar presença",
    "conversations:write",
  ],
  [
    "post",
    "/profiles/{profile}/agenda/appointments/{id}/no-show",
    "Agenda: marcar ausência",
    "conversations:write",
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

/** Rotas da Agenda (módulo "agenda", docs/AGENDA.md). */
function describeAgendaOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
  ref: (name: string) => any,
) {
  entry.tags = ["Agenda"];
  entry.description +=
    " Com o módulo Agenda desligado na área, responde 409 module_disabled. Horários em ms Unix; dias e horas de trabalho no horário de Brasília.";
  const list = (name: string) => ({
    type: "object",
    properties: { data: { type: "array", items: ref(name) } },
  });
  const query = (name: string, description: string, type = "string") =>
    entry.parameters.push({ in: "query", name, schema: { type }, description });
  const schema = (value: any) =>
    (success.content["application/json"].schema = value);
  if (
    /\/(services|professionals|blocks)(\/\{id\})?$/.test(path) &&
    method !== "get"
  )
    entry.description +=
      " Somente administradores (sessão de pessoa). Excluir serviço ou profissional arquiva: some das listas e continua nos agendamentos antigos.";
  if (path.endsWith("/agenda")) {
    schema({
      type: "object",
      properties: {
        config: {
          type: "object",
          description:
            "Chave agenda de PUT /settings, já com os padrões: min_notice_minutes, max_days_ahead, slot_step_minutes, reminder_hours, customer_change_hours, close_on_holidays, web_page, intro_text, booked_text, reminder_text, cancelled_text.",
        },
        services: { type: "array", items: ref("AgendaService") },
        professionals: { type: "array", items: ref("AgendaProfessional") },
      },
    });
    return;
  }
  if (path.endsWith("/services"))
    return void (method === "get"
      ? schema(list("AgendaService"))
      : schema(ref("AgendaService")));
  if (path.endsWith("/professionals"))
    return void (method === "get"
      ? schema(list("AgendaProfessional"))
      : schema(ref("AgendaProfessional")));
  if (path.endsWith("/services/{id}") && method === "put")
    return void schema(ref("AgendaService"));
  if (path.endsWith("/professionals/{id}") && method === "put")
    return void schema(ref("AgendaProfessional"));
  if (path.endsWith("/blocks")) {
    if (method === "get") {
      query("from", "Início do período em ms (padrão: 24 h atrás).", "integer");
      query(
        "to",
        "Fim do período em ms (até 62 dias depois de from).",
        "integer",
      );
      schema(list("AgendaBlock"));
    } else schema(ref("AgendaBlock"));
    return;
  }
  if (path.endsWith("/availability")) {
    query("service_id", "Serviço (obrigatório).");
    query(
      "professional_id",
      "Só este profissional; ausente, qualquer um que atenda o serviço.",
    );
    query("date", "Dia AAAA-MM-DD; ou from_date e to_date (até 31 dias).");
    query("from_date", "Primeiro dia AAAA-MM-DD.");
    query("to_date", "Último dia AAAA-MM-DD.");
    query("staff", "1 ignora a antecedência mínima e máxima (equipe).");
    entry.description +=
      " Cada slot traz starts, ends, time e os profissionais livres naquele início (professional_ids). Considera horário de trabalho, duração, intervalo entre horários, antecedência, folgas, bloqueios, feriados da área e agendamentos ativos.";
    schema({
      type: "object",
      properties: {
        service_id: { type: "string" },
        professional_id: { type: ["string", "null"] },
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", format: "date" },
              slots: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    starts: { type: "integer" },
                    ends: { type: "integer" },
                    time: { type: "string" },
                    professional_ids: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    return;
  }
  if (path.endsWith("/appointments") && method === "get") {
    query("from", "Início do período em ms (padrão: 24 h atrás).", "integer");
    query(
      "to",
      "Fim do período em ms (até 62 dias depois de from).",
      "integer",
    );
    query("professional_id", "Só deste profissional.");
    query(
      "status",
      "booked, confirmed, cancelled, no_show (separados por vírgula).",
    );
    query("conversation_id", "Só da conversa.");
    schema(list("AgendaAppointment"));
    return;
  }
  if (path.endsWith("/appointments") && method === "post")
    entry.description +=
      " A reserva é atômica: dois pedidos para o mesmo horário do mesmo profissional nunca ficam os dois (409 slot_taken ou slot_unavailable). Com conversation_id, o cliente recebe a mensagem de agendamento (modelo de notificação fora da janela de 24 h). Publica agenda.booked. Pela conversa, o mesmo agendamento é POST /conversations/{id}/actions com action agenda; action agenda_link envia ao cliente o link (ou a conversa) para ele mesmo escolher.";
  if (path.endsWith("/move"))
    entry.description +=
      " Remarcar volta o status para booked, zera o lembrete e a confirmação e avisa o cliente. Publica agenda.rescheduled.";
  if (path.endsWith("/cancel"))
    entry.description +=
      " Avisa o cliente da conversa. Publica agenda.cancelled.";
  if (path.endsWith("/confirm"))
    entry.description += " Publica agenda.confirmed.";
  if (path.endsWith("/no-show"))
    entry.description +=
      " Só depois do início do horário. Publica agenda.no_show.";
  if (path.includes("/appointments")) schema(ref("AgendaAppointment"));
}

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
  if (path.startsWith("/profiles/{profile}/agenda")) {
    describeAgendaOperation(path, method, entry, success, ref);
    return;
  }
  if (path === "/profiles/{profile}/people") {
    entry.description =
      "Pessoas ativas com acesso à área (administradores incluídos), em ordem de nome, para escolher o responsável de uma ordem de serviço ou de outro registro de módulo. Sem bots e sem e-mail. Aceita sessão de pessoa da área e chave de aplicação com conversations:read; 404 se a credencial não alcançar a área.";
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "role"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              role: { type: "string", enum: ["admin", "operator"] },
            },
          },
        },
      },
    };
    return;
  }
  if (path === "/profiles/{profile}/establishment") {
    entry.description =
      'Nome fantasia, CPF ou CNPJ, endereço, telefone e rodapé, editados em Gestão → Estabelecimento (PUT /settings com {"establishment": {...}}). Aceita sessão de pessoa da área e chave de aplicação, inclusive aparelho pareado, sem escopo próprio; 404 se a credencial não alcançar a área. Sem cadastro, name é o nome da área e configured é false.';
    success.content["application/json"].schema = ref("Establishment");
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
            via: { enum: ["whatsapp", "panel", "api"] },
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
