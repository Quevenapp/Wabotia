import React from "react";
import type { Api } from "../web/lib/api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkApi,
  pendingImplementation,
  workError,
  queryString,
} from "../web/modules/os/work-api";
import {
  commonExtra,
  parseExtra,
  ExtraFields,
  fieldValue,
} from "../web/modules/os/components/ExtraFields";
import { parseAreaTemplate } from "../web/admin/area-templates/template-import";
import { StagePill } from "../web/modules/os/components/StagePill";
import {
  newWorkType,
  newField,
  prepareTypeSave,
  validateTypeDraft,
  parseTypeImport,
} from "../web/modules/os/types/type-draft";
import { hasWorkMenu } from "../web/menu-tree";
import { href, pageRoute, parseRoute, sameRoute } from "../web/lib/routes";
import { canOpenPage } from "../web/workspace-navigation";
import { workCollectionLabel } from "../web/modules/os/work-vocabulary";
import { quantityMilli } from "../web/modules/os/entries/WorkEntriesTab";
import type { WorkField, WorkTypeView } from "../web/modules/os/work-contracts";

const type = () => ({
  ...newWorkType(),
  id: "projeto",
  labels: {
    ...newWorkType().labels,
    singular: "Projeto",
    plural: "Projetos",
    item: "Obra",
    problem: "Escopo",
    customer_singular: "Contratante",
    customer_plural: "Contratantes",
  },
});

describe("painel de trabalhos: contrato e compatibilidade", () => {
  it("conserva os nomes embutidos e resolve o vocabulário por tipo", () => {
    const builtin = {
      ...type(),
      kind: "builtin",
      id: "service_order",
      revision: 1,
    } as WorkTypeView;
    expect(workCollectionLabel([builtin])).toBe("Ordens de serviço");
    expect(workCollectionLabel([builtin], undefined, true)).toBe("Ordens");
    expect(workCollectionLabel([type()])).toBe("Projetos");
    expect(
      workCollectionLabel([builtin, type()], {
        collection_label: "Atividades",
      }),
    ).toBe("Atividades");
  });

  it("não confunde menus de tipos distintos nem perde o menu antigo", () => {
    const items = [
      { type: "os_open" },
      { type: "os_track", type_id: "projeto" },
    ];
    expect(hasWorkMenu(items, "os_open", "service_order")).toBe(true);
    expect(hasWorkMenu(items, "os_open", "projeto")).toBe(false);
    expect(hasWorkMenu(items, "os_track", "projeto")).toBe(true);
    expect(hasWorkMenu(items, "os_track", "service_order")).toBe(false);
  });

  it("endereça tipo, trabalho, aba e filtros sem quebrar o endereço antigo", () => {
    expect(parseRoute("/app/gestao/ordens-de-servico")).toMatchObject({
      area: "erp",
      page: "work",
    });
    const route = parseRoute(
      "/app/gestao/trabalhos/projeto/order%2F1",
      "?aba=tarefas&stage=vistoria&q=abc&open=0",
    );
    expect(route).toMatchObject({
      area: "erp",
      page: "work",
      typeId: "projeto",
      id: "order/1",
      tab: "tarefas",
      filters: { stage: "vistoria", q: "abc", open: "0" },
    });
    expect(href(route)).toBe("/app/erp/modulos/trabalhos/projeto/order%2F1?aba=tarefas&stage=vistoria&q=abc&open=0");
    expect(pageRoute("service-orders")).toEqual({ area: "erp", page: "work" });
    expect(sameRoute(route, { ...route, tab: "pessoas" })).toBe(false);
    expect(sameRoute(route, { ...route, typeId: "obra" })).toBe(false);
    expect(
      sameRoute(route, {
        ...route,
        filters: { open: "0", q: "abc", stage: "vistoria" },
      }),
    ).toBe(true);
    expect(parseRoute("/app/gestao/tipos-de-trabalho/projeto").typeId).toBe(
      "projeto",
    );
  });

  it("modelos funcionam com OS desligado; editor e modelos são administrativos", () => {
    expect(canOpenPage("area-templates", "admin", { os: false })).toBe(true);
    expect(canOpenPage("area-templates", "agent", { os: true })).toBe(false);
    expect(canOpenPage("work-types", "agent", { os: true })).toBe(false);
    expect(canOpenPage("work", "admin", { os: false })).toBe(false);
    expect(canOpenPage("my-deadlines", "agent", { os: true }, ["os"])).toBe(
      true,
    );
  });

  it("renderiza etapas diferentes que têm o mesmo estado de base", () => {
    const a = renderToStaticMarkup(
      React.createElement(StagePill, {
        status: "in_progress",
        label: "Vistoria",
      }),
    );
    const b = renderToStaticMarkup(
      React.createElement(StagePill, {
        status: "in_progress",
        label: "Projeto executivo",
      }),
    );
    expect(a).toContain("Vistoria");
    expect(b).toContain("Projeto executivo");
    expect(a).not.toBe(b);
  });

  it("renderiza campos dinâmicos, zero e falso, sem colocar dados privados no DOM", () => {
    const fields: WorkField[] = [
      { ...newField("text"), id: "referencia", label: "Referência" },
      { ...newField("boolean"), id: "aceito", label: "Confirmado" },
      { ...newField("integer"), id: "horas", label: "Horas" },
      {
        ...newField("text"),
        id: "privado",
        label: "SEGREDO_LABEL",
        sensitive: true,
      },
    ];
    const values = {
      referencia: "REF-5",
      aceito: false,
      horas: 0,
      privado: "SENTINELA_PRIVADA",
    };
    const html = renderToStaticMarkup(
      React.createElement(ExtraFields, { fields, values, readOnly: true }),
    );
    expect(html).toContain("REF-5");
    expect(html).toContain("Não");
    expect(html).toContain(">0<");
    expect(html).not.toContain("SENTINELA_PRIVADA");
    expect(html).not.toContain("SEGREDO_LABEL");
    const form = renderToStaticMarkup(
      React.createElement(ExtraFields, { fields, values, onChange: () => {} }),
    );
    expect(form).not.toContain("SENTINELA_PRIVADA");
    expect(form).not.toContain("SEGREDO_LABEL");
    expect(commonExtra(fields, values)).toEqual({
      referencia: "REF-5",
      aceito: false,
      horas: 0,
    });
    expect(fieldValue(fields[1], "false")).toBe(false);
    expect(fieldValue(fields[2], "0")).toBe(0);
  });

  it("envia transição e versão, nunca infere a etapa a partir do estado", async () => {
    const request = vi.fn(async (..._args: Parameters<Api>) => ({}));
    const api = createWorkApi(request, "v1/profiles/a");
    await api.stage("id/a", {
      transition_id: "vistoria_para_projeto",
      version: 9,
    });
    expect(request.mock.calls[0]).toEqual([
      "v1/profiles/a/service-orders/id%2Fa/stage",
      "POST",
      { transition_id: "vistoria_para_projeto", version: 9 },
      undefined,
      expect.any(String),
    ]);
    await api.stage("id/a", { transition_id: "aprovar", version: 9 }, true);
    expect(request.mock.calls[1][0]).toBe(
      "v1/profiles/a/service-orders/id%2Fa/stage-approval",
    );
  });

  it("consulta somente a coleção pedida, com cursor opaco e histórico separado", async () => {
    const request = vi.fn(async (..._args: Parameters<Api>) => ({
      data: [],
      next_cursor: null,
    }));
    const api = createWorkApi(request, "v1/profiles/a");
    await api.order("one");
    expect(request.mock.calls).toHaveLength(1);
    expect(request.mock.calls[0][0]).toBe(
      "v1/profiles/a/service-orders/one?history=none",
    );
    await api.tasks("one", { cursor: "a+/=b", limit: 50 });
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1][0]).toContain(
      "/one/tasks?cursor=a%2B%2F%3Db&limit=50",
    );
    await api.history("one", { cursor: "next", limit: 50 });
    expect(request.mock.calls[2][0]).toContain("/one/history?cursor=next");
  });

  it("reutiliza idempotência depois de falha de transporte e mantém versão em conflito", async () => {
    let fail = true;
    const request = vi.fn(async (..._args: Parameters<Api>) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("offline"), { status: 0 });
      }
      return { id: "one" };
    });
    const api = createWorkApi(request, "v1/profiles/a");
    const body = { item: "Rascunho", version: 3 };
    await expect(api.update("one", body)).rejects.toThrow("offline");
    await api.update("one", body);
    expect(request.mock.calls[0][4]).toBe(request.mock.calls[1][4]);
    expect(body).toEqual({ item: "Rascunho", version: 3 });
    expect(workError({ code: "version_conflict" })).toContain(
      "rascunho foi preservado",
    );
    expect(pendingImplementation({ status: 404 })).toBe(true);
    expect(pendingImplementation({ code: "not_implemented" })).toBe(true);
    expect(pendingImplementation({ status: 403 })).toBe(false);
  });

  it("retifica com versão, envia documentos sem telefone e aplica o hash da prévia", async () => {
    const request = vi.fn(async (..._args: Parameters<Api>) => ({}));
    const api = createWorkApi(request, "v1/profiles/a");
    await api.reviseEntry("one", "entry", {
      version: 4,
      kind: "horas",
      text: "Correção",
      quantity_milli: 1250,
      occurred_at: 123,
      sensitive: false,
      client_visible: false,
    });
    expect(request.mock.calls[0][0]).toContain("/entries/entry/revisions");
    await api.sendDocument("one", "document", 5);
    expect(request.mock.calls[1][2]).toEqual({ version: 5 });
    await api.apply({
      template_id: "servicos",
      preview_hash: "hash-fixado",
      selection: {
        work_type_ids: [],
        module_ids: [],
        menus: true,
        departments: true,
        ticket_categories: true,
        vocabulary: true,
        texts: true,
        bot_suggestions: false,
      },
    });
    expect(request.mock.calls[2][0]).toBe("v1/profiles/a/area-templates/apply");
    expect(request.mock.calls[2][2]).toMatchObject({
      preview_hash: "hash-fixado",
    });
    expect(
      queryString({ stage: "", cursor: "a b", include_archived: false }),
    ).toBe("?cursor=a+b&include_archived=0");
  });

  it("aposenta IDs removidos, incrementa revisão e impede redução de sigilo", () => {
    const original = {
      ...type(),
      fields: [
        { ...newField(), id: "privado", label: "Privado", sensitive: true },
      ],
    };
    const removed = prepareTypeSave({ ...original, fields: [] }, original);
    expect(removed.retired_field_ids).toEqual(["privado"]);
    expect(removed.revision).toBe(2);
    expect(prepareTypeSave(original, original).revision).toBe(1);
    expect(
      validateTypeDraft(
        { ...original, fields: [{ ...original.fields[0], sensitive: false }] },
        original,
      ).join(),
    ).toContain("permanente");
    expect(validateTypeDraft(type())).toEqual([]);
    expect(parseTypeImport(JSON.stringify(type()))).toEqual(type());
    expect(() => parseTypeImport('{"kind":"builtin"}')).toThrow("Formato");
  });

  it("converte quantidade sem arredondar silenciosamente", () => {
    expect(quantityMilli("0")).toBe(0);
    expect(quantityMilli("1,025")).toBe(1025);
    expect(() => quantityMilli("1.0009")).toThrow();
    expect(() => quantityMilli("-1")).toThrow();
  });
  it("valida decimais e datas sem perder zero nem falso", () => {
    const fields: WorkField[] = [
      { ...newField("decimal"), id: "medida", label: "Medida", required: true },
      {
        ...newField("boolean"),
        id: "confirmado",
        label: "Confirmado",
        required: true,
      },
      { ...newField("date"), id: "dia", label: "Dia" },
    ];
    expect(
      parseExtra(fields, {
        medida: "0,00",
        confirmado: false,
        dia: "2024-02-29",
      }),
    ).toEqual({ medida: 0, confirmado: false, dia: "2024-02-29" });
    expect(() =>
      parseExtra(fields, { medida: "1,234", confirmado: false }),
    ).toThrow("casas decimais");
    expect(() =>
      parseExtra(fields, { medida: "1", confirmado: false, dia: "2025-02-29" }),
    ).toThrow("data inválida");
    expect(() => parseExtra(fields, { medida: "", confirmado: false })).toThrow(
      "obrigatório",
    );
  });

  it("recusa importações malformadas antes de renderizar", () => {
    expect(() =>
      parseTypeImport(
        JSON.stringify({
          ...type(),
          fields: [{ kind: "choice", id: "x", label: {}, options: null }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseAreaTemplate(
        JSON.stringify({ schema_version: 1, work_types: [null] }),
      ),
    ).toThrow("Manifesto inválido");
    const privateType = {
      ...type(),
      fields: [
        { ...newField(), id: "segredo", label: "Sigilo", sensitive: true },
      ],
      pickup_reminder_text: "{campo_segredo}",
    };
    expect(validateTypeDraft(privateType).join()).toContain(
      "marcador não permitido",
    );
  });
});
