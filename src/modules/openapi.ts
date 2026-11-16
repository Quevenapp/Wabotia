// Trecho do OpenAPI dos módulos embutidos (docs/MODULOS.md).
import {
  describeReservaOperation,
  reservaOperations,
  reservaSchemas,
} from "./reserva/openapi";
import {
  describePedidoOperation,
  pedidoOperations,
  pedidoSchemas,
} from "./pedido/openapi";
import {
  describeEntregaOperation,
  entregaOperations,
  entregaSchemas,
} from "./entrega/openapi";
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
    properties: {
      enabled: { type: "boolean" },
      cascade: {
        type: "boolean",
        description:
          "Ao desligar um módulo do qual outros dependem (requires), desliga os dependentes junto. Sem ele, 409 module_required.",
      },
    },
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
  ...pedidoSchemas(),
  ...entregaSchemas(),
  ...mensalidadeSchemas(),
  ...suporteSchemas(),
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
  ...reservaSchemas,
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
    "/profiles/{profile}/grants",
    "Papéis por pessoa nos módulos ligados (entregador, garçom, técnico, caixa) e quem tem cada um",
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
    "/profiles/{profile}/agenda/conversations/{id}",
    "Agenda: próximos agendamentos do cliente de uma conversa (bot)",
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
    "get",
    "/profiles/{profile}/service-orders/conversation/{id}",
    "Ordens de serviço do cliente de uma conversa (bot)",
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
  ...reservaOperations,
  ...pedidoOperations,
  ...entregaOperations,
  ...mensalidadeOperations(),
  ...suporteOperations(),
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
    query(
      "staff",
      "1 ignora a antecedência mínima e máxima (equipe); horário que já passou nunca aparece (agendar no passado só com force).",
    );
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
  if (path.startsWith("/profiles/{profile}/reserva"))
    return describeReservaOperation(path, method, entry, success);
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  if (path.startsWith("/profiles/{profile}/pedido"))
    return describePedidoOperation(path, method, entry, success);
  if (path.startsWith("/profiles/{profile}/entrega"))
    return describeEntregaOperation(path, method, entry, success);
  if (path.includes("/service-orders"))
    return describeServiceOrderOperation(path, method, entry, success);
  if (path.includes("/mensalidade/"))
    return describeMensalidadeOperation(path, method, entry, success);
  if (path.includes("/suporte/"))
    return describeSuporteOperation(path, method, entry, success);
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
      "Pessoas ativas com acesso à área (administradores incluídos), em ordem de nome, para escolher o responsável de uma ordem de serviço ou de outro registro de módulo. Sem bots e sem e-mail. grants traz os papéis da pessoa nos módulos ligados (os:technician); com ?grant=os:technician, só quem tem o papel (400 se o papel não existir ou o módulo estiver desligado). Aceita sessão de pessoa da área e chave de aplicação com conversations:read; 404 se a credencial não alcançar a área.";
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
              grants: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
    return;
  }
  if (path === "/profiles/{profile}/grants") {
    entry.description =
      'Papéis que esta área pode conceder (declarados pelos módulos ligados) e as pessoas com cada um. id é "<módulo>:<papel>". O administrador concede com PUT /settings e {"module_grants": {"os:technician": ["<id da pessoa>"]}} (cada papel enviado substitui a lista dele; lista vazia retira). Aceita sessão de pessoa da área e chave de aplicação com conversations:read.';
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
        counts: {
          type: "object",
          description:
            "Ordens da área por estado, sem os filtros da consulta. Chaves = códigos de status (received, analyzing, quoted, approved, declined, in_progress, ready, delivered, cancelled); estado sem ordens fica ausente (vale 0).",
          properties: Object.fromEntries(
            [
              "received",
              "analyzing",
              "quoted",
              "approved",
              "declined",
              "in_progress",
              "ready",
              "delivered",
              "cancelled",
            ].map((s) => [s, { type: "integer" }]),
          ),
          additionalProperties: false,
        },
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

// --- Mensalidade (módulo "mensalidade", docs/MENSALIDADE.md) ----------------
function mensalidadeOperations(): [string, string, string, string?, string?][] {
  const base = "/profiles/{profile}/mensalidade";
  return [
    ["get", `${base}/plans`, "Mensalidade: planos", "conversations:read"],
    [
      "get",
      `${base}/conversations/{id}`,
      "Mensalidade: situação e parcelas em aberto do pagador de uma conversa (bot)",
      "conversations:read",
    ],
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
    ["get", `${base}/payers`, "Mensalidade: pagadores", "conversations:read"],
    [
      "post",
      `${base}/payers`,
      "Mensalidade: cadastrar pagador",
      "conversations:write",
      "MensalidadePayerInput",
    ],
    [
      "get",
      `${base}/payers/{id}`,
      "Mensalidade: pagador com assinaturas e situação",
      "conversations:read",
    ],
    [
      "patch",
      `${base}/payers/{id}`,
      "Mensalidade: alterar pagador",
      "conversations:write",
      "MensalidadePayerInput",
    ],
    [
      "post",
      `${base}/payers/{id}/phones`,
      "Mensalidade: autorizar telefone do pagador",
      "conversations:write",
      "MensalidadePayerPhone",
    ],
    [
      "post",
      `${base}/payers/{id}/phones/remove`,
      "Mensalidade: retirar telefone do pagador",
      "conversations:write",
      "MensalidadePayerPhone",
    ],
    [
      "get",
      `${base}/situation`,
      "Mensalidade: situação do pagador por telefone ou documento",
      "conversations:read",
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
        sellable: {
          type: "boolean",
          description:
            "Oferecido para contratação pelo WhatsApp (módulo Suporte).",
        },
        description: { type: "string", maxLength: 200 },
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
    MensalidadePayer: {
      type: "object",
      description:
        "Quem paga (CPF ou CNPJ, inclusive o alfanumérico) e os telefones autorizados a falar por ele.",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        document: {
          type: ["string", "null"],
          description:
            "Só dígitos (CPF) ou 12 alfanuméricos + 2 dígitos (CNPJ).",
        },
        document_type: { enum: ["cpf", "cnpj", null] },
        document_display: {
          type: ["string", "null"],
          example: "11.222.333/0001-81",
        },
        email: { type: "string" },
        notes: { type: "string" },
        phones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              phone: { type: "string", example: "5511981000001" },
              label: { type: "string" },
              created: { type: "integer" },
            },
          },
        },
        subscriptions: {
          description:
            "Na lista, quantas não encerradas; no detalhe, as assinaturas.",
        },
        situation: {
          type: "object",
          description: "Só no detalhe.",
          properties: {
            status: { enum: ["em_dia", "em_atraso", "sem_assinatura"] },
            open_installment: {
              oneOf: [
                { $ref: "#/components/schemas/MensalidadeInstallment" },
                { type: "null" },
              ],
            },
            grace_days: { type: "integer" },
          },
        },
      },
    },
    MensalidadePayerInput: {
      type: "object",
      required: ["name"],
      description: "No PATCH, todos opcionais; telefones por /phones.",
      properties: {
        name: { type: "string", maxLength: 120 },
        document: {
          type: ["string", "null"],
          description: "CPF ou CNPJ, com ou sem pontuação.",
        },
        email: { type: "string", maxLength: 200 },
        notes: { type: "string", maxLength: 1000 },
        phones: {
          type: "array",
          maxItems: 50,
          description: "Só na criação: telefones ou {phone, label}.",
        },
      },
    },
    MensalidadePayerPhone: {
      type: "object",
      required: ["phone"],
      properties: {
        phone: { type: "string", maxLength: 40 },
        label: { type: "string", maxLength: 60 },
      },
    },
    MensalidadeSituation: {
      type: "object",
      properties: {
        status: { enum: ["em_dia", "em_atraso", "sem_assinatura"] },
        payer: { $ref: "#/components/schemas/MensalidadePayer" },
        matched_by: { enum: ["phone", "document", "id"] },
        phone_linked: {
          type: ["boolean", "null"],
          description: "O telefone consultado é autorizado pelo pagador.",
        },
        subscriptions: { type: "array", items: { type: "object" } },
        open_installment: {
          oneOf: [
            { $ref: "#/components/schemas/MensalidadeInstallment" },
            { type: "null" },
          ],
        },
        grace_days: { type: "integer" },
        payers: {
          type: "integer",
          description:
            "Pela busca por telefone: quantos pagadores autorizaram o número.",
        },
      },
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
      : /\/(import|pause|resume|end|pay|waive)$|\/generate$|\/payers\/\{id\}\/phones$/.test(
          path,
        );
  if (adminOnly)
    entry.description +=
      " Operação financeira: pessoas, só administradores (403 admin_required); aplicações, com billing:write (403 missing_scope).";
  if (/\/subscriptions(\/\{id\})?$/.test(path) && method !== "get")
    entry.description +=
      " Valor, desconto e plano (e billing_consent, com billing_consent_evidence) exigem administrador ou aplicação com billing:write.";
  if (/\/payers(\/\{id\})?$/.test(path) && method === "get")
    entry.description +=
      " Aplicações precisam de contacts:read. Na listagem, o atendente vê o documento mascarado.";
  if (method === "get")
    entry.description +=
      " Sem contacts:read, a aplicação não recebe documento, e-mail nem telefones; sem notes:read, não recebe as observações.";
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
  if (path.endsWith("/situation")) {
    query("phone", "document");
    entry.description +=
      " Em dia, em atraso (com open_installment: a parcela vencida além da carência ou a primeira parcela da contratação ainda sem pagar) ou sem assinatura ativa. Por telefone vale o pagador mais favorável entre os que o autorizaram. Documento inválido: 400; sem pagador: 404 payer_not_found.";
    success.content["application/json"].schema = ref("MensalidadeSituation");
    return;
  }
  if (path.endsWith("/payers") && method === "get") {
    query("q", "document", "phone", "limit", "cursor");
    success.content["application/json"].schema = list("MensalidadePayer", {
      next_cursor: { type: ["string", "null"] },
    });
    return;
  }
  if (path.includes("/payers")) {
    if (path.endsWith("/payers") || path.endsWith("/payers/{id}"))
      entry.description +=
        " CPF ou CNPJ com dígitos conferidos (aceita o CNPJ alfanumérico); repetido na área: 409 payer_exists.";
    success.content["application/json"].schema = ref("MensalidadePayer");
    return;
  }
  success.content["application/json"].schema = ref("MensalidadeInstallment");
}

// --- Suporte pago (módulo "suporte", docs/SUPORTE.md) -------------------------
function suporteOperations(): [string, string, string, string?, string?][] {
  const base = "/profiles/{profile}/suporte";
  return [
    [
      "get",
      `${base}/releases`,
      "Suporte pago: liberações",
      "conversations:read",
    ],
    [
      "get",
      `${base}/purchases`,
      "Suporte pago: compras avulsas",
      "conversations:read",
    ],
    [
      "get",
      `${base}/offers`,
      "Suporte pago: pacotes e planos oferecidos",
      "conversations:read",
    ],
    [
      "get",
      `${base}/pending`,
      "Suporte pago: aguardando a equipe confirmar a identidade",
      "conversations:read",
    ],
    [
      "get",
      `${base}/conversations/{id}`,
      "Suporte pago: situação de uma conversa",
      "conversations:read",
    ],
    [
      "post",
      `${base}/conversations/{id}/courtesy`,
      "Suporte pago: liberar como cortesia",
      "conversations:write",
      "SuporteCourtesy",
    ],
    [
      "post",
      `${base}/conversations/{id}/link-phone`,
      "Suporte pago: vincular o telefone ao pagador",
      "conversations:write",
    ],
    [
      "post",
      `${base}/conversations/{id}/confirm`,
      "Suporte pago: equipe confirma e libera",
      "conversations:write",
      "SuporteConfirm",
    ],
    [
      "post",
      `${base}/releases/{id}/end`,
      "Suporte pago: encerrar liberação",
      "conversations:write",
    ],
  ];
}

function suporteSchemas() {
  const kinds = ["subscription", "installment", "package", "courtesy", "team"];
  return {
    SuporteRelease: {
      type: "object",
      description:
        "Liberação do atendimento humano: quem, como, por qual pagador e até quando.",
      properties: {
        id: { type: "string" },
        conversation_id: { type: "string" },
        phone: { type: "string" },
        payer_id: { type: ["string", "null"] },
        payer_name: { type: "string" },
        kind: {
          enum: kinds,
          description:
            "subscription (assinatura em dia), installment (mensalidade em atraso paga), package (avulso), courtesy (cortesia do atendente), team (equipe confirmou no modo só telefone vinculado).",
        },
        kind_label: { type: "string" },
        ref_id: {
          type: ["string", "null"],
          description: "Assinatura, parcela ou compra que liberou.",
        },
        phone_linked: {
          type: "boolean",
          description:
            "false: veio pelo CPF/CNPJ de um telefone não autorizado.",
        },
        valid_until: { type: ["integer", "null"] },
        until_ticket: {
          type: "boolean",
          description:
            "Vale até o protocolo amarrado (ticket_id) fechar ou a conversa ser resolvida.",
        },
        ticket_id: {
          type: ["string", "null"],
          description: "Protocolo da conversa na hora da liberação.",
        },
        expires_at: {
          type: "integer",
          description:
            "Prazo máximo absoluto (7 dias até o protocolo, 30 dias as demais, 4 horas com telefone não vinculado).",
        },
        reason: { type: "string" },
        summary: {
          type: "string",
          description: "Resumo entregue ao atendente.",
        },
        actor: {
          type: "string",
          description: "provider (pagamento confirmado), system ou a pessoa.",
        },
        status: { enum: ["active", "ended"] },
        ended_at: { type: ["integer", "null"] },
        ended_by: { type: ["string", "null"] },
        created: { type: "integer" },
      },
    },
    SuportePurchase: {
      type: "object",
      properties: {
        id: { type: "string" },
        conversation_id: { type: "string" },
        payer_id: { type: ["string", "null"] },
        document: { type: ["string", "null"] },
        name: { type: "string" },
        phone: { type: "string" },
        package_id: { type: "string" },
        package_name: { type: "string" },
        price_cents: { type: "integer" },
        mode: { enum: ["ticket", "hours"] },
        hours: { type: ["integer", "null"] },
        validity: { type: "string" },
        method: { enum: ["pix", "link"] },
        payment: { type: ["object", "null"] },
        status: {
          enum: ["pending", "paid", "expired", "cancelled", "refunded"],
        },
        status_label: { type: "string" },
        attention: {
          enum: ["duplicate_payment", "paid_after_cancel", "refunded", null],
          description:
            "Pendência para a equipe: dinheiro em dobro, paga depois de cancelada ou estornada depois de liberar.",
        },
        paid_at: { type: ["integer", "null"] },
        created: { type: "integer" },
      },
    },
    SuporteConversation: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        phone: { type: "string" },
        allowed: {
          type: "boolean",
          description:
            "Pode ir para um humano agora (liberação ativa ou pagador em dia).",
        },
        reason: {
          enum: [
            "released",
            "subscription",
            "payment_required",
            "module_disabled",
          ],
        },
        release: {
          oneOf: [
            { $ref: "#/components/schemas/SuporteRelease" },
            { type: "null" },
          ],
        },
        session: { type: ["object", "null"] },
        awaiting_team: {
          type: "boolean",
          description:
            "CPF/CNPJ de um cadastro digitado por telefone não autorizado: a equipe confirma.",
        },
        group_held: {
          type: "boolean",
          description:
            "Pedido de humano num grupo, segurado: a equipe libera com cortesia.",
        },
        unlinked_phone: {
          type: ["object", "null"],
          properties: {
            payer_id: { type: "string" },
            payer_name: { type: "string" },
            provisional: {
              type: "boolean",
              description:
                "Pagador criado por contratação paga pelo WhatsApp, a partir de documento digitado.",
            },
            phones: {
              type: "array",
              description:
                "Telefones autorizados do pagador e quem cadastrou cada um (requer contacts:read).",
              items: {
                type: "object",
                properties: {
                  phone: { type: "string" },
                  created_by: { type: "string" },
                  created: { type: "integer" },
                },
              },
            },
          },
        },
        purchases: {
          type: "array",
          items: { $ref: "#/components/schemas/SuportePurchase" },
        },
      },
    },
    SuporteCourtesy: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: { type: "string", maxLength: 300 },
        hours: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 720,
          description: "Sem horas: até o protocolo fechar.",
        },
      },
    },
    SuporteConfirm: {
      type: "object",
      properties: {
        link: {
          type: "boolean",
          default: true,
          description: "Autoriza o telefone da conversa no pagador.",
        },
      },
    },
  };
}

function describeSuporteOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const query = (...names: string[]) =>
    entry.parameters.push(
      ...names.map((name) => ({
        in: "query",
        name,
        schema: { type: "string" },
      })),
    );
  entry.description +=
    " Módulo Suporte pago (suporte); desligado, 409 module_disabled.";
  if (method === "get")
    entry.description +=
      " Sem contacts:read, a aplicação não recebe documento nem telefone; sem notes:read, não recebe resumo nem motivo.";
  else if (/\/(courtesy|link-phone|confirm|end)$/.test(path))
    entry.description +=
      " Dá atendimento pago sem pagamento: aplicações precisam de billing:write; pessoas, da conversa assumida ou de administrador.";
  if (path.endsWith("/releases")) {
    query(
      "kind",
      "status",
      "conversation_id",
      "payer_id",
      "from",
      "to",
      "q",
      "limit",
      "cursor",
    );
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        data: { type: "array", items: ref("SuporteRelease") },
        next_cursor: { type: ["string", "null"] },
        counts: { type: "object", additionalProperties: { type: "integer" } },
      },
    };
    return;
  }
  if (path.endsWith("/purchases")) {
    query("status", "conversation_id", "q", "limit", "cursor");
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        data: { type: "array", items: ref("SuportePurchase") },
        next_cursor: { type: ["string", "null"] },
        counts: { type: "object", additionalProperties: { type: "integer" } },
        paid_cents: { type: "integer" },
      },
    };
    return;
  }
  if (path.endsWith("/pending")) {
    entry.description +=
      " Sessões dos últimos 7 dias em que o cliente digitou o CPF/CNPJ de um cadastro por um telefone que ele não autorizou; nada foi liberado nem mostrado ao cliente. A equipe confirma em conversations/{id}/confirm.";
    success.content["application/json"].schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              session_id: { type: "string" },
              conversation_id: { type: "string" },
              phone: { type: "string" },
              payer_id: { type: "string" },
              payer_name: { type: "string" },
              created: { type: "integer" },
            },
          },
        },
      },
    };
    return;
  }
  if (path.endsWith("/offers")) {
    entry.description +=
      " Pacotes avulsos ativos e planos vendáveis da Mensalidade (some com a Mensalidade desligada), com payments_ready.";
    return;
  }
  if (path.endsWith("/courtesy")) {
    entry.description +=
      " Atendente com a conversa, administrador ou aplicação. Registra quem liberou e o motivo; repetir a Idempotency-Key devolve a mesma liberação.";
    success.content["application/json"].schema = ref("SuporteRelease");
    return;
  }
  if (path.endsWith("/link-phone")) {
    entry.description +=
      " Autoriza o telefone da conversa no pagador identificado pelo CPF/CNPJ. Sem vínculo pendente: 409 nothing_to_link.";
    success.content["application/json"].schema = ref("SuporteConversation");
    return;
  }
  if (path.endsWith("/confirm")) {
    entry.description +=
      " Modo só telefone vinculado: a equipe confirma a identidade (e vincula). Libera se o pagador estiver em dia; senão 409 payment_required. Sem confirmação pendente: 409 nothing_to_confirm.";
    success.content["application/json"].schema = ref("SuporteRelease");
    return;
  }
  if (path.endsWith("/end")) {
    entry.description += " Só administradores (pessoas).";
    success.content["application/json"].schema = ref("SuporteRelease");
    return;
  }
  if (method === "get")
    success.content["application/json"].schema = ref("SuporteConversation");
}
