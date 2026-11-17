// Recibo do /command na emissão e na chamada da fila (src/coordinator.ts,
// src/command-context.ts): a auditoria e a marca do recibo
// ("ref:<operação>:<id>") gravam no lote da escrita, junto com a senha; a
// resposta exata vai depois da resposta ao cliente. Uma repetição com a
// mesma Idempotency-Key:
// - durante a gravação da resposta, espera e devolve a mesma resposta;
// - depois de um reinício (a gravação se perdeu), reconstrói pela marca e
//   fecha o recibo;
// - sem marca (a escrita não gravou), roda a operação de novo.
// Em todos os casos: uma senha só e uma auditoria só.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { perform } from "../src/service";
import { canonical, sha } from "../src/security";
import { fixture } from "./service-center-fixture";

/** A gravação da resposta exata no recibo (não a marca do lote da escrita). */
const CLOSE = /^UPDATE receipts SET response=\?,status=\? WHERE/;

/**
 * Troca o DB do objeto por um que segura (`hold`) ou faz falhar (`fail`) o
 * lote que bate com `match`, até `release`; `once`: só o primeiro.
 */
function intercept(
  stub: DurableObjectStub,
  match: RegExp,
  mode: "hold" | "fail",
) {
  let release!: (fail?: boolean) => void;
  let failAtRelease = mode === "fail";
  const gate = new Promise<void>(
    (r) =>
      (release = (fail) => {
        if (fail !== undefined) failAtRelease = fail;
        r();
      }),
  );
  let used = false;
  const install = runInDurableObject(stub, async (instance: any) => {
    const original = instance.env;
    const sqlOf = new WeakMap<object, string>();
    const DB = new Proxy(original.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(t, p) {
                if (p === "bind")
                  return (...args: any[]) => {
                    const bound = t.bind(...args);
                    sqlOf.set(bound, sql);
                    return bound;
                  };
                const v = t[p];
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
          };
        if (prop === "batch")
          return async (stmts: any[]) => {
            if (!used && stmts.some((s) => match.test(sqlOf.get(s) ?? ""))) {
              used = true;
              await gate;
              if (failAtRelease) throw new Error("Network connection lost");
            }
            return target.batch(stmts);
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    instance.env = { ...original, DB };
  });
  return { install, release };
}

async function setup() {
  const f = await fixture();
  const run = (op: string, data: any, actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  await run("module.set", { id: "queue", enabled: true });
  const queue = await run("queue.save", { name: "Geral", service_minutes: 10 });
  const counter = await run("counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run("counter.state", { id: counter.id, status: "open" }, f.member);
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  const send = (operation: string, data: any, key: string, actor = f.admin) =>
    stub.fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({
        profile: f.profile,
        actor,
        operation,
        data,
        key,
        requestId: uid(),
      }),
    });
  const issue = (key: string) =>
    send(
      "queue.issue",
      { queue_id: queue.id, preferential: false, source: "staff" },
      key,
    );
  const callNext = (key: string) =>
    send("queue.call_next", { id: counter.id }, key, f.member);
  const tickets = () =>
    all(env, "SELECT id,status FROM queue_tickets WHERE queue_id=?", queue.id);
  const audits = (operation: string) =>
    all(
      env,
      "SELECT resource_id FROM audit WHERE profile_id=? AND operation=?",
      f.profile,
      operation,
    );
  const receipt = (key: string) =>
    one(env, "SELECT response,status FROM receipts WHERE key=?", key);
  /** Reinício simulado: o objeto perde o que tinha em memória. */
  const restart = () =>
    runInDurableObject(stub, (instance: any) => instance.closing.clear());
  return {
    f,
    queue,
    stub,
    issue,
    callNext,
    tickets,
    audits,
    receipt,
    restart,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("recibo da emissão e da chamada no lote da escrita", () => {
  it("a auditoria e a marca gravam junto com a senha, antes da resposta exata", async () => {
    const { stub, issue, audits, receipt } = await setup();
    const { install, release } = intercept(stub, CLOSE, "hold");
    await install;
    const key = uid();
    const first = await issue(key);
    expect(first.status).toBe(200);
    const issued = (await first.json()) as any;
    // A resposta exata ainda não gravou; a auditoria e a marca, sim.
    expect((await receipt(key))?.response).toBe(`ref:queue.issue:${issued.id}`);
    expect((await audits("queue.issue")).map((a) => a.resource_id)).toEqual([
      issued.id,
    ]);
    release(false);
    await settle();
    expect((await receipt(key))?.response).toMatch(/^sealed:/);
  });

  it("repetições durante a gravação da resposta (duas ao mesmo tempo) recebem a mesma senha", async () => {
    const { stub, issue, tickets, audits } = await setup();
    const { install, release } = intercept(stub, CLOSE, "hold");
    await install;
    const key = uid();
    const issued = (await (await issue(key)).json()) as any;
    // O app repete (e repete de novo) enquanto a resposta ainda grava.
    const a = issue(key);
    const b = issue(key);
    await settle();
    release(false);
    const [ra, rb] = await Promise.all([a, b]);
    for (const r of [ra, rb]) {
      expect(r.status).toBe(200);
      expect(r.headers.get("Idempotency-Replayed")).toBe("true");
      expect(((await r.json()) as any).id).toBe(issued.id);
    }
    expect(await tickets()).toHaveLength(1);
    expect(await audits("queue.issue")).toHaveLength(1);
  });

  it("reinício entre a resposta e o fechamento: a repetição reconstrói, uma senha só, auditoria presente", async () => {
    const { stub, issue, tickets, audits, receipt, restart } = await setup();
    const { install, release } = intercept(stub, CLOSE, "hold");
    await install;
    const key = uid();
    const issued = (await (await issue(key)).json()) as any;
    // O objeto reinicia: a gravação da resposta exata se perde.
    await restart();
    const again = await issue(key);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const replayed = (await again.json()) as any;
    expect(replayed.id).toBe(issued.id);
    expect(replayed.code).toBe(issued.code);
    expect(replayed.public_token).toBe(issued.public_token);
    expect(await tickets()).toHaveLength(1);
    expect(await audits("queue.issue")).toHaveLength(1);
    // O recibo fechou na repetição.
    expect((await receipt(key))?.response).toMatch(/^sealed:/);
    release(true);
  });

  it("a gravação da resposta falha: a repetição reconstrói pela marca", async () => {
    const { stub, issue, tickets, audits } = await setup();
    const { install, release } = intercept(stub, CLOSE, "fail");
    await install;
    const key = uid();
    const issued = (await (await issue(key)).json()) as any;
    release();
    await settle();
    const again = await issue(key);
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).id).toBe(issued.id);
    expect(await tickets()).toHaveLength(1);
    expect(await audits("queue.issue")).toHaveLength(1);
  });

  it("a escrita não gravou: sem marca, a repetição emite (uma senha só)", async () => {
    const { f, queue, issue, tickets, audits, receipt } = await setup();
    const key = uid();
    // O estado que sobra quando o objeto cai antes do lote da escrita (ou o
    // lote falha: ele é atômico): o recibo reservado na abertura, sem
    // resposta e sem marca. (Um erro dentro do blockConcurrencyWhile
    // reinicia o objeto, por isso o estado é montado direto.)
    const data = { queue_id: queue.id, preferential: false, source: "staff" };
    await exec(
      env,
      "INSERT INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)",
      `${f.admin.id}:${f.profile}:queue.issue`,
      key,
      await sha(canonical(data)),
      now(),
    );
    expect(await tickets()).toHaveLength(0);
    expect((await receipt(key))?.response ?? null).toBeNull();
    const again = await issue(key);
    expect(again.status).toBe(200);
    expect(await tickets()).toHaveLength(1);
    expect(await audits("queue.issue")).toHaveLength(1);
  });

  it("chamada: reinício entre a resposta e o fechamento, a repetição devolve a mesma senha chamada", async () => {
    const { stub, issue, callNext, tickets, audits, restart } = await setup();
    await (await issue(uid())).json();
    const { install, release } = intercept(stub, CLOSE, "hold");
    await install;
    const key = uid();
    const called = (await (await callNext(key)).json()) as any;
    expect(called.status).toBe("called");
    await restart();
    const again = await callNext(key);
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).id).toBe(called.id);
    // Uma chamada só: a senha chamada uma vez e uma auditoria.
    expect((await tickets()).map((t) => t.status)).toEqual(["called"]);
    expect(await audits("queue.call_next")).toHaveLength(1);
    release(true);
  });
});
