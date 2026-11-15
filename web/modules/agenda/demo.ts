// Agenda na demonstração (/app?demo=1, web/lib/demo.ts): uma barbearia com
// dois profissionais e a agenda de hoje e dos próximos dias.
import type { Row } from "../../lib/api";
import { addDays, at, brDate, brStart, DAY_MS } from "./model";

export const agendaDemoModule: Row = {
  id: "agenda",
  name: "Agenda",
  version: "1.0.0",
  description:
    "Serviços, profissionais e horários; o cliente agenda, confirma, remarca e cancela pelo WhatsApp, com lembrete antes do horário.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  navigation: [
    { id: "agenda", label: "Agenda", place: "admin", admin: false },
    {
      id: "agenda-settings",
      label: "Serviços e horários",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    { type: "agenda", label: "Agendar horário" },
    { type: "agenda_mine", label: "Meus agendamentos" },
  ],
};

const week = (start: string, end: string, days = [1, 2, 3, 4, 5, 6]) =>
  days.map((weekday) => ({ weekday, start, end }));
const services: Row[] = [
  {
    id: "corte",
    name: "Corte",
    description: "Tesoura e máquina",
    duration_minutes: 30,
    price_cents: 5000,
    active: true,
    position: 0,
  },
  {
    id: "barba",
    name: "Barba",
    description: "",
    duration_minutes: 30,
    price_cents: 3500,
    active: true,
    position: 1,
  },
  {
    id: "combo",
    name: "Corte e barba",
    description: "",
    duration_minutes: 60,
    price_cents: 8000,
    active: true,
    position: 2,
  },
];
const professionals: Row[] = [
  {
    id: "rafa",
    name: "Rafael",
    user_id: "demo-user",
    active: true,
    position: 0,
    service_ids: ["corte", "barba", "combo"],
    hours: week("09:00", "18:00"),
  },
  {
    id: "carla",
    name: "Carla",
    user_id: "demo-ana",
    active: true,
    position: 1,
    service_ids: ["corte"],
    hours: week("10:00", "19:00", [2, 3, 4, 5, 6]),
  },
];
const config: Row = {
  min_notice_minutes: 60,
  max_days_ahead: 30,
  slot_step_minutes: 30,
  reminder_hours: 24,
  customer_change_hours: 2,
  close_on_holidays: true,
  intro_text: "Vamos agendar o seu horário. Qual serviço você quer?",
  booked_text:
    "Agendado! {servico} com {profissional}, {data} às {hora}. Para ver, remarcar ou cancelar, use Meus agendamentos no menu.",
  reminder_text:
    "Lembrete: {servico} com {profissional}, {data} às {hora}. Você confirma?",
  cancelled_text:
    "Seu agendamento de {servico} em {data} às {hora} foi cancelado.",
};

function appointments(): Row[] {
  const today = brDate(Date.now());
  const plan: [number, string, string, string, string, string, string][] = [
    [0, "09:00", "rafa", "corte", "Mariana Albuquerque", "confirmed", "demo-1"],
    [0, "10:00", "rafa", "combo", "João Pedro Santos", "booked", "demo-2"],
    [0, "11:30", "carla", "corte", "Lucas Ferreira", "booked", ""],
    [0, "14:00", "carla", "corte", "Fernanda Rocha", "cancelled", "demo-5"],
    [1, "09:30", "rafa", "barba", "Paulo Mendes", "booked", ""],
    [1, "15:00", "carla", "corte", "Beatriz Lima", "confirmed", ""],
    [2, "16:30", "rafa", "corte", "Mariana Albuquerque", "booked", "demo-1"],
  ];
  return plan.map(
    ([days, time, pro, service, name, status, conversation], index) => {
      const date = addDays(today, days);
      const starts = at(date, time);
      const s = services.find((item) => item.id === service)!;
      return {
        id: "appt-" + index,
        service_id: s.id,
        service_name: s.name,
        professional_id: pro,
        professional_name: professionals.find((p) => p.id === pro)!.name,
        starts,
        ends: starts + s.duration_minutes * 60_000,
        date,
        time,
        status,
        conversation_id: conversation || null,
        contact_id: null,
        customer_name: name,
        customer_phone: "",
        notes: "",
        source: conversation ? "whatsapp" : "panel",
        price_cents: s.price_cents,
        booked_at: starts - 3 * DAY_MS,
        reminded_at: status === "booked" && days === 0 ? starts - DAY_MS : null,
        confirmed_at: status === "confirmed" ? starts - DAY_MS : null,
        cancelled_at: status === "cancelled" ? starts - 5 * 3_600_000 : null,
        cancelled_by: null,
        cancel_reason:
          status === "cancelled" ? "Cancelado pelo cliente no WhatsApp" : "",
        no_show_at: null,
        moves: 0,
        created_by: "customer",
        created: starts - 3 * DAY_MS,
        updated: starts - DAY_MS,
      };
    },
  );
}

/** Leituras de /agenda… na demonstração (`rest` sem /profiles/:id/). */
export function agendaDemo(rest: string, query: URLSearchParams): any {
  if (rest === "agenda") return { config, services, professionals };
  if (rest === "agenda/services") return { data: services };
  if (rest === "agenda/professionals") return { data: professionals };
  if (rest === "agenda/blocks") {
    const day = addDays(brDate(Date.now()), 5);
    return {
      data: [
        {
          id: "folga",
          professional_id: "carla",
          starts: brStart(day),
          ends: brStart(day) + DAY_MS,
          reason: "Folga",
          created_by: "demo-user",
          created: Date.now(),
        },
      ],
    };
  }
  if (rest === "agenda/appointments") {
    const from = Number(query.get("from")) || 0,
      to = Number(query.get("to")) || Infinity,
      pro = query.get("professional_id"),
      conversation = query.get("conversation_id");
    return {
      data: appointments().filter(
        (a) =>
          a.starts < to &&
          a.ends > from &&
          (!pro || a.professional_id === pro) &&
          (!conversation || a.conversation_id === conversation),
      ),
    };
  }
  if (rest === "agenda/availability") {
    const date = query.get("date") || brDate(Date.now());
    const taken = new Set(appointments().map((a) => a.starts));
    const slots = [];
    for (let minute = 9 * 60; minute < 18 * 60; minute += 30) {
      const starts = brStart(date) + minute * 60_000;
      if (!taken.has(starts) && starts > Date.now())
        slots.push({
          starts,
          ends: starts + 30 * 60_000,
          time: "",
          professional_ids: ["rafa"],
        });
    }
    return {
      service_id: query.get("service_id"),
      professional_id: null,
      days: [{ date, slots }],
    };
  }
  return { data: [] };
}
