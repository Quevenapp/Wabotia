import type { IdentityPort } from "./erp/engine/identity.ts";
import { erpRequirement, erpRequirementMet, readErpPartsSnapshot, type ErpModuleId, type ErpPartsSnapshot } from "./erp/parts.ts";
// Armazenamento de arquivos do ERP no R2 (o bucket MEDIA que a instalação já
// tem; nenhum recurso novo). É o `/storage/v1` do Supabase que a erp-api do
// Fagoo chama (anexos, logotipo e arquivos da empresa, CNAB, exportação e
// notas recebidas), servido pela costura local (src/erp/api/local-fetch.ts).
//
// - Chave no R2: erp-storage/<área>/<bucket>/<caminho>, o mesmo formato de
//   erpObjectKey (src/erp/engine/rpc-endpoint.ts), que o objeto erp: consulta
//   antes dos RPCs e soma no uso do armazenamento.
// - Bucket lógico do Fagoo → prefixo no MEDIA (ERP_BUCKETS), cada um com o
//   tamanho e os tipos do Fagoo e o bloco do ERP que precisa estar ligado
//   (CNAB: erp-cobranca; notas e certificado: erp-fiscal).
// - Nada é público. A leitura é pela rota do Worker (a erp-api, com o
//   envelope da pessoa) ou por URL assinada de curta duração
//   (/api/public/erp-storage/…, HMAC com a MASTER_KEY).
// - Gravação grande sem montar o arquivo na memória: createErpUpload grava em
//   partes e só dá o nome no fim, com o SHA-256 (a exportação da empresa).
import { requireModule } from "./modules/registry";
import { equal, hmac, rate, sha } from "./security";
import { ApiError, uid, type Env } from "./types";

const MiB = 1024 * 1024;
const OCTET = ["application/octet-stream"];

/** Um bucket lógico do Fagoo, que vira prefixo no MEDIA. */
export interface ErpBucket {
  /** Tamanho e tipos do storage.buckets do Fagoo (file_size_limit, allowed_mime_types). */
  maxBytes: number;
  types: readonly string[];
  /**
   * Bloco do ERP que precisa estar ligado na área (src/erp/blocks.ts). O
   * `erp` já é conferido na rota; os opcionais são conferidos de novo aqui.
   */
  module: ErpModuleId;
  /**
   * Aceita URL assinada (/api/public/erp-storage/…). Só a exportação, que o
   * Fagoo entrega por link; o resto sai só pela rota, com o envelope.
   */
  sign: boolean;
  /**
   * Nome no endereço público (/api/public/erp-storage/<área>/<apelido>/…):
   * o nome do Fagoo (brufap-…) fica só por dentro, onde os adaptadores e o
   * diferencial precisam dele.
   */
  alias: string;
}

/**
 * Todos os buckets do storage.buckets do Fagoo, por nome (as migrações e os
 * CONFIGs da erp-api). Ficam de fora origin-backups e origin-fiscal-xml, do
 * Origin, que saiu da instalação principal (bloco "externo": a erp-api nem
 * chega a chamá-los). Bucket fora da tabela dá 404.
 */
export const ERP_BUCKETS: Record<string, ErpBucket> = {
  // attachment-storage.mjs (ATTACHMENT_BUCKET_CONFIG): anexos de documento,
  // contato, produto, financeiro e funcionário; logotipo e arquivos da empresa.
  "erp-attachments": {
    alias: "anexos",
    maxBytes: 10 * MiB,
    types: [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/xml",
      "text/plain",
    ],
    module: "erp",
    sign: false,
  },
  // cnab.mjs (CNAB_BUCKET_CONFIG): remessas e retornos, com dados de cobrança
  // de clientes. Caminhos das RPCs: profiles/<perfil>/remittances/<hash>.rem e
  // profiles/<perfil>/returns/<hash>.ret.
  "brufap-cnab": {
    alias: "cobranca",
    maxBytes: 4_020_000,
    types: OCTET,
    module: "erp-cobranca",
    sign: false,
  },
  // platform.mjs (EXPORT_BUCKET, EXPORT_MAX_BYTES; 202610210331_platform_exports)
  "brufap-exports": {
    alias: "exportacoes",
    maxBytes: 50 * MiB,
    types: ["application/zip"],
    module: "erp",
    sign: true,
  },
  // dfe-distribution.mjs e 202610160045_dfe_distribution: notas recebidas.
  "brufap-received-dfe": {
    alias: "dfe",
    maxBytes: 8 * MiB,
    types: OCTET,
    module: "erp-fiscal",
    sign: false,
  },
  // 202610160051_fiscal_wsdl e seguintes: XML assinado, recibos e respostas
  // da SEFAZ.
  "brufap-fiscal-artifacts": {
    alias: "fiscal",
    maxBytes: 8 * MiB,
    types: OCTET,
    module: "erp-fiscal",
    sign: false,
  },
  // brufap-a1-vault (202610160041_a1_custody, custódia do certificado A1)
  // fica de fora de propósito: o certificado nunca fica no Wabotia. Ele mora
  // no cofre da NFapi, separado do sistema que tem bots e integrações
  // (decisão do usuário; src/erp/emissor/README.md). Código portado do Fiscal
  // que tente guardar ou ler o certificado aqui recebe 404.
};

/** Chave do objeto no R2 (formato de erpObjectKey, rpc-endpoint.ts). */
export const erpStorageKey = (profile: string, bucket: string, path: string) =>
  `erp-storage/${profile}/${bucket}/${path}`;

// Caminho dentro do bucket: segmentos de letras, números, ponto, hífen e
// sublinhado; sem "." nem ".." sozinhos, sem barra no começo, no fim ou dupla.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
export function validPath(path: string) {
  if (!path || path.length > 512) return false;
  return path.split("/").every((s) => SEGMENT.test(s) && s !== "..");
}


/** Origem física, complementada pelo registro persistido para anexos de documentos. */
export function erpFileRequirement(bucketName: string, path: string) {
  const bucket = bucketOf(bucketName); if (!bucket) return null;
  if (bucketName !== "erp-attachments") return erpRequirement(bucket.module);
  const owner: Record<string, ErpModuleId> = { products: "erp-produtos", finance: "erp-financeiro", contacts: "erp", employees: "erp", company: "erp", documents: "erp" };
  const module = owner[path.split("/")[0]];
  return module ? erpRequirement(module) : null;
}

/** Resposta de erro no formato do Storage do Supabase. */
const storageError = (status: number, error: string, message: string) =>
  Response.json({ statusCode: String(status), error, message }, { status });
const notFound = () => storageError(404, "not_found", "Object not found");

function bucketOf(name: string) {
  return Object.prototype.hasOwnProperty.call(ERP_BUCKETS, name)
    ? ERP_BUCKETS[name]
    : null;
}
const baseType = (value: string | null) =>
  (value || "").split(";")[0].trim().toLowerCase();

/**
 * Um pedido da erp-api ao `/storage/v1` (a URL local da costura), respondido
 * do R2. Rotas do Storage do Supabase que o Fagoo usa:
 * - POST   /object/<bucket>/<caminho>                (enviar; x-upsert)
 * - PUT    /object/<bucket>/<caminho>                (substituir)
 * - GET    /object/authenticated/<bucket>/<caminho>  (baixar; HEAD também)
 * - DELETE /object/<bucket>/<caminho>
 * - POST   /object/sign/<bucket>/<caminho>           ({expiresIn} → signedURL)
 */
export interface ErpStorageAuthorization {
  snapshot: ErpPartsSnapshot;
  /** Somente o executor administrativo: leitura histórica para backup/exportação. */
  administrativeExport?: boolean;
}
export async function erpStorage(
  env: Env,
  profile: string,
  request: Request,
  identity?: IdentityPort | ErpStorageAuthorization,
  authorizedKeys?: ReadonlySet<string>,
): Promise<Response> {
  const url = new URL(request.url);
  const route =
    /^\/storage\/v1\/object\/(?:(authenticated|sign)\/)?([a-z0-9-]+)\/(.+)$/.exec(
      url.pathname,
    );
  if (!route) return storageError(404, "not_found", "Route not found");
  const [, kind, bucketName, path] = route;
  const bucket = bucketOf(bucketName);
  if (!bucket) return storageError(404, "not_found", "Bucket not found");
  if (!validPath(path))
    return storageError(400, "invalid_key", "Invalid object key");
  const administrativeExport = identity && "snapshot" in identity && identity.administrativeExport === true;
  const input = identity && "snapshot" in identity ? identity.snapshot : identity ? { ...identity.partsControl, parts: identity.parts } : null;
  const snapshot = readErpPartsSnapshot(input, profile);
  if (!snapshot) return storageError(503, "erp_parts_unavailable", "Estado das partes indisponível.");
  const requirement = administrativeExport ? erpRequirement("erp") : erpFileRequirement(bucketName, path);
  if (!requirement) return notFound();
  if (!erpRequirementMet(snapshot.parts, requirement)) return storageError(409, "module_disabled", "Esta rotina depende de uma parte desligada.");
  // Anexos só são acessíveis após o RPC original autorizar este objeto exato.
  // O caminho de documentos contém ID, não tipo; o RPC resolve o dono salvo.
  if (bucketName === "erp-attachments" && !(administrativeExport && ["GET", "HEAD"].includes(request.method)) && !authorizedKeys?.has(`${bucketName}/${path}`))
    return storageError(403, "access_denied", "Arquivo fora do acesso autorizado.");
  const key = erpStorageKey(profile, bucketName, path);
  const method = request.method.toUpperCase();

  if (kind === "authenticated") {
    if (method !== "GET" && method !== "HEAD")
      return storageError(405, "method_not_allowed", "Method not allowed");
    const object =
      method === "HEAD" ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
    if (!object) return notFound();
    const headers = new Headers({
      "Content-Type":
        object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      ETag: object.httpEtag,
    });
    return new Response(
      method === "HEAD" ? null : (object as R2ObjectBody).body,
      { headers },
    );
  }

  if (kind === "sign") {
    if (method !== "POST")
      return storageError(405, "method_not_allowed", "Method not allowed");
    if (!bucket.sign)
      return storageError(403, "not_signable", "Bucket has no signed URLs");
    const body = await request
      .json<{ expiresIn?: unknown }>()
      .catch(() => ({}));
    const seconds = Number((body as { expiresIn?: unknown }).expiresIn);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
      return storageError(400, "invalid_expires", "Invalid expiresIn");
    if (!(await env.MEDIA.head(key))) return notFound();
    const token = await signToken(
      env,
      profile,
      bucketName,
      path,
      Math.floor(Date.now() / 1000) + seconds,
    );
    return Response.json({
      signedURL: `/object/sign/${bucketName}/${path}?token=${token}`,
    });
  }

  if (method === "DELETE") {
    if (!(await env.MEDIA.head(key))) return notFound();
    await env.MEDIA.delete(key);
    return Response.json({ message: "Successfully deleted" });
  }

  if (method === "POST" || method === "PUT") {
    const type = baseType(request.headers.get("Content-Type"));
    if (!bucket.types.includes(type))
      return storageError(
        415,
        "invalid_mime_type",
        `mime type ${type || "(none)"} is not supported`,
      );
    const declared = Number(request.headers.get("Content-Length"));
    if (declared > bucket.maxBytes) return tooLarge();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return storageError(400, "invalid_body", "Empty object");
    if (bytes.length > bucket.maxBytes) return tooLarge();
    // POST cria (x-upsert: true substitui); PUT substitui o que existe.
    const exists = !!(await env.MEDIA.head(key));
    const upsert = request.headers.get("x-upsert") === "true";
    if (method === "POST" && exists && !upsert)
      return storageError(409, "Duplicate", "The resource already exists");
    if (method === "PUT" && !exists) return notFound();
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
    return Response.json({ Key: `${bucketName}/${path}`, Id: uid() });
  }

  return storageError(405, "method_not_allowed", "Method not allowed");
}
const tooLarge = () =>
  storageError(
    413,
    "Payload too large",
    "The object exceeded the maximum allowed size",
  );

// ---------------------------------------------------------------------------
// URL assinada: /api/public/erp-storage/<área>/<apelido>/<caminho>?token=…
// O token é <expira em segundos>.<HMAC-SHA256> de área, bucket (o nome do
// Fagoo), caminho e expiração. Vale só até expirar e só para aquele objeto
// daquela área. A chave do HMAC não é a MASTER_KEY: é derivada dela com um
// rótulo próprio (linkKey), para o link nunca usar a chave que cifra os
// segredos.

const LINK_KEY_LABEL = "erp-storage-link/v1";
async function linkKey(env: Env) {
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32)
    throw new ApiError(
      503,
      "setup_required",
      "Configure MASTER_KEY nos secrets do Worker.",
    );
  return hmac(env.MASTER_KEY, LINK_KEY_LABEL);
}
/** Bucket do Fagoo pelo apelido do endereço público. */
function bucketByAlias(alias: string) {
  return Object.entries(ERP_BUCKETS).find(([, b]) => b.alias === alias) ?? null;
}
const signedPayload = (
  profile: string,
  bucket: string,
  path: string,
  expires: number,
) => `erp-storage-sign:v1\n${profile}\n${bucket}\n${path}\n${expires}`;

async function signToken(
  env: Env,
  profile: string,
  bucket: string,
  path: string,
  expires: number,
) {
  const mac = await hmac(
    await linkKey(env),
    signedPayload(profile, bucket, path, expires),
  );
  return `${expires}.${mac}`;
}

/** Caminho público das URLs assinadas (a costura reescreve o do Supabase). */
export const SIGNED_PATH = "/api/public/erp-storage/";

/**
 * A URL que a erp-api monta com o endereço local da costura
 * (`<local>/storage/v1/object/sign/<bucket>/…`) vira a rota pública do
 * Worker, na mesma origem em que a pessoa chamou o ERP, com o apelido do
 * bucket no lugar do nome do Fagoo.
 */
export function publicSignedUrls(
  text: string,
  local: string,
  origin: string,
  profile: string,
) {
  const from = `${local}/storage/v1/object/sign/`;
  if (!text.includes(from)) return text;
  const to = `${origin}${SIGNED_PATH}${encodeURIComponent(profile)}/`;
  let out = text;
  for (const [name, bucket] of Object.entries(ERP_BUCKETS))
    if (bucket.sign)
      out = out.split(`${from}${name}/`).join(`${to}${bucket.alias}/`);
  return out;
}

/** GET /api/public/erp-storage/<área>/<bucket>/<caminho>?token=…&download=… */
export async function erpSignedDownload(env: Env, request: Request) {
  await rate(
    env,
    "erp-storage-sign:" +
      (await sha(request.headers.get("CF-Connecting-IP") || "")),
    120,
  );
  const url = new URL(request.url);
  const match =
    /^\/api\/public\/erp-storage\/([^/]+)\/([a-z0-9-]+)\/(.+)$/.exec(
      url.pathname,
    );
  const denied = () =>
    new ApiError(403, "invalid_signature", "Link inválido ou vencido.");
  if (!match) throw denied();
  const profile = decodeURIComponent(match[1]);
  const [, , alias, path] = match;
  const found = bucketByAlias(alias);
  // Só bucket que aceita link (a exportação): CNAB, fiscal e anexos nunca.
  if (!found || !found[1].sign || !validPath(path)) throw denied();
  const [bucketName, bucket] = found;
  const [expiresText, mac] = (url.searchParams.get("token") || "").split(".");
  const expires = Number(expiresText);
  if (
    !/^\d{1,12}$/.test(expiresText || "") ||
    !mac ||
    expires < Math.floor(Date.now() / 1000)
  )
    throw denied();
  const expected = await hmac(
    await linkKey(env),
    signedPayload(profile, bucketName, path, expires),
  );
  if (!equal(mac, expected)) throw denied();
  // Com o ERP (ou o bloco do bucket) desligado na área, os links param de valer.
  await requireModule(env, profile, "erp");
  if (bucket.module !== "erp") await requireModule(env, profile, bucket.module);
  const object = await env.MEDIA.get(erpStorageKey(profile, bucketName, path));
  if (!object) throw new ApiError(404, "not_found", "Arquivo não encontrado.");
  const name = (url.searchParams.get("download") || path.split("/").pop() || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
  return new Response(object.body, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${name || "arquivo"}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ---------------------------------------------------------------------------
// Gravação em partes, com o nome dado no fim (exportação da empresa)
//
// O pacote da exportação tem até 50 MiB e o nome leva o SHA-256 do arquivo
// inteiro (exports/<id>/<sha>.zip), que só se sabe no fim. O R2 não renomeia,
// e o envio em partes (multipart) precisa do nome no começo. Então:
// 1. os bytes chegam aos poucos (write) e são guardados em partes de 5 MiB,
//    objetos temporários em <bucket>/.upload/<id>/<n>, com o SHA-256 somado
//    no caminho (DigestStream);
// 2. no fim (finish), com o SHA-256 em mãos, o envio em partes do R2 cria o
//    objeto final, lendo uma parte temporária por vez;
// 3. as temporárias são apagadas.
// A memória fica em uma parte (5 MiB), não no arquivo. Até 5 MiB vai direto,
// sem temporárias. Temporárias de um envio interrompido são apagadas pelo
// próximo envio do mesmo bucket depois de um dia (sweepStaleUploads).

/** Tamanho das partes (o R2 exige partes iguais, de 5 MiB ou mais, salvo a última). */
export const UPLOAD_PART_BYTES = 5 * MiB;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface ErpUpload {
  /** Bytes já escritos. */
  readonly size: number;
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Fecha o envio: `name` dá o caminho final a partir do SHA-256 (hex). Se o
   * objeto já existir (resposta perdida de uma tentativa anterior: a chave
   * tem o SHA-256, os bytes são os mesmos), não grava de novo.
   */
  finish(
    name: (sha256: string) => string,
  ): Promise<{ path: string; size: number; sha256: string }>;
  /** Desiste: apaga as partes temporárias. */
  abort(): Promise<void>;
}

export async function createErpUpload(
  env: Env,
  profile: string,
  bucketName: string,
  contentType: string,
): Promise<ErpUpload> {
  const bucket = bucketOf(bucketName);
  if (!bucket || !bucket.types.includes(contentType))
    throw new ApiError(400, "erp_storage_invalid", "Bucket ou tipo inválido.");
  await sweepStaleUploads(env, profile, bucketName);
  const id = uid();
  const tempKey = (n: number) =>
    erpStorageKey(profile, bucketName, `.upload/${id}/${n}`);
  // crypto.DigestStream do Workers (o tipo Crypto do DOM não o tem).
  const { DigestStream: Digest } = crypto as unknown as {
    DigestStream: typeof DigestStream;
  };
  const digest = new Digest("SHA-256");
  // Desistir (abort) rejeita o resumo; ninguém mais espera por ele.
  digest.digest.catch(() => {});
  const hashing = digest.getWriter();
  let buffer = new Uint8Array(UPLOAD_PART_BYTES);
  let filled = 0;
  let parts = 0;
  let size = 0;
  let closed = false;

  const flush = async () => {
    await env.MEDIA.put(tempKey(parts), buffer.slice(0, filled), {
      customMetadata: { erp_upload: id, created: String(Date.now()) },
    });
    parts++;
    filled = 0;
  };
  const removeTemps = async () => {
    for (let n = 0; n < parts; n += 1000)
      await env.MEDIA.delete(
        Array.from({ length: Math.min(1000, parts - n) }, (_, i) =>
          tempKey(n + i),
        ),
      );
  };

  return {
    get size() {
      return size;
    },
    async write(bytes) {
      if (closed) throw new Error("erp_upload_closed");
      if (size + bytes.length > bucket.maxBytes)
        throw new ApiError(
          413,
          "erp_storage_too_large",
          "Arquivo grande demais.",
        );
      size += bytes.length;
      await hashing.write(bytes);
      let at = 0;
      while (at < bytes.length) {
        const take = Math.min(UPLOAD_PART_BYTES - filled, bytes.length - at);
        buffer.set(bytes.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === UPLOAD_PART_BYTES) await flush();
      }
    },
    async finish(name) {
      if (closed) throw new Error("erp_upload_closed");
      closed = true;
      await hashing.close();
      const sha256 = [...new Uint8Array(await digest.digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const path = name(sha256);
      if (!validPath(path)) {
        await removeTemps();
        throw new ApiError(400, "erp_storage_invalid", "Caminho inválido.");
      }
      const key = erpStorageKey(profile, bucketName, path);
      const options = { httpMetadata: { contentType } };
      try {
        if (await env.MEDIA.head(key)) return { path, size, sha256 };
        if (!parts) {
          // Coube numa parte: vai direto.
          await env.MEDIA.put(key, buffer.slice(0, filled), options);
          return { path, size, sha256 };
        }
        if (filled) await flush();
        const upload = await env.MEDIA.createMultipartUpload(key, options);
        try {
          const done: R2UploadedPart[] = [];
          for (let n = 0; n < parts; n++) {
            const part = await env.MEDIA.get(tempKey(n));
            if (!part) throw new Error("erp_upload_part_missing");
            done.push(await upload.uploadPart(n + 1, await part.arrayBuffer()));
          }
          await upload.complete(done);
        } catch (error) {
          await upload.abort().catch(() => {});
          throw error;
        }
        return { path, size, sha256 };
      } finally {
        buffer = new Uint8Array(0);
        await removeTemps();
      }
    },
    async abort() {
      closed = true;
      await hashing.abort().catch(() => {});
      buffer = new Uint8Array(0);
      await removeTemps();
    },
  };
}

/** Apaga partes temporárias de envios interrompidos há mais de um dia. */
export async function sweepStaleUploads(
  env: Env,
  profile: string,
  bucketName: string,
  at = Date.now(),
) {
  const prefix = erpStorageKey(profile, bucketName, ".upload/");
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects)
      if (at - o.uploaded.getTime() > STALE_UPLOAD_MS) stale.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && stale.length < 1000);
  if (stale.length) await env.MEDIA.delete(stale.slice(0, 1000));
  return stale.length;
}
