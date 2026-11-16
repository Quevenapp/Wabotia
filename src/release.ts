// Pacote de publicação do Wabotia (formato 2), lido pelo atualizador do
// painel e pelos dois instaladores. Nenhuma credencial do cliente vai para a
// origem oficial; só a Cloudflare recebe o token de API.
// Formato, assinatura e limites: docs/ATUALIZACOES-FORMATO.md.
//
//   /releases/v2/latest.json            índice (versão, commit, SHA-256 do
//   /releases/v2/latest.sig             manifesto, validade) e a assinatura
//   /releases/<versão>/manifest.json    metadados; modules/assets/migrations
//   /releases/<versão>/manifest.sig     como {name, type, size, sha256}
//   /releases/blobs/<sha256>            bytes crus, endereçados por conteúdo
//
// O índice e o manifesto são assinados com Ed25519 por uma das chaves de
// src/release-keys.json. O índice tem prazo (`expires`): um índice velho,
// mesmo assinado, é recusado. Os blobs são conferidos pelo SHA-256 que o
// manifesto assinado traz.
import { Buffer } from "node:buffer";
import releaseKeys from "./release-keys.json";

export const OFFICIAL_RELEASE_ORIGIN = "https://wabotia.queven.app";
// Só o build de teste (`npm run release -- --test-origin <url>`) define esta
// constante, com `<url>/api/test-catalog`: a instalação de teste serve o
// próprio catálogo do R2 (TEST_CATALOG_PREFIX). No build oficial ela não
// existe e vale o endereço oficial.
declare const __WABOTIA_TEST_RELEASE_ORIGIN__: string | undefined;
export const TEST_CATALOG_PATH = "/api/test-catalog";
export const TEST_CATALOG_PREFIX = "test-catalog";
export const RELEASE_ORIGIN: string =
  typeof __WABOTIA_TEST_RELEASE_ORIGIN__ === "string"
    ? __WABOTIA_TEST_RELEASE_ORIGIN__
    : OFFICIAL_RELEASE_ORIGIN;

/**
 * Um pacote de teste traz `test_origin` assinado no índice e no manifesto e
 * só vale num build de teste que aponta para essa mesma origem. O build
 * oficial recusa qualquer `test_origin`, seja qual for o valor (inclusive o
 * próprio endereço oficial) e esteja a assinatura como estiver.
 */
export function testOriginAccepted(value: unknown) {
  if (value === undefined) return true;
  return RELEASE_ORIGIN !== OFFICIAL_RELEASE_ORIGIN && value === RELEASE_ORIGIN;
}

export const MAX_MANIFEST = 2 * 1024 * 1024;
/** Teto por arquivo: o de um estático da Cloudflare, que serve os blobs. */
export const MAX_BLOB = 25 * 1024 * 1024;
/** Módulos do Worker somados (o Worker aceita 64 MiB sem compressão). */
export const MAX_MODULES_TOTAL = 40 * 1024 * 1024;
/** Todos os arquivos únicos da versão somados. */
export const MAX_TOTAL = 160 * 1024 * 1024;
export const MAX_MODULES = 256;
export const MAX_ASSETS = 2000;
export const MAX_MIGRATIONS = 1000;
/** Hashes por lote da sessão de envio de estáticos da Cloudflare. */
export const MAX_UPLOAD_BATCH = 2000;
/** Por rodada do atualizador: até 20 arquivos ou 16 MiB (o que vier antes). */
export const ROUND_FILES = 20;
export const ROUND_BYTES = 16 * 1024 * 1024;
/** Validade máxima de um índice assinado. */
export const MAX_INDEX_DAYS = 180;

export function assertRelease(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function digest(value: Uint8Array | string) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  ).toString("hex");
}
export async function limitedBody(response: Response, limit: number) {
  assertRelease(
    response.ok && response.body,
    `Não foi possível baixar a versão oficial (HTTP ${response.status}).`,
  );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assertRelease(
        size <= limit,
        "O pacote oficial excedeu o tamanho permitido.",
      );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Assinatura (Ed25519)

export interface ReleaseKey {
  id: string;
  /** Chave pública crua, 32 bytes em base64url. */
  ed25519: string;
}
/** Chaves públicas embutidas; a lista só muda numa versão assinada. */
export const RELEASE_KEYS: readonly ReleaseKey[] = releaseKeys.keys;
let trusted: readonly ReleaseKey[] = RELEASE_KEYS;
/** Só para testes: troca as chaves confiáveis (com `null`, volta às embutidas). */
export function trustReleaseKeysForTests(keys: readonly ReleaseKey[] | null) {
  trusted = keys || RELEASE_KEYS;
}

/** O que cada assinatura cobre: separa índice de manifesto. */
export const SIGNATURE_DOMAIN = {
  index: "wabotia-release-index-v2\n",
  manifest: "wabotia-release-manifest-v2\n",
} as const;
export type SignedKind = keyof typeof SIGNATURE_DOMAIN;

/** Bytes assinados: o domínio seguido dos bytes exatos do arquivo. */
export function signedBytes(kind: SignedKind, bytes: Uint8Array) {
  return Buffer.concat([
    Buffer.from(SIGNATURE_DOMAIN[kind], "utf8"),
    Buffer.from(bytes),
  ]);
}

export interface SignatureFile {
  format: 1;
  algorithm: "Ed25519";
  key_id: string;
  /** 64 bytes em base64. */
  signature: string;
}

const signatureError = (detail: string) =>
  new Error(
    `A assinatura da versão oficial não confere (${detail}). Nada foi alterado.`,
  );

/**
 * Confere a assinatura de um índice ou manifesto contra as chaves embutidas.
 * Devolve o id da chave que assinou.
 */
export async function verifySignature(
  kind: SignedKind,
  bytes: Uint8Array,
  signature: Uint8Array | null,
) {
  if (!signature?.length) throw signatureError("versão sem assinatura");
  let file: SignatureFile;
  try {
    file = JSON.parse(Buffer.from(signature).toString("utf8"));
  } catch {
    throw signatureError("arquivo de assinatura inválido");
  }
  if (
    file?.format !== 1 ||
    file.algorithm !== "Ed25519" ||
    typeof file.signature !== "string"
  )
    throw signatureError("arquivo de assinatura inválido");
  const key = trusted.find((k) => k.id === file.key_id);
  if (!key) throw signatureError("chave desconhecida");
  const sig = Buffer.from(file.signature, "base64");
  if (sig.length !== 64) throw signatureError("assinatura malformada");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(key.ed25519, "base64url"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    sig,
    signedBytes(kind, bytes),
  );
  if (!ok) throw signatureError("conteúdo alterado ou chave errada");
  return key.id;
}

// ---------------------------------------------------------------------------
// Índice

export interface ReleaseIndexV2 {
  format: 2;
  version: string;
  commit: string;
  manifest_sha256: string;
  manifest_size: number;
  total_size: number;
  requires: { min_version: string; workers_paid: boolean };
  /** Quando foi assinado e até quando vale (ms Unix). */
  issued_at: number;
  expires: number;
  /** Só em pacote de teste: a origem do catálogo de teste. */
  test_origin?: string;
}
export interface BlobRef {
  name: string;
  type: string;
  size: number;
  sha256: string;
}
export interface ReleaseManifest {
  format: 2;
  version: string;
  commit: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets_config: Record<string, unknown>;
  durable_migrations: { tag: string; new_sqlite_classes?: string[] }[];
  modules: BlobRef[];
  assets: BlobRef[];
  /** Cada blob de migração é um JSON: lista de instruções SQL. */
  migrations: BlobRef[];
}

const semver = /^\d+\.\d+\.\d+$/;
/** a >= b, em versões x.y.z. */
export function versionAtLeast(a: string, b: string) {
  if (!semver.test(a) || !semver.test(b)) return false;
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}
/** a > b, em versões x.y.z. */
export const versionGreater = (a: string, b: string) =>
  versionAtLeast(a, b) && a !== b;

/**
 * Estrutura do índice. Com `at`, confere também a validade: assinado há no
 * máximo 180 dias e ainda dentro de `expires`.
 */
export function validateIndexV2(value: any, at?: number): ReleaseIndexV2 {
  assertRelease(
    value?.format === 2 &&
      semver.test(value.version) &&
      /^[a-f0-9]{40}$/.test(value.commit) &&
      /^[a-f0-9]{64}$/.test(value.manifest_sha256) &&
      Number.isSafeInteger(value.manifest_size) &&
      value.manifest_size > 0 &&
      value.manifest_size <= MAX_MANIFEST &&
      Number.isSafeInteger(value.total_size) &&
      value.total_size > 0 &&
      value.total_size <= MAX_TOTAL &&
      semver.test(value.requires?.min_version) &&
      typeof value.requires?.workers_paid === "boolean" &&
      Number.isSafeInteger(value.issued_at) &&
      Number.isSafeInteger(value.expires) &&
      value.expires > value.issued_at &&
      value.expires - value.issued_at <= MAX_INDEX_DAYS * 86400000,
    "A versão oficial não contém um índice de publicação válido.",
  );
  assertRelease(
    testOriginAccepted(value.test_origin),
    "Este é um pacote de teste e não vale nesta instalação. Nada foi alterado.",
  );
  if (at !== undefined) {
    assertRelease(
      value.issued_at <= at + 86400000,
      "O índice da versão oficial tem data no futuro. Confira o relógio e tente mais tarde.",
    );
    assertRelease(
      value.expires > at,
      "O índice da versão oficial venceu: o mantenedor precisa renová-lo. O atendimento continua normal; tente mais tarde.",
    );
  }
  return {
    format: 2,
    version: value.version,
    commit: value.commit,
    manifest_sha256: value.manifest_sha256,
    manifest_size: value.manifest_size,
    total_size: value.total_size,
    requires: {
      min_version: value.requires.min_version,
      workers_paid: value.requires.workers_paid,
    },
    issued_at: value.issued_at,
    expires: value.expires,
    ...(value.test_origin === undefined ? {} : { test_origin: value.test_origin }),
  };
}

export const INDEX_PATH = "/releases/v2/latest.json";
export const INDEX_SIGNATURE_PATH = "/releases/v2/latest.sig";
export const manifestPath = (version: string) =>
  `/releases/${version}/manifest.json`;
export const manifestSignaturePath = (version: string) =>
  `/releases/${version}/manifest.sig`;
export const blobPath = (sha256: string) => `/releases/blobs/${sha256}`;

/** Índice já com a assinatura conferida, a partir dos bytes. */
export async function parseIndex(
  bytes: Uint8Array,
  signature: Uint8Array | null,
  at: number = Date.now(),
) {
  await verifySignature("index", bytes, signature);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    value = null;
  }
  return validateIndexV2(value, at);
}

const fetchRelease = (path: string) =>
  fetch(RELEASE_ORIGIN + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
/** Assinatura opcional na resposta: ausente vira null (a verificação recusa). */
async function signatureBody(path: string) {
  const r = await fetchRelease(path);
  if (r.status === 404) return null;
  return limitedBody(r, 4096);
}

export async function latestReleaseV2(): Promise<ReleaseIndexV2> {
  const bytes = await limitedBody(await fetchRelease(INDEX_PATH), 8192);
  return parseIndex(bytes, await signatureBody(INDEX_SIGNATURE_PATH));
}

// ---------------------------------------------------------------------------
// Manifesto e arquivos

function validRef(f: any, group: "module" | "asset" | "migration") {
  return (
    f &&
    typeof f.name === "string" &&
    f.name.length <= 300 &&
    (group === "asset"
      ? /^\/[a-zA-Z0-9_./-]+$/
      : group === "module"
        ? /^[a-zA-Z0-9_./-]+$/
        : /^\d{4}_[a-z0-9_]+\.sql$/
    ).test(f.name) &&
    !f.name.split("/").includes("..") &&
    typeof f.type === "string" &&
    f.type.length < 120 &&
    Number.isSafeInteger(f.size) &&
    f.size >= 0 &&
    f.size <= MAX_BLOB &&
    /^[a-f0-9]{64}$/.test(f.sha256)
  );
}

/**
 * Confere o manifesto: a assinatura, o SHA-256 e o tamanho fixados no
 * índice, a estrutura e as travas de Durable Object e rotas.
 */
export async function parseManifest(
  index: ReleaseIndexV2,
  bytes: Uint8Array,
  signature: Uint8Array | null,
): Promise<ReleaseManifest> {
  await verifySignature("manifest", bytes, signature);
  assertRelease(
    bytes.length === index.manifest_size &&
      (await digest(bytes)) === index.manifest_sha256,
    "A integridade do manifesto oficial não confere. Nenhuma publicação foi feita.",
  );
  const p = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assertRelease(
    p.format === 2 &&
      p.version === index.version &&
      p.commit === index.commit &&
      p.test_origin === index.test_origin,
    "O manifesto não corresponde à versão escolhida.",
  );
  assertRelease(
    testOriginAccepted(p.test_origin),
    "Este é um pacote de teste e não vale nesta instalação. Nada foi alterado.",
  );
  assertRelease(
    /^\d{4}-\d{2}-\d{2}$/.test(p.compatibility_date) &&
      Array.isArray(p.compatibility_flags) &&
      p.compatibility_flags.every((v: unknown) => typeof v === "string") &&
      Array.isArray(p.modules) &&
      p.modules.length > 0 &&
      p.modules.length <= MAX_MODULES &&
      Array.isArray(p.assets) &&
      p.assets.length > 0 &&
      p.assets.length <= MAX_ASSETS &&
      Array.isArray(p.migrations) &&
      p.migrations.length <= MAX_MIGRATIONS,
    "Estrutura do pacote oficial inválida.",
  );
  const seen = new Set<string>();
  const sizes = new Map<string, number>();
  let modulesTotal = 0;
  for (const [group, files] of [
    ["module", p.modules],
    ["asset", p.assets],
    ["migration", p.migrations],
  ] as const) {
    for (const f of files) {
      assertRelease(
        validRef(f, group) && !seen.has(group + f.name),
        group === "migration"
          ? "Migração inválida no pacote oficial."
          : "Arquivo inválido no pacote oficial.",
      );
      seen.add(group + f.name);
      // O mesmo conteúdo tem o mesmo tamanho em qualquer lugar.
      assertRelease(
        !sizes.has(f.sha256) || sizes.get(f.sha256) === f.size,
        "Arquivo corrompido no pacote oficial.",
      );
      sizes.set(f.sha256, f.size);
      if (group === "module") modulesTotal += f.size;
    }
  }
  const migrationNames = p.migrations.map((m: BlobRef) => m.name);
  assertRelease(
    migrationNames.every(
      (name: string, i: number) => i === 0 || migrationNames[i - 1] < name,
    ),
    "Migrações fora de ordem no pacote oficial.",
  );
  assertRelease(
    modulesTotal <= MAX_MODULES_TOTAL,
    "O Worker desta versão excede o tamanho permitido.",
  );
  assertRelease(
    [...sizes.values()].reduce((a, b) => a + b, 0) === index.total_size,
    "O tamanho total do pacote não confere com o índice.",
  );
  assertRelease(
    p.modules.some(
      (f: BlobRef) =>
        f.name === p.main_module && f.type === "application/javascript+module",
    ),
    "Módulo principal inválido.",
  );
  // Durable Objects e rotas do Worker fixos: o atualizador nunca cria recurso.
  assertRelease(
    JSON.stringify(p.durable_migrations) ===
      JSON.stringify([{ tag: "v1", new_sqlite_classes: ["Coordinator"] }]),
    "Esta versão altera Durable Objects e exige atualização manual.",
  );
  assertRelease(
    p.assets_config?.not_found_handling === "single-page-application" &&
      JSON.stringify(p.assets_config?.run_worker_first) ===
        JSON.stringify(["/api/*", "/webhooks/*", "/internal/*"]),
    "Configuração de arquivos incompatível.",
  );
  return p;
}

export async function fetchManifest(index: ReleaseIndexV2) {
  validateIndexV2(index);
  const bytes = await limitedBody(
    await fetchRelease(manifestPath(index.version)),
    MAX_MANIFEST,
  );
  const signature = await signatureBody(manifestSignaturePath(index.version));
  return {
    manifest: await parseManifest(index, bytes, signature),
    bytes,
    signature: signature!,
  };
}

/** Confere tamanho e SHA-256 de um arquivo baixado ou relido. */
export async function checkBlob(ref: BlobRef, bytes: Uint8Array) {
  assertRelease(
    bytes.length === ref.size && (await digest(bytes)) === ref.sha256,
    `Arquivo corrompido no pacote oficial (${ref.name}). Nenhuma publicação foi feita.`,
  );
  return bytes;
}

export async function fetchBlob(ref: BlobRef) {
  // Arquivo vazio: a resposta pode vir sem corpo; o SHA-256 confere o vazio.
  if (ref.size === 0) return checkBlob(ref, new Uint8Array(0));
  const r = await fetch(RELEASE_ORIGIN + blobPath(ref.sha256), {
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  return checkBlob(ref, await limitedBody(r, Math.min(MAX_BLOB, ref.size)));
}

/** Arquivos únicos da versão (por SHA-256), em ordem estável. */
export function uniqueBlobs(m: ReleaseManifest) {
  const out = new Map<string, BlobRef>();
  for (const f of [...m.modules, ...m.migrations, ...m.assets])
    if (!out.has(f.sha256)) out.set(f.sha256, f);
  return [...out.values()];
}

/** Próxima rodada: até ROUND_FILES arquivos ou ROUND_BYTES (pelo menos um). */
export function nextRound<T extends { size: number }>(
  items: T[],
  from: number,
  maxFiles = ROUND_FILES,
  maxBytes = ROUND_BYTES,
) {
  const out: T[] = [];
  let bytes = 0;
  for (let i = from; i < items.length && out.length < maxFiles; i++) {
    if (out.length && bytes + items[i].size > maxBytes) break;
    out.push(items[i]);
    bytes += items[i].size;
  }
  return out;
}

export function assetManifestV2(m: ReleaseManifest) {
  return Object.fromEntries(
    m.assets.map((f) => [f.name, { hash: f.sha256.slice(0, 32), size: f.size }]),
  );
}

/** Estáticos pedidos pela Cloudflare num lote (até MAX_UPLOAD_BATCH hashes). */
export function assetsForHashes(m: ReleaseManifest, hashes: unknown) {
  assertRelease(
    Array.isArray(hashes) &&
      hashes.length <= MAX_UPLOAD_BATCH &&
      hashes.every((h) => typeof h === "string"),
    "Lote de arquivos inválido.",
  );
  return (hashes as string[]).map((hash) => {
    const f = m.assets.find((file) => file.sha256.slice(0, 32) === hash);
    assertRelease(
      f,
      "A Cloudflare solicitou um arquivo fora da versão escolhida.",
    );
    return { hash, file: f! };
  });
}

/** Corpo do envio de estáticos (?base64=true), lendo cada arquivo só aqui. */
export async function assetUploadV2(
  items: { hash: string; file: BlobRef }[],
  read: (ref: BlobRef) => Promise<Uint8Array>,
) {
  const body = new FormData();
  for (const { hash, file } of items)
    body.set(
      hash,
      new Blob([Buffer.from(await read(file)).toString("base64")], {
        type: file.type,
      }),
      hash,
    );
  return body;
}

/** Instruções SQL de um blob de migração (JSON: lista de textos). */
export function migrationStatements(ref: BlobRef, bytes: Uint8Array) {
  let statements: unknown;
  try {
    statements = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    statements = null;
  }
  assertRelease(
    Array.isArray(statements) &&
      statements.length > 0 &&
      statements.length <= 100 &&
      statements.every((s) => typeof s === "string" && s.length < 100000),
    `Migração inválida no pacote oficial (${ref.name}).`,
  );
  return statements as string[];
}

// ---------------------------------------------------------------------------
// Cloudflare

export class CloudflareCallError extends Error {
  constructor(
    message: string,
    public ambiguous: boolean,
  ) {
    super(message);
  }
}
export async function releaseCloudflare(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  assertRelease(
    /^\/accounts\/[a-f0-9]{32}\/workers\//.test(path),
    "Destino Cloudflare inválido.",
  );
  const multipart = body instanceof FormData;
  let r: Response;
  try {
    r = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(!multipart && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : multipart
            ? (body as FormData)
            : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CloudflareCallError(
      "A Cloudflare não confirmou a operação. Confira o andamento antes de repetir.",
      method !== "GET",
    );
  }
  let data: any;
  try {
    data = await r.json();
  } catch {
    throw new CloudflareCallError(
      "Resposta inesperada da Cloudflare. Confira o andamento antes de repetir.",
      method !== "GET",
    );
  }
  if (!r.ok || data.success !== true)
    throw new CloudflareCallError(
      `Cloudflare HTTP ${r.status}. Confira a conta e a permissão Workers Scripts: Edit do token.`,
      method !== "GET" && !(r.status >= 400 && r.status < 500),
    );
  return data.result;
}
export function scriptPath(account: string, worker: string) {
  assertRelease(
    /^[a-f0-9]{32}$/.test(account) && /^[a-z][a-z0-9-]{2,45}$/.test(worker),
    "Identificação da instalação inválida.",
  );
  return `/accounts/${account}/workers/scripts/${worker}`;
}
export async function installedSettings(token: string, base: string) {
  const [settings, service] = await Promise.all([
    releaseCloudflare(token, base + "/settings"),
    releaseCloudflare(
      token,
      base.replace("/workers/scripts/", "/workers/services/"),
    ),
  ]);
  // /settings omits the migration tag. Wrangler reads it from service metadata.
  return {
    ...settings,
    migration_tag: service?.default_environment?.script?.migration_tag,
  };
}
export function validateInstalledSettings(
  settings: any,
  installationId: string,
) {
  const bindings = settings?.bindings;
  assertRelease(
    Array.isArray(bindings) &&
      installationId &&
      bindings.some(
        (b: any) =>
          b.name === "WABOTIA_INSTALLATION_ID" &&
          b.type === "plain_text" &&
          b.text === installationId,
      ),
    "O Worker indicado não corresponde a esta instalação.",
  );
  for (const [name, type] of [
    ["DB", "d1"],
    ["MEDIA", "r2_bucket"],
    ["COORDINATOR", "durable_object_namespace"],
    ["ASSETS", "assets"],
    ["MASTER_KEY", "secret_text"],
  ])
    assertRelease(
      bindings.some((b: any) => b.name === name && b.type === type),
      `A ligação ${name} não está configurada corretamente.`,
    );
  const coordinator = bindings.find((b: any) => b.name === "COORDINATOR");
  assertRelease(
    coordinator.class_name === "Coordinator" && !coordinator.script_name,
    "Durable Object externo exige atualização manual.",
  );
  assertRelease(
    settings.migration_tag === "v1",
    "A migração Durable Object exige revisão manual.",
  );
  return settings;
}

/** Corpo da publicação do Worker: módulos lidos sob demanda. */
export async function workerUploadV2(
  m: ReleaseManifest,
  settings: any,
  completionToken: string,
  read: (ref: BlobRef) => Promise<Uint8Array>,
) {
  const metadata: Record<string, unknown> = {
    main_module: m.main_module,
    compatibility_date: m.compatibility_date,
    compatibility_flags: m.compatibility_flags,
    bindings: [{ type: "assets", name: "ASSETS" }],
    keep_bindings: [
      ...new Set(
        settings.bindings
          .map((b: any) => b.type)
          .filter((t: string) => t !== "assets"),
      ),
    ],
    assets: { jwt: completionToken, config: m.assets_config },
    annotations: {
      "workers/message": `Wabotia ${m.version} · ${m.commit.slice(0, 12)}`,
    },
  };
  for (const key of [
    "observability",
    "limits",
    "logpush",
    "placement",
    "tail_consumers",
    "streaming_tail_consumers",
    "tags",
  ])
    if (settings[key] !== undefined) metadata[key] = settings[key];
  const body = new FormData();
  body.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const f of m.modules)
    body.set(
      f.name,
      new Blob([(await read(f)) as Uint8Array<ArrayBuffer>], { type: f.type }),
      f.name,
    );
  return body;
}
