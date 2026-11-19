import { all, one, exec } from "./db";
import {
  ApiError,
  type Env,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { putStream } from "./media";
import { zernioAccountList } from "./zernio-accounts";
import { probeZernioChannelAccount } from "./channel-accounts";
import { secret } from "./security";
import { aiProbe } from "./ai-provider";
import type { Actor } from "./types";
import { channelConnectionDriver } from "./channel-extension-registry";
import { channelNotReady } from "./channel-extension-stubs";
import { assertPublicChannelData } from "./channel-extension-kernel";
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
  actor?: Actor,
) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  requireValue(c, "Conexão não encontrada.");
  if (c.kind === "telegram_bot" || c.kind === "email" ||
      (c.kind === "zernio" && (c.channel === "googlebusiness" || c.channel === "tiktok"))) {
    const driver = channelConnectionDriver(c.channel);
    if (!driver) channelNotReady();
    if (!actor || actor.kind !== "user" || actor.via || actor.role !== "admin")
      throw new ApiError(403, "admin_required", "Somente administradores.");
    const result = await driver.probe({ env, actor, profileId: profile, connection: c, input: { origin }, commandId: `probe:${id}`, now: now() });
    assertPublicChannelData(result);
    return { ok: result.status === "active", ...result };
  }
  requireValue(!(await one(env, "SELECT 1 FROM connections WHERE id=? AND kind IN ('hermes','hermes-whatsapp')", id)), "Hermes retirado: escolha um bot interno.");
  const cfg = json(c.config),
    keys = await secret(env, `connection:${id}`);
  let details: any = {};
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
    if (!c.channel || c.channel === "whatsapp") {
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
    } else {
      // O vínculo importado confirma canal/área/conta; identidade social não é telefone.
      details = { ...await probeZernioChannelAccount(env, c), provider: "zernio" };
    }
  }
  if (c.kind === "qr") {
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
