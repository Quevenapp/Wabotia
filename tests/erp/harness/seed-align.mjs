// Alinhamento da semeadura no início da fixture dupla (pedido da P).
//
// Algumas migrações do Fagoo semeiam com gen_random_uuid() (por exemplo
// erp_catalog.contact_type e erp_a1.installation): o Postgres do oráculo
// tem ids novos a cada criação, e a semeadura do SQLite
// (seed.generated.ts) tem os ids da hora em que foi gerada. O espelho só
// copia tabela alterada, então essas tabelas começavam diferentes e os
// vínculos copiados do Postgres apontavam para linhas inexistentes.
//
// O que se faz: compara TODAS as tabelas com linhas (em qualquer lado),
// com a mesma correspondência de ids livres do comparador
// (state-compare.mjs). Só id que existe num lado só pode ser ligado, e só
// se a bijeção deixar as tabelas idênticas. Diferença que sobra é
// semeadura desalinhada: a fixture para. As tabelas que só diferem nos ids
// são copiadas do Postgres.
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import { ERP_DEVIATIONS, liteValue } from "../../../src/erp/schema/deviations.ts";
import { derivedIds } from "./derived-ids.mjs";
import { IdMap, compareState, loadTables } from "./state-compare.mjs";

const q = (id) => `"${id.replace(/"/g, '""')}"`;
const NORMALIZED = ["fold", "computed"];

/**
 * Lacuna conhecida, fora da pasta do harness: scripts/erp/gen-sqlite-lib.mjs
 * (seed e espelho) filtra as colunas normalizadas e calculadas, então a
 * semeadura de produção grava NULL em, por exemplo,
 * erp_catalog__contact_type.label__fold dos tipos do sistema. Consulta pela
 * coluna __fold não acha essas linhas (rótulo "Cliente" repetido passaria).
 * Pedido à N. Enquanto true, o alinhamento aceita essas colunas NULL no
 * SQLite e as preenche a partir do Postgres; tests/erp/harness.test.mjs
 * confere que a lacuna ainda existe (quando a semeadura for corrigida, o
 * teste manda pôr false).
 */
export const SEED_LEAVES_NORMALIZED_NULL = false;

/**
 * Colunas que o Fagoo semeia com uuid aleatório (as únicas da semeadura com
 * uuid, conferido em 16/11). Só ids delas (e de quem aponta para elas) são
 * alinhados; outro id da semeadura diferente entre os motores (um uuid fixo
 * que mudou e o seed.generated.ts que ficou para trás, por exemplo) é
 * divergência. Migração nova que semeie com gen_random_uuid() aparece como
 * divergência aqui e entra na lista, com a origem.
 */
export const RANDOM_SEED_COLUMNS = {
  // 202610160006_erp_catalog.sql e 202610200124_contact_profile.sql: insert sem id (default gen_random_uuid()).
  erp_catalog__contact_type: ["id"],
  // 202610160041_a1_custody.sql: vault_id uuid default gen_random_uuid(), insert só com singleton.
  erp_a1__installation: ["vault_id"],
};

/** Os gatilhos gerados (imutabilidade) não valem para escrita do harness: saem e voltam iguais. */
export function withoutTriggers(lite, t, fn) {
  const triggers = lite.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='trigger' AND tbl_name=?").all(t);
  for (const g of triggers) lite.exec(`DROP TRIGGER main.${q(g.name)}`);
  try {
    return fn();
  } finally {
    for (const g of triggers) lite.exec(g.sql);
  }
}

/**
 * Desvios deliberados (src/erp/schema/deviations.ts): o valor do Wabotia nos
 * dois motores, sem gatilhos de guarda. Os aplicados já estão na semeadura
 * do SQLite (o UPDATE não muda nada); os forçados por teste entram aqui.
 */
export async function applyDeviationsBoth(pg, lite, deviations = ERP_DEVIATIONS.filter((d) => d.applied)) {
  if (!deviations.length) return;
  await pg.exec("set session_replication_role = replica");
  try {
    for (const d of deviations) {
      const info = ERP_TABLES[d.table];
      const codec = info.columns[d.column].codec;
      const keys = Object.keys(d.key);
      const value = codec === "json" ? JSON.stringify(d.value) : d.value;
      const r = await pg.query(
        `update ${q(info.schema)}.${q(info.table)} set ${q(d.column)}=$1${codec === "json" ? "::jsonb" : ""} where ${keys.map((k, i) => `${q(k)}=$${i + 2}`).join(" and ")}`,
        [value, ...keys.map((k) => d.key[k])],
      );
      if (r.affectedRows !== 1) throw new Error(`Desvio ${d.id}: ${r.affectedRows} linhas no Postgres.`);
      const changes = withoutTriggers(lite, d.table, () =>
        lite
          .prepare(`UPDATE ${q(d.table)} SET ${q(d.column)}=? WHERE ${keys.map((k) => `${q(k)}=?`).join(" AND ")}`)
          .run(liteValue(codec, d.value), ...keys.map((k) => (typeof d.key[k] === "boolean" ? Number(d.key[k]) : d.key[k]))).changes,
      );
      if (Number(changes) !== 1) throw new Error(`Desvio ${d.id}: ${changes} linhas no SQLite.`);
    }
  } finally {
    await pg.exec("set session_replication_role = origin");
  }
}

async function pgCounts(pg) {
  const sql = Object.entries(ERP_TABLES)
    .map(([t, i]) => `select '${t}' t, count(*)::int n from ${q(i.schema)}.${q(i.table)}`)
    .join(" union all ");
  return new Map((await pg.query(sql)).rows.map((r) => [r.t, Number(r.n)]));
}

/**
 * Diferenças da semeadura: { diffs (vazio: alinhável), align (tabelas a
 * copiar do Postgres), gaps (colunas normalizadas NULL na semeadura) }.
 */
export async function seedDifferences(pg, lite, { specs = derivedIds(), allowNormalizedGap = SEED_LEAVES_NORMALIZED_NULL } = {}) {
  const counts = await pgCounts(pg);
  const tables = Object.keys(ERP_TABLES).filter(
    (t) => counts.get(t) > 0 || Number(lite.prepare(`SELECT count(*) AS n FROM ${q(t)}`).get().n) > 0,
  );
  const data = await loadTables(pg, lite, tables);
  const gaps = [];
  for (const t of tables) {
    const d = data[t];
    for (const [n, c] of Object.entries(ERP_TABLES[t].columns)) {
      if (!NORMALIZED.includes(c.codec)) continue;
      if (d.lite.length && d.lite.every((r) => r[n] === null) && d.pg.some((r) => r[n] !== null)) {
        gaps.push(`${t}.${n}`);
        if (allowNormalizedGap) for (const r of [...d.pg, ...d.lite]) delete r[n];
      }
    }
  }
  const ids = new IdMap();
  const { diffs, withFree } = compareState(data, ids, { specs });
  const random = new Set();
  for (const [t, cols] of Object.entries(RANDOM_SEED_COLUMNS))
    for (const r of data[t]?.pg ?? []) for (const c of cols) if (r[c]) random.add(String(r[c]).toLowerCase());
  for (const [p, l] of ids.pgToLite)
    if (!random.has(p)) {
      const where = tables.filter((t) => data[t].pg.some((r) => JSON.stringify(r).toLowerCase().includes(p)));
      diffs.push({ table: where.join(","), pg: p, lite: l, why: "id da semeadura difere entre os motores fora das colunas aleatórias declaradas (RANDOM_SEED_COLUMNS)" });
    }
  const align = [...new Set([...withFree, ...(allowNormalizedGap ? gaps.map((g) => g.split(".")[0]) : [])])];
  return { diffs, align, gaps, tables };
}
