// Diferencial aleatório dos auxiliares do Catálogo, bloco A (sessão B): etiquetas de contato
// (leitura e gravação), campos customizados (lista, tela e exclusão) e o seletor de vendedores.
// Cada chamada roda nos dois motores e compara resposta, erro e tabelas; semente fixa.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { auxFixture } from "./aux-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";

/** Erro do domínio (código do Postgres) segue; divergência do diferencial ou erro sem código sobe. */
const domainError = (e) => {
  if (!e.code || e.code === "ERR_ASSERTION") throw e;
};

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

let f;
before(async () => {
  f = await auxFixture();
});
after(async () => f?.close());

test("diferencial aleatório: etiquetas de contato, campos customizados e seletor de vendedores", async () => {
  const r = rng(20261117);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const users = [f.users.admin, f.users.admin, f.users.vendas, f.users.financeiro, f.users.consulta, f.users.estoque, f.users.inactive];
  const group = (await f.taxonomySave("tag_groups", { name: "Grupo", tag_type: "contacts" })).item;
  const names = ["Ana", "ana", "Ábaco", "Zé", "Ωmega", "Çelia", "bruna", "Bruna", "Ünal", "JOÃO"];
  const tags = [];
  for (let i = 0; i < 14; i++)
    tags.push((await f.taxonomySave("tags", i % 3 ? { name: `${names[i % names.length]} ${i}`, tag_type: "contacts" } : { name: `${names[i % names.length]} ${i}`, parent_id: group.id })).item.id);
  const productTag = (await f.taxonomySave("tags", { name: "Produto", tag_type: "products" })).item.id;
  const contacts = [];
  for (let i = 0; i < 6; i++) contacts.push((await f.contact({ name: `${pick(names)} contato ${i}` })).id);
  const SETTINGS = {
    user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
    commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
  };
  const sellers = [];
  for (let i = 0; i < 5; i++)
    sellers.push(
      (
        await f.rpc("erp_catalog_seller_save", {
          p_user_id: f.users.admin, p_command_id: randomUUID(), p_acknowledged: null, p_id: null, p_expected_version: 0, p_contact_expected_version: 0,
          p_contact: { name: `${pick(names)} vendedor ${i}`, ...(i % 2 ? { types: ["customer"] } : {}) },
          p_settings: { ...SETTINGS, commission_rate: i % 2 ? "2.5" : null, discount_limit: String(i), user_id: i === 0 ? f.users.vendas : null },
        })
      ).seller.id,
    );
  const categories = [];
  for (let i = 0; i < 4; i++) categories.push((await f.taxonomySave("categories", { name: `Categoria ${i}` })).item.id);
  const deleted = contacts[5];
  await f.rpc("erp_catalog_contact_set_situation", { p_user_id: f.users.admin, p_id: deleted, p_expected_version: 1, p_command_id: randomUUID(), p_situation: "E" });
  const tagList = () => {
    const n = Math.floor(r() * 5);
    const list = Array.from({ length: n }, () => pick(tags));
    if (r() < 0.1) list.push(pick([productTag, randomUUID(), "x", 7, null]));
    if (r() < 0.1 && list.length) list.push(list[0].toUpperCase?.() ?? list[0]);
    return r() < 0.05 ? pick([null, { a: 1 }]) : list;
  };
  const commands = [];
  let calls = 0,
    ok = 0;
  for (let i = 0; i < 220; i++) {
    const op = r();
    const user = pick(users);
    try {
      calls++;
      if (op < 0.45) {
        const id = r() < 0.9 ? pick(contacts) : pick([randomUUID(), null]);
        const mode = pick(["replace", "replace", "add", "outro", null]);
        const state = id && contacts.includes(id) ? await f.scalar("select version v from erp_catalog.contact_tag_state where record_id=$1", [id]) : null;
        const right = state ?? 0;
        const version = mode === "add" ? (r() < 0.9 ? null : 1) : pick([right, right, right, right + 1, null, -1]);
        const reuse = r() < 0.1 && commands.length;
        const args = reuse
          ? { ...pick(commands), ...(r() < 0.5 ? {} : { p_tag_ids: tagList() }) }
          : { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: randomUUID(), p_tag_ids: tagList(), p_mode: mode };
        commands.push(args);
        await f.rpc("erp_catalog_contact_tags_save", args);
      } else if (op < 0.6) {
        const n = Math.floor(r() * 4);
        const ids = Array.from({ length: n }, () => (r() < 0.85 ? pick(contacts) : randomUUID()));
        await f.rpc("erp_catalog_contact_tags", { p_user_id: user, p_ids: r() < 0.05 ? null : ids });
      } else if (op < 0.72) {
        // Definição nova ou alteração sorteada (válida ou não) pelo save.
        const fields = (await f.db.query("select id, version, field_type from erp_catalog.custom_field order by id")).rows;
        const field = fields.length && r() < 0.6 ? pick(fields) : null;
        const patch = {};
        if (!field || r() < 0.2) patch.field_type = pick(["text", "integer", "decimal", "list", "boolean", "date", "long_text", "outro"]);
        if (!field || r() < 0.5) patch.name = pick([`${pick(names)} ${i}`, `  ${pick(names)}  `, "", "x".repeat(61), pick(names), "a\u0001"]);
        if (r() < 0.3) patch.hint = pick([null, "", " dica ", "x".repeat(101)]);
        if (r() < 0.3) patch.info = pick([null, "\tlinha 1\nlinha 2 ", "a\u0002"]);
        if (r() < 0.3) patch.min_length = pick([null, 1, 5, 300, 0, "3"]);
        if (r() < 0.3) patch.max_length = pick([null, 4, 255, 4000, 9999]);
        if (r() < 0.2) patch.width = pick(["small", "extra_large", "giant"]);
        if (r() < 0.3) patch.grouped = r() < 0.7;
        if (r() < 0.3) patch.category_ids = Array.from({ length: Math.floor(r() * 3) }, () => pick([...categories, randomUUID()]));
        if (r() < 0.2) patch.active = r() < 0.5;
        const type = field ? field.field_type : patch.field_type;
        if (type === "list" || r() < 0.1) {
          const current = field ? (await f.db.query("select id, label from erp_catalog.custom_field_option where field_id=$1 order by position", [field.id])).rows : [];
          const kept = current.filter(() => r() < 0.7).sort(() => r() - 0.5).map((o) => ({ id: o.id, label: r() < 0.3 ? `${o.label}!` : o.label }));
          patch.options = [...kept, ...Array.from({ length: Math.floor(r() * 3) }, (_, n) => ({ label: pick(["A", "b", "Á", " c ", ""]) + n }))];
        }
        if (r() < 0.05) patch.extra = 1;
        await f.rpc("erp_catalog_custom_field_save", {
          p_user_id: pick([f.users.admin, f.users.admin, f.users.estoque, f.users.consulta]), p_id: field ? field.id : null,
          p_expected_version: field ? pick([field.version, field.version, field.version, field.version + 1]) : 0, p_command_id: randomUUID(), p_data: patch,
        });
      } else if (op < 0.85) {
        const fields = (await f.db.query("select id, version from erp_catalog.custom_field order by id")).rows;
        const field = fields.length && r() < 0.9 ? pick(fields) : { id: randomUUID(), version: 1 };
        await f.rpc("erp_catalog_custom_field_delete", {
          p_user_id: user, p_id: field.id, p_expected_version: pick([field.version, field.version, field.version + 1, 0]), p_command_id: randomUUID(),
        });
      } else if (op < 0.93) {
        await f.rpc(pick(["erp_catalog_custom_fields", "erp_catalog_custom_fields_screen"]), { p_user_id: user, p_module: pick(["products", "products", "contacts"]) });
      } else if (op < 0.96) {
        await f.rpc("erp_catalog_seller_options", { p_user_id: user, p_query: pick([null, "", "ana", "a\u0001", "x".repeat(121), "contato 1"]) });
      } else if (r() < 0.5) {
        await f.rpc("erp_catalog_seller_get", { p_user_id: user, p_id: r() < 0.85 ? pick(sellers) : pick([randomUUID(), null]) });
      } else {
        await f.rpc("erp_catalog_seller_page", {
          p_user_id: user, p_page: pick([1, 1, 2, 0]), p_size: pick([2, 10, 100, 101]),
          p_sort: pick(["created_desc", "name_asc", "name_desc", "code_asc", "code_desc", "x"]),
          p_query: pick([null, "vendedor", "ana", "a\u0001"]), p_situation: pick(["latest", "all", "A", "E", "x"]),
          p_type: pick([null, null, "customer", "seller", "none", "nada"]),
        });
      }
      ok++;
    } catch (e) {
      domainError(e);
    }
  }
  assert.ok(ok > 40 && calls - ok > 40, `sucessos ${ok} e recusas ${calls - ok} suficientes`);
  // Vendedores: gravação sorteada (configurações válidas ou não), Tornar vendedor e Vincular a vendedor.
  const setting = () => {
    const s = { ...SETTINGS };
    if (r() < 0.3) s.user_id = pick([f.users.vendas, f.users.vendedor, f.users.consulta, f.users.inactive, randomUUID(), "x", null]);
    if (r() < 0.3) s.access_hours_enabled = r() < 0.7;
    if (r() < 0.3)
      s.access_windows = pick([
        [{ start: "08:00", end: "18:00", days: [1, 2, 3] }], [{ start: "18:00", end: "08:00", days: [1] }], [{ start: "08:00", end: "12:00", days: [1, 1] }],
        [{ start: "8:00", end: "12:00", days: [1] }], [], [{ start: "08:00", end: "12:00", days: [7] }],
      ]);
    if (r() < 0.3) s.modules = pick([{ clientes: true, propostas: false }, { multilojas: true }, { clientes: "sim" }, {}]);
    if (r() < 0.2) s.commission_rule = pick(["faturamento", "outra"]);
    if (r() < 0.3) s.commission_rate = pick(["2.5", "100", "101", "1.23456", "0", null, 3]);
    if (r() < 0.3)
      s.commission_bands = pick([
        [{ discount_up_to: "5", rate: "3" }, { discount_up_to: "10", rate: "1.5" }], [{ discount_up_to: "10", rate: "2" }, { discount_up_to: "5", rate: "3" }],
        [{ discount_up_to: "5", rate: "3", x: 1 }], [],
      ]);
    if (r() < 0.2) s.discount_limit = pick(["10", null, "abc"]);
    if (r() < 0.2) s.notes = pick(["  nota  ", "a\u0001", "", null]);
    if (r() < 0.05) s.extra = true;
    if (r() < 0.05) delete s.notes;
    return s;
  };
  const people = [];
  for (let i = 0; i < 4; i++) people.push((await f.contact({ name: `${pick(names)} pessoa ${i}`, types: i % 2 ? ["customer"] : [] })).id);
  for (let i = 0; i < 70; i++) {
    const user = pick([f.users.admin, f.users.admin, f.users.admin, f.users.vendas, f.users.consulta]);
    try {
      const op = r();
      if (op < 0.5) {
        const known = sellers.length && r() < 0.6 ? pick(sellers) : null;
        const s = known ? await f.db.query("select s.version v, r.version c from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=$1", [known]) : null;
        const v = s?.rows[0];
        const result = await f.rpc("erp_catalog_seller_save", {
          p_user_id: user, p_command_id: randomUUID(), p_acknowledged: null, p_id: known,
          p_expected_version: known ? pick([v.v, v.v, v.v + 1]) : 0, p_contact_expected_version: known ? pick([v.c, v.c, 0]) : 0,
          p_contact: pick([{ name: `${pick(names)} v${i}` }, { name: `${pick(names)} v${i}`, types: ["customer"] }, { name: "" }, {}, { types: "seller" }]),
          p_settings: setting(),
        });
        if (!known) sellers.push(result.seller.id);
      } else if (op < 0.75) {
        const contact = r() < 0.85 ? pick([...people, ...contacts]) : randomUUID();
        const result = await f.rpc("erp_catalog_seller_from_contact", { p_user_id: user, p_command_id: randomUUID(), p_contact_id: r() < 0.05 ? null : contact });
        sellers.push(result.seller.id);
      } else {
        const id = pick([...people, ...contacts]);
        const version = await f.scalar("select version v from erp_catalog.record where id=$1", [id]);
        await f.rpc("erp_catalog_contact_set_seller", {
          p_user_id: user, p_id: id, p_expected_version: pick([version, version, version + 1]), p_command_id: randomUUID(),
          p_seller_id: r() < 0.8 ? pick(sellers) : pick([null, randomUUID()]),
        });
      }
    } catch (e) {
      domainError(e);
    }
  }
  // Vendedores: leitura e página, antes e depois de ligar a carteira do vendedor.
  for (let round = 0; round < 2; round++) {
    if (round === 1) await f.preference("cadastros-contatos", "contatos.acesso_vendedor", true);
    for (let i = 0; i < 30; i++) {
      const user = pick(users);
      try {
        if (r() < 0.4) await f.rpc("erp_catalog_seller_get", { p_user_id: user, p_id: r() < 0.9 ? pick(sellers) : randomUUID() });
        else
          await f.rpc("erp_catalog_seller_page", {
            p_user_id: user, p_page: pick([1, 1, 2]), p_size: pick([2, 3, 100]),
            p_sort: pick(["created_desc", "name_asc", "name_desc", "code_asc", "code_desc"]),
            p_query: pick([null, null, "vendedor", "ana 1"]), p_situation: pick(["latest", "all", "A"]),
            p_type: pick([null, null, "customer", "seller"]),
          });
      } catch (e) {
        domainError(e);
      }
    }
  }
  // Os RPCs do lote rodaram nos dois motores (não só no Postgres).
  for (const name of [
    "erp_catalog_contact_tags", "erp_catalog_contact_tags_save", "erp_catalog_custom_fields", "erp_catalog_custom_fields_screen",
    "erp_catalog_custom_field_delete", "erp_catalog_custom_field_save", "erp_catalog_seller_options", "erp_catalog_seller_get",
    "erp_catalog_seller_page", "erp_catalog_seller_save", "erp_catalog_seller_from_contact", "erp_catalog_contact_set_seller",
  ])
    assert.equal(isPorted(name), true, name);
  assert.ok(f.stats.ported > 150, `chamadas comparadas: ${f.stats.ported}`);
});
