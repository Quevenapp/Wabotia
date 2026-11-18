import { describe, expect, it } from "vitest";
import type {
  AreaModuleId,
  AreaTemplate,
  BaseStatus,
  CustomWorkType,
} from "../src/modules/os/contracts";
import { escolasTemplate } from "../src/area-templates/models/escolas";
import { professoresTemplate } from "../src/area-templates/models/professores";

// Sem dependência do catálogo ou do validador que a tarefa A implementará.
const templates: AreaTemplate[] = [escolasTemplate, professoresTemplate];
const baseStatuses: BaseStatus[] = [
  "received", "analyzing", "quoted", "approved", "declined",
  "in_progress", "ready", "delivered", "cancelled",
];
const moduleIds: AreaModuleId[] = [
  "os", "queue", "forms", "agenda", "reserva", "pedido",
  "mensalidade", "suporte", "mesas", "entrega", "payments", "erp",
];
const terminalStatuses: BaseStatus[] = ["delivered", "cancelled"];
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function textLimit(value: string, max: number, required = true) {
  expect(value).toBe(value.trim());
  const length = [...value.trim()].length;
  expect(length).toBeGreaterThanOrEqual(required ? 1 : 0);
  expect(length).toBeLessThanOrEqual(max);
}

function uniqueIds(items: Array<{ id: string }>, max: number) {
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  for (const { id } of items) {
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    textLimit(id, max);
  }
}

function reachable(type: CustomWorkType, start: string) {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const transition of type.transitions) {
      if (transition.from === current) pending.push(transition.to);
    }
  }
  return visited;
}

describe("modelos de ensino: catálogo declarativo", () => {
  it("mantém modelos e tipos distintos, sem redefinir a Ordem de serviço", () => {
    uniqueIds(templates, 64);
    uniqueIds(templates.flatMap((template) => template.work_types), 64);
    expect(escolasTemplate.work_types.map((type) => type.id)).toEqual([
      "escolas_matricula", "escolas_solicitacao",
    ]);
    expect(professoresTemplate.work_types.map((type) => type.id)).toEqual([
      "professores_aluno",
    ]);
    for (const template of templates) {
      expect(template.schema_version).toBe(1);
      expect(template.version).toBe(1);
      expect(template.work_types.length).toBeGreaterThan(0);
      expect(template.work_types.length).toBeLessThanOrEqual(20);
      expect(bytes(template)).toBeLessThanOrEqual(128 * 1024);
      // Inclui as sugestões e os textos, além da configuração dos tipos.
      expect(JSON.stringify(template).length).toBeLessThanOrEqual(150000);
      for (const type of template.work_types) {
        expect(type.kind).toBe("custom");
        expect(type.id).not.toBe("service_order");
        expect(type.schema_version).toBe(1);
        expect(type.revision).toBe(1);
        expect(type.archived).toBe(false);
        expect(type.retired_field_ids).toEqual([]);
        expect(type.retired_stage_ids).toEqual([]);
      }
    }
  });
});

for (const template of templates) {
  describe(`modelo de ensino: ${template.name}`, () => {
    it("usa estados de base válidos e transições entre etapas existentes", () => {
      for (const type of template.work_types) {
        const stages = new Map(type.stages.map((stage) => [stage.id, stage]));
        expect(type.stages.length).toBeGreaterThan(0);
        expect(type.stages.length).toBeLessThanOrEqual(32);
        expect(type.transitions.length).toBeLessThanOrEqual(128);
        uniqueIds(type.stages, 32);
        uniqueIds(type.transitions, 32);
        expect(stages.get(type.initial_stage)?.base_status).toBe("received");
        for (const stage of type.stages) {
          expect(baseStatuses).toContain(stage.base_status);
        }
        for (const transition of type.transitions) {
          expect(stages.has(transition.from)).toBe(true);
          expect(stages.has(transition.to)).toBe(true);
          expect(transition.from).not.toBe(transition.to);
          expect(transition.kind).toBe("manual");
        }
      }
    });

    it("alcança todas as etapas e permite concluir e cancelar cada etapa aberta", () => {
      for (const type of template.work_types) {
        expect([...reachable(type, type.initial_stage)].sort()).toEqual(
          type.stages.map((stage) => stage.id).sort(),
        );
        const completed = type.stages.filter((stage) => stage.base_status === "delivered");
        const cancelled = type.stages.filter((stage) => stage.base_status === "cancelled");
        expect(completed.length).toBeGreaterThan(0);
        expect(cancelled.length).toBeGreaterThan(0);
        for (const stage of type.stages) {
          if (terminalStatuses.includes(stage.base_status)) {
            expect(type.transitions.filter((edge) => edge.from === stage.id)).toEqual([]);
          } else {
            const destinations = reachable(type, stage.id);
            expect(completed.some((final) => destinations.has(final.id))).toBe(true);
            expect(cancelled.some((final) => destinations.has(final.id))).toBe(true);
          }
        }
      }
    });

    it("respeita limites de campos, textos e definições em UTF-8", () => {
      for (const value of Object.values(template.vocabulary)) textLimit(value, 80);
      for (const type of template.work_types) {
        // A compilação acrescentará o prefixo global; verificar também esse caso.
        const compiled = { ...type, id: `area_${template.id}__${type.id}` };
        textLimit(compiled.id, 64);
        expect(bytes(compiled)).toBeLessThanOrEqual(12 * 1024);
        expect(bytes({ schema_version: 1, type: compiled })).toBeLessThanOrEqual(16 * 1024);
        expect(type.fields.length).toBeLessThanOrEqual(24);
        uniqueIds(type.fields, 32);
        for (const value of Object.values(type.labels)) textLimit(value, 80);
        textLimit(type.number_prefix, 12);
        if (type.terms !== null) textLimit(type.terms, 1400);
        textLimit(type.pickup_reminder_text, 900, false);
        for (const stage of type.stages) {
          textLimit(stage.label, 80);
          textLimit(stage.message, 900, false);
        }
        for (const transition of type.transitions) textLimit(transition.label, 80);
        for (const field of type.fields) {
          expect(["__proto__", "constructor", "prototype"]).not.toContain(field.id);
          textLimit(field.label, 80);
          textLimit(field.help, 240, false);
          if (field.kind === "text") {
            expect(Number.isInteger(field.max_length)).toBe(true);
            expect(field.max_length).toBeGreaterThan(0);
            expect(field.max_length).toBeLessThanOrEqual(2000);
          } else if (field.kind === "choice") {
            expect(field.options.length).toBeGreaterThan(0);
            expect(field.options.length).toBeLessThanOrEqual(32);
            uniqueIds(field.options, 32);
            for (const option of field.options) textLimit(option.label, 80);
          } else if (field.kind === "integer") {
            expect(Number.isSafeInteger(field.min)).toBe(true);
            expect(Number.isSafeInteger(field.max)).toBe(true);
            expect(field.min).toBeGreaterThanOrEqual(1);
            expect(field.max).toBeGreaterThanOrEqual(field.min);
          } else if (field.kind === "date") {
            // Datas sem restrição no levantamento, sem inventar calendário.
            expect(field.min).toBeNull();
            expect(field.max).toBeNull();
          } else {
            throw new Error(`Tipo de campo inesperado no modelo: ${field.kind}`);
          }
        }
      }
    });

    it("protege inclusive o nome do aluno e usa apenas o número nas mensagens", () => {
      for (const type of template.work_types) {
        expect(type.fields.length).toBeGreaterThan(0);
        expect(type.labels.item).toBe("Referência administrativa (sem dados pessoais)");
        expect(type.fields.find((field) => field.id === "nome_aluno")).toMatchObject({
          label: "Nome do aluno", kind: "text",
          sensitive: true, client_visible: false, required: false,
        });
        expect(type.labels.problem).toContain("sem dados do aluno");
        for (const field of type.fields) {
          expect(field.sensitive).toBe(true);
          expect(field.client_visible).toBe(false);
          expect(field.required).toBe(false);
        }
        const messages = [
          ...type.stages.map((stage) => stage.message),
          type.pickup_reminder_text,
          type.terms ?? "",
        ];
        for (const message of messages) {
          for (const marker of message.matchAll(/\{([^{}]+)\}/g)) {
            expect(marker[1]).toBe("numero");
          }
        }
        expect(type.features).toEqual({
          customer_open: true,
          tasks: true,
          people: true,
          documents: true,
          entries: true,
          quote: null,
          warranty_days: 0,
          pickup_reminder_days: 0,
          stale_days: 0,
        });
        expect(type.pickup_reminder_text).toBe("");
        for (const stage of type.stages) {
          expect(["quoted", "approved", "declined"]).not.toContain(stage.base_status);
        }
      }
      expect(template.bot.allowed_operations).toEqual([]);
      expect(template.bot.suggested_roles).toEqual([]);
      expect(template.bot.denied_operations).toContain("os.");
      expect(JSON.stringify(template)).not.toContain("além do nome");
      expect(template.texts.instructions).toContain("Não informe nomes");
    });

    it("mantém IDs únicos por coleção e referências de menus válidas", () => {
      uniqueIds(template.work_types, 64);
      uniqueIds(template.departments, 32);
      uniqueIds(template.ticket_categories, 32);
      uniqueIds(template.menus, 32);
      expect(template.modules.os).toBe(true);
      for (const moduleId of Object.keys(template.modules)) {
        expect(moduleIds).toContain(moduleId);
      }
      for (const department of template.departments) {
        expect(department.members).toEqual([]);
        expect(department.enabled).toBe(true);
      }
      for (const menu of template.menus) {
        if (menu.type === "os_open" || menu.type === "os_track") {
          const type = template.work_types.find((candidate) => candidate.id === menu.type_id);
          expect(type).toBeDefined();
          if (menu.type === "os_open") expect(type?.features.customer_open).toBe(true);
        } else if (menu.type === "human" && menu.department_id !== null) {
          expect(template.departments.some((department) => department.id === menu.department_id)).toBe(true);
        } else if (menu.type === "message") {
          expect(menu.content.trim().length).toBeGreaterThan(0);
        }
      }
      expect(template.manual_steps.length).toBeGreaterThan(0);
    });
  });
}
