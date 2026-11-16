// Pacote de formato 2 de mentira para os testes do atualizador e dos
// instaladores: manifesto, blobs por SHA-256 e índice v2 assinados por um par
// Ed25519 gerado na hora, servidos por um fetch simulado na origem oficial.
import { Buffer } from "node:buffer";
import {
  blobPath,
  digest,
  INDEX_PATH,
  INDEX_SIGNATURE_PATH,
  manifestPath,
  manifestSignaturePath,
  RELEASE_ORIGIN,
  signedBytes,
  trustReleaseKeysForTests,
  type BlobRef,
  type ReleaseIndexV2,
  type ReleaseManifest,
  type SignedKind,
} from "../src/release";

export interface TestKey {
  id: string;
  privateKey: CryptoKey;
  ed25519: string;
}
let keys: Record<"principal" | "reserva" | "unknown", TestKey> | null = null;
/**
 * Principal e reserva de teste (confiáveis) e uma terceira fora da lista.
 * Troca as chaves embutidas pelas de teste nesta instância do módulo.
 */
export async function testKeys() {
  if (!keys) {
    const make = async (id: string): Promise<TestKey> => {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const raw = (await crypto.subtle.exportKey(
        "raw",
        pair.publicKey,
      )) as ArrayBuffer;
      return {
        id,
        privateKey: pair.privateKey,
        ed25519: Buffer.from(raw).toString("base64url"),
      };
    };
    keys = {
      principal: await make("principal"),
      reserva: await make("reserva"),
      unknown: await make("desconhecida"),
    };
  }
  trustReleaseKeysForTests(
    [keys.principal, keys.reserva].map(({ id, ed25519 }) => ({ id, ed25519 })),
  );
  return keys;
}

/** Arquivo .sig, como o scripts/release.mjs grava. */
export async function signFile(
  kind: SignedKind,
  bytes: Uint8Array,
  key: TestKey,
  keyId = key.id,
) {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key.privateKey,
    signedBytes(kind, bytes),
  );
  return Buffer.from(
    JSON.stringify({
      format: 1,
      algorithm: "Ed25519",
      key_id: keyId,
      signature: Buffer.from(signature).toString("base64"),
    }),
  );
}

export interface ReleaseSpec {
  version: string;
  commit: string;
  modules: { name: string; type?: string; body: string | Uint8Array }[];
  assets: { name: string; type?: string; body: string | Uint8Array }[];
  migrations: { name: string; statements: string[] }[];
  requires?: { min_version: string; workers_paid: boolean };
  assets_config?: Record<string, unknown>;
  durable_migrations?: unknown[];
  /** Quem assina (padrão: principal); null deixa sem assinatura. */
  signer?: "principal" | "reserva" | "unknown" | null;
  issued_at?: number;
  expires?: number;
}
export interface BuiltRelease {
  index: ReleaseIndexV2;
  indexBytes: Buffer;
  indexSignature: Buffer | null;
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  manifestSignature: Buffer | null;
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
  const issued = spec.issued_at ?? Date.now() - 60000;
  const index: ReleaseIndexV2 = {
    format: 2,
    version: spec.version,
    commit: spec.commit,
    manifest_sha256: await digest(manifestBytes),
    manifest_size: manifestBytes.length,
    total_size: total,
    requires: spec.requires || { min_version: "0.0.1", workers_paid: false },
    issued_at: issued,
    expires: spec.expires ?? issued + 90 * 86400000,
  };
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2));
  const signer = spec.signer === undefined ? "principal" : spec.signer;
  const key = signer ? (await testKeys())[signer] : null;
  return {
    index,
    indexBytes,
    indexSignature: key ? await signFile("index", indexBytes, key) : null,
    manifest,
    manifestBytes,
    manifestSignature: key
      ? await signFile("manifest", manifestBytes, key)
      : null,
    blobs,
  };
}

const json = { "Content-Type": "application/json" };
/** Resposta da origem oficial para um caminho de /releases/…, ou null. */
export function serveRelease(url: URL, release: BuiltRelease) {
  if (url.origin !== RELEASE_ORIGIN) return null;
  const missing = () => new Response("not found", { status: 404 });
  if (url.pathname === INDEX_PATH)
    return new Response(release.indexBytes, { headers: json });
  if (url.pathname === INDEX_SIGNATURE_PATH)
    return release.indexSignature
      ? new Response(release.indexSignature, { headers: json })
      : missing();
  if (url.pathname === manifestPath(release.index.version))
    return new Response(release.manifestBytes, { headers: json });
  if (url.pathname === manifestSignaturePath(release.index.version))
    return release.manifestSignature
      ? new Response(release.manifestSignature, { headers: json })
      : missing();
  const blob = /^\/releases\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
  if (blob && release.blobs.has(blob[1]))
    return new Response(release.blobs.get(blob[1]), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  return missing();
}

export { blobPath };
