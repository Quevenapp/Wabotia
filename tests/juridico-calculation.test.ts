import { describe, expect, it } from "vitest";
import { calculate, localInstant } from "../src/modules/juridico/calculation";
import { calendarSchema, nationalSeed, parse, type Calendar, type CalendarEvent, type Rule } from "../src/modules/juridico/model";

const calendar = (events: CalendarEvent[] = []): Calendar => ({ name: "Calendário de teste", jurisdiction: "Âmbito de teste", from: "2026-01-01", to: "2027-12-31", timezone: "America/Sao_Paulo", weekend: [0, 6], events });
const rule = (changes: Partial<Rule> = {}): Rule => ({ start_date: "2026-11-16", days: 5, include_start: false, start_non_working: "next", due_non_working: "next", due_time: "18:00", alert_days: 2, alert_time: "09:00", ...changes });
const occurrence = (changes: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: "ocorrencia", name: "Suspensão de teste", from: "2026-11-18", to: "2026-11-19", kind: "suspension", effect: "all", source: "Ato informado pelo curador", ...changes });

describe("jurídico: contagem civil reproduzível", () => {
  it("conta dias úteis, exclui início e guarda cada exclusão e fonte", () => {
    const result = calculate(calendar([occurrence()]), rule());
    expect(result.due_date).toBe("2026-11-25");
    expect(result.trace.filter(d => d.phase === "count" && d.counted)).toHaveLength(5);
    expect(result.trace.find(d => d.date === "2026-11-18")).toMatchObject({ counted: false, sources: ["Ato informado pelo curador"] });
    expect(result.warning).toContain("confira");
    expect(result.calendar.events[0]).toEqual(occurrence());
    expect(result.alert_date).toBe("2026-11-23");
  });
  it("inclui o termo quando solicitado e nunca conta uma sobreposição duas vezes", () => {
    const e = occurrence({ from: "2026-11-17", to: "2026-11-17" });
    const a = calculate(calendar([e]), rule({ days: 2, include_start: true }));
    const b = calculate(calendar([e, { ...e, id: "outra", kind: "recess" }]), rule({ days: 2, include_start: true }));
    expect(a.due_date).toBe("2026-11-18"); expect(b.due_at).toBe(a.due_at);
  });
  it.each(["national", "state", "municipal", "court", "suspension", "recess"] as const)("aplica ocorrência %s somente no calendário escolhido", kind => {
    const excluded = calendar([occurrence({ kind, from: "2026-11-17", to: "2026-11-17" })]);
    expect(calculate(excluded, rule({ days: 1 })).due_date).toBe("2026-11-18");
    expect(calculate(calendar(), rule({ days: 1 })).due_date).toBe("2026-11-17");
  });
  it("ajusta início antes de excluir/incluir e oferece recuo ou recusa", () => {
    const r = rule({ start_date: "2026-11-14", days: 1, include_start: true });
    expect(calculate(calendar(), r).due_date).toBe("2026-11-16");
    expect(calculate(calendar(), { ...r, start_non_working: "previous" }).due_date).toBe("2026-11-13");
    expect(calculate(calendar(), { ...r, include_start: false }).due_date).toBe("2026-11-17");
    expect(() => calculate(calendar(), { ...r, start_non_working: "reject" })).toThrow();
  });
  it("ajusta o vencimento por efeito específico, sem suspender toda a contagem", () => {
    const c = calendar([occurrence({ from: "2026-11-17", to: "2026-11-17", effect: "due" })]);
    expect(calculate(c, rule({ days: 1 })).due_date).toBe("2026-11-18");
    expect(calculate(c, rule({ days: 1, due_non_working: "previous", alert_days: 0 })).due_date).toBe("2026-11-16");
    expect(() => calculate(c, rule({ days: 1, due_non_working: "reject" }))).toThrow();
  });
  it("distingue suspensão da contagem de ocorrência que só afeta início", () => {
    const c = calendar([occurrence({ from: "2026-11-17", to: "2026-11-17", effect: "start" })]);
    expect(calculate(c, rule({ days: 1 })).due_date).toBe("2026-11-17");
  });
  it("aceita calendário com sábado útil e ano bissexto", () => {
    const c = { ...calendar(), from: "2024-01-01", to: "2024-12-31", weekend: [0] };
    expect(calculate(c, rule({ start_date: "2024-02-28", days: 3, alert_days: 0 })).due_date).toBe("2024-03-02");
    expect(() => calculate(c, rule({ start_date: "2024-02-30" }))).toThrow();
  });
  it("recusa cobertura incompleta na contagem e na antecedência", () => {
    expect(() => calculate({ ...calendar(), to: "2026-11-17" }, rule())).toThrow();
    expect(() => calculate({ ...calendar(), from: "2026-11-16" }, rule({ days: 1, alert_days: 10 }))).toThrow();
  });
  it("converte pelo fuso e recusa horários inexistentes ou ambíguos", () => {
    expect(localInstant("2026-11-16", "18:00", "America/Sao_Paulo")).toBe(Date.parse("2026-11-16T21:00:00Z"));
    expect(() => localInstant("2026-03-08", "02:30", "America/New_York")).toThrow();
    expect(() => localInstant("2026-11-01", "01:30", "America/New_York")).toThrow();
    expect(() => calculate(calendar(), rule({ alert_days: 0, alert_time: "19:00" }))).toThrow();
  });
  it("carga inicial traz só nove feriados fixos, sempre marcados para conferência", () => {
    const events = nationalSeed("2026-01-01", "2026-12-31");
    expect(events).toHaveLength(9);
    expect(events.every(e => e.kind === "national" && e.from === e.to && e.source.includes("Confira antes de usar"))).toBe(true);
    expect(events.some(e => /Carnaval|Páscoa|Corpus/i.test(e.name))).toBe(false);
    expect(events.map(e => e.from)).toContain("2026-11-20");
  });
  it("recusa propriedades desconhecidas, datas inválidas, quantidade e calendário sem semana útil", () => {
    for (const r of [rule({ days: 0 }), rule({ days: 1.5 }), rule({ days: 367 }), { ...rule(), phone: "arbitrário" }]) expect(() => calculate(calendar(), r)).toThrow();
    expect(() => parse(calendarSchema, { ...calendar(), weekend: [0, 1, 2, 3, 4, 5, 6] })).toThrow();
    expect(() => parse(calendarSchema, calendar([occurrence(), occurrence()]))).toThrow();
  });
});
