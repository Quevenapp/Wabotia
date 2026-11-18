import { describe, expect, it } from "vitest";
import { advogadosTemplate } from "../src/area-templates/models/advogados";
import { escritorioAdvocaciaTemplate } from "../src/area-templates/models/escritorio-advocacia";
import type {
  AreaTemplate,
  BaseStatus,
  CustomWorkType,
} from "../src/modules/os/contracts";

// Conferência declarativa independente do aplicador e da validação de M/A.
const templates: AreaTemplate[] = [
  advogadosTemplate,
  escritorioAdvocaciaTemplate,
];
const statuses: BaseStatus[] = [
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
const terminal = new Set<BaseStatus>(["delivered", "cancelled"]);
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const length = (value: string) => [...value.trim()].length;

function textLimit(value: string, max: number, empty = false) {
  expect(length(value)).toBeGreaterThanOrEqual(empty ? 0 : 1);
  expect(length(value)).toBeLessThanOrEqual(max);
}

function uniqueIds(ids: string[], max: number) {
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    textLimit(id, max);
  }
}

function edges(type: CustomWorkType): Array<[string, string]> {
  const result: Array<[string, string]> = type.transitions.map((transition) => [
    transition.from,
    transition.to,
  ]);
  // O grafo inclui as operações de orçamento, que não são transições manuais.
  const quote = type.features.quote;
  if (quote) {
    for (const source of quote.source_stages) {
      result.push([source, quote.sent_stage]);
    }
    for (const target of [
      quote.approved_stage,
      quote.declined_stage,
      quote.edited_stage,
    ]) {
      result.push([quote.sent_stage, target]);
    }
  }
  return result;
}

function reachable(type: CustomWorkType, start: string): Set<string> {
  const graph = edges(type);
  const found = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const [from, to] of graph) {
      if (from !== current || found.has(to)) continue;
      found.add(to);
      pending.push(to);
    }
  }
  return found;
}

describe("modelos de advocacia: identidades", () => {
  it("mantém modelos distintos e IDs globais únicos após o prefixo contratual", () => {
    uniqueIds(templates.map((template) => template.id), 64);
    const globalIds = templates.flatMap((template) =>
      [
        ...template.work_types,
        ...template.menus,
        ...template.departments,
        ...template.ticket_categories,
      ].map((entry) => `area_${template.id}__${entry.id}`),
    );
    expect(new Set(globalIds).size).toBe(globalIds.length);
    expect(templates.map((template) => template.id)).toEqual([
      "advogados",
      "escritorio_advocacia",
    ]);
  });
});

for (const template of templates) {
  describe(`modelo jurídico: ${template.id}`, () => {
    it("respeita os limites do manifesto, da definição e da cópia imutável", () => {
      expect(template.schema_version).toBe(1);
      expect(template.version).toBe(1);
      expect(bytes(template)).toBeLessThanOrEqual(128 * 1024);
      expect(template.work_types.length).toBeLessThanOrEqual(20);
      expect(template.work_types.map((type) => type.id)).toEqual([
        "advocacia_processo",
        "advocacia_consultivo",
      ]);
      expect(template.work_types.map((type) => type.fields.length)).toEqual([11, 5]);
      expect(template.work_types.map((type) => type.stages.length)).toEqual([13, 10]);
      for (const value of Object.values(template.vocabulary)) textLimit(value, 80);
      for (const type of template.work_types) {
        expect(type.schema_version).toBe(1);
        expect(type.kind).toBe("custom");
        expect(type.id).not.toBe("service_order");
        expect(type.revision).toBe(1);
        expect(type.archived).toBe(false);
        expect(bytes(type)).toBeLessThanOrEqual(12 * 1024);
        expect(bytes({ schema_version: 1, type })).toBeLessThanOrEqual(16 * 1024);
        expect(type.fields.length).toBeLessThanOrEqual(24);
        expect(type.stages.length).toBeLessThanOrEqual(32);
        expect(type.transitions.length).toBeLessThanOrEqual(128);
        for (const value of Object.values(type.labels)) textLimit(value, 80);
        textLimit(type.number_prefix, 12);
        if (type.terms !== null) textLimit(type.terms, 1400);
        textLimit(type.pickup_reminder_text, 900, true);
        expect(type.features.warranty_days).toBeGreaterThanOrEqual(0);
        expect(type.features.warranty_days).toBeLessThanOrEqual(3650);
        for (const days of [
          type.features.pickup_reminder_days,
          type.features.stale_days,
        ]) {
          expect(Number.isInteger(days)).toBe(true);
          expect(days).toBeGreaterThanOrEqual(0);
          expect(days).toBeLessThanOrEqual(365);
        }
      }
    });

    it("usa IDs válidos e únicos em cada escopo, sem reaproveitar aposentados", () => {
      uniqueIds(template.work_types.map((type) => type.id), 64);
      for (const type of template.work_types) {
        textLimit(`area_${template.id}__${type.id}`, 64);
        uniqueIds([...type.fields.map((field) => field.id), ...type.retired_field_ids], 32);
        uniqueIds([...type.stages.map((stage) => stage.id), ...type.retired_stage_ids], 32);
        uniqueIds(type.transitions.map((transition) => transition.id), 32);
        for (const field of type.fields) {
          expect(["__proto__", "constructor", "prototype"]).not.toContain(field.id);
          if (field.kind === "choice") {
            uniqueIds(field.options.map((option) => option.id), 32);
          }
        }
      }
    });

    it("aponta para estados de base e etapas existentes, com finais sem saídas", () => {
      for (const type of template.work_types) {
        const stages = new Map(type.stages.map((stage) => [stage.id, stage]));
        expect(stages.get(type.initial_stage)?.base_status).toBe("received");
        expect(type.stages.some((stage) => stage.base_status === "delivered")).toBe(true);
        expect(type.stages.some((stage) => stage.base_status === "cancelled")).toBe(true);
        for (const stage of type.stages) {
          expect(statuses).toContain(stage.base_status);
          textLimit(stage.label, 80);
          textLimit(stage.message, 900, true);
          if (terminal.has(stage.base_status)) {
            expect(edges(type).filter(([from]) => from === stage.id)).toEqual([]);
          }
        }
        for (const transition of type.transitions) {
          expect(stages.has(transition.from)).toBe(true);
          expect(stages.has(transition.to)).toBe(true);
          expect(transition.from).not.toBe(transition.to);
          textLimit(transition.label, 80);
          if (transition.kind === "customer_approval") {
            expect(transition.valid_hours).toBeGreaterThanOrEqual(1);
            expect(transition.valid_hours).toBeLessThanOrEqual(720);
            textLimit(transition.request_text, 900);
          }
        }
      }
    });

    it("alcança todas as etapas e permite concluir ou cancelar cada etapa aberta", () => {
      for (const type of template.work_types) {
        expect([...reachable(type, type.initial_stage)].sort()).toEqual(
          type.stages.map((stage) => stage.id).sort(),
        );
        for (const stage of type.stages) {
          if (terminal.has(stage.base_status)) continue;
          const destinations = reachable(type, stage.id);
          for (const status of terminal) {
            expect(type.stages.some((target) =>
              target.base_status === status && destinations.has(target.id),
            )).toBe(true);
          }
        }
      }
    });

    it("reserva envio, decisão e edição da proposta às operações de orçamento", () => {
      for (const type of template.work_types) {
        const quote = type.features.quote;
        expect(quote).not.toBeNull();
        if (!quote) throw new Error("Modelo jurídico sem política de orçamento");
        expect(quote.default_valid_days).toBe(7);
        const stages = new Map(type.stages.map((stage) => [stage.id, stage]));
        expect(stages.get(quote.sent_stage)?.base_status).toBe("quoted");
        expect(stages.get(quote.approved_stage)?.base_status).toBe("approved");
        expect(stages.get(quote.declined_stage)?.base_status).toBe("declined");
        expect(stages.get(quote.edited_stage)?.base_status).toBe("analyzing");
        expect(quote.source_stages.length).toBeGreaterThan(0);
        uniqueIds(quote.source_stages, 32);
        for (const source of quote.source_stages) {
          expect(["received", "analyzing", "quoted", "declined"]).toContain(
            stages.get(source)?.base_status,
          );
        }
        for (const transition of type.transitions) {
          expect([quote.sent_stage, quote.approved_stage, quote.declined_stage])
            .not.toContain(transition.to);
          expect(transition.from === quote.sent_stage &&
            transition.to === quote.edited_stage).toBe(false);
        }
        for (const id of [quote.sent_stage, quote.approved_stage, quote.declined_stage]) {
          expect(stages.get(id)?.message).toBe("");
        }
      }
    });

    it("limita campos e mantém os dados sensíveis opcionais e privados", () => {
      for (const type of template.work_types) {
        for (const field of type.fields) {
          textLimit(field.label, 80);
          textLimit(field.help, 240, true);
          if (field.sensitive) {
            expect(field.required).toBe(false);
            expect(field.client_visible).toBe(false);
          }
          if (type.features.customer_open && field.required) {
            expect(field.client_visible).toBe(true);
            expect(field.sensitive).toBe(false);
          }
          if (field.kind === "text") {
            expect(Number.isInteger(field.max_length)).toBe(true);
            expect(field.max_length).toBeGreaterThan(0);
            expect(field.max_length).toBeLessThanOrEqual(2000);
          }
          if (field.kind === "choice") {
            expect(field.options.length).toBeGreaterThan(0);
            expect(field.options.length).toBeLessThanOrEqual(32);
            for (const option of field.options) textLimit(option.label, 80);
          }
          if (field.kind === "decimal" || field.kind === "integer") {
            expect(Number.isFinite(field.min)).toBe(true);
            expect(Number.isFinite(field.max)).toBe(true);
            expect(field.min).toBeLessThanOrEqual(field.max);
            if (field.kind === "decimal") {
              expect(Number.isInteger(field.scale)).toBe(true);
              expect(field.scale).toBeGreaterThanOrEqual(0);
              expect(field.scale).toBeLessThanOrEqual(6);
            } else {
              expect(Number.isSafeInteger(field.min)).toBe(true);
              expect(Number.isSafeInteger(field.max)).toBe(true);
            }
          }
          if (field.kind === "date") {
            for (const date of [field.min, field.max]) {
              if (date === null) continue;
              expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
              expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
            }
            if (field.min !== null && field.max !== null) {
              expect(field.min <= field.max).toBe(true);
            }
          }
        }
      }
      const process = template.work_types[0];
      for (const field of process.fields.filter((field) => field.id !== "natureza")) {
        expect(field.sensitive).toBe(true);
      }
      const advisory = template.work_types[1];
      expect(advisory.fields.find((field) => field.id === "escopo_interno"))
        .toMatchObject({ sensitive: true, client_visible: false, required: false });
    });

    it("usa somente marcadores contratuais sem interpolar campos privados", () => {
      for (const type of template.work_types) {
        const allowed = new Set([
          "numero", "item", "estado", "total", "validade", "garantia",
          "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador",
          ...type.fields.filter((field) => field.client_visible && !field.sensitive)
            .map((field) => `campo_${field.id}`),
        ]);
        const messages = [
          ...type.stages.map((stage) => stage.message),
          type.pickup_reminder_text,
          ...type.transitions.flatMap((transition) =>
            transition.kind === "customer_approval" ? [transition.request_text] : [],
          ),
        ];
        for (const message of messages) {
          for (const match of message.matchAll(/\{([^{}]+)\}/g)) {
            expect(allowed.has(match[1])).toBe(true);
          }
        }
      }
    });

    it("resolve referências locais dos menus sem registrar extensão ou permissões", () => {
      const types = new Map(template.work_types.map((type) => [type.id, type]));
      const departments = new Set(template.departments.map((department) => department.id));
      for (const records of [template.departments, template.ticket_categories, template.menus]) {
        uniqueIds(records.map((record) => record.id), 64);
      }
      expect(template.modules.os).toBe(true);
      expect(template.modules).not.toHaveProperty("juridico");
      for (const department of template.departments) {
        expect(department.members).toEqual([]);
        expect(department.enabled).toBe(true);
      }
      for (const menu of template.menus) {
        if (menu.type === "os_open" || menu.type === "os_track") {
          expect(types.has(menu.type_id)).toBe(true);
          if (menu.type === "os_open") {
            expect(types.get(menu.type_id)?.features.customer_open).toBe(true);
            expect(types.get(menu.type_id)?.archived).toBe(false);
          }
        } else if (menu.type === "human" && menu.department_id !== null) {
          expect(departments.has(menu.department_id)).toBe(true);
        }
      }
      expect(template.bot.allowed_operations).toEqual([]);
      expect(template.bot.suggested_roles).toEqual([]);
      expect(template.manual_steps.length).toBeGreaterThan(0);
    });
  });
}
