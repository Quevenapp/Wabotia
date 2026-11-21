// Permissões por módulo (src/security-modules.ts): nível rápido e ações por
// módulo, o papel do motor derivado dos níveis, a migração dos papéis antigos
// do ERP, o portão de cada ação no servidor e o bot limitado à pessoa.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { ApiError, type Actor } from "../src/types";
import { sha } from "../src/security";
import { accessCatalog, allows, effectiveAccess, requireAreaModuleAction, validateAccess } from "../src/access";
import { requireErpAction } from "../src/modules/erp/identity";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotOperationAction } from "../src/modules/erp/bot-access";
import { ERP_MODULE_IDS } from "../src/erp/parts";
import {
  ERP_MODULE_ACTIONS,
  erpEngineRoleFor,
  erpRouteAction,
  erpRouteAllowed,
  legacyErpItems,
  migrateErpAccess,
  type ErpEngineRole,
} from "../src/security-modules";
import { moduleLevel, setModuleLevel, toggleModuleAction } from "../web/admin/module-permissions";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts } from "./erp-module-helper";

const ERP = [...ERP_MODULE_IDS] as string[];
const person = (access: string[] | null, extra: Partial<Actor> = {}) =>
  ({ kind: "user", role: "operator", id: "u1", access, ...extra }) as Actor;
/** Pessoa só com "Financeiro: só ver", como a tela grava e o servidor normaliza. */
const financeReader = () => validateAccess(setModuleLevel(["conversations"], "erp-financeiro", "ver", ERP))!;
const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error as ApiError;
  }
  return null;
};

describe("modelo de permissões por módulo", () => {
  it("cada módulo do ERP tem ações com nome e descrição, e o catálogo de acesso as leva", () => {
    for (const id of ERP_MODULE_IDS) {
      const actions = ERP_MODULE_ACTIONS[id];
      expect(actions.length, id).toBeGreaterThan(1);
      expect(actions[0].level, id).toBe("ver");
      for (const action of actions) {
        expect(action.label.length).toBeGreaterThan(2);
        expect(action.description.length).toBeGreaterThan(5);
      }
    }
    const catalog = accessCatalog({ erp: true, "erp-financeiro": true, os: true });
    expect(catalog.find((i) => i.id === "erp-financeiro")?.actions?.map((a) => a.id)).toEqual(
      expect.arrayContaining(["ver_contas", "ver_lucro", "lancar", "baixar", "apagar", "conciliar", "cobrar"]),
    );
    expect(catalog.find((i) => i.id === "os")?.actions?.map((a) => a.id)).toEqual(["ver", "operar", "apagar"]);
    // Os papéis "ERP: consulta / financeiro / ..." continuam aceitos, mas saem da tela.
    expect(catalog.filter((i) => i.module_id === "erp" && i.role).every((i) => i.legacy)).toBe(true);
    expect(catalog.find((i) => i.id === "os:technician")?.legacy).toBeUndefined();
  });

  it("o servidor deriva o papel do motor dos níveis e descarta o papel enviado", () => {
    expect(financeReader()).toContain("erp:consulta");
    expect(validateAccess(["erp-financeiro@operar", "erp:admin"])).toEqual(["erp-financeiro@operar", "erp:financeiro"]);
    // Vendas e Financeiro operando juntos: nenhum papel único cobre; o motor
    // recebe administrador e o Worker confere ação por ação.
    expect(erpEngineRoleFor(["erp-vendas@operar", "erp-financeiro@operar"])).toBe("admin");
    expect(erpEngineRoleFor(["erp-financeiro@administrar"])).toBe("admin");
    expect(erpEngineRoleFor(["erp-financeiro@nenhum"])).toBeNull();
    expect(validateAccess(["erp-financeiro@nenhum", "erp:vendas"])).toEqual(["erp-financeiro@nenhum"]);
    expect(() => validateAccess(["erp-financeiro@ver", "erp-financeiro@operar"])).toThrow(/um só nível/);
    expect(() => validateAccess(["erp-financeiro+voar"])).toThrow(/desconhecido/);
    expect(() => validateAccess(["modulo-que-nao-existe@ver"])).toThrow(/desconhecido/);
  });
});

describe("Financeiro: só ver", () => {
  it("lê contas e DRE; é recusado ao baixar, lançar e apagar, com a ação que falta e quem libera", () => {
    const list = financeReader();
    for (const [method, route] of [
      ["GET", "erp/v1/financeiro/titles"],
      ["GET", "erp/v1/financeiro/titles/abc/detalhe"],
      ["GET", "erp/v1/financeiro/extrato"],
      ["GET", "erp-relatorios/dre"],
      ["GET", "erp-relatorios/graficos/financeiro"],
      ["GET", "erp/v1/me"],
    ])
      expect(erpRouteAllowed(list, method, route), route).toEqual({ ok: true });
    expect(erpRouteAllowed(list, "POST", "erp/v1/financeiro/actions/settle")).toEqual({ ok: false, module: "erp-financeiro", action: "baixar" });
    expect(erpRouteAllowed(list, "POST", "erp/v1/financeiro/actions/reverse")).toMatchObject({ ok: false, action: "baixar" });
    expect(erpRouteAllowed(list, "POST", "erp/v1/financeiro/actions/title_create")).toMatchObject({ ok: false, action: "lancar" });
    expect(erpRouteAllowed(list, "POST", "erp/v1/financeiro/actions/title_delete")).toMatchObject({ ok: false, action: "apagar" });
    expect(erpRouteAllowed(list, "POST", "erp/v1/financeiro/actions/title_cancel")).toMatchObject({ ok: false, action: "apagar" });
    // Outros módulos ficaram sem acesso.
    expect(erpRouteAllowed(list, "GET", "erp/v1/documentos/sales_orders")).toMatchObject({ ok: false, module: "erp-vendas" });
    const error = refusal(() =>
      requireErpAction(person(list), "p1", "POST", "/api/v1/profiles/p1/erp/v1/financeiro/actions/settle"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error!.status).toBe(403);
    expect(error!.code).toBe("permission_denied");
    expect(error!.message).toContain("Financeiro › Baixar e estornar");
    expect(error!.message).toContain("Pessoas e acessos");
    expect(refusal(() => requireErpAction(person(list), "p1", "GET", "/api/v1/profiles/p1/erp/v1/financeiro/titles"))).toBeNull();
  });

  it(
    "pela rota de verdade: a baixa é recusada antes do motor e a leitura passa do portão",
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      await enableErpParts(f.profile, f.admin.id);
      await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(financeReader()), f.member.id);
      const token = await bearer(f.member);
      await exec(env, "UPDATE sessions SET id=? WHERE hash=?", crypto.randomUUID(), await sha(token));
      const call = async (path: string, init: RequestInit = {}) => {
        const ctx = createExecutionContext();
        const response = await worker.fetch(
          new Request(`https://test/api/v1/profiles/${f.profile}/${path}`, {
            ...init,
            headers: { Authorization: "Bearer " + token, ...(init.body ? { "Content-Type": "application/json" } : {}) },
          }),
          env as any,
          ctx,
        );
        await waitOnExecutionContext(ctx);
        return { status: response.status, body: await response.json<any>().catch(() => null) };
      };
      const settle = await call("erp/v1/financeiro/actions/settle", { method: "POST", body: JSON.stringify({}) });
      expect(settle.status, JSON.stringify(settle.body)).toBe(403);
      expect(settle.body.error.code).toBe("permission_denied");
      expect(settle.body.error.message).toContain("Baixar e estornar");
      const create = await call("erp/v1/financeiro/actions/title_create", { method: "POST", body: JSON.stringify({}) });
      expect(create.body?.error?.code).toBe("permission_denied");
      const remove = await call("erp/v1/financeiro/actions/title_delete", { method: "POST", body: JSON.stringify({}) });
      expect(remove.body?.error?.code).toBe("permission_denied");
      const titles = await call("erp/v1/financeiro/titles");
      expect(titles.body?.error?.code, JSON.stringify(titles.body)).not.toBe("permission_denied");
      expect(titles.status).not.toBe(403);
      const dre = await call("erp-relatorios/dre");
      expect(dre.body?.error?.code, JSON.stringify(dre.body)).not.toBe("permission_denied");
    },
  );
});

describe("migração dos papéis antigos do ERP", () => {
  const ROLES: ErpEngineRole[] = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"];

  it("cada papel vira níveis que derivam o mesmo papel do motor", () => {
    for (const role of ROLES) {
      const migrated = migrateErpAccess(["*", `erp:${role}`]);
      expect(migrated).not.toContain(`erp:${role}`);
      expect(erpEngineRoleFor(migrated), role).toBe(role);
      expect(validateAccess(migrated), role).toContain(`erp:${role}`);
      // Todas as partes do ERP ficam com um nível ou ações: nada ambíguo.
      for (const id of ERP_MODULE_IDS) expect(migrated.some((i) => i.startsWith(id + "@") || i.startsWith(id + "+")), `${role} ${id}`).toBe(true);
    }
    // Quem nunca foi salvo no modelo novo continua como estava.
    expect(validateAccess(["*", "erp:vendas"])).toEqual(["*", "erp:vendas"]);
    expect(erpRouteAllowed(["*", "erp:vendas"], "POST", "erp/v1/financeiro/actions/settle")).toEqual({ ok: true });
  });

  it("mantém o que cada papel fazia", () => {
    const can = (role: ErpEngineRole, method: string, route: string) =>
      erpRouteAllowed(validateAccess(migrateErpAccess([`erp:${role}`]))!, method, route).ok;
    // Administrador: tudo, inclusive configurar.
    expect(can("admin", "POST", "erp/v1/empresa")).toBe(true);
    expect(can("admin", "POST", "erp/v1/financeiro/actions/category_create")).toBe(true);
    // Consulta: lê tudo, não muda nada.
    expect(can("consulta", "GET", "erp/v1/financeiro/titles")).toBe(true);
    expect(can("consulta", "GET", "erp/v1/documentos/sales_orders")).toBe(true);
    expect(can("consulta", "GET", "erp-relatorios/dre")).toBe(true);
    expect(can("consulta", "POST", "erp/v1/financeiro/actions/settle")).toBe(false);
    // Vendas: clientes, pedidos e propostas, inclusive cancelar; não lê o Financeiro.
    expect(can("vendas", "POST", "erp/v1/documentos/sales_orders")).toBe(true);
    expect(can("vendas", "POST", "erp/v1/documentos/sales_orders/x/cancelar")).toBe(true);
    expect(can("vendas", "POST", "erp/v1/cadastros/contacts")).toBe(true);
    expect(can("vendas", "GET", "erp/v1/cadastros/products")).toBe(true);
    expect(can("vendas", "GET", "erp/v1/financeiro/titles")).toBe(false);
    // Financeiro: lança, baixa, apaga e concilia; configurar contas é do administrador.
    for (const action of ["title_create", "settle", "reverse", "title_delete", "line_reconcile"])
      expect(can("financeiro", "POST", `erp/v1/financeiro/actions/${action}`), action).toBe(true);
    expect(can("financeiro", "GET", "erp-relatorios/dre")).toBe(true);
    expect(can("financeiro", "POST", "erp/v1/financeiro/actions/account_create")).toBe(false);
    // Estoque e Fiscal.
    expect(can("estoque", "POST", "erp/v1/estoque/movimentos")).toBe(true);
    expect(can("estoque", "POST", "erp/v1/cadastros/products")).toBe(true);
    expect(can("fiscal", "POST", "erp-comercial-nfe/emissoes/x/emitir")).toBe(true);
    expect(can("fiscal", "POST", "erp-comercial-nfe/emissoes/x/carta-correcao")).toBe(true);
    expect(can("fiscal", "GET", "erp/v1/documentos/sales_orders")).toBe(true);
  });

  it("a tela mostra o papel antigo como níveis e salva no modelo novo", () => {
    const migrated = migrateErpAccess(["conversations", "erp:consulta"]);
    expect(moduleLevel(migrated, "erp-financeiro")).toBe("ver");
    const financeiro = migrateErpAccess(["erp:financeiro"]);
    expect(moduleLevel(financeiro, "erp-vendas")).toBe("nenhum");
    expect(moduleLevel(financeiro, "erp-financeiro")).toBe("personalizado");
    expect(legacyErpItems("admin").every((i) => i.endsWith("@administrar"))).toBe(true);
  });
});

describe("tela de pessoa: nível rápido e Personalizar", () => {
  it("nível rápido grava o módulo e põe Sem acesso nas outras partes do ERP", () => {
    const list = setModuleLevel(["*"], "erp-financeiro", "ver", ERP);
    expect(list).toContain("erp-financeiro@ver");
    expect(list).toContain("erp-vendas@nenhum");
    expect(list).toContain("*");
  });

  it("Personalizar marca ações uma a uma e volta ao nível quando forma um", () => {
    const order = ERP_MODULE_ACTIONS["erp-financeiro"].map((a) => a.id);
    let list = setModuleLevel([], "erp-financeiro", "ver", ERP);
    list = toggleModuleAction(list, "erp-financeiro", "baixar", true, order, ERP);
    expect(list).toContain("erp-financeiro+baixar");
    expect(list).toContain("erp-financeiro+ver_contas");
    expect(moduleLevel(list, "erp-financeiro")).toBe("personalizado");
    const saved = validateAccess(list)!;
    expect(erpRouteAllowed(saved, "POST", "erp/v1/financeiro/actions/settle")).toEqual({ ok: true });
    expect(erpRouteAllowed(saved, "POST", "erp/v1/financeiro/actions/title_create")).toMatchObject({ ok: false, action: "lancar" });
    list = toggleModuleAction(list, "erp-financeiro", "baixar", false, order, ERP);
    expect(moduleLevel(list, "erp-financeiro")).toBe("ver");
  });

  it("módulo da área: Só ver lê e não muda; Sem acesso tira o módulo mesmo com o atendente completo", () => {
    const reader = person(validateAccess(["conversations", "os@ver"]));
    expect(allows(reader, "os")).toBe(true);
    expect(refusal(() => requireAreaModuleAction(reader, "os", "GET"))).toBeNull();
    const denied = refusal(() => requireAreaModuleAction(reader, "os", "POST", "Ordem de Serviço"));
    expect(denied?.code).toBe("permission_denied");
    expect(denied?.message).toContain("Ordem de Serviço › Criar e editar");
    const none = person(validateAccess(["*", "os@nenhum"]));
    expect(allows(none, "os")).toBe(false);
    expect(effectiveAccess(none, accessCatalog({ os: true }))).not.toContain("os");
    expect(allows(none, "tickets")).toBe(true);
    // Sem item novo, como antes.
    expect(refusal(() => requireAreaModuleAction(person(["*"]), "os", "DELETE"))).toBeNull();
  });
});

describe("bot com o mesmo modelo", () => {
  it("cada operação do bot é o detalhe de uma ação de módulo", () => {
    const inventory = erpBotInventory(Object.fromEntries(ERP.map((id) => [id, true])));
    const listed = inventory.permissions.flatMap((m) => m.actions.flatMap((a) => a.operations));
    expect([...listed].sort()).toEqual(ERP_BOT_OPERATIONS.map((op) => op.id).sort());
    const writeoff = ERP_BOT_OPERATIONS.find((op) => op.id === "erp_finance_title_bank_writeoff")!;
    expect(erpBotOperationAction(writeoff)).toEqual({ module: "erp-financeiro", action: "baixar" });
    expect(inventory.groups.length).toBeGreaterThan(0);
  });

  it("o bot não faz o que a pessoa não pode: vale pessoa ∩ bot", () => {
    const list = financeReader();
    const via = { bot_id: "b1", run_id: "r1" } as any;
    const actor = person(list, { via });
    for (const op of ERP_BOT_OPERATIONS) {
      const path = `/api/v1/profiles/p1/${op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "x")}`;
      const found = erpRouteAction(op.method, op.path)!;
      const personCan = found.action === null ||
        (found.module === "erp-financeiro" && ["ver_contas", "ver_lucro", "relatorios"].includes(found.action));
      const error = refusal(() => requireErpAction(actor, "p1", op.method, path));
      if (!personCan) expect(error?.code, op.id).toBe("permission_denied");
    }
    // A baixa pelo banco, mesmo liberada ao bot, é recusada pela pessoa.
    expect(refusal(() => requireErpAction(actor, "p1", "POST", "/api/v1/profiles/p1/erp/v1/financeiro/actions/title_bank_writeoff"))?.code)
      .toBe("permission_denied");
  });
});
