// Financeiro básico de exemplo que um modelo de área monta no ERP
// (examples.ts → financeiro): formas de pagamento, categorias financeiras e a
// conta "Caixa", cada tipo só se a área ainda não tem nada dele. O ERP é outro
// objeto: a aplicação do modelo só registra o que falta montar
// (area_template_erp_examples, migração 0166) no mesmo lote da configuração;
// o alarme da área (registerSchedule "erp", src/erp/conversa/charges.ts) monta
// na primeira vez que o ERP responder, pelas rotas do próprio ERP e em nome do
// administrador que aplicou o modelo. O que foi criado entra na pegada do
// modelo (area_template_footprints.examples_json) e o desfazer remove o que
// ninguém alterou (versão igual) nem usou (o ERP recusa apagar o que tem uso).
import { all, exec, one } from "../db";
import { ApiError, json, now, type Actor, type Env } from "../types";
import { actorForUser } from "../security";
import { erpCall } from "../erp/conversa/documents.ts";
import { brDate, commandId } from "../erp/conversa/charges.ts";
import type { FinanceExamples } from "./examples";
import type { FootprintExample } from "./footprint";

export type ErpExampleKind = "erp_payment_method" | "erp_finance_category" | "erp_finance_account";
export const isErpExample = (kind: string): kind is ErpExampleKind => kind.startsWith("erp_");
const MAX_ATTEMPTS = 30;

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
};

function methodData(method: FinanceExamples["payment_methods"][number]) {
  return { description: method.description, payment_type: method.payment_type, condition: null, destination: "contas", account_id: null,
    business_days: false, applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
    auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null };
}

/** Monta, como `actor`, o que falta do financeiro de exemplo. Devolve o que criou. */
export async function mountFinanceExamples(env: Env, profile: string, templateId: string, actor: Actor, examples: FinanceExamples): Promise<FootprintExample[]> {
  const created: FootprintExample[] = [];
  const call = (method: "GET" | "POST", path: string, body?: unknown) => erpCall(env, profile, actor, method, path, body, "o financeiro de exemplo");
  const seed = (what: string) => commandId(`area-template-erp:${profile}:${templateId}:${what}`);
  const version = (body: any) => Number(object(body?.record ?? body?.item ?? body).version) || 1;
  const idOf = (body: any) => String(object(body?.record ?? body?.item ?? body).id ?? "");
  // Formas de pagamento: só com nenhuma cadastrada (nem inativa).
  if (!rows(await call("GET", PATHS.methods)).some(alive)) {
    for (const method of examples.payment_methods) {
      const body = await call("POST", "/v1/cadastros/formas-pagamento", { command_id: await seed(`method:${method.payment_type}`), data: methodData(method) });
      if (idOf(body)) created.push({ kind: "erp_payment_method", id: idOf(body), label: `Forma de pagamento "${method.description}" no ERP`, updated: version(body) });
    }
  }
  if (examples.categories.length) for (const kind of ["receivable", "payable"] as const) {
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
  return created;
}

/** Alarme da área: monta o financeiro de exemplo pendente (o ERP pode ainda não estar de pé). */
export async function mountPendingErpExamples(env: Env, profile: string) {
  const pending = await all(env, `SELECT * FROM area_template_erp_examples WHERE profile_id=? AND state='pendente' AND attempts<? AND coalesce(next_at,0)<=? LIMIT 3`,
    profile, MAX_ATTEMPTS, now());
  for (const row of pending) {
    const footprint = await one(env, "SELECT status FROM area_template_footprints WHERE profile_id=? AND template_id=?", profile, row.template_id);
    // Desfeito antes de montar: nada a fazer.
    if (footprint?.status !== "applied") { await exec(env, "UPDATE area_template_erp_examples SET state='cancelado',updated=? WHERE profile_id=? AND template_id=?", now(), profile, row.template_id); continue; }
    const actor = await actorForUser(env, row.actor);
    const examples = json(row.examples_json, null) as FinanceExamples | null;
    try {
      if (!actor) throw new ApiError(403, "actor_missing", "O administrador que aplicou o modelo não está mais ativo; aplique o modelo de novo para montar o financeiro de exemplo.");
      if (!examples) throw new ApiError(422, "invalid_examples", "O financeiro de exemplo registrado está incompleto.");
      const created = await mountFinanceExamples(env, profile, row.template_id, actor, examples);
      await exec(env, `UPDATE area_template_footprints SET examples_json=(SELECT json_group_array(json(value)) FROM (
          SELECT value FROM json_each(area_template_footprints.examples_json) UNION ALL SELECT value FROM json_each(?)))
        WHERE profile_id=? AND template_id=? AND status='applied'`, JSON.stringify(created), profile, row.template_id);
      await exec(env, "UPDATE area_template_erp_examples SET state='montado',note=?,updated=? WHERE profile_id=? AND template_id=?",
        created.length ? `${created.length} cadastro(s) de exemplo criados no ERP.` : "O ERP já tinha formas de pagamento, categorias e contas; nada de exemplo foi criado.", now(), profile, row.template_id);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "O ERP ainda não respondeu.";
      // Parte desligada ou ERP fora do ar: tenta de novo mais tarde. Permissão ou dado: para e registra.
      const retry = !(error instanceof ApiError) || error.status >= 500 || error.code === "module_disabled" || error.code === "erp_unavailable";
      await exec(env, `UPDATE area_template_erp_examples SET state=?,attempts=attempts+1,next_at=?,note=?,updated=? WHERE profile_id=? AND template_id=?`,
        retry ? "pendente" : "falhou", now() + Math.min(60_000 * 2 ** Number(row.attempts || 0), 3_600_000), message.slice(0, 500), now(), profile, row.template_id);
    }
  }
}

/** Estado de um exemplo do ERP para o desfazer: saiu, foi alterado, está como criado, ou o ERP não respondeu. */
export async function erpExampleState(env: Env, actor: Actor, profile: string, example: FootprintExample): Promise<"gone" | "changed" | "free" | "unknown"> {
  try {
    const path = example.kind === "erp_payment_method" ? PATHS.methods : example.kind === "erp_finance_account" ? PATHS.accounts : null;
    const found = path ? rows(await erpCall(env, profile, actor, "GET", path, undefined, "os exemplos do ERP")).find(row => row.id === example.id)
      : [...rows(await erpCall(env, profile, actor, "GET", PATHS.categories("receivable"), undefined, "os exemplos do ERP")),
        ...rows(await erpCall(env, profile, actor, "GET", PATHS.categories("payable"), undefined, "os exemplos do ERP"))].find(row => row.id === example.id);
    if (!found || !alive(found)) return "gone";
    return found.version !== undefined && Number(found.version) !== example.updated ? "changed" : "free";
  } catch { return "unknown"; }
}

/** Apaga o exemplo no ERP (o ERP recusa o que já tem uso). false: ficou. */
export async function deleteErpExample(env: Env, actor: Actor, profile: string, example: FootprintExample): Promise<boolean> {
  const command = await commandId(`area-template-erp-undo:${profile}:${example.kind}:${example.id}:${example.updated}`);
  try {
    if (example.kind === "erp_payment_method")
      await erpCall(env, profile, actor, "POST", `/v1/cadastros/formas-pagamento/${example.id}/acao`, { command_id: command, expected_version: example.updated, action: "delete" }, "a forma de pagamento de exemplo");
    else await erpCall(env, profile, actor, "POST", `/v1/financeiro/actions/${example.kind === "erp_finance_account" ? "account_delete" : "category_delete"}`,
      { command_id: command, data: { id: example.id, expected_version: example.updated } }, "o exemplo do Financeiro");
    return true;
  } catch { return false; }
}
