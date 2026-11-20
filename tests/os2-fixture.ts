import worker from "../src/index";
import type { Env } from "../src/types";
import { withOs2Adapters, type Os2Adapters } from "../src/modules/os/os2-ports";
import type { Runtime } from "./os-integration-fixture";
import { emptyOs2Count, os2CountingEnv, type Os2D1Count } from "./os2-d1-counter";
import { vi } from "vitest";

export interface Os2Invocation {
  name: string;
  worker_invoked: boolean;
  worker: Os2D1Count;
  coordinators: Array<Os2D1Count & { coordinator: string; operation: string }>;
}
/** Instala adaptadores em cada invocação real, sem mutar registro global. */
export function os2Harness(env: Env, runtime: Runtime, adapters: Partial<Os2Adapters> = {}) {
  const report: Os2Invocation[] = [];
  async function fetchInside(stub: DurableObjectStub, id: string, request: Request, coordinators: Os2Invocation["coordinators"]) {
    // runInDurableObject atravessa contextos de I/O. Nem Request/Response nem
    // seus streams podem atravessar essa fronteira por uma closure. Consumir
    // cada corpo no contexto de origem e transportar somente dados em memória.
    const input = {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      redirect: request.redirect,
      body: request.body === null ? null : await request.arrayBuffer(),
    };
    const invocation = await inside(stub, id, new URL(input.url).pathname, coordinators, async instance => {
      const response: Response = await instance.fetch(new Request(input.url, {
        method: input.method, headers: input.headers, redirect: input.redirect, body: input.body,
      }));
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body: response.body === null ? null : await response.arrayBuffer(),
      };
    });
    return new Response(invocation.result.body, {
      status: invocation.result.status,
      statusText: invocation.result.statusText,
      headers: invocation.result.headers,
    });
  }
  function namespace(original: DurableObjectNamespace, coordinators: Os2Invocation["coordinators"]): DurableObjectNamespace {
    return new Proxy(original, {
      get(target, property) {
        if (property === "get") return (...args: Parameters<typeof target.get>) => {
          const stub = target.get(...args);
          return new Proxy(stub, {
            get(targetStub, key) {
              if (key === "fetch") return async (input: RequestInfo, init?: RequestInit) => {
                const request = new Request(input, init);
                return fetchInside(stub, String(args[0]), request, coordinators);
              };
              const value = Reflect.get(targetStub, key);
              return typeof value === "function" ? value.bind(targetStub) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  async function inside<T>(stub: DurableObjectStub, id: string, operation: string, coordinators: Os2Invocation["coordinators"], invoke: (instance: any, state: DurableObjectState) => Promise<T>) {
    return runtime.inside(stub, async (instance, state) => withOs2Adapters(adapters, async () => {
      const original = instance.env;
      const originalContext = instance.ctx;
      const pending: Promise<unknown>[] = [];
      const counted = os2CountingEnv(original);
      instance.env = { ...counted.env, COORDINATOR: namespace(original.COORDINATOR, coordinators) };
      instance.ctx = new Proxy(originalContext, {
        get(target, property) {
          if (property === "waitUntil") return (work: Promise<unknown>) => {
            pending.push(work);
            return target.waitUntil(work);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        const result = await invoke(instance, state);
        await Promise.all([...(instance.closing?.values() ?? [])]);
        // A drenagem acompanha promessas enfileiradas por outras promessas.
        // Não depende de sleeps, relógio real ou alarme automático.
        for (let drained = 0; drained < pending.length;) {
          const through = pending.length;
          await Promise.all(pending.slice(drained, through));
          drained = through;
        }
        return { result, count: { ...counted.count, coordinator: id, operation } };
      } finally {
        coordinators.push({ ...counted.count, coordinator: id, operation });
        instance.env = original;
        instance.ctx = originalContext;
        await state.storage.deleteAlarm();
      }
    }));
  }
  return {
    env, report,
    run<T>(run: () => T): T { return withOs2Adapters(adapters, run); },
    async fetch(request: Request, name = request.method + " " + new URL(request.url).pathname) {
      const counted = os2CountingEnv(env);
      const coordinators: Os2Invocation["coordinators"] = [];
      const COORDINATOR = namespace(env.COORDINATOR, coordinators);
      const context = runtime.context();
      return withOs2Adapters(adapters, async () => {
        try {
          const response = await worker.fetch(request, { ...counted.env, COORDINATOR }, context);
          await runtime.drain(context);
          return response;
        } finally { report.push({ name, worker_invoked: true, worker: counted.count, coordinators }); }
      });
    },
    async coordinator(profile: string, request: Request, name: string) {
      const id = env.COORDINATOR.idFromName(profile);
      const coordinators: Os2Invocation["coordinators"] = [];
      try { return await fetchInside(env.COORDINATOR.get(id), String(id), request, coordinators); }
      finally { report.push({ name, worker_invoked: false, worker: emptyOs2Count(), coordinators }); }
    },
    async alarm(profile: string) {
      const id = env.COORDINATOR.idFromName(profile);
      const coordinators: Os2Invocation["coordinators"] = [];
      const invocation = await inside(env.COORDINATOR.get(id), String(id), "alarm", coordinators, async (instance, state) => {
        await state.storage.put("profile", profile);
        await state.storage.delete("modules_tick");
        await instance.alarm();
      });
      report.push({ name: "alarm", worker_invoked: false, worker: emptyOs2Count(), coordinators });
      return invocation.count;
    },
  };
}
export type Os2Harness = ReturnType<typeof os2Harness>;
/** Relógio fixo, sem sleeps nem deadlines curtos; alarmes são explícitos. */
export async function withOs2Time<T>(at: number, run: (clock: { advance: (milliseconds: number) => void }) => Promise<T>): Promise<T> {
  let current = at;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => current);
  try { return await run({ advance: milliseconds => { current += milliseconds; } }); }
  finally { spy.mockRestore(); }
}
