// Argumentos dos RPCs da conciliação a partir da consulta, do caminho e do
// corpo das rotas (./routes.ts). Puro: os testes do Node importam este
// arquivo. O motor confere tudo de novo (src/erp/domains/reconciliation/rpc.ts).
import type { ErpReconciliationOperation } from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Pedido com dado inválido (a rota responde 400 invalid_request com a mensagem). */
export class ReconciliationArgsError extends Error {}
const bad = (message: string): never => { throw new ReconciliationArgsError(message); };

export const BANK_STATE_PARAM: Readonly<Record<string, string>> = Object.freeze({ pendentes: "pending", conciliadas: "reconciled", ignoradas: "ignored", todas: "all" });
export const CARD_STATE_PARAM: Readonly<Record<string, string>> = Object.freeze({
  pendentes: "pending", casadas: "matched", recebidas: "received", ignoradas: "ignored", abertas: "open", todas: "all",
});
export const BANK_ACTION_PARAM: Readonly<Record<string, string>> = Object.freeze({
  confirmar: "confirm", baixar: "settle", lancar_regra: "rule_entry", lancar: "create_entry", ignorar: "ignore", voltar: "unignore", desfazer: "undo",
});
export const CARD_ACTION_PARAM: Readonly<Record<string, string>> = Object.freeze({
  confirmar: "confirm", casar: "match", desfazer_casamento: "unmatch", ignorar: "ignore", voltar: "unignore", desfazer_recebimento: "unreceive",
});
export const CARD_BATCH_PARAM: Readonly<Record<string, string>> = Object.freeze({ confirmar_sugestoes: "confirm_all", procurar_de_novo: "rematch" });

export const uuid = (value: unknown, name: string, required = false): string | null => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: informe o identificador.`) : null;
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
};
const date = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE.test(value)) bad(`${name}: use a data no formato AAAA-MM-DD.`);
  return value as string;
};
const version = (value: unknown, name = "versao"): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) bad(`${name}: atualize a tela e tente de novo.`);
  return value as number;
};
const text = (value: unknown, name: string, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") bad(`${name}: use texto.`);
  if ((value as string).length > max) bad(`${name}: até ${max} caracteres.`);
  return (value as string).trim() || null;
};
const flag = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "sim") return true;
  if (value === "false" || value === "nao" || value === "não") return false;
  return bad(`${name}: use verdadeiro ou falso.`);
};
const cents = (value: unknown, name: string): string => {
  const t = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof t !== "string" || !/^[0-9]{1,15}$/.test(t)) bad(`${name}: informe o valor em centavos (só números).`);
  return t as string;
};
const integer = (value: unknown, name: string, lo: number, hi: number): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < lo || n > hi) bad(`${name}: use um número de ${lo} a ${hi}.`);
  return n as number;
};
/** Percentual da taxa ("1,99", "1.99" ou 1.99) → centésimos de ponto (199). */
export const rateParam = (value: unknown): number => {
  const t = typeof value === "number" ? String(value) : typeof value === "string" ? value.replace("%", "").trim().replace(",", ".") : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) bad("taxa: informe o percentual, como 1,99.");
  const bp = Math.round(Number(t) * 100);
  if (bp > 10000) bad("taxa: até 100%.");
  return bp;
};
const enumOf = (value: unknown, map: Readonly<Record<string, string>>, name: string): string => {
  if (typeof value !== "string" || !Object.hasOwn(map, value)) bad(`${name}: use ${Object.keys(map).join(", ")}.`);
  return map[value as string];
};
const object = (value: unknown, name: string): Record<string, unknown> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) bad(`${name}: use um objeto.`);
  return value as Record<string, unknown>;
};
const fileFormat = (value: unknown) => (value === "ofx" || value === "csv" ? value : bad("formato: use ofx ou csv."));
const content = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : bad("conteudo: envie o texto do arquivo."));
/** "Banco" do modelo salvo junto com a importação: { nome }. */
const saveLayout = (value: unknown) => {
  if (value === undefined || value === null || value === "" || value === false) return undefined;
  if (typeof value === "string") return { name: text(value, "salvar_modelo", 80) ?? bad("salvar_modelo: dê um nome ao modelo.") };
  const o = object(value, "salvar_modelo")!;
  return { name: text(o.nome, "salvar_modelo.nome", 80) ?? bad("salvar_modelo: dê um nome ao modelo.") };
};
/** Modelo de colunas: { colunas: { data: "Data", valor: "Valor", ... }, separador, decimal, formato_data, inverter }. */
const BANK_COLUMNS: Readonly<Record<string, string>> = { data: "date", descricao: "description", valor: "amount", credito: "credit", debito: "debit", saldo: "balance", documento: "id", tipo: "type" };
const CARD_COLUMNS: Readonly<Record<string, string>> = {
  data_venda: "sold_on", data_pagamento: "expected_on", bandeira: "brand", modalidade: "product", parcela: "installment", parcelas: "installments",
  bruto: "gross", taxa: "fee", liquido: "net", percentual: "rate", nsu: "nsu", autorizacao: "authorization", descricao: "description",
};
export function mappingParam(value: unknown, kind: "bank" | "card") {
  const o = object(value, "colunas");
  if (!o) return undefined;
  const names = kind === "bank" ? BANK_COLUMNS : CARD_COLUMNS;
  const columns: Record<string, string> = {};
  const source = object(o.colunas ?? {}, "colunas.colunas")!;
  for (const [key, v] of Object.entries(source)) {
    if (!Object.hasOwn(names, key)) bad(`colunas: use ${Object.keys(names).join(", ")}.`);
    const t = text(v, `colunas.${key}`, 80);
    if (t) columns[names[key]] = t;
  }
  const separator = o.separador === undefined ? undefined : o.separador === ";" || o.separador === "," || o.separador === "\t" ? o.separador : o.separador === "tab" ? "\t" : bad("separador: use ; , ou tab.");
  const decimal = o.decimal === undefined ? undefined : o.decimal === "," || o.decimal === "." || o.decimal === "auto" ? o.decimal : bad("decimal: use , ou .");
  const format = o.formato_data === undefined ? undefined : ({ "dd/mm/aaaa": "dmy", "aaaa-mm-dd": "ymd", "mm/dd/aaaa": "mdy", dmy: "dmy", ymd: "ymd", mdy: "mdy" } as Record<string, string>)[String(o.formato_data)]
    ?? bad("formato_data: use dd/mm/aaaa, aaaa-mm-dd ou mm/dd/aaaa.");
  return { columns, ...(separator ? { separator } : {}), ...(decimal ? { decimal } : {}), ...(format ? { date_format: format } : {}), ...(flag(o.inverter, "inverter") ? { invert: true } : {}) };
}

/** Os argumentos do RPC a partir da consulta, do caminho e do corpo. */
export async function reconciliationRpcArgs(operation: ErpReconciliationOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined,
  command: (body: Record<string, unknown>) => Promise<string>): Promise<Record<string, unknown>> {
  for (const key of query.keys()) if (!operation.query.includes(key) || query.getAll(key).length !== 1) bad(`Parâmetro não aceito: ${key}. Use ${operation.query.join(", ") || "nenhum"}.`);
  const q = (key: string) => query.get(key);
  const b = body ?? {};
  const withCommand = async (args: Record<string, unknown>) => ({ p_command_id: await command(b), p_args: args });
  switch (operation.name) {
    case "erp.conciliacao.resumo":
      return { p_args: {} };
    case "erp.conciliacao.banco": {
      const state = q("situacao");
      return { p_args: { account_id: uuid(params.conta, "conta", true), ...(state ? { state: enumOf(state, BANK_STATE_PARAM, "situacao") } : {}),
        from: date(q("de"), "de"), to: date(q("ate"), "ate"), search: text(q("busca"), "busca", 100) } };
    }
    case "erp.conciliacao.banco.candidatos":
      return { p_args: { line_id: uuid(params.id, "linha", true), search: text(q("busca"), "busca", 120), from: date(q("de"), "de"), to: date(q("ate"), "ate") } };
    case "erp.conciliacao.previa": {
      const target = b.alvo === "banco" ? "bank" : b.alvo === "cartao" ? "card" : bad("alvo: use banco ou cartao.");
      return { p_args: { target, ...(target === "card" ? { kind: b.tipo === "recebiveis" ? "receivables" : b.tipo === "vendas" ? "sales" : bad("tipo: use vendas ou recebiveis.") } : {}),
        format: target === "bank" ? fileFormat(b.formato) : "csv", content: content(b.conteudo), layout_id: uuid(b.modelo, "modelo"), mapping: mappingParam(b.colunas, target) } };
    }
    case "erp.conciliacao.banco.importar":
      return withCommand({ account_id: uuid(params.conta, "conta", true), format: fileFormat(b.formato), file_name: text(b.arquivo, "arquivo", 200), content: content(b.conteudo),
        layout_id: uuid(b.modelo, "modelo"), mapping: mappingParam(b.colunas, "bank"), save_layout: saveLayout(b.salvar_modelo) });
    case "erp.conciliacao.banco.conciliar": {
      const action = enumOf(b.acao, BANK_ACTION_PARAM, "acao");
      const args: Record<string, unknown> = { line_id: uuid(params.id, "linha", true), expected_version: version(b.versao), action };
      if (action === "confirm") {
        if (!Array.isArray(b.vinculos) || b.vinculos.length < 1 || b.vinculos.length > 50) bad("vinculos: escolha de 1 a 50 lançamentos.");
        args.links = (b.vinculos as unknown[]).map((raw) => {
          const o = object(raw, "vinculos") ?? bad("vinculos: formato inválido.");
          const kind = o.tipo === "lancamento" || o.tipo === "entry" ? "entry" : o.tipo === "movimento" || o.tipo === "movement" ? "movement" : bad("vinculos: tipo lancamento ou movimento.");
          return { kind, id: uuid(o.id, "vinculos.id", true) };
        });
      } else if (action === "settle") {
        if (!Array.isArray(b.contas) || b.contas.length < 1 || b.contas.length > 50) bad("contas: escolha de 1 a 50 contas a baixar.");
        args.titles = (b.contas as unknown[]).map((raw) => {
          const o = object(raw, "contas") ?? bad("contas: formato inválido.");
          return { id: uuid(o.id, "contas.id", true), ...(o.versao !== undefined ? { expected_version: version(o.versao, "contas.versao") } : {}),
            ...(o.valor !== undefined ? { amount_cents: cents(o.valor, "contas.valor") } : {}) };
        });
      } else if (action === "rule_entry") args.rule_id = uuid(b.regra, "regra", true);
      else if (action === "create_entry") {
        args.category_id = uuid(b.categoria, "categoria", true);
        args.contact_id = uuid(b.contato, "contato");
        args.note = text(b.observacao, "observacao", 500);
      } else if (action === "ignore") args.reason = text(b.motivo, "motivo", 500) ?? bad("motivo: diga por que a linha fica de fora (de 3 a 500 caracteres).");
      else if (action === "undo") { const r = flag(b.estornar, "estornar"); if (r !== undefined) args.reverse = r; }
      return withCommand(args);
    }
    case "erp.conciliacao.regra.salvar": {
      const id = uuid(b.id, "id");
      const direction = b.direcao === undefined || b.direcao === null ? "any" : enumOf(b.direcao, { entradas: "in", saidas: "out", todas: "any" }, "direcao");
      return withCommand({ ...(id ? { id, expected_version: version(b.versao) } : {}), name: text(b.nome, "nome", 80), pattern: text(b.texto, "texto", 120) ?? bad("texto: diga o que procurar na descrição do extrato."),
        direction, account_id: uuid(b.conta, "conta"), category_id: uuid(b.categoria, "categoria", true), contact_id: uuid(b.contato, "contato"), note: text(b.observacao, "observacao", 500),
        ...(b.ativa !== undefined ? { active: flag(b.ativa, "ativa") } : {}) });
    }
    case "erp.conciliacao.modelo.salvar": {
      const kind = b.tipo === "banco" ? "bank" : b.tipo === "cartao" ? "card" : bad("tipo: use banco ou cartao.");
      const id = uuid(b.id, "id");
      return withCommand({ ...(id ? { id, expected_version: version(b.versao) } : {}), kind, name: text(b.nome, "nome", 80) ?? bad("nome: dê um nome ao modelo."),
        ...(kind === "card" ? { acquirer: text(b.adquirente, "adquirente", 30) ?? bad("adquirente: escolha a adquirente.") } : { account_id: uuid(b.conta, "conta") }),
        mapping: mappingParam(b.colunas, kind) ?? bad("colunas: diga qual coluna é cada informação."), ...(b.ativo !== undefined ? { active: flag(b.ativo, "ativo") } : {}) });
    }
    case "erp.conciliacao.cartao": {
      const kind = q("tipo");
      const state = q("situacao");
      return { p_args: { ...(kind ? { kind: enumOf(kind, { venda: "sale", recebivel: "receivable", todos: "all" }, "tipo") } : {}),
        ...(state ? { state: enumOf(state, CARD_STATE_PARAM, "situacao") } : {}), ...(q("adquirente") ? { acquirer: text(q("adquirente"), "adquirente", 30) } : {}),
        from: date(q("de"), "de"), to: date(q("ate"), "ate"), search: text(q("busca"), "busca", 60), ...(flag(q("divergentes"), "divergentes") ? { divergent: true } : {}) } };
    }
    case "erp.conciliacao.cartao.candidatos":
      return { p_args: { line_id: uuid(params.id, "linha", true) } };
    case "erp.conciliacao.cartao.importar":
      return withCommand({ acquirer: text(b.adquirente, "adquirente", 30) ?? bad("adquirente: escolha a adquirente."),
        kind: b.tipo === "recebiveis" ? "receivables" : b.tipo === "vendas" ? "sales" : bad("tipo: use vendas ou recebiveis."), file_name: text(b.arquivo, "arquivo", 200),
        content: content(b.conteudo), layout_id: uuid(b.modelo, "modelo"), mapping: mappingParam(b.colunas, "card"), save_layout: saveLayout(b.salvar_modelo) });
    case "erp.conciliacao.cartao.acao": {
      const action = enumOf(b.acao, CARD_ACTION_PARAM, "acao");
      return withCommand({ action, line_id: uuid(params.id, "linha", true), expected_version: version(b.versao),
        ...(action === "match" ? { title_id: uuid(b.conta_receber, "conta_receber"), group_id: uuid(b.grupo, "grupo") } : {}),
        ...(action === "ignore" ? { reason: text(b.motivo, "motivo", 500) ?? bad("motivo: diga por que a linha fica de fora (de 3 a 500 caracteres).") } : {}) });
    }
    case "erp.conciliacao.cartao.lote": {
      const action = enumOf(b.acao, CARD_BATCH_PARAM, "acao");
      const min = integer(b.confianca_minima, "confianca_minima", 70, 100);
      return withCommand({ action, ...(action === "confirm_all" && min !== undefined ? { min_confidence: min } : {}) });
    }
    case "erp.conciliacao.cartao.receber": {
      if (!Array.isArray(b.linhas) || b.linhas.length < 1 || b.linhas.length > 200) bad("linhas: escolha de 1 a 200 linhas da adquirente.");
      return withCommand({ line_ids: (b.linhas as unknown[]).map((id) => uuid(id, "linhas", true)), account_id: uuid(b.conta, "conta", true), received_on: date(b.data, "data"),
        bank_line_id: uuid(b.linha_banco, "linha_banco"), ...(b.versao_linha_banco !== undefined ? { bank_line_version: version(b.versao_linha_banco, "versao_linha_banco") } : {}) });
    }
    case "erp.conciliacao.cartao.taxa": {
      const id = uuid(b.id, "id");
      return withCommand({ ...(id ? { id, expected_version: version(b.versao) } : {}), acquirer: text(b.adquirente, "adquirente", 30) ?? bad("adquirente: escolha a adquirente."),
        brand: typeof b.bandeira === "string" ? b.bandeira : bad("bandeira: escolha a bandeira."), product: enumOf(b.modalidade, { debito: "debit", credito: "credit" }, "modalidade"),
        installments_from: integer(b.parcelas_de, "parcelas_de", 1, 99) ?? 1, installments_to: integer(b.parcelas_ate, "parcelas_ate", 1, 99) ?? integer(b.parcelas_de, "parcelas_de", 1, 99) ?? 1,
        rate_bp: rateParam(b.taxa), fixed_cents: b.tarifa_fixa === undefined || b.tarifa_fixa === null || b.tarifa_fixa === "" ? "0" : cents(b.tarifa_fixa, "tarifa_fixa"),
        ...(integer(b.prazo, "prazo", 0, 400) !== undefined ? { settle_days: integer(b.prazo, "prazo", 0, 400) } : {}), ...(b.ativa !== undefined ? { active: flag(b.ativa, "ativa") } : {}) });
    }
  }
  return bad("Operação desconhecida.");
}
