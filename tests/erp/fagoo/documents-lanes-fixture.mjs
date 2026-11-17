// Auxiliares das fixtures de documentos do Fagoo (workers/erp-api/test/helpers/
// documents-b-fixture, documents-c-fixture, documents-d-fixture,
// documents-e-fixture e pos-fixture) sobre a fixture dupla: o banco tem todas
// as migrações; RPC portado roda nos dois motores, não portado roda no Postgres
// e o estado é espelhado no SQLite. Toda chamada passa pelo Worker real do
// Fagoo (cópia em src/erp/fagoo), como no original.
// Adaptações, só nos auxiliares:
// - o `upto` das fixtures (banco parado numa migração) não existe: o oráculo
//   tem todas as migrações;
// - o `vendas2` da documents-e-fixture é o `vendedor` da fixture dupla (papel
//   vendas, outra pessoa);
// - escrita direta no Postgres feita pelos auxiliares (vendedor, vínculo do
//   contato, permissões, formas de pagamento do PDV) é seguida de f.sync();
// - divergência entre os motores dentro de uma chamada ao Worker não vira 400:
//   é guardada e relançada por `call`, para nunca passar despercebida.
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

const env = { SUPABASE_URL: "https://synthetic.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", ALLOWED_ORIGINS: "https://synthetic.invalid" };
const DIVERGE = /os motores divergem/;

/** Worker ligado à fixture dupla. `message(e)`: o corpo de erro que o PostgREST devolveria. */
function wire(f, message, extra = null) {
  const pending = [];
  const calls = [];
  // hooks.answer(name, value): troca a resposta do RPC antes do Worker (o
  // original faz isso trocando a função no Postgres, o que o motor TS não vê).
  const hooks = { answer: null };
  const handler = createHandler({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: options.headers.Authorization.slice(7) });
      if (extra) {
        const answer = await extra(url, options);
        if (answer) return answer;
      }
      const name = new URL(url).pathname.split("/").at(-1);
      calls.push(name);
      try {
        const value = await f.rpc(name, JSON.parse(options.body));
        return Response.json(hooks.answer ? hooks.answer(name, value) : value);
      } catch (e) {
        if (DIVERGE.test(e?.message ?? "")) {
          pending.push(e);
          throw e;
        }
        return Response.json(message(e), { status: 400 });
      }
    },
  });
  const call = async (path, method = "GET", body, user = f.users.admin) => {
    const response = await handler(
      new Request("https://api.synthetic.invalid" + path, {
        method,
        headers: { Authorization: "Bearer " + user, Origin: "https://synthetic.invalid", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
    if (pending.length) throw pending.splice(0)[0];
    return { status: response.status, value: await response.json() };
  };
  return { call, calls, handler, hooks };
}

/**
 * Fixture de documentos da onda `lane` ('B', 'C', 'D' ou 'E'), com os mesmos
 * auxiliares da fixture original daquela onda.
 */
export async function documentsLaneFixture(lane = "E", options) {
  const f = await dualFixture(options);
  const users = { ...f.users, vendas2: f.users.vendedor };
  const rpc = f.rpc;
  const scalar = async (text, args = []) => (await f.db.query(text, args)).rows[0]?.v;
  const rows = async (text, args = []) => (await f.db.query(text, args)).rows;
  // B e C escondem toda mensagem SQL; D e E deixam passar as `erp_*`.
  const message =
    lane === "B" || lane === "C"
      ? (e) => ({ code: e.code, message: "SANITIZE_SYNTHETIC_SQL_ERROR" })
      : (e) => ({ code: e.code, message: /^erp_[a-z0-9_]{1,80}$/.test(e.message) ? e.message : "SANITIZE_SYNTHETIC_SQL_ERROR" });
  // Supabase Auth admin (a trava de acesso das pessoas ligadas a um vendedor), só na onda E.
  const auth = { calls: [], fail: false };
  const admin =
    lane === "E"
      ? async (url, options) => {
          if (!url.includes("/auth/v1/admin/users/")) return null;
          auth.calls.push({ user: url.split("/").at(-1), method: options.method, body: JSON.parse(options.body) });
          if (auth.fail) return Response.json({ msg: "synthetic" }, { status: 500 });
          return Response.json({ id: url.split("/").at(-1) });
        }
      : null;
  const { call, calls, hooks } = wire(f, message, admin);
  const catalog = async (entity, data, user = users.admin) =>
    (await rpc("erp_catalog_save", { p_user_id: user, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
  const contact = await catalog("contacts", { name: `Contato sintético ${lane}` });
  const product = await catalog("products", { name: `Produto sintético ${lane}`, unit: "UN", kind: "P", format: "S", price: "10" });
  const other = lane === "E" ? undefined : await catalog("products", { name: `Outro produto sintético ${lane}`, unit: "UN", kind: "P", format: "S", price: "5" });
  const recordVersion = async (id) => scalar("select version v from erp_catalog.record where id=$1", [id]);
  const setPreference = async (page, key, value) => {
    const current = (await rpc("erp_preferences_page", { p_user_id: users.admin, p_page: page })).items.find((item) => item.key === key);
    if (lane === "E" && JSON.stringify(current.value) === JSON.stringify(value)) return null;
    return rpc("erp_preferences_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] });
  };
  const line = (extra = {}) => ({ product_id: null, description: "Item sintético", detailed_description: null, code: null, unit: "UN", quantity: "1", unit_price: "10", discount_percent: "0", ...extra });
  const data = (kind, extra = {}) => ({
    date: "2026-10-20", contact_id: contact.id,
    items: kind === "service_orders" ? [] : [lane === "E" ? line({ product_id: product.id }) : line()],
    discount_mode: "amount", discount_value: "0", freight: "0", other_expenses: "0", installments: [], commercial: null, ...extra,
  });
  /** Cria um documento pelo Worker e o devolve. */
  const create = async (kind, extra = {}, user = users.admin) => {
    const r = await call(`/v1/documentos/${kind}`, "POST", { command_id: randomUUID(), data: data(kind, extra) }, user);
    if (r.status !== 200) throw new Error(`create ${kind}: ${r.status} ${JSON.stringify(r.value)}`);
    return r.value.document;
  };
  /** Gerenciador de transições (148): situação personalizada sobre um status. */
  const situation = async (kind, base, name, color = "#123456") =>
    (await rpc("erp_preferences_situation_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: kind, p_situation: null, p_expected_version: 0, p_data: { active: true, base_status: base, color, name } })).receipt.target;
  /** Transição configurada entre chaves (o `transition` das ondas C e D, o `rule` da E). */
  const rule = async (kind, from, to, ruleData = { active: true, actions: [] }) => {
    const version = await scalar("select coalesce((select version from erp_preferences.transition where kind=$1 and from_key=$2 and to_key=$3),0) v", [kind, from, to]);
    return rpc("erp_preferences_transition_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: kind, p_from: from, p_to: to, p_expected_version: version, p_data: ruleData });
  };
  /** Mudança de situação de um documento pelo Worker (o `transition` da onda E). */
  const move = async (doc, status, user = users.admin, reason = "Motivo sintético") =>
    call(`/v1/documentos/${doc.kind}/${doc.id}/status`, "POST", { command_id: randomUUID(), expected_version: doc.version, status, reason }, user);
  /** Vendedor (Cadastros › Vendedores) ligado à pessoa, com contato próprio. */
  const seller = async (user, { allow = false, limit = "0", name = "Vendedor sintético" } = {}) => {
    const own = await catalog("contacts", { name });
    const id = await scalar(
      "insert into erp_catalog.seller(contact_id,user_id,allow_unregistered_products,discount_limit,created_by,updated_by) values($1,$2,$3,$4::numeric,$5,$5) returning id::text v",
      [own.id, user, allow, limit, users.admin],
    );
    await f.sync();
    return id;
  };
  /** Liga o contato ao vendedor (Clientes e fornecedores › Vendedor). */
  const assign = async (contactId, sellerId) => {
    const r = await f.db.query(
      "insert into erp_catalog.contact_profile(record_id,seller_id) values($1,$2) on conflict(record_id) do update set seller_id=excluded.seller_id",
      [contactId, sellerId],
    );
    await f.sync();
    return r;
  };
  /** Sistema › Usuários › Permissões (229). */
  const permissions = async (user, keys) => {
    const r = await f.db.query(
      "insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1",
      [user, keys, users.admin],
    );
    await f.sync();
    return r;
  };
  /** 222: produto com composição e a sua Estrutura. */
  const kit = async (name, components) => {
    const created = await catalog("products", { name, unit: "UN", kind: "P", format: "E", price: "30" });
    await rpc("erp_stock_product_compose", {
      p_user_id: users.estoque, p_id: created.id, p_expected_version: await recordVersion(created.id), p_command_id: randomUUID(), p_data: { name }, p_acknowledged: null,
      p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "components", items: components.map(([component, quantity]) => ({ component_id: component.id ?? component, quantity })) },
    });
    return created;
  };
  const common = { ...f, users, scalar, rows, rpc, call, calls, hooks, auth, catalog, contact, product, recordVersion, setPreference, line, data, create, situation, seller, assign, permissions, kit };
  if (lane === "E") return { ...common, transition: move, rule };
  return { ...common, other, transition: rule };
}

export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

/** A pos-fixture do Fagoo (Frente de caixa) sobre a fixture dupla. */
export async function posLaneFixture(options) {
  const f = await dualFixture(options);
  const { users, rpc } = f;
  const scalar = async (text, args = []) => (await f.db.query(text, args)).rows[0]?.v;
  // O PostgREST manda a mensagem SQL da recusa; o Worker a reduz a um motivo permitido.
  const { call } = wire(f, (e) => ({ code: e.code, message: e.message, details: "SYNTHETIC_SQL_DETAIL" }));
  const catalog = async (entity, data) => (await rpc("erp_catalog_save", { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
  const setPreference = async (page, key, value) => {
    const current = (await rpc("erp_preferences_page", { p_user_id: users.admin, p_page: page })).items.find((item) => item.key === key);
    return rpc("erp_preferences_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] });
  };
  const account = (data) => rpc("erp_finance_account_execute", { p_user_id: users.admin, p_command_id: randomUUID(), p_action: "account_create", p_data: data });
  const store = (await account({ account_type: "cash", name: "Caixa loja sintética", start_on: "2020-01-01", opening_cents: "0" })).record;
  const bank = (await account({ account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "Banco sintético", agency: "1", account_number: "2", account_digit: "3", start_on: "2020-01-01", opening_cents: "0" })).record;
  const method = async (description, type, destination = "caixa", accountId = null) =>
    (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,account_id,applicable,created_by,updated_by) values($1,$2,$3,$4,'ambos',$5,$5) returning id", [description, type, destination, accountId, users.admin])).rows[0].id;
  const methods = { dinheiro: await method("Dinheiro", "01"), cartao: await method("Cartão de crédito", "03", "contas"), pix: await method("Pix", "20", "caixa", bank.id) };
  await f.sync();
  const warehouse = await catalog("warehouses", { name: "Depósito sintético PDV" });
  const product = await catalog("products", { name: "Caneta sintética", code: "CAN-01", unit: "UN", kind: "P", format: "S", price: "10", gtin: "7891234567895" });
  const other = await catalog("products", { name: "Caderno sintético", code: "CAD-01", unit: "UN", kind: "P", format: "S", price: "25.50" });
  const service = await catalog("products", { name: "Embalagem para presente", code: "SRV-01", unit: "UN", kind: "S", format: "S", price: "5" });
  const contact = await catalog("contacts", { name: "Cliente sintético PDV", roles: ["customer"] });
  const consumer = await catalog("contacts", { name: "Consumidor final", roles: ["customer"] });
  const receive = async (productId, quantity) => {
    const version = Number(await scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v", [productId, warehouse.id]));
    return rpc("erp_stock_post", { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: today(), p_reason: "Saldo sintético do PDV", p_items: [{ product_id: productId, warehouse_id: warehouse.id, quantity, expected_version: version }] });
  };
  const stock = async (productId) => scalar("select coalesce((select quantity from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)::text v", [productId, warehouse.id]);
  const balance = async (accountId) => scalar("select coalesce(sum(delta_cents),0)::text v from erp_finance.movement where account_id=$1", [accountId]);
  return { ...f, scalar, call, catalog, setPreference, store, bank, methods, warehouse, product, other, service, contact, consumer, receive, stock, balance };
}
