// Links de uso único da conta (docs/API.md, "Login e segundo fator"): o
// administrador gera um link para redefinir a senha de alguém (24 h) ou para
// a pessoa convidada criar a dela (72 h). Só o hash fica guardado; o código
// vai no fragmento da URL (src/install-links.ts, accountLink). Um link novo
// do mesmo tipo invalida o anterior; usar o link troca a senha e derruba as
// sessões da pessoa.
import { exec, one } from "./db";
import { ApiError, type Env, now } from "./types";
import { random, sha } from "./security";
import { accountLink, type AccountLinkPurpose } from "./install-links";
import { publicOrigin } from "./web-steps";

export const TOKEN_TTL_MS: Record<AccountLinkPurpose, number> = {
  reset: 24 * 3600000,
  invite: 72 * 3600000,
};

export async function issueAccountLink(
  env: Env,
  input: {
    userId: string;
    purpose: AccountLinkPurpose;
    createdBy: string;
    origin?: string | null;
  },
) {
  const origin = input.origin || (await publicOrigin(env));
  if (!origin)
    throw new ApiError(
      409,
      "origin_unknown",
      "O endereço público desta instalação ainda não é conhecido. Abra o painel pelo endereço usado pela equipe e tente de novo.",
    );
  await exec(
    env,
    "UPDATE auth_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL",
    now(),
    input.userId,
    input.purpose,
  );
  const token = random();
  const expires = now() + TOKEN_TTL_MS[input.purpose];
  await exec(
    env,
    "INSERT INTO auth_tokens(hash,user_id,purpose,expires,created_by,created) VALUES(?,?,?,?,?,?)",
    await sha(token),
    input.userId,
    input.purpose,
    expires,
    input.createdBy,
    now(),
  );
  return {
    url: accountLink(origin, input.purpose, token),
    expires_at: expires,
  };
}

const shape = /^[a-f0-9]{64}$/;

/** Pessoa e finalidade de um link ainda válido (sem gastar), ou erro 410. */
export async function peekAccountLink(env: Env, token: unknown) {
  const row =
    typeof token === "string" && shape.test(token)
      ? await one(
          env,
          "SELECT t.purpose,t.expires,t.used_at,u.id user_id,u.name,u.email,u.disabled FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=?",
          await sha(token),
        )
      : null;
  if (!row || row.used_at || row.expires <= now() || row.disabled)
    throw new ApiError(
      410,
      "link_invalid",
      "Este link não vale mais. Peça um novo ao administrador.",
    );
  return row;
}

/** Gasta o link (uma vez só) e devolve a pessoa. */
export async function consumeAccountLink(env: Env, token: unknown) {
  const row = await peekAccountLink(env, token);
  const used = await exec(
    env,
    "UPDATE auth_tokens SET used_at=? WHERE hash=? AND used_at IS NULL AND expires>?",
    now(),
    await sha(token as string),
    now(),
  );
  if (!used.meta?.changes)
    throw new ApiError(
      410,
      "link_invalid",
      "Este link não vale mais. Peça um novo ao administrador.",
    );
  return row;
}
