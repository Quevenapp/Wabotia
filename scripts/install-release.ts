#!/usr/bin/env node
// Bundled as public/install-wabotia.mjs. Run locally once; Wabotia runs on Cloudflare.
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  assertRelease,
  latestRelease,
  fetchPackage,
  validateIndex,
  parsePackage,
  scriptPath,
  type ReleasePackage,
} from "../src/release";

export async function materializeRelease(folder: string, pkg: ReleasePackage) {
  for (const [group, files] of [
    ["worker", pkg.modules],
    ["web", pkg.assets],
  ] as const) {
    for (const file of files) {
      const path = join(folder, group, file.name.replace(/^\//, ""));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.data, "base64"));
    }
  }
  await mkdir(join(folder, "migrations"), { recursive: true });
  for (const migration of pkg.migrations)
    await writeFile(
      join(folder, "migrations", migration.name),
      migration.statements.join(";\n") + ";\n",
    );
}
export async function question(
  label: string,
  hidden = false,
  io = { input: process.stdin, output: process.stdout },
) {
  if (!io.input.isTTY)
    throw Error(
      `Defina ${label} por variável de ambiente ou execute num terminal interativo.`,
    );
  // A complete line remains visible in web terminals that defer partial lines.
  io.output.write(`\nAGUARDANDO VOCÊ · ${label}\n`);
  io.output.write(
    hidden
      ? "Cole o token e pressione Enter. A entrada fica invisível, inclusive ao colar.\n"
      : "Digite ou cole a resposta e pressione Enter para continuar.\n",
  );
  let muted = hidden;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) io.output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: io.input, output, terminal: true });
  try {
    return (await rl.question(hidden ? "" : "> ")).trim();
  } finally {
    rl.close();
    if (hidden) io.output.write("\n");
  }
}

export async function progress<T>(label: string, task: () => Promise<T>) {
  const started = Date.now();
  console.log(`\nEM EXECUÇÃO · ${label}`);
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    console.log(
      `AGUARDANDO RESULTADO · ${label} · ${elapsed}s decorridos. Não inicie outra instalação.`,
    );
  }, 10000);
  timer.unref();
  try {
    const result = await task();
    console.log(
      `OK · ${label} · ${Math.floor((Date.now() - started) / 1000)}s.`,
    );
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  await new Promise<void>((done, fail) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", () =>
      fail(
        Error(
          "Não foi possível iniciar npm/Wrangler. Confira node -v e npm -v.",
        ),
      ),
    );
    child.once("close", (status) => {
      if (status === 0) done();
      else
        fail(
          Error(
            "A etapa não concluiu. Corrija o erro e retome com --resume e a mesma pasta.",
          ),
        );
    });
  });
}
async function cloudflareGet(token: string, path: string, absent = false) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (absent && r.status === 404) return null;
  const data: any = await r.json();
  assertRelease(
    r.ok && data.success === true,
    `Cloudflare HTTP ${r.status}. Confira Account ID, validade e permissões do token.`,
  );
  return data.result;
}
export async function assertNewResources(
  token: string,
  account: string,
  name: string,
) {
  const buckets = await cloudflareGet(token, `/accounts/${account}/r2/buckets`);
  assertRelease(
    Array.isArray(buckets?.buckets),
    "Não foi possível conferir os buckets R2.",
  );
  assertRelease(
    !buckets.buckets.some((b: any) => b.name === name + "-media"),
    "Já existe um bucket R2 com esse nome. Escolha outro nome para preservar os arquivos existentes.",
  );
  for (let page = 1; ; page++) {
    const databases = await cloudflareGet(
      token,
      `/accounts/${account}/d1/database?per_page=100&page=${page}`,
    );
    assertRelease(
      Array.isArray(databases),
      "Não foi possível conferir os bancos D1.",
    );
    assertRelease(
      !databases.some((db: any) => db.name === name),
      "Já existe um banco D1 com esse nome. Escolha outro nome; uma instalação nova precisa de banco vazio.",
    );
    if (databases.length < 100) return;
  }
}
export async function install() {
  const args = process.argv.slice(2);
  const option = (name: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args.includes("--help")) {
    console.log(
      "Wabotia: instalação sem GitHub.\nnode install-wabotia.mjs [--name NOME] [--directory PASTA] [--resume]\nO assistente pede Account ID e token Cloudflare. Node.js 22.13+ e npm são necessários.\n--resume retoma somente a instalação identificada pela pasta local. Não apaga recursos.",
    );
    return;
  }
  const major = Number(process.versions.node.split(".")[0]);
  assertRelease(
    major > 22 ||
      (major === 22 && Number(process.versions.node.split(".")[1]) >= 13),
    "Instale Node.js 22.13 ou superior: https://wabotia.queven.app/install#nodejs",
  );
  console.log(
    "Wabotia · instalação direta na sua Cloudflare\nNão é necessário ter conta ou repositório GitHub.",
  );
  console.log(
    "Primeiro você informa Account ID, token e nome. Nenhuma publicação começa antes disso.\nDurante a execução, o assistente informa a etapa e o tempo a cada 10 segundos.\nSe estiver gravando, pause antes de preencher tokens ou abrir arquivos de chaves.",
  );
  const account =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    (await question("Account ID da Cloudflare"));
  const token =
    process.env.CLOUDFLARE_API_TOKEN ||
    (await question("Token de API da Cloudflare (não será exibido)", true));
  const name =
    option("--name") ||
    (await question(
      "Nome novo para a instalação (exemplo: wabotia-atendimento)",
    ));
  const base = scriptPath(account, name),
    folder = resolve(option("--directory") || name);
  assertRelease(token.length >= 20 && !/\s/.test(token), "Token inválido.");
  const stateFile = join(folder, "installation.local.json"),
    secretsFile = join(folder, "chaves.local.json"),
    configFile = join(folder, "wrangler.jsonc");
  let state: any;
  if (args.includes("--resume")) {
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assertRelease(
      state.account === account && state.name === name,
      "A pasta pertence a outra instalação.",
    );
    if (state.step === "done") {
      console.log(
        `Instalação já concluída. Abra ${state.url}/app. Para atualizar, use o painel.`,
      );
      return;
    }
    const savedSecrets = JSON.parse(await readFile(secretsFile, "utf8"));
    if (savedSecrets.WABOTIA_UPDATE_TOKEN !== token) {
      savedSecrets.WABOTIA_UPDATE_TOKEN = token;
      await writeFile(secretsFile, JSON.stringify(savedSecrets, null, 2), {
        mode: 0o600,
      });
      // A renewed token must reach the Worker even if only verification remained.
      if (state.step === "verify") state.step = "secrets";
    }
  } else {
    let exists = false;
    try {
      await access(folder);
      exists = true;
    } catch {}
    assertRelease(
      !exists,
      "A pasta já existe. Escolha outra pasta ou use --resume para retomar a mesma instalação.",
    );
    await progress(
      "Conferindo a conta e os nomes dos recursos na Cloudflare",
      async () => {
        assertRelease(
          !(await cloudflareGet(token, base + "/settings", true)),
          "Já existe um Worker com esse nome. Escolha um nome novo; o instalador não substitui outra instalação.",
        );
        await assertNewResources(token, account, name);
      },
    );
    const releaseDirectory = option("--release-dir");
    const index = releaseDirectory
      ? validateIndex(
          JSON.parse(
            await readFile(
              join(resolve(releaseDirectory), "release.json"),
              "utf8",
            ),
          ),
        )
      : await progress(
          "Consultando a versão oficial do Wabotia",
          latestRelease,
        );
    await mkdir(folder, { mode: 0o700 });
    state = {
      account,
      name,
      installation_id: randomUUID(),
      release_directory: releaseDirectory
        ? resolve(releaseDirectory)
        : undefined,
      index,
      step: "download",
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      secretsFile,
      JSON.stringify(
        {
          MASTER_KEY: randomBytes(32).toString("hex"),
          SETUP_TOKEN: randomBytes(32).toString("hex"),
          WABOTIA_UPDATE_TOKEN: token,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
  }
  const save = () =>
    writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  let npx = "npx",
    launcher: string[] = [];
  if (process.platform === "win32") {
    // Run npm's JS entry point directly: cmd.exe would interpret paths as code.
    const found = spawnSync("where.exe", ["npx.cmd"], { encoding: "utf8" });
    const candidates = [
      join(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"),
      ...(found.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => join(dirname(path), "node_modules/npm/bin/npx-cli.js")),
    ];
    const entry = candidates.find((path) => existsSync(path));
    assertRelease(
      entry,
      "npm não foi encontrado. Reinstale Node.js LTS com npm e abra um novo terminal.",
    );
    npx = process.execPath;
    launcher = [entry!];
  }
  const run = (command: string[]) =>
    runCommand(
      npx,
      [
        ...launcher,
        "--yes",
        "wrangler@4.157.0",
        ...command,
        "--config",
        configFile,
      ],
      {
        cwd: folder,
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_API_TOKEN: token,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
  if (state.step === "download") {
    console.log(
      `1/5 · Baixando e verificando a versão oficial ${state.index.version}.`,
    );
    const { pkg } = state.release_directory
      ? {
          pkg: await parsePackage(
            validateIndex(state.index),
            await readFile(join(state.release_directory, "package.json")),
          ),
        }
      : await progress("Baixando e conferindo o pacote oficial", () =>
          fetchPackage(validateIndex(state.index)),
        );
    await materializeRelease(folder, pkg);
    const config = {
      name,
      account_id: account,
      main: "worker/" + pkg.main_module,
      no_bundle: true,
      compatibility_date: pkg.compatibility_date,
      compatibility_flags: pkg.compatibility_flags,
      assets: { directory: "web", binding: "ASSETS", ...pkg.assets_config },
      d1_databases: [
        { binding: "DB", database_name: name, migrations_dir: "migrations" },
      ],
      r2_buckets: [{ binding: "MEDIA", bucket_name: name + "-media" }],
      durable_objects: {
        bindings: [{ name: "COORDINATOR", class_name: "Coordinator" }],
      },
      migrations: pkg.durable_migrations,
      triggers: { crons: ["*/5 * * * *"] },
      observability: { enabled: true },
      workers_dev: true,
      vars: {
        APP_NAME: "Wabotia",
        WABOTIA_ACCOUNT_ID: account,
        WABOTIA_WORKER_NAME: name,
        WABOTIA_INSTALLATION_ID: state.installation_id,
      },
    };
    await writeFile(configFile, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    state.step = "deploy";
    await save();
  }
  if (state.step === "deploy") {
    const existing = await cloudflareGet(token, base + "/settings", true);
    if (existing)
      assertRelease(
        existing.bindings?.some(
          (b: any) =>
            b.name === "WABOTIA_INSTALLATION_ID" &&
            b.text === state.installation_id,
        ),
        "O Worker existente pertence a outra instalação. A retomada foi interrompida.",
      );
    console.log("2/5 · Publicando Worker, D1, R2 e Durable Objects.");
    await progress(
      "Publicando Worker, banco e armazenamento (pode levar alguns minutos)",
      () => run(["deploy"]),
    );
    state.step = "migrate";
    await save();
  }
  if (state.step === "migrate") {
    console.log("3/5 · Preparando o banco.");
    await progress("Aplicando a estrutura do banco", () =>
      run(["d1", "migrations", "apply", "DB", "--remote"]),
    );
    state.step = "secrets";
    await save();
  }
  if (state.step === "secrets") {
    console.log(
      "4/5 · Guardando as chaves e habilitando a atualização pelo painel.",
    );
    await progress("Guardando as chaves no Worker", () =>
      run(["secret", "bulk", secretsFile]),
    );
    state.step = "verify";
    await save();
  }
  console.log("5/5 · Confirmando os recursos e a resposta do site publicado.");
  await progress("Confirmando a publicação na Cloudflare", async () => {
    const settings = await cloudflareGet(token, base + "/settings");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    const db = settings.bindings.find((b: any) => b.name === "DB");
    if (db?.id) config.d1_databases[0].database_id = db.id;
    await writeFile(configFile, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    const subdomain = await cloudflareGet(
      token,
      `/accounts/${account}/workers/subdomain`,
    );
    assertRelease(
      subdomain?.subdomain,
      "Habilite o subdomínio workers.dev no dashboard e retome o instalador.",
    );
    state.url = `https://${name}.${subdomain.subdomain}.workers.dev`;
    const health = await fetch(state.url + "/api/health", {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const info: any = await health.json();
    assertRelease(
      health.ok && info.commit === state.index.commit,
      "A publicação ainda não foi confirmada. Aguarde e retome o instalador com --resume.",
    );
  });
  state.step = "done";
  await save();
  await chmod(secretsFile, 0o600);
  console.log(
    `5/5 · Pronto: ${state.url}/app\nAbra ${secretsFile} e copie SETUP_TOKEN para criar o primeiro administrador.\nGuarde a pasta ${folder} em local privado. MASTER_KEY recupera suas credenciais; não gere outra para a mesma instalação.\nAs próximas versões são instaladas em Sistema e atualizações. O computador usado na instalação pode ser desligado.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  install().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "A instalação falhou.",
    );
    process.exitCode = 1;
  });
