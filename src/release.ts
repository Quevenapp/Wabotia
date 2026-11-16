// Shared by the Worker updater and the standalone installer. No customer credentials
// are sent to the release origin; only Cloudflare receives the API token.
import { Buffer } from "node:buffer";

export const RELEASE_ORIGIN = "https://wabotia.queven.app";
// Abaixo dos 25 MiB por arquivo estático da Cloudflare, que serve o pacote, e
// com folga para a memória de 128 MB do Worker que o lê e decodifica.
// Instalações até a 0.17.0 aceitam no máximo 20 MB: um pacote maior só pode
// sair depois que elas tiverem atualizado para uma versão com este limite
// (scripts/release.mjs confere).
export const MAX_PACKAGE = 24 * 1024 * 1024;
export interface ReleaseIndex {
  format: 1;
  version: string;
  commit: string;
  package_sha256: string;
  package_size: number;
}
export interface ReleaseFile {
  name: string;
  type: string;
  data: string;
  sha256: string;
}
export interface ReleasePackage {
  format: 1;
  version: string;
  commit: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets_config: Record<string, unknown>;
  durable_migrations: { tag: string; new_sqlite_classes?: string[] }[];
  modules: ReleaseFile[];
  assets: ReleaseFile[];
  migrations: { name: string; statements: string[] }[];
}
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
export function validateIndex(value: any): ReleaseIndex {
  assertRelease(
    value?.format === 1 &&
      /^\d+\.\d+\.\d+$/.test(value.version) &&
      /^[a-f0-9]{40}$/.test(value.commit) &&
      /^[a-f0-9]{64}$/.test(value.package_sha256) &&
      Number.isSafeInteger(value.package_size) &&
      value.package_size > 0 &&
      value.package_size <= MAX_PACKAGE,
    "A versão oficial não contém um pacote de publicação válido.",
  );
  return {
    format: 1,
    version: value.version,
    commit: value.commit,
    package_sha256: value.package_sha256,
    package_size: value.package_size,
  };
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
export async function latestRelease(): Promise<ReleaseIndex> {
  const r = await fetch(`${RELEASE_ORIGIN}/releases/latest.json`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  return validateIndex(
    JSON.parse((await limitedBody(r, 8192)).toString("utf8")),
  );
}
export async function fetchPackage(index: ReleaseIndex) {
  validateIndex(index);
  const r = await fetch(
    `${RELEASE_ORIGIN}/releases/${index.version}/package.json`,
    { redirect: "manual", signal: AbortSignal.timeout(20000) },
  );
  const bytes = await limitedBody(r, MAX_PACKAGE);
  const pkg = await parsePackage(index, bytes);
  return { pkg, bytes };
}
export async function parsePackage(
  index: ReleaseIndex,
  bytes: Uint8Array,
): Promise<ReleasePackage> {
  assertRelease(
    bytes.length === index.package_size &&
      (await digest(bytes)) === index.package_sha256,
    "A integridade do pacote oficial não confere. Nenhuma publicação foi feita.",
  );
  const p = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assertRelease(
    p.format === 1 && p.version === index.version && p.commit === index.commit,
    "O pacote não corresponde à versão escolhida.",
  );
  assertRelease(
    /^\d{4}-\d{2}-\d{2}$/.test(p.compatibility_date) &&
      Array.isArray(p.compatibility_flags) &&
      p.compatibility_flags.every((v: unknown) => typeof v === "string") &&
      Array.isArray(p.modules) &&
      p.modules.length > 0 &&
      p.modules.length < 64 &&
      Array.isArray(p.assets) &&
      p.assets.length > 0 &&
      p.assets.length <= 100 &&
      Array.isArray(p.migrations) &&
      p.migrations.length <= 100,
    "Estrutura do pacote oficial inválida.",
  );
  const seen = new Set<string>();
  for (const [group, files] of [
    ["module", p.modules],
    ["asset", p.assets],
  ] as const) {
    for (const f of files) {
      assertRelease(
        typeof f.name === "string" &&
          (group === "asset"
            ? /^\/[a-zA-Z0-9_./-]+$/
            : /^[a-zA-Z0-9_./-]+$/
          ).test(f.name) &&
          !f.name.split("/").includes("..") &&
          !seen.has(group + f.name) &&
          typeof f.data === "string" &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(f.data) &&
          typeof f.type === "string" &&
          f.type.length < 120,
        "Arquivo inválido no pacote oficial.",
      );
      seen.add(group + f.name);
      const raw = Buffer.from(f.data, "base64");
      assertRelease(
        raw.toString("base64") === f.data && (await digest(raw)) === f.sha256,
        "Arquivo corrompido no pacote oficial.",
      );
    }
  }
  assertRelease(
    p.modules.some(
      (f: ReleaseFile) =>
        f.name === p.main_module && f.type === "application/javascript+module",
    ),
    "Módulo principal inválido.",
  );
  assertRelease(
    JSON.stringify(p.durable_migrations) ===
      JSON.stringify([{ tag: "v1", new_sqlite_classes: ["Coordinator"] }]),
    "Esta versão altera Durable Objects e exige atualização manual.",
  );
  for (const m of p.migrations) {
    assertRelease(
      /^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) &&
        !seen.has(m.name) &&
        Array.isArray(m.statements) &&
        m.statements.length > 0 &&
        m.statements.length <= 100 &&
        m.statements.every(
          (s: unknown) => typeof s === "string" && s.length < 100000,
        ),
      "Migração inválida no pacote oficial.",
    );
    seen.add(m.name);
  }
  assertRelease(
    p.assets_config?.not_found_handling === "single-page-application" &&
      JSON.stringify(p.assets_config?.run_worker_first) ===
        JSON.stringify(["/api/*", "/webhooks/*", "/internal/*"]),
    "Configuração de arquivos incompatível.",
  );
  return p;
}

// ---------------------------------------------------------------------------
// Formato 2 (versão ponte em diante; docs/ATUALIZACOES-FORMATO.md)
//
//   /releases/v2/latest.json            índice: {format:2, version, commit,
//                                       manifest_sha256, manifest_size,
//                                       total_size, requires}
//   /releases/<versão>/manifest.json    metadados; modules/assets/migrations
//                                       como {name, type, size, sha256}
//   /releases/blobs/<sha256>            bytes crus, endereçados por conteúdo
//
// Sem base64 e sem um JSON único: o atualizador baixa o manifesto (até
// 2 MiB) e depois só os arquivos de que precisa, conferindo o SHA-256 de cada
// um. O releases/latest.json antigo (formato 1) fica congelado na ponte: uma
// instalação antiga só enxerga a ponte e, depois dela, o índice v2.

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

export interface ReleaseIndexV2 {
  format: 2;
  version: string;
  commit: string;
  manifest_sha256: string;
  manifest_size: number;
  total_size: number;
  requires: { min_version: string; workers_paid: boolean };
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

export function validateIndexV2(value: any): ReleaseIndexV2 {
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
      typeof value.requires?.workers_paid === "boolean",
    "A versão oficial não contém um índice de publicação válido.",
  );
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
  };
}

export const indexV2Url = () => `${RELEASE_ORIGIN}/releases/v2/latest.json`;
export const manifestPath = (version: string) =>
  `/releases/${version}/manifest.json`;
export const blobPath = (sha256: string) => `/releases/blobs/${sha256}`;

export async function latestReleaseV2(): Promise<ReleaseIndexV2> {
  const r = await fetch(indexV2Url(), {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  return validateIndexV2(
    JSON.parse((await limitedBody(r, 8192)).toString("utf8")),
  );
}

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

/** Confere o manifesto contra o índice; as regras de estrutura do formato 1 valem. */
export async function parseManifest(
  index: ReleaseIndexV2,
  bytes: Uint8Array,
): Promise<ReleaseManifest> {
  assertRelease(
    bytes.length === index.manifest_size &&
      (await digest(bytes)) === index.manifest_sha256,
    "A integridade do manifesto oficial não confere. Nenhuma publicação foi feita.",
  );
  const p = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assertRelease(
    p.format === 2 && p.version === index.version && p.commit === index.commit,
    "O manifesto não corresponde à versão escolhida.",
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
  // Inalterado em relação ao formato 1: Durable Objects e rotas do Worker.
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
  const r = await fetch(RELEASE_ORIGIN + manifestPath(index.version), {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const bytes = await limitedBody(r, MAX_MANIFEST);
  return { manifest: await parseManifest(index, bytes), bytes };
}

/** Confere tamanho e SHA-256 de um arquivo baixado. */
export async function checkBlob(ref: BlobRef, bytes: Uint8Array) {
  assertRelease(
    bytes.length === ref.size && (await digest(bytes)) === ref.sha256,
    `Arquivo corrompido no pacote oficial (${ref.name}). Nenhuma publicação foi feita.`,
  );
  return bytes;
}

export async function fetchBlob(ref: BlobRef) {
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

/** Corpo da publicação do Worker no formato 2: módulos lidos sob demanda. */
export async function workerUploadV2(
  m: ReleaseManifest,
  settings: any,
  completionToken: string,
  read: (ref: BlobRef) => Promise<Uint8Array>,
) {
  const body = workerUpload(
    { ...(m as any), modules: [] } as ReleasePackage,
    settings,
    completionToken,
  );
  for (const f of m.modules)
    body.set(
      f.name,
      new Blob([(await read(f)) as Uint8Array<ArrayBuffer>], { type: f.type }),
      f.name,
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
export function assetManifest(pkg: ReleasePackage) {
  return Object.fromEntries(
    pkg.assets.map((f) => [
      f.name,
      {
        hash: f.sha256.slice(0, 32),
        size: Buffer.from(f.data, "base64").length,
      },
    ]),
  );
}
export function assetUpload(pkg: ReleasePackage, hashes: string[]) {
  const body = new FormData();
  assertRelease(
    Array.isArray(hashes) && hashes.length <= MAX_UPLOAD_BATCH,
    "Lote de arquivos inválido.",
  );
  for (const hash of hashes) {
    const f = pkg.assets.find((file) => file.sha256.slice(0, 32) === hash);
    assertRelease(
      f,
      "A Cloudflare solicitou um arquivo fora da versão escolhida.",
    );
    body.set(hash, new Blob([f.data], { type: f.type }), hash);
  }
  return body;
}
export function workerUpload(
  pkg: ReleasePackage,
  settings: any,
  completionToken: string,
) {
  const metadata: Record<string, unknown> = {
    main_module: pkg.main_module,
    compatibility_date: pkg.compatibility_date,
    compatibility_flags: pkg.compatibility_flags,
    bindings: [{ type: "assets", name: "ASSETS" }],
    keep_bindings: [
      ...new Set(
        settings.bindings
          .map((b: any) => b.type)
          .filter((t: string) => t !== "assets"),
      ),
    ],
    assets: { jwt: completionToken, config: pkg.assets_config },
    annotations: {
      "workers/message": `Wabotia ${pkg.version} · ${pkg.commit.slice(0, 12)}`,
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
  for (const f of pkg.modules)
    body.set(
      f.name,
      new Blob([Buffer.from(f.data, "base64")], { type: f.type }),
      f.name,
    );
  return body;
}
