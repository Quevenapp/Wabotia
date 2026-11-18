import { describe, expect, it } from "vitest";
import { calculate, defaultRule, frequency, periods, rule, schedule, type Mark } from "../src/modules/ensino/model";

const mark = (score: number | null, overrides: Partial<Mark> = {}): Mark => ({ id: "p1", title: "Prova", max_score: 10, weight: 1, kind: "regular", status: score === null ? "pending" : "graded", score, ...overrides });
describe("Ensino: cálculo explicável", () => {
  it("normaliza escalas e calcula média simples, arredondando só no final", () => {
    const result = calculate([mark(7.5), mark(90, { max_score: 100 })], defaultRule);
    expect(result.final).toBe(8.3);
    expect(result.exact).toBe("33/4");
    expect(result.explanation).toContain("90 / 100 × 10");
    expect(result.explanation).toContain("metade para cima");
    expect(result.inputs).toHaveLength(2);
  });
  it("pondera pelos pesos positivos", () => {
    expect(calculate([mark(5, { weight: 1 }), mark(9, { weight: 3 })], { ...defaultRule, method: "weighted" }).final).toBe(8);
    expect(() => calculate([mark(5, { weight: 0 })], defaultRule)).toThrow();
  });
  it.each([["half_up", 1.01], ["truncate", 1], ["ceil", 1.01]] as const)("%s trata 1,005 sem erro binário", (rounding, final) => {
    expect(calculate([mark(1), mark(1.01)], { ...defaultRule, decimals: 2, rounding }).final).toBe(final);
  });
  it("mantém nota zero e distingue pendente, ausente e dispensado", () => {
    expect(calculate([mark(0)], defaultRule).final).toBe(0);
    for (const status of ["pending", "absent"] as const) expect(calculate([mark(null, { status }), mark(10)], defaultRule).final).toBeNull();
    expect(calculate([mark(null, { status: "exempt" }), mark(10)], defaultRule).final).toBe(10);
    expect(calculate([mark(null, { status: "exempt" })], defaultRule).final).toBeNull();
  });
  it("aplica recuperação pela maior nota com limite explícito", () => {
    const config = { ...defaultRule, recovery: { mode: "best" as const, base_weight: 1, recovery_weight: 1, cap: 7 } };
    const result = calculate([mark(5), mark(9, { kind: "recovery" })], config);
    expect(result.final).toBe(7);
    expect(result.explanation).toContain("Limite após recuperação: 7");
    expect(calculate([mark(8), mark(3, { kind: "recovery" })], { ...config, recovery: { ...config.recovery, cap: 10 } }).final).toBe(8);
  });
  it("combina média e recuperação com pesos e não exige recuperação não cadastrada", () => {
    const config = { ...defaultRule, recovery: { mode: "weighted" as const, base_weight: 1, recovery_weight: 3, cap: 10 } };
    expect(calculate([mark(4), mark(8, { kind: "recovery" })], config).final).toBe(7);
    expect(calculate([mark(4)], config).final).toBe(4);
    expect(calculate([mark(4), mark(null, { kind: "recovery" })], config).final).toBeNull();
  });
  it("recusa notas fora da escala, precisão indevida, recuperação desligada e expressões", () => {
    for (const value of [NaN, Infinity, -1, 11, 1.234]) expect(() => calculate([mark(value)], defaultRule)).toThrow();
    expect(() => calculate([mark(1), mark(10, { kind: "recovery" })], defaultRule)).toThrow();
    expect(() => rule({ ...defaultRule, expression: "eval(input)" })).toThrow();
  });
});
describe("Ensino: calendário e frequência", () => {
  it("exclui canceladas/previstas e nunca transforma pendência em falta", () => {
    const result = frequency([{ status: "held", attendance: "present" }, { status: "held", attendance: null }, { status: "cancelled", attendance: "absent" }, { status: "planned", attendance: null }], false);
    expect(result).toMatchObject({ held: 2, present: 1, absent: 0, pending: 1, percent: null });
  });
  it("configura o efeito da justificativa; sem aula não inventa 100%", () => {
    const rows = [{ status: "held", attendance: "present" }, { status: "held", attendance: "justified" }];
    expect(frequency(rows, false).percent).toBe(50);
    expect(frequency(rows, true).percent).toBe(100);
    expect(frequency([], true).percent).toBeNull();
  });
  it("recusa períodos sobrepostos, datas inexistentes e horários conflitantes", () => {
    expect(() => periods([{ id: "p", name: "P", start: "2025-02-30", end: "2025-03-01" }], "2025-01-01", "2025-12-31")).toThrow();
    expect(() => periods([{ id: "a", name: "A", start: "2025-01-01", end: "2025-03-01" }, { id: "b", name: "B", start: "2025-03-01", end: "2025-06-30" }], "2025-01-01", "2025-12-31")).toThrow();
    expect(() => schedule([{ day: 1, start: "08:00", end: "09:00" }, { day: 1, start: "08:30", end: "09:30" }])).toThrow();
    expect(schedule([{ day: 1, start: "08:00", end: "09:00" }, { day: 1, start: "09:00", end: "10:00" }])).toHaveLength(2);
  });
});
