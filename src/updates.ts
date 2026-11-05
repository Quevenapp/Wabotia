import { admin, secret, setSecret } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  now,
  requireValue,
  uid,
} from "./types";
import { buildInfo } from "./build-info.generated";
import { all } from "./db";
import * as legacy from "./legacy-updates";
import {
  assetManifest,
  assetUpload,
  CloudflareCallError,
  fetchPackage,
  installedSettings,
  latestRelease,
  parsePackage,
  releaseCloudflare,
  scriptPath,
  validateInstalledSettings,
  workerUpload,
} from "./release";

const configId = "system:release-config",
  stateId = "system:release-state",
  latestId = "system:release-latest";
export const deployHookUrl = legacy.deployHookUrl;
export const updatePlan = legacy.updatePlan;
const isDirect = (env: Env) =>
  !!(
    env.WABOTIA_INSTALLATION_ID &&
    env.WABOTIA_ACCOUNT_ID &&
    env.WABOTIA_WORKER_NAME
  );
async function tokenFor(env: Env) {
  return (await secret(env, configId)).token || env.WABOTIA_UPDATE_TOKEN || "";
}
async function legacyMode(env: Env) {
  return !isDirect(env) && !!(await secret(env, "system:update-config")).hook;
}
function failure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(
    502,
    "update_check_failed",
    error instanceof Error
      ? error.message
      : "Não foi possível consultar a publicação oficial.",
  );
}
export async function checkUpdate(env: Env, force = false) {
  if (await legacyMode(env)) return legacy.checkUpdate(env, force);
  const cached = await secret(env, latestId);
  if (!force && cached.checked_at > now() - 300000) return cached;
  try {
    const index = await latestRelease();
    const latest = {
      ...index,
      checked_at: now(),
      url: `https://github.com/Quevenapp/Wabotia/commit/${index.commit}`,
    };
    await setSecret(env, latestId, latest);
    return latest;
  } catch (e) {
    failure(e);
  }
}
function publicState(state: any) {
  if (!state.id) return null;
  return Object.fromEntries(
    [
      "id",
      "target",
      "version",
      "previous",
      "status",
      "phase",
      "created",
      "updated",
      "completed_at",
      "error",
    ].map((key) => [key, state[key]]),
  );
}
export async function updateStatus(env: Env) {
  if (await legacyMode(env))
    return {
      ...(await legacy.updateStatus(env)),
      method: "legacy",
      installation_ready: false,
    };
  const state = await secret(env, stateId),
    latest = await secret(env, latestId);
  if (state.target === buildInfo.commit && state.status !== "completed") {
    state.status = "completed";
    state.completed_at = now();
    await setSecret(env, stateId, state);
    if (state.package_key) await env.MEDIA.delete(state.package_key);
  }
  return {
    installed: buildInfo,
    method: "direct",
    installation_ready: isDirect(env),
    account_id: env.WABOTIA_ACCOUNT_ID || "",
    worker_name: env.WABOTIA_WORKER_NAME || "",
    configured: isDirect(env) && !!(await tokenFor(env)),
    latest: latest.commit ? latest : null,
    available: !!latest.commit && latest.commit !== buildInfo.commit,
    state: publicState(state),
    review_required:
      ["requested", "unknown", "sending"].includes(state.status) &&
      state.created < now() - 900000,
  };
}
export async function configureUpdates(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (!isDirect(env) && data.hook_url)
    return legacy.configureUpdates(env, actor, data);
  requireValue(
    isDirect(env),
    "Esta instalação usa o fluxo antigo. Siga o guia de reinstalação sem repositório.",
  );
  requireValue(
    typeof data.token === "string" &&
      data.token.length >= 20 &&
      data.token.length <= 1024 &&
      !/\s/.test(data.token),
    "Informe um token Cloudflare com Workers Scripts: Edit.",
  );
  requireValue(
    !(await updatePending(env)),
    "Aguarde a atualização atual antes de trocar o token.",
  );
  try {
    const settings = await installedSettings(
      data.token,
      scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!),
    );
    validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
    await setSecret(env, configId, { token: data.token, configured_at: now() });
    return { configured: true };
  } catch (e) {
    failure(e);
  }
}
export async function startUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (await legacyMode(env)) return legacy.startUpdate(env, actor, data);
  requireValue(
    isDirect(env) && (await tokenFor(env)),
    "Configure a autorização Cloudflare para atualizar esta instalação.",
  );
  const old = await secret(env, stateId);
  if (["pending", "sending", "requested", "unknown"].includes(old.status))
    return publicState(old);
  const index = await checkUpdate(env);
  requireValue(
    data.commit === index.commit && index.commit !== buildInfo.commit,
    "Confira novamente a versão disponível antes de atualizar.",
  );
  const state = {
    id: uid(),
    index,
    target: index.commit,
    version: index.version,
    previous: buildInfo.commit,
    status: "pending",
    phase: "download",
    created: now(),
    updated: now(),
  };
  await setSecret(env, stateId, state);
  return publicState(state);
}
export async function updatePending(env: Env) {
  return (await secret(env, stateId)).status === "pending";
}
export async function processUpdate(env: Env) {
  const state = await secret(env, stateId);
  if (state.status !== "pending") return;
  try {
    const token = await tokenFor(env),
      base = scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!);
    if (state.phase === "download") {
      const { bytes } = await fetchPackage(state.index);
      state.package_key = `system/releases/${state.id}.json`;
      await env.MEDIA.put(state.package_key, bytes, {
        httpMetadata: { contentType: "application/json" },
      });
      state.phase = "prepare";
    } else {
      const stored = await env.MEDIA.get(state.package_key);
      requireValue(
        stored,
        "O pacote temporário não está disponível. Libere uma nova tentativa.",
      );
      const pkg = await parsePackage(
        state.index,
        new Uint8Array(await stored!.arrayBuffer()),
      );
      if (state.phase === "prepare") {
        const settings = await installedSettings(token, base);
        validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
        const upload = await releaseCloudflare(
          token,
          base + "/assets-upload-session",
          "POST",
          { manifest: assetManifest(pkg) },
        );
        requireValue(
          typeof upload?.jwt === "string" && Array.isArray(upload.buckets),
          "Sessão de arquivos inválida.",
        );
        state.upload = upload;
        state.bucket = 0;
        state.phase = upload.buckets.length ? "assets" : "migrate";
      } else if (state.phase === "assets") {
        const result = await releaseCloudflare(
          state.upload.jwt,
          `/accounts/${env.WABOTIA_ACCOUNT_ID}/workers/assets/upload?base64=true`,
          "POST",
          assetUpload(pkg, state.upload.buckets[state.bucket]),
        );
        state.bucket++;
        if (state.bucket === state.upload.buckets.length) {
          requireValue(
            typeof result?.jwt === "string",
            "A Cloudflare não confirmou todos os arquivos. Libere uma nova tentativa.",
          );
          state.upload.jwt = result.jwt;
          state.phase = "migrate";
        }
      } else if (state.phase === "migrate") {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
        ).run();
        const applied = await all(env, "SELECT name FROM d1_migrations");
        const migration = pkg.migrations.find(
          (m) => !applied.some((row) => row.name === m.name),
        );
        if (migration) {
          await env.DB.batch([
            ...migration.statements.map((sql) => env.DB.prepare(sql)),
            env.DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(
              migration.name,
            ),
          ]);
        } else state.phase = "publish";
      } else if (state.phase === "publish") {
        const settings = await installedSettings(token, base);
        validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
        state.status = "sending";
        state.updated = now();
        await setSecret(env, stateId, state);
        const result = await releaseCloudflare(
          token,
          base,
          "PUT",
          workerUpload(pkg, settings, state.upload.jwt),
        );
        requireValue(
          result?.id || result?.etag,
          "A Cloudflare não confirmou a publicação. Confira a versão antes de repetir.",
        );
        state.status = "requested";
      } else throw new Error("Etapa de atualização desconhecida.");
    }
    state.updated = now();
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  } catch (e) {
    state.error =
      e instanceof Error ? e.message : "A atualização não foi concluída.";
    state.status =
      state.status === "sending" &&
      (!(e instanceof CloudflareCallError) || e.ambiguous)
        ? "unknown"
        : "failed";
    state.updated = now();
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  }
}
export async function resetUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (await legacyMode(env)) return legacy.resetUpdate(env, actor, data);
  const state = await secret(env, stateId);
  requireValue(
    data.confirmed_build_stopped === true &&
      state.id &&
      state.status !== "completed" &&
      state.status !== "pending",
    "Confira a versão e confirme que a publicação anterior terminou.",
  );
  requireValue(
    state.status === "failed" || state.created < now() - 900000,
    "Aguarde a publicação. Não é possível repetir uma operação ainda em andamento.",
  );
  state.status = "cancelled";
  await setSecret(env, stateId, state);
  if (state.package_key) await env.MEDIA.delete(state.package_key);
  return publicState(state);
}
