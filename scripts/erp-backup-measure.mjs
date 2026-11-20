#!/usr/bin/env node
// Medição do backup lógico do ERP em páginas (src/erp/engine/backup-pages.ts):
// para cada tamanho, gera a massa sintética, faz backup e restauração num
// processo com heap fixo e imprime memória de pico, tempos, invocações e
// quanto tempo as escritas ficaram retidas. Sem rede; arquivos temporários.
//
//   node scripts/erp-backup-measure.mjs            # 16, 256 e 1024 MiB
//   node scripts/erp-backup-measure.mjs 16 64      # tamanhos à escolha
//   HEAP_MB=64 node scripts/erp-backup-measure.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("../tests/erp/backup/memory-probe.mjs", import.meta.url));
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const heap = Number(process.env.HEAP_MB ?? 48);
const rows = [];
for (const mib of sizes.length ? sizes : [16, 256, 1024]) {
  const run = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", `--max-old-space-size=${heap}`, probe, "--mib", String(mib)],
    { encoding: "utf8", timeout: 3_600_000, maxBuffer: 1 << 20 });
  if (run.status !== 0) { console.error(`falhou em ${mib} MiB (heap ${heap} MB):\n${run.stderr}`); process.exit(1); }
  const r = JSON.parse(run.stdout.trim().split("\n").at(-1));
  rows.push(r);
  console.log(JSON.stringify(r));
}
console.log(`\nheap máximo do processo: ${heap} MB (--max-old-space-size)`);
console.log("| dados (MiB) | NDJSON (bytes) | gzip (bytes) | partes | backup (s) | invocações | escritas retidas (s) | restauração (s) | invocações | troca (s) | pico de heap acima da base (MB) |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${r.mib} | ${r.text_bytes} | ${r.gzip_bytes} | ${r.parts} | ${(r.backup_ms / 1000).toFixed(1)} | ${r.backup_invocations} | ${(r.writes_held_ms / 1000).toFixed(1)} | ${(r.restore_ms / 1000).toFixed(1)} | ${r.restore_invocations} | ${(r.swap_ms / 1000).toFixed(1)} | ${r.heap_peak_over_base_mb} |`);
