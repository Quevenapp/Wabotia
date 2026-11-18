// Regressão de inicialização, executável com node --test, sem Vitest ou rede.
// Cada entrada é carregada primeiro, em um processo novo, sem cache de módulos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const entry of ["src/index.ts", "src/coordinator.ts"]) {
  test(`inicializa ${entry} com todos os registros I2`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "motor-i2-bootstrap-"));
    try {
      const { outputFiles } = await build({
        stdin: {
          contents: `
            import * as entry from './${entry}';
            import assert from 'node:assert/strict';
            import { moduleRoutes, moduleCommandHandler, moduleMcpTools, menuHandler,
              credentialHook, conversationAction, scheduledModules } from './src/modules/hooks';
            import { modules, resolveStates } from './src/modules/registry';
            import { ensinoReads, ensinoWrites, ensinoCommands } from './src/modules/ensino/ensino';
            import { saudeExtension } from './src/modules/saude/saude';
            import { juridicoReads, juridicoWrites, juridicoCommands } from './src/modules/juridico/juridico';
            assert.equal(typeof entry.Coordinator, 'function');
            ${entry === "src/index.ts" ? "assert.equal(typeof entry.default.fetch, 'function');" : ""}
            const routes = moduleRoutes();
            const states = resolveStates({});
            for (const id of ['juridico', 'condominio', 'saude', 'ensino']) {
              assert.equal(modules.filter(m => m.id === id).length, 1, id);
              assert.equal(states[id], false, id + ' desligado por padrão');
              assert(routes.write.some(r => r.path.startsWith(id + '/')), id);
            }
            for (const [kind, expected] of [
              ['read', [...ensinoReads, ...juridicoReads]],
              ['write', [...ensinoWrites, ...juridicoWrites, ...saudeExtension.writes]],
              ['binary', [...saudeExtension.binaryReads.map(r => ({ ...r, method: 'GET' })),
                ...saudeExtension.binaryUploads.map(r => ({ ...r, method: 'PUT' }))]],
            ]) for (const r of expected) {
              assert.equal(routes[kind].filter(x => x.path === r.path && x.method === r.method).length,
                1, kind + ' ' + r.path);
            }
            for (const r of [...ensinoCommands, ...juridicoCommands, ...saudeExtension.commands])
              assert.equal(typeof moduleCommandHandler(r.op), 'function', r.op);
            for (const name of ['cond_unit', 'ensino_boletim'])
              assert.equal(typeof menuHandler(name), 'function', name);
            for (const id of ['condominio', 'ensino'])
              assert.equal(typeof credentialHook(id), 'function', id);
            assert.equal(typeof conversationAction('ensino_boletim'), 'function');
            assert.equal(moduleMcpTools().filter(t => t.name === 'ensino_pedir_boletim').length, 1);
            const scheduled = scheduledModules().map(([id]) => id);
            for (const id of ['os', 'juridico', 'condominio'])
              assert.equal(scheduled.filter(x => x === id).length, 1, id);
            for (const id of ['saude', 'ensino']) assert(!scheduled.includes(id), id);
          `,
          resolveDir: root,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        logLevel: "error",
        plugins: [{
          name: "cloudflare-base-class",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "local" }));
            b.onLoad({ filter: /.*/, namespace: "local" }, () => ({
              contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
            }));
          },
        }],
      });
      const bundle = join(directory, "entry.mjs");
      await writeFile(bundle, outputFiles[0].contents);
      assert.doesNotThrow(() => execFileSync(process.execPath, [bundle], { stdio: "pipe", timeout: 30_000 }),
        `${entry} deve inicializar antes das asserções de registro`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
