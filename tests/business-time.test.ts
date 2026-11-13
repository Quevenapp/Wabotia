import { describe, expect, it } from "vitest";
import {
  protocolDueAt,
  formatBrasilia,
  businessHours,
  validateBusinessHours,
} from "../src/business-time";
import { brasilia } from "./service-center-fixture";

// November 2026: 10 Tue, 11 Wed, 12 Thu, 13 Fri, 14 Sat, 15 Sun, 16 Mon.
const week = {
  protocol_response_unit: "business_days",
  protocol_response_days: 3,
  business_hours: {
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
    holidays: [] as string[],
  },
};
const due = (at: number, config: any = week) =>
  formatBrasilia(protocolDueAt(at, config)!);

describe("prazo do protocolo em dias úteis", () => {
  it("segue os três exemplos do contrato", () => {
    // Tuesday 14:00 is due on Friday 14:00.
    expect(due(brasilia(2026, 11, 10, 14))).toBe("13/11/2026 às 14:00");
    // Saturday 10:00 starts on Monday 09:00 and is due on Thursday 09:00.
    expect(due(brasilia(2026, 11, 14, 10))).toBe("19/11/2026 às 09:00");
    // Friday 19:30 starts on Monday 09:00 and is due on Thursday 09:00.
    expect(due(brasilia(2026, 11, 13, 19, 30))).toBe("19/11/2026 às 09:00");
  });
  it("mantém a hora exata do relógio, inclusive segundos", () => {
    const opened = brasilia(2026, 11, 10, 14, 7) + 42_500;
    expect(protocolDueAt(opened, week)).toBe(
      brasilia(2026, 11, 13, 14, 7) + 42_500,
    );
  });
  it("antes da abertura parte do início do mesmo dia; no fechamento, do próximo dia útil", () => {
    expect(due(brasilia(2026, 11, 10, 7, 15))).toBe("13/11/2026 às 09:00");
    expect(due(brasilia(2026, 11, 10, 9))).toBe("13/11/2026 às 09:00");
    expect(due(brasilia(2026, 11, 10, 17, 59))).toBe("13/11/2026 às 17:59");
    // 18:00 is already outside the service hours: Wednesday 09:00 + 3 days.
    expect(due(brasilia(2026, 11, 10, 18))).toBe("16/11/2026 às 09:00");
  });
  it("usa o dia de Brasília mesmo quando o UTC já virou", () => {
    // Tuesday 23:30 in Brasília is Wednesday 02:30 UTC.
    expect(due(brasilia(2026, 11, 10, 23, 30))).toBe("16/11/2026 às 09:00");
    // Sunday 22:00 in Brasília is Monday 01:00 UTC, still a closed day.
    expect(due(brasilia(2026, 11, 15, 22))).toBe("19/11/2026 às 09:00");
    // Monday 00:30 in Brasília: before opening on a working day.
    expect(due(brasilia(2026, 11, 16, 0, 30))).toBe("19/11/2026 às 09:00");
  });
  it("não conta feriados nem parte de um feriado", () => {
    const holiday = {
      ...week,
      business_hours: { ...week.business_hours, holidays: ["2026-11-12"] },
    };
    // Tue 14:00 -> Wed (1), Thu is a holiday, Fri (2), Mon (3).
    expect(due(brasilia(2026, 11, 10, 14), holiday)).toBe(
      "16/11/2026 às 14:00",
    );
    // Opened on the holiday itself: starts on Friday 09:00.
    expect(due(brasilia(2026, 11, 12, 10), holiday)).toBe(
      "18/11/2026 às 09:00",
    );
    // A holiday on a weekend changes nothing.
    expect(
      due(brasilia(2026, 11, 10, 14), {
        ...week,
        business_hours: { ...week.business_hours, holidays: ["2026-11-14"] },
      }),
    ).toBe("13/11/2026 às 14:00");
  });
  it("atravessa o fim de semana e a virada do ano", () => {
    // Friday 10:00 + 1 working day is Monday 10:00.
    expect(
      due(brasilia(2026, 11, 13, 10), { ...week, protocol_response_days: 1 }),
    ).toBe("16/11/2026 às 10:00");
    // Wed 30/12/2026 14:00 -> Thu 31 (1), Fri 01/01 holiday, Mon 04 (2), Tue 05 (3).
    expect(
      due(brasilia(2026, 12, 30, 14), {
        ...week,
        business_hours: { ...week.business_hours, holidays: ["2027-01-01"] },
      }),
    ).toBe("05/01/2027 às 14:00");
    // Thu 31/12/2026 20:00 without holidays starts on Fri 01/01/2027 09:00.
    expect(due(brasilia(2026, 12, 31, 20))).toBe("06/01/2027 às 09:00");
  });
  it("respeita dias e horários próprios e prazos longos", () => {
    const saturday = {
      protocol_response_unit: "business_days",
      protocol_response_days: 2,
      business_hours: {
        days: [2, 3, 4, 5, 6],
        start: "08:30",
        end: "12:00",
        holidays: [],
      },
    };
    // Monday is closed: starts Tuesday 08:30, due Thursday 08:30.
    expect(due(brasilia(2026, 11, 16, 10), saturday)).toBe(
      "19/11/2026 às 08:30",
    );
    // Friday 11:00 + 2 days: Saturday (1), Tuesday (2).
    expect(due(brasilia(2026, 11, 13, 11), saturday)).toBe(
      "17/11/2026 às 11:00",
    );
    // 60 working days from Tuesday 10/11/2026, Monday to Friday.
    expect(
      due(brasilia(2026, 11, 10, 14), { ...week, protocol_response_days: 60 }),
    ).toBe("02/02/2027 às 14:00");
  });
  it("usa os padrões quando a configuração de dias úteis está ausente ou corrompida", () => {
    expect(
      due(brasilia(2026, 11, 10, 14), {
        protocol_response_unit: "business_days",
      }),
    ).toBe("13/11/2026 às 14:00");
    expect(
      due(brasilia(2026, 11, 10, 14), {
        protocol_response_unit: "business_days",
        protocol_response_days: 0,
        business_hours: { days: [], start: "18:00", end: "09:00" },
      }),
    ).toBe("13/11/2026 às 14:00");
    expect(
      businessHours({ days: [5, 1], holidays: ["2026-02-30", "2026-12-25"] }),
    ).toEqual({
      days: [1, 5],
      start: "09:00",
      end: "18:00",
      holidays: ["2026-12-25"],
    });
  });
  it("preserva a contagem em horas corridas e o protocolo sem prazo", () => {
    const at = brasilia(2026, 11, 14, 10);
    expect(protocolDueAt(at, { protocol_response_hours: 24 })).toBe(
      at + 86400000,
    );
    expect(
      protocolDueAt(at, {
        protocol_response_unit: "hours",
        protocol_response_hours: 1.5,
        protocol_response_days: 3,
      }),
    ).toBe(at + 5400000);
    expect(protocolDueAt(at, { protocol_response_hours: null })).toBeNull();
    expect(
      protocolDueAt(at, {
        protocol_response_unit: "hours",
        protocol_response_hours: null,
      }),
    ).toBeNull();
  });
  it("valida o horário de atendimento ao salvar", () => {
    const valid = {
      days: [5, 1, 3],
      start: "08:00",
      end: "17:30",
      holidays: [],
    };
    expect(validateBusinessHours(valid).days).toEqual([1, 3, 5]);
    for (const wrong of [
      { ...valid, days: [] },
      { ...valid, days: [1, 1] },
      { ...valid, days: [7] },
      { ...valid, days: [1.5] },
      { ...valid, start: "8:00" },
      { ...valid, end: "24:00" },
      { ...valid, start: "17:30", end: "17:30" },
      { ...valid, start: "18:00", end: "09:00" },
      { ...valid, holidays: ["25/12/2026"] },
      { ...valid, holidays: ["2026-02-30"] },
      { ...valid, holidays: ["2026-12-25", "2026-12-25"] },
      { ...valid, holidays: Array.from({ length: 101 }, (_, i) => i) },
      null,
      [],
    ])
      expect(() => validateBusinessHours(wrong)).toThrow();
  });
  it("formata o prazo no horário de Brasília", () => {
    expect(formatBrasilia(Date.UTC(2026, 10, 14, 17, 0))).toBe(
      "14/11/2026 às 14:00",
    );
    expect(formatBrasilia(Date.UTC(2027, 0, 1, 2, 5))).toBe(
      "31/12/2026 às 23:05",
    );
  });
});
