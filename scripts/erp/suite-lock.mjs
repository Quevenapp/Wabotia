// Trava entre sessões para a suíte completa (docs/ERP-PORTE.md, "Suíte do
// tronco"): no máximo 2 suítes completas ao mesmo tempo na máquina, mais uma
// vaga reservada para a rodada do tronco (ERP_TRUNK_ROUND=1, só a N usa).
// - Diretório comum, fora dos worktrees: ERP_SUITE_LOCK_DIR, ou
//   <pasta acima do repositório>/.suite-locks (D:\Code\wabotia\.suite-locks).
// - Cada vaga é um arquivo criado com "wx" (atômico), com o dono: pid, host,
//   worktree, branch e desde quando.
// - Vaga de processo que não existe mais, ou com mais de 90 min, é liberada.
// - Quem não acha vaga espera e imprime, a cada minuto, quem está segurando.
// - A vaga sai na saída do processo, também em erro ou Ctrl+C.
import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const SLOTS = ["slot-1", "slot-2"];
const TRUNK = "trunk";
const STALE_MS = 90 * 60 * 1000;

function lockDir() {
  if (process.env.ERP_SUITE_LOCK_DIR) return process.env.ERP_SUITE_LOCK_DIR;
  const top = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  // <repositório>/.git → a pasta acima do repositório (comum a todos os worktrees).
  return resolve(top, "..", "..", ".suite-locks");
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

function read(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A vaga está livre (não existe, dono morto ou vencida)? Libera a vencida. */
function reclaim(file) {
  const owner = read(file);
  if (owner === null) {
    try {
      unlinkSync(file);
    } catch {}
    return true;
  }
  const stale = !alive(owner.pid) || owner.host !== hostname() || Date.now() - Date.parse(owner.since) > STALE_MS;
  if (stale) {
    try {
      unlinkSync(file);
    } catch {}
    return true;
  }
  return false;
}

function tryTake(file, me) {
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, JSON.stringify(me));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return false;
  }
}

/** Espera `ms`, ou menos se o sinal cancelar. */
const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/**
 * Pega uma vaga (espera se preciso) e devolve a função que a libera; a
 * liberação também fica registrada para a saída do processo.
 */
export async function acquireSuiteSlot(label = "suíte completa", { signal } = {}) {
  const dir = lockDir();
  mkdirSync(dir, { recursive: true });
  const trunk = process.env.ERP_TRUNK_ROUND === "1";
  const candidates = trunk ? [TRUNK, ...SLOTS] : SLOTS;
  let branch = "?";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  const me = { pid: process.pid, host: hostname(), worktree: process.cwd(), branch, label, since: new Date().toISOString() };
  let lastReport = 0;
  for (;;) {
    for (const name of candidates) {
      const file = join(dir, `${name}.json`);
      if (tryTake(file, me) || (reclaim(file) && tryTake(file, me))) {
        let held = true;
        const release = () => {
          if (!held) return;
          held = false;
          const owner = read(file);
          if (owner && owner.pid === process.pid) {
            try {
              unlinkSync(file);
            } catch {}
          }
        };
        process.on("exit", release);
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])
          process.on(sig, () => {
            release();
            process.exit(130);
          });
        console.log(`Trava da suíte: vaga ${name} (${dir}).`);
        return release;
      }
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      const holders = readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => ({ n, o: read(join(dir, n)) }))
        .filter((x) => x.o)
        .map((x) => `  ${x.n.replace(/\.json$/, "")}: pid ${x.o.pid}, ${x.o.worktree} (${x.o.branch}), desde ${x.o.since}`);
      console.log(`Trava da suíte: sem vaga; esperando. Segurando agora:\n${holders.join("\n")}`);
    }
    await sleep(15_000, signal);
    if (signal?.aborted) throw new Error("Trava da suíte: espera cancelada.");
  }
}
