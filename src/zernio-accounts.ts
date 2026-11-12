import { one, exec, batch } from "./db";
import { Env, Actor, ApiError, json, requireValue, uid, now } from "./types";
import { access, admin, secret, setSecret } from "./security";
import { zernioRequest } from "./zernio";
import { billingPeriod, numberUsage } from "./number-quota";

const objectId = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

/** Return only the identity and display fields needed by the operator. */
export function zernioAccountIdentity(item: any, profileId: string) {
  const profile =
    typeof item.profileId === "object" ? item.profileId?._id : item.profileId;
  if (
    item.platform !== "whatsapp" ||
    profile !== profileId ||
    !objectId(item._id) ||
    item.isActive === false ||
    item.needsReconnect === true
  )
    return null;
  const number = String(
    item.metadata?.displayPhoneNumber || item.username || "",
  ).replace(/\D/g, "");
  if (!/^\d{8,16}$/.test(number)) return null;
  return {
    account_id: item._id,
    phone_id: item._id,
    number,
    name: String(
      item.displayName || item.metadata?.verifiedName || number,
    ).slice(0, 100),
    quality: String(item.metadata?.qualityRating || "UNKNOWN"),
  };
}

export async function zernioAccountList(
  env: Env,
  conn: any,
  profileId: string,
) {
  requireValue(
    objectId(profileId),
    "Informe o ID da integração na Zernio (24 caracteres).",
  );
  const found: any[] = [],
    cursors = new Set<string>();
  let cursor = "";
  do {
    const query = new URLSearchParams({
      profileId,
      platform: "whatsapp",
      status: "connected",
      limit: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const result = await zernioRequest(env, conn, `accounts?${query}`);
    requireValue(
      Array.isArray(result.accounts),
      "A Zernio não retornou a lista de telefones.",
    );
    for (const item of result.accounts) {
      const identity = zernioAccountIdentity(item, profileId);
      if (identity && !found.some((n) => n.account_id === identity.account_id))
        found.push(identity);
    }
    const next = result.pagination?.nextCursor;
    if (next == null) break;
    requireValue(
      typeof next === "string" &&
        next &&
        !cursors.has(next) &&
        cursors.size < 100,
      "Paginação Zernio inválida.",
    );
    cursors.add(next);
    cursor = next;
  } while (cursor);
  return found;
}

export async function zernioAccountCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
) {
  access(actor, profile, "routing:read");
  admin(actor);
  if (op === "zernio-account.save") {
    const id = data.id || uid();
    const old = await one(env, "SELECT * FROM meta_accounts WHERE id=?", id);
    requireValue(
      !old || (old.profile_id === profile && old.provider === "zernio"),
      "Integração de outra área de atendimento ou da conexão antiga.",
    );
    const name = String(data.name || "").trim(),
      remote = data.zernio_profile_id || old?.zernio_profile_id || null;
    requireValue(
      name.length > 0 && name.length <= 100,
      "Informe o nome da integração.",
    );
    requireValue(
      remote === null || objectId(remote),
      "Informe o ID da integração na Zernio (24 caracteres).",
    );
    requireValue(
      !old || old.zernio_profile_id === remote,
      "O ID da integração na Zernio não pode ser alterado após o cadastro.",
    );
    requireValue(
      !(await one(
        env,
        "SELECT id FROM meta_accounts WHERE provider='zernio' AND zernio_profile_id=? AND id!=?",
        remote,
        id,
      )),
      "Esta integração na Zernio já está cadastrada.",
    );
    const timezone = String(
      data.timezone || old?.timezone || "America/Sao_Paulo",
    );
    try {
      billingPeriod(now(), timezone);
    } catch {
      throw new ApiError(
        400,
        "invalid_timezone",
        "Informe um fuso IANA válido.",
      );
    }
    requireValue(
      !old ||
        old.timezone === timezone ||
        !(await one(
          env,
          "SELECT connection_id FROM meta_numbers WHERE account_id=? LIMIT 1",
          id,
        )),
      "Defina o fuso antes de cadastrar números.",
    );
    const previous = await secret(env, `zernio-account:${id}`);
    const keys = { ...previous };
    for (const key of ["api_key", "webhook_secret"]) {
      if (data.secrets?.[key]) {
        requireValue(
          typeof data.secrets[key] === "string" &&
            data.secrets[key].length <= 4096 &&
            !/[\r\n]/.test(data.secrets[key]),
          "Credencial inválida.",
        );
        keys[key] = data.secrets[key];
      }
      requireValue(
        keys[key],
        "Preencha a chave API e o segredo do webhook Zernio.",
      );
    }
    const changed =
      keys.api_key !== previous.api_key ||
      keys.webhook_secret !== previous.webhook_secret;
    if (old && changed)
      requireValue(
        !(await one(
          env,
          "SELECT o.id FROM outbox o JOIN meta_numbers n ON n.connection_id=o.connection_id WHERE n.account_id=? AND o.status IN ('pending','sending','unknown') LIMIT 1",
          id,
        )),
        "Reconcilie as entregas antes de alterar as credenciais da integração.",
      );
    if (old && changed)
      requireValue(
        !(await one(
          env,
          "SELECT g.id FROM group_operations g JOIN meta_numbers n ON n.connection_id=g.connection_id WHERE n.account_id=? AND g.status IN ('pending','sending','unknown') LIMIT 1",
          id,
        )),
        "Reconcilie as operações de grupos antes de alterar as credenciais da integração.",
      );
    await exec(
      env,
      "INSERT INTO meta_accounts(id,profile_id,name,waba_id,timezone,created,provider,zernio_profile_id) VALUES(?,?,?,?,?,?,'zernio',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,timezone=excluded.timezone,discovered_at=0",
      id,
      profile,
      name,
      remote ? `zernio:${remote}` : `zernio-pending:${id}`,
      timezone,
      now(),
      remote,
    );
    await setSecret(env, `zernio-account:${id}`, keys);
    // Revalidation is required after credential changes.
    if (changed)
      await exec(
        env,
        "UPDATE connections SET status='paused',config=json_remove(config,'$.verified_at') WHERE json_extract(config,'$.zernio_workspace_id')=?",
        id,
      );
    return { id, webhook_path: `/webhooks/zernio-accounts/${id}` };
  }
  const account = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'",
    data.account_id || data.id,
    profile,
  );
  requireValue(
    account,
    "Integração Zernio não encontrada. Cadastre uma integração Zernio para substituir a integração antiga.",
  );
  const conn = {
    profile_id: profile,
    config: JSON.stringify({ zernio_workspace_id: account.id }),
  };
  if (op === "zernio-account.connect" || op === "zernio-account.discover")
    requireValue(
      objectId(account.zernio_profile_id),
      "Use Encontrar ID na Zernio primeiro para identificar esta integração.",
    );
  if (op === "zernio-account.connect") {
    requireValue(typeof data.origin === "string", "Origem do painel ausente.");
    const query = new URLSearchParams({
      profileId: account.zernio_profile_id,
      redirect_url: `${data.origin}/app`,
      onboarding: "api",
    });
    const result = await zernioRequest(env, conn, `connect/whatsapp?${query}`);
    let url: URL;
    try {
      url = new URL(result.authUrl);
    } catch {
      throw new ApiError(
        502,
        "invalid_connect_url",
        "A Zernio não retornou um endereço de conexão válido.",
      );
    }
    requireValue(
      url.protocol === "https:" && !url.username && !url.password,
      "Endereço de conexão inválido.",
    );
    return { authUrl: url.toString() };
  }
  if (op === "zernio-account.discover") {
    const found = await zernioAccountList(env, conn, account.zernio_profile_id);
    await exec(
      env,
      "UPDATE meta_accounts SET discovered=?,discovered_at=? WHERE id=?",
      JSON.stringify(found),
      now(),
      account.id,
    );
    return { data: found };
  }
  if (op === "zernio-number.save") {
    requireValue(
      now() - account.discovered_at < 3600000,
      "Clique em Buscar números antes de cadastrar.",
    );
    const remote = data.accountId || data.phone_id;
    requireValue(objectId(remote), "Informe o ID do telefone na Zernio.");
    const found = json(account.discovered, []).find(
      (n: any) => n.account_id === remote,
    );
    requireValue(found, "Telefone não encontrado nesta integração Zernio.");
    requireValue(
      !(await one(
        env,
        "SELECT id FROM connections WHERE kind='zernio' AND json_extract(config,'$.account_id')=?",
        remote,
      )),
      "Este número já está cadastrado.",
    );
    requireValue(
      !(await one(
        env,
        "SELECT id FROM connections WHERE json_extract(config,'$.number')=? AND (status='active' OR EXISTS(SELECT 1 FROM outbox o WHERE o.connection_id=connections.id AND o.status IN ('pending','sending','unknown')))",
        found.number,
      )),
      "Pause a conexão anterior deste telefone e reconcilie as entregas antes de cadastrar.",
    );
    requireValue(
      data.baseline_confirmed === true,
      "Confira o contador inicial antes de cadastrar.",
    );
    const baseline = Number(data.baseline_used ?? 0),
      limit = Number(data.service_limit ?? 1000);
    requireValue(
      Number.isSafeInteger(baseline) && baseline >= 0 && baseline <= 100000000,
      "Uso inicial inválido.",
    );
    requireValue(
      Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000,
      "O limite local deve estar entre 0 e 1.000 mensagens.",
    );
    const id = uid(),
      created = now();
    const config = {
      account_id: remote,
      zernio_profile_id: account.zernio_profile_id,
      zernio_workspace_id: account.id,
      number: found.number,
      verified_at: created,
    };
    await batch(env, [
      [
        "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','paused',?,?)",
        [
          id,
          profile,
          String(data.name || found.name || found.number).slice(0, 100),
          JSON.stringify(config),
          created,
        ],
      ],
      [
        "INSERT INTO meta_numbers(connection_id,account_id,phone_id,service_limit,baseline_period,baseline_used,monitored_at) VALUES(?,?,?,?,?,?,?)",
        [
          id,
          account.id,
          remote,
          limit,
          billingPeriod(created, account.timezone),
          baseline,
          created,
        ],
      ],
    ]);
    return { id, status: "paused", usage: await numberUsage(env, id) };
  }
  throw new ApiError(400, "unknown_action", "Operação Zernio inválida.");
}
