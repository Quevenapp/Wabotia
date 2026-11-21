// Argumentos dos RPCs da expedição a partir da consulta, do caminho e do corpo
// das rotas (./routes.ts). Puro: os testes do Node importam este arquivo. O
// motor confere tudo de novo (src/erp/domains/shipping/rpc.ts).
import type { ErpShippingOperation } from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Pedido com dado inválido (a rota responde 400 invalid_request com a mensagem). */
export class ShippingArgsError extends Error {}
const bad = (message: string): never => { throw new ShippingArgsError(message); };

export const SHIPPING_STATUS_PARAM: Readonly<Record<string, string>> = Object.freeze({
  a_separar: "to_pick", em_separacao: "picking", separado: "picked", embalado: "packed", expedido: "shipped", todas: "all",
});
export const RETURN_CONDITION_PARAM: Readonly<Record<string, string>> = Object.freeze({
  volta_ao_estoque: "restock", avariado: "damaged", descarte: "discard",
});

export const uuid = (value: unknown, name: string, required = false): string | null => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: informe o identificador.`) : null;
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
};
const date = (value: string | null, name: string): string | null => {
  if (value === null || value === "") return null;
  if (!DATE.test(value)) bad(`${name}: use a data no formato AAAA-MM-DD.`);
  return value;
};
const decimal = (value: unknown, name: string): string => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]{1,12}([.,][0-9]{1,6})?$/.test(text)) bad(`${name}: informe um número, como 2 ou 2,5.`);
  return text.replace(",", ".");
};
const optionalDecimal = (value: unknown, name: string) => (value === undefined || value === null || value === "" ? null : decimal(value, name));
const ids = (value: unknown, name: string): string[] => {
  const list = typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) bad(`${name}: escolha de 1 a 100 pedidos.`);
  return (list as unknown[]).map((id) => uuid(id, name, true)!);
};
const version = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) bad("versao: atualize a tela e tente de novo.");
  return value as number;
};
const text = (value: unknown, name: string, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") bad(`${name}: use texto.`);
  if ((value as string).length > max) bad(`${name}: até ${max} caracteres.`);
  return (value as string).trim() || null;
};
const carrier = (value: string | null) => (value === "sem" ? "none" : uuid(value, "transportadora"));

/** Os argumentos do RPC a partir da consulta, do caminho e do corpo. */
export async function shippingRpcArgs(operation: ErpShippingOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined,
  command: (body: Record<string, unknown>) => Promise<string>): Promise<Record<string, unknown>> {
  for (const key of query.keys()) if (!operation.query.includes(key) || query.getAll(key).length !== 1) bad(`Parâmetro não aceito: ${key}. Use ${operation.query.join(", ") || "nenhum"}.`);
  const q = (key: string) => query.get(key);
  const b = body ?? {};
  const withCommand = async (args: Record<string, unknown>) => ({ p_command_id: await command(b), p_args: args });
  switch (operation.name) {
    case "erp.expedicao.pedidos": {
      const status = q("situacao");
      if (status !== null && status !== "" && !Object.hasOwn(SHIPPING_STATUS_PARAM, status)) bad(`situacao: use ${Object.keys(SHIPPING_STATUS_PARAM).join(", ")}.`);
      return { p_args: { ...(status ? { status: SHIPPING_STATUS_PARAM[status] } : {}), from: date(q("de"), "de"), to: date(q("ate"), "ate"),
        carrier_id: carrier(q("transportadora")), warehouse_id: uuid(q("deposito"), "deposito"), search: text(q("busca"), "busca", 100) } };
    }
    case "erp.expedicao.pedido":
      return { p_args: { id: uuid(params.id, "pedido", true) } };
    case "erp.expedicao.separacao":
      return { p_args: { id: uuid(params.id, "lista", true) } };
    case "erp.expedicao.embalagens":
      return { p_args: {} };
    case "erp.expedicao.romaneio":
      return { p_args: { from: date(q("de"), "de"), to: date(q("ate"), "ate"), carrier_id: carrier(q("transportadora")) } };
    case "erp.expedicao.etiquetas":
      return { p_args: { document_ids: ids(q("pedidos"), "pedidos") } };
    case "erp.expedicao.separacao.gerar": {
      if (b.filtros !== undefined && b.filtros !== null && (typeof b.filtros !== "object" || Array.isArray(b.filtros))) bad("filtros: use um objeto.");
      return withCommand({ document_ids: ids(b.pedidos, "pedidos"), filters: b.filtros ?? {} });
    }
    case "erp.expedicao.separacao.marcar":
      if (typeof b.linha !== "string" || !b.linha) bad("linha: informe a linha da lista.");
      return { p_args: { list_id: uuid(params.id, "lista", true), expected_version: version(b.versao), key: b.linha, picked: decimal(b.separado, "separado") } };
    case "erp.expedicao.separacao.concluir":
    case "erp.expedicao.separacao.cancelar":
      return withCommand({ list_id: uuid(params.id, "lista", true), expected_version: version(b.versao) });
    case "erp.expedicao.pendencia.resolver":
      return withCommand({ id: uuid(params.id, "pendencia", true), note: text(b.observacao, "observacao", 500) });
    case "erp.expedicao.embalagem.salvar": {
      if (b.ativa !== undefined && typeof b.ativa !== "boolean") bad("ativa: use verdadeiro ou falso.");
      const id = uuid(b.id, "id");
      return withCommand({
        ...(id ? { id, expected_version: version(b.versao) } : {}), name: text(b.nome, "nome", 80) ?? bad("nome: informe o nome da embalagem."),
        length_cm: optionalDecimal(b.comprimento, "comprimento"), width_cm: optionalDecimal(b.largura, "largura"), height_cm: optionalDecimal(b.altura, "altura"),
        empty_weight_kg: optionalDecimal(b.peso_vazio, "peso_vazio"), ...(b.ativa !== undefined ? { active: b.ativa } : {}),
      });
    }
    case "erp.expedicao.volumes": {
      if (!Array.isArray(b.volumes) || b.volumes.length < 1 || b.volumes.length > 999) bad("volumes: monte de 1 a 999 volumes.");
      const volumes = (b.volumes as unknown[]).map((raw, index) => {
        const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : bad(`volume ${index + 1}: formato inválido.`);
        if (!Array.isArray(v.itens)) bad(`volume ${index + 1}: informe os itens.`);
        return {
          package_id: uuid(v.embalagem, `volume ${index + 1}, embalagem`), length_cm: optionalDecimal(v.comprimento, "comprimento"), width_cm: optionalDecimal(v.largura, "largura"),
          height_cm: optionalDecimal(v.altura, "altura"), gross_kg: optionalDecimal(v.peso_bruto, "peso_bruto"),
          items: (v.itens as unknown[]).map((item) => {
            const i = item && typeof item === "object" ? (item as Record<string, unknown>) : bad(`volume ${index + 1}: item inválido.`);
            return { key: typeof i.linha === "string" ? i.linha : bad(`volume ${index + 1}: informe a linha do item.`), quantity: decimal(i.quantidade, "quantidade") };
          }),
        };
      });
      return withCommand({ document_id: uuid(params.id, "pedido", true), expected_version: version(b.versao), volumes });
    }
    case "erp.expedicao.expedir":
      return withCommand({ document_ids: ids(b.pedidos, "pedidos"), tracking_code: text(b.rastreio, "rastreio", 200) });
    case "erp.expedicao.entrega_local":
      return { p_args: { document_id: uuid(params.id, "pedido", true) } };
    case "erp.expedicao.devolucao": {
      if (!Array.isArray(b.itens) || b.itens.length < 1 || b.itens.length > 250) bad("itens: informe de 1 a 250 itens que voltaram.");
      const items = (b.itens as unknown[]).map((raw) => {
        const i = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : bad("itens: formato inválido.");
        const condition = typeof i.estado === "string" && Object.hasOwn(RETURN_CONDITION_PARAM, i.estado) ? RETURN_CONDITION_PARAM[i.estado] : bad("estado: use volta_ao_estoque, avariado ou descarte.");
        return { key: typeof i.linha === "string" ? i.linha : bad("linha: informe a linha do item no pedido."), quantity: decimal(i.quantidade, "quantidade"), condition };
      });
      return withCommand({ document_id: uuid(params.id, "pedido", true), reason: text(b.motivo, "motivo", 500) ?? bad("motivo: diga por que a mercadoria voltou."),
        warehouse_id: uuid(b.deposito, "deposito"), items });
    }
  }
  return bad("Operação desconhecida.");
}
