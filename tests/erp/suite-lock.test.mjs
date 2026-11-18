// Trava da suíte completa (scripts/erp/suite-lock.mjs): vaga de dono morto
// volta; a rodada do tronco tem vaga própria; sem vaga, espera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSuiteSlot } from "../../scripts/erp/suite-lock.mjs";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "suite-lock-"));
  process.env.ERP_SUITE_LOCK_DIR = dir;
  return dir;
};
const owner = (pid, since = new Date().toISOString()) => JSON.stringify({ pid, host: hostname(), worktree: "x", branch: "y", label: "z", since });

test("vaga de processo que não existe mais é liberada", async () => {
  const dir = fresh();
  delete process.env.ERP_TRUNK_ROUND;
  writeFileSync(join(dir, "slot-1.json"), owner(2147483646));
  const release = await acquireSuiteSlot("teste");
  assert.equal(JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8")).pid, process.pid);
  release();
  assert.equal(existsSync(join(dir, "slot-1.json")), false);
});

test("vaga com mais de 90 min é liberada; a rodada do tronco tem a vaga dela", async () => {
  const dir = fresh();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"]);
  try {
    writeFileSync(join(dir, "slot-1.json"), owner(sleeper.pid));
    writeFileSync(join(dir, "slot-2.json"), owner(sleeper.pid, new Date(Date.now() - 91 * 60000).toISOString()));
    delete process.env.ERP_TRUNK_ROUND;
    const old = await acquireSuiteSlot("teste");
    assert.equal(JSON.parse(readFileSync(join(dir, "slot-2.json"), "utf8")).pid, process.pid, "a vencida volta");
    process.env.ERP_TRUNK_ROUND = "1";
    const trunk = await acquireSuiteSlot("tronco");
    assert.equal(JSON.parse(readFileSync(join(dir, "trunk.json"), "utf8")).pid, process.pid);
    trunk();
    old();
  } finally {
    delete process.env.ERP_TRUNK_ROUND;
    sleeper.kill();
  }
});

test("sem vaga, espera", async () => {
  const dir = fresh();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"]);
  try {
    writeFileSync(join(dir, "slot-1.json"), owner(sleeper.pid));
    writeFileSync(join(dir, "slot-2.json"), owner(sleeper.pid));
    const stop = new AbortController();
    const waiting = acquireSuiteSlot("teste", { signal: stop.signal }).then(() => "pegou", () => "cancelou");
    const got = await Promise.race([waiting, new Promise((r) => setTimeout(() => r("esperando"), 1500))]);
    assert.equal(got, "esperando");
    stop.abort();
    assert.equal(await waiting, "cancelou");
  } finally {
    sleeper.kill();
  }
});
