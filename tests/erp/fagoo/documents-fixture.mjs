// Auxiliares das fixtures de documentos do Fagoo (documents-b-fixture,
// documents-c-fixture, documents-d-fixture e documents-e-fixture, em
// workers/erp-api/test/helpers/) sobre a fixture dupla: cada chamada da
// erp-api passa pelo Worker real e o RPC vai para f.rpc (portado: os dois
// motores; não portado: Postgres e espelho no SQLite).
// Diferenças dos originais, só nos auxiliares:
// - o banco tem todas as migrações (os originais param na leva: `upto`);
// - as pessoas são as da fixture dupla; `vendas2` (leva E) é f.users.vendedor;
// - SQL direto de escrita (seller, assign, permissions, write) chama f.sync();
// - divergência dos motores dentro do Worker não vira resposta 400: a chamada
//   (call) relança o erro "os motores divergem".
// `lane`: 'B', 'C', 'D' ou 'E' (nomes do contato e do produto, o texto de
// erro que o Worker repassa e o `transition`/`rule` de cada leva).
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { createHandler } from "../../../src/erp/fagoo/workers/erp-api/src/index.mjs";

const env = { SUPABASE_URL: "https://synthetic.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", ALLOWED_ORIGINS: "https://synthetic.invalid" };

export async function documentsFixture({ lane = "E", ...options } = {}) {
  const f = await dualFixture(options);
  try {
    const db = f.db;
    const scalar = async (text, args = []) => (await db.query(text, args)).rows[0]?.v;
    const rows = async (text, args = []) => (await db.query(text, args)).rows;
    const rpc = (name, args) => f.rpc(name, args);
    /** Escrita direta no Postgres seguida da cópia para o SQLite. */
    const write = async (text, args = []) => {
      const r = await db.query(text, args);
      await f.sync();
      return r;
    };
    const users = { ...f.users, vendas2: f.users.vendedor };
    const passErp = lane === "D" || lane === "E";
    const calls = [], auth = { calls: [], fail: false };
    let divergence = null;
    const handler = createHandler({
      fetchImpl: async (url, options) => {
        if (url.endsWith("/auth/v1/user")) return Response.json({ id: options.headers.Authorization.slice(7) });
        if (url.includes("/auth/v1/admin/users/")) {
          auth.calls.push({ user: url.split("/").at(-1), method: options.method, body: JSON.parse(options.body) });
          if (auth.fail) return Response.json({ msg: "synthetic" }, { status: 500 });
          return Response.json({ id: url.split("/").at(-1) });
        }
        const name = new URL(url).pathname.split("/").at(-1);
        calls.push(name);
        try {
          return Response.json(await rpc(name, JSON.parse(options.body)));
        } catch (e) {
          if (e?.code === "ERR_ASSERTION") {
            divergence ??= e;
            return Response.json({ code: "XX000", message: "SANITIZE_SYNTHETIC_SQL_ERROR" }, { status: 500 });
          }
          return Response.json(
            { code: e.code, message: passErp && /^erp_[a-z0-9_]{1,80}$/.test(e.message) ? e.message : "SANITIZE_SYNTHETIC_SQL_ERROR" },
            { status: 400 },
          );
        }
      },
    });
    const call = async (path, method = "GET", body, user = users.admin) => {
      divergence = null;
      const response = await handler(
        new Request("https://api.synthetic.invalid" + path, {
          method,
          headers: { Authorization: "Bearer " + user, Origin: "https://synthetic.invalid", ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }),
        env,
      );
      const value = await response.json();
      if (divergence) throw divergence;
      return { status: response.status, value };
    };
    const catalog = async (entity, data, user = users.admin) =>
      (await rpc("erp_catalog_save", { p_user_id: user, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
    const contact = await catalog("contacts", { name: `Contato sintético ${lane}` });
    const product = await catalog("products", { name: `Produto sintético ${lane}`, unit: "UN", kind: "P", format: "S", price: "10" });
    const other = lane === "E" ? null : await catalog("products", { name: `Outro produto sintético ${lane}`, unit: "UN", kind: "P", format: "S", price: "5" });
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
    /** Creates a document through the Worker and returns it. */
    const create = async (kind, extra = {}, user = users.admin) => {
      const r = await call(`/v1/documentos/${kind}`, "POST", { command_id: randomUUID(), data: data(kind, extra) }, user);
      if (r.status !== 200) throw new Error(`create ${kind}: ${r.status} ${JSON.stringify(r.value)}`);
      return r.value.document;
    };
    /** Gerenciador de transições (148, administrador): a custom situação based on a status. */
    const situation = async (kind, base, name, color = "#123456") =>
      (await rpc("erp_preferences_situation_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: kind, p_situation: null, p_expected_version: 0, p_data: { active: true, base_status: base, color, name } })).receipt.target;
    const rule = async (kind, from, to, ruleData = { active: true, actions: [] }) => {
      const version = await scalar("select coalesce((select version from erp_preferences.transition where kind=$1 and from_key=$2 and to_key=$3),0) v", [kind, from, to]);
      return rpc("erp_preferences_transition_save", { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: kind, p_from: from, p_to: to, p_expected_version: version, p_data: ruleData });
    };
    const docTransition = async (doc, status, user = users.admin, reason = "Motivo sintético") =>
      call(`/v1/documentos/${doc.kind}/${doc.id}/status`, "POST", { command_id: randomUUID(), expected_version: doc.version, status, reason }, user);
    /** A vendedor (Cadastros › Vendedores) linked to the user, with its own contact. */
    const seller = async (user, { allow = false, limit = "0", name = "Vendedor sintético" } = {}) => {
      const own = await catalog("contacts", { name });
      return (await write(
        "insert into erp_catalog.seller(contact_id,user_id,allow_unregistered_products,discount_limit,created_by,updated_by) values($1,$2,$3,$4::numeric,$5,$5) returning id::text v",
        [own.id, user, allow, limit, users.admin],
      )).rows[0]?.v;
    };
    /** Links the contact to the seller (Clientes e fornecedores › Vendedor). */
    const assign = async (contactId, sellerId) =>
      write("insert into erp_catalog.contact_profile(record_id,seller_id) values($1,$2) on conflict(record_id) do update set seller_id=excluded.seller_id", [contactId, sellerId]);
    /** Sistema › Usuários › Permissões (229): the saved permission set of a user (null: everything of the profile). */
    const permissions = async (user, keys) =>
      write(
        "insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1",
        [user, keys, users.admin],
      );
    /** 222: a composition (format "Com composição") with its Estrutura. */
    const kit = async (name, components) => {
      const created = await catalog("products", { name, unit: "UN", kind: "P", format: "E", price: "30" });
      await rpc("erp_stock_product_compose", {
        p_user_id: users.estoque, p_id: created.id, p_expected_version: await recordVersion(created.id), p_command_id: randomUUID(), p_data: { name }, p_acknowledged: null,
        p_composition: { expected_version: 0, stock_type: "virtual", post_mode: "components", items: components.map(([component, quantity]) => ({ component_id: component.id ?? component, quantity })) },
      });
      return created;
    };
    return {
      ...f, db, scalar, rows, rpc, write, users, calls, auth, call, catalog, contact, product, other, recordVersion, setPreference, line, data, create,
      situation, rule, seller, assign, permissions, kit,
      // Leva E: transition(doc, status, user, reason); levas C e D: transition(kind, from, to, data) é a regra.
      transition: lane === "E" ? docTransition : rule,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
