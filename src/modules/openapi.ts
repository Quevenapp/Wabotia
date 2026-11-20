import { ensinoOperations, ensinoSchemas, describeEnsinoOperation } from "./ensino/openapi";
import { erpOperations, describeErpOperation } from "./erp/openapi";
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
  describeMesasOperation,
  mesasOperations,
  mesasSchemas,
} from "./mesas/openapi";
import {
  describeEntregaOperation,
  entregaOperations,
  entregaSchemas,
} from "./entrega/openapi";
export const moduleSchemas = {
  ...ensinoSchemas,
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
      source: {
        type: "object",
        description:
          "Código-fonte do commit em execução (AGPL-3.0, §13). WABOTIA_SOURCE_URL troca o repositório.",
        properties: {
          url: { type: "string", format: "uri" },
          repository: { type: "string", format: "uri" },
          commit: { type: "string" },
          license: { type: "string", example: "AGPL-3.0" },
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
      confirmed_dependents: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        description:
          "Opcional com cascade: true. Quando presente, deve conter exatamente os dependentes ligados atuais, em qualquer ordem; falta, sobra, repetição ou tipo inválido retorna 409 module_cascade_conflict sem alterações. Omitido, desliga os dependentes atuais por compatibilidade. O painel envia a lista exibida na confirmação.",
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
  ...workMotorSchemas(),
  ...pedidoSchemas(),
  ...mesasSchemas(),
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
      address: {
        type: "string",
        description:
          "Endereço para imprimir e mostrar: montado dos campos (\"Rua X, 200 - Bairro, Cidade/UF, CEP 00000-000\") quando rua e cidade estão preenchidas; senão, o texto livre.",
      },
      address_free: {
        type: "string",
        maxLength: 300,
        description: "O texto livre gravado, como está (o que Gestão edita em `address` no PUT /settings).",
      },
      street: { type: "string", maxLength: 200 },
      number: { type: "string", maxLength: 30 },
      complement: { type: "string", maxLength: 200 },
      district: { type: "string", maxLength: 100, description: "Bairro." },
      city: { type: "string", maxLength: 100 },
      state: { type: "string", description: "UF, duas letras." },
      postal_code: { type: "string", description: "CEP, 8 dígitos." },
      municipality_code: {
        type: "string",
        description: "Código IBGE do município (7 dígitos), opcional.",
      },
      latitude: { type: ["number", "null"] },
      longitude: { type: ["number", "null"] },
      position: {
        description:
          "Posição da loja (Gestão → Estabelecimento, \"Usar a localização deste aparelho\"): referência para os apps acharem endereços perto da loja.",
        oneOf: [
          {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" } },
          },
          { type: "null" },
        ],
      },
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
  ...ensinoOperations,
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
    "/profiles/{profile}/access",
    "Catálogo do que se marca no acesso de uma pessoa (áreas, módulos ligados e papéis) e atalhos de perfil",
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
  ...workMotorOperations(),
  ...reservaOperations,
  ...erpOperations,
  ...pedidoOperations,
  ...mesasOperations,
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
  if (path.startsWith("/profiles/{profile}/erp/")) return describeErpOperation(path, method, entry, success);
  if (path.startsWith("/profiles/{profile}/ensino/")) return describeEnsinoOperation(path, method, entry, success);
  entry.tags = ["Módulos"];
  if (path.startsWith("/profiles/{profile}/reserva"))
    return describeReservaOperation(path, method, entry, success);
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  if (path.startsWith("/profiles/{profile}/pedido"))
    return describePedidoOperation(path, method, entry, success);
  if (path.startsWith("/profiles/{profile}/mesas"))
    return describeMesasOperation(path, method, entry, success);

  if (path.startsWith("/profiles/{profile}/entrega"))
    return describeEntregaOperation(path, method, entry, success);
  if (path.includes("/service-orders"))
    return describeServiceOrderOperation(path, method, entry, success);
  if (path.includes("/area-templates"))
    return describeWorkMotorOperation(path, method, entry, success);
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
      'Papéis que esta área pode conceder (declarados pelos módulos ligados) e as pessoas com cada um. id é "<módulo>:<papel>". O administrador marca o papel no acesso da pessoa: PATCH /users/{id} com {"access": ["*", "os:technician"]} (docs/API.md, Acesso por pessoa). Aceita sessão de pessoa da área e chave de aplicação com conversations:read.';
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
          minimum: 1,
          maximum: 2147483647,
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
              kind: {
                type: "string",
                description: "Código do registro: opened/status/quote/edit no legado e eventos os.* no motor, como os.stage_changed e os.task.created. Consumidores devem aceitar códigos novos.",
              },
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
        ...workOrderProperties(),
      },
      examples: Object.values(workOrderExamples()),
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
        type_id: { type: "string", default: "service_order" },
        extra: { $ref: "#/components/schemas/ExtraValues" },
        contact_id: { type: "string", description: "Contato canônico autorizado; obrigatório quando o modelo usa objeto e não há conversa confirmada." },
        object: workRef("ObjectOpeningRequest"),
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
        extra: { $ref: "#/components/schemas/ExtraValues" },
        version: { type: "integer", minimum: 1 },
      },
    },
    ServiceOrderStatus: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          enum: ["received", "analyzing", "in_progress", "ready", "delivered", "cancelled"],
          description: "Embutido: analyzing, in_progress, ready, delivered ou cancelled, conforme a origem. Personalizado também admite received por uma única transição manual que altere o estado de base. quoted/approved/declined usam as rotas de orçamento.",
        },
        note: { type: "string", maxLength: 500 },
      },
    },
    ServiceOrderQuote: {
      type: "object",
      required: ["items"],
      properties: {
        version: { type: "integer", minimum: 1, description: "Versão esperada da ordem; opcional para compatibilidade." },
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
  describeWorkMotorOperation(path, method, entry, success);
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
      "get",
      `${base}/conversations/{id}/situation`,
      "Suporte pago: situação para o próprio cliente (ferramenta suporte_situacao)",
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

// Motor de trabalhos: contrato das seções 3, 5 e 7, completado por F0.
// Este catálogo documenta a integração; não registra manipuladores HTTP.
function workRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function workObject(
  properties: Record<string, any>,
  required = Object.keys(properties),
) {
  return {
    type: "object",
    properties,
    required: [...new Set(required)],
    additionalProperties: false,
  };
}

function workStatuses() {
  return [
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
}

function workOrderProperties() {
  const text = { type: "string" };
  const version = { type: "integer", minimum: 1 };
  return {
    object: workRef("ServiceObjectSnapshotView"),
    type_id: text,
    type_revision: version,
    type_number: { type: "integer", minimum: 1, maximum: 2147483647 },
    type_label: text,
    type_plural_label: text,
    display_number: text,
    stage: text,
    stage_label: text,
    features: workRef("WorkFeatures"),
    next_task: { anyOf: [workObject({ id: text, title: text, due_at: { type: ["integer", "null"] } }), { type: "null" }] },
    labels: workRef("WorkLabels"),
    extra: workRef("ExtraValues"),
    fields: {
      type: "array",
      items: workRef("WorkField"),
      description:
        "Somente definições autorizadas; campos sensíveis ficam fora da resposta comum.",
    },
    version,
    next_stages: {
      type: "array",
      items: workObject({
        transition_id: text,
        stage: text,
        stage_label: text,
        base_status: { type: "string", enum: workStatuses() },
        kind: { enum: ["manual", "customer_approval"] },
      }),
    },
    stage_approval: {
      anyOf: [workRef("PendingStageApproval"), { type: "null" }],
    },
  };
}

function workOrderExamples() {
  const builtin = {
    id: "os_42",
    number: 42,
    status: "received",
    status_label: "Recebida",
    customer: {
      name: "Cliente de exemplo",
      phone: "5511999998888",
      contact_id: null,
      conversation_id: "conversation_1",
    },
    item: "Impressora",
    problem: "Não imprime",
    notes: "",
    assignee: null,
    due_at: null,
    source: "panel",
    terms: null,
    quote: null,
    decision: null,
    ready_at: null,
    delivered_at: null,
    warranty_until: null,
    next_statuses: ["analyzing", "in_progress", "cancelled"],
    created_by: "user_1",
    created: 1795000000000,
    updated: 1795000000000,
    type_id: "service_order",
    type_revision: 1,
    type_number: 42,
    type_label: "Ordem de serviço",
    type_plural_label: "Ordens de serviço",
    display_number: "42",
    stage: "received",
    stage_label: "Recebida",
    labels: {
      singular: "Ordem de serviço",
      plural: "Ordens de serviço",
      item: "Item",
      problem: "Problema",
      customer_singular: "Cliente",
      customer_plural: "Clientes",
    },
    extra: {},
    fields: [],
    version: 1,
    stage_approval: null,
    next_stages: [
      {
        transition_id: "received_analyzing",
        stage: "analyzing",
        stage_label: "Em análise",
        base_status: "analyzing",
        kind: "manual",
      },
      {
        transition_id: "received_in_progress",
        stage: "in_progress",
        stage_label: "Em execução",
        base_status: "in_progress",
        kind: "manual",
      },
      {
        transition_id: "received_cancelled",
        stage: "cancelled",
        stage_label: "Cancelada",
        base_status: "cancelled",
        kind: "manual",
      },
    ],
  };
  const custom = {
    ...builtin,
    id: "os_43",
    number: 43,
    item: "Projeto da loja",
    problem: "Revisar planta",
    status: "in_progress",
    status_label: "Em execução",
    type_id: "projeto",
    type_number: 7,
    type_label: "Projeto",
    type_plural_label: "Projetos",
    display_number: "PROJ-7",
    stage: "revisao",
    stage_label: "Revisão",
    version: 3,
    labels: {
      ...builtin.labels,
      singular: "Projeto",
      plural: "Projetos",
      item: "Projeto",
      problem: "Objetivo",
    },
    extra: { visitas: 0 },
    fields: [
      {
        id: "visitas",
        label: "Visitas",
        help: "",
        required: false,
        client_visible: true,
        sensitive: false,
        kind: "integer",
        min: 0,
        max: 100,
      },
    ],
    next_statuses: ["cancelled"],
    next_stages: [
      {
        transition_id: "finalizar_revisao",
        stage: "execucao",
        stage_label: "Execução",
        base_status: "in_progress",
        kind: "manual",
      },
      {
        transition_id: "cancelar",
        stage: "cancelado",
        stage_label: "Cancelado",
        base_status: "cancelled",
        kind: "manual",
      },
    ],
  };
  return { builtin, custom };
}

// O download conserva o MIME validado na reserva, não o tipo do corpo do upload.
function workDocumentMimeTypes() {
  return [
    "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain",
    "application/msword", "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ];
}

function workMotorSchemas(): Record<string, any> {
  const text = { type: "string" };
  const bool = { type: "boolean" };
  const version = { type: "integer", minimum: 1 };
  const nullableText = { type: ["string", "null"] };
  const date = {
    type: "integer",
    description: "Instante Unix em milissegundos.",
  };
  const nullableDate = { ...date, type: ["integer", "null"] };
  const array = (items: any, maxItems?: number) => ({
    type: "array",
    items,
    ...(maxItems === undefined ? {} : { maxItems }),
  });
  const strings = array(text);
  const id = (maxLength = 32) => ({
    type: "string",
    pattern: "^[a-z][a-z0-9_]*$",
    minLength: 1,
    maxLength,
  });
  const label = { type: "string", minLength: 1, maxLength: 80 };
  const message = { type: "string", maxLength: 900 };
  const visibility = { client_visible: bool, sensitive: bool };
  const child = {
    id: text,
    order_id: text,
    version,
    ...visibility,
    created_by: text,
    created: date,
    updated: date,
    archived_at: nullableDate,
  };
  const childRequired = Object.keys(child).filter(
    (key) => key !== "created_by",
  );
  const task = {
    title: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string", maxLength: 4000 },
    assignee: nullableText,
    audience: { enum: ["staff", "customer"] },
    due_at: nullableDate,
    remind_at: nullableDate,
    ...visibility,
  };
  const person = {
    role: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    contact_id: nullableText,
    phone: { type: "string", maxLength: 40 },
    email: { type: "string", maxLength: 254 },
    note: { type: "string", maxLength: 2000 },
    ...visibility,
  };
  const document = {
    name: { type: "string", minLength: 1, maxLength: 200 },
    mime_type: { type: "string", enum: workDocumentMimeTypes() },
    expected_bytes: { type: "integer", minimum: 1, maximum: 10485760 },
    ...visibility,
  };
  const entry = {
    kind: { type: "string", minLength: 1, maxLength: 64 },
    text: { type: "string", minLength: 1, maxLength: 4000 },
    quantity_milli: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 1000000000000,
      description:
        "Quantidade em milésimos: 1500 = 1,5. Não cria movimento financeiro.",
    },
    unit: { type: "string", maxLength: 32 },
    occurred_at: date,
    ...visibility,
  };
  const taskState = { enum: ["open", "done", "cancelled"] };
  const entryRequired = [
    "kind",
    "text",
    "occurred_at",
    "client_visible",
    "sensitive",
  ];
  const field = {
    id: id(),
    label,
    help: { type: "string", maxLength: 240 },
    required: bool,
    ...visibility,
  };
  const variants = {
    text: {
      multiline: bool,
      max_length: { type: "integer", minimum: 1, maximum: 2000 },
    },
    integer: {
      min: {
        type: "integer",
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      },
      max: {
        type: "integer",
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      },
    },
    decimal: {
      min: { type: "number" },
      max: { type: "number" },
      scale: { type: "integer", minimum: 0, maximum: 6 },
    },
    boolean: {},
    date: {
      min: { type: ["string", "null"], format: "date" },
      max: { type: ["string", "null"], format: "date" },
    },
    choice: {
      options: { ...array(workObject({ id: id(), label }), 32), minItems: 1 },
    },
  };
  const transition = { id: id(), from: id(), to: id(), label };
  const typeProperties = {
    schema_version: { enum: [1] },
    kind: { enum: ["custom"] },
    id: { ...id(64), not: { enum: ["service_order"] } },
    revision: version,
    archived: bool,
    labels: workRef("WorkLabels"),
    number_prefix: { type: "string", maxLength: 12 },
    terms: { type: ["string", "null"], maxLength: 1400 },
    fields: array(workRef("WorkField"), 24),
    retired_field_ids: array(id()),
    stages: { ...array(workRef("WorkStage"), 32), minItems: 1 },
    retired_stage_ids: array(id()),
    initial_stage: id(),
    transitions: array(workRef("WorkTransition"), 128),
    features: workRef("WorkFeatures"),
    pickup_reminder_text: message,
  };
  const modules = [
    "os",
    "queue",
    "forms",
    "agenda",
    "reserva",
    "pedido",
    "mensalidade",
    "suporte",
    "mesas",
    "entrega",
    "payments",
    "erp",
  ];
  const menu = { id: text, label };
  const selection = workObject({
    work_type_ids: strings,
    module_ids: array({ enum: modules }),
    menus: bool,
    departments: bool,
    ticket_categories: bool,
    vocabulary: bool,
    texts: bool,
    bot_suggestions: bool,
  });
  const templateRequest = (apply: boolean) => ({
    oneOf: ["template_id", "manifest"].map((source) =>
      workObject({
        [source]: source === "template_id" ? text : workRef("AreaTemplate"),
        selection: workRef("AreaTemplateSelection"),
        ...(apply ? { preview_hash: text } : {}),
      }),
    ),
  });
  const page = (name: string) =>
    workObject({ data: array(workRef(name)), next_cursor: nullableText });
  const counts = {
    type: "object",
    additionalProperties: false,
    description:
      "Mapa esparso dos nove estados da área inteira, independente de filtros e paginação; chave ausente vale zero.",
    properties: Object.fromEntries(
      workStatuses().map((status) => [status, { type: "integer", minimum: 0 }]),
    ),
  };
  return {
    BaseStatus: { type: "string", enum: workStatuses() },
    ExtraValues: {
      type: "object",
      additionalProperties: { type: ["string", "number", "boolean", "null"] },
      description:
        "Até 16 KiB UTF-8; somente IDs da definição fixada na abertura. Rotas comuns rejeitam valores sensíveis. Ausência difere de false, zero, vazio e null.",
    },
    WorkLabels: workObject(
      Object.fromEntries(
        [
          "singular",
          "plural",
          "item",
          "problem",
          "customer_singular",
          "customer_plural",
        ].map((key) => [key, label]),
      ),
    ),
    WorkField: {
      oneOf: Object.entries(variants).map(([kind, extra]) =>
        workObject({ ...field, kind: { enum: [kind] }, ...extra }),
      ),
      description:
        "ID único; constructor, prototype e __proto__ proibidos. sensitive exige client_visible=false e required=false. Escolha recebe ID, data civil deve existir, decimal finito respeita escala sem arredondamento.",
    },
    WorkStage: workObject({
      id: id(),
      label,
      base_status: workRef("BaseStatus"),
      message,
    }),
    WorkTransition: {
      oneOf: [
        workObject({ ...transition, kind: { enum: ["manual"] } }),
        workObject({
          ...transition,
          kind: { enum: ["customer_approval"] },
          valid_hours: { type: "integer", minimum: 1, maximum: 720 },
          request_text: message,
        }),
      ],
    },
    WorkQuotePolicy: workObject({
      default_valid_days: { type: "integer", minimum: 1, maximum: 90 },
      source_stages: array(id()),
      sent_stage: id(),
      approved_stage: id(),
      declined_stage: id(),
      edited_stage: id(),
    }),
    WorkFeatures: workObject({
      customer_open: bool,
      tasks: bool,
      people: bool,
      documents: bool,
      entries: bool,
      quote: { anyOf: [workRef("WorkQuotePolicy"), { type: "null" }] },
      warranty_days: { type: "integer", minimum: 0, maximum: 3650 },
      pickup_reminder_days: { type: "integer", minimum: 0, maximum: 365 },
      stale_days: { type: "integer", minimum: 0, maximum: 365 },
    }),
    CustomWorkType: {
      ...workObject({
        ...typeProperties,
        object_type_id: id(64),
        stage_field_rules: array(workRef("StageFieldRule"), 24),
        list_fields: array(workRef("ListFieldRule"), 8),
      }, Object.keys(typeProperties)),
      description:
        "Até 12 KiB UTF-8. Novo tipo tem revisão 1; alteração incrementa uma vez. Não excluir: arquivar. IDs aposentados não são reutilizados; sigilo não pode ser reduzido. Etapa inicial received; delivered/cancelled terminais. quoted/approved/declined reservados ao orçamento.",
    },
    WorkTypeView: {
      oneOf: [
        workRef("CustomWorkType"),
        workObject({
          ...typeProperties,
          kind: { enum: ["builtin"] },
          id: { enum: ["service_order"] },
          revision: { enum: [1] },
        }),
      ],
      description:
        "Definição resolvida; omite campos sensíveis sem autorização. O embutido é virtual; não salvar em os_work_types.",
    },
    OsVocabulary: workObject({
      collection_label: label,
      customer_singular: label,
      customer_plural: label,
    }),
    WorkTypeSettings: workObject(
      {
        os_work_types: array(workRef("CustomWorkType"), 20),
        os_object_types: array(workRef("ServiceObjectType"), 20),
        os2_ai_access: workRef("Os2AiAccess"),
        os_vocabulary: workRef("OsVocabulary"),
        settings_revision: text,
      },
      ["settings_revision"],
    ),
    WorkTypeCatalog: workObject({
      data: array(workRef("WorkTypeView")),
      settings_revision: text,
    }),
    Os2AiAccess: {
      ...workObject({ enabled: { ...bool, default: false }, internal: { ...bool, default: false }, sensitive: { ...bool, default: false } }),
      description: "Configuração administrativa com settings_revision. Ausência equivale a três false. Flags não concedem escopos nem ampliam propriedade: WhatsApp e cliente só alcançam dados próprios autorizados.",
    },
    FieldRef: workObject({ scope: { enum: ["order", "object"] }, field_id: id() }),
    StageFieldRule: workObject({ field_id: id(), required_from_stage: id(), required_on_exit: array(id(), 32) }, ["field_id"]),
    ListFieldRule: workObject({ ref: workRef("FieldRef"), column: bool, filter: bool }, ["ref"]),
    ServiceObjectType: {
      ...workObject({
        schema_version: { enum: [1] }, id: id(64), revision: version, archived: bool,
        labels: workObject({ singular: label, plural: label }), identifier_field_id: id(),
        fields: array(workRef("WorkField"), 24), retired_field_ids: array(id()),
      }),
      description: "Até 8 KiB UTF-8. Identificador aponta para texto de uma linha não sensível com até 120 caracteres. Identificador não é único, autorização ou prova de propriedade. Arquivar em vez de excluir; IDs e classificação sensível são preservados.",
    },
    ServiceObjectTypeView: workObject({
      schema_version: { enum: [1] }, id: id(64), revision: version,
      labels: workObject({ singular: label, plural: label }), identifier_field_id: id(),
      fields: array(workRef("WorkField"), 24),
    }, ["schema_version", "id", "revision", "labels", "fields"]),
    ObjectTypeCatalog: workObject({ data: array(workRef("ServiceObjectType"), 20), settings_revision: text }),
    ServiceObjectSnapshotView: {
      ...workObject({
        schema_version: { enum: [1] }, object_id: text, object_version: version,
        captured_at: date, origin: { enum: ["opening", "legacy_link"] },
        type: workRef("ServiceObjectTypeView"), values: workRef("ExtraValues"), identifier: text,
      }),
      description: "Cópia autorizada capturada na abertura ou no vínculo posterior; nunca consulta o cadastro atual. Campos privados e internos não autorizados são omitidos. Sem vínculo, a propriedade object não existe na ordem.",
    },
    ServiceObjectView: workObject({
      id: text, contact_id: text, type_id: text, type_revision: version,
      type: workRef("ServiceObjectTypeView"), values: workRef("ExtraValues"),
      archived: bool, version, identifier: text, created: date, updated: date,
      latest_completed: { anyOf: [workObject({ id: text, number: version, delivered_at: nullableDate }), { type: "null" }] },
    }, ["id", "type_id", "type_revision", "type", "values", "archived", "version", "identifier", "created", "updated"]),
    ServiceObjectPage: page("ServiceObjectView"),
    OrderHistoryObjectsPage: page("ServiceOrder"),
    ConversationObjectDetail: workObject({ object: workRef("ServiceObjectView"), orders: workRef("OrderHistoryObjectsPage") }),
    ObjectOpeningRequest: {
      oneOf: [
        workObject({ mode: { enum: ["existing"] }, id: text, version }),
        workObject({ mode: { enum: ["new"] }, type_id: text, values: workRef("ExtraValues") }),
      ],
      description: "Seleção obrigatória em modelo com objeto. Cadastro inline e ordem são confirmados juntos. Modelo sem objeto rejeita este campo.",
    },
    CreateServiceObjectRequest: workObject({ contact_id: text, type_id: text, values: workRef("ExtraValues") }),
    UpdateServiceObjectRequest: workObject({ version, values: workRef("ExtraValues"), adopt_revision: version }, ["version"]),
    ArchiveServiceObjectRequest: workObject({ version, archived: bool }),
    LegacyObjectLinkRequest: workObject({ version, object: workRef("ObjectOpeningRequest") }),
    ObjectPrivateFields: workObject({ id: text, version, fields: array(workRef("WorkField"), 24), values: workRef("ExtraValues") }),
    ObjectPrivateFieldsRequest: workObject({ version, values: workRef("ExtraValues") }),
    OrderRequirements: workObject({
      id: text, version, transition_id: text,
      required: array(workObject({ field_id: id(), label })),
      missing: array(workObject({ field_id: id(), label })), internal_missing: bool,
    }, ["id", "version", "required", "missing", "internal_missing"]),
    OrderFieldFilter: { oneOf: [
      workObject({ ref: workRef("FieldRef"), operator: { enum: ["eq"] }, value: { type: ["string", "number", "boolean"] } }),
      workObject({ ref: workRef("FieldRef"), operator: { enum: ["range"] }, from: { type: ["string", "number"] }, to: { type: ["string", "number"] } }),
    ] },
    FieldIndexState: workObject({
      type_id: text, generation: text, status: { enum: ["building", "ready"] },
      cursor_number: { type: "integer", minimum: 0 }, ceiling_number: { type: "integer", minimum: 0 },
      excluded_count: { type: "integer", minimum: 0 }, updated: date,
    }),
    FieldIndexRebuildRequest: workObject({ generation: text, cursor_number: { type: "integer", minimum: 0 } }, []),
    FieldFilteredOrderList: workObject({
      data: array(workRef("ServiceOrder"), 50), next_cursor: nullableText,
      counts: { type: "null" }, counts_scope: { enum: ["not_computed"] },
      order_by: { enum: ["number_desc", "field_value_asc"] },
    }),
    PendingStageApproval: workObject({
      version,
      transition_id: text,
      from_stage: text,
      to_stage: text,
      state: {
        enum: ["pending", "approved", "declined", "expired", "cancelled"],
      },
      requested_at: date,
      expires_at: date,
      decided_at: nullableDate,
      decided_by: nullableText,
    }),
    StageRequest: workObject(
      {
        transition_id: text,
        version,
        note: { type: "string", maxLength: 500 },
      },
      ["transition_id", "version"],
    ),
    StageApprovalRequest: workObject({ transition_id: text, version }),
    StageApprovalDecisionRequest: workObject({
      decision: { enum: ["approve", "decline"] },
      approval_version: version,
      version,
    }),
    PrivateFields: workObject({
      fields: { type: "array", items: workRef("WorkField") },
      id: text,
      version,
      extra: workRef("ExtraValues"),
    }),
    PrivateFieldsRequest: workObject({
      version,
      extra: workRef("ExtraValues"),
    }),
    PrivateFieldsResult: workObject({
      id: text,
      version,
      changed_fields: strings,
    }),
    VersionRequest: workObject({ version }),
    MutationRef: workObject({ id: text, order_id: text, version }),
    ServiceOrderList: {
      ...workObject(
        {
          data: array(workRef("ServiceOrder")),
          next_cursor: nullableText,
          counts,
          facets: workObject(
            {
              types: {
                type: "object",
                additionalProperties: { type: "integer", minimum: 0 },
              },
              stages: {
                type: "object",
                additionalProperties: { type: "integer", minimum: 0 },
              },
            },
            ["types"],
          ),
        },
        ["data", "next_cursor", "counts"],
      ),
      example: {
        data: Object.values(workOrderExamples()).reverse(),
        next_cursor: null,
        counts: { received: 1, in_progress: 1 },
      },
    },
    ConversationOrders: workObject({ data: array(workRef("ServiceOrder")) }),
    OrderHistory: workObject(
      {
        id: text,
        kind: text,
        from_status: {
          type: ["string", "null"],
          enum: [...workStatuses(), null],
        },
        to_status: {
          type: ["string", "null"],
          enum: [...workStatuses(), null],
        },
        actor: text,
        note: text,
        created: date,
        from_stage: nullableText,
        to_stage: nullableText,
        entity_kind: { enum: ["task", "person", "document", "entry", null] },
        entity_id: nullableText,
        entity_version: { type: ["integer", "null"], minimum: 1 },
        mutation_key: nullableText,
        changed_fields: strings,
      },
      ["id", "kind", "from_status", "to_status", "actor", "created"],
    ),
    OrderHistoryPage: page("OrderHistory"),
    CreateTaskRequest: {
      ...workObject({ ...task, sensitive: { enum: [false] } }, ["title", "audience", "client_visible", "sensitive"]),
      description:
        "audience=customer exige client_visible=true e sensitive=false. remind_at exige due_at e não pode ser posterior ao prazo.",
    },
    UpdateTaskRequest: workObject({ ...task, sensitive: { enum: [false] }, version, state: taskState }, [
      "version",
    ]),
    CreatePrivateTaskRequest: {
      ...workObject(task, ["title", "audience", "client_visible", "sensitive"]),
      description: "Operação privada exige os:sensitive mesmo com sensitive=false. Tarefa sensitive=true exige audience=staff e client_visible=false.",
      anyOf: [
        { properties: { sensitive: { enum: [false] } } },
        { properties: { sensitive: { enum: [true] }, audience: { enum: ["staff"] }, client_visible: { enum: [false] } } },
      ],
    },
    UpdatePrivateTaskRequest: {
      ...workObject({ ...task, version, state: taskState }, ["version"]),
      description: "Valida os campos combinados com a tarefa existente. Não permite retirar sensitive=true; tarefa sensível exige audience=staff e client_visible=false.",
    },
    Task: workObject(
      {
        ...child,
        ...task,
        state: taskState,
        notified_at: nullableDate,
        completed_at: nullableDate,
      },
      [
        ...childRequired,
        "title",
        "description",
        "assignee",
        "audience",
        "due_at",
        "remind_at",
        "state",
        "notified_at",
        "completed_at",
      ],
    ),
    TaskPage: page("Task"),
    MyTask: workObject({
      ...child, ...task, state: taskState,
      notified_at: nullableDate, completed_at: nullableDate,
      type_id: text, type_label: text, display_number: text, stage_label: text,
    }, [...new Set([...childRequired, ...Object.keys(task), "state", "notified_at", "completed_at",
      "type_id", "type_label", "display_number", "stage_label"])]),
    MyTaskPage: page("MyTask"),
    EntrySummary: workObject({ data: array(workObject({
      kind: text, unit: text, count: { type: "integer", minimum: 1 },
      quantity_milli: {
        type: ["string", "null"], pattern: "^[0-9]+$",
        description: "Soma exata em milésimos como texto; null se todas as quantidades do grupo forem nulas.",
      },
    })) }),
    CreatePersonRequest: workObject(person, [
      "role",
      "name",
      "client_visible",
      "sensitive",
    ]),
    UpdatePersonRequest: workObject({ ...person, version }, ["version"]),
    LinkedPerson: {
      ...workObject({ ...child, ...person }, [
        ...childRequired,
        "role",
        "name",
      ]),
      description:
        "Contato e nota dependem dos escopos. Vínculo não concede acesso à ordem.",
    },
    LinkedPersonPage: page("LinkedPerson"),
    CreateDocumentRequest: workObject({ ...document, sensitive: { enum: [false] } }),
    CreatePrivateDocumentRequest: workObject({
      ...document, sensitive: { enum: [true] }, client_visible: { enum: [false] },
    }),
    DocumentMetadata: workObject(
      {
        ...child,
        ...document,
        byte_length: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 10485760,
        },
        sha256: nullableText,
        state: { enum: ["pending", "ready", "aborted"] },
        upload_expires_at: date,
      },
      [
        ...childRequired,
        ...Object.keys(document),
        "byte_length",
        "sha256",
        "state",
        "upload_expires_at",
      ],
    ),
    DocumentMetadataPage: page("DocumentMetadata"),
    DocumentReservation: workObject({
      id: text,
      order_id: text,
      version,
      upload_url: text,
      expires_at: date,
    }),
    DocumentUploadResult: workObject({
      id: text,
      version,
      upload_attempt: text,
      byte_length: { type: "integer", minimum: 1, maximum: 10485760 },
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
    CompleteDocumentRequest: workObject({ version, upload_attempt: text }),
    SendDocumentResult: workObject({ id: text, message_id: text }),
    CreateEntryRequest: workObject(entry, entryRequired),
    ReviseEntryRequest: workObject({ ...entry, version }, [
      ...entryRequired,
      "version",
    ]),
    Entry: workObject({ ...child, ...entry, replaces_id: nullableText }, [
      ...childRequired,
      ...Object.keys(entry),
      "replaces_id",
    ]),
    EntryPage: page("Entry"),
    AreaModuleId: { enum: modules },
    AreaBotSuggestion: workObject({
      instructions: text,
      allowed_operations: strings,
      denied_operations: strings,
      suggested_roles: strings,
    }),
    TemplateMenu: {
      oneOf: [
        workObject({
          ...menu,
          type: { enum: ["os_open", "os_track"] },
          type_id: text,
        }),
        workObject({
          ...menu,
          type: { enum: ["human"] },
          department_id: nullableText,
        }),
        workObject({ ...menu, type: { enum: ["message"] }, content: text }),
      ],
    },
    AreaTemplate: {
      ...workObject({
        schema_version: { enum: [1] },
        id: text,
        version,
        name: text,
        description: text,
        work_types: array(workRef("CustomWorkType"), 20),
        object_types: array(workRef("ServiceObjectType"), 20),
        modules: workObject(
          Object.fromEntries(modules.map((name) => [name, bool])),
          [],
        ),
        vocabulary: workRef("OsVocabulary"),
        departments: array(
          workObject({
            id: text,
            name: text,
            members: { type: "array", maxItems: 0 },
            enabled: { enum: [true] },
          }),
        ),
        ticket_categories: array(
          workObject({ id: text, name: text, enabled: { enum: [true] } }),
        ),
        menus: array(workRef("TemplateMenu")),
        texts: workObject(
          {
            instructions: text,
            menu_greeting: text,
            protocol_confirmation: text,
          },
          [],
        ),
        bot: workRef("AreaBotSuggestion"),
        manual_steps: strings,
      }, ["schema_version", "id", "version", "name", "description", "work_types", "modules", "vocabulary", "departments", "ticket_categories", "menus", "texts", "bot", "manual_steps"]),
      description:
        "Manifesto declarativo até 128 KiB UTF-8, sem código ou dados pessoais de ordens. message é convertido em content pelo compilador; sugestões não concedem papéis nem permissões.",
    },
    AreaSetup: workObject({
      template_id: text,
      bot: workRef("AreaBotSuggestion"),
      manual_steps: strings,
    }),
    AreaTemplateSelection: selection,
    TemplateChange: workObject({
      path: text,
      action: { enum: ["add", "set", "keep", "skip"] },
      reason: text,
    }),
    AreaTemplatePreviewRequest: templateRequest(false),
    AreaTemplateApplyRequest: templateRequest(true),
    AreaTemplatePreview: workObject({
      preview_hash: text,
      template_id: text,
      template_version: version,
      changes: array(workRef("TemplateChange")),
      conflicts: array(workObject({ path: text, code: text, message: text })),
      manual_steps: strings,
      can_apply: bool,
    }),
    AreaTemplateApplyResult: workObject({
      applied: bool,
      changes: array(workRef("TemplateChange")),
      manual_steps: strings,
      settings_revision: text,
    }),
    AreaTemplateExportRequest: workObject({
      id: text,
      name: text,
      type_ids: strings,
    }),
    AreaTemplateCatalog: workObject({
      data: array(
        workObject({ id: text, version, name: text, description: text }),
      ),
    }),
  };
}

type WorkOperation = [
  method: string,
  path: string,
  summary: string,
  input: string | null,
  output: string,
  errors: string,
  query: string[],
  description: string,
  operation?: string,
];

function workMotorContract(): WorkOperation[] {
  const b = "/profiles/{profile}/service-orders";
  const o = `${b}/{id}`;
  const c = `${b}/conversation/{id}/orders/{order_id}`;
  const a = "/profiles/{profile}/area-templates";
  const page = ["cursor", "limit"];
  const routes: WorkOperation[] = [
    [
      "get", `${b}/my-tasks`, "Trabalhos: meus prazos", null, "MyTaskPage",
      "400 invalid_filter;400 invalid_cursor;403 forbidden",
      ["assignee", "state", "period", "type_id", "due_from", "due_to", ...page],
      "Exige pessoa autenticada, sem bot, aplicação ou credencial limitada à conversa. Somente tarefas atribuídas ao solicitante; assignee=me. state padrão open; period padrão dated (com prazo). range exige due_from e due_to como datas civis inclusivas em Brasília. Ordena por prazo e ID. Inclui type_id, type_label, display_number e stage_label do snapshot do pai; registros sensíveis exigem os:sensitive.",
    ],
    [
      "get", `${o}/entries/summary`, "Trabalhos: resumo de lançamentos", null, "EntrySummary",
      "400 invalid_filter", ["kind", "include_archived"],
      "Agrupa somente lançamentos autorizados por kind e unit. Retorna count e quantity_milli como string decimal exata ou null; não usa cursor nem limite. include_archived=1 inclui correções arquivadas, conforme autorização.",
    ],
    [
      "get",
      b,
      "Trabalhos: listar ordens",
      null,
      "ServiceOrderList",
      "400 invalid_filter",
      [
        "status",
        "open",
        "q",
        "phone",
        "conversation_id",
        "limit",
        "cursor",
        "type_id",
        "type_ids",
        "stage",
        "facets",
        "assignee",
        "due_from",
        "due_to",
        "field_filter",
      ],
      "Ordena pelo número global decrescente; cursor continua texto. stage exige type_id. type_ids aceita até 21 IDs separados por vírgula para filtrar vários modelos sem alterar a paginação; omitir conserva a consulta legada. assignee aceita ID, me ou unassigned; due_from/due_to são limites inclusivos do prazo geral, em milissegundos Unix. Tipos personalizados incluem next_task, a próxima tarefa aberta autorizada, ou null. counts é esparso e sempre da área inteira, independente de filtros. facets=1 acrescenta types e, com type_id, stages; não substitui counts. Busca não pesquisa valores sensíveis. field_filter é JSON de OrderFieldFilter: exige um modelo e uma geração ready, examina no máximo 200 candidatos e devolve até 50 ordens, counts=null e counts_scope=not_computed. Igualdade ordena por número decrescente; intervalo por valor crescente, número/ID decrescente. Cursor preserva candidatos ainda não consumidos.",
    ],
    [
      "get",
      `${b}/types`,
      "Trabalhos: catálogo de tipos",
      null,
      "WorkTypeCatalog",
      "403 forbidden",
      ["include_archived"],
      "Inclui service_order virtual e settings_revision. include_archived=1 somente para equipe. Definições são filtradas por acesso; configuração integral é administrativa.",
    ],
    [
      "get",
      `${b}/types/{type_id}`,
      "Trabalhos: consultar tipo",
      null,
      "WorkTypeView",
      "404 type_not_found",
      [],
      "Retorna a definição atual resolvida, filtrada para o solicitante. Ordens existentes conservam a definição fixada na abertura.",
    ],
    [
      "get",
      o,
      "Ordem de serviço com histórico",
      null,
      "ServiceOrder",
      "404 not_found",
      ["history"],
      "history=legacy é o padrão e conserva o histórico antigo. A tela nova usa history=none e consulta /history separadamente.",
    ],
    [
      "get",
      `${o}/history`,
      "Trabalhos: histórico paginado",
      null,
      "OrderHistoryPage",
      "400 invalid_cursor",
      page,
      "Histórico completo, incluindo filhos. Novos eventos contêm IDs, versões, transições e nomes de campos alterados, sem valores sensíveis.",
    ],
    [
      "post",
      b,
      "Abrir ordem de serviço ou trabalho",
      "ServiceOrderCreate",
      "ServiceOrder",
      "404 type_not_found;409 type_archived;400 invalid_fields;409 sequence_exhausted",
      [],
      "Sem type_id, abre service_order e conserva o fluxo anterior. item e problem continuam obrigatórios e textuais. Tipo personalizado fixa uma cópia imutável da definição e termos. number é global e type_number é próprio do tipo; ambos até 2147483647.",
    ],
    [
      "patch",
      o,
      "Alterar dados da ordem de serviço",
      "ServiceOrderUpdate",
      "ServiceOrder",
      "409 version_conflict;400 immutable_field;400 invalid_fields",
      [],
      "extra contém somente campos comuns autorizados; version confere concorrência quando informado. Identidade do tipo não é editável. No embutido encerrado, somente notes pode mudar. Alterar campos cancela aprovação de etapa pendente.",
    ],
    [
      "post",
      `${o}/status`,
      "Mudar o estado da ordem de serviço",
      "ServiceOrderStatus",
      "ServiceOrder",
      "409 invalid_transition;409 stage_required",
      [],
      "Embutido: recebida → em análise, em execução ou cancelada; em análise → em execução ou cancelada; orçamento enviado → em análise ou cancelada; aprovada → em execução ou cancelada; recusada → em análise, pronta ou cancelada; em execução → pronta ou cancelada; pronta → entregue, em execução ou cancelada. No personalizado exige uma única transição manual elegível que altere o estado de base, sem aprovação nem desvio do orçamento. Ausência: invalid_transition; ambiguidade ou ação própria de etapa: stage_required. Nunca escolher a primeira transição.",
    ],
    [
      "post",
      `${o}/stage`,
      "Trabalhos: executar transição",
      "StageRequest",
      "ServiceOrder",
      "409 invalid_transition;409 version_conflict;409 approval_required",
      [],
      "Recebe transition_id, nunca um destino livre. Transição entre etapas do mesmo estado aparece somente em next_stages; não reinicia datas de garantia ou retirada. Cancela aprovação pendente ao mudar etapa.",
    ],
    [
      "put",
      `${o}/quote`,
      "Salvar o orçamento da ordem de serviço",
      "ServiceOrderQuote",
      "ServiceOrder",
      "409 feature_disabled;409 invalid_transition",
      [],
      "Embutido: somente received, analyzing, quoted e declined. Alterar orçamento enviado volta a analyzing. Tipo personalizado usa a política de orçamento da definição fixada. Alterar orçamento cancela aprovação de etapa pendente.",
    ],
    [
      "post",
      `${o}/quote/send`,
      "Enviar o orçamento ao cliente",
      "ServiceOrderQuoteSend",
      "ServiceOrder",
      "409 feature_disabled;409 invalid_transition;409 no_conversation",
      [],
      "Fixa validade no fim do dia em Brasília, incrementa quote.version e passa a quoted pela etapa de envio. notify=false só registra envio por outro meio. Fora da janela de 24 horas usa modelo de notificação.",
    ],
    [
      "post",
      `${o}/decision`,
      "Registrar aprovação ou recusa do orçamento",
      "ServiceOrderDecision",
      "ServiceOrder",
      "409 quote_expired;409 quote_not_pending;409 feature_disabled",
      [],
      "Entrada approve/decline; saída decision.decision continua approved/declined. Usa a política de orçamento e preserva o protocolo legado; não decide aprovação de etapa.",
    ],
    [
      "post",
      `${o}/stage-approval`,
      "Trabalhos: pedir aprovação de etapa",
      "StageApprovalRequest",
      "ServiceOrder",
      "409 approval_pending;409 invalid_transition;409 version_conflict",
      [],
      "Solicita transição customer_approval, com origem, destino, prazo e versão próprios; independente do orçamento.",
    ],
    [
      "post",
      `${o}/stage-approval/decision`,
      "Trabalhos: decidir aprovação de etapa",
      "StageApprovalDecisionRequest",
      "ServiceOrder",
      "409 approval_expired;409 approval_not_pending;409 version_conflict",
      [],
      "Confere approval_version, version da ordem, titular, origem e validade. Aprovar executa a transição registrada; recusar conserva a etapa de origem.",
    ],
    [
      "get",
      `${o}/private-fields`,
      "Trabalhos: ler campos sensíveis",
      null,
      "PrivateFields",
      "403 sensitive_forbidden",
      [],
      "Somente campos sensíveis autorizados. Exige pessoa autenticada, papel explícito os:sensitive e ausência de via; administrador não substitui o papel. Bots, aplicações e conectores são recusados.",
    ],
    [
      "patch",
      `${o}/private-fields`,
      "Trabalhos: alterar campos sensíveis",
      "PrivateFieldsRequest",
      "PrivateFieldsResult",
      "403 sensitive_forbidden;409 version_conflict;400 invalid_fields",
      [],
      "Mesma barreira da leitura privada. Responde apenas id, version e changed_fields, nunca valores. Operação fora do catálogo de IA e em bot.deny.",
    ],
    [
      "get",
      `${o}/tasks`,
      "Trabalhos: listar tarefas",
      null,
      "TaskPage",
      "400 invalid_filter",
      ["state", ...page],
      "Somente registros autorizados. Até 500 tarefas por ordem, contando arquivadas.",
    ],
    [
      "post",
      `${o}/tasks`,
      "Trabalhos: criar tarefa",
      "CreateTaskRequest",
      "MutationRef",
      "400 invalid_task;409 collection_limit",
      [],
      "audience=customer exige client_visible=true e sensitive=false. remind_at exige due_at e não pode ultrapassá-lo. Limite 500 incluindo arquivadas.",
    ],
    [
      "patch",
      `${o}/tasks/{task_id}`,
      "Trabalhos: alterar tarefa",
      "UpdateTaskRequest",
      "MutationRef",
      "409 version_conflict;400 invalid_task",
      [],
      "Versão do próprio filho, sem exigir versão do pai. Admite state=open/done/cancelled.",
    ],
    [
      "post",
      `${o}/tasks/{task_id}/archive`,
      "Trabalhos: arquivar tarefa",
      "VersionRequest",
      "MutationRef",
      "409 version_conflict",
      [],
      "Arquiva sem apagar registro ou histórico.",
    ],
    [
      "get",
      `${o}/people`,
      "Trabalhos: listar pessoas ligadas",
      null,
      "LinkedPersonPage",
      "",
      page,
      "Telefone, contato e nota dependem dos escopos existentes. O vínculo não concede acesso à ordem.",
    ],
    [
      "post",
      `${o}/people`,
      "Trabalhos: vincular pessoa",
      "CreatePersonRequest",
      "MutationRef",
      "400 invalid_person;404 contact_not_found;409 collection_limit",
      [],
      "Contato deve pertencer à área. Até 200 pessoas por ordem, incluindo arquivadas. Ser responsável, tutor ou contratante não muda o titular autorizado.",
    ],
    [
      "patch",
      `${o}/people/{person_id}`,
      "Trabalhos: alterar pessoa ligada",
      "UpdatePersonRequest",
      "MutationRef",
      "409 version_conflict",
      [],
      "Versão própria; não amplia acesso ao trabalho.",
    ],
    [
      "post",
      `${o}/people/{person_id}/archive`,
      "Trabalhos: arquivar pessoa ligada",
      "VersionRequest",
      "MutationRef",
      "409 version_conflict",
      [],
      "Retira da lista corrente, preservando histórico.",
    ],
    [
      "get",
      `${o}/documents`,
      "Trabalhos: listar documentos",
      null,
      "DocumentMetadataPage",
      "",
      page,
      "Somente metadados autorizados; nunca chave R2, tentativa privada ou URL pública de mídia.",
    ],
    [
      "post",
      `${o}/documents`,
      "Trabalhos: reservar documento",
      "CreateDocumentRequest",
      "DocumentReservation",
      "413 document_too_large;415 unsupported_media_type;409 collection_limit",
      [],
      "Rota comum exige sensitive=false; use private-documents para conteúdo sensível. Reserva pending por 24 horas, até 10 MiB reais. Até 500 documentos incluindo arquivados. A concessão de cada tentativa de upload dura cinco minutos.",
    ],
    [
      "put",
      `${o}/documents/{document_id}/content`,
      "Trabalhos: enviar conteúdo binário",
      null,
      "DocumentUploadResult",
      "409 upload_busy;409 upload_expired;413 document_too_large",
      [],
      "Corpo binário; Upload-Version informa a versão e Idempotency-Key identifica a tentativa. Autoriza antes de ler bytes. Calcula SHA-256 no servidor. Repetir a mesma chave recupera upload concluído, sem sobrescrever objeto confirmado. É necessário confirmar em /complete.",
    ],
    [
      "post",
      `${o}/documents/{document_id}/complete`,
      "Trabalhos: confirmar documento",
      "CompleteDocumentRequest",
      "MutationRef",
      "409 upload_incomplete;409 content_mismatch",
      [],
      "Confere tentativa atual, objeto, tamanho e hash antes de mudar para ready. Upload pendente não pode ser baixado.",
    ],
    [
      "get",
      `${o}/documents/{document_id}/content`,
      "Trabalhos: baixar documento autenticado",
      null,
      "binary",
      "404 not_found;409 document_not_ready",
      [],
      "Autoriza área, ordem, documento, classificação e solicitante antes de abrir o objeto. Cache-Control: no-store. Retorna o MIME cadastrado. Documento sensível nesta rota retorna 404 not_found, inclusive para pessoa com os:sensitive; use private-documents.",
    ],
    [
      "post",
      `${o}/documents/{document_id}/send`,
      "Trabalhos: enviar documento ao cliente",
      "VersionRequest",
      "SendDocumentResult",
      "403 document_not_shareable;409 no_conversation;409 document_not_ready",
      [],
      "Exige documento pronto, client_visible=true, sensitive=false e permissão para mensagem. Cria anexo compartilhável pelo adaptador do núcleo.",
    ],
    [
      "post",
      `${o}/documents/{document_id}/archive`,
      "Trabalhos: arquivar documento",
      "VersionRequest",
      "MutationRef",
      "409 version_conflict",
      [],
      "Oculta da lista corrente, sem apagar imediatamente o objeto. Eliminação definitiva fora deste contrato.",
    ],
    [
      "get",
      `${o}/entries`,
      "Trabalhos: listar lançamentos",
      null,
      "EntryPage",
      "400 invalid_filter",
      ["kind", ...page, "include_archived"],
      "Ordenação por chave occurred_at e id; include_archived inclui o histórico de correções autorizado.",
    ],
    [
      "post",
      `${o}/entries`,
      "Trabalhos: criar lançamento",
      "CreateEntryRequest",
      "MutationRef",
      "400 invalid_entry;409 collection_limit",
      [],
      "Até 10000 lançamentos incluindo arquivados. Texto, quantidade em milésimos e data são imutáveis; não cria movimento financeiro no ERP.",
    ],
    [
      "post",
      `${o}/entries/{entry_id}/revisions`,
      "Trabalhos: corrigir lançamento",
      "ReviseEntryRequest",
      "MutationRef",
      "409 version_conflict;409 entry_replaced;409 collection_limit",
      [],
      "Envia versão do anterior e todos os campos obrigatórios da correção. Cria novo lançamento com replaces_id e arquiva o anterior no mesmo lote. Retorna referência do novo.",
    ],
    [
      "post",
      `${o}/entries/{entry_id}/archive`,
      "Trabalhos: arquivar lançamento",
      "VersionRequest",
      "MutationRef",
      "409 version_conflict",
      [],
      "Arquiva sem apagar conteúdo ou histórico.",
    ],
    [
      "get",
      `${b}/conversation/{id}`,
      "Ordens de serviço do cliente de uma conversa (bot)",
      null,
      "ConversationOrders",
      "",
      ["open", "type_id"],
      "Ordens do titular autenticado da conversa. Sem campos internos ou sensíveis novos; não aceita telefone como substituto da identidade.",
    ],
    [
      "get",
      c,
      "Trabalhos: detalhe do cliente",
      null,
      "ServiceOrder",
      "404 not_found",
      [],
      "Projeção pública da ordem; confere conversa da credencial e titular no servidor.",
    ],
    [
      "get",
      `${c}/tasks`,
      "Trabalhos: tarefas do cliente",
      null,
      "TaskPage",
      "",
      page,
      "Somente tarefas client_visible=true e sensitive=false do titular autenticado.",
    ],
    [
      "get",
      `${c}/documents`,
      "Trabalhos: documentos do cliente",
      null,
      "DocumentMetadataPage",
      "",
      page,
      "Somente metadados compartilháveis do titular autenticado, sem chave de armazenamento.",
    ],
    [
      "get",
      `${c}/entries`,
      "Trabalhos: lançamentos do cliente",
      null,
      "EntryPage",
      "",
      page,
      "Somente lançamentos visíveis e não sensíveis do titular autenticado.",
    ],
    [
      "get",
      a,
      "Modelos de área: catálogo",
      null,
      "AreaTemplateCatalog",
      "403 forbidden",
      [],
      "Catálogo resumido de modelos declarativos.",
    ],
    [
      "get",
      `${a}/{template_id}`,
      "Modelos de área: manifesto",
      null,
      "AreaTemplate",
      "404 template_not_found",
      [],
      "Manifesto com tipos, módulos, menus, vocabulário, sugestões e passos manuais.",
    ],
    [
      "post",
      `${a}/preview`,
      "Modelos de área: prévia",
      "AreaTemplatePreviewRequest",
      "AreaTemplatePreview",
      "400 invalid_template;413 template_too_large;404 template_not_found",
      [],
      "Não grava. Informe exatamente template_id ou manifest, mais selection. Hash inclui manifesto, seleção, configuração completa, módulos, dependências, procedência e resultado. Importação até 128 KiB UTF-8.",
    ],
    [
      "post",
      `${a}/apply`,
      "Modelos de área: aplicar prévia",
      "AreaTemplateApplyRequest",
      "AreaTemplateApplyResult",
      "409 preview_stale;409 template_conflict;409 dependency_conflict;400 invalid_template;413 template_too_large;404 template_not_found",
      [],
      "Relê e recalcula preview_hash no comando. Confirma configurações, módulos e procedência no mesmo lote. Preserva edições manuais; não recria itens apagados nem repõe caminhos removidos. Reaplicação idêntica retorna applied=false. Prefixo area_<template_id>__<id_local>; não concede papéis nem amplia permissões de bots.",
    ],
    [
      "post",
      `${a}/export`,
      "Modelos de área: exportar",
      "AreaTemplateExportRequest",
      "AreaTemplate",
      "400 invalid_export;404 type_not_found",
      [],
      "Não grava. Exporta configuração declarativa dos type_ids, sem dados pessoais de ordens, filhos, membros ou segredos.",
    ],
  ];
  const objectErrors = "400 invalid_fields;409 customer_required;409 object_required;409 object_archived;409 object_definition_conflict;409 object_limit;409 idempotency_conflict";
  const ownerAccess = "Exige acesso ao módulo, à área e ao contato canônico ativo no namespace team. Identificador nunca concede acesso. A configuração administrativa delimita o acesso de IA, desligado por padrão. ";
  const objectRoutes: WorkOperation[] = [
    ["get", `${b}/object-types`, "Objetos: tipos autorizados", null, "ObjectTypeCatalog", objectErrors, ["include_archived"], "Retorna a revisão dos settings e definições autorizadas. Salvar os_object_types, os_work_types e settings_revision juntos no PUT /settings existente.", "os.object_types.list"],
    ["get", `${b}/objects`, "Objetos: listar do contato", null, "ServiceObjectPage", objectErrors, ["contact_id", "type_id", "include_archived", ...page], ownerAccess + "Página de até 50 objetos, com arquivados somente quando solicitado e autorizado.", "os.objects.list"],
    ["post", `${b}/objects`, "Objetos: cadastrar", "CreateServiceObjectRequest", "ServiceObjectView", objectErrors, [], ownerAccess + "Até 100 objetos por contato incluindo arquivados e 30 ativos por contato/tipo; contagem conferida na transação. Recibo delimitado por área, ator, operação e Idempotency-Key.", "os.objects.create"],
    ["get", `${b}/objects/{object_id}`, "Objetos: consultar ficha", null, "ServiceObjectView", objectErrors, [], ownerAccess + "Definição adotada, valores autorizados, versão e último atendimento delivered por delivered_at, número/ID. Data legada ausente permanece indisponível.", "os.objects.get"],
    ["patch", `${b}/objects/{object_id}`, "Objetos: alterar ficha", "UpdateServiceObjectRequest", "ServiceObjectView", objectErrors, [], ownerAccess + "Não modifica cópias em ordens. adopt_revision é explícito e valida os valores pela nova definição; requer versão esperada.", "os.objects.update"],
    ["post", `${b}/objects/{object_id}/archive`, "Objetos: arquivar ou reativar", "ArchiveServiceObjectRequest", "ServiceObjectView", objectErrors, [], ownerAccess + "Não há DELETE público. Arquivamento impede novas seleções; reativação confere os limites na transação.", "os.objects.archive"],
    ["get", `${b}/objects/{object_id}/private-fields`, "Objetos: ler campos privados", null, "ObjectPrivateFields", objectErrors, [], ownerAccess + "Requer autorização específica para dados sensíveis. A projeção comum nunca os inclui.", "os.objects.private.read"],
    ["patch", `${b}/objects/{object_id}/private-fields`, "Objetos: alterar campos privados", "ObjectPrivateFieldsRequest", "PrivateFieldsResult", objectErrors, [], ownerAccess + "Escrita privada separada, com versão esperada; devolve somente IDs de campos alterados.", "os.objects.private.update"],
    ["get", `${b}/objects/{object_id}/orders`, "Objetos: histórico de ordens", null, "OrderHistoryObjectsPage", objectErrors, page, ownerAccess + "Até 50 ordens por abertura decrescente. Campos desta ordem vêm dos snapshots históricos autorizados; sem lookup de objeto por linha.", "os.objects.orders"],
    ["post", `${o}/object-link`, "Objetos: vincular ordem antiga", "LegacyObjectLinkRequest", "ServiceOrder", objectErrors, [], ownerAccess + "Somente personalizada sem vínculo, inclusive encerrada; criação opcional, vínculo e recibo atômicos. Captura legacy_link na data atual. Não move valores históricos nem copia campos sensíveis para públicos.", "os.object.link"],
    ["get", `${o}/requirements`, "Trabalhos: requisitos da etapa", null, "OrderRequirements", "400 invalid_fields;409 missing_fields", ["transition_id"], "Usa a ordem e seus snapshots. Expõe somente rótulos autorizados e a versão observada; pendências internas do cliente são genéricas. Não consulta o cadastro atual do objeto.", "os.requirements"],
    ["get", `${b}/types/{type_id}/field-index`, "Trabalhos: estado do índice de campos", null, "FieldIndexState", "409 field_index_building", [], "Administrador consulta geração, progresso e versões excluídas. A lista comum continua funcionando durante a construção.", "os.field_index.get"],
    ["post", `${b}/types/{type_id}/field-index/rebuild`, "Trabalhos: construir índice de campos", "FieldIndexRebuildRequest", "FieldIndexState", "409 field_index_building;409 idempotency_conflict", [], "Comando administrativo explícito com geração/cursor esperados; até cinco ordens e 50 instruções por invocação. Não há construção síncrona em consultas ou novo agendador.", "os.field_index.rebuild"],
    ["get", `${b}/conversation/{id}/objects`, "Objetos: consultar titular da conversa", null, "ServiceObjectPage", objectErrors, ["type_id", ...page], "Resolve o titular autorizado da conversa antes de consultar. Somente objetos próprios e campos públicos, até 50; contact_id, telefone e identificador enviados no corpo não autorizam acesso.", "os.conversation.objects.list"],
    ["get", `${b}/conversation/{id}/objects/{object_id}`, "Objetos: ficha do titular da conversa", null, "ConversationObjectDetail", objectErrors, page, "Reautoriza área e titular canônico confirmado; devolve ficha e histórico público paginado, exclusivamente do titular. Conhecer object_id não concede acesso.", "os.conversation.objects.get"],
  ];
  routes.push(...objectRoutes);
  for (const route of routes) {
    if (route[1] === b && route[0] === "post") {
      route[5] += ";409 customer_required;409 object_required;409 object_archived;409 object_definition_conflict;409 idempotency_conflict;409 object_limit";
      route[7] += " Em modelo com objeto, exige seleção existente com versão ou cadastro inline. Objeto, contadores, ordem, índices, históricos e recibo confirmam no mesmo lote; extra guarda somente campos desta ordem.";
    }
    if (route[1] === b && route[0] === "get") route[5] += ";409 field_index_building;400 invalid_fields";
    if (route[0] !== "get" && (route[1] === o || /\/(status|stage|quote|quote\/send|decision|stage-approval|stage-approval\/decision|private-fields)$/.test(route[1]))) {
      route[5] += ";409 missing_fields";
      route[7] += " Regras por etapa validam os valores resultantes antes de qualquer efeito; exigências ativadas persistem em retornos. Cancelamento não exige completar campos. Pendência interna tem mensagem genérica ao cliente; requirements fornece rótulos autorizados.";
    }
  }
  // As famílias privadas compartilham transporte e versões, mas nunca /send.
  const privateAccess = "Exige pessoa autenticada com papel explícito os:sensitive e sem via; administrador não substitui o papel. Fora do catálogo de IA e negado ao bot. ";
  for (const route of [...routes]) {
    const [method, path, summary, input, output, errors, query, description] = route;
    const task = path.startsWith(`${o}/tasks`) && method !== "get";
    const document = path.startsWith(`${o}/documents`) && !path.endsWith("/send");
    if (!task && !document) continue;
    const privateInput: Record<string, string> = {
      CreateTaskRequest: "CreatePrivateTaskRequest",
      UpdateTaskRequest: "UpdatePrivateTaskRequest",
      CreateDocumentRequest: "CreatePrivateDocumentRequest",
    };
    routes.push([
      method, path.replace(task ? "/tasks" : "/documents", task ? "/private-tasks" : "/private-documents"),
      `${summary} (privado)`, input ? privateInput[input] ?? input : null,
      output, `${errors};403 sensitive_forbidden`, query,
      privateAccess + (task
        ? "Mesmo corpo e versão da tarefa; admite sensitive=true somente com audience=staff e client_visible=false. Não permite reduzir sigilo. A leitura autorizada continua em GET /tasks. " + description
        : "Coleção exclusiva de documentos sensitive=true e client_visible=false. Use esta família desde a reserva até upload, confirmação, download e arquivamento. Não há envio ao cliente. " + description
          .replace("Rota comum exige sensitive=false; use private-documents para conteúdo sensível. ", "")
          .replace("Documento sensível nesta rota retorna 404 not_found, inclusive para pessoa com os:sensitive; use private-documents.", "")),
    ]);
    if (task) route[7] = description + " A rota comum recusa tarefas ou valores sensíveis com 403 sensitive_forbidden, mesmo com os:sensitive; use private-tasks.";
  }
  return routes;
}

function workMotorOperations(): [string, string, string, string?, string?][] {
  return workMotorContract().map(([method, path, summary, input]) => [
    method,
    path,
    summary,
    path.includes("/area-templates")
      ? undefined
      : method === "get"
        ? "conversations:read"
        : "conversations:write",
    input ?? undefined,
  ]);
}

function describeWorkMotorOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  const route = workMotorContract().find(
    ([m, p]) => m === method && p === path,
  );
  if (!route) return;
  const [, , , , output, specificErrors, queries, description, operation] = route;
  if (operation) entry.operationId = operation;
  const admin = path.includes("/area-templates");
  const base = "/profiles/{profile}/service-orders";
  const legacy = [base, `${base}/{id}`, `${base}/{id}/status`, `${base}/{id}/quote`,
    `${base}/{id}/quote/send`, `${base}/{id}/decision`, `${base}/conversation/{id}`].includes(path);
  entry.description =
    (admin
      ? "Exige administrador (pessoa autenticada). Funciona com os desligado. "
      : `Permissão: conversations:${method === "get" ? "read" : "write"}. Módulo ${legacy ? "Ordem de Serviço" : "de trabalhos"} (os); desligado, 409 module_disabled. `) +
    description;
  entry.description +=
    " Datas de instantes em milissegundos Unix. Parâmetros do caminho prevalecem sobre o corpo; profile não vem do corpo.";
  if (!admin && !operation)
    entry.description +=
      " Restrições de contatos e notas continuam valendo. Dados sensíveis exigem pessoa com os:sensitive explícito e sem via; administrador não substitui o papel. Filhos ocultos são omitidos inclusive de contagens; vínculo de pessoa não concede acesso.";
  if (operation)
    entry.description += " Acesso de IA segue os2_ai_access e os escopos autorizados, com padrão conservador. A configuração não amplia os dados próprios acessíveis ao titular externo. Dados sensíveis não integram projeções comuns.";
  const objectOperation = operation?.startsWith("os.objects.") || operation?.startsWith("os.conversation.objects.");
  if (method !== "get")
    entry.description +=
      " Escrita com Idempotency-Key; repetir a chave recupera o resultado sem repetir efeitos.";
  const paged = /\/(history|tasks|my-tasks|private-documents|people|documents|entries)$/.test(path);
  const childPage = paged && !path.endsWith("/history");
  if (paged && method === "get")
    entry.description +=
      path.endsWith("/my-tasks")
        ? " Página de no máximo 100 itens; cursor opaco vinculado à área, pessoa, filtros e janela civil. Sem OFFSET."
        : " Página de no máximo 100 itens; cursor opaco vinculado à área, ordem, coleção e filtros. Sem OFFSET. Carregar coleções sob demanda.";
  if (childPage && method === "get")
    entry.description += " Listas filhas usam 50 itens por padrão.";
  const querySchemas: Record<string, any> = {
    status: {
      type: "string",
      pattern: `^(${workStatuses().join("|")})(,(${workStatuses().join("|")}))*$`,
    },
    open: { enum: ["1", "0"] },
    facets: { enum: ["1", "0"] },
    type_ids: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63}){0,20}$" },
    include_archived: { enum: ["1", "0"] },
    field_filter: { type: "string", contentMediaType: "application/json", description: "JSON validado de OrderFieldFilter; um filtro próprio por consulta." },
    history: { enum: ["legacy", "none"], default: "legacy" },
    state: { enum: ["open", "done", "cancelled"], ...(path.endsWith("/my-tasks") ? { default: "open" } : {}) },
    assignee: path.endsWith("/my-tasks") ? { enum: ["me"], default: "me" } : { type: "string", description: "ID da pessoa, me ou unassigned." },
    period: { enum: ["dated", "overdue", "today", "next7", "range", "undated"], default: "dated" },
    due_from: path.endsWith("/my-tasks") ? { type: "string", format: "date" } : { type: "integer", minimum: 0 },
    due_to: path.endsWith("/my-tasks") ? { type: "string", format: "date" } : { type: "integer", minimum: 0 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: objectOperation ? 50 : paged ? 100 : 200,
      ...(childPage ? { default: 50 } : {}),
    },
  };
  for (const name of queries)
    entry.parameters.push({
      in: "query",
      name,
      schema: querySchemas[name] ?? { type: "string" },
      ...(name === "stage"
        ? { description: "Exige type_id; ID da etapa do tipo selecionado." }
        : {}),
    });
  const errors = new Map<string, Set<string>>();
  const common =
    "400 invalid_request;403 forbidden;404 not_found;409 version_conflict;413 payload_too_large;429 rate_limited" +
    (admin
      ? ""
      : ";403 sensitive_forbidden;409 module_disabled;409 feature_disabled") +
    (paged ? ";400 invalid_cursor" : "");
  for (const pair of `${common};${specificErrors}`.split(";")) {
    const [status, code] = pair.split(" ");
    if (!code) continue;
    const codes = errors.get(status) ?? new Set<string>();
    codes.add(code);
    errors.set(status, codes);
  }
  for (const [status, codes] of errors) {
    entry.responses[status] = {
      ...entry.responses[status],
      description:
        [...codes].join(", ") +
        (status === "400"
          ? ". Indica o caminho do campo sem repetir valores sensíveis."
          : ""),
      content: {
        "application/json": {
          schema: workRef("Error"),
          examples: Object.fromEntries(
            [...codes].map((code) => [
              code,
              {
                value: {
                  error: {
                    code,
                    message: workErrorMessage(code),
                    request_id: "req_example",
                  },
                },
              },
            ]),
          ),
        },
      },
    };
  }
  if (path.endsWith("/content")) {
    // O gerador central aplica convenções de mídia a todo /content.
    // Documentos seguem o contrato próprio, sem Range ou inline.
    entry.parameters = entry.parameters.filter(
      ({ in: location, name }: { in: string; name: string }) =>
        !(location === "header" && name === "Range") &&
        !(location === "query" && name === "inline"),
    );
    delete entry.responses["206"];
    delete entry.responses["416"];
    success.description =
      output === "binary" ? "Arquivo privado" : "Conteúdo recebido";
  }
  if (output === "binary") {
    success.content = Object.fromEntries(workDocumentMimeTypes().map((mime) => [
      mime, { schema: { type: "string", format: "binary" } },
    ]));
    success.headers = {
      ...success.headers,
      "Cache-Control": {
        schema: { type: "string", enum: ["no-store"] },
        description: "Sempre no-store, inclusive para documento público.",
      },
    };
  } else {
    // Upload recebe bytes, mas responde JSON; substitui o conteúdo binário
    // atribuído pelo gerador central antes de descrever o módulo.
    success.content = {
      "application/json": {
        schema:
          output === "ServiceOrderList"
            ? { oneOf: [workRef("ServiceOrderList"), workRef("FieldFilteredOrderList")] }
            : workRef(output),
      },
    };
    // Exemplos de equipe não podem ser reutilizados em respostas de cliente
    // nem em mutações cujo estado final depende da operação.
    if (output === "ServiceOrder" && (method === "get" || path.endsWith("/service-orders"))) {
      const examples: Record<string, any> = workOrderExamples();
      if (method === "post") {
        Object.assign(examples.custom, {
          status: "received", status_label: "Recebida", stage: "entrada", stage_label: "Entrada", version: 1,
          next_statuses: ["in_progress", "cancelled"],
          next_stages: [
            { transition_id: "iniciar_revisao", stage: "revisao", stage_label: "Revisão", base_status: "in_progress", kind: "manual" },
            { transition_id: "cancelar_entrada", stage: "cancelado", stage_label: "Cancelado", base_status: "cancelled", kind: "manual" },
          ],
        });
      }
      if (path.includes("/conversation/")) {
        for (const value of Object.values(examples)) {
          value.customer = { name: value.customer.name };
          for (const key of ["notes", "created_by", "assignee", "history"]) delete value[key];
          value.fields = value.fields.filter((field: any) => field.client_visible && !field.sensitive);
          value.extra = Object.fromEntries(value.fields.filter((field: any) => Object.hasOwn(value.extra, field.id)).map((field: any) => [field.id, value.extra[field.id]]));
          value.next_statuses = [];
          value.next_stages = [];
        }
      }
      success.content["application/json"].examples = Object.fromEntries(
        Object.entries(examples).map(([name, value]) => [
          name,
          { value },
        ]),
      );
    }
  }
  if (method === "put" && path.endsWith("/content")) {
    entry.parameters.push({
      in: "header",
      name: "Upload-Version",
      required: true,
      schema: { type: "integer", minimum: 1 },
      description: "Versão recebida na reserva do documento.",
    });
    entry.requestBody = {
      required: true,
      description:
        "Bytes reais do arquivo, de 1 a 10485760 bytes; tamanho conferido no servidor.",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    };
  }
}

function workErrorMessage(code: string) {
  const messages: Record<string, string> = {
    invalid_request: "Entrada inválida no campo version.",
    invalid_fields: "Campo extra não autorizado ou inválido.",
    version_conflict: "A versão mudou; releia o registro antes de alterar.",
    stage_required: "Selecione a transição pelo identificador da etapa.",
    sensitive_forbidden: "Acesso sensível não autorizado.",
    not_found: "Registro não encontrado.",
    preview_stale: "A configuração mudou; gere outra prévia.",
    upload_busy: "Há outra tentativa de envio ativa.",
    customer_required: "Confirme o contato do cliente antes de continuar.",
    object_required: "Selecione ou cadastre o objeto deste serviço.",
    object_archived: "Este objeto está arquivado. Reative o cadastro ou selecione outro.",
    object_definition_conflict: "As definições não são compatíveis. Revise a atualização do cadastro.",
    object_limit: "O limite de objetos foi atingido. Arquive um cadastro ativo antes de adicionar outro.",
    idempotency_conflict: "Esta chave já foi usada com outro conteúdo. Envie uma nova intenção.",
    missing_fields: "A equipe precisa completar os dados desta etapa.",
    field_index_building: "O índice está sendo construído. Retome a construção para usar este filtro.",
    not_implemented: "Este recurso ainda não está disponível.",
  };
  return messages[code] ?? `Operação recusada: ${code}.`;
}
