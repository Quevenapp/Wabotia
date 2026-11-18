// Gatilhos de imutabilidade do CNAB que viram gatilhos do SQLite pelo override
// sqlTriggers (scripts/erp/overrides/cnab.mjs; gen-sqlite.mjs,
// sqlTriggerFromOverride): o mesmo UPDATE/DELETE direto nos dois motores dá o
// mesmo resultado ou o mesmo erro.
//   purpose_immutable (remittance, return_file, return_event): purpose não muda → 40001;
//   operational_evidence_immutable (return_file, return_event): linha operacional não muda nem sai → 42501;
//   operational_occurrence_immutable (return_occurrence): ocorrência de arquivo operacional idem → 42501.
// Com dois gatilhos na mesma linha (mudar o purpose de um arquivo operacional),
// vale o primeiro na ordem do nome, como no Postgres.
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";

let f, profile;
const H = (c) => c.repeat(64);
before(async () => {
  f = await dualFixture();
  profile = randomUUID();
  await seed(
    `insert into erp_cnab.profile(id,account_id,identity,settings,account_scope,next_sequence) values($1,$2,'{}','{}','bank',1)`,
    [profile, randomUUID()],
  );
});
after(async () => f?.close());

/** Escrita direta sem os gatilhos (como a semeadura do harness), espelhada no SQLite. */
async function seed(sql, args) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}
async function remittance(purpose) {
  const id = randomUUID();
  await seed(
    `insert into erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor,purpose) values($1,$2,(select coalesce(max(sequence),0)+1 from erp_cnab.remittance),'2026-11-17','{}',$3,$4)`,
    [id, profile, f.users.admin, purpose],
  );
  return id;
}
async function file(purpose) {
  const id = randomUUID();
  await seed(
    `insert into erp_cnab.return_file(id,profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor,purpose)
     values($1,$2,$3,'cnab/retorno.ret',100,'2026-11-17',20,2,'[]','{}',$4,$5)`,
    [id, profile, H(id[0] === "a" ? "b" : "a").slice(0, 56) + id.replace(/-/g, "").slice(0, 8), f.users.admin, purpose],
  );
  return id;
}
async function event(purpose) {
  const id = randomUUID();
  await seed(
    `insert into erp_cnab.return_event(id,profile_id,event_hash,payload,proposed_action,reason,purpose) values($1,$2,$3,'{}','ignore','sintético',$4)`,
    [id, profile, "c".repeat(56) + id.replace(/-/g, "").slice(0, 8), purpose],
  );
  return id;
}
/** Ocorrência na linha 2 do arquivo (chave: file_id, line). */
async function occurrence(fileId, eventId) {
  await seed(`insert into erp_cnab.return_occurrence(file_id,line,event_id,line_hash,duplicate) values($1,2,$2,$3,false)`, [
    fileId, eventId, "d".repeat(56) + fileId.replace(/-/g, "").slice(0, 8),
  ]);
  return fileId;
}

/** O mesmo SQL direto nos dois motores (tabela "erp_cnab.x" no Postgres, "erp_cnab__x" no SQLite). */
async function same(label, statement) {
  const lite = statement.replace(/erp_cnab\.([a-z_]+)/g, '"erp_cnab__$1"');
  try {
    await f.dual(
      label,
      async () => {
        await f.db.query(statement);
        return "ok";
      },
      () =>
        inTransaction(f.driver, (ctx) => {
          ctx.db.exec(lite);
          return "ok";
        }),
    );
    return "ok";
  } catch (e) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return `${e.code}:${e.message}`;
  }
}
const expect = (got, want) => {
  if (got !== want) throw new Error(`esperado ${want}, veio ${got}`);
};

test("purpose_immutable: o propósito da remessa, do arquivo e do evento não muda", async () => {
  const r = await remittance("homologation");
  expect(await same("remessa purpose", `update erp_cnab.remittance set purpose='operational' where id='${r}'`), "40001:erp_cnab_purpose_immutable");
  expect(await same("remessa outro campo", `update erp_cnab.remittance set snapshot='{"x":1}' where id='${r}'`), "ok");
  const fh = await file("homologation");
  expect(await same("arquivo purpose", `update erp_cnab.return_file set purpose='operational' where id='${fh}'`), "40001:erp_cnab_purpose_immutable");
  const eh = await event("homologation");
  expect(await same("evento purpose", `update erp_cnab.return_event set purpose='operational' where id='${eh}'`), "40001:erp_cnab_purpose_immutable");
});

test("operational_evidence_immutable: arquivo e evento operacionais não mudam nem saem", async () => {
  const fo = await file("operational");
  const eo = await event("operational");
  for (const [label, sql] of [
    ["arquivo operacional update", `update erp_cnab.return_file set warnings='["x"]' where id='${fo}'`],
    ["arquivo operacional delete", `delete from erp_cnab.return_file where id='${fo}'`],
    ["evento operacional update", `update erp_cnab.return_event set reason='outro' where id='${eo}'`],
    ["evento operacional delete", `delete from erp_cnab.return_event where id='${eo}'`],
  ])
    expect(await same(label, sql), "42501:erp_cnab_operational_evidence_immutable");
  // Dois gatilhos na linha: cnab_return_purpose_immutable vem antes de operational_return_file_immutable.
  expect(await same("arquivo operacional purpose", `update erp_cnab.return_file set purpose='homologation' where id='${fo}'`), "40001:erp_cnab_purpose_immutable");
  expect(await same("evento operacional purpose", `update erp_cnab.return_event set purpose='homologation' where id='${eo}'`), "40001:erp_cnab_purpose_immutable");
  // Homologação muda e sai.
  const fh = await file("homologation");
  const eh = await event("homologation");
  expect(await same("arquivo homologação update", `update erp_cnab.return_file set warnings='["x"]' where id='${fh}'`), "ok");
  expect(await same("evento homologação delete", `delete from erp_cnab.return_event where id='${eh}'`), "ok");
});

test("operational_occurrence_immutable: ocorrência de arquivo operacional não muda nem sai", async () => {
  // Evento do mesmo propósito do arquivo (cnab_occurrence_purpose, ainda em
  // TS no CNAB da G, recusaria antes a mistura no Postgres).
  const fo = await file("operational");
  const fh = await file("homologation");
  const oo = await occurrence(fo, await event("operational"));
  const oh = await occurrence(fh, await event("homologation"));
  expect(await same("ocorrência operacional update", `update erp_cnab.return_occurrence set duplicate=true where file_id='${oo}'`), "42501:erp_cnab_operational_evidence_immutable");
  expect(await same("ocorrência operacional delete", `delete from erp_cnab.return_occurrence where file_id='${oo}'`), "42501:erp_cnab_operational_evidence_immutable");
  expect(await same("ocorrência homologação update", `update erp_cnab.return_occurrence set duplicate=true where file_id='${oh}'`), "ok");
  expect(await same("ocorrência homologação delete", `delete from erp_cnab.return_occurrence where file_id='${oh}'`), "ok");
});
