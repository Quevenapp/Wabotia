// Reforma tributária no ERP (IBS, CBS e IS), em
// /api/v1/profiles/:profile/erp-reforma: configuração da empresa,
// classificação e Imposto Seletivo do produto, classificação da natureza,
// contexto do bloco das propostas e pedidos e o relatório do contador (CSV).
//
// Só pela tela (bot: false): fora do inventário dos bots. Cada operação exige
// as partes do ERP dela (desligada: 409 module_disabled e qual ligar). O motor
// confere papel e permissão de novo. Só sintaxe TypeScript apagável: os
// testes do Node importam este arquivo.
import type { ErpModuleId } from "../parts.ts";

/** Segmento das rotas no Worker (módulo erp e parte Fiscal). */
export const ERP_REFORMA_ROUTE = "erp-reforma";

export interface ErpReformOperation {
  name: string;
  method: "GET" | "POST";
  /** Depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  /** Partes do ERP que a operação exige (a dona primeiro). */
  parts: readonly ErpModuleId[];
  /** O RPC do motor que a operação chama. */
  rpc: string;
  query: readonly string[];
  body: readonly string[];
  required: readonly string[];
  bot: false;
}

const R = ERP_REFORMA_ROUTE;
export const ERP_REFORM_OPERATIONS: readonly ErpReformOperation[] = Object.freeze([
  {
    name: "erp.reforma.configuracao", method: "GET", path: `${R}/configuracao`, parts: ["erp-fiscal"], rpc: "erp_fiscal_reform_settings_get",
    summary: "Ver a configuração da reforma tributária", query: [], body: [], required: [], bot: false,
  },
  {
    name: "erp.reforma.configuracao.salvar", method: "POST", path: `${R}/configuracao`, parts: ["erp-fiscal"], rpc: "erp_fiscal_reform_settings_save",
    summary: "Salvar a configuração da reforma tributária", query: [], body: ["simples_regular", "aliquotas", "versao", "comando"], required: ["simples_regular", "versao"], bot: false,
  },
  {
    name: "erp.reforma.produto", method: "GET", path: `${R}/produtos/:id`, parts: ["erp-fiscal", "erp-produtos"], rpc: "erp_fiscal_reform_product_get",
    summary: "Ver a classificação de IBS/CBS e o Imposto Seletivo de um produto", query: [], body: [], required: ["id"], bot: false,
  },
  {
    name: "erp.reforma.produto.salvar", method: "POST", path: `${R}/produtos/:id`, parts: ["erp-fiscal", "erp-produtos"], rpc: "erp_fiscal_reform_product_save",
    summary: "Salvar a classificação de IBS/CBS e o Imposto Seletivo de um produto", query: [], body: ["classificacao", "seletivo", "hash", "comando"], required: ["id", "hash"], bot: false,
  },
  {
    name: "erp.reforma.natureza", method: "GET", path: `${R}/naturezas/:id`, parts: ["erp-fiscal"], rpc: "erp_fiscal_reform_nature_class_get",
    summary: "Ver a classificação de IBS/CBS padrão e as exceções de uma natureza de operação", query: [], body: [], required: ["id"], bot: false,
  },
  {
    name: "erp.reforma.natureza.salvar", method: "POST", path: `${R}/naturezas/:id`, parts: ["erp-fiscal"], rpc: "erp_fiscal_reform_nature_class_save",
    summary: "Salvar a classificação de IBS/CBS de uma natureza de operação", query: [], body: ["regras", "hash", "comando"], required: ["id", "regras", "hash"], bot: false,
  },
  {
    name: "erp.reforma.documento", method: "GET", path: `${R}/documento`, parts: ["erp-fiscal", "erp-vendas"], rpc: "erp_fiscal_reform_document_context",
    summary: "Classificação dos produtos de uma proposta ou pedido para o bloco de IBS/CBS", query: ["tipo", "contato", "produtos"], body: [], required: ["tipo"], bot: false,
  },
  {
    name: "erp.reforma.relatorio", method: "GET", path: `${R}/relatorio`, parts: ["erp-fiscal"], rpc: "erp_fiscal_reform_report",
    summary: "IBS, CBS e IS das NF-e autorizadas por mês e classificação (CSV para o contador)", query: ["de", "ate", "ambiente", "formato"], body: [], required: ["de", "ate"], bot: false,
  },
]);

/** A operação e os parâmetros do caminho, ou null. */
export function erpReformOperationFor(method: string, path: string) {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  for (const operation of ERP_REFORM_OPERATIONS) {
    if (operation.method !== verb) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/:([a-z_]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; })}/?$`);
    const match = pattern.exec(path);
    if (match) return { operation, params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])) as Record<string, string> };
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReformArgsError extends Error {}
const bad = (message: string): never => { throw new ReformArgsError(message); };
const uuid = (value: unknown, label: string) => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : bad(`${label}: informe um identificador válido.`));

/** Argumentos do RPC a partir do caminho, da consulta e do corpo (nomes em português na API). */
export function reformRpcArgs(operation: ErpReformOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined, command: () => string) {
  const b = body ?? {};
  const comando = b.comando === undefined || b.comando === null ? command() : uuid(b.comando, "comando");
  switch (operation.name) {
    case "erp.reforma.configuracao":
      return {};
    case "erp.reforma.configuracao.salvar":
      if (typeof b.simples_regular !== "boolean") bad("simples_regular: informe sim ou não.");
      if (!Number.isSafeInteger(b.versao) || (b.versao as number) < 0) bad("versao: informe a versão lida da configuração.");
      return { p_command_id: comando, p_expected_version: b.versao, p_data: { simples_regular: b.simples_regular, rates: b.aliquotas ?? {} } };
    case "erp.reforma.produto":
      return { p_product_id: uuid(params.id, "produto") };
    case "erp.reforma.produto.salvar":
      if (typeof b.hash !== "string") bad("hash: informe a versão lida do produto.");
      return { p_command_id: comando, p_product_id: uuid(params.id, "produto"), p_expected_hash: b.hash, p_classification: b.classificacao ?? null, p_selective: b.seletivo ?? null };
    case "erp.reforma.natureza":
      return { p_nature_id: uuid(params.id, "natureza") };
    case "erp.reforma.natureza.salvar":
      if (typeof b.hash !== "string" || !Array.isArray(b.regras)) bad("Informe as regras e a versão lida da natureza.");
      return { p_command_id: comando, p_nature_id: uuid(params.id, "natureza"), p_expected_hash: b.hash, p_rules: b.regras };
    case "erp.reforma.documento": {
      const kind = query.get("tipo");
      if (kind !== "sales_orders" && kind !== "sales_proposals") bad("tipo: sales_orders ou sales_proposals.");
      const contact = query.get("contato");
      const products = (query.get("produtos") ?? "").split(",").filter(Boolean);
      if (products.length > 250) bad("produtos: até 250 por consulta.");
      return { p_kind: kind, p_contact_id: contact ? uuid(contact, "contato") : null, p_product_ids: products.map((id) => uuid(id, "produto")) };
    }
    case "erp.reforma.relatorio": {
      const from = query.get("de"), to = query.get("ate"), environment = query.get("ambiente") ?? "producao";
      if (!from || !to || !DATE.test(from) || !DATE.test(to)) bad("Informe o período (de e ate, AAAA-MM-DD).");
      if (!["producao", "homologacao"].includes(environment)) bad("ambiente: producao ou homologacao.");
      return { p_from: from, p_to: to, p_environment: environment };
    }
    default:
      return bad("Operação desconhecida.");
  }
}

export const ERP_REFORMA_MODULE_CONTRACT = { routes: [ERP_REFORMA_ROUTE] };
