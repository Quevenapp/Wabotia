// Diferencial das leituras de configuração do Documentos (sessão L, B0,
// documents/rpc/reads-config.ts): cada leitura nos dois motores, com todos os
// papéis, tipos de documento e argumentos estragados, sobre dados que forçam
// a semântica do oráculo: nomes com acento, maiúsculas e empates (ordem por
// lower() e id, collation C), árvore de categorias mais funda que 5, nós
// inativos com filhos visíveis, campos customizados contados no corpo dos
// documentos, numeração no teto, cabeçalho e assinatura ausentes.
// Os dados são gravados direto no Postgres e espelhados (os escritores do
// Documentos ainda não estão portados).
//   node --test tests/erp/documents/reads-config-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

const KINDS = ["sales_proposals", "sales_orders", "purchase_orders", "service_orders", "x", null];
const NAMES = ["Água", "agua", "Zeta", "éclair", "Ébano", "a b", "ÁGUA", "Ω omega", "zeta", "İstanbul"];
let f;
const sql = async (text, args = []) => (await f.db.query(text, args)).rows;
const replica = async (fn) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await fn();
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
};

before(async () => {
  f = await dualFixture();
  const { admin } = f.users;
  const contact = (await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer"] })).id;
  await replica(async () => {
    // Categorias: duas árvores (receber e pagar), profundidade 7, nós ocultos com filhos visíveis.
    for (const kind of ["receivable", "payable"]) {
      let parents = [null];
      for (let depth = 1; depth <= 7; depth++) {
        const next = [];
        for (const parent of parents)
          for (let i = 0; i < (depth <= 2 ? 3 : 1); i++) {
            const id = randomUUID();
            const name = `${NAMES[(depth * 3 + i) % NAMES.length]}${depth % 2 ? "" : " " + depth}`;
            const deleted = depth === 3 && i === 0 && next.length === 0;
            const active = !(depth === 2 && i === 1) && !deleted;
            await sql(
              "insert into erp_finance.category(id,name,kind,active,version,created_at,updated_at,parent_id,deleted_at,deleted_by) values($1,$2,$3,$4,1,now(),now(),$5,$6,$7)",
              [id, name, kind, active, parent, deleted ? new Date() : null, deleted ? admin : null],
            );
            next.push(id);
          }
        parents = next;
      }
    }
    const pick = async (kind, active) => (await sql("select id from erp_finance.category where kind=$1 and active=$2 limit 1", [kind, active]))[0]?.id;
    for (const [key, kind, active] of [["sale", "receivable", true], ["service", "receivable", false], ["purchase", "payable", true]])
      await sql(
        "insert into erp_finance.category_default(key,category_id,version,actor,updated_at) values($1,$2,1,$3,now()) on conflict(key) do update set category_id=excluded.category_id",
        [key, await pick(kind, active), admin],
      );
    // Campos customizados da OS (lower(name) é único: maiúsculas e acento na ordem) e documentos que os usam no corpo.
    const fields = [];
    for (const [i, name] of ["Garantia", "garantia 2", "Ábaco", "zebra", "Zebra!"].entries()) {
      const id = randomUUID();
      fields.push(id);
      await sql(
        "insert into erp_documents.custom_field(id,kind,field_type,name,hint,required,width,options,active,version,created_by,updated_by,created_at,updated_at) values($1,'service_orders','text',$2,$3,$4,'medium','[]',$5,1,$6,$6,now(),now())",
        [id, name, i % 2 ? null : "dica", i === 0, i !== 3, admin],
      );
    }
    const body = (cf) => JSON.stringify({ custom_fields: cf });
    const doc = (kind, number, b) =>
      sql(
        "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority) values($1,$2,$3,1,'open',$6,0,'{}',$4,$5,$5,now(),now(),'brufap','brufap')",
        [randomUUID(), kind, number, b, admin, contact],
      );
    await doc("service_orders", 7, body({ [fields[0]]: "x", [fields[2]]: "y" }));
    await doc("service_orders", 8, body([fields[0]]));
    await doc("service_orders", 9, JSON.stringify({ custom_fields: fields[1] }));
    await doc("sales_orders", 9999999999, body({ [fields[0]]: "x" }));
    await doc("purchase_orders", 3, "{}");
    await sql("update erp_documents.numbering set last_number=9999999999 where kind='sales_proposals'");
    // Listagem, cabeçalho e assinatura de alguns.
    await sql(
      "insert into erp_documents.list_view(user_id,kind,custom_view,columns,default_statuses,version,updated_at) values($1,'sales_orders',true,'{date,total}','{}',3,now()),($2,'sales_proposals',false,null,'{open}',1,now())",
      [f.users.vendas, admin],
    );
    await sql("insert into erp_documents.print_header(kind,content,version,updated_by,updated_at) values('sales_orders',$1,2,$2,now())", [
      JSON.stringify({ ops: [{ insert: "Cabeçalho" }] }),
      admin,
    ]);
    await sql("insert into erp_documents.user_signature(user_id,greeting,department,version,updated_at) values($1,'Att.',null,4,now())", [f.users.vendas]);
    await sql("update erp_access.profile set name=$1 where user_id=$2", ["Ângela Ñúñez 😀", f.users.consulta]);
  });
  await f.sync();
});
after(async () => f?.close());

const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (/divergem/.test(e.message)) throw e;
    return { error: e.code };
  }
};
const users = () => [...Object.values(f.users), randomUUID(), null];

test("categorias, campos customizados, listagem, numeração, cabeçalho e assinatura: todos os papéis e tipos", async () => {
  for (const user of users()) {
    for (const kind of KINDS) {
      const args = { p_user_id: user, p_kind: kind };
      await outcome(f.rpc("erp_document_categories", args));
      await outcome(f.rpc("erp_document_custom_fields", args));
      await outcome(f.rpc("erp_document_list_view_get", args));
      await outcome(f.rpc("erp_document_next_number", args));
      await outcome(f.rpc("erp_document_print_header", args));
      await outcome(f.rpc("erp_document_payment_options", args));
    }
    await outcome(f.rpc("erp_document_signature", { p_user_id: user }));
    await outcome(f.rpc("erp_document_discount_approval", { p_user_id: user }));
  }
  const tree = await f.rpc("erp_document_categories", { p_user_id: f.users.admin, p_kind: "sales_orders" });
  assert.ok(tree.items.length > 5 && tree.items.every((i) => i.depth <= 5), "profundidade até 5");
  const cf = await f.rpc("erp_document_custom_fields", { p_user_id: f.users.admin, p_kind: "service_orders" });
  assert.ok(cf.items.some((i) => i.documents === 2), "contagem pelo ?: chave de objeto e elemento de array");
  assert.equal((await f.rpc("erp_document_next_number", { p_user_id: f.users.admin, p_kind: "sales_proposals" })).next_number, null);
});

test("formas de pagamento e contas: ordem por padrão, lower(descrição) e id", async () => {
  const { admin } = f.users;
  await replica(async () => {
    for (const [i, name] of NAMES.entries()) {
      await sql(
        `insert into erp_catalog.payment_method(id,description,payment_type,destination,account_id,business_days,applicable,auto_settle,fee_type,active,is_default,version,created_by,updated_by,created_at,updated_at,default_receipt,default_payment,default_return)
         values($1,$2,'01',$3,null,false,$4,false,'aliquota',$5,$6,1,$7,$7,now(),now(),$6,false,false)`,
        // is_default = default_receipt (CHECK): só em forma ativa que recebe (i=3: ambos).
        [randomUUID(), name + "z".repeat(i * 9), i % 3 ? "caixa" : "contas", ["ambos", "recebimentos", "pagamentos"][i % 3], i !== 4, i === 3, admin],
      );
      await sql(
        "insert into erp_finance.account(id,name,kind,active,opening_recorded,version,created_at,updated_at,account_type,default_movements,default_boleto) values($1,$2,'bank',$3,false,1,now(),now(),'checking',false,false)",
        [randomUUID(), name, i !== 2],
      );
    }
  });
  await f.sync();
  for (const user of users()) for (const kind of KINDS) await outcome(f.rpc("erp_document_payment_options", { p_user_id: user, p_kind: kind }));
  const r = await f.rpc("erp_document_payment_options", { p_user_id: admin, p_kind: "sales_orders" });
  assert.ok(r.methods.length >= 3 && r.accounts.length >= 3);
});

test("códigos do fornecedor e lote dos produtos: listas de ids válidas e estragadas", async () => {
  const supplier = await f.catalog("contacts", { name: "Fornecedor Sintético", roles: ["supplier"] });
  const products = [];
  for (let i = 0; i < 4; i++) products.push((await f.catalog("products", { name: `Produto ${i}`, code: `P${i}` })).id);
  await replica(async () => {
    for (const [i, code] of ["A1", "  ", null, " b2 "].entries())
      await sql("insert into erp_catalog.product_supplier(record_id,position,supplier_id,code,is_default) values($1,1,$2,$3,false)", [products[i], supplier.id, code]);
    await sql("update erp_catalog.product_detail set lot_control=true where record_id=$1", [products[1]]);
  });
  await f.sync();
  const lists = [products, [products[2], products[0]], [], [products[0], null], [products[0], products[0]], Array.from({ length: 251 }, () => randomUUID()), null, [randomUUID()]];
  for (const user of [f.users.admin, f.users.estoque, f.users.vendas, f.users.consulta, null])
    for (const ids of lists) {
      for (const contact of [supplier.id, randomUUID(), null])
        await outcome(f.rpc("erp_document_supplier_codes", { p_user_id: user, p_contact_id: contact, p_product_ids: ids }));
      for (const kind of KINDS) await outcome(f.rpc("erp_document_lot_products", { p_user_id: user, p_kind: kind, p_product_ids: ids }));
    }
  const r = await f.rpc("erp_document_supplier_codes", { p_user_id: f.users.admin, p_contact_id: supplier.id, p_product_ids: products });
  // Ordem por record_id (uuid aleatório): só o conjunto; o código em branco sai, o com espaços fica como está.
  assert.deepEqual(r.items.map((i) => i.code).sort(), [" b2 ", "A1"]);
});
