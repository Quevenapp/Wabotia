import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = require("../node_modules/wrangler/node_modules/esbuild");
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
