// Pacote de formato 2 de mentira para os testes do atualizador e dos
// instaladores: manifesto, blobs por SHA-256 e índice v2, servidos por um
// fetch simulado na origem oficial.
import { Buffer } from "node:buffer";
import {
  blobPath,
  digest,
  manifestPath,
  RELEASE_ORIGIN,
  type BlobRef,
  type ReleaseIndexV2,
  type ReleaseManifest,
} from "../src/release";

export interface ReleaseSpec {
  version: string;
  commit: string;
  modules: { name: string; type?: string; body: string | Uint8Array }[];
  assets: { name: string; type?: string; body: string | Uint8Array }[];
  migrations: { name: string; statements: string[] }[];
  requires?: { min_version: string; workers_paid: boolean };
  assets_config?: Record<string, unknown>;
  durable_migrations?: unknown[];
}
export interface BuiltRelease {
  index: ReleaseIndexV2;
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  blobs: Map<string, Uint8Array>;
}

const bytesOf = (body: string | Uint8Array) =>
  typeof body === "string" ? new Uint8Array(Buffer.from(body)) : body;

export async function buildRelease(spec: ReleaseSpec): Promise<BuiltRelease> {
  const blobs = new Map<string, Uint8Array>();
  const ref = async (name: string, type: string, body: string | Uint8Array) => {
    const bytes = bytesOf(body);
    const sha256 = await digest(bytes);
    blobs.set(sha256, bytes);
    return { name, type, size: bytes.length, sha256 } as BlobRef;
  };
  const manifest: ReleaseManifest = {
    format: 2,
    version: spec.version,
    commit: spec.commit,
    main_module: "index.js",
    compatibility_date: "2026-11-04",
    compatibility_flags: ["nodejs_compat"],
    assets_config: spec.assets_config || {
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/webhooks/*", "/internal/*"],
      _headers: "/*\n  X-Test: 1\n",
    },
    durable_migrations: (spec.durable_migrations as any) || [
      { tag: "v1", new_sqlite_classes: ["Coordinator"] },
    ],
    modules: await Promise.all(
      spec.modules.map((m) =>
        ref(m.name, m.type || "application/javascript+module", m.body),
      ),
    ),
    assets: await Promise.all(
      spec.assets.map((a) => ref(a.name, a.type || "text/html", a.body)),
    ),
    migrations: await Promise.all(
      spec.migrations.map((m) =>
        ref(m.name, "application/json", JSON.stringify(m.statements)),
      ),
    ),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const total = [...blobs.values()].reduce((a, b) => a + b.length, 0);
  return {
    manifest,
    manifestBytes,
    blobs,
    index: {
      format: 2,
      version: spec.version,
      commit: spec.commit,
      manifest_sha256: await digest(manifestBytes),
      manifest_size: manifestBytes.length,
      total_size: total,
      requires: spec.requires || { min_version: "0.0.1", workers_paid: false },
    },
  };
}

/** Resposta da origem oficial para um caminho de /releases/…, ou null. */
export function serveRelease(url: URL, release: BuiltRelease) {
  if (url.origin !== RELEASE_ORIGIN) return null;
  if (url.pathname === "/releases/v2/latest.json")
    return Response.json(release.index);
  if (url.pathname === manifestPath(release.index.version))
    return new Response(release.manifestBytes, {
      headers: { "Content-Type": "application/json" },
    });
  const blob = /^\/releases\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
  if (blob && release.blobs.has(blob[1]))
    return new Response(release.blobs.get(blob[1]), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  return new Response("not found", { status: 404 });
}

export { blobPath };
