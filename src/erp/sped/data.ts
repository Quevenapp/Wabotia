// O que os arquivos leem do objeto da área, só leitura: a empresa (dados,
// regime e complementares), a configuração dos arquivos, os produtos e
// contatos citados, o inventário do Estoque num dia e a conferência antes de
// gerar (o que falta, em palavras, com o atalho para corrigir).
// Esquema sem a tabela (versão antiga ou parte que não existe): lê vazio.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import type { SqlDriver } from "../engine/driver.ts";
import { regimeNotice, SPED_KIND_LABELS, SPED_SCREEN, type SpedKind, type SpedProblem } from "./contract.ts";
import { unscaled } from "./format.ts";
import type { SpedCompany, SpedInventoryItem, SpedSettings } from "./model.ts";
import { settingsOf, validCpf } from "./settings.ts";

export const T_SETTINGS = "erp_sped__settings";
const parse = (v: unknown): Record<string, unknown> => { try { const o = JSON.parse(String(v ?? "{}")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
function rows(db: SqlDriver, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  try { return db.exec(sql, ...params).rows; } catch { return []; }
}

export function readSpedSettings(db: SqlDriver): SpedSettings {
  return settingsOf(parse(rows(db, `SELECT data FROM "${T_SETTINGS}" WHERE id=1`)[0]?.data));
}
export function saveSpedSettings(db: SqlDriver, settings: SpedSettings, actor: string, now: number): void {
  db.exec(`INSERT INTO "${T_SETTINGS}"(id, version, data, updated_at, updated_by) VALUES(1, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version=version+1, data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  JSON.stringify(settings), now, actor);
}

/** A empresa, ou null sem os dados cadastrados. */
export function readCompany(db: SqlDriver): SpedCompany | null {
  const identity = parse(rows(db, 'SELECT data FROM "erp_company__identity" WHERE singleton=1')[0]?.data);
  if (!str(identity.cnpj)) return null;
  const extra = parse(rows(db, 'SELECT data FROM "erp_company__extra" WHERE singleton=1')[0]?.data);
  const crt = rows(db, 'SELECT crt FROM "erp_company__fiscal" WHERE singleton=1')[0]?.crt;
  return {
    name: str(identity.legal_name) ?? "", trade_name: str(identity.trade_name), cnpj: String(identity.cnpj).replace(/[^0-9A-Z]/gi, "").toUpperCase(),
    ie: extra.ie_exempt === true ? null : str(identity.ie), im: str(extra.municipal_registration), uf: str(identity.state) ?? "", city: str(identity.city) ?? "",
    city_code: str(identity.municipality_code) ?? "", postal_code: str(identity.postal_code) ?? "", street: str(identity.street) ?? "", number: str(identity.number) ?? "S/N",
    complement: str(identity.complement), district: str(identity.district) ?? "", phone: str(identity.phone), email: str(identity.email), suframa: str(extra.suframa),
    crt: crt == null ? null : String(crt), cnae: str(extra.cnae),
  };
}
/** A empresa é isenta de IE (cadastro complementar). */
const ieExempt = (db: SqlDriver) => parse(rows(db, 'SELECT data FROM "erp_company__extra" WHERE singleton=1')[0]?.data).ie_exempt === true;

export interface ProductInfo { id: string; code: string; name: string; description: string; unit: string | null; ncm: string | null; gtin: string | null; cest: string | null }
/** Código do produto no arquivo: o código do cadastro, ou o começo do id. */
export const productCode = (id: string, code: unknown) => (str(code) ?? `ID-${id.replace(/-/g, "").slice(0, 12)}`).slice(0, 60);

export function readProducts(db: SqlDriver, ids: readonly string[]): Map<string, ProductInfo> {
  const out = new Map<string, ProductInfo>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const r of rows(db, `SELECT r.id, r.code, r.name, p.description, p.unit, p.ncm, p.gtin, p.gtin_tax, p.cest
        FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id IN (SELECT value FROM json_each(?))`, JSON.stringify(chunk))) {
      const id = String(r.id);
      const gtin = [r.gtin_tax, r.gtin].map(str).find((g) => g && /^\d{8,14}$/.test(g)) ?? null;
      out.set(id, { id, code: productCode(id, r.code), name: str(r.name) ?? "Produto", description: str(r.name) ?? str(r.description) ?? "Produto",
        unit: str(r.unit), ncm: str(r.ncm)?.replace(/\D/g, "") || null, gtin, cest: str(r.cest)?.replace(/\D/g, "") || null });
    }
  }
  return out;
}

/** Inventário num dia: a soma dos lançamentos do Estoque até o dia, por produto, com o custo médio. */
export async function readInventory(db: SqlDriver, day: string): Promise<SpedInventoryItem[]> {
  const balances = rows(db, `SELECT e.product_id, CAST(sum(e.quantity) AS TEXT) AS q FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
    WHERE m.occurred_on<=? GROUP BY e.product_id HAVING sum(e.quantity)>0 ORDER BY e.product_id`, day);
  if (!balances.length) return [];
  const ids = balances.map((r) => String(r.product_id));
  const products = readProducts(db, ids);
  let costs = new Map<string, bigint | null>();
  try { const { averageCosts } = await import("../domains/stock/costs.ts"); costs = averageCosts(db, ids); } catch { /* sem custo médio: valor zero */ }
  return balances.map((r) => {
    const id = String(r.product_id), p = products.get(id);
    const qty = BigInt(String(r.q)); // escala 6
    const cost = costs.get(id) ?? 0n; // escala 10
    // valor = qtd (6) × custo (10) = escala 16 → centavos (2): ÷ 10^14, arredondado.
    const raw = qty * cost, cents = Number((raw + 50_000_000_000_000n) / 100_000_000_000_000n);
    return { product_id: id, code: p?.code ?? productCode(id, null), description: p?.name ?? "Produto", unit: p?.unit ?? null, ncm: p?.ncm ?? null, gtin: p?.gtin ?? null,
      qty: unscaled(qty, 6), unit_cost: unscaled(cost, 10), amount: cents };
  });
}

/** Linhas das entradas do período ligadas a produto (para a conferência e o 0200). */
export function entryProducts(db: SqlDriver, environment: string, from: string, to: string): string[] {
  const ids = new Set<string>();
  for (const r of rows(db, `SELECT e.snapshot FROM erp_purchase_inbound__entry e JOIN erp_purchase_inbound__note n ON n.id=e.note_id
      WHERE e.state='active' AND n.environment=? AND coalesce(json_extract(e.result,'$.day'), n.issued_on) BETWEEN ? AND ?`, environment, from, to)) {
    const snap = parse(r.snapshot);
    for (const line of Array.isArray(snap.lines) ? snap.lines : []) if (line && typeof line.product_id === "string") ids.add(line.product_id);
  }
  return [...ids];
}

const link = { company: "/empresa-configuracoes", config: `${SPED_SCREEN}?aba=configuracao`, received: "/notas-recebidas-compras",
  product: (id: string) => `/cadastros-reais?cadastro=products&registro=${encodeURIComponent(id)}`,
  contact: (id: string) => `/cadastros-reais?cadastro=contacts&registro=${encodeURIComponent(id)}` };

/**
 * Conferência antes de gerar: o que falta nos cadastros para o arquivo do
 * tipo pedido. Bloqueante impede o arquivo; o resto é atenção.
 */
export async function conference(db: SqlDriver, input: { kind: SpedKind; environment: string; from: string; to: string; inventory: string | null; settings?: SpedSettings }):
Promise<{ problems: SpedProblem[]; notice: string | null; crt: string | null }> {
  const problems: SpedProblem[] = [];
  const add = (p: SpedProblem) => { if (problems.length < 200) problems.push(p); };
  const company = readCompany(db);
  const settings = input.settings ?? readSpedSettings(db);
  const label = SPED_KIND_LABELS[input.kind];
  if (!company) {
    add({ kind: "empresa", blocking: true, link: link.company, message: "Os dados da empresa (razão social, CNPJ e endereço) não estão cadastrados. Preencha em Empresa › Dados da empresa." });
    return { problems, notice: regimeNotice(input.kind, null), crt: null };
  }
  if (company.cnpj.length !== 14) add({ kind: "empresa", blocking: true, link: link.company, message: "O arquivo é de empresa com CNPJ (14 posições). Confira o CNPJ em Empresa › Dados da empresa." });
  if (input.kind !== "efd_contribuicoes" && !company.ie && !ieExempt(db))
    add({ kind: "empresa", blocking: true, link: link.company, message: `Falta a inscrição estadual (IE) da empresa, que o ${label} pede. Preencha em Empresa › Dados da empresa (ou marque que a empresa é isenta).` });
  if (!/^\d{7}$/.test(company.city_code)) add({ kind: "empresa", blocking: true, link: link.company, message: "Falta o código do município (IBGE) da empresa. Confira o endereço em Empresa › Dados da empresa." });
  if (!company.crt) add({ kind: "empresa", blocking: false, link: link.company, message: "O regime da empresa (CRT) não está informado: o arquivo sai, mas confira em Empresa › Dados fiscais." });
  if (input.kind !== "sintegra") {
    const a = settings.accountant;
    const missing = [!a.name && "nome", !validCpf(a.cpf) && "CPF", !a.crc && "CRC", !a.email && "e-mail"].filter(Boolean) as string[];
    if (missing.length) add({ kind: "contador", blocking: true, link: link.config,
      message: `O registro do contador (0100) pede ${missing.join(", ")} do contador. Preencha em Obrigações em arquivo › Configuração.` });
  }
  if (input.environment === "homologacao") add({ kind: "configuracao", blocking: false, link: null, message: "Ambiente de homologação: as notas de teste não têm valor fiscal. Use produção para o arquivo do contador." });

  // Notas recebidas com entrada no período: XML guardado e fornecedor com documento.
  const entries = rows(db, `SELECT n.id, n.number, n.access_key, n.xml_key, n.emitter_name, n.emitter_document, e.supplier_id, e.snapshot,
      coalesce(json_extract(e.result,'$.day'), n.issued_on) AS day
    FROM erp_purchase_inbound__entry e JOIN erp_purchase_inbound__note n ON n.id=e.note_id
    WHERE e.state='active' AND n.environment=? AND n.situation='autorizada' AND coalesce(json_extract(e.result,'$.day'), n.issued_on) BETWEEN ? AND ? ORDER BY day LIMIT 2000`,
  input.environment, input.from, input.to);
  for (const n of entries) {
    if (!n.xml_key) add({ kind: "nota", blocking: true, link: link.received,
      message: `A nota recebida nº ${n.number ?? "?"} de ${String(n.emitter_name ?? "fornecedor")} entrou sem o XML: sem ele o arquivo não tem os itens. Importe o XML em Compras › Notas recebidas.` });
    if (!String(n.emitter_document ?? "").replace(/\D/g, "")) add({ kind: "participante", blocking: true, link: n.supplier_id ? link.contact(String(n.supplier_id)) : link.received,
      message: `O fornecedor da nota recebida nº ${n.number ?? "?"} está sem CPF ou CNPJ. Corrija o cadastro do fornecedor.` });
  }
  const suppliers = [...new Set(entries.map((n) => n.supplier_id).filter((v): v is string => typeof v === "string"))];
  if (suppliers.length) for (const c of rows(db, `SELECT c.record_id, r.name, c.document FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id
      WHERE c.record_id IN (SELECT value FROM json_each(?))`, JSON.stringify(suppliers)))
    if (!String(c.document ?? "").replace(/\D/g, "")) add({ kind: "participante", blocking: false, link: link.contact(String(c.record_id)),
      message: `O contato ${String(c.name)} (fornecedor de nota do período) está sem CPF ou CNPJ no cadastro. O arquivo usa o documento do XML, mas vale corrigir.` });

  // Produtos citados: os ligados às entradas e, se pedido, os do inventário.
  const ids = new Set(entryProducts(db, input.environment, input.from, input.to));
  let inventoryCount = 0;
  if (input.inventory && input.kind !== "efd_contribuicoes") {
    const balances = rows(db, `SELECT e.product_id FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id WHERE m.occurred_on<=? GROUP BY e.product_id HAVING sum(e.quantity)>0`, input.inventory);
    inventoryCount = balances.length;
    for (const r of balances) ids.add(String(r.product_id));
    if (!inventoryCount) add({ kind: "inventario", blocking: false, link: "/estoque-empresa", message: `O estoque não tem saldo em ${input.inventory.split("-").reverse().join("/")}: o inventário vai vazio.` });
  }
  const products = readProducts(db, [...ids]);
  for (const p of products.values()) {
    const missing = [!p.ncm || p.ncm.length !== 8 ? "NCM" : null, !p.unit ? "unidade" : null].filter(Boolean);
    if (missing.length) add({ kind: "produto", blocking: true, link: link.product(p.id), message: `O produto ${p.name} (${p.code}) está sem ${missing.join(" e ")}. Corrija no cadastro do produto.` });
  }
  if (input.kind === "efd_icms_ipi" && settings.activity === "0" && input.inventory === null && input.from.endsWith("-02-01"))
    add({ kind: "inventario", blocking: false, link: null, message: "O SPED de fevereiro costuma levar o inventário de 31 de dezembro. Se for o caso, escolha o dia do inventário." });
  return { problems, notice: regimeNotice(input.kind, company.crt), crt: company.crt };
}
