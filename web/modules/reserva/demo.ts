// Reserva na demonstração (/app?demo=1, web/lib/demo.ts): uma pousada com
// três acomodações por diária e um salão por hora, com reservas de hoje e
// dos próximos dias (uma aguardando o sinal, uma com check-in feito).
import type { Row } from "../../lib/api";
import { addDays, at, brDate, brStart, DAY_MS, daysBetween } from "./model";

export const reservaDemoModule: Row = {
  id: "reserva",
  name: "Reserva e check-in",
  version: "1.0.0",
  description:
    "Quartos, chalés, quadras e salões reservados pelo WhatsApp por diária ou por hora, com sinal por Pix ou link, check-in online, lembrete e mensagem de saída.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  navigation: [
    { id: "reserva", label: "Reservas", place: "admin", admin: false },
    {
      id: "reserva-settings",
      label: "Unidades e regras",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    { type: "reserva", label: "Fazer reserva" },
    { type: "reserva_mine", label: "Minhas reservas" },
  ],
};

const config: Row = {
  min_notice_hours: 2,
  max_days_ahead: 365,
  min_nights: 2,
  max_nights: 15,
  checkin_time: "14:00",
  checkout_time: "12:00",
  hourly_open: "10:00",
  hourly_close: "24:00",
  hourly_step_minutes: 60,
  min_hours: 4,
  max_hours: 8,
  deposit_type: "percent",
  deposit_percent: 30,
  deposit_cents: 0,
  deposit_method: "pix",
  deposit_deadline_minutes: 120,
  cancellation_policy:
    "Cancelamento grátis até 7 dias antes da entrada. Depois disso, o sinal não é devolvido.",
  customer_cancel_hours: 168,
  checkin_enabled: true,
  checkin_hours_before: 48,
  checkin_fields: {
    document: true,
    companions: true,
    arrival_time: true,
    rules: true,
  },
  checkin_questions: ["Placa do carro"],
  house_rules:
    "Silêncio depois das 22h. Proibido fumar nos quartos. Animais com aviso prévio.",
  reminder_hours: 24,
  checkout_message: true,
  checkout_minutes_before: 60,
  intro_text:
    "Que bom ter você na Pousada Maré Mansa! O que você quer reservar?",
  confirmed_text:
    "Reserva {numero} confirmada! {unidade}: entrada {entrada}, saída {saida}. Para ver ou cancelar, use Minhas reservas no menu.",
  pending_text:
    "Reserva {numero} feita! {unidade}: entrada {entrada}, saída {saida}. Para garantir, pague o sinal de {sinal} até {prazo}. Sem o pagamento, a reserva é liberada.",
  expired_text:
    "O prazo para pagar o sinal da reserva {numero} ({unidade}) acabou e a reserva foi liberada. Se ainda quiser, faça uma nova reserva pelo menu.",
  cancelled_text:
    "A reserva {numero} ({unidade}, entrada {entrada}) foi cancelada.",
  reminder_text:
    "Lembrete da sua reserva {numero}: {unidade}, entrada {entrada}. Até breve!",
  checkout_text:
    "Sua saída de {unidade} é {saida}. Obrigado pela preferência e volte sempre!",
};

const units: Row[] = [
  {
    id: "mar",
    name: "Suíte Vista Mar",
    kind: "room",
    description: "Cama de casal, varanda e vista para o mar.",
    capacity: 2,
    photos: [],
    mode: "daily",
    price_cents: 38000,
    active: true,
    position: 0,
  },
  {
    id: "jardim",
    name: "Suíte Jardim",
    kind: "room",
    description: "Térrea, com rede no jardim.",
    capacity: 3,
    photos: [],
    mode: "daily",
    price_cents: 29000,
    active: true,
    position: 1,
  },
  {
    id: "chale",
    name: "Chalé Família",
    kind: "house",
    description: "Dois quartos, cozinha e churrasqueira.",
    capacity: 6,
    photos: [],
    mode: "daily",
    price_cents: 62000,
    active: true,
    position: 2,
  },
  {
    id: "salao",
    name: "Salão de eventos",
    kind: "hall",
    description: "Até 80 pessoas, com som e cozinha.",
    capacity: 80,
    photos: [],
    mode: "hourly",
    price_cents: 25000,
    active: true,
    position: 3,
  },
].map((u) => ({ ...u, created: 0, updated: 0 }));

function booking(
  number: number,
  unit: Row,
  startOffset: number,
  nightsOrHours: number,
  extra: Row = {},
): Row {
  const today = brDate(Date.now());
  const start = addDays(today, startOffset);
  const daily = unit.mode === "daily";
  const end = daily ? addDays(start, nightsOrHours) : start;
  const starts = daily ? brStart(start) : at(start, "19:00");
  const ends = daily ? brStart(end) : starts + nightsOrHours * 3_600_000;
  const arrival = daily ? at(start, config.checkin_time) : starts;
  const departure = daily ? at(end, config.checkout_time) : ends;
  const price = unit.price_cents * nightsOrHours;
  return {
    id: `demo-reserva-${number}`,
    number,
    unit_id: unit.id,
    unit_name: unit.name,
    mode: unit.mode,
    start_date: start,
    end_date: end,
    starts,
    ends,
    arrival_at: arrival,
    departure_at: departure,
    arrival_time: daily ? config.checkin_time : "19:00",
    departure_time: daily
      ? config.checkout_time
      : new Date(ends - 3 * 3_600_000).toISOString().slice(11, 16),
    nights: daily ? nightsOrHours : null,
    duration_minutes: daily ? null : nightsOrHours * 60,
    guests: 2,
    status: "confirmed",
    conversation_id: "demo-c1",
    contact_id: null,
    customer_name: "Cliente",
    customer_phone: "5511988887777",
    notes: "",
    source: "whatsapp",
    price_cents: price,
    deposit_cents: Math.round(price * 0.3),
    payment_id: `demo-pay-${number}`,
    payment_status: "paid",
    payment_error: null,
    payment_due_at: null,
    paid_at: Date.now() - 5 * DAY_MS,
    confirmed_at: Date.now() - 5 * DAY_MS,
    confirmed_by: "payment",
    checkin_status: "none",
    checkin_step_id: null,
    checkin_sent_at: null,
    checkin_at: null,
    checkin_answers: null,
    reminded_at: null,
    checkout_sent_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: "",
    changes: 0,
    created_by: "customer",
    created: Date.now() - 6 * DAY_MS,
    updated: Date.now() - DAY_MS,
    ...extra,
  };
}

const bookings: Row[] = [
  booking(41, units[0], -1, 3, {
    customer_name: "Marina Costa",
    guests: 2,
    checkin_status: "completed",
    checkin_at: Date.now() - 2 * DAY_MS,
    checkin_answers: {
      documento: "123.456.789-00",
      acompanhantes: "Rafael Costa",
      chegada: "15h",
      pergunta_1: "ABC1D23",
      regras: true,
    },
  }),
  booking(42, units[2], 0, 4, {
    customer_name: "Família Andrade",
    guests: 5,
    checkin_status: "sent",
    checkin_sent_at: Date.now() - DAY_MS,
  }),
  booking(43, units[1], 2, 2, {
    customer_name: "João Pereira",
    status: "pending_payment",
    payment_status: "created",
    payment_due_at: Date.now() + 90 * 60_000,
    paid_at: null,
    confirmed_at: null,
    confirmed_by: null,
  }),
  booking(44, units[3], 3, 5, {
    customer_name: "Aniversário da Lia",
    guests: 60,
    source: "panel",
    conversation_id: null,
  }),
  booking(45, units[0], 5, 2, { customer_name: "Paula Reis", source: "api" }),
  booking(40, units[1], -4, 2, {
    customer_name: "Carlos Lima",
    status: "cancelled",
    cancelled_at: Date.now() - 6 * DAY_MS,
    cancelled_by: "customer",
    cancel_reason: "Cancelada pelo cliente no WhatsApp",
    payment_status: "refunded",
  }),
];

const blocks: Row[] = [
  {
    id: "demo-block",
    unit_id: "jardim",
    starts: brStart(addDays(brDate(Date.now()), 8)),
    ends: brStart(addDays(brDate(Date.now()), 10)),
    from_date: addDays(brDate(Date.now()), 8),
    to_date: addDays(brDate(Date.now()), 9),
    reason: "Pintura",
    created_by: "demo",
    created: 0,
  },
];

const activeStates = ["pending_payment", "confirmed", "completed"];

function calendar(query: URLSearchParams) {
  const from = query.get("from_date") || brDate(Date.now());
  const to = query.get("to_date") || addDays(from, 13);
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 93; d = addDays(d, 1))
    days.push(d);
  const within = bookings.filter(
    (b) =>
      activeStates.includes(b.status) &&
      b.starts < brStart(to) + DAY_MS &&
      b.ends > brStart(from),
  );
  return {
    from_date: from,
    to_date: to,
    days,
    units: units.map((u) => ({
      unit_id: u.id,
      name: u.name,
      mode: u.mode,
      active: u.active,
      cells: days.map((date) => {
        const s = brStart(date),
          e = s + DAY_MS;
        const here = within.filter(
          (b) => b.unit_id === u.id && b.starts < e && b.ends > s,
        );
        const blocked = blocks.filter(
          (b) =>
            (!b.unit_id || b.unit_id === u.id) && b.starts < e && b.ends > s,
        );
        return {
          date,
          state: blocked.length
            ? "blocked"
            : u.mode === "daily" && here.length
              ? here[0].status
              : here.length
                ? "partial"
                : "free",
          booking_ids: here.map((b) => b.id),
          block_ids: blocked.map((b) => b.id),
        };
      }),
    })),
    bookings: within,
  };
}

/** Respostas de GET /profiles/:p/reserva… na demonstração. */
export function reservaDemo(rest: string, query: URLSearchParams): any {
  if (rest === "reserva")
    return {
      config,
      units,
      deposit: { available: true, reason: null, message: null },
    };
  if (rest === "reserva/units") return { data: units };
  if (rest === "reserva/blocks") return { data: blocks };
  if (rest === "reserva/calendar") return calendar(query);
  if (rest === "reserva/availability") {
    const start = query.get("start_date") || brDate(Date.now());
    const end = query.get("end_date") || addDays(start, 2);
    const nights = Math.max(1, daysBetween(start, end));
    return {
      start_date: start,
      end_date: end,
      units: units
        .filter(
          (u) =>
            u.mode === "daily" &&
            (!query.get("unit_id") || u.id === query.get("unit_id")),
        )
        .map((u) => {
          const taken = bookings.some(
            (b) =>
              b.unit_id === u.id &&
              ["pending_payment", "confirmed"].includes(b.status) &&
              b.starts < brStart(end) &&
              b.ends > brStart(start),
          );
          return {
            unit_id: u.id,
            name: u.name,
            capacity: u.capacity,
            available: !taken,
            reason: taken ? "booked" : null,
            message: taken
              ? "Essa unidade já está reservada nesse período."
              : null,
            price_cents: u.price_cents * nights,
            deposit_cents: Math.round(u.price_cents * nights * 0.3),
            nights,
          };
        }),
    };
  }
  if (rest === "reserva/bookings") {
    const status = (query.get("status") || "").split(",").filter(Boolean);
    const q = (query.get("q") || "").toLowerCase();
    return {
      data: bookings
        .filter((b) => !status.length || status.includes(b.status))
        .filter(
          (b) =>
            !q ||
            b.customer_name.toLowerCase().includes(q) ||
            `#${b.number}`.includes(q),
        )
        .sort((a, b) => a.starts - b.starts),
    };
  }
  const one = /^reserva\/bookings\/([^/]+)$/.exec(rest);
  if (one) return bookings.find((b) => b.id === one[1]) || null;
  return { data: [] };
}
