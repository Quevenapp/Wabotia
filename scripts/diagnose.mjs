#!/usr/bin/env node
const url = process.argv[2];
if (!url)
  throw Error("Uso: node scripts/diagnose.mjs https://seu-worker.workers.dev");
for (const route of [
  "/api/health",
  "/api/auth/status",
  "/api/openapi.json",
  "/install",
  "/guide/wabotia-instalacao.pdf",
]) {
  try {
    const r = await fetch(new URL(route, url), {
      signal: AbortSignal.timeout(15000),
    });
    console.log(r.status, route);
    if (route.endsWith("status") && r.ok) console.log(await r.json());
    await r.body?.cancel();
  } catch {
    console.log("Falha de conexão", route);
  }
}
