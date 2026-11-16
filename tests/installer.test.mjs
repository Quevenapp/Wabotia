import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { build } = require("../node_modules/wrangler/node_modules/esbuild");
async function bundledInstaller(run) {
  const folder = await mkdtemp(join(tmpdir(), "wabotia-installer-ui-"));
  try {
    const outfile = join(folder, "installer.mjs");
    await build({
      entryPoints: ["scripts/install-release.ts"],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    await run(await import(pathToFileURL(outfile)));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("perguntas ficam em linhas completas; o token nunca aparece na saída", async () => {
  await bundledInstaller(async ({ question }) => {
    let output = "";
    const sink = new PassThrough();
    sink.on("data", (chunk) => {
      output += chunk.toString();
    });
    try {
      for (const hidden of [false, true]) {
        const input = new PassThrough();
        input.isTTY = true;
        input.setRawMode = (value) => {
          input.isRaw = value;
        };
        let readyBeforePrompt = false;
        sink.once("data", () => {
          readyBeforePrompt = input.isRaw === true;
        });
        const answer = question(
          hidden ? "Token Cloudflare" : "Account ID",
          hidden,
          { input, output: sink },
        );
        assert.equal(
          readyBeforePrompt,
          true,
          "Modo sem eco precisa estar ativo antes de mostrar a pergunta",
        );
        // Assertions before sending input reproduce a terminal waiting for a person.
        assert.match(
          output,
          hidden
            ? /AGUARDANDO VOCÊ · Token Cloudflare\n/
            : /AGUARDANDO VOCÊ · Account ID\n/,
        );
        if (hidden) assert.match(output, /entrada fica invisível/);
        input.write(
          hidden
            ? "segredo-ficticio-que-nao-pode-aparecer\n"
            : "conta-de-teste\n",
        );
        assert.equal(
          await answer,
          hidden ? "segredo-ficticio-que-nao-pode-aparecer" : "conta-de-teste",
        );
        input.destroy();
      }
      assert.doesNotMatch(output, /segredo-ficticio-que-nao-pode-aparecer/);
    } finally {
      sink.destroy();
    }
  });
});

test("andamento informa tempo enquanto aguarda e encerra o aviso após sucesso ou falha", async (t) => {
  await bundledInstaller(async ({ progress }) => {
    const log = console.log;
    const lines = [];
    try {
      console.log = (...args) => lines.push(args.join(" "));
      t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
      let finish;
      const waiting = progress(
        "Publicação de teste",
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      t.mock.timers.tick(10000);
      assert.ok(lines.some((line) => /AGUARDANDO RESULTADO.*10s/.test(line)));
      finish("feito");
      assert.equal(await waiting, "feito");
      const completed = lines.length;
      t.mock.timers.tick(20000);
      assert.equal(lines.length, completed);
      await assert.rejects(
        progress("Falha de teste", async () => {
          throw Error("falhou");
        }),
        /falhou/,
      );
      const failed = lines.length;
      t.mock.timers.tick(20000);
      assert.equal(lines.length, failed);
    } finally {
      t.mock.timers.reset();
      console.log = log;
    }
  });
});

test("comando externo permite atualizar o andamento e propaga falhas", async () => {
  await bundledInstaller(async ({ runCommand }) => {
    let elapsed = false;
    const timer = setTimeout(() => {
      elapsed = true;
    }, 20);
    try {
      await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
        cwd: process.cwd(),
        env: process.env,
      });
      assert.equal(elapsed, true);
      await assert.rejects(
        runCommand(process.execPath, ["-e", "process.exit(7)"], {
          cwd: process.cwd(),
          env: process.env,
        }),
        /--resume/,
      );
    } finally {
      clearTimeout(timer);
    }
  });
});

test("instalação nova recusa recursos existentes, inclusive D1 paginado", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wabotia-installer-test-"));
  const originalFetch = globalThis.fetch;
  try {
    const outfile = join(folder, "installer.mjs");
    await build({
      entryPoints: ["scripts/install-release.ts"],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const { assertNewResources } = await import(pathToFileURL(outfile));
    const response = (result) => Response.json({ success: true, result });
    globalThis.fetch = async () =>
      response({ buckets: [{ name: "minha-instalacao-media" }] });
    await assert.rejects(
      assertNewResources("token", "a".repeat(32), "minha-instalacao"),
      /bucket R2/,
    );
    globalThis.fetch = async (url) =>
      response(
        url.includes("/r2/")
          ? { buckets: [] }
          : url.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, i) => ({ name: "outro-" + i }))
            : [{ name: "minha-instalacao" }],
      );
    await assert.rejects(
      assertNewResources("token", "a".repeat(32), "minha-instalacao"),
      /banco D1/,
    );
    globalThis.fetch = async (url) =>
      response(url.includes("/r2/") ? { buckets: [] } : []);
    await assertNewResources("token", "a".repeat(32), "minha-instalacao");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
});

test("instalador no formato 2: catálogo local, arquivos conferidos um a um", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const root = await mkdtemp(join(tmpdir(), "wabotia-release-v2-"));
  try {
    const blobs = join(root, "blobs"),
      version = join(root, "9.9.9");
    await mkdir(blobs, { recursive: true });
    await mkdir(version, { recursive: true });
    const ref = async (name, type, body) => {
      const raw = Buffer.from(body);
      await writeFile(join(blobs, sha(raw)), raw);
      return { name, type, size: raw.length, sha256: sha(raw) };
    };
    const manifest = {
      format: 2,
      version: "9.9.9",
      commit: "a".repeat(40),
      main_module: "index.js",
      compatibility_date: "2026-11-04",
      compatibility_flags: [],
      assets_config: {
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*", "/webhooks/*", "/internal/*"],
      },
      durable_migrations: [{ tag: "v1", new_sqlite_classes: ["Coordinator"] }],
      modules: [await ref("index.js", "application/javascript+module", "export default {}")],
      assets: [await ref("/app/index.html", "text/html", "<html></html>")],
      migrations: [
        await ref("0001_core.sql", "application/json", JSON.stringify(["CREATE TABLE t(id)", "INSERT INTO t VALUES(1)"])),
      ],
    };
    const text = JSON.stringify(manifest);
    const total = [...manifest.modules, ...manifest.assets, ...manifest.migrations].reduce((a, f) => a + f.size, 0);
    await writeFile(join(version, "manifest.json"), text);
    await writeFile(
      join(version, "release-v2.json"),
      JSON.stringify({
        format: 2,
        version: "9.9.9",
        commit: "a".repeat(40),
        manifest_sha256: sha(text),
        manifest_size: Buffer.byteLength(text),
        total_size: total,
        requires: { min_version: "0.0.1", workers_paid: false },
      }),
    );
    await bundledInstaller(async ({ localRelease, materializeRelease }) => {
      const source = await localRelease(version);
      const out = join(root, "instalacao");
      await materializeRelease(out, source.manifest, source.read);
      assert.equal(await readFile(join(out, "worker", "index.js"), "utf8"), "export default {}");
      assert.equal(await readFile(join(out, "web", "app", "index.html"), "utf8"), "<html></html>");
      assert.equal(
        await readFile(join(out, "migrations", "0001_core.sql"), "utf8"),
        "CREATE TABLE t(id);\nINSERT INTO t VALUES(1);\n",
      );
      // Arquivo adulterado no catálogo: recusa antes de gravar.
      await writeFile(join(blobs, manifest.assets[0].sha256), "<html>outro</html>");
      await assert.rejects(
        materializeRelease(join(root, "outra"), source.manifest, source.read),
        /corrompido/,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
