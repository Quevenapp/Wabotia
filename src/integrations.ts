import { all, one, exec } from "./db";
import {
  ApiError,
  type Env,
  type Run,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { mediaKind, putStream, multipartStream } from "./media";
import { zernioAccountList } from "./zernio-accounts";
import { secret, setSecret, safeFetch, random, sha } from "./security";
import { isLink, linkCall, type LinkOp } from "./hermes-link";
import { aiProbe } from "./ai-provider";
// No modo plugin o motor continua pedindo os mesmos caminhos; aqui eles viram
// as operações fechadas do vínculo (docs/HERMES-PLUGIN.md).
function linkJob(
  path: string,
  body?: any,
  profile?: string,
  idem?: string,
  sessionKey?: string,
) {
  if (path === "/api/profiles") return { op: "profiles.list" as LinkOp };
  const target = profile || "default";
  if (path === "/v1/capabilities")
    return { op: "capabilities.get" as LinkOp, profile: target };
  if (path === "/v1/runs" && body)
    return {
      op: "runs.create" as LinkOp,
      profile: target,
      body,
      idempotency_key: idem,
      ...(sessionKey ? { session_key: sessionKey } : {}),
    };
  const run = /^\/v1\/runs\/([^/]+)(\/stop)?$/.exec(path);
  if (run)
    return {
      op: (run[2] ? "runs.stop" : "runs.get") as LinkOp,
      profile: target,
      run_id: decodeURIComponent(run[1]),
    };
  throw new ApiError(
    502,
    "hermes_error",
    "Operação Hermes indisponível pelo plugin.",
  );
}
export async function hermesRequest(
  env: Env,
  connection: any,
  path: string,
  body?: any,
  profile?: string,
  idem?: string,
  // Separa a memória do Hermes por conversa: sem isto, tudo o que o perfil
  // atende compartilha o mesmo escopo.
  sessionKey?: string,
) {
  if (isLink(connection))
    return linkCall(
      env,
      connection,
      linkJob(path, body, profile, idem, sessionKey),
    );
  const cfg = json(connection.config),
    keys = await secret(env, `connection:${connection.id}`);
  const api = path.startsWith("/v1/");
  const base = api ? cfg.api_url || cfg.url : cfg.url;
  const token = api
    ? keys.profile_keys?.[profile || "default"]
    : keys.dashboard_token;
  requireValue(
    token,
    `Configure a chave ${api ? "API_SERVER_KEY de " + profile : "do backend administrativo"} do Hermes.`,
  );
  const prefix =
    api && profile && profile !== "default"
      ? `/p/${encodeURIComponent(profile)}`
      : "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (keys.access_client_id) {
    headers["CF-Access-Client-Id"] = keys.access_client_id;
    headers["CF-Access-Client-Secret"] = keys.access_client_secret;
  }
  if (idem) headers["Idempotency-Key"] = idem;
  if (sessionKey) headers["X-Hermes-Session-Key"] = sessionKey;
  const r = await safeFetch(`${base}${prefix}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok)
    throw new ApiError(
      502,
      "hermes_error",
      `Hermes respondeu HTTP ${r.status}.`,
    );
  const result = await r.json<any>();
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    connection.id,
  );
  return result;
}

export async function hermesArtifact(
  env: Env,
  connection: any,
  profile: string,
  artifactId: string,
  name: string,
  actor: string,
) {
  requireValue(
    /^[A-Za-z0-9_-]{8,200}$/.test(artifactId),
    "Referência de arquivo inválida.",
  );
  const cfg = json(connection.config),
    keys = await secret(env, `connection:${connection.id}`),
    link = isLink(connection);
  requireValue(
    link || keys.profile_keys?.[profile],
    "Configure a API_SERVER_KEY do bot no Hermes.",
  );
  const prior = await one(
    env,
    "SELECT * FROM artifact_imports WHERE connection_id=? AND remote_profile=? AND artifact_id=?",
    connection.id,
    profile,
    artifactId,
  );
  if (prior) {
    requireValue(
      prior.actor === actor,
      "Artefato pertence a outra identidade.",
    );
    const existing = await one(
      env,
      "SELECT id FROM media WHERE id=? AND actor=?",
      prior.media_id,
      actor,
    );
    if (existing) return existing.id;
    // A completed R2 write can be recovered even if the following D1 write was interrupted.
    const key = `${connection.profile_id}/${prior.media_id}`,
      obj = await env.MEDIA.head(key);
    if (obj) {
      await exec(
        env,
        "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        prior.media_id,
        connection.profile_id,
        prior.name,
        obj.httpMetadata?.contentType || "application/octet-stream",
        obj.size,
        key,
        actor,
        now(),
      );
      await exec(
        env,
        "UPDATE artifact_imports SET state='complete' WHERE media_id=?",
        prior.media_id,
      );
      return prior.media_id;
    }
    throw new ApiError(
      409,
      "artifact_unknown",
      "Download de uso único interrompido. Exporte um novo artefato no Hermes; o download anterior não será repetido automaticamente.",
    );
  }
  const id = uid();
  await exec(
    env,
    "INSERT INTO artifact_imports(connection_id,remote_profile,artifact_id,media_id,actor,name,created) VALUES(?,?,?,?,?,?,?)",
    connection.id,
    profile,
    artifactId,
    id,
    actor,
    name.slice(0, 200),
    now(),
  );
  if (link) {
    // O plugin envia o arquivo para uma chave temporária; daqui ele segue o
    // mesmo caminho de gravação do download direto.
    const job = uid(),
      temporary = `hermes-link/${connection.id}/${job}`;
    try {
      await linkCall(env, connection, {
        id: job,
        op: "artifacts.download",
        profile,
        artifact_id: artifactId,
        deadline_ms: 25_000,
      });
      const object = await env.MEDIA.get(temporary);
      requireValue(object, "O Hermes não enviou o arquivo.");
      await storeRemoteMedia(
        env,
        connection.profile_id,
        name.slice(0, 200),
        object.httpMetadata?.contentType || "application/octet-stream",
        new Response(object.body, {
          headers: { "Content-Length": String(object.size) },
        }),
        { id, actor },
      );
    } finally {
      await env.MEDIA.delete(temporary);
    }
    await exec(
      env,
      "UPDATE artifact_imports SET state='complete' WHERE media_id=?",
      id,
    );
    return id;
  }
  const headers: Record<string, string> = {
    Authorization: "Bearer " + keys.profile_keys[profile],
  };
  if (keys.access_client_id) {
    headers["CF-Access-Client-Id"] = keys.access_client_id;
    headers["CF-Access-Client-Secret"] = keys.access_client_secret;
  }
  const prefix =
    profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  const response = await safeFetch(
    `${cfg.api_url || cfg.url}${prefix}/v1/artifacts/download/${encodeURIComponent(artifactId)}`,
    { headers },
  );
  await storeRemoteMedia(
    env,
    connection.profile_id,
    name.slice(0, 200),
    response.headers.get("Content-Type") || "application/octet-stream",
    response,
    { id, actor },
  );
  await exec(
    env,
    "UPDATE artifact_imports SET state='complete' WHERE media_id=?",
    id,
  );
  return id;
}
export async function discover(env: Env, id: string, profile: string) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='hermes'",
    id,
    profile,
  );
  requireValue(c, "Conexão Hermes não encontrada.");
  const data = await hermesRequest(env, c, "/api/profiles");
  for (const p of data.profiles || []) {
    if (typeof p.name !== "string") continue;
    await exec(
      env,
      "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,remote_profile) DO UPDATE SET name=excluded.name",
      uid(),
      profile,
      c.id,
      p.name,
      p.display_name || p.name,
    );
  }
  const keys = await secret(env, `connection:${id}`);
  const checks: Record<string, any> = {};
  // No modo plugin as chaves ficam no Hermes: valem os perfis que ele informa
  // com a API local habilitada.
  const remoteProfiles: string[] = isLink(c)
    ? (data.profiles || [])
        .filter((p: any) => typeof p.name === "string" && p.api_enabled)
        .map((p: any) => p.name as string)
    : Object.keys(keys.profile_keys || {});
  requireValue(
    remoteProfiles.length <= 20,
    "Use no máximo 20 bots por conexão Hermes.",
  );
  await Promise.all(
    remoteProfiles.map(async (remote) => {
      const cap = await hermesRequest(
        env,
        c,
        "/v1/capabilities",
        undefined,
        remote,
      );
      requireValue(
        cap.features?.runs_idempotency?.supported &&
          cap.features?.runs_idempotency?.durable,
        "Atualize o Hermes: é necessária a API /v1/runs com idempotência durável.",
      );
      checks[remote] = cap.features?.runs_idempotency;
    }),
  );
  requireValue(
    Object.keys(checks).length,
    "Configure a API_SERVER_KEY de pelo menos um bot no Hermes.",
  );
  await exec(
    env,
    "UPDATE connections SET config=?,last_seen=? WHERE id=?",
    JSON.stringify({
      ...json(c.config),
      verified_at: now(),
      capabilities: checks,
    }),
    now(),
    id,
  );
  return all(env, "SELECT * FROM bots WHERE connection_id=?", id);
}
/** The Telegram team channel no longer exists; old connections can only be deleted. */
export const telegramRemoved = () =>
  new ApiError(
    410,
    "telegram_removed",
    "O atendimento pelo Telegram foi removido. Use o painel ou os aplicativos e exclua esta conexão.",
  );
export async function probe(
  env: Env,
  id: string,
  profile: string,
  origin: string,
) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  requireValue(c, "Conexão não encontrada.");
  const cfg = json(c.config),
    keys = await secret(env, `connection:${id}`);
  let details: any = {};
  if (c.kind === "hermes")
    return { ok: true, bots: await discover(env, id, profile) };
  if (c.kind === "ai") {
    // Uma conexão de IA tem um único bot, criado (desabilitado) no primeiro
    // teste bem-sucedido, com o nome da conexão.
    await aiProbe(env, c);
    await exec(
      env,
      "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,remote_profile) DO NOTHING",
      uid(),
      profile,
      c.id,
      "default",
      c.name,
    );
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ ...cfg, verified_at: now() }),
      id,
    );
    return {
      ok: true,
      provider: cfg.provider,
      model: cfg.model,
      bots: await all(env, "SELECT * FROM bots WHERE connection_id=?", id),
    };
  }
  if (c.kind === "telegram") throw telegramRemoved();
  if (c.kind === "meta") {
    throw new ApiError(
      410,
      "meta_removed",
      "Conecte este telefone pela Zernio. A integração direta Meta foi removida.",
    );
  }
  if (c.kind === "zernio") {
    const found = await zernioAccountList(env, c, cfg.zernio_profile_id);
    const account = found.find((a: any) => a.account_id === cfg.account_id);
    requireValue(
      account && account.number === cfg.number,
      "A Zernio não confirmou este telefone na integração informada.",
    );
    details = {
      account_id: account.account_id,
      number: account.number,
      provider: "zernio",
    };
  }
  if (["qr", "hermes-whatsapp"].includes(c.kind)) {
    requireValue(
      c.last_seen && now() - c.last_seen < 60000,
      "O conector está offline. Inicie-o antes de testar.",
    );
    details = { online: true };
  }
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({ ...cfg, verified_at: now() }),
    id,
  );
  return { ok: true, ...details };
}
export async function storeRemoteMedia(
  env: Env,
  profile: string,
  name: string,
  type: string,
  response: Response,
  identity?: { id: string; actor: string },
) {
  requireValue(
    response.ok && response.body,
    "Não foi possível obter o arquivo.",
  );
  const id = identity?.id || uid(),
    objectKey = `${profile}/${id}`;
  const size = await putStream(env, objectKey, type, response);
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    profile,
    name,
    type,
    size,
    objectKey,
    identity?.actor || "transport",
    now(),
  );
  return id;
}
export function approvedTemplate(t: any) {
  if (t?.status !== "APPROVED" || t?.category !== "UTILITY") return false;
  const body = t.components?.find((c: any) => c.type === "BODY");
  const slots = Array.from(
    new Set((body?.text || "").match(/\{\{\s*\d+\s*\}\}/g) || []),
  )
    .sort()
    .join(",")
    .replaceAll(" ", "");
  return (
    slots === "{{1}},{{2}}" &&
    t.components.every(
      (c: any) =>
        c.type === "BODY" ||
        (c.type === "FOOTER" && !/\{\{/.test(c.text || "")) ||
        (c.type === "HEADER" &&
          c.format === "TEXT" &&
          !/\{\{/.test(c.text || "")),
    )
  );
}
