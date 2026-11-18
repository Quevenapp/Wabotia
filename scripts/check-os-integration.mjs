// Smoke local: SQL real em SQLite, Worker/Coordinator reais, R2 e estado DO em memória.
// Não usa rede, Vitest, Wrangler ou Miniflare. Não substitui o runtime Cloudflare.
import { build } from "esbuild";
import { writeFile, rm, readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
let serializedDepth = 0;
const bundle = new URL("./.os-check.generated.mjs", import.meta.url);
const built = await build({
  stdin: {
    contents: `export {Coordinator} from './src/coordinator'; export * from './tests/os-integration-fixture'; export * from './tests/os-integration-scenarios'; export {areaTemplates} from './src/area-templates';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  plugins: [
    {
      name: "local-bindings",
      setup(b) {
        b.onResolve({ filter: /^cloudflare:(workers|test)$/ }, (a) => ({
          path: a.path,
          namespace: "local",
        }));
        b.onLoad({ filter: /.*/, namespace: "local" }, (a) => ({
          contents: a.path.endsWith("workers")
            ? "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"
            : 'export const env={}; export const SELF={}; export const runInDurableObject=()=>{throw Error("use local runtime")};',
        }));
      },
    },
  ],
});
await writeFile(bundle, built.outputFiles[0].contents);
try {
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor() {
      super();
      // Guarda local: o adaptador Node não reproduz o input gate de workerd.
      // Não deixar que uma cópia via pipeTo/R2 passe despercebida no comando.
      assert.equal(
        serializedDepth,
        0,
        "FixedLengthStream dentro do bloqueio do Coordinator",
      );
    }
  };
  const lib = await import(bundle.href);
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile("migrations/" + file, "utf8"));
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind(...values) {
      return statement(sql, values);
    },
    async all() {
      return execute(this);
    },
    async run() {
      return execute(this);
    },
    async first(column) {
      const r = execute(this).results[0];
      return column ? (r?.[column] ?? null) : (r ?? null);
    },
    async raw() {
      return execute(this).results.map(Object.values);
    },
  });
  function execute(s) {
    let rows;
    try {
      rows = sqlite
        .prepare(s.sql)
        .all(...s.args)
        .map((r) => ({ ...r }));
    } catch (error) {
      throw error;
    }
    const { n } = sqlite.prepare("SELECT changes() n").get();
    return {
      success: true,
      results: rows,
      meta: {
        changes: n,
        duration: 0,
        last_row_id: 0,
        rows_read: rows.length,
        rows_written: n,
      },
    };
  }
  const DB = {
    prepare: statement,
    async batch(list) {
      sqlite.exec("BEGIN");
      try {
        const r = list.map(execute);
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  const objects = new Map();
  const metadata = (o) => ({
    key: o.key,
    size: o.bytes.length,
    uploaded: o.uploaded,
    etag: o.etag,
    httpEtag: '"' + o.etag + '"',
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
    checksums: {},
    writeHttpMetadata(headers) {
      for (const [k, v] of Object.entries(o.httpMetadata ?? {}))
        if (k === "contentType") headers.set("Content-Type", v);
    },
  });
  const MEDIA = {
    async put(key, body, options = {}) {
      const previous = objects.get(key);
      if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const o = {
        key,
        bytes,
        uploaded: new Date(),
        etag: crypto.randomUUID(),
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
      };
      objects.set(key, o);
      return metadata(o);
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        ...metadata(o),
        body: new Response(o.bytes).body,
        arrayBuffer: async () => o.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(o.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? metadata(o) : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys])
        objects.delete(key);
    },
    async list(options = {}) {
      const items = [...objects.values()]
        .filter((o) => o.key.startsWith(options.prefix ?? ""))
        .sort((a, b) => a.key.localeCompare(b.key));
      const start = Number(options.cursor ?? 0),
        end = start + (options.limit ?? 1000);
      return {
        objects: items.slice(start, end).map(metadata),
        truncated: end < items.length,
        cursor: String(end),
        delimitedPrefixes: [],
      };
    },
  };
  const instances = new Map();
  const context = () => {
    const pending = [];
    return {
      waitUntil(p) {
        pending.push(p);
      },
      passThroughOnException() {},
      pending,
    };
  };
  const env = {
    DB,
    MEDIA,
    MASTER_KEY: "test-master-key-00000000000000000000",
    SETUP_TOKEN: "test-setup-token",
  };
  env.COORDINATOR = {
    idFromName: (name) => name,
    get(id) {
      if (!instances.has(id)) {
        const kv = new Map();
        let alarm = null;
        const ctx = {
          ...context(),
          storage: {
            get: async (k) => kv.get(k),
            put: async (k, v) => kv.set(k, v),
            delete: async (k) => kv.delete(k),
            getAlarm: async () => alarm,
            setAlarm: async (n) => {
              alarm = n;
            },
            deleteAlarm: async () => {
              alarm = null;
            },
          },
          blockConcurrencyWhile: async (fn) => {
            serializedDepth++;
            try {
              return await fn();
            } finally {
              serializedDepth--;
            }
          },
          getWebSockets: () => [],
        };
        const instance = new lib.Coordinator(ctx, env);
        instances.set(id, { instance, ctx });
      }
      return {
        id,
        fetch: (input, init) =>
          instances.get(id).instance.fetch(new Request(input, init)),
      };
    },
  };
  // Qualquer saída inesperada falha localmente, sem abrir sockets.
  globalThis.fetch = async () => {
    throw Error("Rede proibida no smoke local");
  };
  const runtime = {
    context,
    drain: async (c) => {
      while (c.pending.length) await Promise.all(c.pending.splice(0));
    },
    inside: async (stub, fn) => {
      const x = instances.get(stub.id);
      try {
        return await fn(x.instance, x.ctx);
      } catch (error) {
        console.error(error);
        throw error;
      }
    },
  };
  const h = lib.integrationHarness(env, runtime);
  for (const model of lib.areaTemplates) {
    await lib.applyRegisteredTemplate(h, model.id);
    console.log("Modelo", model.id, "OK");
  }
  await lib.recoveredChild(h);
  console.log("Fluxo integrado e recuperação: OK");
  await lib.deadlinesRegression(h);
  await lib.outgoingAttachmentRegression(h);
  console.log("Regressões de prazos e anexos: OK");
  if (lib.budgetScenario)
    console.log("Orçamento", JSON.stringify(await lib.budgetScenario(h)));
  const report = {};
  for (const r of h.report.filter((r) => !r.name.includes("/api/v1"))) {
    const values = (report[r.name] ??= { worker: 0, coordinator: 0 });
    values.worker = Math.max(values.worker, r.worker.statements);
    values.coordinator = Math.max(
      values.coordinator,
      0,
      ...r.coordinators.map((c) => c.statements),
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(bundle, { force: true });
}
