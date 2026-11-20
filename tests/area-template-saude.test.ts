import { describe, expect, it } from "vitest";
import { clinicaMedicaTemplate } from "../src/area-templates/models/clinica-medica";
import { clinicaVeterinariaTemplate } from "../src/area-templates/models/clinica-veterinaria";
import type {
  AreaTemplate,
  BaseStatus,
  CustomWorkType,
} from "../src/modules/os/contracts";

// Não importa o aplicador ou a validação de A/M: estes testes fixam o contrato.
const templates: AreaTemplate[] = [
  clinicaMedicaTemplate,
  clinicaVeterinariaTemplate,
];
const baseStatuses: BaseStatus[] = [
  "received", "analyzing", "quoted", "approved", "declined",
  "in_progress", "ready", "delivered", "cancelled",
];
const terminalStatuses: BaseStatus[] = ["delivered", "cancelled"];
const quoteStatuses: BaseStatus[] = ["quoted", "approved", "declined"];
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const normalize = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function textLimit(value: string, max: number, empty = false) {
  expect(value).toBe(value.trim());
  expect([...value].length).toBeGreaterThanOrEqual(empty ? 0 : 1);
  expect([...value].length).toBeLessThanOrEqual(max);
}

function ids(values: string[], max = 32) {
  expect(new Set(values).size).toBe(values.length);
  for (const value of values) {
    expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    textLimit(value, max);
    expect(["__proto__", "constructor", "prototype"]).not.toContain(value);
  }
}

function graph(type: CustomWorkType) {
  const edges = type.transitions.map(({ from, to }) => ({ from, to }));
  const quote = type.features.quote;
  // Envio, decisão e edição são arestas das operações de orçamento, não manuais.
  if (quote) {
    for (const from of quote.source_stages) edges.push({ from, to: quote.sent_stage });
    for (const to of [quote.approved_stage, quote.declined_stage, quote.edited_stage]) {
      edges.push({ from: quote.sent_stage, to });
    }
  }
  return edges;
}

function reachable(type: CustomWorkType, from: string) {
  const edges = graph(type);
  const found = new Set<string>([from]);
  const pending = [from];
  while (pending.length) {
    const current = pending.pop();
    for (const edge of edges) {
      if (edge.from === current && !found.has(edge.to)) {
        found.add(edge.to);
        pending.push(edge.to);
      }
    }
  }
  return found;
}

// Lista positiva administrativa: um campo clínico novo, mesmo renomeado,
// exige revisão explícita. As opções também não podem virar narrativa clínica.
const administrativeFields: Record<string, Record<string, string[] | "text">> = {
  "clinica_medica/atendimento": {
    modalidade: ["consulta", "retorno", "procedimento"],
    pagamento_tipo: ["particular", "convenio"],
    convenio_nome: "text",
    autorizacao_convenio: ["nao_se_aplica", "pendente", "confirmada", "negada"],
    contato_administrativo: ["paciente", "responsavel_verificado"],
  },
  "clinica_veterinaria/atendimento": {
    modalidade: ["consulta", "retorno", "procedimento", "preventivo"],
    origem: ["agendado", "encaixe", "encaminhamento"],
    pagador: ["tutor_principal", "outro_autorizado"],
  },
  "clinica_veterinaria/internacao": {
    acomodacao_codigo: "text",
    contato_prioritario: ["tutor_principal", "tutor_adicional"],
    janela_contato: ["manha", "tarde", "noite", "combinado"],
  },
  "clinica_veterinaria/banho_tosa": {
    servico: ["banho", "banho_e_tosa", "tosa_higienica"],
    porte: ["pequeno", "medio", "grande", "gigante"],
    preferencia_estetica: "text",
  },
};
const clinicalField = /queixa|sintoma|diagnost|prescri|receita|exame|resultado|anamnese|evolucao|prognost|medic|alerg|peso|sinais_vitais|vacina|vermif|historico_clinico/;

describe("modelos de saúde: contrato declarativo", () => {
  it("mantém modelos e tipos identificáveis sem copiar a Ordem de serviço", () => {
    ids(templates.map((template) => template.id), 64);
    expect(templates.map((template) => template.id)).toEqual([
      "clinica_medica", "clinica_veterinaria",
    ]);
    expect(templates.flatMap((template) =>
      template.work_types.map((type) => `${template.id}/${type.id}`),
    ).sort()).toEqual(Object.keys(administrativeFields).sort());
  });

  for (const template of templates) {
    describe(template.name, () => {
      it("respeita limites de manifesto, referências e IDs em cada escopo", () => {
        expect(template.schema_version).toBe(1);
        // A veterinária foi publicada de novo na parte 2 (objeto Animal).
        expect(template.version).toBe(template.id === "clinica_veterinaria" ? 2 : 1);
        expect(jsonBytes(template)).toBeLessThanOrEqual(128 * 1024);
        expect(template.work_types.length).toBeLessThanOrEqual(20);
        expect(JSON.stringify(template).length).toBeLessThanOrEqual(150_000);
        expect(JSON.parse(JSON.stringify(template))).toEqual(template);
        ids(template.work_types.map((type) => type.id), 64);
        ids(template.menus.map((menu) => menu.id));
        ids(template.departments.map((department) => department.id));
        ids(template.ticket_categories.map((category) => category.id));
        for (const label of Object.values(template.vocabulary)) textLimit(label, 80);
        for (const type of template.work_types) {
          textLimit(`area_${template.id}__${type.id}`, 64);
        }
        for (const department of template.departments) {
          expect(department.members).toEqual([]);
          expect(department.enabled).toBe(true);
        }
        for (const menu of template.menus) {
          expect(["os_open", "os_track", "human", "message"]).toContain(menu.type);
          if (menu.type === "os_open" || menu.type === "os_track") {
            const type = template.work_types.find((type) => type.id === menu.type_id);
            expect(type).toBeDefined();
            if (menu.type === "os_open") {
              expect(type?.archived).toBe(false);
              expect(type?.features.customer_open).toBe(true);
            }
          } else if (menu.type === "human" && menu.department_id !== null) {
            expect(template.departments.map(({ id }) => id)).toContain(menu.department_id);
          } else if (menu.type === "message") {
            expect(menu.content.trim()).not.toBe("");
          }
        }
      });

      it("proíbe orientação clínica e deixa explícito que o bloqueio de IA é manual", () => {
        expect(template.bot.instructions).toContain("Não forneça orientação clínica");
        expect(template.bot.instructions).toContain("Não registre dados clínicos");
        expect(template.bot.allowed_operations).toEqual([]);
        expect(template.bot.suggested_roles).toEqual([]);
        expect(template.bot.denied_operations).toContain("os.private");
        if (template.id === "clinica_veterinaria") {
          // Parte 2 (regra do dono): IA desligada por padrão e delimitada pela
          // configuração do administrador; o manifesto não ativa IA nem concede papéis.
          expect(template.bot.instructions).toContain("A IA começa desligada");
          expect(template.manual_steps.some((step) => step.includes("o manifesto não ativa IA nem concede papéis"))).toBe(true);
        } else {
          expect(template.bot.instructions).toContain("IA generativa desligada");
          expect(template.manual_steps.some((step) =>
            step.includes("não configura nem garante esse bloqueio técnico"),
          )).toBe(true);
        }
        expect(template.manual_steps.some((step) => step.includes("os:sensitive"))).toBe(true);
      });

      for (const type of template.work_types) {
        describe(type.labels.singular, () => {
          it("respeita os limites da seção 3", () => {
            expect(type.schema_version).toBe(1);
            expect(type.kind).toBe("custom");
            expect(type.id).not.toBe("service_order");
            expect(type.revision).toBe(1);
            expect(jsonBytes(type)).toBeLessThanOrEqual(12 * 1024);
            expect(jsonBytes({ schema_version: 1, type })).toBeLessThanOrEqual(16 * 1024);
            expect(type.fields.length).toBeLessThanOrEqual(24);
            expect(type.stages.length).toBeLessThanOrEqual(32);
            expect(type.transitions.length).toBeLessThanOrEqual(128);
            ids(type.fields.map(({ id }) => id));
            ids(type.stages.map(({ id }) => id));
            ids(type.transitions.map(({ id }) => id));
            expect(type.retired_field_ids).toEqual([]);
            expect(type.retired_stage_ids).toEqual([]);
            for (const label of Object.values(type.labels)) textLimit(label, 80);
            textLimit(type.number_prefix, 12);
            textLimit(type.terms ?? "", 1400);
            textLimit(type.pickup_reminder_text, 900, true);
            for (const stage of type.stages) {
              textLimit(stage.label, 80);
              textLimit(stage.message, 900, true);
            }
            for (const transition of type.transitions) textLimit(transition.label, 80);
            expect(type.features.warranty_days).toBe(0);
            expect(type.features.stale_days).toBe(0);
            expect(type.features.pickup_reminder_days).toBeGreaterThanOrEqual(0);
            expect(type.features.pickup_reminder_days).toBeLessThanOrEqual(365);
            if (type.features.pickup_reminder_days) {
              expect(type.stages.some((stage) => stage.base_status === "ready")).toBe(true);
            }
          });

          it("tem estados válidos, referências existentes e caminhos de conclusão e cancelamento", () => {
            const stageIds = type.stages.map(({ id }) => id);
            expect(type.stages.find(({ id }) => id === type.initial_stage)?.base_status).toBe("received");
            expect(type.stages.some((stage) => stage.base_status === "delivered")).toBe(true);
            expect(type.stages.some((stage) => stage.base_status === "cancelled")).toBe(true);
            for (const edge of graph(type)) {
              expect(stageIds).toContain(edge.from);
              expect(stageIds).toContain(edge.to);
              expect(edge.from).not.toBe(edge.to);
            }
            expect([...reachable(type, type.initial_stage)].sort()).toEqual([...stageIds].sort());
            for (const stage of type.stages) {
              expect(baseStatuses).toContain(stage.base_status);
              if (terminalStatuses.includes(stage.base_status)) {
                expect(graph(type).filter((edge) => edge.from === stage.id)).toEqual([]);
              } else {
                const destinations = type.stages.filter((candidate) => reachable(type, stage.id).has(candidate.id));
                expect(destinations.some((candidate) => candidate.base_status === "delivered")).toBe(true);
                expect(destinations.some((candidate) => candidate.base_status === "cancelled")).toBe(true);
              }
            }
          });

          it("reserva estados e operações protegidas para a política de orçamento", () => {
            const quote = type.features.quote;
            if (!quote) {
              expect(type.stages.some((stage) => quoteStatuses.includes(stage.base_status))).toBe(false);
              return;
            }
            const status = (id: string) => type.stages.find((stage) => stage.id === id)?.base_status;
            expect(status(quote.sent_stage)).toBe("quoted");
            expect(status(quote.approved_stage)).toBe("approved");
            expect(status(quote.declined_stage)).toBe("declined");
            expect(status(quote.edited_stage)).toBe("analyzing");
            expect(quote.default_valid_days).toBe(7);
            ids(quote.source_stages);
            expect(quote.source_stages.length).toBeGreaterThan(0);
            for (const source of quote.source_stages) {
              expect(["received", "analyzing", "quoted", "declined"]).toContain(status(source));
            }
            for (const transition of type.transitions) {
              expect(transition.kind).toBe("manual");
              expect([quote.sent_stage, quote.approved_stage, quote.declined_stage]).not.toContain(transition.to);
              if (transition.from === quote.sent_stage) expect(status(transition.to)).toBe("cancelled");
            }
            for (const stage of type.stages.filter((stage) => quoteStatuses.includes(stage.base_status))) {
              expect(stage.message).toBe("");
            }
          });

          it("contém somente campos administrativos e protege os relacionados à saúde", () => {
            const expected = administrativeFields[`${template.id}/${type.id}`];
            expect(type.fields.map(({ id }) => id).sort()).toEqual(Object.keys(expected).sort());
            for (const label of [type.labels.item, type.labels.problem]) {
              expect(normalize(label)).not.toMatch(clinicalField);
            }
            for (const field of type.fields) {
              expect(normalize(`${field.id} ${field.label}`)).not.toMatch(clinicalField);
              textLimit(field.label, 80);
              textLimit(field.help, 240);
              if (expected[field.id] === "text") {
                expect(field.kind).toBe("text");
                expect(field.help).toMatch(/Não|não/);
              } else {
                expect(field.kind).toBe("choice");
                if (field.kind === "choice") {
                  expect(field.options.map(({ id }) => id)).toEqual(expected[field.id]);
                  expect(field.options.length).toBeLessThanOrEqual(32);
                  ids(field.options.map(({ id }) => id));
                  for (const option of field.options) {
                    textLimit(option.label, 80);
                    expect(normalize(`${option.id} ${option.label}`)).not.toMatch(clinicalField);
                  }
                }
              }
              if (field.kind === "text") {
                expect(field.max_length).toBeGreaterThan(0);
                expect(field.max_length).toBeLessThanOrEqual(2000);
              }
              if (type.id !== "banho_tosa") expect(field.sensitive).toBe(true);
              if (field.sensitive) {
                expect(field.client_visible).toBe(false);
                expect(field.required).toBe(false);
              }
              if (type.features.customer_open && field.required) {
                expect(field.client_visible).toBe(true);
                expect(field.sensitive).toBe(false);
              }
            }
          });

          it("usa apenas marcadores públicos nas mensagens", () => {
            const allowed = ["numero", "item", "estado", "total", "validade", "garantia", "pronto", "previsao", "tipo", "etapa", "numero_tipo", "identificador"];
            for (const message of [...type.stages.map(({ message }) => message), type.pickup_reminder_text]) {
              for (const match of message.matchAll(/\{([^{}]+)\}/g)) expect(allowed).toContain(match[1]);
            }
          });
        });
      }
    });
  }

  it("mantém opcionais arquivados e não automatiza retirada de internação", () => {
    const medical = clinicaMedicaTemplate.work_types[0];
    expect(medical.stages.find(({ id }) => id === "confirmado")?.base_status).toBe("analyzing");
    const hospital = clinicaVeterinariaTemplate.work_types.find(({ id }) => id === "internacao")!;
    const grooming = clinicaVeterinariaTemplate.work_types.find(({ id }) => id === "banho_tosa")!;
    expect(hospital.archived).toBe(true);
    expect(hospital.features.customer_open).toBe(false);
    expect(hospital.features.pickup_reminder_days).toBe(0);
    expect(hospital.pickup_reminder_text).toBe("");
    expect(grooming.archived).toBe(true);
    expect(grooming.features.pickup_reminder_days).toBe(1);
  });
});
