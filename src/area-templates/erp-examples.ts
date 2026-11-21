// Exemplos que um modelo de área monta no ERP: o financeiro básico
// (examples.ts → financeiro: formas de pagamento, categorias financeiras e a
// conta "Caixa") e o catálogo de Produtos e serviços (examples.ts → catalogo),
// cada tipo só se a área ainda não tem nada dele. O ERP é outro objeto: a
// aplicação do modelo só registra o que falta montar
// (area_template_erp_examples, migração 0166) no mesmo lote da configuração;
// o alarme da área (registerSchedule "erp", src/erp/conversa/charges.ts) monta
// na primeira vez que o ERP responder, pelas rotas do próprio ERP e em nome do
// administrador que aplicou o modelo. O que foi criado entra na pegada do
// modelo (area_template_footprints.examples_json) e o desfazer remove o que
// ninguém alterou (versão igual) nem usou (o ERP recusa apagar o que tem uso;
// o produto com estoque fica).
import { all, exec, one } from "../db";
import { ApiError, json, now, type Actor, type Env } from "../types";
import { actorForUser } from "../security";
import { erpCall } from "../erp/conversa/documents.ts";
import { brDate, commandId } from "../erp/conversa/charges.ts";
import { erpApi } from "../erp/api/local-fetch";
import { erpIdentity } from "../modules/erp/identity";
import type { ErpExamples, FinanceExamples } from "./examples";
import type { FootprintExample } from "./footprint";

export type ErpExampleKind = "erp_payment_method" | "erp_finance_category" | "erp_finance_account" | "erp_product";
export const isErpExample = (kind: string): kind is ErpExampleKind => kind.startsWith("erp_");
const MAX_ATTEMPTS = 30;

/** Uma rota do painel do ERP, como a pessoa. Os testes passam um ERP simulado. */
export type ErpCaller = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<any>;
export function erpCaller(env: Env, profile: string, actor: Actor, what: string): ErpCaller {
  return (method, path, body) => method === "PATCH" ? erpPatch(env, profile, actor, path, body, what) : erpCall(env, profile, actor, method, path, body, what);
}
/** Apagar produto é PATCH (…/deleted); erpCall só fala GET e POST. Mesmo caminho: identidade da pessoa e erpApi. */
async function erpPatch(env: Env, profile: string, actor: Actor, path: string, body: unknown, what: string) {
  const url = `https://wabotia.internal/api/v1/profiles/${encodeURIComponent(profile)}/erp${path}`;
  const who: Actor = { ...actor, via: undefined };
  const identity = await erpIdentity(env, who, profile, "PATCH", new URL(url).pathname);
  const response = await erpApi(env, new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body ?? {}) }), profile, who, identity);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, object(object(result).error).code ?? "erp_refused", `O ERP recusou a alteração de ${what}.`);
  return result;
}

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
/** Linhas (com id) de uma resposta de lista do ERP, também de árvore (children). */
function rows(body: unknown): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const row = object(value);
    if (typeof row.id === "string") out.push(row);
    for (const key of ["items", "data", "records", "nodes", "children", "tree", "categories"]) if (Array.isArray(row[key])) walk(row[key]);
  };
  const root = object(body);
  walk(Array.isArray(body) ? body : root.items ?? root.data ?? root.records ?? root.nodes ?? root.tree ?? root.categories ?? []);
  return out;
}
const alive = (row: Record<string, any>) => row.deleted !== true && !row.deleted_at;

const PATHS = {
  methods: "/v1/cadastros/formas-pagamento?page=1&size=100&situation=all",
  accounts: "/v1/financeiro/contas-financeiras?page=1&limit=100",
  categories: (kind: string) => `/v1/financeiro/categorias-arvore?kind=${kind}`,
  // "latest": ativos e inativos, sem os excluídos (página nova da lista de produtos).
  products: "/v1/cadastros/products?page=1&size=100&situation=latest",
  product: (id: string) => `/v1/cadastros/products/${encodeURIComponent(id)}`,
};

function methodData(method: FinanceExamples["payment_methods"][number]) {
  return { description: method.description, payment_type: method.payment_type, condition: null, destination: "contas", account_id: null,
    business_days: false, applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
    auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null };
}

/** Monta, como `actor`, o que falta do financeiro e do catálogo de exemplo. Devolve o que criou. */
export async function mountFinanceExamples(env: Env, profile: string, templateId: string, actor: Actor, examples: ErpExamples,
  call: ErpCaller = erpCaller(env, profile, actor, "os exemplos do ERP")): Promise<FootprintExample[]> {
  const created: FootprintExample[] = [];
  const seed = (what: string) => commandId(`area-template-erp:${profile}:${templateId}:${what}`);
  const version = (body: any) => Number(object(body?.record ?? body?.item ?? body).version) || 1;
  const idOf = (body: any) => String(object(body?.record ?? body?.item ?? body).id ?? "");
  // Formas de pagamento: só com nenhuma cadastrada (nem inativa).
  if (examples.payment_methods?.length && !rows(await call("GET", PATHS.methods)).some(alive)) {
    for (const method of examples.payment_methods) {
      const body = await call("POST", "/v1/cadastros/formas-pagamento", { command_id: await seed(`method:${method.payment_type}`), data: methodData(method) });
      if (idOf(body)) created.push({ kind: "erp_payment_method", id: idOf(body), label: `Forma de pagamento "${method.description}" no ERP`, updated: version(body) });
    }
  }
  if (examples.categories?.length) for (const kind of ["receivable", "payable"] as const) {
    if (rows(await call("GET", PATHS.categories(kind))).some(alive)) continue;
    for (const category of examples.categories.filter(item => item.kind === kind)) {
      const body = await call("POST", "/v1/financeiro/actions/category_create", { command_id: await seed(`category:${kind}:${category.name}`),
        data: { kind, name: category.name, ...(category.dre_group ? { dre_group: category.dre_group } : {}) } });
      if (idOf(body)) created.push({ kind: "erp_finance_category", id: idOf(body), label: `Categoria financeira "${category.name}" no ERP`, updated: version(body) });
    }
  }
  if (examples.account && !rows(await call("GET", PATHS.accounts)).some(alive)) {
    const body = await call("POST", "/v1/financeiro/actions/account_create", { command_id: await seed("account:caixa"),
      data: { account_type: "cash", name: examples.account.name, start_on: brDate(now()), opening_cents: "0" } });
    if (idOf(body)) created.push({ kind: "erp_finance_account", id: idOf(body), label: `Conta "${examples.account.name}" no Financeiro`, updated: version(body) });
  }
  // Catálogo: só com Produtos e serviços vazio (nem inativo). Item simples, sem código, NCM nem estoque inicial.
  if (examples.products?.length && !rows(await call("GET", PATHS.products)).some(alive)) {
    for (const item of examples.products) {
      const body = await call("POST", "/v1/cadastros/products", { command_id: await seed(`product:${item.name}`),
        data: { name: item.name, kind: item.kind, format: "S", unit: item.unit, price: item.price } });
      if (idOf(body)) created.push({ kind: "erp_product", id: idOf(body), label: `${item.kind === "S" ? "Serviço" : "Produto"} "${item.name}" em Produtos e serviços do ERP`, updated: version(body) });
    }
  }
  return created;
}

/** Alarme da área: monta os exemplos do ERP pendentes (o ERP pode ainda não estar de pé). */
export async function mountPendingErpExamples(env: Env, profile: string, call?: ErpCaller) {
  const pending = await all(env, `SELECT * FROM area_template_erp_examples WHERE profile_id=? AND state='pendente' AND attempts<? AND coalesce(next_at,0)<=? LIMIT 3`,
    profile, MAX_ATTEMPTS, now());
  for (const row of pending) {
    const footprint = await one(env, "SELECT status FROM area_template_footprints WHERE profile_id=? AND template_id=?", profile, row.template_id);
    // Desfeito antes de montar: nada a fazer.
    if (footprint?.status !== "applied") { await exec(env, "UPDATE area_template_erp_examples SET state='cancelado',updated=? WHERE profile_id=? AND template_id=?", now(), profile, row.template_id); continue; }
    const actor = await actorForUser(env, row.actor);
    const examples = json(row.examples_json, null) as ErpExamples | null;
    try {
      if (!actor) throw new ApiError(403, "actor_missing", "O administrador que aplicou o modelo não está mais ativo; aplique o modelo de novo para montar os exemplos do ERP.");
      if (!examples) throw new ApiError(422, "invalid_examples", "Os exemplos do ERP registrados estão incompletos.");
      const created = await mountFinanceExamples(env, profile, row.template_id, actor, examples, call);
      await exec(env, `UPDATE area_template_footprints SET examples_json=(SELECT json_group_array(json(value)) FROM (
          SELECT value FROM json_each(area_template_footprints.examples_json) UNION ALL SELECT value FROM json_each(?)))
        WHERE profile_id=? AND template_id=? AND status='applied'`, JSON.stringify(created), profile, row.template_id);
      await exec(env, "UPDATE area_template_erp_examples SET state='montado',note=?,updated=? WHERE profile_id=? AND template_id=?",
        created.length ? `${created.length} cadastro(s) de exemplo criados no ERP.` : "O ERP já tinha cadastros desses tipos; nada de exemplo foi criado.", now(), profile, row.template_id);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "O ERP ainda não respondeu.";
      // Parte desligada ou ERP fora do ar: tenta de novo mais tarde. Permissão ou dado: para e registra.
      const retry = !(error instanceof ApiError) || error.status >= 500 || error.code === "module_disabled" || error.code === "erp_unavailable";
      await exec(env, `UPDATE area_template_erp_examples SET state=?,attempts=attempts+1,next_at=?,note=?,updated=? WHERE profile_id=? AND template_id=?`,
        retry ? "pendente" : "falhou", now() + Math.min(60_000 * 2 ** Number(row.attempts || 0), 3_600_000), message.slice(0, 500), now(), profile, row.template_id);
    }
  }
}

/** Estoque diferente de zero (o produto já se mexeu no ERP). */
const hasStock = (value: unknown) => value !== null && value !== undefined && value !== "" && Number(object(value).quantity ?? object(value).total ?? value) !== 0;

/** Estado de um exemplo do ERP para o desfazer: saiu, foi alterado, tem uso, está como criado, ou o ERP não respondeu. */
export async function erpExampleState(env: Env, actor: Actor, profile: string, example: FootprintExample,
  call: ErpCaller = erpCaller(env, profile, actor, "os exemplos do ERP")): Promise<"gone" | "changed" | "used" | "free" | "unknown"> {
  try {
    if (example.kind === "erp_product") {
      let body: any;
      try { body = await call("GET", PATHS.product(example.id)); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return "gone"; throw error; }
      const found = object(body?.record ?? body?.item ?? body);
      if (found.id !== example.id || !alive(found)) return "gone";
      if (found.version !== undefined && Number(found.version) !== example.updated) return "changed";
      return hasStock(found.stock) ? "used" : "free";
    }
    const path = example.kind === "erp_payment_method" ? PATHS.methods : example.kind === "erp_finance_account" ? PATHS.accounts : null;
    const found = path ? rows(await call("GET", path)).find(row => row.id === example.id)
      : [...rows(await call("GET", PATHS.categories("receivable"))), ...rows(await call("GET", PATHS.categories("payable")))].find(row => row.id === example.id);
    if (!found || !alive(found)) return "gone";
    return found.version !== undefined && Number(found.version) !== example.updated ? "changed" : "free";
  } catch { return "unknown"; }
}

/** Apaga o exemplo no ERP (o ERP recusa o que já tem uso; o produto vai para os excluídos). false: ficou. */
export async function deleteErpExample(env: Env, actor: Actor, profile: string, example: FootprintExample,
  call: ErpCaller = erpCaller(env, profile, actor, "o exemplo do ERP")): Promise<boolean> {
  const command = await commandId(`area-template-erp-undo:${profile}:${example.kind}:${example.id}:${example.updated}`);
  try {
    if (example.kind === "erp_payment_method")
      await call("POST", `/v1/cadastros/formas-pagamento/${example.id}/acao`, { command_id: command, expected_version: example.updated, action: "delete" });
    else if (example.kind === "erp_product")
      await call("PATCH", `${PATHS.product(example.id)}/deleted`, { command_id: command, expected_version: example.updated, deleted: true });
    else await call("POST", `/v1/financeiro/actions/${example.kind === "erp_finance_account" ? "account_delete" : "category_delete"}`,
      { command_id: command, data: { id: example.id, expected_version: example.updated } });
    return true;
  } catch { return false; }
}
