// Multiempresa: a lógica que não depende do Worker. Cada empresa é um ERP
// (objeto erp: da área); aqui só se fala com ele por uma porta `ErpCall`, que
// chama um RPC do motor como a pessoa (o Worker usa localFetch; os testes, o
// motor SQLite local). Nada aqui lê ou grava fora das funções de domínio:
//
// - copiar cadastros: lê a origem pelas exportações e listas do ERP, compara
//   com o destino (produto pelo código, contato pelo CPF/CNPJ, os demais pelo
//   nome) e grava no destino só o que falta, pela importação existente
//   (erp_preferences_import_batch) e pelos cadastros de cada domínio
//   (categorias, formas de pagamento, categorias financeiras, naturezas,
//   listas de preços). O que já existe no destino fica como está.
// - consolidado: o resumo do Início de cada ERP (erp_home_overview), lado a lado.
//
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { COPY_KINDS, COPY_KIND_LABELS, IMPORT_BATCH, MAX_COPY_RECORDS, type CopyKind } from "./contract.ts";

/** Chama um RPC do motor de uma empresa como a pessoa (p_user_id é posto pela porta). */
export type ErpCall = (rpc: string, args?: Record<string, unknown>) => Promise<any>;

/** Erro conhecido da cópia, com o que fazer. */
export class CopyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------------------
// Normalização das chaves de comparação

/** Nome para comparar: sem acento, sem espaços repetidos, minúsculas. */
export const fold = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\s+/g, " ").trim().toLowerCase();
/** CPF/CNPJ (ou código) para comparar: só letras e números, minúsculas. */
export const compactKey = (value: unknown) => String(value ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase();

/** UUID estável a partir de um texto (formato v5), para comandos que se repetem sem duplicar. */
export async function stableUuid(...parts: string[]) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["wabotia-erp-multiempresa-v1", ...parts])))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Leitura de uma empresa

export interface Taxon { id: string; parent_id: string | null; name: string; path: string[] }
export interface ProductRow { code: string | null; name: string; category: string | null; category_path: string[] | null;
  group: string | null; group_path: string[] | null; data: Record<string, unknown> }
export interface PriceListRow { name: string; header: Record<string, unknown>; items: { code: string; price: string | null }[]; payment_methods: string[] }
export interface ContactRow { name: string; document: string | null; data: Record<string, unknown> }
export interface PaymentRow { description: string; data: Record<string, unknown> }
export interface FinanceCategoryRow { kind: "receivable" | "payable"; path: string[]; dre_group: string | null }
export interface NatureRow { description: string; direction: string; data: Record<string, unknown> | null; dropped_rules: number }

export interface Snapshot {
  categories?: Taxon[];
  groups?: Taxon[];
  products?: ProductRow[];
  priceLists?: PriceListRow[];
  contacts?: ContactRow[];
  paymentMethods?: PaymentRow[];
  financeCategories?: FinanceCategoryRow[];
  natures?: NatureRow[];
}

const PAGE = 250;
const tooMany = (kind: CopyKind, total: number): never => {
  throw new CopyError("erp_company_copy_too_many",
    `${COPY_KIND_LABELS[kind]}: a empresa de origem tem ${total} cadastros e a cópia leva até ${MAX_COPY_RECORDS} de cada vez. Copie os outros cadastros primeiro e, para este, use a exportação e a importação por planilha do ERP (Cadastros › Importar).`);
};

/** Lê uma lista paginada por offset até o total (com o teto da cópia). */
async function paged(kind: CopyKind, size: number, read: (offset: number) => Promise<{ items: any[]; total?: number }>) {
  const out: any[] = [];
  for (let offset = 0; ; offset += size) {
    const page = await read(offset);
    const total = Number(page.total ?? 0);
    if (total > MAX_COPY_RECORDS) tooMany(kind, total);
    out.push(...(page.items ?? []));
    if (!page.items?.length || out.length >= total) return out;
  }
}

function taxa(items: any[]): Taxon[] {
  const byId = new Map(items.map((t) => [String(t.id), t]));
  const path = (t: any, seen = new Set<string>()): string[] => {
    if (!t || seen.has(t.id)) return [];
    seen.add(t.id);
    return [...(t.parent_id ? path(byId.get(String(t.parent_id)), seen) : []), String(t.name)];
  };
  return items.map((t) => ({ id: String(t.id), parent_id: t.parent_id ?? null, name: String(t.name), path: path(t) }));
}

/** Campos da exportação que não são do cadastro (ids, vínculos com outros registros da empresa, estado). */
const PRODUCT_DROP = new Set(["id", "active", "version", "created_at", "updated_at", "tag_ids", "custom_values", "deleted_at", "category", "product_group",
  "tags", "images", "supplier", "stock", "source_id", "category_id", "product_group_id", "cost_price"]);
const CONTACT_DROP = new Set(["id", "entity", "active", "version", "created_at", "updated_at", "finance_category_name", "operation_nature_name", "seller_name",
  "seller_record_id", "updated_by_name", "finance_category_id", "operation_nature_id", "seller_id", "code"]);
const clean = (row: Record<string, unknown>, drop: Set<string>) =>
  Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== null && value !== undefined && !drop.has(key)));
const PAYMENT_KEYS = ["description", "payment_type", "condition", "destination", "account_id", "business_days", "applicable", "interest_rate", "fine_rate",
  "card_brand", "card_integration", "card_cnpj", "auto_settle", "pix_integration", "pix_cnpj", "fee_type", "fee_rate", "fee_fixed", "settlement_days"];
const NATURE_KEYS = ["description", "series", "direction", "crt", "presence", "invoiced", "final_consumer", "return_operation", "update_last_purchase_price",
  "include_freight_ipi_base", "others", "retentions", "additional_info", "fiscal_info"];

/**
 * Lê os cadastros de uma empresa. `detail`: também o que só a origem precisa
 * (regras das naturezas e itens das listas de preços).
 */
export async function readSnapshot(call: ErpCall, kinds: readonly CopyKind[], detail: boolean): Promise<Snapshot> {
  const snap: Snapshot = {};
  if (kinds.includes("produtos")) {
    snap.categories = taxa((await call("erp_catalog_taxonomy_list", { p_kind: "categories" })).items ?? []);
    snap.groups = taxa((await call("erp_catalog_taxonomy_list", { p_kind: "product_groups" })).items ?? []);
    const categoryPath = new Map(snap.categories.map((t) => [t.id, t.path]));
    const groupPath = new Map(snap.groups.map((t) => [t.id, t.path]));
    const rows = await paged("produtos", PAGE, (offset) => call("erp_catalog_product_export_v2", { p_offset: offset, p_limit: PAGE }));
    snap.products = rows.map((row) => ({
      code: row.code ? String(row.code) : null, name: String(row.name ?? ""),
      category: row.category ?? null, category_path: row.category_id ? categoryPath.get(String(row.category_id)) ?? null : null,
      group: row.product_group ?? null, group_path: row.product_group_id ? groupPath.get(String(row.product_group_id)) ?? null : null,
      data: clean(row, PRODUCT_DROP),
    }));
    const lists = (await call("erp_pricing_lists", {})).items ?? [];
    snap.priceLists = [];
    for (const list of lists) {
      if (!detail) { snap.priceLists.push({ name: String(list.name), header: list, items: [], payment_methods: [] }); continue; }
      const items: { code: string; price: string | null }[] = [];
      let header: Record<string, unknown> = list;
      for (let offset = 0; offset < MAX_COPY_RECORDS; offset += 100) {
        const page = await call("erp_pricing_list_get", { p_id: list.id, p_offset: offset, p_limit: 100 });
        header = page.list ?? header;
        for (const item of page.items ?? []) if (item.code) items.push({ code: String(item.code), price: item.custom_price ?? null });
        if (!page.items?.length || offset + 100 >= Number(page.total ?? 0)) break;
      }
      const methods = Array.isArray(header.payment_methods) ? (header.payment_methods as any[]).map((m) => String(m.name)) : [];
      snap.priceLists.push({ name: String(list.name), header, items, payment_methods: methods });
    }
  }
  if (kinds.includes("contatos")) {
    const rows = await paged("contatos", 100, (offset) => call("erp_catalog_contact_export", { p_offset: offset, p_limit: 100 }));
    snap.contacts = rows.map((row) => ({ name: String(row.name ?? ""), document: row.document ? String(row.document) : null, data: clean(row, CONTACT_DROP) }));
  }
  if (kinds.includes("formas_pagamento")) {
    const rows: any[] = [];
    for (let page = 1; page <= 50; page++) {
      const out = await call("erp_catalog_payment_method_page", { p_page: page, p_size: 100 });
      rows.push(...(out.items ?? []));
      if (!out.items?.length || rows.length >= Number(out.total ?? 0)) break;
    }
    snap.paymentMethods = rows.map((row) => ({ description: String(row.description),
      data: { ...Object.fromEntries(PAYMENT_KEYS.map((key) => [key, row[key] ?? null])), account_id: null } }));
  }
  if (kinds.includes("categorias_financeiras")) {
    snap.financeCategories = [];
    for (const kind of ["receivable", "payable"] as const) {
      const items = ((await call("erp_finance_category_tree", { p_kind: kind })).items ?? []).filter((c: any) => c.active !== false);
      for (const t of taxa(items)) snap.financeCategories.push({ kind, path: t.path, dre_group: items.find((c: any) => String(c.id) === t.id)?.dre_group ?? null });
    }
  }
  if (kinds.includes("naturezas")) {
    const rows: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const out = await call("erp_fiscal_nature_list", { p_page: page, p_limit: 100 });
      rows.push(...(out.items ?? []));
      if (!out.items?.length || rows.length >= Number(out.total_count ?? 0)) break;
    }
    snap.natures = [];
    for (const row of rows) {
      if (!detail) { snap.natures.push({ description: String(row.description), direction: String(row.direction), data: null, dropped_rules: 0 }); continue; }
      const nature = (await call("erp_fiscal_nature_get", { p_id: row.id })).nature;
      const rules = (nature.rules ?? []) as any[];
      // Regras por produto ou grupo citam cadastros desta empresa: ficam de fora (as gerais e por NCM vão).
      const kept = rules.filter((r) => r.product_scope === "any" || r.product_scope === "ncm").map((r) => ({
        tax: r.tax, destinations: r.destinations ?? [], product_scope: r.product_scope, ncms: r.ncms ?? [], product_ids: [],
        data: r.data ?? {}, additional_info: r.additional_info ?? null, fiscal_info: r.fiscal_info ?? null,
      }));
      snap.natures.push({ description: String(nature.description), direction: String(nature.direction),
        data: { ...Object.fromEntries(NATURE_KEYS.map((key) => [key, nature[key] ?? null])), rules: kept }, dropped_rules: rules.length - kept.length });
    }
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Prévia (o plano): pura, sem chamadas

export interface Skipped { nome: string; motivo: string }
export interface KindPlan {
  cadastro: CopyKind;
  titulo: string;
  /** Cadastros que vão ser criados no destino. */
  novos: number;
  /** Os primeiros nomes dos novos (para a tela). */
  amostra: string[];
  /** Já existem no destino e ficam como estão. */
  existentes: number;
  ignorados: Skipped[];
  /** Produtos: categorias e listas de preços que vêm junto. */
  categorias_novas?: number;
  listas_novas?: number;
  listas_existentes?: number;
  avisos: string[];
}
export interface CopyPlan { kinds: KindPlan[]; work: CopyWork }
/** O que gravar (interno à cópia). */
export interface CopyWork {
  categories: Taxon[]; groups: Taxon[]; products: ProductRow[]; priceLists: PriceListRow[];
  contacts: ContactRow[]; paymentMethods: PaymentRow[]; financeCategories: FinanceCategoryRow[]; natures: NatureRow[];
}

const SAMPLE = 30;
const pathKey = (path: string[]) => path.map(fold).join(" › ");

/** Compara origem e destino e diz o que a cópia faria. */
export function planCopy(kinds: readonly CopyKind[], source: Snapshot, target: Snapshot): CopyPlan {
  const work: CopyWork = { categories: [], groups: [], products: [], priceLists: [], contacts: [], paymentMethods: [], financeCategories: [], natures: [] };
  const plans: KindPlan[] = [];
  const base = (kind: CopyKind): KindPlan => ({ cadastro: kind, titulo: COPY_KIND_LABELS[kind], novos: 0, amostra: [], existentes: 0, ignorados: [], avisos: [] });
  const add = (plan: KindPlan, name: string) => { plan.novos++; if (plan.amostra.length < SAMPLE) plan.amostra.push(name); };
  for (const kind of COPY_KINDS.filter((k) => kinds.includes(k))) {
    const plan = base(kind);
    if (kind === "produtos") {
      // Categorias e grupos: pelo caminho (pai › filho), criadas do pai para o filho.
      for (const [from, to, list] of [[source.categories, target.categories, work.categories], [source.groups, target.groups, work.groups]] as const) {
        const have = new Set((to ?? []).map((t) => pathKey(t.path)));
        for (const t of [...(from ?? [])].sort((a, b) => a.path.length - b.path.length))
          if (!have.has(pathKey(t.path))) { have.add(pathKey(t.path)); list.push(t); }
      }
      plan.categorias_novas = work.categories.length + work.groups.length;
      const codes = new Set((target.products ?? []).map((p) => compactKey(p.code)).filter(Boolean));
      const seen = new Set<string>();
      for (const p of source.products ?? []) {
        const key = compactKey(p.code);
        if (!key) { plan.ignorados.push({ nome: p.name, motivo: "Produto sem código: dê um código a ele na empresa de origem para copiar sem duplicar." }); continue; }
        if (codes.has(key)) { plan.existentes++; continue; }
        if (seen.has(key)) { plan.ignorados.push({ nome: `${p.code} · ${p.name}`, motivo: "Código repetido na empresa de origem: só o primeiro vai." }); continue; }
        seen.add(key);
        work.products.push(p);
        add(plan, `${p.code} · ${p.name}`);
      }
      const lists = new Set((target.priceLists ?? []).map((l) => fold(l.name)));
      plan.listas_novas = 0;
      plan.listas_existentes = 0;
      for (const list of source.priceLists ?? []) {
        if (lists.has(fold(list.name))) { plan.listas_existentes++; continue; }
        const category = String(list.header.category ?? "other");
        if (category === "contact" || category === "seller") {
          plan.ignorados.push({ nome: `Lista de preços ${list.name}`, motivo: category === "contact"
            ? "Lista ligada a clientes: os clientes são outros cadastros na outra empresa. Crie a lista lá e escolha os clientes."
            : "Lista ligada a vendedores: os vendedores são outros cadastros na outra empresa. Crie a lista lá e escolha os vendedores." });
          continue;
        }
        plan.listas_novas++;
        work.priceLists.push(list);
      }
      if (work.priceLists.some((l) => l.payment_methods.length))
        plan.avisos.push("Listas por forma de pagamento: as formas são ligadas pelo nome; copie também as formas de pagamento para elas virem junto.");
    } else if (kind === "contatos") {
      const docs = new Set((target.contacts ?? []).map((c) => compactKey(c.document)).filter(Boolean));
      const seen = new Set<string>();
      for (const c of source.contacts ?? []) {
        const key = compactKey(c.document);
        if (!key) { plan.ignorados.push({ nome: c.name, motivo: "Contato sem CPF/CNPJ: não dá para conferir se já existe. Cadastre-o à mão na outra empresa, se precisar." }); continue; }
        if (docs.has(key)) { plan.existentes++; continue; }
        if (seen.has(key)) { plan.ignorados.push({ nome: c.name, motivo: "CPF/CNPJ repetido na empresa de origem: só o primeiro vai." }); continue; }
        seen.add(key);
        work.contacts.push(c);
        add(plan, c.name);
      }
    } else if (kind === "formas_pagamento") {
      const have = new Set((target.paymentMethods ?? []).map((m) => fold(m.description)));
      for (const m of source.paymentMethods ?? []) {
        if (have.has(fold(m.description))) { plan.existentes++; continue; }
        have.add(fold(m.description));
        work.paymentMethods.push(m);
        add(plan, m.description);
      }
      if (work.paymentMethods.some((m) => m.data.destination === "contas"))
        plan.avisos.push("As formas de pagamento chegam sem a conta bancária ou caixa: escolha a conta de cada uma na outra empresa.");
    } else if (kind === "categorias_financeiras") {
      const have = new Set((target.financeCategories ?? []).map((c) => `${c.kind}:${pathKey(c.path)}`));
      for (const c of [...(source.financeCategories ?? [])].sort((a, b) => a.path.length - b.path.length)) {
        const key = `${c.kind}:${pathKey(c.path)}`;
        if (have.has(key)) { plan.existentes++; continue; }
        have.add(key);
        work.financeCategories.push(c);
        add(plan, `${c.kind === "receivable" ? "Receitas" : "Despesas"} › ${c.path.join(" › ")}`);
      }
    } else if (kind === "naturezas") {
      const have = new Set((target.natures ?? []).map((n) => `${n.direction}:${fold(n.description)}`));
      for (const n of source.natures ?? []) {
        const key = `${n.direction}:${fold(n.description)}`;
        if (have.has(key)) { plan.existentes++; continue; }
        have.add(key);
        work.natures.push(n);
        add(plan, n.description);
      }
      const dropped = work.natures.filter((n) => n.dropped_rules > 0).length;
      if (dropped) plan.avisos.push(`${dropped} natureza(s) têm regras por produto ou grupo: essas regras não vão (os produtos são outros na outra empresa); as regras gerais e por NCM vão.`);
    }
    plans.push(plan);
  }
  return { kinds: plans, work };
}

// ---------------------------------------------------------------------------
// Cópia

export interface KindResult {
  cadastro: CopyKind;
  titulo: string;
  criados: number;
  ja_existiam: number;
  recusados: Skipped[];
  ignorados: Skipped[];
  categorias_criadas?: number;
  listas_criadas?: number;
}

/** Motivo de recusa de uma linha da importação, em palavras de quem usa. */
export function importReasonText(reason: string | null | undefined): string {
  const r = String(reason ?? "");
  const field = r.includes(":") ? r.split(":")[1] : "";
  const fields: Record<string, string> = { category: "a categoria", product_group: "o grupo", document: "o CPF/CNPJ", code: "o código", name: "o nome",
    price: "o preço", unit: "a unidade", ncm: "o NCM", gtin: "o GTIN", email: "o e-mail", state: "a UF", postal_code: "o CEP", ie: "a inscrição estadual" };
  if (r === "erp_preferences_import_denied" || r.endsWith("_denied") || r.endsWith("_forbidden"))
    return "Só o administrador do ERP da empresa de destino grava estes cadastros. Peça ao administrador em Gestão › Pessoas e acessos.";
  if (r.startsWith("erp_preferences_import_ambiguous")) return `Há mais de um cadastro com ${fields[field] ?? "este dado"} na empresa de destino. Deixe só um e copie de novo.`;
  if (r.startsWith("erp_preferences_import_not_found")) return `Não achei ${fields[field] ?? "um dado ligado a este cadastro"} na empresa de destino. Confira e copie de novo.`;
  if (r === "erp_preferences_import_duplicate" || r.includes("duplicate")) return "Já existe um cadastro igual na empresa de destino. Confira lá.";
  if (field && fields[field]) return `Confira ${fields[field]} deste cadastro na empresa de origem.`;
  return "O ERP de destino recusou este cadastro. Confira os dados dele na empresa de origem e copie de novo.";
}

const failText = (error: unknown) => error instanceof CopyError ? error.message : importReasonText((error as any)?.reason ?? (error as any)?.message);

/**
 * Grava no destino o que o plano manda, na ordem: formas de pagamento,
 * categorias financeiras, naturezas, categorias de produto, produtos,
 * contatos e as listas de preços. `command`: o identificador do pedido; os
 * comandos de cada gravação derivam dele (repetir a mesma cópia não duplica).
 */
export async function applyCopy(call: ErpCall, plan: CopyPlan, command: string, fileName: string): Promise<KindResult[]> {
  const { work } = plan;
  const results: KindResult[] = [];
  const result = (kind: KindPlan): KindResult => ({ cadastro: kind.cadastro, titulo: kind.titulo, criados: 0, ja_existiam: kind.existentes, recusados: [], ignorados: kind.ignorados });
  const id = (...parts: string[]) => stableUuid(command, ...parts);
  const file = fileName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Cópia de outra empresa";
  for (const kind of plan.kinds) {
    const out = result(kind);
    if (kind.cadastro === "formas_pagamento") {
      for (const m of work.paymentMethods) {
        try {
          await call("erp_catalog_payment_method_save", { p_id: null, p_expected_version: 0, p_command_id: await id("pagamento", fold(m.description)), p_data: m.data });
          out.criados++;
        } catch (error) { out.recusados.push({ nome: m.description, motivo: failText(error) }); }
      }
    } else if (kind.cadastro === "categorias_financeiras") {
      // Do pai para o filho: o id do pai vem da árvore do destino, relida por tipo.
      for (const k of ["receivable", "payable"] as const) {
        const mine = work.financeCategories.filter((c) => c.kind === k);
        if (!mine.length) continue;
        const ids = new Map(taxa((await call("erp_finance_category_tree", { p_kind: k })).items ?? []).map((t) => [pathKey(t.path), t.id]));
        for (const c of mine) {
          const parent = c.path.length > 1 ? ids.get(pathKey(c.path.slice(0, -1))) ?? null : null;
          const name = c.path.join(" › ");
          if (c.path.length > 1 && !parent) { out.recusados.push({ nome: name, motivo: "A categoria de cima não existe no destino. Copie de novo depois de conferir." }); continue; }
          try {
            const saved = await call("erp_finance_category_execute", { p_command_id: await id("categoria_financeira", k, pathKey(c.path)), p_action: "category_create",
              p_data: { kind: k, parent_id: parent, name: c.path.at(-1), ...(c.path.length === 1 && c.dre_group ? { dre_group: c.dre_group } : {}) } });
            ids.set(pathKey(c.path), String(saved.record.id));
            out.criados++;
          } catch (error) { out.recusados.push({ nome: name, motivo: failText(error) }); }
        }
      }
    } else if (kind.cadastro === "naturezas") {
      for (const n of work.natures) {
        try {
          await call("erp_fiscal_nature_execute", { p_command_id: await id("natureza", n.direction, fold(n.description)), p_action: "create", p_data: { nature: n.data } });
          out.criados++;
        } catch (error) { out.recusados.push({ nome: n.description, motivo: failText(error) }); }
      }
    } else if (kind.cadastro === "produtos") {
      out.categorias_criadas = 0;
      out.listas_criadas = 0;
      for (const [taxonomy, list] of [["categories", work.categories], ["product_groups", work.groups]] as const) {
        if (!list.length) continue;
        const ids = new Map(taxa((await call("erp_catalog_taxonomy_list", { p_kind: taxonomy })).items ?? []).map((t) => [pathKey(t.path), t.id]));
        for (const t of list) {
          const parent = t.path.length > 1 ? ids.get(pathKey(t.path.slice(0, -1))) ?? null : null;
          try {
            const saved = await call("erp_catalog_taxonomy_save", { p_kind: taxonomy, p_id: null, p_expected_version: 0, p_command_id: await id(taxonomy, pathKey(t.path)),
              p_data: { name: t.name, ...(parent ? { parent_id: parent } : {}) } });
            ids.set(pathKey(t.path), String(saved.item.id));
            out.categorias_criadas = (out.categorias_criadas ?? 0) + 1;
          } catch (error) { out.recusados.push({ nome: `${taxonomy === "categories" ? "Categoria" : "Grupo"} ${t.path.join(" › ")}`, motivo: failText(error) }); }
        }
      }
      const rows = work.products.map((p) => ({ ...p.data, ...(p.category ? { category: p.category } : {}), ...(p.group ? { product_group: p.group } : {}) }));
      await importRows(call, "produtos", "products", rows, work.products.map((p) => `${p.code} · ${p.name}`), command, file, out);
      // Listas de preços: o cabeçalho pelo cadastro das listas e os produtos pela planilha da lista (código e preço).
      const methods = work.priceLists.some((l) => l.payment_methods.length)
        ? new Map(((await call("erp_catalog_payment_method_page", { p_page: 1, p_size: 100 })).items ?? []).map((m: any) => [fold(m.description), String(m.id)]))
        : new Map<string, string>();
      for (const list of work.priceLists) {
        const h = list.header;
        const linked = list.payment_methods.map((name) => methods.get(fold(name))).filter((x): x is string => !!x);
        if (h.category === "payment_method" && !linked.length) {
          out.recusados.push({ nome: `Lista de preços ${list.name}`, motivo: "Nenhuma das formas de pagamento desta lista existe na empresa de destino. Copie as formas de pagamento antes." });
          continue;
        }
        try {
          const saved = await call("erp_pricing_list_save", { p_id: null, p_expected_version: 0, p_command_id: await id("lista", fold(list.name)), p_data: {
            name: list.name, category: h.category, list_type: h.list_type, factor: h.factor ?? null, factor_unit: h.factor_unit, direction: h.direction,
            considers_datetime: !!h.considers_datetime, starts_on: h.starts_on ?? null, ends_on: h.ends_on ?? null, start_time: h.start_time ?? null, end_time: h.end_time ?? null,
            contacts: [], regions: Array.isArray(h.regions) ? h.regions : [], ...(h.category === "payment_method" ? { payment_methods: linked } : {}),
          } });
          let version = Number(saved.list.version);
          for (let start = 0; start < list.items.length; start += 500) {
            const chunk = list.items.slice(start, start + 500).map((item) => item.price === null ? { code: item.code } : { code: item.code, price: item.price });
            const imported = await call("erp_pricing_list_import", { p_id: saved.list.id, p_expected_version: version, p_command_id: await id("lista_itens", fold(list.name), String(start)), p_rows: chunk });
            version = Number(imported.list?.version ?? version + 1);
          }
          out.listas_criadas = (out.listas_criadas ?? 0) + 1;
        } catch (error) { out.recusados.push({ nome: `Lista de preços ${list.name}`, motivo: failText(error) }); }
      }
    } else if (kind.cadastro === "contatos") {
      await importRows(call, "contatos", "contacts", work.contacts.map((c) => c.data), work.contacts.map((c) => c.name), command, file, out);
    }
    results.push(out);
  }
  return results;
}

/** Grava pela importação existente, em lotes de 50 linhas de um mesmo lote de importação. */
async function importRows(call: ErpCall, kind: CopyKind, importKind: string, rows: Record<string, unknown>[], names: string[], command: string, file: string, out: KindResult) {
  if (!rows.length) return;
  const job = await stableUuid(command, kind, "job");
  for (let start = 0; start < rows.length; start += IMPORT_BATCH) {
    const batch = rows.slice(start, start + IMPORT_BATCH).map((data, index) => ({ row: start + index + 2, lines: [start + index + 2], data }));
    let items: any[];
    try {
      items = (await call("erp_preferences_import_batch", { p_command_id: await stableUuid(command, kind, "lote", String(start)), p_job_id: job, p_kind: importKind,
        p_file_name: file, p_total_rows: rows.length, p_dry_run: false, p_rows: batch })).items ?? [];
    } catch (error) {
      for (let i = start; i < Math.min(rows.length, start + IMPORT_BATCH); i++) out.recusados.push({ nome: names[i], motivo: failText(error) });
      continue;
    }
    for (const item of items) {
      const name = names[Number(item.row) - 2] ?? `Linha ${item.row}`;
      if (item.status === "created") out.criados++;
      else if (item.status === "updated" || item.status === "unchanged") out.ja_existiam++;
      else out.recusados.push({ nome: name, motivo: importReasonText(item.reason) });
    }
  }
}

// ---------------------------------------------------------------------------
// Consolidado

export interface CompanySummary {
  vendas: { pedidos: number; total_centavos: string } | null;
  receber: { aberto_centavos: string; vencido_centavos: string; contas: number } | null;
  pagar: { aberto_centavos: string; vencido_centavos: string; contas: number } | null;
  saldo_contas_centavos: string | null;
  partes_desligadas: string[];
}

/** Resumo de uma empresa a partir do Início do ERP (erp_home_overview). */
export function summaryOf(overview: any): CompanySummary {
  const sales = overview?.period?.sales;
  const vendas = sales ? (() => {
    const kept = (sales.statuses ?? []).filter((s: any) => s.status !== "cancelled");
    return { pedidos: kept.reduce((n: number, s: any) => n + Number(s.count ?? 0), 0), total_centavos: kept.reduce((n: bigint, s: any) => n + BigInt(s.total_cents ?? 0), 0n).toString() };
  })() : null;
  const titles = overview?.finance?.titles as any[] | undefined;
  const side = (kind: string) => {
    const t = titles?.find((x) => x.kind === kind);
    if (!t) return null;
    const buckets = t.buckets as any[];
    return {
      aberto_centavos: buckets.reduce((n: bigint, b: any) => n + BigInt(b.balance_cents ?? 0), 0n).toString(),
      vencido_centavos: String(buckets.find((b) => b.bucket === "overdue")?.balance_cents ?? "0"),
      contas: buckets.reduce((n: number, b: any) => n + Number(b.count ?? 0), 0),
    };
  };
  const balance = overview?.finance?.accounts?.recorded_balance_cents;
  const off = overview?.unavailable_parts;
  return { vendas, receber: side("receivable"), pagar: side("payable"), saldo_contas_centavos: balance === undefined || balance === null ? null : String(balance),
    partes_desligadas: Array.isArray(off) ? off.map(String) : [] };
}

/** Soma das empresas (só o que todas mostram; o que falta numa fica de fora da soma e é avisado). */
export function totalOf(rows: (CompanySummary | null)[]) {
  const ok = rows.filter((r): r is CompanySummary => r !== null);
  const sum = (pick: (r: CompanySummary) => string | null | undefined) => ok.reduce((n, r) => n + BigInt(pick(r) ?? 0), 0n).toString();
  return {
    vendas_centavos: sum((r) => r.vendas?.total_centavos),
    pedidos: ok.reduce((n, r) => n + (r.vendas?.pedidos ?? 0), 0),
    receber_centavos: sum((r) => r.receber?.aberto_centavos),
    receber_vencido_centavos: sum((r) => r.receber?.vencido_centavos),
    pagar_centavos: sum((r) => r.pagar?.aberto_centavos),
    pagar_vencido_centavos: sum((r) => r.pagar?.vencido_centavos),
    saldo_contas_centavos: sum((r) => r.saldo_contas_centavos),
    incompleto: ok.length !== rows.length || ok.some((r) => !r.vendas || !r.receber || !r.pagar || r.saldo_contas_centavos === null),
  };
}

/** Lista de cadastros pedida (texto separado por vírgula ou lista) → tipos conhecidos, sem repetição. */
export function copyKindsOf(value: unknown): CopyKind[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const kinds = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  if (!kinds.length || kinds.some((k) => !(COPY_KINDS as readonly string[]).includes(k)))
    throw new CopyError("erp_company_copy_kinds", `Escolha o que copiar: ${COPY_KINDS.join(", ")}.`);
  return kinds as CopyKind[];
}
