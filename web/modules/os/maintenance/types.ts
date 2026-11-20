// OS4: formatos do contrato de manutenção e da execução agendada, como o
// servidor devolve (src/modules/os/maintenance/*). Valores em centavos;
// datas civis AAAA-MM-DD; instantes em milissegundos.
export type ContractStatus = "active" | "suspended" | "ended";
export type CoverageUnit = "visits" | "hours";
export type CoveragePeriod = "month" | "quarter" | "year";

export interface ContractCoverage {
  type_ids: string[];
  services: string;
  unit: CoverageUnit;
  /** Visitas, ou minutos quando a unidade é horas. */
  limit: number;
  period: CoveragePeriod;
  excess: "quote" | "approval";
  excess_unit_cents: number | null;
  type_labels: string[];
  text: string;
  excess_text: string;
}
export interface VisitRule {
  kind: "every_days" | "month_day";
  days?: number;
  day?: number;
  lead_days: number;
  type_id: string;
  item: string;
  first_on?: string | null;
  text: string;
  next_on: string | null;
  due: boolean;
}
export interface ContractObject { id: string; type_id: string; type_label: string; identifier: string; archived: boolean }
export interface ContractSubscription {
  id: string;
  plan_name: string | null;
  status: "active" | "paused" | "ended";
  status_label: string;
  charge_cents: number;
  period_label: string;
  next_due: { due_date: string; amount_cents: number; status: string }[];
  overdue: boolean;
  late_in_grace: boolean;
  overdue_cents: number;
  grace_days: number;
}
export interface Contract {
  id: string;
  number: number;
  display_number: string;
  version: number;
  status: ContractStatus;
  status_label: string;
  in_force: boolean;
  customer: { contact_id: string; name: string; phone: string | null };
  objects: ContractObject[];
  plan: { id: string; name: string; amount_cents: number | null; period_label: string } | null;
  subscription: ContractSubscription | null;
  coverage: ContractCoverage;
  usage: { period_key: string; used: number; limit: number; remaining: number; text: string };
  starts_on: string;
  ends_on: string | null;
  adjustment: { percent: number; on: string; text: string; due: boolean; noticed_on: string | null } | null;
  overdue_policy: "warn" | "block";
  terms: string;
  visits: VisitRule | null;
  status_reason: string;
  status_changed_at: number | null;
  warnings: string[];
  history?: { id: string; kind: string; actor: string; note: string; created: number }[];
  created: number;
  updated: number;
}
export interface ContractList { data: Contract[]; next_cursor: string | null; counts: Partial<Record<ContractStatus, number>> }
export interface ContractOptions {
  modules: { os: boolean; mensalidade: boolean };
  missing: string | null;
  plans: { id: string; name: string; amount_cents: number; period_label: string; due_day: number }[];
  types: { id: string; label: string }[];
}
export interface MaintenanceDue {
  available: boolean;
  missing: string | null;
  data: { contract: Contract; due_on: string; overdue: boolean; type_id: string; type_label: string; item: string; objects: ContractObject[] }[];
}
export interface OrderContract {
  available: boolean;
  missing: string | null;
  contracts: (Contract & { headline: string; can_cover: boolean; blocked_reason: string | null })[];
  coverage: {
    contract_id: string; contract_number: number | null; period_key: string;
    covered_units: number; excess_units: number; unit: CoverageUnit;
    covered_text: string; excess_text: string; excess_rule: "quote" | "approval"; counts: boolean;
  } | null;
  warnings?: string[];
}
export interface OrderSchedule {
  order_id: string;
  agenda: { enabled: boolean; message: string | null };
  whatsapp: { ready: boolean; reason: string | null };
  schedule: {
    mode: "agenda" | "manual";
    state: "active" | "cancelled";
    starts: number;
    ends: number | null;
    when_text: string;
    service: { id: string; name: string } | null;
    professional: { id: string; name: string } | null;
    appointment: { id: string; status: string; status_label: string; confirmed_at: number | null } | null;
    note: string;
    changed_by_agenda: boolean;
    agenda_off: boolean;
  } | null;
  warnings?: string[];
}
export interface ScheduleOptions {
  agenda: { enabled: boolean; message: string | null };
  services: { id: string; name: string; duration_minutes: number }[];
  professionals: { id: string; name: string; service_ids: string[] }[];
}
export interface ScheduleSlots {
  service: { id: string; name: string } | null;
  days: { date: string; slots: { starts: number; ends: number; professional_ids: string[] }[] }[];
}
export interface MyScheduleItem {
  id: string; type_id: string; display_number: string; item: string; customer_name: string;
  status: string; status_label: string; scheduled_at: number; when_text: string; mode: "agenda" | "manual"; overdue: boolean;
}

export interface ContractBody {
  contact_id?: string;
  customer_name?: string;
  object_ids?: string[];
  plan_id?: string;
  subscription_id?: string | null;
  create_subscription?: boolean;
  coverage?: { type_ids: string[]; services: string; unit: CoverageUnit; limit: number; period: CoveragePeriod; excess: "quote" | "approval"; excess_unit_cents: number | null };
  starts_on?: string;
  ends_on?: string | null;
  adjustment?: { percent: number; on?: string } | null;
  overdue_policy?: "warn" | "block";
  terms?: string;
  visits?: { kind: "every_days" | "month_day"; days?: number; day?: number; lead_days: number; type_id: string; item: string; first_on?: string | null } | null;
  version?: number;
}

export function createMaintenanceApi(get: <T>(url: string, query?: object) => Promise<T>, send: <T>(url: string, method: string, body: object) => Promise<T>, base: string) {
  const contract = (id: string) => base + "/contracts/" + encodeURIComponent(id);
  const order = (id: string) => base + "/" + encodeURIComponent(id);
  return {
    contractOptions: () => get<ContractOptions>(base + "/contract-options"),
    contracts: (query: { situation?: string; contact_id?: string; object_id?: string; q?: string; cursor?: string; limit?: string } = {}) => get<ContractList>(base + "/contracts", query),
    contract: (id: string) => get<Contract>(contract(id)),
    createContract: (body: ContractBody) => send<Contract>(base + "/contracts", "POST", body),
    updateContract: (id: string, body: ContractBody) => send<Contract>(contract(id), "PATCH", body),
    contractSituation: (id: string, body: { status: ContractStatus; reason?: string; subscription?: "follow" | "keep"; version?: number }) => send<Contract>(contract(id) + "/situation", "POST", body),
    maintenanceDue: () => get<MaintenanceDue>(base + "/maintenance-due"),
    openVisit: (id: string, body: { due_on: string; action?: "open" | "skip"; object_id?: string; reason?: string }) =>
      send<{ order: { id: string; number: number; type_id: string } | null; contract: Contract; warnings: string[] }>(contract(id) + "/visits", "POST", body),
    orderContract: (id: string) => get<OrderContract>(order(id) + "/contract"),
    coverOrder: (id: string, body: { contract_id: string; hours?: number; version?: number }) => send<OrderContract>(order(id) + "/contract-coverage", "POST", body),
    releaseCoverage: (id: string, body: { reason: string }) => send<OrderContract>(order(id) + "/contract-coverage/release", "POST", body),
    schedule: (id: string) => get<OrderSchedule>(order(id) + "/schedule"),
    scheduleOptions: () => get<ScheduleOptions>(base + "/schedule-options"),
    scheduleSlots: (query: { service_id: string; professional_id?: string; from?: string; days?: number; order_id?: string }) => get<ScheduleSlots>(base + "/schedule-slots", query),
    setSchedule: (id: string, body: { mode: "agenda" | "manual"; starts: number; ends?: number | null; service_id?: string; professional_id?: string | null; note?: string }) =>
      send<OrderSchedule>(order(id) + "/schedule", "PUT", body),
    cancelSchedule: (id: string, body: { reason?: string }) => send<OrderSchedule>(order(id) + "/schedule/cancel", "POST", body),
    mySchedule: (query: { from?: string; to?: string } = {}) => get<{ data: MyScheduleItem[] }>(base + "/my-schedule", query),
  };
}

export const brDate = (date: string | null | undefined) => date ? date.split("-").reverse().join("/") : "";
/** Horas para mostrar a partir de minutos ("1,5"). */
export const hoursText = (minutes: number) => {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, "").replace(".", ",");
};
