import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
// O esbuild do Wrangler, aninhado ou içado (ver scripts/release.mjs).
const { build } = createRequire(require.resolve("wrangler/package.json"))(
  "esbuild",
);
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

test("build de teste: só a chave do ensaio vale, e só junto com a origem de teste; o oficial nunca a aceita", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { signatureFile } = await import("../scripts/release-sign.mjs");
  const official = JSON.parse(await readFile("src/release-keys.json", "utf8")).keys;
  const ensaio = generateKeyPairSync("ed25519");
  const testKeys = [{ id: "ensaio", ed25519: ensaio.publicKey.export({ format: "jwk" }).x }];
  const origin = "https://catalogo-ensaio.example/api/test-catalog";
  const folder = await mkdtemp(join(tmpdir(), "wabotia-release-keys-"));
  // Compila src/release.ts como o release.mjs compila cada tipo de build.
  const compiled = async (name, define) => {
    const outfile = join(folder, `${name}.mjs`);
    await build({
      entryPoints: ["src/release.ts"],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      define,
      logLevel: "silent",
    });
    return import(pathToFileURL(outfile));
  };
  try {
    const keys = JSON.stringify(testKeys);
    const oficial = await compiled("oficial", {});
    const soChaves = await compiled("so-chaves", { __WABOTIA_TEST_RELEASE_KEYS__: keys });
    const teste = await compiled("teste", {
      __WABOTIA_TEST_RELEASE_ORIGIN__: JSON.stringify(origin),
      __WABOTIA_TEST_RELEASE_KEYS__: keys,
    });
    const bytes = Buffer.from('{"format":2}');
    const signed = Buffer.from(
      signatureFile("index", bytes, { id: "ensaio", key: ensaio.privateKey }, testKeys),
    );
    // Oficial: só as chaves de src/release-keys.json; a do ensaio é recusada,
    // e qualquer test_origin também.
    assert.deepEqual(oficial.RELEASE_KEYS, official);
    await assert.rejects(oficial.verifySignature("index", bytes, signed), /chave desconhecida/);
    assert.equal(oficial.testOriginAccepted(origin), false);
    // A constante das chaves sem a origem de teste não muda nada.
    assert.deepEqual(soChaves.RELEASE_KEYS, official);
    await assert.rejects(soChaves.verifySignature("index", bytes, signed), /chave desconhecida/);
    // Teste: só a chave do ensaio (nenhuma oficial) e só a própria origem.
    assert.deepEqual(teste.RELEASE_KEYS, testKeys);
    assert.equal(await teste.verifySignature("index", bytes, signed), "ensaio");
    assert.ok(!teste.RELEASE_KEYS.some((k) => official.some((o) => o.ed25519 === k.ed25519)));
    assert.equal(teste.testOriginAccepted(origin), true);
    assert.equal(teste.testOriginAccepted("https://outro.example/api/test-catalog"), false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("instalador no formato 2: catálogo local assinado, arquivos conferidos um a um", async () => {
  const { createHash, generateKeyPairSync } = await import("node:crypto");
  const { mkdir, writeFile, readFile, unlink } = await import("node:fs/promises");
  const { signatureFile, signerFor, withValidity, SIGNATURE_DOMAIN } =
    await import("../scripts/release-sign.mjs");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  // Par gerado na hora; as chaves reais nunca entram nos testes.
  const pair = () => generateKeyPairSync("ed25519");
  const principal = pair(),
    reserva = pair(),
    stranger = pair();
  const publicKeys = [
    { id: "principal", ed25519: principal.publicKey.export({ format: "jwk" }).x },
    { id: "reserva", ed25519: reserva.publicKey.export({ format: "jwk" }).x },
  ];
  // A chave de fora da lista não assina uma publicação.
  assert.throws(() => signerFor(stranger.privateKey, publicKeys), /nenhuma chave pública/);
  assert.throws(
    () => signatureFile("index", Buffer.from("x"), { id: "principal", key: stranger.privateKey }, publicKeys),
    /não confere/,
  );
  assert.deepEqual(SIGNATURE_DOMAIN, {
    index: "wabotia-release-index-v2\n",
    manifest: "wabotia-release-manifest-v2\n",
  });
  const valid = withValidity({ format: 2 }, 1000);
  assert.equal(valid.expires - valid.issued_at, 90 * 86400000);

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
    const indexOf = (extra = {}) =>
      JSON.stringify(
        withValidity({
          format: 2,
          version: "9.9.9",
          commit: "a".repeat(40),
          manifest_sha256: sha(text),
          manifest_size: Buffer.byteLength(text),
          total_size: total,
          requires: { min_version: "0.0.1", workers_paid: false },
          ...extra,
        }),
        null,
        2,
      );
    /** Grava o catálogo assinado por `key` (ou sem assinatura). */
    const publish = async (key, index = indexOf(), manifestText = text) => {
      await writeFile(join(version, "manifest.json"), manifestText);
      await writeFile(join(version, "release-v2.json"), index);
      for (const file of ["manifest.sig", "release-v2.sig"])
        await unlink(join(version, file)).catch(() => {});
      if (!key) return;
      const signer = signerFor(key, publicKeys);
      await writeFile(join(version, "manifest.sig"), signatureFile("manifest", Buffer.from(text), signer, publicKeys));
      await writeFile(join(version, "release-v2.sig"), signatureFile("index", Buffer.from(index), signer, publicKeys));
    };
    await bundledInstaller(async ({ localRelease, materializeRelease, trustReleaseKeysForTests }) => {
      trustReleaseKeysForTests(publicKeys);
      // Assinado pela principal: instala.
      await publish(principal.privateKey);
      const source = await localRelease(version);
      const out = join(root, "instalacao");
      await materializeRelease(out, source.manifest, source.read);
      assert.equal(await readFile(join(out, "worker", "index.js"), "utf8"), "export default {}");
      assert.equal(await readFile(join(out, "web", "app", "index.html"), "utf8"), "<html></html>");
      assert.equal(
        await readFile(join(out, "migrations", "0001_core.sql"), "utf8"),
        "CREATE TABLE t(id);\nINSERT INTO t VALUES(1);\n",
      );
      // Pela reserva: também.
      await publish(reserva.privateKey);
      assert.equal((await localRelease(version)).index.version, "9.9.9");
      // Chave fora da lista: recusa.
      await publish(principal.privateKey);
      const foreign = JSON.parse(await readFile(join(version, "manifest.sig"), "utf8"));
      await writeFile(join(version, "manifest.sig"), JSON.stringify({ ...foreign, key_id: "outra" }));
      await assert.rejects(localRelease(version), /chave desconhecida/);
      // Sem assinatura: recusa.
      await publish(null);
      await assert.rejects(localRelease(version), /sem assinatura/);
      // Manifesto alterado em um byte depois de assinado.
      await publish(principal.privateKey);
      const altered = Buffer.from(text);
      altered[altered.length - 3] ^= 1;
      await writeFile(join(version, "manifest.json"), altered);
      await assert.rejects(localRelease(version), /conteúdo alterado/);
      // Índice alterado depois de assinado (outra versão mínima).
      await publish(principal.privateKey);
      const index = await readFile(join(version, "release-v2.json"), "utf8");
      await writeFile(join(version, "release-v2.json"), index.replace("0.0.1", "0.0.2"));
      await assert.rejects(localRelease(version), /conteúdo alterado/);
      // Pacote de teste não vale no instalador oficial.
      await publish(principal.privateKey, indexOf({ test_origin: "https://teste.example/api/test-catalog" }));
      await assert.rejects(localRelease(version), /pacote de teste/);
      // Arquivo trocado por outro do catálogo e arquivo corrompido: recusa antes de gravar.
      await publish(principal.privateKey);
      const good = await localRelease(version);
      const html = join(blobs, manifest.assets[0].sha256);
      const original = await readFile(html);
      await writeFile(html, await readFile(join(blobs, manifest.modules[0].sha256)));
      await assert.rejects(materializeRelease(join(root, "outra"), good.manifest, good.read), /corrompido/);
      const corrupt = Buffer.from(original);
      corrupt[0] ^= 1;
      await writeFile(html, corrupt);
      await assert.rejects(materializeRelease(join(root, "outra2"), good.manifest, good.read), /corrompido/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instalador pela rede: índice assinado e no prazo, senão nada começa", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { signatureFile, signerFor, withValidity } = await import("../scripts/release-sign.mjs");
  const key = generateKeyPairSync("ed25519");
  const publicKeys = [{ id: "principal", ed25519: key.publicKey.export({ format: "jwk" }).x }];
  const signer = signerFor(key.privateKey, publicKeys);
  const originalFetch = globalThis.fetch;
  try {
    await bundledInstaller(async ({ latestReleaseV2, trustReleaseKeysForTests }) => {
      trustReleaseKeysForTests(publicKeys);
      const serve = (index, signed = true) => {
        const bytes = Buffer.from(JSON.stringify(index));
        globalThis.fetch = async (url) =>
          String(url).endsWith("/releases/v2/latest.json")
            ? new Response(bytes)
            : String(url).endsWith("/releases/v2/latest.sig") && signed
              ? new Response(signatureFile("index", bytes, signer, publicKeys))
              : new Response("", { status: 404 });
      };
      const base = {
        format: 2,
        version: "9.9.9",
        commit: "a".repeat(40),
        manifest_sha256: "b".repeat(64),
        manifest_size: 10,
        total_size: 10,
        requires: { min_version: "0.0.1", workers_paid: false },
      };
      serve(withValidity(base));
      assert.equal((await latestReleaseV2()).version, "9.9.9");
      serve(withValidity(base), false);
      await assert.rejects(latestReleaseV2(), /sem assinatura/);
      serve(withValidity(base, Date.now() - 100 * 86400000));
      await assert.rejects(latestReleaseV2(), /venceu/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});