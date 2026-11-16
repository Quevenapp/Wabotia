#!/usr/bin/env node
// Roteiro do ERP na instalação de teste (sessão K): confirma na Cloudflare o
// que a fase 0 só mediu no workerd local (docs/ERP-FASE0.md, "Roteiro da
// instalação de teste"). Dados sintéticos numa área NOVA, criada pelo
// roteiro; não toca a área dos aparelhos. No fim apaga o objeto erp: da área
// e desliga o módulo (a área vazia fica, com "(apagar)" no nome: não há rota
// para apagar área).
//
// Pré-requisitos:
// - o deploy com `--minify --var ERP_PROBES:1` (sem a variável as sondas
//   respondem 404);
// - .smoke.local.json com o administrador da instalação de teste (o mesmo
//   de scripts/smoke.mjs).
//
//   node scripts/erp/staging-check.mjs --url https://<instalação de teste> [--tail] [--config <wrangler.json>]
//
// --tail abre `wrangler tail --format json` em paralelo e soma a CPU (cpuTime)
// de cada chamada do ERP; sem ele, leia a CPU no painel (Workers →
// Observabilidade, filtro pelo caminho /erp-probe/). Resultado em
// output/staging-check-<instante>.json.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = (arg("--url") || "").replace(/\/$/, "");
if (!/^https:\/\/\S+$/.test(base)) throw Error("Informe --url https://<instalação de teste>.");
if (!base.includes("staging") && !process.argv.includes("--not-staging-ok"))
  throw Error("A URL não parece a instalação de teste (sem 'staging'). Use --not-staging-ok se tiver certeza.");
const credentials = JSON.parse(await readFile(".smoke.local.json", "utf8"));
const started = new Date().toISOString();
const report = { url: base, started, steps: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`· ${name}: ${JSON.stringify(data).slice(0, 400)}`);
};

// CPU pelo wrangler tail (opcional).
const cpu = [];
let tail = null;
if (process.argv.includes("--tail")) {
  const config = arg("--config");
  tail = spawn("npx", ["wrangler", "tail", "--format", "json", ...(config ? ["--config", config] : [])], {
    shell: process.platform === "win32",
  });
  let buffer = "";
  tail.stdout.on("data", (chunk) => {
    buffer += chunk;
    // Cada evento é um objeto JSON; o wrangler os separa por linha em branco.
    for (let i; (i = buffer.indexOf("\n}\n")) >= 0; ) {
      const text = buffer.slice(0, i + 2);
      buffer = buffer.slice(i + 3);
      try {
        const e = JSON.parse(text.slice(text.indexOf("{")));
        const url = e.event?.request?.url || "";
        if (/erp-probe|\/erp\/|erp-rpc/.test(url))
          cpu.push({ url: url.replace(/^https?:\/\/[^/]+/, ""), cpu_ms: e.cpuTime ?? null, wall_ms: e.wallTime ?? null, outcome: e.outcome });
      } catch {
        // evento parcial
      }
    }
  });
  await new Promise((r) => setTimeout(r, 8000)); // o tail leva alguns segundos para conectar
}

let cookie = "";
async function api(route, { method = "GET", body, expected = 200 } = {}) {
  const t0 = Date.now();
  const r = await fetch(base + "/api/" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const parsed = await r.json().catch(() => null);
  if (r.headers.has("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
  if (expected !== null && r.status !== expected)
    throw Error(`${method} ${route}: ${r.status} ${JSON.stringify(parsed?.error ?? parsed).slice(0, 300)}`);
  return { status: r.status, ms, body: parsed };
}
const probe = async (p, name, body = {}) => (await api(`v1/profiles/${p}/erp-probe/${name}`, { method: "POST", body })).body;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];

let profile = null;
try {
  await api("auth/login", { method: "POST", body: credentials });
  profile = (await api("v1/profiles", { method: "POST", body: { name: `ERP conferência ${started} (apagar)` } })).body.id;
  step("área de teste criada", { profile });
  await api(`v1/profiles/${profile}/modules/erp`, { method: "PUT", body: { enabled: true } });

  // 1. Localização (locationHint "sam").
  step("localização", await probe(profile, "location"));

  // 2. Primeira chamada (cria a instância e aplica o esquema) e costura da erp-api.
  step("preparo (vínculo, 100 produtos, 10 depósitos)", await probe(profile, "setup"));
  const cnae = [];
  for (let i = 0; i < 20; i++) cnae.push((await api(`v1/profiles/${profile}/erp/v1/plataforma/referencias/cnae?q=4744`)).ms);
  step("costura: GET referências/cnae × 20 (ms no cliente)", { first: cnae[0], p50: median(cnae.slice(1)), p95: p95(cnae.slice(1)) });

  // 3. erp_stock_post com 50 e 100 itens.
  for (const items of [50, 50, 100, 100]) step(`erp_stock_post ${items} itens`, await probe(profile, "stock-post", { items }));

  // 4. Carga de 100 mil lançamentos (5 × 200 movimentos × 100 linhas) e relatórios.
  for (let from = 1; from <= 1000; from += 200) step(`carga ${from}–${from + 199}`, await probe(profile, "load", { from, count: 200 }));
  for (const name of ["saldo", "extrato", "deposito", "saldo", "extrato", "deposito"]) step(`relatório ${name}`, await probe(profile, "report", { name }));

  // 5. Limites do SQLite de produção.
  step("limites", await probe(profile, "limits"));

  // 6. Recuperação no tempo: marca A, espera, marca B, bookmark do meio, restaura, confere.
  const a = await probe(profile, "bookmark-mark", { label: "a" });
  await new Promise((r) => setTimeout(r, 5000));
  const b = await probe(profile, "bookmark-mark", { label: "b" });
  const middle = Math.round((a.result.at + b.result.at) / 2);
  const at = await probe(profile, "bookmark-at", { at: middle });
  step("bookmark do instante entre A e B", at);
  step("restauração pedida", await probe(profile, "bookmark-restore", { bookmark: at.result.bookmark }));
  await new Promise((r) => setTimeout(r, 3000));
  const check = await probe(profile, "bookmark-check");
  const marks = (check.result.marks || []).map((m) => m.key);
  step("depois da restauração", { marks, ok: marks.includes("probe_mark_a") && !marks.includes("probe_mark_b") });
} finally {
  // 7. Limpeza: objeto erp: apagado e módulo desligado.
  if (profile) {
    try {
      step("limpeza", await probe(profile, "wipe"));
      await api(`v1/profiles/${profile}/modules/erp`, { method: "PUT", body: { enabled: false } });
    } catch (e) {
      step("limpeza falhou", { error: String(e.message) });
    }
  }
  // Fecha a sessão do administrador do roteiro.
  if (cookie) await api("v1/logout", { method: "POST", expected: null }).catch(() => {});
  if (tail) {
    await new Promise((r) => setTimeout(r, 5000));
    // No Windows o tail roda sob o shell (npx.cmd): kill() só fecha o shell e
    // deixa o wrangler órfão. taskkill /T encerra a árvore inteira.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(tail.pid), "/T", "/F"], { stdio: "ignore" });
    else tail.kill();
    report.cpu = cpu;
    const by = {};
    for (const c of cpu) (by[c.url.replace(/\?.*$/, "")] ??= []).push(c.cpu_ms);
    console.log("CPU por rota (ms):", JSON.stringify(by));
  }
  report.finished = new Date().toISOString();
  await mkdir("output", { recursive: true });
  const file = `output/staging-check-${started.replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(`Relatório: ${file}`);
}
