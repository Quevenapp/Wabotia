// Recibo do /command fechado depois da resposta (src/coordinator.ts): a
// auditoria e a resposta gravada vão num lote fora do caminho do cliente. Uma
// repetição com a mesma Idempotency-Key durante esse fechamento espera e
// recebe a mesma resposta; se o fechamento falhar, a repetição recebe o
// operation_unknown de sempre (que os apps repetem com a mesma chave), com
// Retry-After.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { uid } from "../src/types";
import { perform } from "../src/service";
import { fixture } from "./service-center-fixture";

const CLOSE = /^UPDATE receipts SET response=/;

/**
 * Troca o DB do objeto por um que segura (ou faz falhar) o lote de
 * fechamento do recibo até `release`.
 */
function holdClosing(stub: DurableObjectStub, mode: "hold" | "fail") {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const install = runInDurableObject(stub, async (instance: any) => {
    const original = instance.env;
    const sqlOf = new WeakMap<object, string>();
    const DB = new Proxy(original.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            const bindable = new Proxy(stmt, {
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
            return bindable;
          };
        if (prop === "batch")
          return async (stmts: any[]) => {
            if (stmts.some((s) => CLOSE.test(sqlOf.get(s) ?? ""))) {
              await gate;
              if (mode === "fail") throw new Error("Network connection lost");
            }
            return target.batch(stmts);
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    instance.env = { ...original, DB };
  });
  return { install, release: () => release() };
}

async function setup() {
  const f = await fixture();
  const run = (op: string, data: any, actor = f.admin) =>
    perform(env, actor, f.profile, op, data, uid());
  await run("module.set", { id: "queue", enabled: true });
  const queue = await run("queue.save", { name: "Geral", service_minutes: 10 });
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
  const command = (key: string) =>
    stub.fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({
        profile: f.profile,
        actor: f.admin,
        operation: "queue.issue",
        data: { queue_id: queue.id, preferential: false, source: "staff" },
        key,
        requestId: uid(),
      }),
    });
  const tickets = () =>
    all(env, "SELECT id FROM queue_tickets WHERE queue_id=?", queue.id);
  return { f, stub, command, tickets };
}

describe("recibo do /command fechado depois da resposta", () => {
  it("repetição durante o fechamento espera e recebe a mesma senha", async () => {
    const { stub, command, tickets } = await setup();
    const { install, release } = holdClosing(stub, "hold");
    await install;
    const key = uid();
    const first = await command(key);
    expect(first.status).toBe(200);
    const issued = (await first.json()) as any;
    // O fechamento está parado; a repetição (o app depois de 1,5 s) chega.
    const again = command(key);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const replay = await again;
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as any).id).toBe(issued.id);
    expect(await tickets()).toHaveLength(1);
    // Depois do fechamento, a repetição vem do recibo gravado.
    const later = await command(key);
    expect(((await later.json()) as any).id).toBe(issued.id);
    expect(await tickets()).toHaveLength(1);
  });

  it("fechamento que falha: a repetição recebe operation_unknown com Retry-After, sem senha nova", async () => {
    const { stub, command, tickets } = await setup();
    const { install, release } = holdClosing(stub, "fail");
    await install;
    const key = uid();
    const first = await command(key);
    expect(first.status).toBe(200);
    release();
    // O fechamento falhou fora da resposta; o objeto não guarda mais nada.
    await new Promise((r) => setTimeout(r, 50));
    const retry = await command(key);
    expect(retry.status).toBe(409);
    expect(retry.headers.get("Retry-After")).toBe("1");
    expect(((await retry.json()) as any).error.code).toBe("operation_unknown");
    expect(await tickets()).toHaveLength(1);
  });
});
