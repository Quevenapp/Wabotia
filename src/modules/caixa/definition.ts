// Caixa (PDV): abertura e fechamento com troco inicial, sangria e suprimento,
// venda por toque na grade de produtos com foto e leitor de código de barras.
// Depende de Vendas (catálogo, estoque e a venda) pela interface de
// src/modules/vendas/public.ts. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Código em ./caixa.ts; uso em docs/CAIXA.md.
import type { ModuleDefinition } from "../types";

export const caixaModule: ModuleDefinition = {
  id: "caixa",
  name: "Caixa",
  version: "1.0.0",
  description:
    "Frente de caixa no tablet do balcão: venda por toque com fotos e categorias, leitor de código de barras, troco, sangria, suprimento e fechamento com conferência do dinheiro.",
  builtin: true,
  default_enabled: false,
  requires: ["vendas"],
  navigation: [
    { id: "caixa", label: "Caixa", place: "admin", admin: false },
  ],
  menu_item_types: [],
  events: ["caixa.opened", "caixa.closed", "caixa.moved", "caixa.register_changed"],
  settings: [],
  routes: ["caixa"],
  operations: ["caixa."],
  scopes: [],
};
