import { exec, one } from "./db";
import { access, admin } from "./security";
import { ApiError, type Actor, type Env, requireValue } from "./types";
import { zernioRequest } from "./zernio";

const objectId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);

const dependencies = `
  EXISTS(SELECT 1 FROM meta_numbers WHERE account_id=?)
  OR EXISTS(
    SELECT 1 FROM connections
    WHERE json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END,'$.zernio_workspace_id')=?
  )
  OR EXISTS(SELECT 1 FROM number_pools WHERE account_id=?)`;

const notFound = () =>
  new ApiError(
    404,
    "not_found",
    "Integração Zernio não encontrada nesta área de atendimento.",
  );
const invalidResponse = () =>
  new ApiError(
    502,
    "zernio_response_invalid",
    "A Zernio retornou uma lista de integrações inválida.",
  );

async function profileOptions(env: Env, conn: any) {
  // The documented unpaginated endpoint returns the complete profile list.
  const result = await zernioRequest(env, conn, "profiles");
  if (!Array.isArray(result.profiles)) throw invalidResponse();
  const options = new Map<string, { id: string; name: string }>();
  for (const item of result.profiles) {
    // Profile's documented identifier is _id, not an arbitrary id alias.
    if (!objectId(item?._id)) throw invalidResponse();
    const name =
      typeof item.name === "string"
        ? item.name
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .trim()
            .slice(0, 100)
        : "";
    options.set(item._id, { id: item._id, name: name || item._id });
  }
  return [...options.values()];
}

async function accountProfile(env: Env, conn: any, current: string) {
  if (!objectId(current)) return { matched: false, profile: null };
  const cursors = new Set<string>();
  let cursor = "";
  do {
    // GET /accounts/{id} is not in Zernio's API. Identify an account through
    // the documented cursor listing, including disconnected WhatsApp accounts.
    const query = new URLSearchParams({ platform: "whatsapp", limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await zernioRequest(env, conn, `accounts?${query}`);
    if (!Array.isArray(result.accounts)) throw invalidResponse();
    for (const item of result.accounts) {
      if (item?._id !== current || item.platform !== "whatsapp") continue;
      const remote =
        typeof item.profileId === "string"
          ? item.profileId
          : item.profileId?._id;
      return { matched: true, profile: objectId(remote) ? remote : null };
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
  return { matched: false, profile: null };
}

/** Resolve with saved credentials; change only after an explicit selection.
 * Run through the area's Coordinator, serialized with imports and pool edits.
 * Every provider request is a read. No provider identity or credential changes.
 */
export async function resolveZernioProfile(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  access(actor, profile, "routing:read");
  admin(actor);
  requireValue(
    typeof data?.id === "string" && data.id,
    "Informe a integração.",
  );
  const account = await one(
    env,
    "SELECT * FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'",
    data.id,
    profile,
  );
  if (!account) throw notFound();
  const applying = data.zernio_profile_id !== undefined;
  if (applying)
    requireValue(
      objectId(data.zernio_profile_id),
      "Selecione um ID de integração confirmado pela Zernio.",
    );
  const current = String(account.zernio_profile_id || "");
  const conn = {
    profile_id: profile,
    config: JSON.stringify({ zernio_workspace_id: account.id }),
  };
  const options = await profileOptions(env, conn);
  const includes = (id: string | null) =>
    id !== null && options.some((option) => option.id === id);

  if (!applying) {
    let suggested_id: string | null = null;
    let matched_by: "current" | "account" | "single" | null = null;
    if (includes(current)) {
      suggested_id = current;
      matched_by = "current";
    } else {
      const linked = await accountProfile(env, conn, current);
      if (includes(linked.profile)) {
        suggested_id = linked.profile;
        matched_by = "account";
      } else if (!linked.matched && options.length === 1) {
        // A known account outside the accessible list must not suggest an
        // unrelated integration just because it is the only visible option.
        suggested_id = options[0].id;
        matched_by = "single";
      }
    }
    return { options, suggested_id, current_id: current, matched_by };
  }

  const selected = data.zernio_profile_id as string;
  requireValue(
    includes(selected),
    "A integração selecionada não está acessível com esta chave API da Zernio.",
  );
  if (selected === current) {
    const fresh = await one(
      env,
      "SELECT zernio_profile_id FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'",
      account.id,
      profile,
    );
    if (!fresh) throw notFound();
    if (fresh.zernio_profile_id === selected)
      return { id: account.id, zernio_profile_id: selected, changed: false };
  }

  // One guarded write protects against dependencies or a conflicting selection
  // appearing after the remote lookup. Preserve the local/webhook ID and keys.
  const result = await exec(
    env,
    `UPDATE meta_accounts SET zernio_profile_id=?,waba_id=?,discovered='[]',discovered_at=0
      WHERE id=? AND profile_id=? AND provider='zernio' AND zernio_profile_id IS ?
      AND NOT (${dependencies})
      AND NOT EXISTS(
        SELECT 1 FROM meta_accounts
        WHERE id!=? AND (waba_id=? OR (provider='zernio' AND lower(zernio_profile_id)=lower(?)))
      )`,
    selected,
    `zernio:${selected}`,
    account.id,
    profile,
    account.zernio_profile_id,
    account.id,
    account.id,
    account.id,
    account.id,
    `zernio:${selected}`,
    selected,
  );
  if (!result.meta.changes) {
    const fresh = await one(
      env,
      "SELECT zernio_profile_id FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'",
      account.id,
      profile,
    );
    if (!fresh) throw notFound();
    if (fresh.zernio_profile_id === selected)
      return { id: account.id, zernio_profile_id: selected, changed: false };
    if (
      await one(
        env,
        "SELECT id FROM meta_accounts WHERE id!=? AND (waba_id=? OR (provider='zernio' AND lower(zernio_profile_id)=lower(?)))",
        account.id,
        `zernio:${selected}`,
        selected,
      )
    )
      throw new ApiError(
        409,
        "integration_already_registered",
        "Esta integração na Zernio já está cadastrada.",
      );
    if (
      (
        await one(
          env,
          `SELECT (${dependencies}) AS in_use`,
          account.id,
          account.id,
          account.id,
        )
      ).in_use
    )
      throw new ApiError(
        409,
        "integration_in_use",
        "O ID não pode ser corrigido enquanto a integração possui telefones ou grupos de distribuição.",
      );
    throw new ApiError(
      409,
      "integration_changed",
      "A integração foi alterada durante a consulta. Identifique o ID novamente.",
    );
  }
  return { id: account.id, zernio_profile_id: selected, changed: true };
}
