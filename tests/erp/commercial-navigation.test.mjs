import { test } from "node:test";
import assert from "node:assert/strict";
import { ERP_ROUTE_ALIASES, erpRouteExists } from "../../src/erp/blocks.ts";
import { erpRouteRequirement, erpDestinationRequirement } from "../../src/erp/parts-requirements.ts";
import { ERP_MODULE_IDS, erpRequirementMet, normalizeErpParts } from "../../src/erp/parts.ts";
import { ERP_MANAGEMENT_ITEMS } from "../../src/modules/erp/panel-menu.ts";
import { portedTargetState } from "../../web/management/ported-policy.ts";
import { setErpBlocks, targetEnabled } from "../../web/erp/blocks.ts";
import { setMotorReal } from "../../web/erp/motor.ts";
import { resolveMenu } from "../../web/erp/app/lib/origin-menu.ts";
import { workspaceMenu } from "../../web/erp/app/lib/fagoo-menu.ts";

const screens = [
  ["/meu-negocio", "erp-vendas", "sales", "/v1/meu-negocio/mensal"],
  ["/preferencias/sistema/registro-atividades", "erp", "customers", "/v1/registro-atividades"],
  ["/preferencias/sistema/consulta-exclusoes", "erp", "customers", "/v1/registro-atividades"],
  ["/cobranca-operacional", "erp-cobranca", "billing", "/v1/cobranca-operacional"],
  ["/retornos-operacionais", "erp-cobranca", "billing", "/v1/retornos-operacionais"],
];

test("as cinco telas têm menu e ficam subordinadas à sua parte", () => {
  const modules = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true]));
  for (const [screen, owner, part, route] of screens) {
    const item = ERP_MANAGEMENT_ITEMS.find(item => item.target.to.split("?")[0] === screen);
    assert.equal(item?.module, owner, screen);
    assert.equal(erpDestinationRequirement(screen)?.owner, owner, screen);
    const context = { statusLoaded: true, modules, erpRole: "admin" };
    assert.equal(portedTargetState(screen, context), "allowed", screen);
    assert.equal(portedTargetState(screen, { ...context, erpRole: null }), "denied", screen);
    assert.equal(portedTargetState(screen, { ...context, modules: { ...modules, [owner]: false } }), "disabled", screen);
    const requirement = erpRouteRequirement("GET", new URL(route, "https://erp.invalid"));
    assert.ok(erpRequirementMet(normalizeErpParts(), requirement), route);
    assert.equal(erpRequirementMet(normalizeErpParts({ [part]: false }), requirement), false, route);
  }
});

test("a projeção do menu entrega as telas reabertas ao grupo certo sem ampliar os papéis", () => {
  const modules = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true]));
  const destinations = [
    ["/cobranca-operacional", "Financeiro", ["admin", "consulta", "financeiro"]],
    ["/retornos-operacionais", "Financeiro", ["admin", "consulta", "financeiro"]],
    ["/preferencias/sistema/registro-atividades", "Sistema", ["admin"]],
    ["/preferencias/sistema/consulta-exclusoes", "Sistema", ["admin"]],
  ];
  setErpBlocks(modules);
  setMotorReal(true);
  try {
    for (const role of ["admin", "consulta", "financeiro", "vendas", "estoque", "fiscal"]) {
      const groups = workspaceMenu(resolveMenu("real", { role, resources: ["contacts", "products"] }));
      for (const [to, group, roles] of destinations) {
        const actual = groups.find(entry => entry.columns.some(column => column.items.some(item => item.to === to)));
        assert.equal(actual?.name, roles.includes(role) ? group : undefined, `${role}: ${to}`);
      }
    }
    setErpBlocks({ ...modules, "erp-cobranca": false });
    const disabled = workspaceMenu(resolveMenu("real", { role: "admin", resources: ["contacts", "products"] }));
    assert.equal(disabled.some(group => group.columns.some(column => column.items.some(item => destinations.slice(0, 2).some(([to]) => item.to === to)))), false);
  } finally {
    setMotorReal(false);
    setErpBlocks(null);
  }
});

test("consultas e fragmentos preservam telas comerciais abertas e recusas fiscais, de parte e de papel", () => {
  const modules = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true]));
  const context = { statusLoaded: true, modules, erpRole: "admin" };
  setMotorReal(true);
  try {
    for (const [screen, owner] of screens) {
      for (const suffix of ["", "#detalhe", "?filtro=ativo#detalhe"]) {
        const to = screen + suffix;
        setErpBlocks(modules);
        assert.equal(targetEnabled(to), true, to);
        assert.equal(portedTargetState(to, context), "allowed", to);
        assert.equal(portedTargetState(to, { ...context, erpRole: null }), "denied", to);
        const disabled = { ...modules, [owner]: false };
        setErpBlocks(disabled);
        assert.equal(targetEnabled(to), false, to);
        assert.equal(portedTargetState(to, { ...context, modules: disabled }), "disabled", to);
      }
    }
    setErpBlocks(modules);
    for (const screen of ["/notas-entrada", "/notas-recebidas", "/inutilizacoes-nfe", "/cartas-correcao", "/numeracao-fiscal", "/emissor-fiscal", "/preferencias/certificado/configuracoes", "/preferencias/importacoes/notas-fiscais"]) {
      for (const suffix of ["", "#detalhe", "?filtro=ativo#detalhe"]) {
        const to = screen + suffix;
        assert.equal(targetEnabled(to), false, to);
        assert.equal(portedTargetState(to, context), "unavailable", to);
        assert.equal(portedTargetState(to, context, true), "allowed", to);
      }
    }
    setMotorReal(false);
    assert.equal(targetEnabled("/notas-recebidas#detalhe"), true);
  } finally {
    setMotorReal(false);
    setErpBlocks(null);
  }
});

test("raízes CNAB são aliases de listagens existentes e não criam escritas", () => {
  for (const root of ["/v1/cobranca-operacional", "/v1/cobranca-operacional-v2", "/v1/retornos-operacionais"]) {
    assert.ok(erpRouteExists("GET", root));
    assert.ok(erpRouteExists("GET", ERP_ROUTE_ALIASES[root]));
    assert.equal(erpRouteExists("DELETE", root), false);
    assert.equal(erpRouteExists("POST", root), false);
    assert.deepEqual(erpRouteRequirement("GET", new URL(root, "https://erp.invalid")),
      erpRouteRequirement("GET", new URL(ERP_ROUTE_ALIASES[root], "https://erp.invalid")));
  }
});

test("painéis de margem e previsão exigem as mesmas partes da tela", () => {
  for (const panel of ["margem-pedido", "previsao-estoque"]) {
    assert.deepEqual(erpRouteRequirement("GET", new URL(`/v1/meu-negocio/${panel}`, "https://erp.invalid")),
      erpDestinationRequirement(`/meu-negocio?painel=${panel}`).requirement);
  }
});
