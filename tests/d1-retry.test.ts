// Nova tentativa em erro transitório do D1 (src/db.ts): uma vez só, só
// leitura (ou lote que aceita repetir), com registro em log.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one, readOnlySql } from "../src/db";
import type { Env } from "../src/types";

const TRANSIENT = "D1_ERROR: Network connection lost.";

/** D1 que falha nas `failures` primeiras chamadas com a mensagem dada. */
function flaky(failures: number, message = TRANSIENT) {
  let calls = 0;
  const fail = () => {
    calls++;
    if (calls <= failures) throw new Error(message);
  };
  const db: any = env.DB;
  const wrapStmt = (stmt: any): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind")
          return (...a: any[]) => wrapStmt(target.bind(...a));
        if (["first", "all", "run", "raw"].includes(prop as string))
          return async (...a: any[]) => {
            fail();
            return target[prop](...a);
          };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const raw = new WeakMap<object, any>();
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          const s = target.prepare(sql);
          const p = wrapStmt(s);
          raw.set(p, s);
          return p;
        };
      if (prop === "batch")
        return async (stmts: any[]) => {
          fail();
          return target.batch(stmts.map((s) => raw.get(s) ?? s));
        };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB } as Env, calls: () => calls };
}

afterEach(() => vi.restoreAllMocks());

describe("nova tentativa de leitura no D1", () => {
  it("leitura falha uma vez por erro transitório: repete e registra", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = flaky(1);
    expect(await one(d.env, "SELECT 1 AS n")).toEqual({ n: 1 });
    expect(d.calls()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Network connection lost");
    const d2 = flaky(1);
    expect(
      await all(d2.env, "WITH x AS (SELECT 2 AS n) SELECT n FROM x"),
    ).toEqual([{ n: 2 }]);
  });

  it("só uma vez: duas falhas seguidas chegam a quem chamou", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = flaky(2);
    await expect(one(d.env, "SELECT 1")).rejects.toThrow(
      /Network connection lost/,
    );
    expect(d.calls()).toBe(2);
  });

  it("escrita e erro que não é transitório não repetem", async () => {
    const d = flaky(1);
    await expect(
      exec(d.env, "UPDATE instance_settings SET updated=updated WHERE key='x'"),
    ).rejects.toThrow();
    expect(d.calls()).toBe(1);
    // UPDATE … RETURNING lido por one() também é escrita.
    const d2 = flaky(1);
    await expect(
      one(
        d2.env,
        "UPDATE instance_settings SET updated=updated WHERE key='x' RETURNING key",
      ),
    ).rejects.toThrow();
    expect(d2.calls()).toBe(1);
    const d3 = flaky(1, "D1_ERROR: no such table: nada");
    await expect(one(d3.env, "SELECT * FROM nada")).rejects.toThrow(
      /no such table/,
    );
    expect(d3.calls()).toBe(1);
  });

  it("lote: só leitura repete; com escrita, só quando quem chama aceita", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reads = flaky(1);
    await batch(reads.env, [
      ["SELECT 1", []],
      ["SELECT 2", []],
    ]);
    expect(reads.calls()).toBe(2);
    const writes = flaky(1);
    await expect(
      batch(writes.env, [
        ["SELECT 1", []],
        ["UPDATE instance_settings SET updated=updated WHERE key='x'", []],
      ]),
    ).rejects.toThrow();
    expect(writes.calls()).toBe(1);
    const accepted = flaky(1);
    await batch(
      accepted.env,
      [["UPDATE instance_settings SET updated=updated WHERE key='x'", []]],
      { retry: true },
    );
    expect(accepted.calls()).toBe(2);
  });

  it("classificação de leitura", () => {
    expect(readOnlySql("SELECT * FROM a")).toBe(true);
    expect(readOnlySql("  with x as (select 1) select * from x")).toBe(true);
    expect(
      readOnlySql("WITH x AS (SELECT 1) INSERT INTO a SELECT * FROM x"),
    ).toBe(false);
    expect(readOnlySql("INSERT INTO a VALUES(1)")).toBe(false);
    expect(readOnlySql("UPDATE a SET b=1 RETURNING b")).toBe(false);
  });
});
