// Instalador pelo navegador: a página /instalar conduz a instalação passo a
// passo e este módulo executa cada passo na API da Cloudflare.
//
// O token da pessoa passa por aqui a cada passo e segue direto para a
// Cloudflare. Ele não é gravado em banco, arquivo ou log, e nada fica guardado
// entre um passo e outro: o andamento (cursor) volta para o navegador. Por
// isso o recurso só existe onde WABOTIA_WEB_INSTALLER=1, que é o site oficial.
import { Buffer } from "node:buffer";
import { ApiError, type Env } from "./types";
import {
  assetManifestV2,
  assetsForHashes,
  assetUploadV2,
  blobPath,
  checkBlob,
  limitedBody,
  INDEX_PATH,
  INDEX_SIGNATURE_PATH,
  manifestPath,
  manifestSignaturePath,
  migrationStatements,
  parseIndex,
  parseManifest,
  validateIndexV2,
  MAX_BLOB,
  MAX_MANIFEST,
  RELEASE_ORIGIN,
  type BlobRef,
  type ReleaseIndexV2,
  type ReleaseManifest,
} from "./release";

export const webInstallerEnabled = (env: Env) =>
  env.WABOTIA_WEB_INSTALLER === "1";

export const installSteps = [
  "check",
  "database",
  "bucket",
  "migrate",
  "assets",
  "publish",
  "finish",
  "verify",
] as const;
type Step = (typeof installSteps)[number];

const shapes = {
  account: /^[a-f0-9]{32}$/,
  name: /^[a-z][a-z0-9-]{2,45}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  key: /^[a-f0-9]{64}$/,
};
const invalid = (message: string) =>
  new ApiError(400, "invalid_request", message);

/** One call to the Cloudflare API, limited to this account's Workers, D1 and R2. */
async function cloudflare(
  token: string,
  account: string,
  path: string,
  method = "GET",
  body?: unknown,
  absent = false,
) {
  if (!/^\/(workers|d1|r2)\//.test(path))
    throw new ApiError(500, "internal_error", "Destino Cloudflare inválido.");
  const multipart = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
      {
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
        signal: AbortSignal.timeout(25000),
      },
    );
  } catch {
    throw new ApiError(
      502,
      "cloudflare_unreachable",
      "A Cloudflare não respondeu. Tente este passo de novo.",
    );
  }
  if (absent && response.status === 404) return null;
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // tratado abaixo como resposta inesperada
  }
  if (!response.ok || data?.success !== true) {
    const detail =
      typeof data?.errors?.[0]?.message === "string"
        ? " " + data.errors[0].message.slice(0, 200)
        : "";
    const hint =
      [400, 401, 403].includes(response.status) &&
      (response.status !== 400 || /authenticat/i.test(detail))
        ? " Confira o Account ID, a validade e as permissões do token."
        : "";
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? 400 : 502,
      "cloudflare_error",
      `A Cloudflare recusou este passo (HTTP ${response.status}).${detail}${hint}`,
    );
  }
  return data.result;
}

// The official site serves its own catalogue as static files; any other host
// reads it from the official origin.
async function releaseFile(env: Env, path: string, limit: number) {
  let response: Response | null = null;
  try {
    const local = await env.ASSETS.fetch(new Request("https://assets" + path));
    // JSON do catálogo, assinatura (.sig) ou arquivo do formato 2 (bytes
    // crus, sem extensão). Um caminho ausente volta como a página do painel
    // (text/html), que nunca vale como arquivo do catálogo.
    const type = local.headers.get("Content-Type") || "";
    if (
      local.ok &&
      (type.includes("application/json") ||
        (path.endsWith(".sig") && !type.includes("text/html")) ||
        (path.startsWith("/releases/blobs/") &&
          type.includes("application/octet-stream")))
    )
      response = local;
  } catch {
    // sem catálogo local
  }
  response ||= await fetch(RELEASE_ORIGIN + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  return limitedBody(response, limit);
}
const unavailable = (error: unknown) =>
  new ApiError(
    502,
    "release_unavailable",
    error instanceof Error
      ? error.message
      : "Não foi possível obter a versão oficial.",
  );
/** Manifesto da versão (formato 2): até 2 MiB, assinado e conferido contra o índice. */
async function releaseManifest(env: Env, index: ReleaseIndexV2) {
  try {
    return await parseManifest(
      index,
      await releaseFile(env, manifestPath(index.version), MAX_MANIFEST),
      await releaseFile(env, manifestSignaturePath(index.version), 4096).catch(
        () => null,
      ),
    );
  } catch (error) {
    throw unavailable(error);
  }
}
/** Um arquivo da versão, lido só quando o passo precisa, SHA conferido. */
function blobReader(env: Env) {
  return async (ref: BlobRef) => {
    try {
      return await checkBlob(
        ref,
        await releaseFile(env, blobPath(ref.sha256), MAX_BLOB),
      );
    } catch (error) {
      throw unavailable(error);
    }
  };
}

async function publishBody(
  pkg: ReleaseManifest,
  read: (ref: BlobRef) => Promise<Uint8Array>,
  input: {
    account: string;
    name: string;
    token: string;
    installationId: string;
    databaseId: string;
    masterKey: string;
    setupToken: string;
    assetsToken: string;
  },
) {
  const text = (name: string, value: string) => ({
    type: "plain_text",
    name,
    text: value,
  });
  const secret = (name: string, value: string) => ({
    type: "secret_text",
    name,
    text: value,
  });
  const [migration] = pkg.durable_migrations;
  const metadata = {
    main_module: pkg.main_module,
    compatibility_date: pkg.compatibility_date,
    compatibility_flags: pkg.compatibility_flags,
    bindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", id: input.databaseId },
      { type: "r2_bucket", name: "MEDIA", bucket_name: input.name + "-media" },
      {
        type: "durable_object_namespace",
        name: "COORDINATOR",
        class_name: "Coordinator",
      },
      text("APP_NAME", "Vinki"),
      text("WABOTIA_ACCOUNT_ID", input.account),
      text("WABOTIA_WORKER_NAME", input.name),
      text("WABOTIA_INSTALLATION_ID", input.installationId),
      secret("MASTER_KEY", input.masterKey),
      secret("SETUP_TOKEN", input.setupToken),
      // Same as the terminal installer: lets the panel install new versions.
      secret("WABOTIA_UPDATE_TOKEN", input.token),
    ],
    migrations: {
      new_tag: migration.tag,
      new_sqlite_classes: migration.new_sqlite_classes,
    },
    assets: { jwt: input.assetsToken, config: pkg.assets_config },
    observability: { enabled: true },
    annotations: {
      "workers/message": `Vinki ${pkg.version} · ${pkg.commit.slice(0, 12)}`,
    },
  };
  const body = new FormData();
  body.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const file of pkg.modules)
    body.set(
      file.name,
      new Blob([Buffer.from(await read(file))], { type: file.type }),
      file.name,
    );
  return body;
}

export interface InstallResult {
  /** Next step to request, or "done". */
  next: Step | "done";
  /** Progress the browser sends back with the next step. Holds no secret. */
  cursor: Record<string, any>;
  message: string;
  /** True when the same step should simply be asked again in a few seconds. */
  wait?: boolean;
}

export async function installStep(env: Env, body: any): Promise<InstallResult> {
  const account = String(body?.account || "")
      .trim()
      .toLowerCase(),
    name = String(body?.name || "").trim(),
    token = String(body?.token || "").trim(),
    step = body?.step as Step;
  if (!shapes.account.test(account))
    throw invalid("Account ID inválido: são 32 letras e números.");
  if (!shapes.name.test(name))
    throw invalid(
      "Nome inválido: use de 3 a 46 letras minúsculas, números e hífen, começando por letra.",
    );
  if (token.length < 20 || token.length > 400 || /\s/.test(token))
    throw invalid("Token inválido.");
  if (!installSteps.includes(step)) throw invalid("Passo desconhecido.");
  const cursor: Record<string, any> =
    body.cursor && typeof body.cursor === "object" ? { ...body.cursor } : {};
  const call = (path: string, method = "GET", data?: unknown, absent = false) =>
    cloudflare(token, account, path, method, data, absent);

  if (step === "check") {
    // O plano não é conferido pela API: exigiria permissão de cobrança no
    // token. O administrador confirma que a conta tem o Workers Paid.
    if (body?.paid_plan !== true)
      throw invalid(
        "O Vinki exige o plano pago Workers Paid na conta. Assine na página de planos do Workers da Cloudflare e confirme na página antes de instalar.",
      );
    if (await call(`/workers/scripts/${name}/settings`, "GET", undefined, true))
      throw invalid(
        "Já existe um Worker com esse nome. Escolha um nome novo; o instalador não substitui outra instalação.",
      );
    const buckets = await call("/r2/buckets");
    if (!Array.isArray(buckets?.buckets))
      throw invalid(
        "Não foi possível conferir o R2. Ative a assinatura R2 na conta.",
      );
    if (buckets.buckets.some((b: any) => b.name === name + "-media"))
      throw invalid(
        "Já existe um bucket R2 com esse nome. Escolha outro nome para preservar os arquivos existentes.",
      );
    for (let page = 1; page <= 20; page++) {
      const databases = await call(`/d1/database?per_page=100&page=${page}`);
      if (!Array.isArray(databases))
        throw invalid("Não foi possível conferir os bancos D1.");
      if (databases.some((db: any) => db.name === name))
        throw invalid(
          "Já existe um banco D1 com esse nome. Escolha outro nome; uma instalação nova precisa de banco vazio.",
        );
      if (databases.length < 100) break;
    }
    let index: ReleaseIndexV2;
    let bytes: Uint8Array;
    let signature: Uint8Array | null;
    try {
      bytes = await releaseFile(env, INDEX_PATH, 8192);
    } catch {
      throw new ApiError(
        502,
        "release_unavailable",
        "Não foi possível consultar a versão oficial. Tente de novo em instantes.",
      );
    }
    // Assinatura e validade conferidas antes de criar qualquer recurso. Sem
    // assinatura válida a instalação não começa.
    try {
      signature = await releaseFile(env, INDEX_SIGNATURE_PATH, 4096).catch(
        () => null,
      );
      index = await parseIndex(bytes, signature);
    } catch (error) {
      throw unavailable(error);
    }
    return {
      next: "database",
      cursor: {
        index,
        // Os bytes exatos e a assinatura vão no andamento: cada passo
        // seguinte confere de novo e usa só o que foi assinado.
        signed_index: {
          data: Buffer.from(bytes).toString("base64"),
          signature: Buffer.from(signature!).toString("base64"),
        },
        installation_id: crypto.randomUUID(),
      },
      message: `Conta e nomes conferidos. Versão oficial ${index.version}.`,
    };
  }

  // O andamento volta do navegador: o índice nunca é aceito como veio. Vale
  // só o que a assinatura confere de novo aqui, a cada passo.
  const signed = cursor.signed_index;
  if (
    typeof signed?.data !== "string" ||
    typeof signed?.signature !== "string" ||
    signed.data.length > 12000 ||
    signed.signature.length > 6000
  )
    throw invalid("Andamento inválido. Recomece a instalação.");
  let index: ReleaseIndexV2;
  try {
    index = await parseIndex(
      Buffer.from(signed.data, "base64"),
      Buffer.from(signed.signature, "base64"),
    );
  } catch (error) {
    throw invalid(
      (error instanceof Error ? error.message : "Andamento inválido.") +
        " Recomece a instalação.",
    );
  }
  if (!shapes.uuid.test(cursor.installation_id || ""))
    throw invalid("Andamento inválido. Recomece a instalação.");
  cursor.index = index;

  if (step === "database") {
    const created = await call("/d1/database", "POST", { name });
    if (!shapes.uuid.test(created?.uuid || ""))
      throw new ApiError(
        502,
        "cloudflare_error",
        "A Cloudflare não confirmou o banco.",
      );
    return {
      next: "bucket",
      cursor: { ...cursor, database_id: created.uuid },
      message: "Banco de dados criado.",
    };
  }
  if (!shapes.uuid.test(cursor.database_id || ""))
    throw invalid("Andamento inválido. Recomece a instalação.");

  if (step === "bucket") {
    await call("/r2/buckets", "POST", { name: name + "-media" });
    return {
      next: "migrate",
      cursor: { ...cursor, migration: 0 },
      message: "Armazenamento de arquivos criado.",
    };
  }

  if (step === "verify") {
    const url = String(cursor.url || "");
    if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url))
      throw invalid("Andamento inválido. Recomece a instalação.");
    let live = false;
    try {
      const health = await fetch(url + "/api/health", {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      const info: any = await health.json();
      live = health.ok && info.commit === index.commit;
    } catch {
      // o endereço novo ainda está sendo ativado
    }
    return live
      ? { next: "done", cursor, message: "Instalação no ar e conferida." }
      : {
          next: "verify",
          cursor,
          wait: true,
          message: "A Cloudflare ainda está ativando o endereço. Aguardando.",
        };
  }

  if (step === "finish") {
    await call(`/workers/scripts/${name}/schedules`, "PUT", [
      { cron: "*/5 * * * *" },
    ]);
    await call(`/workers/scripts/${name}/subdomain`, "POST", { enabled: true });
    const subdomain = await call("/workers/subdomain");
    if (!/^[a-z0-9-]+$/.test(subdomain?.subdomain || ""))
      throw invalid(
        "Habilite o subdomínio workers.dev da conta no painel da Cloudflare e tente este passo de novo.",
      );
    return {
      next: "verify",
      cursor: {
        ...cursor,
        url: `https://${name}.${subdomain.subdomain}.workers.dev`,
      },
      message: "Endereço e agendamento ligados.",
    };
  }

  const pkg = await releaseManifest(env, index);
  const read = blobReader(env);

  if (step === "migrate") {
    const position = Number(cursor.migration) || 0;
    const migration = pkg.migrations[position];
    if (!migration)
      return {
        next: "assets",
        cursor,
        message: "Estrutura do banco pronta.",
      };
    // One request per migration, recorded the way Wrangler and the panel's
    // updater expect, so later updates know what was already applied.
    await call(`/d1/database/${cursor.database_id}/query`, "POST", {
      sql:
        (position === 0
          ? "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);\n"
          : "") +
        migrationStatements(migration, await read(migration)).join(";\n") +
        `;\nINSERT INTO d1_migrations(name) VALUES('${migration.name}');`,
    });
    const done = position + 1;
    return {
      next: done < pkg.migrations.length ? "migrate" : "assets",
      cursor: { ...cursor, migration: done },
      message: `Preparando o banco: ${done} de ${pkg.migrations.length}.`,
    };
  }

  if (step === "assets") {
    if (!cursor.upload) {
      const session = await call(
        `/workers/scripts/${name}/assets-upload-session`,
        "POST",
        { manifest: assetManifestV2(pkg) },
      );
      if (typeof session?.jwt !== "string" || !Array.isArray(session.buckets))
        throw new ApiError(
          502,
          "cloudflare_error",
          "A Cloudflare não abriu o envio dos arquivos.",
        );
      const upload = { jwt: session.jwt, buckets: session.buckets };
      return {
        next: upload.buckets.length ? "assets" : "publish",
        cursor: { ...cursor, upload, bucket: 0 },
        message: "Envio dos arquivos do painel iniciado.",
      };
    }
    const upload = cursor.upload,
      bucket = Number(cursor.bucket) || 0;
    if (
      typeof upload.jwt !== "string" ||
      !Array.isArray(upload.buckets) ||
      !Array.isArray(upload.buckets[bucket])
    )
      throw invalid("Andamento inválido. Recomece a instalação.");
    // A Cloudflare pede que cada lote vá inteiro num só envio; só a resposta
    // do último lote da sessão traz o token de conclusão.
    let part;
    try {
      part = assetsForHashes(pkg, upload.buckets[bucket]);
    } catch {
      throw invalid("Andamento inválido. Recomece a instalação.");
    }
    // This call is authorised by the upload session itself, not by the token.
    const result = await cloudflare(
      upload.jwt,
      account,
      "/workers/assets/upload?base64=true",
      "POST",
      await assetUploadV2(part, read),
    );
    const sent = bucket + 1;
    if (sent < upload.buckets.length)
      return {
        next: "assets",
        cursor: { ...cursor, bucket: sent },
        message: `Enviando os arquivos do painel: lote ${sent + 1} de ${upload.buckets.length}.`,
      };
    if (typeof result?.jwt !== "string")
      throw new ApiError(
        502,
        "cloudflare_error",
        "A Cloudflare não confirmou todos os arquivos. Tente este passo de novo.",
      );
    return {
      next: "publish",
      cursor: {
        ...cursor,
        bucket: sent,
        upload: { jwt: result.jwt, buckets: [] },
      },
      message: "Arquivos do painel enviados.",
    };
  }

  // publish
  const masterKey = String(body.keys?.MASTER_KEY || ""),
    setupToken = String(body.keys?.SETUP_TOKEN || "");
  if (
    !shapes.key.test(masterKey) ||
    !shapes.key.test(setupToken) ||
    masterKey === setupToken
  )
    throw invalid("Chaves da instalação inválidas. Recomece a instalação.");
  if (typeof cursor.upload?.jwt !== "string")
    throw invalid("Andamento inválido. Recomece a instalação.");
  const published = await call(
    `/workers/scripts/${name}`,
    "PUT",
    await publishBody(pkg, read, {
      account,
      name,
      token,
      installationId: cursor.installation_id,
      databaseId: cursor.database_id,
      masterKey,
      setupToken,
      assetsToken: cursor.upload.jwt,
    }),
  );
  if (!published?.id && !published?.etag)
    throw new ApiError(
      502,
      "cloudflare_error",
      "A Cloudflare não confirmou a publicação.",
    );
  const { upload, bucket, ...rest } = cursor;
  return {
    next: "finish",
    cursor: rest,
    message: `Vinki ${pkg.version} publicado na sua conta.`,
  };
}
