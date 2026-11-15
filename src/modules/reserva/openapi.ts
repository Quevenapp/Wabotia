// OpenAPI do módulo Reserva e check-in (docs/RESERVA.md, docs/API.md),
// acrescentado à lista dos módulos em src/modules/openapi.ts.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const reservaSchemas = {
  ReservaUnit: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", example: "Suíte Mar" },
      kind: { enum: ["room", "house", "court", "hall", "other"] },
      description: { type: "string" },
      capacity: { type: "integer", minimum: 1 },
      photos: { type: "array", items: { type: "string", format: "uri" } },
      mode: {
        enum: ["daily", "hourly"],
        description:
          "daily: entrada e saída em dias (diárias); hourly: início e duração.",
      },
      price_cents: {
        type: "integer",
        description: "Preço da diária (daily) ou da hora (hourly).",
      },
      active: { type: "boolean" },
      position: { type: "integer" },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  ReservaUnitInput: {
    type: "object",
    required: ["name", "mode", "price_cents"],
    properties: {
      name: { type: "string", maxLength: 80 },
      kind: { enum: ["room", "house", "court", "hall", "other"] },
      description: { type: "string", maxLength: 600 },
      capacity: { type: "integer", minimum: 1, maximum: 1000 },
      photos: {
        type: "array",
        maxItems: 6,
        items: { type: "string", format: "uri", pattern: "^https://" },
      },
      mode: { enum: ["daily", "hourly"] },
      price_cents: { type: "integer", minimum: 0 },
      active: { type: "boolean" },
      position: { type: "integer" },
    },
  },
  ReservaBlockInput: {
    type: "object",
    description:
      "Dias inteiros (from_date a to_date, inclusive) ou um intervalo starts/ends em ms. Sem unit_id, vale para todas as unidades.",
    properties: {
      unit_id: { type: ["string", "null"] },
      from_date: { type: "string", format: "date" },
      to_date: { type: "string", format: "date" },
      starts: { type: "integer" },
      ends: { type: "integer" },
      reason: { type: "string", maxLength: 200 },
    },
  },
  ReservaBooking: {
    type: "object",
    description:
      "Datas em ms Unix; start_date, end_date, arrival_time e departure_time já vêm no horário de Brasília. A ocupação é [starts, ends): por diária, da meia-noite da entrada à meia-noite da saída; por hora, do início ao fim.",
    properties: {
      id: { type: "string" },
      number: {
        type: "integer",
        description: "Número curto da reserva (#12).",
      },
      unit_id: { type: "string" },
      unit_name: { type: "string" },
      mode: { enum: ["daily", "hourly"] },
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
      starts: { type: "integer" },
      ends: { type: "integer" },
      arrival_at: { type: "integer" },
      departure_at: { type: "integer" },
      arrival_time: { type: "string", example: "14:00" },
      departure_time: { type: "string", example: "12:00" },
      nights: { type: ["integer", "null"] },
      duration_minutes: { type: ["integer", "null"] },
      guests: { type: "integer" },
      status: {
        enum: [
          "pending_payment",
          "confirmed",
          "cancelled",
          "expired",
          "completed",
        ],
      },
      conversation_id: { type: ["string", "null"] },
      contact_id: { type: ["string", "null"] },
      customer_name: { type: "string" },
      customer_phone: { type: "string" },
      notes: {
        type: "string",
        description: "Interna; não mostrar ao cliente.",
      },
      source: { enum: ["whatsapp", "panel", "api"] },
      price_cents: { type: "integer" },
      deposit_cents: { type: "integer" },
      payment_id: { type: ["string", "null"] },
      payment_status: {
        type: ["string", "null"],
        enum: ["created", "paid", "expired", "cancelled", "refunded", null],
      },
      payment_error: { type: ["string", "null"] },
      payment_due_at: { type: ["integer", "null"] },
      paid_at: { type: ["integer", "null"] },
      confirmed_at: { type: ["integer", "null"] },
      confirmed_by: { type: ["string", "null"] },
      checkin_status: { enum: ["none", "invited", "sent", "completed"] },
      checkin_step_id: { type: ["string", "null"] },
      checkin_sent_at: { type: ["integer", "null"] },
      checkin_at: { type: ["integer", "null"] },
      checkin_answers: { type: ["object", "null"] },
      reminded_at: { type: ["integer", "null"] },
      checkout_sent_at: { type: ["integer", "null"] },
      cancelled_at: { type: ["integer", "null"] },
      cancelled_by: { type: ["string", "null"] },
      cancel_reason: { type: "string" },
      changes: { type: "integer" },
      created_by: { type: "string" },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  ReservaBookingInput: {
    type: "object",
    required: ["unit_id"],
    description:
      "Por diária: start_date e end_date (ou nights). Por hora: starts (ms) e duration_minutes. Informe conversation_id ou customer_name.",
    properties: {
      unit_id: { type: "string" },
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date" },
      nights: { type: "integer", minimum: 1 },
      starts: { type: "integer" },
      duration_minutes: { type: "integer", minimum: 15, multipleOf: 15 },
      guests: { type: "integer", minimum: 1 },
      conversation_id: { type: "string" },
      customer_name: { type: "string", maxLength: 120 },
      customer_phone: { type: "string" },
      notes: { type: "string", maxLength: 1000 },
      deposit: {
        type: "boolean",
        description:
          "Cobrar o sinal das regras pela conversa (a reserva fica pending_payment).",
      },
      force: {
        type: "boolean",
        description: "Aceitar sobre um bloqueio (nunca sobre outra reserva).",
      },
      notify: { type: "boolean" },
    },
  },
  ReservaReason: {
    type: "object",
    properties: {
      reason: { type: "string", maxLength: 300 },
      notify: { type: "boolean" },
    },
  },
};

export const reservaOperations: [string, string, string, string?, string?][] = [
  [
    "get",
    "/profiles/{profile}/reserva",
    "Regras, unidades e estado do sinal (Reserva)",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/units",
    "Unidades reserváveis",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/units",
    "Cadastrar unidade",
    "",
    "ReservaUnitInput",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/units/{id}",
    "Consultar unidade",
    "conversations:read",
  ],
  [
    "put",
    "/profiles/{profile}/reserva/units/{id}",
    "Alterar unidade",
    "",
    "ReservaUnitInput",
  ],
  [
    "delete",
    "/profiles/{profile}/reserva/units/{id}",
    "Excluir (arquivar) unidade",
    "",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/blocks",
    "Bloqueios de datas",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/blocks",
    "Bloquear datas",
    "",
    "ReservaBlockInput",
  ],
  ["delete", "/profiles/{profile}/reserva/blocks/{id}", "Remover bloqueio", ""],
  [
    "get",
    "/profiles/{profile}/reserva/availability",
    "O que está livre no período (diárias) ou horários livres no dia (por hora)",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/calendar",
    "Ocupação por unidade e dia",
    "conversations:read",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/bookings",
    "Reservas",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/bookings",
    "Criar reserva",
    "conversations:write",
    "ReservaBookingInput",
  ],
  [
    "get",
    "/profiles/{profile}/reserva/bookings/{id}",
    "Consultar reserva (pagamento e check-in)",
    "conversations:read",
  ],
  [
    "patch",
    "/profiles/{profile}/reserva/bookings/{id}",
    "Alterar reserva (unidade, datas, horário, pessoas, cliente)",
    "conversations:write",
    "ReservaBookingInput",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/bookings/{id}/cancel",
    "Cancelar reserva",
    "conversations:write",
    "ReservaReason",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/bookings/{id}/confirm",
    "Confirmar reserva sem o sinal (equipe)",
    "conversations:write",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/bookings/{id}/deposit",
    "Cobrar (de novo) o sinal pela conversa",
    "conversations:write",
  ],
  [
    "post",
    "/profiles/{profile}/reserva/bookings/{id}/checkin",
    "Enviar o link do check-in",
    "conversations:write",
  ],
];

const EVENTS =
  " Eventos (GET /events e webhooks com conversations:read): reserva.created, reserva.confirmed, reserva.changed, reserva.cancelled, reserva.expired, reserva.completed, reserva.payment_late, reserva.checkin_sent e reserva.checkin_completed, com booking, conversation_id, actor e module_id. Com o módulo desligado, 409 module_disabled.";

export function describeReservaOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  entry.tags = ["Reserva"];
  const json = success.content["application/json"];
  const list = (name: string) => ({
    type: "object",
    properties: { data: { type: "array", items: ref(name) } },
  });
  const query = (...names: string[]) =>
    entry.parameters.push(
      ...names.map((name) => ({
        in: "query",
        name,
        schema: { type: "string" },
      })),
    );
  if (path.includes("/units") || path.includes("/blocks")) {
    if (method !== "get")
      entry.description += " Exige administrador (sessão de pessoa).";
    if (path.endsWith("/units"))
      json.schema = method === "get" ? list("ReservaUnit") : ref("ReservaUnit");
    if (path.endsWith("/units/{id}") && method !== "delete")
      json.schema = ref("ReservaUnit");
    if (path.endsWith("/blocks") && method === "get")
      query("from_date", "to_date");
    if (path.endsWith("/units/{id}") && method === "delete")
      entry.description +=
        " Recusa unidade com reservas futuras; as reservas antigas continuam mostrando a unidade.";
    return;
  }
  if (path.endsWith("/reserva")) {
    entry.description +=
      " config traz a chave reserva de PUT /settings com os padrões. deposit diz se a Cobrança está pronta para o sinal ({available, reason: payments_disabled|payments_not_configured, message}).";
    return;
  }
  if (path.endsWith("/availability")) {
    query(
      "start_date",
      "end_date",
      "nights",
      "guests",
      "date",
      "duration_minutes",
      "unit_id",
      "staff",
    );
    entry.description +=
      " Diárias: start_date e end_date (ou nights) → units[] com available, reason (booked, blocked, notice, ahead, min_stay, max_stay, capacity, past, inactive), message, price_cents e deposit_cents. Por hora: date e duration_minutes → units[] com slots [{starts, ends, time, price_cents}]. staff=1 ignora antecedência e estadia máxima, como a equipe.";
    return;
  }
  if (path.endsWith("/calendar")) {
    query("from_date", "to_date", "unit_id");
    entry.description +=
      " Até 93 dias. units[].cells[] por dia: state free, pending_payment, confirmed, completed, partial (por hora, ou bloqueio de parte do dia) ou blocked, com booking_ids e block_ids; bookings traz as reservas do período.";
    return;
  }
  if (path.endsWith("/bookings") && method === "get") {
    query(
      "status",
      "from_date",
      "to_date",
      "unit_id",
      "conversation_id",
      "q",
      "limit",
    );
    entry.description +=
      " status separado por vírgula; q busca por nome, telefone ou número." +
      EVENTS;
    json.schema = list("ReservaBooking");
    return;
  }
  json.schema = ref("ReservaBooking");
  if (path.endsWith("/bookings") && method === "post")
    entry.description +=
      " Gravação atômica: dois pedidos para a mesma unidade no mesmo período nunca ficam os dois; o segundo recebe 409 unit_unavailable (ou unit_blocked; outside_rules para regras). Ligada a uma conversa, avisa o cliente; deposit:true cobra o sinal e a reserva fica pending_payment até o webhook do pagamento." +
      EVENTS;
  else if (path.endsWith("/deposit"))
    entry.description +=
      " Só para pending_payment ligada a uma conversa. Erros da Cobrança voltam como estão (409 payments_not_configured, module_disabled, window_closed).";
  else if (path.endsWith("/checkin"))
    entry.description +=
      " Envia o passo web do check-in (campos das regras). Linha oficial com a janela de 24 horas fechada: 400 pedindo que o cliente escreva antes. Estado em checkin_status; respostas em checkin_answers.";
  else if (path.endsWith("/confirm"))
    entry.description +=
      " Para sinal recebido por fora. O cliente nunca confirma por mensagem: o sinal só confirma pelo webhook do provedor.";
  else if (method === "get") entry.description += EVENTS;
}
