// OS4: impressão do contrato de manutenção (A4) e item coberto no orçamento.
import { describe, expect, it } from "vitest";
import { buildContractPrintHtml } from "../web/modules/os/maintenance/print";
import { buildPrintHtml } from "../web/modules/os/work/print";
import type { Contract } from "../web/modules/os/maintenance/types";

const contract: Contract = {
  id: "c1", number: 3, display_number: "Contrato nº 3", version: 1, status: "active", status_label: "Vigente", in_force: true,
  customer: { contact_id: "k1", name: "Buffet <Alegria>", phone: "5511987650001" },
  objects: [{ id: "o1", type_id: "equipamento", type_label: "Equipamento", identifier: "Split 12000 BTUs", archived: false }],
  plan: { id: "p1", name: "Manutenção mensal", amount_cents: 35000, period_label: "Mensal" },
  subscription: { id: "s1", plan_name: "Manutenção mensal", status: "active", status_label: "Ativa", charge_cents: 35000, period_label: "Mensal",
    next_due: [{ due_date: "2026-12-10", amount_cents: 35000, status: "open" }], overdue: false, late_in_grace: false, overdue_cents: 0, grace_days: 0 },
  coverage: { type_ids: [], services: "Limpeza de filtros e carga de gás", unit: "visits", limit: 2, period: "month", excess: "approval", excess_unit_cents: 18000,
    type_labels: ["Todos os modelos"], text: "2 visitas por mês", excess_text: "" },
  usage: { period_key: "2026-11", used: 1, limit: 2, remaining: 1, text: "1 de 2 visitas usadas neste mês" },
  starts_on: "2026-11-01", ends_on: null, adjustment: { percent: 5.5, on: "2027-11-01", text: "", due: false, noticed_on: null },
  overdue_policy: "warn", terms: "Atendimento em até 48 horas.", visits: null, status_reason: "", status_changed_at: null, warnings: [], created: 0, updated: 0,
};

describe("OS4 impressão do contrato", () => {
  it("A4 com Estabelecimento, cliente, objetos, cobertura, valores, vigência e assinatura, sem HTML injetado", () => {
    const html = buildContractPrintHtml(contract, { name: "Clima Bom Refrigeração", document: "12345678000190", address: "Rua A, 10", phone: "5511933334444" }, Date.UTC(2026, 10, 20, 15));
    for (const text of ["Clima Bom Refrigeração", "CNPJ 12.345.678/0001-90", "Contrato de manutenção · Contrato nº 3", "Buffet &lt;Alegria&gt;", "(11) 98765-0001",
      "Split 12000 BTUs", "Limpeza de filtros e carga de gás", "2 visitas por mês", "R$ 180,00 por visita excedente", "aprovação do cliente",
      "R$ 350,00 mensal", "por prazo indeterminado", "5,5% ao ano", "Atendimento em até 48 horas.", "class=\"sign\"", "size:A4"])
      expect(html, text).toContain(text);
    expect(html).not.toContain("<Alegria>");
  });

  it("orçamento impresso indica o item coberto pelo contrato", () => {
    const order: any = {
      id: "o1", number: 7, display_number: "7", status: "analyzing", status_label: "Em análise", item: "Ar-condicionado", problem: "Preventiva",
      customer: { name: "Buffet", phone: "5511987650001" }, labels: { singular: "Ordem de serviço", item: "Item", problem: "Problema", customer_singular: "Cliente" },
      quote: { items: [{ description: "Limpeza do filtro", quantity: 1, unit_cents: 0, covered: true }, { description: "Peça", quantity: 1, unit_cents: 5000 }],
        total_cents: 5000, note: "", valid_days: 7, valid_until: null, sent_at: null, version: 1, expired: false },
    };
    const html = buildPrintHtml({ order, company: null, now: Date.UTC(2026, 10, 20) }, "quote", "a4");
    expect(html).toContain("Limpeza do filtro (coberto pelo contrato)");
    expect(html).not.toContain("Peça (coberto");
  });
});
