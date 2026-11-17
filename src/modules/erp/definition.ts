// ERP (Fagoo) como módulo da área, desligado de fábrica (PLANO-FAGOO.md,
// itens 16 e 17). O núcleo `erp` (cadastros, documentos, estoque,
// financeiro, preferências) é indivisível; Fiscal, Cobrança bancária e
// Caixa/PDV são opcionais com chave própria, dependentes do `erp`. O Origin
// (migração do Bling) não é módulo: sai da instalação principal.
//
// Declaração só com dados (src/modules/registry.ts). Com o `erp` desligado,
// /api/v1/profiles/:profile/erp/* responde 409 module_disabled pelo portão
// comum (routes: ["erp"]). Os opcionais não têm segmento próprio: o portão de
// cada bloco olha o caminho dentro de /erp (src/erp/blocks.ts) e responde o
// mesmo 409 antes de chegar ao objeto erp:<área>. As tabelas existem sempre
// (o esquema é um só); desligar não apaga dados.
import type { ModuleDefinition } from "../types";

const optional = {
  version: "0.1.0",
  builtin: true,
  default_enabled: false,
  navigation: [],
  menu_item_types: [],
  events: [],
  settings: [],
  routes: [],
  operations: [],
  scopes: [],
  requires: ["erp"],
} satisfies Partial<ModuleDefinition>;

export const erpModule: ModuleDefinition = {
  id: "erp",
  name: "ERP",
  version: "0.1.0",
  description:
    "Cadastros de produtos e contatos, pedidos de venda e de compra, propostas, ordens de serviço, estoque e financeiro, no banco próprio da área.",
  builtin: true,
  default_enabled: false,
  navigation: [{ id: "erp", label: "ERP", place: "rail", admin: false }],
  menu_item_types: [],
  events: [],
  settings: [],
  // erp-emissor: a configuração do emissor fiscal (src/erp/emissor/routes.ts),
  // fora de /erp/* porque /erp/* é a erp-api inteira; o papel erp:* dá a rota.
  routes: ["erp", "erp-emissor"],
  operations: [],
  scopes: [],
  // Papéis do ERP (os seis do Fagoo) no acesso por pessoa: no máximo um por
  // pessoa (src/access.ts, validateAccess). O administrador do Wabotia vale
  // erp:admin; o "*" dá o módulo, nunca o papel. O motor recebe o papel no
  // envelope de identidade (src/modules/erp/identity.ts).
  grants: [
    {
      id: "admin",
      label: "ERP: administrador",
      description:
        "Tudo no ERP, inclusive empresa, usuários do ERP, preferências e política de segurança.",
    },
    {
      id: "consulta",
      label: "ERP: consulta",
      description: "Só leitura: cadastros, documentos, estoque e relatórios.",
    },
    {
      id: "vendas",
      label: "ERP: vendas",
      description:
        "Clientes, produtos, propostas e pedidos de venda, e o caixa quando ligado.",
    },
    {
      id: "financeiro",
      label: "ERP: financeiro",
      description: "Contas a pagar e a receber, caixa, conciliação e cobrança.",
    },
    {
      id: "estoque",
      label: "ERP: estoque",
      description:
        "Entradas, saídas, transferências, inventário e pedidos de compra.",
    },
    {
      id: "fiscal",
      label: "ERP: fiscal",
      description:
        "Notas fiscais, naturezas de operação e numeração, quando o Fiscal está ligado.",
    },
  ],
};

export const erpFiscalModule: ModuleDefinition = {
  ...optional,
  id: "erp-fiscal",
  name: "ERP: Fiscal",
  description:
    "Notas fiscais de entrada e de saída, NFC-e, naturezas de operação, numeração e notas recebidas (DF-e). Sem ele, o ERP e o PDV vendem sem documento fiscal.",
};

export const erpCobrancaModule: ModuleDefinition = {
  ...optional,
  id: "erp-cobranca",
  name: "ERP: Cobrança bancária",
  description:
    "Boletos, remessas e retornos CNAB, borderôs e a baixa de títulos pelo retorno do banco. Sem ele, os títulos são baixados à mão no financeiro.",
};

export const erpPdvModule: ModuleDefinition = {
  ...optional,
  id: "erp-pdv",
  name: "ERP: Caixa / PDV",
  description:
    "Frente de caixa para venda no balcão e devolução, com baixa no estoque e no caixa do financeiro.",
};
