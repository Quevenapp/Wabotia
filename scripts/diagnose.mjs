#!/usr/bin/env node
const url = process.argv[2];
if (!url)
  throw Error("Uso: node scripts/diagnose.mjs https://seu-worker.workers.dev");
let failed = false;
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
    if (!r.ok) throw Error("HTTP " + r.status);
    if (route.endsWith("/status")) {
      const state = await r.json();
      if (!state.configured) throw Error("Secrets não configurados");
      console.log(
        "OK",
        route,
        state.initialized
          ? "Administrador criado"
          : "Pronto para criar o administrador",
      );
    } else if (route.endsWith(".pdf")) {
      if (!r.headers.get("content-type")?.includes("application/pdf"))
        throw Error("PDF ausente ou resposta HTML");
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
        throw Error("Arquivo não é PDF");
      console.log("OK", route, bytes.length + " bytes");
    } else {
      console.log("OK", route);
      await r.body?.cancel();
    }
  } catch (error) {
    failed = true;
    console.log("FALHA", route, error.message);
  }
}
process.exitCode = failed ? 1 : 0;
