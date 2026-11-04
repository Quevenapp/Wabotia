#!/usr/bin/env node
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const args = process.argv.slice(2),
  get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const environment = get("--environment", "production"),
  name = get(
    "--name",
    environment === "production" ? "wabotia" : "wabotia-" + environment,
  ),
  domain = get("--domain", "");
if (
  !/^[a-z][a-z0-9-]{2,45}$/.test(name) ||
  !["production", "staging"].includes(environment)
)
  throw Error("Use um nome simples e --environment production ou staging.");
const configPath = `wrangler.${environment}.local.json`,
  secretsPath = `.secrets.${environment}.local.json`;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
function run(command, options = {}) {
  const r = spawnSync(npx, ["wrangler", ...command, "--config", configPath], {
    stdio: "inherit",
    ...options,
  });
  if (r.status !== 0)
    throw Error(
      "A etapa falhou. Corrija a mensagem acima e execute novamente.",
    );
  return r;
}
let config;
try {
  config = parse(await readFile(configPath, "utf8"));
} catch {
  config = parse(await readFile("wrangler.jsonc", "utf8"));
  config.name = name;
  config.d1_databases[0].database_name = name;
  config.r2_buckets[0].bucket_name = name + "-media";
  delete config.d1_databases[0].database_id;
  if (domain) config.routes = [{ pattern: domain, custom_domain: true }];
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
if (domain) {
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
    throw Error("Domínio inválido.");
  config.routes = [{ pattern: domain, custom_domain: true }];
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
console.log(
  "1/5 · Confira a conta Cloudflare (execute npx wrangler login se necessário).",
);
run(["whoami"]);
console.log("2/5 · Provisionando Worker, D1, R2 e Durable Objects.");
const build = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "build"],
  { stdio: "inherit" },
);
if (build.status !== 0) throw Error("Build falhou.");
run(["deploy"]);
console.log("3/5 · Preparando o banco.");
run(["d1", "migrations", "apply", "DB", "--remote"]);
console.log("4/5 · Configurando secrets sem mostrá-los no terminal.");
let secrets;
try {
  secrets = JSON.parse(await readFile(secretsPath, "utf8"));
} catch {
  const prior = run(["secret", "list"], { stdio: "pipe", encoding: "utf8" });
  if (JSON.parse(prior.stdout).some((entry) => entry.name === "MASTER_KEY"))
    throw Error(
      "Este Worker já tem MASTER_KEY. Recupere o arquivo local de secrets original; não substitua a chave de uma instalação existente.",
    );
  secrets = {
    MASTER_KEY: randomBytes(32).toString("hex"),
    SETUP_TOKEN: randomBytes(32).toString("hex"),
  };
  await writeFile(secretsPath, JSON.stringify(secrets, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
run(["secret", "bulk", secretsPath]);
console.log(
  `5/5 · Pronto. Abra a URL exibida pelo deploy e acrescente /app. O código inicial está em ${secretsPath}, campo SETUP_TOKEN. Guarde esse arquivo em local seguro: MASTER_KEY é necessária para restaurar as credenciais. Arquivos .local.json não vão para o GitHub.`,
);
