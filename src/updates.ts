import { admin, requireDirectPerson, secret, setSecret } from "./security";
import { requireStepUp } from "./mfa";
import {
  ApiError,
  type Actor,
  type Env,
  now,
  requireValue,
  uid,
} from "./types";
import { buildInfo } from "./build-info.generated";
import { webInstallerEnabled } from "./web-install";
import { all, exec, one } from "./db";
import {
  assetManifestV2,
  assetsForHashes,
  assetUploadV2,
  checkBlob,
  CloudflareCallError,
  fetchBlob,
  fetchManifest,
  installedSettings,
  latestReleaseV2,
  MAX_UPLOAD_BATCH,
  migrationStatements,
  nextRound,
  parseManifest,
  releaseCloudflare,
  scriptPath,
  uniqueBlobs,
  validateIndexV2,
  validateInstalledSettings,
  versionAtLeast,
  versionGreater,
  workerUploadV2,
  type BlobRef,
  type ReleaseManifest,
} from "./release";

const configId = "system:release-config",
  stateId = "system:release-state",
  latestId = "system:release-latest";
const automaticConfigId = "system:release-automatic-config",
  automaticStateId = "system:release-automatic-state";
const activeStatuses = ["pending", "sending", "requested", "unknown"];
const automaticDefaults = {
  enabled: false,
  hour: 3,
  window_hours: 2,
  timezone: "America/Sao_Paulo",
};

async function updateLock<T>(
  env: Env,
  work: () => Promise<T>,
  skipBusy = false,
): Promise<T | null> {
  const owner = uid(),
    at = now();
  const result = await exec(
    env,
    "INSERT INTO system_update_locks(name,owner,expires) VALUES('release',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE system_update_locks.expires<=?",
    owner,
    at + 180000,
    at,
  );
  if (!result.meta.changes) {
    if (skipBusy) return null;
    throw new ApiError(
      409,
      "update_busy",
      "Outra etapa de atualização está em andamento. Tente novamente em instantes.",
    );
  }
  try {
    return await work();
  } finally {
    await exec(
      env,
      "DELETE FROM system_update_locks WHERE name='release' AND owner=?",
      owner,
    );
  }
}

function localParts(at: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export function automaticWindow(at: number, hour: number, windowHours: number) {
  const local = localParts(at),
    distance = (local.hour - hour + 24) % 24;
  return {
    open: distance < windowHours,
    key: localParts(at - distance * 3600000).date,
  };
}

export async function automaticUpdateStatus(env: Env) {
  const config = {
    ...automaticDefaults,
    ...(await secret(env, automaticConfigId)),
  };
  const state = await secret(env, automaticStateId);
  return {
    ...config,
    ...state,
    enabled: config.enabled,
    status: config.enabled ? state.status || "scheduled" : "off",
    max_attempts: 3,
  };
}

export async function configureAutomaticUpdates(
  env: Env,
  actor: Actor,
  data: any,
) {
  admin(actor);
  requireValue(
    typeof data.enabled === "boolean",
    "Informe se a atualização automática está ligada.",
  );
  requireValue(
    Number.isInteger(data.hour) && data.hour >= 0 && data.hour <= 23,
    "Escolha uma hora entre 0 e 23.",
  );
  requireValue(
    Number.isInteger(data.window_hours) &&
      data.window_hours >= 1 &&
      data.window_hours <= 6,
    "Escolha uma janela de 1 a 6 horas.",
  );
  if (data.enabled) {
    requireValue(
      (await secret(env, configId)).mode !== PER_UPDATE,
      "Com o token colado a cada atualização não há token guardado para a atualização automática. Salve um token em Alterar configuração de atualização para ligá-la.",
    );
    requireValue(
      isDirect(env) && !!(await tokenFor(env)),
      "Configure a atualização direta desta instalação antes de ligar a atualização automática.",
    );
  }
  return updateLock(env, async () => {
    const old = await secret(env, automaticConfigId);
    await setSecret(env, automaticConfigId, {
      ...automaticDefaults,
      enabled: data.enabled,
      hour: data.hour,
      window_hours: data.window_hours,
      updated_at: now(),
      updated_by: actor.id,
    });
    if (!data.enabled) {
      const job = await secret(env, stateId);
      if (
        job.source === "automatic" &&
        job.status === "pending" &&
        !job.started_at
      ) {
        await setSecret(env, stateId, {
          ...job,
          status: "cancelled",
          updated: now(),
        });
      }
    }
    if (!old.enabled && data.enabled)
      await setSecret(env, automaticStateId, { status: "scheduled" });
    return automaticUpdateStatus(env);
  });
}
const isDirect = (env: Env) =>
  !!(
    env.WABOTIA_INSTALLATION_ID &&
    env.WABOTIA_ACCOUNT_ID &&
    env.WABOTIA_WORKER_NAME
  );
async function tokenFor(env: Env) {
  const config = await secret(env, configId);
  // Modo "colar o token a cada atualização": só o token do trabalho ativo,
  // dentro do prazo. Nunca cai no do painel nem no inicial.
  if (config.mode === PER_UPDATE) return jobToken(env);
  return config.token || env.WABOTIA_UPDATE_TOKEN || "";
}
/**
 * De onde vem o token que o atualizador usa: "panel" (salvo no painel, em
 * geral só Workers Scripts: Edit), "initial" (o segredo do Worker que o
 * instalador gravou, que também tem D1 e R2 Edit), "per_update" (colado a
 * cada atualização, nada guardado em repouso) ou null.
 */
async function tokenSource(env: Env) {
  const config = await secret(env, configId);
  if (config.mode === PER_UPDATE) return PER_UPDATE;
  if (config.token) return "panel";
  return env.WABOTIA_UPDATE_TOKEN ? "initial" : null;
}

// ---------------------------------------------------------------------------
// Modo "não guardar o token" (docs/ATUALIZACOES.md). A instalação não guarda
// token em repouso: a pessoa cola o token ao iniciar a atualização; ele fica
// cifrado em `system:release-job-token`, preso ao trabalho, só enquanto o
// trabalho está em `pending` e por até 60 minutos. Encolhe a janela de
// sempre para minutos por atualização; não protege contra código rodando no
// Worker durante esses minutos.

export const PER_UPDATE = "per_update";
const jobTokenId = "system:release-job-token";
/** Prazo do token do trabalho: seis vezes o maior salto medido (9 min 50 s). */
export const JOB_TOKEN_TTL_MS = 60 * 60000;
const JOB_TOKEN_EXPIRED =
  "O prazo do token venceu. Inicie a atualização de novo e cole o token.";

async function jobToken(env: Env) {
  const record = await secret(env, jobTokenId),
    state = await secret(env, stateId);
  return record.token &&
    record.job_id === state.id &&
    state.status === "pending" &&
    record.expires_at > now()
    ? (record.token as string)
    : "";
}

/**
 * O token do trabalho só existe enquanto o trabalho dele está em `pending` e
 * dentro do prazo. Fora disso (concluído, falho, cancelado, sem confirmação,
 * outro trabalho) é apagado; vencido com o trabalho ainda em `pending`, o
 * trabalho falha com a mensagem do prazo. Chamado em toda entrada do
 * atualizador.
 */
async function settleJobToken(env: Env) {
  const record = await secret(env, jobTokenId);
  if (!record.job_id) return;
  const state = await secret(env, stateId);
  const own = state.id === record.job_id && state.status === "pending";
  if (own && record.expires_at > now()) return;
  if (own)
    await setSecret(env, stateId, {
      ...state,
      status: "failed",
      error: JOB_TOKEN_EXPIRED,
      retryable: false,
      retry_at: null,
      updated: now(),
    });
  await exec(env, "DELETE FROM secrets WHERE id=?", jobTokenId);
}

function requireTokenShape(token: unknown) {
  requireValue(
    typeof token === "string" &&
      token.length >= 20 &&
      token.length <= 1024 &&
      !/\s/.test(token),
    "Informe um token Cloudflare com Workers Scripts: Edit.",
  );
}

/** Confere o token colado contra a identidade desta instalação. */
async function checkPastedToken(env: Env, token: string) {
  try {
    validateInstalledSettings(
      await installedSettings(
        token,
        scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!),
      ),
      env.WABOTIA_INSTALLATION_ID!,
    );
  } catch (e) {
    failure(e);
  }
}

/**
 * Liga o modo "colar o token a cada atualização". Para valer de verdade, não
 * pode sobrar token guardado: apaga o do painel e o segredo inicial do
 * Worker (com o token colado aqui) e desliga a atualização automática, que
 * precisa de token em repouso. Voltar ao modo guardado é salvar um token em
 * "Alterar configuração de atualização" (configureUpdates).
 */
export async function enablePerUpdateToken(env: Env, actor: Actor, data: any) {
  admin(actor);
  requireDirectPerson(actor);
  requireStepUp(actor);
  requireValue(
    isDirect(env),
    "Esta instalação não tem a identificação para atualizar pelo painel.",
  );
  requireValue(
    data?.confirmed === true,
    "Confirme que entendeu: a atualização automática fica desligada e cada atualização pede o token.",
  );
  requireTokenShape(data?.token);
  return updateLock(env, async () => {
    requireValue(
      !activeStatuses.includes((await secret(env, stateId)).status),
      "Aguarde a atualização atual antes de mudar o modo do token.",
    );
    await checkPastedToken(env, data.token);
    let initialDeleted = false;
    if (env.WABOTIA_UPDATE_TOKEN) {
      await releaseCloudflare(
        data.token,
        `${scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!)}/secrets/${INITIAL_TOKEN_SECRET}`,
        "DELETE",
      );
      initialDeleted = true;
    }
    const automatic = await secret(env, automaticConfigId);
    if (automatic.enabled)
      await setSecret(env, automaticConfigId, {
        ...automatic,
        enabled: false,
        updated_at: now(),
        updated_by: actor.id,
      });
    await setSecret(env, configId, {
      mode: PER_UPDATE,
      mode_at: now(),
      mode_by: actor.id,
    });
    await exec(env, "DELETE FROM secrets WHERE id=?", jobTokenId);
    return {
      mode: PER_UPDATE,
      initial_deleted: initialDeleted,
      automatic_disabled: !!automatic.enabled,
    };
  });
}

/** Nome do segredo do Worker com o token inicial (web-install, install-release). */
export const INITIAL_TOKEN_SECRET = "WABOTIA_UPDATE_TOKEN";

/**
 * Apaga o token inicial (segredo do Worker) usando o token salvo no painel.
 * Depois disso não há reserva: se o token do painel for revogado, a
 * atualização para até a pessoa salvar outro. Só a pessoa, na própria sessão,
 * com o segundo fator quando ela tem um ou a política pede.
 */
export async function deleteInitialToken(env: Env, actor: Actor, data: any) {
  admin(actor);
  requireDirectPerson(actor);
  requireStepUp(actor);
  requireValue(
    isDirect(env),
    "Esta instalação não tem a identificação para atualizar pelo painel.",
  );
  requireValue(
    data?.confirmed === true,
    "Confirme que entendeu: depois de apagar, o token salvo no painel é o único, sem reserva.",
  );
  const panel = (await secret(env, configId)).token;
  requireValue(
    !!panel,
    "Salve antes um token só com Workers Scripts: Edit em Alterar configuração de atualização. Sem ele, a instalação ficaria sem atualização.",
  );
  if (!env.WABOTIA_UPDATE_TOKEN) return { deleted: false, absent: true };
  return updateLock(env, async () => {
    const state = await secret(env, stateId);
    requireValue(
      !["pending", "sending"].includes(state.status),
      "Há uma atualização em andamento. Apague o token inicial depois que ela terminar.",
    );
    await releaseCloudflare(
      panel,
      `${scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!)}/secrets/${INITIAL_TOKEN_SECRET}`,
      "DELETE",
    );
    return { deleted: true };
  });
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
  const cached = await secret(env, latestId);
  // Só o índice do formato 2 vale como cache: o que a 0.21.0 guardou (formato
  // 1) é consultado de novo.
  if (
    !force &&
    cached.format === 2 &&
    cached.checked_at > now() - 300000 &&
    cached.expires > now()
  )
    return cached;
  try {
    // Índice do formato 2 com a assinatura e a validade conferidas.
    const index = await latestReleaseV2();
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
      "source",
      "attempt",
      "started_at",
      "retryable",
      "retry_at",
    ].map((key) => [key, state[key]]),
  );
}
/**
 * Herança do formato 1. O trabalho em `system:release-state` pode ter sido
 * criado pelo atualizador da 0.21.0 (ou anterior): índice de formato 1, o
 * pacote inteiro em `package_key` (system/releases/<id>.json, fora do prefixo
 * do trabalho) e etapas que o formato 2 não tem (`download`). Na primeira
 * leitura depois da ponte ele é fechado uma vez:
 * - o que publicou o código em execução (a própria ponte) fica concluído;
 * - qualquer outro ainda ativo vira falho, sem nova tentativa automática: o
 *   formato 2 não continua um trabalho do formato 1 ("Liberar nova
 *   tentativa" e atualizar de novo);
 * - o pacote antigo sai do R2 (cleanup_pending, como na conclusão).
 */
export async function settleFormat1Job(env: Env) {
  const state = await secret(env, stateId);
  if (!state.id || state.format1_settled || state.index?.format === 2)
    return state;
  const at = now();
  if (state.target === buildInfo.commit) {
    if (state.status !== "completed") {
      state.status = "completed";
      state.completed_at = at;
    }
  } else if (activeStatuses.includes(state.status)) {
    state.status = "failed";
    state.error =
      "Esta atualização começou na versão anterior, no formato antigo, e não continua nesta. Libere uma nova tentativa e atualize de novo.";
  }
  state.retryable = false;
  state.retry_at = null;
  state.format1_settled = true;
  if (state.package_key) state.cleanup_pending = true;
  state.updated = at;
  await setSecret(env, stateId, state);
  return state;
}
/** Chamado somente com updateLock adquirido; nunca regrava outro trabalho. */
async function reconcileUpdate(env: Env, id: string | undefined) {
  if ((await secret(env, stateId)).id !== id) return;
  await settleJobToken(env);
  const state = await settleFormat1Job(env);
  if (state.target === buildInfo.commit && state.status !== "completed") {
    // Concluída primeiro; a limpeza do R2 vem depois e, se falhar, é
    // repetida na próxima consulta (cleanup_pending).
    state.status = "completed";
    state.completed_at = now();
    state.cleanup_pending = true;
    if ((await secret(env, stateId)).id === id)
      await setSecret(env, stateId, state);
  }
  if (state.cleanup_pending) {
    try {
      await dropTemporary(env, state);
      state.cleanup_pending = false;
      if ((await secret(env, stateId)).id === id)
        await setSecret(env, stateId, state);
    } catch {
      // Fica pendente para a próxima consulta.
    }
  }
}
/**
 * Há algo a gravar em `reconcileUpdate`? A consulta comum do painel só lê: a
 * trava (uma gravação no D1, e 409 para quem clicar "Atualizar" no mesmo
 * instante) fica para quando o estado pede conclusão, limpeza, o fechamento
 * do formato 1 ou o descarte do token do trabalho.
 */
async function needsReconcile(env: Env, state: any) {
  if (
    state.id &&
    ((!state.format1_settled && state.index?.format !== 2) ||
      (state.target === buildInfo.commit && state.status !== "completed") ||
      state.cleanup_pending)
  )
    return true;
  const record = await secret(env, jobTokenId);
  return (
    !!record.job_id &&
    !(
      record.job_id === state.id &&
      state.status === "pending" &&
      record.expires_at > now()
    )
  );
}
/** Instante do último avanço (os campos novos faltam no estado da ponte). */
const lastProgress = (state: any) =>
  state.last_progress_at ?? state.updated ?? state.created ?? 0;
/** `pending` sem avanço há mais de 30 min: o painel oferece liberar. */
const stalledPending = (state: any) =>
  state.status === "pending" && lastProgress(state) < now() - 30 * 60000;
export async function updateStatus(env: Env) {
  const observed = await secret(env, stateId);
  if (await needsReconcile(env, observed))
    await updateLock(env, () => reconcileUpdate(env, observed.id), true);
  const state = await secret(env, stateId),
    stored = await secret(env, latestId),
    // O índice do formato 1 não descreve uma versão que este leitor instale.
    latest: any = stored.format === 2 ? stored : {};
  return {
    installed: buildInfo,
    method: "direct",
    installation_ready: isDirect(env),
    account_id: env.WABOTIA_ACCOUNT_ID || "",
    worker_name: env.WABOTIA_WORKER_NAME || "",
    configured:
      isDirect(env) &&
      ((await tokenSource(env)) === PER_UPDATE || !!(await tokenFor(env))),
    // O painel avisa quando o token inicial (com D1 e R2) ainda está em uso ou
    // guardado, e oferece apagá-lo depois que houver um token só de Workers.
    token_source: await tokenSource(env),
    initial_token_stored: !!env.WABOTIA_UPDATE_TOKEN,
    // Cofre fiscal configurado em alguma área (mesma conta Cloudflare): o
    // painel sugere o modo "colar o token a cada atualização".
    fiscal_vault_configured: !!(await one(
      env,
      "SELECT 1 x FROM secrets WHERE id LIKE 'erp-emissor:%' LIMIT 1",
    )),
    latest: latest.commit ? latest : null,
    available: !!latest.commit && latest.commit !== buildInfo.commit,
    state: publicState(state),
    review_required:
      (["requested", "unknown", "sending"].includes(state.status) &&
        state.created < now() - 900000) ||
      stalledPending(state),
    automatic: await automaticUpdateStatus(env),
    // Site oficial (que também serve o catálogo): o painel lembra de renovar
    // o índice assinado (docs/ATUALIZACOES-FORMATO.md, "Prazo do índice").
    distribution: webInstallerEnabled(env),
  };
}
export async function configureUpdates(env: Env, actor: Actor, data: any) {
  admin(actor);
  // O token da Cloudflare é segredo: só a pessoa, na própria sessão. Ligar e
  // desligar a atualização automática não leva segredo e segue liberável.
  requireDirectPerson(actor);
  requireValue(
    isDirect(env),
    "Esta instalação não tem a identificação para atualizar pelo painel. Reinstale com o instalador (docs/INSTALACAO.md).",
  );
  requireValue(
    typeof data.token === "string" &&
      data.token.length >= 20 &&
      data.token.length <= 1024 &&
      !/\s/.test(data.token),
    "Informe um token Cloudflare com Workers Scripts: Edit.",
  );
  return updateLock(env, async () => {
    requireValue(
      !activeStatuses.includes((await secret(env, stateId)).status),
      "Aguarde a atualização atual antes de trocar o token.",
    );
    try {
      const settings = await installedSettings(
        data.token,
        scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!),
      );
      validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
      await setSecret(env, configId, {
        token: data.token,
        configured_at: now(),
      });
      return { configured: true };
    } catch (e) {
      failure(e);
    }
  });
}
export async function startUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  if ((await secret(env, configId)).mode !== PER_UPDATE)
    return updateLock(env, () => startDirectUpdate(env, data));
  // Modo "colar o token a cada atualização": o pedido leva um segredo, então
  // só a pessoa, na própria sessão; o token é conferido antes de criar o
  // trabalho e fica preso a ele.
  requireDirectPerson(actor);
  requireStepUp(actor);
  requireTokenShape(data?.token);
  return updateLock(env, async () => {
    await settleJobToken(env);
    const before = (await secret(env, stateId)).id;
    await checkPastedToken(env, data.token);
    const job = await startDirectUpdate(
      env,
      { commit: data.commit },
      "manual",
      true,
    );
    // Um trabalho que já estava ativo segue com o token dele (ou falha pelo
    // prazo); só o trabalho criado agora recebe o token colado.
    if (job && job.id !== before && job.status === "pending")
      await setSecret(env, jobTokenId, {
        token: data.token,
        job_id: job.id,
        expires_at: now() + JOB_TOKEN_TTL_MS,
      });
    return job;
  });
}
async function startDirectUpdate(
  env: Env,
  data: any,
  source = "manual",
  perUpdate = false,
) {
  requireValue(
    isDirect(env) && (perUpdate || (await tokenFor(env))),
    "Configure a autorização Cloudflare para atualizar esta instalação.",
  );
  const old = await settleFormat1Job(env);
  if (activeStatuses.includes(old.status)) return publicState(old);
  // O prazo vale no início; um trabalho já começado segue até o fim. A
  // recusa sai com a mensagem do prazo, como em checkUpdate.
  let index: any;
  try {
    index = validateIndexV2(await checkUpdate(env), now());
  } catch (e) {
    failure(e);
  }
  requireValue(
    data.commit === index.commit && index.commit !== buildInfo.commit,
    "Confira novamente a versão disponível antes de atualizar.",
  );
  // Sem retrocesso: nunca uma versão menor que a instalada, nem a mesma
  // versão com outro código (um índice antigo ou adulterado não faz voltar
  // código sobre um banco já migrado).
  requireValue(
    versionGreater(index.version, buildInfo.version),
    `A versão oficial (${index.version}) não é maior que a instalada (${buildInfo.version}). A atualização não volta de versão.`,
  );
  requireValue(
    versionAtLeast(buildInfo.version, index.requires?.min_version),
    `Esta versão exige a ${index.requires?.min_version} instalada antes. Atualize em etapas.`,
  );
  // Temporários de trabalhos anteriores (falhos ou cancelados) saem antes de
  // começar: um trabalho novo não deixa até 160 MiB para trás.
  await sweepTemporary(env);
  const state = {
    id: uid(),
    index,
    target: index.commit,
    version: index.version,
    previous: buildInfo.commit,
    status: "pending",
    phase: "manifest",
    created: now(),
    updated: now(),
    source,
    attempt: 1,
  };
  await setSecret(env, stateId, state);
  return publicState(state);
}
export async function updatePending(env: Env) {
  return (await secret(env, stateId)).status === "pending";
}

// The existing five-minute cron wakes the installation's _admin coordinator.
// A durable lease also prevents a simultaneous manual command from starting or
// processing the same publication twice after a retry or Worker restart.
export async function automaticUpdateTick(env: Env) {
  if (!(await secret(env, automaticConfigId)).enabled) return;
  return updateLock(
    env,
    async () => {
      const config = {
        ...automaticDefaults,
        ...(await secret(env, automaticConfigId)),
      };
      if (!config.enabled) return;
      const at = now(),
        window = automaticWindow(at, config.hour, config.window_hours);
      const automatic = await secret(env, automaticStateId);
      const save = (patch: Record<string, unknown>) =>
        setSecret(env, automaticStateId, {
          ...automatic,
          ...patch,
          updated_at: at,
        });
      if (!isDirect(env) || !(await tokenFor(env))) {
        await save({
          status: "blocked",
          error:
            "A instalação direta precisa de autorização Cloudflare válida para atualizar.",
        });
        return;
      }
      // A trava já está adquirida; confere só o código realmente em execução.
      await reconcileUpdate(env, (await secret(env, stateId)).id);
      const job = await secret(env, stateId);
      if (activeStatuses.includes(job.status)) {
        await save({
          status: ["sending", "requested", "unknown"].includes(job.status)
            ? "awaiting_confirmation"
            : "running",
          job_id: job.id,
          attempt: job.attempt || 1,
          error: job.error || null,
        });
        return;
      }
      if (job.status === "failed") {
        if (
          job.source !== "automatic" ||
          !job.retryable ||
          (job.attempt || 1) >= 3
        ) {
          await save({
            status: "blocked",
            job_id: job.id,
            attempt: job.attempt || 1,
            error:
              job.error ||
              "A atualização exige revisão antes de uma nova tentativa.",
            retry_at: null,
          });
          return;
        }
        await save({
          status: "retry_wait",
          job_id: job.id,
          attempt: job.attempt || 1,
          error: job.error,
          retry_at: job.retry_at,
        });
        if (!window.open || at < job.retry_at) return;
        // Recomeça na etapa que falhou: o que já foi baixado continua no R2.
        const retry = {
          ...job,
          status: "pending",
          // A sessão de envio de estáticos vence: abre outra (a Cloudflare só
          // pede de novo o que faltou).
          // `assets` e `publish` voltam a `prepare`: a sessão de envio e o
          // token de conclusão valem uma hora, e a nova tentativa pode ficar
          // para a janela do dia seguinte. Sem arquivo faltando, a Cloudflare
          // devolve logo outro token de conclusão.
          phase: ["assets", "publish"].includes(job.phase)
            ? "prepare"
            : job.phase,
          attempt: (job.attempt || 1) + 1,
          error: null,
          retry_at: null,
          retryable: false,
          rounds_without_progress: 0,
          round_progress: undefined,
          updated: at,
        };
        await setSecret(env, stateId, retry);
        await save({
          status: "queued",
          job_id: job.id,
          attempt: retry.attempt,
          error: null,
          retry_at: null,
        });
        return;
      }
      if (!window.open) {
        if (automatic.status !== "scheduled")
          await save({ status: "scheduled", retry_at: null });
        return;
      }
      const sameWindow = automatic.last_window === window.key;
      if (
        sameWindow &&
        (!automatic.check_retry_at ||
          at < automatic.check_retry_at ||
          automatic.check_attempt >= 3)
      )
        return;
      const checkAttempt = sameWindow ? (automatic.check_attempt || 0) + 1 : 1;
      const checkState = {
        last_window: window.key,
        last_checked_at: at,
        check_attempt: checkAttempt,
        check_retry_at: null,
      };
      await save({ ...checkState, status: "checking", error: null });
      try {
        const index = await checkUpdate(env, true);
        if (index.commit === buildInfo.commit) {
          await save({
            ...checkState,
            status: "up_to_date",
            error: null,
            target: index.commit,
          });
        } else if (
          !versionAtLeast(buildInfo.version, index.requires?.min_version)
        ) {
          // Uma versão que exige outra instalada antes (`requires.min_version`)
          // nunca é pulada pelo automático (docs/ATUALIZACOES-FORMATO.md).
          await save({
            ...checkState,
            status: "release_requires_review",
            error: `A versão ${index.version} exige a ${index.requires?.min_version} instalada antes. Atualize em etapas.`,
            target: index.commit,
          });
        } else if (!versionGreater(index.version, buildInfo.version)) {
          await save({
            ...checkState,
            status: "release_requires_review",
            error:
              "A publicação tem versão igual ou anterior à instalada. A atualização automática não faz downgrade nem troca o código de uma versão já publicada.",
            target: index.commit,
          });
        } else {
          const queued = await startDirectUpdate(
            env,
            { commit: index.commit },
            "automatic",
          );
          await save({
            ...checkState,
            status: "queued",
            error: null,
            job_id: queued?.id,
            target: index.commit,
            attempt: 1,
            retry_at: null,
          });
        }
      } catch (error) {
        await save({
          ...checkState,
          status: "check_failed",
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível consultar a versão oficial.",
          check_retry_at:
            checkAttempt < 3 ? at + 300000 * 2 ** (checkAttempt - 1) : null,
        });
      }
    },
    true,
  );
}
export async function processUpdate(env: Env) {
  return updateLock(
    env,
    async () => {
      await settleJobToken(env);
      try {
        await processDirectUpdate(env);
      } finally {
        // Saiu de `pending` nesta rodada: o token do trabalho sai junto.
        await settleJobToken(env);
      }
    },
    true,
  );
}
async function processDirectUpdate(env: Env) {
  const state = await settleFormat1Job(env);
  if (state.status !== "pending") return;
  if (
    state.source === "automatic" &&
    !state.started_at &&
    !(await secret(env, automaticConfigId)).enabled
  ) {
    await setSecret(env, stateId, {
      ...state,
      status: "cancelled",
      updated: now(),
    });
    return;
  }
  state.started_at ||= now();
  // Campos opcionais: o estado deixado pela ponte ainda não os tem.
  const progress = updateProgress(state);
  if (state.round_progress !== progress) {
    state.rounds_without_progress = 0;
    state.last_progress_at =
      state.round_progress === undefined
        ? (state.last_progress_at ?? state.updated ?? state.created ?? now())
        : now();
  }
  if ((state.rounds_without_progress || 0) >= 3) {
    state.status = "failed";
    state.error =
      "A atualização ficou três rodadas seguidas sem avanço. Libere uma nova tentativa e, se persistir, avise o mantenedor.";
    state.retryable = false;
    state.retry_at = null;
    state.updated = now();
    await setSecret(env, stateId, state);
    return;
  }
  state.round_started_at = now();
  state.round_progress = progress;
  state.rounds_without_progress = (state.rounds_without_progress || 0) + 1;
  // Grava antes de qualquer trabalho: até uma queda sem catch deixa recibo.
  await setSecret(env, stateId, state);
  try {
    const token = await tokenFor(env),
      base = scriptPath(env.WABOTIA_ACCOUNT_ID!, env.WABOTIA_WORKER_NAME!);
    // Sem token colado para este trabalho (modo "colar a cada
    // atualização"): não há o que esperar.
    requireValue(
      !!token || (await secret(env, configId)).mode !== PER_UPDATE,
      JOB_TOKEN_EXPIRED,
    );
    await processPhase(env, state, token, base);
    if (updateProgress(state) !== progress) {
      state.round_progress = updateProgress(state);
      state.rounds_without_progress = 0;
      state.last_progress_at = now();
    }
    state.updated = now();
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  } catch (e) {
    const beforeSending = state.status === "pending";
    state.error =
      e instanceof Error ? e.message : "A atualização não foi concluída.";
    state.status =
      state.status === "sending" &&
      (!(e instanceof CloudflareCallError) || e.ambiguous)
        ? "unknown"
        : "failed";
    state.updated = now();
    state.retryable =
      state.source === "automatic" &&
      beforeSending &&
      ["manifest", "blobs", "prepare", "assets", "publish"].includes(
        state.phase,
      ) &&
      (e instanceof CloudflareCallError
        ? e.status === undefined ||
          e.status < 400 ||
          e.status >= 500 ||
          e.status === 429
        : e instanceof TypeError ||
          (e instanceof Error &&
            ["AbortError", "TimeoutError"].includes(e.name)) ||
          /HTTP (429|5\d\d)\b/.test(state.error));
    state.retry_at = state.retryable
      ? now() + 300000 * 2 ** ((state.attempt || 1) - 1)
      : null;
    if ((await secret(env, stateId)).status !== "completed")
      await setSecret(env, stateId, state);
  }
}
/** Só avanço real conta; horários, erros e tentativas não são progresso. */
function updateProgress(state: any) {
  return JSON.stringify([
    state.phase,
    state.blob || 0,
    state.migrations_checked || 0,
    state.bucket || 0,
    !!state.paid_checked,
    state.migration || null,
  ]);
}
export async function resetUpdate(env: Env, actor: Actor, data: any) {
  admin(actor);
  return updateLock(env, () => resetDirectUpdate(env, data));
}
async function resetDirectUpdate(env: Env, data: any) {
  const state = await secret(env, stateId);
  requireValue(
    data.confirmed_build_stopped === true &&
      state.id &&
      state.status !== "completed" &&
      (state.status !== "pending" || stalledPending(state)),
    "Confira a versão e confirme que a publicação anterior terminou.",
  );
  requireValue(
    state.status === "failed" || state.created < now() - 900000,
    "Aguarde a publicação. Não é possível repetir uma operação ainda em andamento.",
  );
  state.status = "cancelled";
  await setSecret(env, stateId, state);
  await settleJobToken(env);
  await dropTemporary(env, state);
  return publicState(state);
}

// ---------------------------------------------------------------------------
// Etapas do formato 2 (docs/ATUALIZACOES-FORMATO.md). Cada chamada faz uma
// rodada curta de uma etapa e grava o andamento; o alarme do _admin chama de
// novo em seguida. Nenhuma rodada lê o pacote inteiro: o manifesto (até
// 2 MiB) e só os arquivos daquela rodada.
//
//   manifest  baixa o manifesto, confere assinatura e SHA; guarda no R2
//   blobs     baixa até 20 arquivos ou 16 MiB por rodada, SHA conferido
//   prepare   confere todas as migrações (20 por rodada), a instalação, e
//             abre a sessão de envio de estáticos
//   assets    envia um lote inteiro da sessão por rodada
//   migrate   sonda o plano pago (uma vez) e aplica uma migração por rodada
//   publish   publica o Worker com os módulos guardados

/** Prefixo dos arquivos temporários de um trabalho no R2. */
export const workPrefix = (id: string) => `system/releases/${id}/`;
const manifestKey = (id: string) => workPrefix(id) + "manifest.json";
const manifestSigKey = (id: string) => workPrefix(id) + "manifest.sig";
const blobKey = (id: string, sha: string) => workPrefix(id) + "b/" + sha;

async function deletePrefix(env: Env, prefix: string, keep?: string) {
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects
      .map((o) => o.key)
      .filter((key) => !keep || !key.startsWith(keep));
    if (keys.length) await env.MEDIA.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Apaga tudo o que o trabalho guardou no R2. */
export async function dropTemporary(env: Env, state: any) {
  if (state.id) await deletePrefix(env, workPrefix(state.id));
  // Trabalho do formato 1 (settleFormat1Job): o pacote inteiro ficava fora do
  // prefixo, em system/releases/<id>.json.
  if (
    typeof state.package_key === "string" &&
    state.package_key.startsWith("system/releases/")
  )
    await env.MEDIA.delete(state.package_key);
}

/**
 * Antes de um trabalho novo, apaga o que sobrou de trabalhos anteriores
 * (falhas, cancelamentos ou limpeza interrompida). Só arquivos temporários
 * de atualização: `system/releases/`.
 */
export async function sweepTemporary(env: Env, keepId?: string) {
  await deletePrefix(
    env,
    "system/releases/",
    keepId ? workPrefix(keepId) : undefined,
  );
}

async function storedManifest(env: Env, state: any) {
  const [stored, signature] = await Promise.all([
    env.MEDIA.get(manifestKey(state.id)),
    env.MEDIA.get(manifestSigKey(state.id)),
  ]);
  requireValue(
    stored && signature,
    "O manifesto temporário não está disponível. Libere uma nova tentativa.",
  );
  // Reconfere a assinatura e o SHA a cada rodada: o R2 não é confiável.
  return parseManifest(
    validateIndexV2(state.index),
    new Uint8Array(await stored!.arrayBuffer()),
    new Uint8Array(await signature!.arrayBuffer()),
  );
}

/** Lê um arquivo já baixado e conferido nesta atualização. */
function blobReader(env: Env, state: any) {
  return async (ref: BlobRef) => {
    const stored = await env.MEDIA.get(blobKey(state.id, ref.sha256));
    requireValue(
      stored,
      "Um arquivo temporário da atualização sumiu. Libere uma nova tentativa.",
    );
    return checkBlob(ref, new Uint8Array(await stored!.arrayBuffer()));
  };
}

/**
 * Sonda do plano Workers Paid: no gratuito, uma invocação faz no máximo 50
 * consultas ao D1 e a 51ª falha. Sessenta `SELECT 1` seguidos só passam no
 * pago. Roda uma vez, antes da primeira migração, e falha sem mexer no banco.
 */
export async function paidPlanProbe(env: Env, queries = 60) {
  try {
    for (let i = 0; i < queries; i++) await env.DB.prepare("SELECT 1").first();
  } catch {
    throw new ApiError(
      409,
      "workers_paid_required",
      "Esta versão exige o plano Workers Paid da Cloudflare. Assine o plano pago e libere uma nova tentativa. Nada foi alterado no banco.",
    );
  }
}

async function processPhase(env: Env, state: any, token: string, base: string) {
  if (state.phase === "manifest") {
    const { manifest, bytes, signature } = await fetchManifest(
      validateIndexV2(state.index),
    );
    await env.MEDIA.put(manifestKey(state.id), bytes, {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MEDIA.put(manifestSigKey(state.id), signature, {
      httpMetadata: { contentType: "application/json" },
    });
    state.blob = 0;
    state.blob_count = uniqueBlobs(manifest).length;
    state.phase = "blobs";
    return;
  }
  const manifest = await storedManifest(env, state);
  if (state.phase === "blobs") {
    const refs = uniqueBlobs(manifest);
    const round = nextRound(refs, state.blob || 0);
    for (const ref of round) {
      // Retomada: o que já está guardado com o tamanho certo não baixa de novo
      // (o SHA é conferido de novo na leitura).
      const head = await env.MEDIA.head(blobKey(state.id, ref.sha256));
      if (head && head.size === ref.size) continue;
      await env.MEDIA.put(blobKey(state.id, ref.sha256), await fetchBlob(ref), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    }
    state.blob = (state.blob || 0) + round.length;
    if (state.blob >= refs.length) state.phase = "prepare";
    return;
  }
  if (state.phase === "prepare") {
    // Todas as migrações são conferidas antes de qualquer uma ser aplicada:
    // uma segunda migração malformada não deixa o banco pela metade.
    // Em rodadas de até 20, para caber nos limites de uma invocação.
    const checked = state.migrations_checked || 0;
    if (checked < manifest.migrations.length) {
      const read = blobReader(env, state);
      const round = nextRound(manifest.migrations, checked);
      for (const migration of round)
        migrationStatements(migration, await read(migration));
      state.migrations_checked = checked + round.length;
      return;
    }
    const settings = await installedSettings(token, base);
    validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
    const upload = await releaseCloudflare(
      token,
      base + "/assets-upload-session",
      "POST",
      { manifest: assetManifestV2(manifest) },
    );
    requireValue(
      typeof upload?.jwt === "string" &&
        Array.isArray(upload.buckets) &&
        upload.buckets.every(
          (b: unknown) => Array.isArray(b) && b.length <= MAX_UPLOAD_BATCH,
        ),
      "Sessão de arquivos inválida.",
    );
    state.upload = upload;
    state.bucket = 0;
    state.phase = upload.buckets.length ? "assets" : "migrate";
    return;
  }
  if (state.phase === "assets") {
    // A Cloudflare pede que cada lote vá inteiro num só envio. Só a
    // resposta do último lote da sessão traz o token de conclusão.
    const bucket = assetsForHashes(
      manifest,
      state.upload.buckets[state.bucket],
    );
    let result;
    try {
      result = await releaseCloudflare(
        state.upload.jwt,
        `/accounts/${env.WABOTIA_ACCOUNT_ID}/workers/assets/upload?base64=true`,
        "POST",
        await assetUploadV2(bucket, blobReader(env, state)),
      );
    } catch (error) {
      if (
        error instanceof CloudflareCallError &&
        (error.status === 401 || error.status === 403) &&
        !(state.upload_session_renewals || 0)
      ) {
        state.upload_session_renewals = 1;
        state.phase = "prepare";
        delete state.upload;
        state.bucket = 0;
        return;
      }
      throw error;
    }
    state.bucket++;
    if (state.bucket === state.upload.buckets.length) {
      requireValue(
        typeof result?.jwt === "string",
        "A Cloudflare não confirmou todos os arquivos. Libere uma nova tentativa.",
      );
      state.upload.jwt = result.jwt;
      state.phase = "migrate";
    }
    return;
  }
  if (state.phase === "migrate") {
    if (state.index.requires?.workers_paid && !state.paid_checked) {
      await paidPlanProbe(env);
      state.paid_checked = true;
      return;
    }
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    ).run();
    const applied = new Set(
      (await all(env, "SELECT name FROM d1_migrations")).map((r) => r.name),
    );
    const migration = manifest.migrations.find((m) => !applied.has(m.name));
    if (!migration) {
      state.phase = "publish";
      return;
    }
    const statements = migrationStatements(
      migration,
      await blobReader(env, state)(migration),
    );
    await env.DB.batch([
      ...statements.map((sql) => env.DB.prepare(sql)),
      env.DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(
        migration.name,
      ),
    ]);
    state.migration = migration.name;
    return;
  }
  if (state.phase === "publish") {
    const settings = await installedSettings(token, base);
    validateInstalledSettings(settings, env.WABOTIA_INSTALLATION_ID!);
    const body = await workerUploadV2(
      manifest,
      settings,
      state.upload.jwt,
      blobReader(env, state),
    );
    state.status = "sending";
    state.updated = now();
    await setSecret(env, stateId, state);
    const result = await releaseCloudflare(token, base, "PUT", body);
    requireValue(
      result?.id || result?.etag,
      "A Cloudflare não confirmou a publicação. Confira a versão antes de repetir.",
    );
    state.status = "requested";
    return;
  }
  throw new Error("Etapa de atualização desconhecida.");
}

export type { ReleaseManifest };
