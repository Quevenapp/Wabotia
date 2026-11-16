// Leituras avulsas do domínio 11 na fixture dupla:
// - erp_read_records: sql-access.test.mjs do Fagoo ("summaries…", "pagination…", "deactivation…", "unexpected nested…"), com o
//   espelho do Origin escrito direto no oráculo e copiado (f.sync); fora, declarados: RLS/GRANT e o auto-cadastro anônimo;
// - erp_files_list_v2: files-activity-e-sql.test.mjs "263 Gerenciador de arquivos…" (o contrato 118, erp_files_list, é de
//   outro domínio; GRANT fora);
// - erp_history_backups, erp_preferences_import_job(s) e erp_wabotia_state: casos próprios sobre linhas gravadas direto
//   (a importação de planilhas e a cópia do Origin escrevem essas tabelas; o pareamento é o do wabotia.test.mjs do Fagoo).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { parseFiles, captureFilesQuery } from "../../../src/erp/fagoo/packages/erp-domain/src/activity.mjs";

const fails = (fn, code, message) => assert.rejects(fn, (e) => e.code === code && (!message || e.message === message));
const write = async (f, sql, args = []) => {
  const r = await f.db.query(sql, args);
  await f.sync();
  return r;
};

test("erp_read_records: resumos do espelho, papéis, paginação, filtros e campos aninhados", async () => {
  const f = await dualFixture();
  try {
    await write(f, "insert into origin_sync.resource_state(resource) values('erp_access_test') on conflict do nothing");
    const seed = (entity, id, payload) =>
      f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'erp_access_test',$2,$3::jsonb,$4)", [
        entity,
        id,
        JSON.stringify(payload),
        "a".repeat(64),
      ]);
    const list = (user, entity, limit = 25, offset = 0, query = null, status = null, from = null, to = null) =>
      f.rpc("erp_read_records", { p_user_id: user, p_entity: entity, p_limit: limit, p_offset: offset, p_query: query, p_status: status, p_from: from, p_to: to });
    const id = "90071992547409931234";
    await seed("contacts", id, { nome: "Fornecedor Sintético", codigo: "C-01", email: "never-return@example.test", numeroDocumento: "private-document", endereco: { rua: "private-address" } });
    await seed("purchase_orders", "77", { numero: 123, data: "2026-10-15", total: 200.1, fornecedor: { id }, situacao: { id: 1, valor: 99 }, observacoes: "private-note" });
    await seed("sales_proposals", "88", { numero: 124, data: "2026-10-14", total: 80.5, contato: { id }, situacao: 2 });
    for (const entity of ["nfe", "nfce"])
      await seed(entity, id, {
        numero: "900",
        dataEmissao: "2026-10-15 10:00:00",
        valorNota: 123.45,
        serie: 1,
        tipo: 1,
        situacao: 6,
        contato: { id, nome: "Cliente Sintético", email: "private-email" },
        xml: "private-signed-url",
        linkDanfe: "private-url",
        chaveAcesso: "private-key",
        itens: [{ secret: "private-item" }],
      });
    for (const [pid, name, status] of [
      ["01", "Produto A", "A"],
      ["02", "Produto B", "I"],
      ["03", "Produto % literal", "A"],
    ])
      await seed("products", pid, { nome: name, codigo: pid, situacao: status, preco: 10 });
    await seed("receivables", "r1", { numero: "R1", dataEmissao: "2026-10-01", vencimento: "2026-10-30T00:00:00", valor: 50, saldo: 20, contato: { id, nome: "Cliente Sintético" } });
    await seed("contacts", "nested", { nome: { token: "private-token" }, codigo: ["private-code"], situacao: { secret: "private-status" } });
    await f.sync();
    const purchase = (await list(f.users.estoque, "purchase_orders")).items[0];
    assert.deepEqual([purchase.counterparty_id, purchase.counterparty_name, purchase.status, purchase.amount], [id, "Fornecedor Sintético", "1", "200.1"]);
    assert.equal((await list(f.users.vendas, "sales_proposals")).items[0].counterparty_name, "Fornecedor Sintético");
    for (const entity of ["nfe", "nfce"]) {
      const item = (await list(f.users.fiscal, entity)).items[0];
      assert.deepEqual([item.id, item.model, item.amount, item.date], [id, entity === "nfe" ? "55" : "65", "123.45", "2026-10-15"]);
      assert.doesNotMatch(JSON.stringify(item), /private-|xml|linkDanfe|chaveAcesso|itens/);
    }
    assert.doesNotMatch(JSON.stringify(await list(f.users.admin, "contacts")), /never-return|private-/);
    const due = (await list(f.users.financeiro, "receivables")).items[0];
    assert.deepEqual([due.due_date, due.balance, due.counterparty_name], ["2026-10-30", "20", "Cliente Sintético"]);
    const first = await list(f.users.estoque, "products", 2, 0);
    assert.deepEqual(first.items.map((row) => row.id), ["01", "02"]);
    assert.deepEqual([first.total, first.has_more, first.next_offset], [3, true, 2]);
    const last = await list(f.users.estoque, "products", 2, 2);
    assert.deepEqual([last.items.map((row) => row.id), last.has_more, last.next_offset], [["03"], false, null]);
    assert.equal((await list(f.users.admin, "products", 25, 0, "%", null)).total, 1);
    assert.equal((await list(f.users.admin, "products", 25, 0, " produto b ", null)).total, 1);
    assert.equal((await list(f.users.admin, "products", 25, 0, "' OR 1=1 --", null)).total, 0);
    assert.equal((await list(f.users.admin, "products", 25, 0, null, "I")).total, 1);
    assert.equal((await list(f.users.admin, "nfe", 25, 0, null, null, "2026-10-16", "2026-10-17")).total, 0);
    assert.equal((await list(f.users.admin, "nfe", 25, 0, null, null, "2026-10-15", "2026-10-15")).total, 1);
    for (const [limit, offset] of [
      [0, 0],
      [101, 0],
      [25, -1],
      [25, 100001],
    ])
      await fails(() => list(f.users.admin, "products", limit, offset), "22023");
    await fails(() => list(f.users.admin, "products", 25, 0, "x".repeat(121)), "22023");
    await fails(() => list(f.users.admin, "nfe", 25, 0, null, null, "2026-10-17", "2026-10-16"), "22023");
    await fails(() => list(f.users.admin, "nfe", 25, 0, null, null, "1899-12-31", null), "22023");
    await fails(() => list(f.users.admin, "credentials"), "42501");
    await fails(() => list(f.users.vendas, "receivables"), "42501");
    await fails(() => list(f.users.admin, null), "42501");
    const nested = (await list(f.users.admin, "contacts")).items.find((row) => row.id === "nested");
    assert.deepEqual([nested.name, nested.code, nested.status], [null, null, null]);
    await write(f, "update erp_access.membership set active=false where user_id=$1", [f.users.vendas]);
    await fails(() => list(f.users.vendas, "contacts"), "42501");
    await fails(() => list(randomUUID(), "contacts"), "42501");
  } finally {
    await f.close();
  }
});

const SHA = "a".repeat(64);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

test("263 Gerenciador de arquivos: every origin, deleted attachments left out, filters, order and administrador only", async () => {
  const f = await dualFixture();
  try {
    const contact = await f.catalog("contacts", { name: "Cliente Sintético Arquivos" });
    const product = await f.catalog("products", { name: "Produto Sintético Imagem", code: "IMG-1", unit: "UN", kind: "P", format: "S", price: "1" });
    const order = (
      await f.rpc("erp_document_save", {
        p_user_id: f.users.admin,
        p_kind: "sales_orders",
        p_id: null,
        p_expected_version: 0,
        p_command_id: randomUUID(),
        p_body: { date: today(), contact_id: contact.id, items: [{ unit: "UN", product_id: product.id, description: "Produto Sintético Imagem", quantity: "1", unit_price: "10" }] },
      })
    ).document;
    const doc = async (name, { deleted = false, size = 100 } = {}) => {
      const id = (
        await f.db.query(
          "insert into erp_attachments.attachment(document_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,$2,$3,$4,$5,'application/pdf',$6,$7,'ready',$3,clock_timestamp()) returning id",
          [order.id, randomUUID(), f.users.admin, SHA, name, size, SHA],
        )
      ).rows[0].id;
      if (deleted)
        await f.db.query("update erp_attachments.attachment set deleted_at=clock_timestamp(),deleted_by=$2,delete_command_id=$3 where id=$1", [id, f.users.admin, randomUUID()]);
      return id;
    };
    const kept = await doc("anexo-contrato.pdf", { size: 300 }),
      gone = await doc("anexo-excluido.pdf", { deleted: true });
    await f.db.query(
      "insert into erp_attachments.contact_file(contact_id,purpose,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,'photo',$2,$3,$4,'anexo-foto.png','image/png',50,$4,'ready',$3,clock_timestamp())",
      [contact.id, randomUUID(), f.users.admin, SHA],
    );
    await f.sync();
    const title = (
      await f.rpc("erp_finance_title_execute", {
        p_user_id: f.users.financeiro,
        p_command_id: randomUUID(),
        p_action: "title_create",
        p_data: {
          kind: "payable",
          contact_id: contact.id,
          description: "Conta com comprovante",
          issued_on: "2026-03-01",
          competence_on: "2026-03-01",
          total_cents: "5000",
          installments: [{ amount_cents: "5000", due_on: "2026-03-10" }],
        },
      })
    ).items[0];
    const finance = (
      await f.db.query(
        "insert into erp_finance.file(owner_kind,owner_id,title_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at) values('title',$1,$1,$2,$3,$4,'anexo-boleto.pdf','application/pdf',70,$4,'ready',$3,clock_timestamp()) returning id",
        [title.id, randomUUID(), f.users.financeiro, SHA],
      )
    ).rows[0].id;
    await f.db.query(
      "insert into erp_catalog.product_stored_image(product_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at,position) values($1,$2,$3,$4,'anexo-imagem.jpg','image/jpeg',80,$4,'ready',$3,clock_timestamp(),1)",
      [product.id, randomUUID(), f.users.admin, SHA],
    );
    const logo = (
      await f.db.query(
        "insert into erp_company.logo(command_id,actor,request_hash,mime_type,size_bytes,sha256,status,finished_by,finished_at) values($1,$2,$3,'image/png',40,$3,'ready',$2,clock_timestamp()) returning id",
        [randomUUID(), f.users.admin, SHA],
      )
    ).rows[0].id;
    await f.sync();
    const files = (args) =>
      f.rpc("erp_files_list_v2", { p_user_id: f.users.admin, p_query: null, p_from: null, p_to: null, p_order: "data", p_origin: null, p_limit: 100, p_offset: 0, ...args });
    const all = parseFiles(await files({}), captureFilesQuery({}));
    assert.deepEqual(all.items.map((i) => i.origin).sort(), ["contatos", "documentos", "empresa", "financeiro", "produtos"]);
    assert.ok(!all.items.some((i) => i.id === gone));
    assert.ok(all.items.some((i) => i.id === kept));
    const byId = Object.fromEntries(all.items.map((i) => [i.origin, i]));
    assert.deepEqual(byId.documentos.source, { kind: "sales_orders", id: order.id, code: String(order.number), label: "Cliente Sintético Arquivos" });
    assert.deepEqual([byId.contatos.source.kind, byId.contatos.source.id, byId.contatos.source.label], ["contact_photo", contact.id, "Cliente Sintético Arquivos"]);
    assert.deepEqual([byId.financeiro.source.kind, byId.financeiro.source.id, byId.financeiro.source.label], ["title", title.id, "Conta com comprovante"]);
    assert.deepEqual([byId.produtos.source.kind, byId.produtos.source.id, byId.produtos.source.code], ["product", product.id, "IMG-1"]);
    assert.deepEqual([byId.empresa.filename, byId.empresa.source.kind, byId.empresa.source.id], ["logo.png", "logo", logo]);
    assert.equal(all.total_bytes, String(300 + 50 + 70 + 80 + 40));
    const size = parseFiles(await files({ p_order: "tamanho", p_limit: 2 }), captureFilesQuery({ order: "tamanho", limit: 2 }));
    assert.deepEqual([size.items.map((i) => i.size_bytes), size.total, size.has_more], [[300, 80], 5, true]);
    const byName = await files({ p_order: "nome" });
    assert.deepEqual(byName.items.map((i) => i.filename), ["anexo-boleto.pdf", "anexo-contrato.pdf", "anexo-foto.png", "anexo-imagem.jpg", "logo.png"]);
    const fin = parseFiles(
      await files({ p_query: "BOLETO ", p_from: today(), p_to: today(), p_order: "nome", p_origin: "financeiro", p_limit: 10 }),
      captureFilesQuery({ q: "boleto", from: today(), to: today(), order: "nome", origin: "financeiro", limit: 10 }),
    );
    assert.deepEqual(fin.items.map((i) => i.id), [finance]);
    assert.equal((await files({ p_from: "2026-01-01", p_to: "2026-01-02" })).total, 0);
    assert.equal((await files({ p_origin: "documentos" })).total, 1);
    assert.equal((await files({ p_offset: 4, p_limit: 10 })).items.length, 1);
    await fails(() => files({ p_user_id: f.users.financeiro }), "42501");
    for (const bad of [{ p_origin: "outros" }, { p_from: today() }, { p_order: "x" }, { p_limit: 0 }, { p_query: "a\u0001" }, { p_from: "2019-12-31", p_to: "2020-01-01" }])
      await fails(() => files(bad), "22023");
  } finally {
    await f.close();
  }
});

test("erp_history_backups e erp_preferences_import_job(s): leituras das linhas gravadas", async () => {
  const f = await dualFixture();
  try {
    await write(
      f,
      `insert into origin_backup.batch(backup_sha,manifest,status,created_at,finished_at) values
       ($1,'{"counts":{"xml":3,"issue":1}}','stored_with_issues','2026-10-01T10:00:00Z','2026-10-01T10:05:00Z'),
       ($2,'{"counts":{}}','uploading','2026-10-02T10:00:00Z',null),
       ($3,'{"counts":{"xml":"7"}}','stored','2026-10-02T10:00:00Z','2026-10-02T11:00:00Z')`,
      ["b".repeat(64), "c".repeat(64), "a".repeat(64)],
    );
    const backups = await f.rpc("erp_history_backups", { p_user_id: f.users.fiscal });
    assert.deepEqual(
      backups.items.map((b) => [b.id[0], b.xml_occurrences, b.issues, b.available]),
      [
        ["a", 7, 0, true],
        ["c", 0, 0, false],
        ["b", 3, 1, true],
      ],
    );
    await fails(() => f.rpc("erp_history_backups", { p_user_id: f.users.vendas }), "42501", "erp_access_denied");
    // Importações: uma do administrador e uma do estoque, com linhas válidas e inválidas.
    const mine = randomUUID(),
      theirs = randomUUID();
    await write(
      f,
      `insert into erp_preferences.import_job(id,kind,actor,file_name,total_rows,rows_done,created,updated,unchanged,invalid,status,created_at,updated_at,finished_at) values
       ($1,'products',$3,'produtos.xlsx',3,3,1,1,0,1,'concluida','2026-10-01T10:00:00Z','2026-10-01T10:01:00Z','2026-10-01T10:01:00Z'),
       ($2,'contacts',$4,'contatos.xlsx',2,1,1,0,0,0,'em_andamento','2026-10-02T10:00:00Z','2026-10-02T10:00:00Z',null)`,
      [mine, theirs, f.users.admin, f.users.estoque],
    );
    await write(
      f,
      `insert into erp_preferences.import_row(job_id,row,lines,command_id,status,action,reason,field,record_id,reference) values
       ($1,2,'{2}',$2,'created','create',null,null,$5,'P-1'),($1,3,'{3}',$3,'invalid',null,'erp_catalog_input_invalid','preco',null,'P-2'),($1,4,'{4,5}',$4,'updated','update',null,null,$6,'P-3')`,
      [mine, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
    const job = (args) => f.rpc("erp_preferences_import_job", { p_user_id: f.users.admin, p_job_id: mine, p_errors: false, p_limit: 2, p_offset: 0, ...args });
    const page = await job({});
    assert.deepEqual([page.total, page.has_more, page.items.map((i) => i.row), page.job.actor.label], [3, true, [2, 3], "Pessoa sintética admin"]);
    assert.deepEqual((await job({ p_errors: true })).items.map((i) => [i.row, i.field]), [[3, "preco"]]);
    assert.equal((await job({ p_offset: 2 })).has_more, false);
    await fails(() => job({ p_user_id: f.users.estoque }), "P0002", "erp_preferences_import_job_not_found");
    assert.equal((await job({ p_user_id: f.users.estoque, p_job_id: theirs })).job.status, "em_andamento");
    for (const bad of [{ p_limit: 0 }, { p_limit: 201 }, { p_offset: 10001 }, { p_errors: null }, { p_job_id: null }]) await fails(() => job(bad), "22023");
    await fails(() => job({ p_user_id: f.users.inactive }), "42501");
    const jobs = (args) => f.rpc("erp_preferences_import_jobs", { p_user_id: f.users.admin, p_status: null, p_limit: 10, p_offset: 0, ...args });
    const listed = await jobs({});
    assert.deepEqual([listed.total, listed.all_users, listed.items.map((j) => j.id)], [2, true, [theirs, mine]]);
    assert.deepEqual((await jobs({ p_status: "concluida" })).items.map((j) => j.id), [mine]);
    const other = await jobs({ p_user_id: f.users.estoque });
    assert.deepEqual([other.total, other.all_users, other.items.map((j) => j.id)], [1, false, [theirs]]);
    assert.deepEqual([(await jobs({ p_limit: 1 })).has_more, (await jobs({ p_limit: 1, p_offset: 1 })).has_more], [true, false]);
    for (const bad of [{ p_status: "x" }, { p_limit: 101 }, { p_offset: -1 }]) await fails(() => jobs(bad), "22023");
  } finally {
    await f.close();
  }
});

test("erp_wabotia_state: leitura, reserva com trava de 30 s, gravação só com a trava e liberação", async () => {
  const f = await dualFixture();
  try {
    const state = (args) => f.rpc("erp_wabotia_state", { p_action: "read", p_lock: null, p_cipher: null, ...args });
    assert.deepEqual(await state({}), { cipher: "" });
    const lock = randomUUID();
    assert.deepEqual(await state({ p_action: "reserve", p_lock: lock }), { acquired: true, cipher: "" });
    assert.deepEqual(await state({ p_action: "reserve", p_lock: randomUUID() }), { acquired: false, cipher: null });
    await fails(() => state({ p_action: "save", p_lock: randomUUID(), p_cipher: "x" }), "P0001", "pairing lock expired");
    assert.deepEqual(await state({ p_action: "save", p_lock: lock, p_cipher: "cifrado" }), { ok: true });
    assert.deepEqual(await state({}), { cipher: "cifrado" });
    assert.deepEqual(await state({ p_action: "release", p_lock: randomUUID() }), { ok: true });
    assert.deepEqual(await state({ p_action: "reserve", p_lock: randomUUID() }), { acquired: false, cipher: null });
    assert.deepEqual(await state({ p_action: "release", p_lock: lock }), { ok: true });
    await fails(() => state({ p_action: "save", p_lock: lock, p_cipher: "y" }), "P0001", "pairing lock expired");
    assert.deepEqual(await state({ p_action: "reserve", p_lock: randomUUID() }), { acquired: true, cipher: "cifrado" });
    await fails(() => state({ p_action: "reserve", p_lock: null }), "P0001", "invalid pairing operation");
    await fails(() => state({ p_action: "x" }), "P0001", "invalid pairing operation");
  } finally {
    await f.close();
  }
});
