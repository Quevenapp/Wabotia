import { describe, expect, it } from "vitest";
import type { AreaTemplate, BaseStatus, CustomWorkType } from "../src/modules/os/contracts";
import { servicosTemplate } from "../src/area-templates/models/servicos";
import { oficinaMecanicaTemplate } from "../src/area-templates/models/oficina-mecanica";
import { lavanderiaCosturaTemplate } from "../src/area-templates/models/lavanderia-costura";
import { despachanteTemplate, graficaTemplate, imobiliariaTemplate } from "../src/area-templates/models/exemplos";

// Não depende do catálogo nem dos validadores de A/M, ainda em implementação.
const templates: AreaTemplate[] = [
  servicosTemplate, oficinaMecanicaTemplate, lavanderiaCosturaTemplate,
  graficaTemplate, despachanteTemplate, imobiliariaTemplate,
];
const statuses: BaseStatus[] = [
  "received", "analyzing", "quoted", "approved", "declined",
  "in_progress", "ready", "delivered", "cancelled",
];
const terminal = (status: BaseStatus) => status === "delivered" || status === "cancelled";
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function text(value: string, max: number, empty = false) {
  expect(value).toBe(value.trim());
  expect([...value].length).toBeGreaterThanOrEqual(empty ? 0 : 1);
  expect([...value].length).toBeLessThanOrEqual(max);
}

function ids(values: string[], max: number) {
  expect(new Set(values).size).toBe(values.length);
  for (const value of values) {
    expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    text(value, max);
  }
}

function keys(value: object, allowed: string[]) {
  expect(Object.keys(value).filter((key) => !allowed.includes(key))).toEqual([]);
}

function messages(type: CustomWorkType) {
  const values = [type.pickup_reminder_text, ...type.stages.map((stage) => stage.message)];
  for (const transition of type.transitions) {
    if (transition.kind === "customer_approval") values.push(transition.request_text);
  }
  const markers = new Set([
    "numero", "item", "estado", "total", "validade", "garantia", "pronto", "previsao",
    "tipo", "etapa", "numero_tipo", "identificador",
    ...type.fields.filter((field) => field.client_visible && !field.sensitive).map((field) => `campo_${field.id}`),
  ]);
  for (const value of values) {
    text(value, 900, true);
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) expect(markers.has(match[1])).toBe(true);
    expect(value.replace(/\{[^{}]+\}/g, "")).not.toMatch(/[{}]/);
  }
}

function graph(type: CustomWorkType) {
  const edges = type.transitions.map(({ from, to }) => ({ from, to }));
  const quote = type.features.quote;
  if (quote) {
    // Estas operações são protegidas; não devem virar transições manuais.
    edges.push(...quote.source_stages.map((from) => ({ from, to: quote.sent_stage })));
    edges.push(
      { from: quote.sent_stage, to: quote.approved_stage },
      { from: quote.sent_stage, to: quote.declined_stage },
      { from: quote.sent_stage, to: quote.edited_stage },
    );
  }
  return (start: string) => {
    const reached = new Set([start]);
    const pending = [start];
    while (pending.length) {
      const from = pending.pop();
      for (const edge of edges.filter((edge) => edge.from === from)) {
        if (!reached.has(edge.to)) {
          reached.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    return reached;
  };
}

describe("modelos de serviços: catálogo declarativo", () => {
  it("exporta seis exemplos independentes com IDs únicos e sem substituir o embutido", () => {
    expect(templates).toHaveLength(6);
    ids(templates.map((template) => template.id), 64);
    ids(templates.flatMap((template) => template.work_types.map((type) => type.id)), 64);
    expect(templates.flatMap((template) => template.work_types).some((type) => type.id === "service_order")).toBe(false);
  });

  for (const template of templates) {
    describe(template.name, () => {
      it("respeita o manifesto, os limites de tamanho e as referências de menu", () => {
        expect(template.schema_version).toBe(1);
        expect(template.version).toBe(1);
        expect(template.modules.os).toBe(true);
        expect(size(template)).toBeLessThanOrEqual(128 * 1024);
        expect(template.work_types.length).toBeGreaterThan(0);
        expect(template.work_types.length).toBeLessThanOrEqual(20);
        expect(JSON.stringify({ os_work_types: template.work_types, os_vocabulary: template.vocabulary }).length).toBeLessThanOrEqual(150000);
        keys(template, ["schema_version", "id", "version", "name", "description", "work_types", "modules", "vocabulary", "departments", "ticket_categories", "menus", "texts", "bot", "manual_steps"]);
        ids(template.work_types.map((type) => type.id), 64);
        ids(template.menus.map((menu) => menu.id), 64);
        ids(template.departments.map((department) => department.id), 64);
        ids(template.ticket_categories.map((category) => category.id), 64);
        for (const value of Object.values(template.vocabulary)) text(value, 80);
        for (const type of template.work_types) text(`area_${template.id}__${type.id}`, 64);
        for (const department of template.departments) {
          expect(department.members).toEqual([]);
          expect(department.enabled).toBe(true);
        }
        for (const menu of template.menus) {
          if (menu.type === "os_open" || menu.type === "os_track") {
            const type = template.work_types.find((type) => type.id === menu.type_id);
            expect(type).toBeDefined();
            if (menu.type === "os_open") {
              expect(type?.features.customer_open).toBe(true);
              expect(type?.archived).toBe(false);
            }
          } else if (menu.type === "human" && menu.department_id !== null) {
            expect(template.departments.some((department) => department.id === menu.department_id)).toBe(true);
          }
        }
        // Sugestões não atribuem permissões nem habilitam comandos de escrita.
        expect(template.bot.allowed_operations).toEqual([]);
        expect(template.bot.suggested_roles).toEqual([]);
      });

      for (const type of template.work_types) {
        it(`${type.labels.singular}: respeita os campos e limites da seção 3`, () => {
          expect(type.schema_version).toBe(1);
          expect(type.kind).toBe("custom");
          expect(type.revision).toBe(1);
          expect(type.archived).toBe(false);
          expect(size(type)).toBeLessThanOrEqual(12 * 1024);
          expect(size({ schema_version: 1, type })).toBeLessThanOrEqual(16 * 1024);
          expect(type.fields.length).toBeLessThanOrEqual(24);
          expect(type.stages.length).toBeLessThanOrEqual(32);
          expect(type.transitions.length).toBeLessThanOrEqual(128);
          keys(type, ["schema_version", "kind", "id", "revision", "archived", "labels", "number_prefix", "terms", "fields", "retired_field_ids", "stages", "retired_stage_ids", "initial_stage", "transitions", "features", "pickup_reminder_text"]);
          for (const value of Object.values(type.labels)) text(value, 80);
          text(type.number_prefix, 12);
          if (type.terms !== null) text(type.terms, 1400);
          ids([...type.fields.map((field) => field.id), ...type.retired_field_ids], 32);
          ids([...type.stages.map((stage) => stage.id), ...type.retired_stage_ids], 32);
          ids(type.transitions.map((transition) => transition.id), 32);
          for (const field of type.fields) {
            expect(["__proto__", "constructor", "prototype"]).not.toContain(field.id);
            text(field.label, 80);
            text(field.help, 240, true);
            if (field.sensitive) {
              expect(field.client_visible).toBe(false);
              expect(field.required).toBe(false);
            }
            if (type.features.customer_open && field.required) {
              expect(field.client_visible).toBe(true);
              expect(field.sensitive).toBe(false);
            }
            const base = ["id", "label", "help", "required", "client_visible", "sensitive", "kind"];
            switch (field.kind) {
              case "text":
                keys(field, [...base, "multiline", "max_length"]);
                expect(Number.isInteger(field.max_length)).toBe(true);
                expect(field.max_length).toBeGreaterThan(0);
                expect(field.max_length).toBeLessThanOrEqual(2000);
                break;
              case "integer":
              case "decimal":
                keys(field, [...base, "min", "max", ...(field.kind === "decimal" ? ["scale"] : [])]);
                expect(Number.isFinite(field.min) && Number.isFinite(field.max)).toBe(true);
                expect(field.min).toBeLessThanOrEqual(field.max);
                if (field.kind === "integer") {
                  expect(Number.isSafeInteger(field.min) && Number.isSafeInteger(field.max)).toBe(true);
                } else {
                  expect(Number.isInteger(field.scale)).toBe(true);
                  expect(field.scale).toBeGreaterThanOrEqual(0);
                  expect(field.scale).toBeLessThanOrEqual(6);
                }
                break;
              case "choice":
                keys(field, [...base, "options"]);
                expect(field.options.length).toBeGreaterThan(0);
                expect(field.options.length).toBeLessThanOrEqual(32);
                ids(field.options.map((option) => option.id), 32);
                for (const option of field.options) {
                  keys(option, ["id", "label"]);
                  text(option.label, 80);
                }
                break;
              case "date":
                keys(field, [...base, "min", "max"]);
                for (const date of [field.min, field.max]) {
                  if (date !== null) {
                    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                    expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
                  }
                }
                if (field.min !== null && field.max !== null) expect(field.min <= field.max).toBe(true);
                break;
              case "boolean":
                keys(field, base);
                break;
            }
          }
          messages(type);
        });

        it(`${type.labels.singular}: usa estados válidos, referências existentes e finais alcançáveis`, () => {
          const stageIds = new Set(type.stages.map((stage) => stage.id));
          const initial = type.stages.find((stage) => stage.id === type.initial_stage);
          expect(initial?.base_status).toBe("received");
          const finals = type.stages.filter((stage) => stage.base_status === "delivered");
          const cancelled = type.stages.filter((stage) => stage.base_status === "cancelled");
          expect(finals.length).toBeGreaterThan(0);
          expect(cancelled.length).toBeGreaterThan(0);
          for (const stage of type.stages) {
            keys(stage, ["id", "label", "base_status", "message"]);
            text(stage.label, 80);
            expect(statuses).toContain(stage.base_status);
            if (terminal(stage.base_status)) expect(type.transitions.filter((transition) => transition.from === stage.id)).toEqual([]);
          }
          for (const transition of type.transitions) {
            keys(transition, ["id", "from", "to", "label", "kind", ...(transition.kind === "customer_approval" ? ["valid_hours", "request_text"] : [])]);
            expect(stageIds.has(transition.from)).toBe(true);
            expect(stageIds.has(transition.to)).toBe(true);
            expect(transition.from).not.toBe(transition.to);
            text(transition.label, 80);
            if (transition.kind === "customer_approval") {
              expect(Number.isInteger(transition.valid_hours)).toBe(true);
              expect(transition.valid_hours).toBeGreaterThanOrEqual(1);
              expect(transition.valid_hours).toBeLessThanOrEqual(720);
              text(transition.request_text, 900);
            }
          }
          const reachable = graph(type);
          expect([...reachable(type.initial_stage)].sort()).toEqual([...stageIds].sort());
          for (const stage of type.stages.filter((stage) => !terminal(stage.base_status))) {
            const reached = reachable(stage.id);
            expect(finals.some((end) => reached.has(end.id))).toBe(true);
            expect(cancelled.some((end) => reached.has(end.id))).toBe(true);
          }
        });

        it(`${type.labels.singular}: preserva o protocolo de orçamento e os limites dos recursos`, () => {
          const features = type.features;
          for (const [value, max] of [[features.warranty_days, 3650], [features.pickup_reminder_days, 365], [features.stale_days, 365]]) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(max);
          }
          if (features.pickup_reminder_days > 0) {
            expect(type.stages.some((stage) => stage.base_status === "ready")).toBe(true);
            text(type.pickup_reminder_text, 900);
          }
          const quote = features.quote;
          const status = (id: string) => type.stages.find((stage) => stage.id === id)?.base_status;
          if (quote) {
            expect(status(quote.sent_stage)).toBe("quoted");
            expect(status(quote.approved_stage)).toBe("approved");
            expect(status(quote.declined_stage)).toBe("declined");
            expect(status(quote.edited_stage)).toBe("analyzing");
            ids(quote.source_stages, 32);
            expect(quote.source_stages.length).toBeGreaterThan(0);
            for (const source of quote.source_stages) expect(["received", "analyzing", "quoted", "declined"]).toContain(status(source));
            for (const transition of type.transitions) {
              expect(["quoted", "approved", "declined"]).not.toContain(status(transition.to));
              if (transition.from === quote.sent_stage) expect(status(transition.to)).toBe("cancelled");
            }
          } else {
            expect(type.stages.some((stage) => ["quoted", "approved", "declined"].includes(stage.base_status))).toBe(false);
          }
        });
      }
    });
  }

  it("separa o aceite da arte do orçamento e não permite produção sem aprovação da etapa", () => {
    const type = graficaTemplate.work_types[0];
    const production = type.transitions.filter((transition) => transition.to === "producao");
    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({ from: "revisao", kind: "customer_approval" });
    expect(type.features.quote?.approved_stage).not.toBe("producao");
    expect(type.transitions.find((transition) => transition.id === "retrabalhar")?.to).toBe("arte");
  });
});
