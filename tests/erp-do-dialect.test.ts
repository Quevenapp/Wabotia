// Fase 0 do ERP, prova 1: sonda do dialeto SQLite numa instância
// "erp:<área>" da classe Coordinator (ctx.storage.sql, no workerd). Cada item
// grava o comportamento observado; as asserções fixam o que as regras de
// conversão (PLANO-FAGOO-MOTOR.md, seção 3) assumem. Resultado em
// docs/ERP-FASE0.md.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";

type Probe = Record<string, unknown>;

const attempt = (fn: () => unknown) => {
  try {
    return { ok: true, value: fn() };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
};

export async function probeDialect(): Promise<Probe> {
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:" + uid()));
  return runInDurableObject(stub, (_instance: any, state: DurableObjectState) => {
    const storage = state.storage;
    const sql = storage.sql;
    const rows = (q: string, ...args: any[]) => sql.exec(q, ...args).toArray();
    const out: Probe = {};

    // 1. STRICT
    sql.exec("CREATE TABLE p_strict(id INTEGER PRIMARY KEY, n INTEGER NOT NULL, t TEXT) STRICT");
    out.strict_ok = attempt(() => sql.exec("INSERT INTO p_strict(n,t) VALUES(?,?)", 1, "a").rowsWritten);
    out.strict_rejects_text_in_integer = attempt(() =>
      sql.exec("INSERT INTO p_strict(n,t) VALUES(?,?)", "abc", "a"),
    );
    out.strict_coerces_numeric_text = attempt(() => {
      sql.exec("INSERT INTO p_strict(n,t) VALUES(?,?)", "42", "b");
      return rows("SELECT typeof(n) ty, n FROM p_strict WHERE t='b'");
    });
    out.strict_rejects_real_in_integer = attempt(() =>
      sql.exec("INSERT INTO p_strict(n,t) VALUES(?,?)", 1.5, "c"),
    );

    // 2. Gatilho com RAISE(ABORT, código)
    sql.exec(
      "CREATE TRIGGER p_strict_immutable BEFORE UPDATE OF n ON p_strict WHEN OLD.n=1 BEGIN SELECT RAISE(ABORT,'erp_immutable:p_strict'); END",
    );
    out.trigger_raise = attempt(() => sql.exec("UPDATE p_strict SET n=2 WHERE n=1"));
    out.trigger_left_row = rows("SELECT n FROM p_strict WHERE t='a'");

    // 3. Índice parcial e coluna gerada
    sql.exec(
      "CREATE TABLE p_doc(id TEXT PRIMARY KEY, status TEXT NOT NULL, total INTEGER NOT NULL, qty INTEGER NOT NULL, doubled INTEGER GENERATED ALWAYS AS (total*2) VIRTUAL, label TEXT GENERATED ALWAYS AS (status || ':' || id) STORED) STRICT",
    );
    sql.exec("CREATE UNIQUE INDEX p_doc_one_open ON p_doc(status) WHERE status='open'");
    sql.exec("INSERT INTO p_doc(id,status,total,qty) VALUES('a','open',10,1),('b','closed',5,1),('c','closed',7,1)");
    out.partial_index_blocks_second_open = attempt(() =>
      sql.exec("INSERT INTO p_doc(id,status,total,qty) VALUES('d','open',1,1)"),
    );
    out.generated_columns = rows("SELECT id,doubled,label FROM p_doc ORDER BY id");
    out.partial_index_used = rows("EXPLAIN QUERY PLAN SELECT id FROM p_doc WHERE status='open'");

    // 4. JSON: ->> e json_each
    out.json_arrow = rows(`SELECT '{"a":{"b":"12.50"},"n":3}' ->> '$.a.b' v, '{"n":3}' ->> 'n' n, '{"n":3}' -> 'n' raw`);
    out.json_each = rows("SELECT value FROM json_each(?) ORDER BY value", JSON.stringify(["b", "a", "c"]));
    out.json_each_in = rows("SELECT id FROM p_doc WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(["a", "c", "zz"]));
    out.json_valid_check = attempt(() => {
      sql.exec("CREATE TABLE p_json(id INTEGER PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body))) STRICT");
      sql.exec("INSERT INTO p_json(body) VALUES('{\"ok\":true}')");
      return sql.exec("INSERT INTO p_json(body) VALUES('{nope')").rowsWritten;
    });

    // 5. transactionSync aninhado com reversão parcial
    sql.exec("CREATE TABLE p_tx(id INTEGER PRIMARY KEY, v TEXT) STRICT");
    out.tx_nested = attempt(() =>
      storage.transactionSync(() => {
        sql.exec("INSERT INTO p_tx(v) VALUES('outer-1')");
        const inner = attempt(() =>
          storage.transactionSync(() => {
            sql.exec("INSERT INTO p_tx(v) VALUES('inner')");
            throw new Error("desfaz só o de dentro");
          }),
        );
        sql.exec("INSERT INTO p_tx(v) VALUES('outer-2')");
        return inner;
      }),
    );
    out.tx_nested_rows = rows("SELECT v FROM p_tx ORDER BY id");
    out.tx_outer_rollback = attempt(() =>
      storage.transactionSync(() => {
        sql.exec("INSERT INTO p_tx(v) VALUES('lost')");
        throw new Error("desfaz tudo");
      }),
    );
    out.tx_outer_rows = rows("SELECT v FROM p_tx ORDER BY id");
    out.savepoint_statement = attempt(() => sql.exec("SAVEPOINT s1"));
    out.begin_statement = attempt(() => sql.exec("BEGIN"));
    out.tx_returns_value = attempt(() => storage.transactionSync(() => 7));

    // 6. i64 exato
    sql.exec("CREATE TABLE p_big(id INTEGER PRIMARY KEY, v INTEGER NOT NULL) STRICT");
    const big = "9007199254740993"; // 2^53 + 1
    out.i64_from_text = attempt(() => {
      sql.exec("INSERT INTO p_big(v) VALUES(?)", big);
      return rows("SELECT typeof(v) ty, CAST(v AS TEXT) s, v FROM p_big");
    });
    out.i64_bigint_param = attempt(() => sql.exec("INSERT INTO p_big(v) VALUES(?)", BigInt(big)).rowsWritten);
    out.i64_max = attempt(() => {
      sql.exec("INSERT INTO p_big(v) VALUES(?)", "9223372036854775807");
      return rows("SELECT CAST(v AS TEXT) s FROM p_big WHERE v > ?", "9007199254740993");
    });
    out.i64_sum_as_text = rows("SELECT CAST(SUM(v) AS TEXT) s, typeof(SUM(v)) ty FROM p_big WHERE v < 9223372036854775807");
    out.i64_overflow_sum = attempt(() => rows("SELECT SUM(v) FROM p_big"));
    out.i64_compare_text_param = rows("SELECT count(*) n FROM p_big WHERE v = ?", big);
    out.i64_read_number_lossy = rows("SELECT v FROM p_big WHERE v = ?", big);

    // 8. Limites: parâmetros, LIKE, argumentos de função, tamanho
    const params = (n: number) => Array.from({ length: n }, (_, i) => i);
    const values = (n: number) =>
      `SELECT count(*) n, sum(column1) s FROM (VALUES ${params(n).map(() => "(?)").join(",")})`;
    out.params_100 = attempt(() => rows(values(100), ...params(100)));
    out.params_101 = attempt(() => rows(values(101), ...params(101)));
    out.expression_depth_101 = attempt(() => rows(`SELECT ${params(101).map(() => "?").join("+")} s`, ...params(101)));
    out.in_list_100 = attempt(() => rows(`SELECT 5 IN (${params(100).map(() => "?").join(",")}) v`, ...params(100)));
    out.json_each_10000 = attempt(() => rows("SELECT count(*) n, sum(value) s FROM json_each(?)", JSON.stringify(params(10000))));
    out.like_50 = attempt(() => rows("SELECT 'x' LIKE ? v", "%" + "a".repeat(48) + "%"));
    out.like_51 = attempt(() => rows("SELECT 'x' LIKE ? v", "%" + "a".repeat(60) + "%"));
    out.function_args_32 = attempt(() => rows(`SELECT json_array(${params(32).join(",")}) v`));
    out.function_args_33 = attempt(() => rows(`SELECT json_array(${params(40).join(",")}) v`));
    out.blob_2mb = attempt(() => {
      sql.exec("CREATE TABLE p_blob(id INTEGER PRIMARY KEY, b TEXT) STRICT");
      return sql.exec("INSERT INTO p_blob(b) VALUES(?)", "x".repeat(2 * 1024 * 1024)).rowsWritten;
    });

    // Extras usados pelo conversor
    out.cursor_counters = attempt(() => {
      const c = sql.exec("SELECT * FROM p_doc");
      c.toArray();
      return { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten };
    });
    out.returning = attempt(() => rows("INSERT INTO p_tx(v) VALUES('ret') RETURNING id, v"));
    out.upsert = attempt(() => rows("INSERT INTO p_doc(id,status,total,qty) VALUES('b','closed',99,1) ON CONFLICT(id) DO UPDATE SET total=excluded.total RETURNING total"));
    out.window_fn = attempt(() => rows("SELECT id, sum(total) OVER (ORDER BY id) run FROM p_doc ORDER BY id"));
    out.cte_recursive = attempt(() => rows("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5) SELECT sum(i) s FROM n"));
    out.lower_unicode = rows("SELECT lower('ÁÉÇ') l, upper('ação') u, 'é' < 'f' cmp");
    out.math_functions = attempt(() => rows("SELECT floor(2.5) f, ceil(2.1) c"));
    out.strftime_unixepoch = attempt(() => rows("SELECT unixepoch('2026-11-16 12:00:00') e"));
    out.collate_nocase_unicode = rows("SELECT 'Ação' = 'AÇÃO' COLLATE NOCASE eq");
    out.pragma_table_list = attempt(() => rows("PRAGMA table_list").length);
    out.pragma_user_version = attempt(() => rows("PRAGMA user_version"));
    out.database_size = storage.sql.databaseSize;
    return out;
  });
}

/**
 * FKs: cada caso numa instância nova, porque uma violação que chega ao fim
 * da invocação reinicia o objeto (desfaz tudo o que a invocação gravou).
 * Devolve o que a função devolveu, o erro de dentro, ou o erro do reinício,
 * e o que ficou gravado numa leitura seguinte.
 */
export async function probeForeignKeys() {
  const setup = (sql: SqlStorage) => {
    sql.exec("CREATE TABLE IF NOT EXISTS p_parent(id TEXT PRIMARY KEY) STRICT");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS p_child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES p_parent(id)) STRICT",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS p_child2(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES p_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS p_mark(id INTEGER PRIMARY KEY, v TEXT) STRICT");
  };
  const cases: Record<string, (s: DurableObjectStorage) => unknown> = {
    pragma_foreign_keys: (s) => s.sql.exec("PRAGMA foreign_keys").toArray(),
    // Fora de transactionSync: a instrução falha na hora?
    violation_autocommit: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      return s.sql.exec("INSERT INTO p_child VALUES('c1','missing')").rowsWritten;
    },
    // Violação capturada pelo código, sem desfazer: o que acontece no fim?
    violation_caught_autocommit: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      try {
        s.sql.exec("INSERT INTO p_child VALUES('c1','missing')");
      } catch (e) {
        return "capturado: " + String((e as Error).message).slice(0, 120);
      }
      return "sem erro na instrução";
    },
    violation_in_tx: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      return attempt(() =>
        s.transactionSync(() => s.sql.exec("INSERT INTO p_child VALUES('c1','missing')")),
      );
    },
    deferred_pragma_fixed: (s) =>
      attempt(() =>
        s.transactionSync(() => {
          s.sql.exec("PRAGMA defer_foreign_keys = ON");
          s.sql.exec("INSERT INTO p_child VALUES('c2','later')");
          s.sql.exec("INSERT INTO p_parent VALUES('later')");
          return "ok";
        }),
      ),
    deferred_pragma_unfixed: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      return attempt(() =>
        s.transactionSync(() => {
          s.sql.exec("PRAGMA defer_foreign_keys = ON");
          s.sql.exec("INSERT INTO p_child VALUES('c3','never')");
        }),
      );
    },
    // Alternativa segura: conferir antes do fim e lançar dentro da transação.
    deferred_checked_before_commit: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      return attempt(() =>
        s.transactionSync(() => {
          s.sql.exec("PRAGMA defer_foreign_keys = ON");
          s.sql.exec("INSERT INTO p_child VALUES('c4','never')");
          const broken = s.sql.exec("PRAGMA foreign_key_check").toArray();
          if (broken.length) throw new Error("fk_violation:" + JSON.stringify(broken[0]));
        }),
      );
    },
    deferrable_ddl_unfixed: (s) => {
      s.sql.exec("INSERT INTO p_mark(v) VALUES('antes')");
      return attempt(() =>
        s.transactionSync(() => s.sql.exec("INSERT INTO p_child2 VALUES('y','never2')")),
      );
    },
    deferrable_ddl_fixed: (s) =>
      attempt(() =>
        s.transactionSync(() => {
          s.sql.exec("INSERT INTO p_child2 VALUES('x','later2')");
          s.sql.exec("INSERT INTO p_parent VALUES('later2')");
          return "ok";
        }),
      ),
    delete_parent_in_use: (s) => {
      s.sql.exec("INSERT INTO p_parent VALUES('p')");
      s.sql.exec("INSERT INTO p_child VALUES('k','p')");
      return attempt(() => s.transactionSync(() => s.sql.exec("DELETE FROM p_parent WHERE id='p'")));
    },
  };
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(cases)) {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:fk:" + uid()));
    let result: unknown;
    try {
      result = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
        setup(state.storage.sql);
        return fn(state.storage);
      });
    } catch (error: any) {
      result = { invocation_error: String(error?.message || error).slice(0, 220) };
    }
    let after: unknown;
    try {
      after = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
        const sql = state.storage.sql;
        const has = sql
          .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='p_mark'")
          .toArray().length;
        if (!has) return { tables: "nenhuma (tudo desfeito)" };
        return {
          marks: sql.exec("SELECT v FROM p_mark").toArray().map((r) => r.v),
          children: sql.exec("SELECT id FROM p_child UNION ALL SELECT id FROM p_child2").toArray().map((r) => r.id),
        };
      });
    } catch (error: any) {
      after = { read_error: String(error?.message || error).slice(0, 160) };
    }
    out[name] = { result, after };
  }
  return out;
}

describe("ERP fase 0: sonda de dialeto no objeto", () => {
  it("FKs: imediatas falham na instrução; adiadas sem correção reiniciam o objeto", async () => {
    const r: any = await probeForeignKeys();
    if (process.env.ERP_PROBE_PRINT) console.log("ERP_FK " + JSON.stringify(r, null, 1));
    const reset = /Durable Object was reset and rolled back/;
    expect(r.pragma_foreign_keys.result).toEqual([{ foreign_keys: 1 }]);
    // Imediata: a instrução falha, o resto da invocação fica.
    expect(r.violation_autocommit.result.invocation_error).toMatch(/FOREIGN KEY constraint failed/);
    expect(r.violation_autocommit.after).toEqual({ marks: ["antes"], children: [] });
    expect(r.violation_caught_autocommit.result).toMatch(/^capturado: FOREIGN KEY/);
    expect(r.violation_in_tx.result).toMatchObject({ ok: false });
    expect(r.delete_parent_in_use.result).toMatchObject({ ok: false });
    // Adiada e corrigida dentro da transação: passa.
    expect(r.deferred_pragma_fixed.result).toEqual({ ok: true, value: "ok" });
    expect(r.deferrable_ddl_fixed.result).toEqual({ ok: true, value: "ok" });
    // Adiada sem correção: o commit reinicia o objeto e desfaz a invocação.
    expect(r.deferred_pragma_unfixed.result.invocation_error).toMatch(reset);
    expect(r.deferrable_ddl_unfixed.result.invocation_error).toMatch(reset);
    // Conferir com PRAGMA foreign_key_check e lançar dentro da transação:
    // desfaz só a transação, sem reinício.
    expect(r.deferred_checked_before_commit.result.error).toMatch(/^fk_violation:/);
    expect(r.deferred_checked_before_commit.after).toEqual({ marks: ["antes"], children: [] });
  });

  it("STRICT, gatilhos, índice parcial, coluna gerada, JSON, transações, i64 e limites", async () => {
    const r: any = await probeDialect();
    if (process.env.ERP_PROBE_PRINT) console.log("ERP_DIALECT " + JSON.stringify(r, null, 1));
    // STRICT: texto numérico vira inteiro; texto e real em INTEGER, não.
    expect(r.strict_rejects_text_in_integer.error).toMatch(/SQLITE_CONSTRAINT_DATATYPE/);
    expect(r.strict_coerces_numeric_text.value).toEqual([{ ty: "integer", n: 42 }]);
    expect(r.strict_rejects_real_in_integer.error).toMatch(/cannot store REAL/);
    // RAISE(ABORT, código): a mensagem começa pelo código.
    expect(r.trigger_raise.error).toMatch(/^erp_immutable:p_strict: SQLITE_CONSTRAINT/);
    expect(r.trigger_left_row).toEqual([{ n: 1 }]);
    expect(r.partial_index_blocks_second_open.error).toMatch(/UNIQUE constraint failed/);
    expect(r.partial_index_used[0].detail).toContain("p_doc_one_open");
    expect(r.generated_columns[0]).toEqual({ id: "a", doubled: 20, label: "open:a" });
    // JSON
    expect(r.json_arrow).toEqual([{ v: "12.50", n: 3, raw: "3" }]);
    expect(r.json_each_in.map((x: any) => x.id)).toEqual(["a", "c"]);
    expect(r.json_valid_check.error).toMatch(/CHECK constraint failed: json_valid/);
    // transactionSync aninhado: o de dentro desfaz só a sua parte.
    expect(r.tx_nested).toEqual({ ok: true, value: { ok: false, error: "desfaz só o de dentro" } });
    expect(r.tx_nested_rows.map((x: any) => x.v)).toEqual(["outer-1", "outer-2"]);
    expect(r.tx_outer_rows.map((x: any) => x.v)).toEqual(["outer-1", "outer-2"]);
    expect(r.savepoint_statement.error).toMatch(/transactionSync/);
    expect(r.begin_statement.error).toMatch(/transactionSync/);
    expect(r.tx_returns_value).toEqual({ ok: true, value: 7 });
    // i64: grava de texto, lê como TEXT; como número perde precisão sem erro.
    expect(r.i64_from_text.value).toEqual([
      { ty: "integer", s: "9007199254740993", v: 9007199254740992 },
    ]);
    expect(r.i64_bigint_param.error).toMatch(/BigInt/);
    expect(r.i64_max.value).toEqual([{ s: "9223372036854775807" }]);
    expect(r.i64_overflow_sum.error).toMatch(/integer overflow/);
    expect(r.i64_compare_text_param).toEqual([{ n: 1 }]);
    // Limites
    expect(r.params_100.value).toEqual([{ n: 100, s: 4950 }]);
    expect(r.params_101.error).toMatch(/too many SQL variables/);
    expect(r.expression_depth_101.error).toMatch(/maximum depth 100/);
    expect(r.json_each_10000.value).toEqual([{ n: 10000, s: 49995000 }]);
    expect(r.like_50.ok).toBe(true);
    expect(r.like_51.error).toMatch(/LIKE or GLOB pattern too complex/);
    expect(r.blob_2mb).toEqual({ ok: true, value: 1 });
    expect(r.cursor_counters.value).toEqual({ rowsRead: 3, rowsWritten: 0 });
    // Texto: lower/upper e NOCASE só ASCII.
    expect(r.lower_unicode).toEqual([{ l: "ÁÉÇ", u: "AçãO", cmp: 0 }]);
    expect(r.collate_nocase_unicode).toEqual([{ eq: 0 }]);
    expect(r.pragma_user_version.error).toMatch(/not authorized/);
    for (const k of ["returning", "upsert", "window_fn", "cte_recursive", "math_functions", "strftime_unixepoch"])
      expect(r[k].ok, k).toBe(true);
  });
});
