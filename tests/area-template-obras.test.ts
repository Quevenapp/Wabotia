import { describe, expect, it } from "vitest";
import { engenheirosTemplate } from "../src/area-templates/models/engenheiros";
import { arquitetosTemplate } from "../src/area-templates/models/arquitetos";
import { construtorasTemplate } from "../src/area-templates/models/construtoras";
import type {
  AreaTemplate,
  BaseStatus,
  CustomWorkType,
} from "../src/modules/os/contracts";

// Independente do registro de A e do validador de M, ainda em desenvolvimento.
const templates: AreaTemplate[] = [
  engenheirosTemplate,
  arquitetosTemplate,
  construtorasTemplate,
];
const baseStatuses: BaseStatus[] = [
  "received", "analyzing", "quoted", "approved", "declined",
  "in_progress", "ready", "delivered", "cancelled",
];
const terminal = (status: BaseStatus) =>
  status === "delivered" || status === "cancelled";
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function text(value: string, max: number, required = true) {
  expect(value).toBe(value.trim());
  expect([...value].length).toBeGreaterThanOrEqual(required ? 1 : 0);
  expect([...value].length).toBeLessThanOrEqual(max);
}

function ids(values: string[], max = 32) {
  expect(new Set(values).size).toBe(values.length);
  for (const value of values) {
    expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    text(value, max);
  }
}

function message(value: string, type: CustomWorkType) {
  text(value, 900, false);
  const markers = new Set([
    "numero", "item", "estado", "total", "validade", "garantia",
    "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador",
    ...type.fields.filter((f) => f.client_visible && !f.sensitive)
      .map((f) => `campo_${f.id}`),
  ]);
  for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
    expect(markers.has(match[1]), match[1]).toBe(true);
  }
}

// As operações protegidas de orçamento também fazem parte do grafo efetivo.
function edges(type: CustomWorkType): Array<[string, string]> {
  const result: Array<[string, string]> = type.transitions.map((t) => [t.from, t.to]);
  const quote = type.features.quote;
  if (quote) {
    for (const source of quote.source_stages) result.push([source, quote.sent_stage]);
    result.push(
      [quote.sent_stage, quote.approved_stage],
      [quote.sent_stage, quote.declined_stage],
      [quote.sent_stage, quote.edited_stage],
    );
  }
  return result;
}

function reachable(start: string, graph: Array<[string, string]>) {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const from = pending.pop();
    for (const [source, to] of graph) {
      if (source === from && !seen.has(to)) {
        seen.add(to);
        pending.push(to);
      }
    }
  }
  return seen;
}

describe("modelos de obras: manifesto declarativo", () => {
  it("deixa a identificação do imóvel no pós-obra visível ao próprio solicitante", () => {
    const type = construtorasTemplate.work_types.find((type) => type.id === "construtora_pos_obra")!;
    expect(type.labels.item).toBe("Referência administrativa (sem endereço)");
    expect(type.labels.problem).toBe("Problema observado (sem endereço ou unidade)");
    // Parte 2: a identificação passou ao objeto Imóvel, com a mesma visibilidade.
    expect(type.object_type_id).toBe("imovel");
    expect(type.retired_field_ids).toContain("unidade");
    expect(construtorasTemplate.object_types!.find((object) => object.id === type.object_type_id)!
      .fields.find((field) => field.id === "unidade")).toMatchObject({
      kind: "text", required: false, client_visible: true, sensitive: false,
    });
    expect(type.list_fields).toContainEqual({ ref: { scope: "object", field_id: "unidade" }, column: true, filter: true });
    expect(construtorasTemplate.texts.instructions).toContain("registre a identificação no cadastro do Imóvel");
    expect(construtorasTemplate.bot.instructions).toContain("pode pedir e citar a identificação do imóvel do próprio solicitante");
    expect(construtorasTemplate.manual_steps.join(" ")).not.toContain("Qual é o empreendimento e a unidade? Obrigatória.");
  });

  it("mantém identificadores de modelos únicos", () => {
    ids(templates.map((t) => t.id), 64);
  });

  for (const template of templates) {
    it(`${template.name}: respeita limites e referências do manifesto`, () => {
      expect(template.schema_version).toBe(1);
      // Versões publicadas pela parte 2 (objeto Imóvel).
      expect(template.version).toBe(({ engenharia: 3, arquitetura: 2, construtora: 2 } as Record<string, number>)[template.id]);
      expect(bytes(template)).toBeLessThanOrEqual(128 * 1024);
      expect(template.work_types.length).toBeGreaterThan(0);
      expect(template.work_types.length).toBeLessThanOrEqual(20);
      ids(template.work_types.map((t) => t.id), 64);
      // A compilação acrescenta o prefixo; ele também precisa caber no ID do tipo.
      ids(template.work_types.map((t) => `area_${template.id}__${t.id}`), 64);
      ids(template.departments.map((d) => d.id), 64);
      ids(template.ticket_categories.map((c) => c.id), 64);
      ids(template.menus.map((m) => m.id), 64);
      for (const label of Object.values(template.vocabulary)) text(label, 80);
      for (const menu of template.menus) {
        if (menu.type === "os_open" || menu.type === "os_track") {
          const type = template.work_types.find((t) => t.id === menu.type_id);
          expect(type, menu.type_id).toBeDefined();
          if (menu.type === "os_open") {
            expect(type?.archived).toBe(false);
            expect(type?.features.customer_open).toBe(true);
          }
        } else if (menu.type === "human" && menu.department_id !== null) {
          expect(template.departments.some((d) => d.id === menu.department_id)).toBe(true);
        }
      }
    });

    for (const type of template.work_types) {
      describe(type.id, () => {
        it("respeita os limites de definição, campos e textos", () => {
          expect(type.schema_version).toBe(1);
          expect(type.kind).toBe("custom");
          expect(type.id).not.toBe("service_order");
          expect(type.revision).toBe(1);
          expect(bytes(type)).toBeLessThanOrEqual(12 * 1024);
          expect(bytes({ schema_version: 1, type })).toBeLessThanOrEqual(16 * 1024);
          expect(type.fields.length).toBeLessThanOrEqual(24);
          expect(type.stages.length).toBeLessThanOrEqual(32);
          expect(type.transitions.length).toBeLessThanOrEqual(128);
          for (const label of Object.values(type.labels)) text(label, 80);
          text(type.number_prefix, 12);
          if (type.terms !== null) text(type.terms, 1400);
          ids(type.fields.map((f) => f.id));
          ids(type.stages.map((s) => s.id));
          ids(type.transitions.map((t) => t.id));
          ids([...type.fields.map((f) => f.id), ...type.retired_field_ids]);
          ids([...type.stages.map((s) => s.id), ...type.retired_stage_ids]);
          for (const field of type.fields) {
            expect(["__proto__", "constructor", "prototype"]).not.toContain(field.id);
            text(field.label, 80);
            text(field.help, 240, false);
            if (field.sensitive) {
              expect(field.required).toBe(false);
              expect(field.client_visible).toBe(false);
            }
            if (type.features.customer_open && field.required) {
              expect(field.client_visible).toBe(true);
              expect(field.sensitive).toBe(false);
            }
            switch (field.kind) {
              case "text":
                expect(Number.isInteger(field.max_length)).toBe(true);
                expect(field.max_length).toBeGreaterThan(0);
                expect(field.max_length).toBeLessThanOrEqual(2000);
                break;
              case "choice":
                expect(field.options.length).toBeGreaterThan(0);
                expect(field.options.length).toBeLessThanOrEqual(32);
                ids(field.options.map((o) => o.id));
                for (const option of field.options) text(option.label, 80);
                break;
              case "integer":
              case "decimal":
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
              case "date":
                for (const date of [field.min, field.max]) {
                  if (date !== null) {
                    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                    expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
                  }
                }
                if (field.min !== null && field.max !== null) expect(field.min <= field.max).toBe(true);
                break;
            }
          }
          for (const [key, max] of [
            ["warranty_days", 3650], ["pickup_reminder_days", 365], ["stale_days", 365],
          ] as const) {
            expect(Number.isInteger(type.features[key])).toBe(true);
            expect(type.features[key]).toBeGreaterThanOrEqual(0);
            expect(type.features[key]).toBeLessThanOrEqual(max);
          }
          if (type.features.pickup_reminder_days > 0) {
            expect(type.stages.some((s) => s.base_status === "ready")).toBe(true);
          }
          message(type.pickup_reminder_text, type);
        });

        it("usa estados válidos, referências existentes e caminhos de conclusão e cancelamento", () => {
          const stages = new Map(type.stages.map((s) => [s.id, s]));
          expect(stages.get(type.initial_stage)?.base_status).toBe("received");
          const graph = edges(type);
          for (const stage of type.stages) {
            expect(baseStatuses).toContain(stage.base_status);
            text(stage.label, 80);
            message(stage.message, type);
            if (terminal(stage.base_status)) {
              expect(graph.filter(([from]) => from === stage.id)).toEqual([]);
            } else {
              const destinations = reachable(stage.id, graph);
              for (const status of ["delivered", "cancelled"]) {
                expect(type.stages.some((s) => s.base_status === status && destinations.has(s.id))).toBe(true);
              }
            }
          }
          expect(type.stages.some((s) => s.base_status === "delivered")).toBe(true);
          expect(type.stages.some((s) => s.base_status === "cancelled")).toBe(true);
          expect([...reachable(type.initial_stage, graph)].sort()).toEqual([...stages.keys()].sort());
          for (const [from, to] of graph) {
            expect(stages.has(from), from).toBe(true);
            expect(stages.has(to), to).toBe(true);
            expect(from).not.toBe(to);
          }
          for (const transition of type.transitions) {
            text(transition.label, 80);
            if (transition.kind === "customer_approval") {
              expect(Number.isInteger(transition.valid_hours)).toBe(true);
              expect(transition.valid_hours).toBeGreaterThanOrEqual(1);
              expect(transition.valid_hours).toBeLessThanOrEqual(720);
              text(transition.request_text, 900);
              message(transition.request_text, type);
            }
          }
        });

        it("reserva envio, decisão e edição de orçamento às operações protegidas", () => {
          const stages = new Map(type.stages.map((s) => [s.id, s.base_status]));
          const quote = type.features.quote;
          if (quote === null) {
            for (const status of stages.values()) expect(["quoted", "approved", "declined"]).not.toContain(status);
            return;
          }
          expect(stages.get(quote.sent_stage)).toBe("quoted");
          expect(stages.get(quote.approved_stage)).toBe("approved");
          expect(stages.get(quote.declined_stage)).toBe("declined");
          expect(stages.get(quote.edited_stage)).toBe("analyzing");
          ids(quote.source_stages);
          expect(quote.source_stages.length).toBeGreaterThan(0);
          for (const source of quote.source_stages) {
            expect(["received", "analyzing", "quoted", "declined"]).toContain(stages.get(source));
          }
          for (const transition of type.transitions) {
            expect([quote.sent_stage, quote.approved_stage, quote.declined_stage]).not.toContain(transition.to);
            if (transition.from === quote.sent_stage) {
              expect(stages.get(transition.to)).toBe("cancelled");
            }
          }
        });
      });
    }
  }
});
