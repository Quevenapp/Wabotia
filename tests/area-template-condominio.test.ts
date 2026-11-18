import { describe, expect, it } from "vitest";
import { condominiosTemplate } from "../src/area-templates/models/condominios";
import type {
  AreaModuleId,
  AreaTemplate,
  BaseStatus,
  CustomWorkType,
} from "../src/modules/os/contracts";

// Conferência independente, apenas pelos contratos congelados nas seções 3/7.
// Não importa o catálogo, a aplicação de modelos nem a validação da tarefa M.
const template: AreaTemplate = condominiosTemplate;
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
const moduleIds: AreaModuleId[] = [
  "os", "queue", "forms", "agenda", "reserva", "pedido",
  "mensalidade", "suporte", "mesas", "entrega", "payments", "erp",
];
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const terminal = (status: BaseStatus) =>
  status === "delivered" || status === "cancelled";

function textLimit(value: string, max: number, required = true) {
  expect(value).toBe(value.trim());
  expect([...value].length).toBeLessThanOrEqual(max);
  if (required) expect(value.length).toBeGreaterThan(0);
}

function uniqueIds(items: Array<{ id: string }>, max: number) {
  const ids = items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    textLimit(id, max);
  }
}

function reachable(type: CustomWorkType, start: string) {
  const found = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const transition of type.transitions) {
      if (transition.from !== queue[i] || found.has(transition.to)) continue;
      found.add(transition.to);
      queue.push(transition.to);
    }
  }
  return found;
}

function messageLimit(type: CustomWorkType, value: string) {
  textLimit(value, 900, false);
  const markers = new Set([
    "numero", "item", "estado", "total", "validade", "garantia", "pronto",
    "previsao", "tipo", "etapa", "numero_tipo", "identificador",
    ...type.fields
      .filter((field) => field.client_visible && !field.sensitive)
      .map((field) => `campo_${field.id}`),
  ]);
  for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
    expect(markers.has(match[1]), `${type.id}: ${match[0]}`).toBe(true);
  }
  expect(value.replace(/\{[^{}]+\}/g, "")).not.toMatch(/[{}]/);
}

describe("modelo de área: condomínios", () => {
  it("exporta os quatro tipos declarativos com IDs locais e tamanho permitido", () => {
    expect(template.schema_version).toBe(1);
    expect(template.version).toBe(1);
    expect(template.id).toBe("condominios");
    expect(template.work_types.map((type) => type.id)).toEqual([
      "ocorrencia", "encomenda", "visitante", "intervencao",
    ]);
    expect(template.work_types.length).toBeLessThanOrEqual(20);
    expect(bytes(template)).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.parse(JSON.stringify(template))).toEqual(template);
    uniqueIds(template.work_types, 64);
    uniqueIds(template.departments, 32);
    uniqueIds(template.ticket_categories, 32);
    uniqueIds(template.menus, 32);
    for (const label of Object.values(template.vocabulary)) textLimit(label, 80);

    // A compilação ainda acrescentará o prefixo aos IDs globais.
    const compiledTypes = template.work_types.map((type) => ({
      ...type,
      id: `area_${template.id}__${type.id}`,
    }));
    uniqueIds(compiledTypes, 64);
    for (const type of compiledTypes) {
      expect(bytes(type), type.id).toBeLessThanOrEqual(12 * 1024);
      expect(bytes({ schema_version: 1, type })).toBeLessThanOrEqual(16 * 1024);
    }
    // Limite de string da configuração, distinto do limite de bytes do manifesto.
    expect(JSON.stringify({
      os_work_types: compiledTypes,
      os_vocabulary: template.vocabulary,
      departments: template.departments,
      ticket_categories: template.ticket_categories,
      menus: template.menus,
      ...template.texts,
      os_area_setup: [{
        template_id: template.id,
        bot: template.bot,
        manual_steps: template.manual_steps,
      }],
    }).length).toBeLessThanOrEqual(150000);
  });

  it("usa apenas módulos do contrato e menus com referências existentes", () => {
    expect(template.modules.os).toBe(true);
    for (const moduleId of Object.keys(template.modules)) {
      expect(moduleIds).toContain(moduleId);
    }
    expect(template.modules).not.toHaveProperty("condominio");
    for (const department of template.departments) {
      expect(department.members).toEqual([]);
      expect(department.enabled).toBe(true);
    }
    for (const menu of template.menus) {
      expect(["os_open", "os_track", "human", "message"]).toContain(menu.type);
      if (menu.type === "os_open" || menu.type === "os_track") {
        const type = template.work_types.find((type) => type.id === menu.type_id);
        expect(type, menu.id).toBeDefined();
        expect(type?.archived).toBe(false);
        if (menu.type === "os_open") expect(type?.features.customer_open).toBe(true);
      } else if (menu.type === "human" && menu.department_id !== null) {
        expect(template.departments.some((item) => item.id === menu.department_id)).toBe(true);
      } else if (menu.type === "message") {
        expect(menu.content.trim().length).toBeGreaterThan(0);
      }
    }
    for (const type of template.work_types) {
      expect(template.menus.some((menu) =>
        menu.type === "os_track" && menu.type_id === type.id,
      )).toBe(true);
    }
  });

  it("mantém retirada exclusiva de encomendas e não sugere permissões automáticas", () => {
    const parcel = template.work_types.find((type) => type.id === "encomenda")!;
    expect(parcel.features.customer_open).toBe(false);
    expect(parcel.terms).toBeNull();
    expect(parcel.features.pickup_reminder_days).toBe(3);
    expect(parcel.pickup_reminder_text).toContain("{identificador}");
    expect(template.work_types.filter((type) =>
      type.features.pickup_reminder_days > 0,
    ).map((type) => type.id)).toEqual(["encomenda"]);
    expect(template.bot.allowed_operations).toEqual([]);
    expect(template.bot.suggested_roles).toEqual([]);
    expect(template.bot.denied_operations).toContain("os.");
    expect(template.manual_steps.length).toBeGreaterThan(0);
    expect(template.texts.menu_greeting).toContain("Informe bloco e número no campo Unidade");
    expect(template.bot.instructions).toContain("Pode pedir bloco e número e citar a unidade do próprio morador");
    expect(template.bot.instructions).toContain("Não peça nem reproduza nomes de visitantes, placas, documentos pessoais");
    expect(template.manual_steps.join(" ")).toContain("A unidade é opcional e visível ao próprio morador");
  });

  for (const type of template.work_types) {
    describe(type.labels.singular, () => {
      it("respeita revisões, IDs e limites de definição", () => {
        expect(type.schema_version).toBe(1);
        expect(type.kind).toBe("custom");
        expect(type.revision).toBe(1);
        expect(type.archived).toBe(false);
        expect(type.id).not.toBe("service_order");
        expect(type.retired_field_ids).toEqual([]);
        expect(type.retired_stage_ids).toEqual([]);
        uniqueIds(type.fields, 32);
        uniqueIds(type.stages, 32);
        uniqueIds(type.transitions, 32);
        expect(type.fields.length).toBeLessThanOrEqual(24);
        expect(type.stages.length).toBeLessThanOrEqual(32);
        expect(type.transitions.length).toBeLessThanOrEqual(128);
        expect(bytes(type)).toBeLessThanOrEqual(12 * 1024);
        for (const label of Object.values(type.labels)) textLimit(label, 80);
        textLimit(type.number_prefix, 12);
        if (type.terms !== null) textLimit(type.terms, 1400);
      });

      it("libera a unidade ao morador e preserva os demais dados sensíveis privados", () => {
        expect(type.fields.find((field) => field.id === "unidade")).toMatchObject({
          kind: "text",
          label: "Unidade (bloco e número)",
          required: false,
          client_visible: true,
          sensitive: false,
        });
        for (const field of type.fields) {
          expect(["__proto__", "constructor", "prototype"]).not.toContain(field.id);
          textLimit(field.label, 80);
          textLimit(field.help, 240, false);
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
          } else if (field.kind === "choice") {
            expect(field.options.length).toBeGreaterThan(0);
            expect(field.options.length).toBeLessThanOrEqual(32);
            uniqueIds(field.options, 32);
            for (const option of field.options) textLimit(option.label, 80);
          } else if (field.kind === "integer") {
            expect(Number.isSafeInteger(field.min)).toBe(true);
            expect(Number.isSafeInteger(field.max)).toBe(true);
            expect(field.min).toBeLessThanOrEqual(field.max);
          } else if (field.kind === "date") {
            // O modelo deixa as datas livres para conferência humana do período.
            expect(field.min).toBeNull();
            expect(field.max).toBeNull();
          } else {
            expect(field.kind).toBe("boolean");
          }
        }
      });

      it("mapeia etapas válidas e transições para etapas existentes", () => {
        const stageIds = new Set(type.stages.map((stage) => stage.id));
        const initial = type.stages.find((stage) => stage.id === type.initial_stage);
        expect(initial?.base_status).toBe("received");
        expect(type.features.quote).toBeNull();
        for (const stage of type.stages) {
          expect(statuses).toContain(stage.base_status);
          // Aprovação administrativa não reutiliza os estados de orçamento.
          expect(["quoted", "approved", "declined"]).not.toContain(stage.base_status);
          textLimit(stage.label, 80);
          messageLimit(type, stage.message);
          if (terminal(stage.base_status)) {
            expect(type.transitions.filter((transition) =>
              transition.from === stage.id,
            )).toEqual([]);
          }
        }
        for (const transition of type.transitions) {
          expect(stageIds.has(transition.from), transition.id).toBe(true);
          expect(stageIds.has(transition.to), transition.id).toBe(true);
          expect(transition.from).not.toBe(transition.to);
          textLimit(transition.label, 80);
          if (transition.kind === "customer_approval") {
            expect(Number.isInteger(transition.valid_hours)).toBe(true);
            expect(transition.valid_hours).toBeGreaterThanOrEqual(1);
            expect(transition.valid_hours).toBeLessThanOrEqual(720);
            expect(transition.request_text.length).toBeGreaterThan(0);
            messageLimit(type, transition.request_text);
          } else {
            expect(transition.kind).toBe("manual");
          }
        }
      });

      it("alcança todas as etapas e permite conclusão e cancelamento de cada aberta", () => {
        expect(reachable(type, type.initial_stage)).toEqual(
          new Set(type.stages.map((stage) => stage.id)),
        );
        for (const status of ["delivered", "cancelled"] as const) {
          const finals = type.stages.filter((stage) => stage.base_status === status);
          expect(finals.length).toBeGreaterThan(0);
          for (const stage of type.stages.filter((stage) => !terminal(stage.base_status))) {
            const destinations = reachable(type, stage.id);
            expect(finals.some((final) => destinations.has(final.id)),
              `${type.id}/${stage.id}: caminho para ${status}`,
            ).toBe(true);
          }
        }
      });

      it("respeita limites de recursos e marcadores das mensagens", () => {
        expect(type.features.warranty_days).toBeGreaterThanOrEqual(0);
        expect(type.features.warranty_days).toBeLessThanOrEqual(3650);
        expect(type.features.pickup_reminder_days).toBeGreaterThanOrEqual(0);
        expect(type.features.pickup_reminder_days).toBeLessThanOrEqual(365);
        expect(type.features.stale_days).toBeGreaterThanOrEqual(0);
        expect(type.features.stale_days).toBeLessThanOrEqual(365);
        if (type.features.pickup_reminder_days > 0) {
          expect(type.stages.some((stage) => stage.base_status === "ready")).toBe(true);
        } else {
          expect(type.pickup_reminder_text).toBe("");
        }
        messageLimit(type, type.pickup_reminder_text);
      });
    });
  }
});
