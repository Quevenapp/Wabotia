// Diferencial do diário da ordem de serviço (sessão L, B0,
// documents/rpc/reads-journal.ts): append (escritor com recibo), get e list
// nos dois motores. Textos no limite (4000 caracteres, 32768 bytes), só
// espaços e tabulações, caractere de controle, recibo repetido e com outro
// texto, versão do documento desatualizada, cursor e limite estragados.
// A OS é gravada direto no Postgres e espelhada.
//   node --test tests/erp/documents/reads-journal-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, os, sale;
const sql = async (text, args = []) => (await f.db.query(text, args)).rows;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (/divergem/.test(e.message)) throw e;
    return { error: e.code };
  }
};

before(async () => {
  f = await dualFixture();
  const customer = await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer"] });
  await f.db.exec("set session_replication_role = replica");
  for (const [kind, version] of [["service_orders", 3], ["sales_orders", 1]]) {
    const id = randomUUID();
    if (kind === "service_orders") os = id;
    else sale = id;
    await sql(
      "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority) values($1,$2,1,$3,'open',$4,0,'{}','{}',$5,$5,now(),now(),'brufap','brufap')",
      [id, kind, version, customer.id, f.users.admin],
    );
  }
  await f.db.exec("set session_replication_role = origin");
  await f.sync();
});
after(async () => f?.close());

test("diário: anotar, repetir, recusar e ler em páginas", async () => {
  const { admin, vendas, consulta } = f.users;
  const append = (user, text, { version = 3, command = randomUUID(), document = os } = {}) =>
    outcome(f.rpc("erp_service_journal_append", { p_user_id: user, p_document_id: document, p_expected_document_version: version, p_command_id: command, p_text: text }));
  const cmd = randomUUID();
  await append(admin, "  Primeira anotação\n", { command: cmd });
  await append(admin, "  Primeira anotação\n", { command: cmd });
  await append(admin, "Outra", { command: cmd });
  await append(vendas, "  Primeira anotação\n", { command: cmd });
  for (const text of ["x".repeat(4000), " " + "x".repeat(4000) + " ", "x".repeat(4001), "ç".repeat(3999) + "€", "€".repeat(4000), "\t \n", "   ", "", null, "a\u0001b", "a\tb\r\nc", "😀".repeat(4000)])
    await append(admin, text);
  await append(admin, "versão velha", { version: 2 });
  await append(admin, "versão zero", { version: 0 });
  await append(admin, "sem comando", { command: null });
  await append(admin, "na venda", { document: sale, version: 1 });
  await append(admin, "sem OS", { document: randomUUID() });
  for (const user of [vendas, consulta, f.users.estoque, f.users.inactive, null]) await append(user, "por " + user);
  for (let i = 0; i < 5; i++) await append(vendas, `nota ${i}`);
  const list = (user, limit, before, document = os) =>
    outcome(f.rpc("erp_service_journal_list", { p_user_id: user, p_document_id: document, p_limit: limit, p_before: before }));
  for (const [limit, before] of [[25, null], [1, null], [3, "5"], [100, "1"], [0, null], [101, null], [null, null], [5, "0"], [5, "x"], [5, "99999999999"]])
    await list(admin, limit, before);
  for (const user of [...Object.values(f.users), randomUUID(), null]) await list(user, 2, null);
  await list(admin, 2, null, sale);
  const page = await f.rpc("erp_service_journal_list", { p_user_id: admin, p_document_id: os, p_limit: 2, p_before: null });
  assert.equal(page.has_more, true);
  for (const e of [...page.items.map((i) => i.id), randomUUID(), null])
    for (const user of [admin, consulta, null]) await outcome(f.rpc("erp_service_journal_get", { p_user_id: user, p_document_id: os, p_entry_id: e }));
});
