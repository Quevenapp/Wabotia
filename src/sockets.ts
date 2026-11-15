// WebSockets da fila (painel da equipe, Senhapp, aparelho pareado, TV) levam
// a credencial que os abriu como tags no Coordinator da área. Ao revogar a
// credencial, o Worker fecha esses sockets na hora (código 4401), sem esperar
// o 401 da próxima leitura.
import { all, one } from "./db";
import { json, type Actor, type Env } from "./types";
import { MOBILE_TOKEN_PREFIX, sha } from "./security";

/** Fechamento por credencial revogada (o app volta para a tela de login). */
export const REVOKED_CLOSE = { code: 4401, reason: "Credencial revogada" };

/** Tags da credencial da requisição: pessoa (sessão) ou aplicação (chave). */
export async function credentialTags(request: Request, actor: Actor) {
  if (actor.kind === "app")
    return [
      `app:${actor.id.replace(/^app:/, "")}`,
      ...(actor.keyId ? [`key:${actor.keyId}`] : []),
    ];
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  const cookie = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)wabotia=([^;]+)/)?.[1];
  const token = bearer?.startsWith(MOBILE_TOKEN_PREFIX) ? bearer : cookie;
  return [
    `user:${actor.id}`,
    ...(token ? [`session:${await sha(token)}`] : []),
  ];
}

/** Fecha, nas áreas dadas, os sockets com qualquer uma das tags. */
export async function closeSockets(
  env: Env,
  profiles: string[],
  tags: string[],
) {
  if (!profiles.length || !tags.length) return;
  await Promise.all(
    [...new Set(profiles)].map((profile) =>
      env.COORDINATOR.get(env.COORDINATOR.idFromName(profile))
        .fetch("https://coordinator/close-sockets", {
          method: "POST",
          body: JSON.stringify({ profile, tags }),
        })
        .catch(() => null),
    ),
  );
}

/** Áreas que uma pessoa alcança (administrador: todas). */
export async function userProfiles(env: Env, userId: string) {
  const user = await one(
    env,
    "SELECT role,profiles FROM users WHERE id=?",
    userId,
  );
  if (!user) return [];
  if (user.role === "admin")
    return (await all(env, "SELECT id FROM profiles")).map((p) => p.id);
  return json(user.profiles, []) as string[];
}

/** Áreas de uma aplicação (chave de integração ou aparelho pareado). */
export async function appProfiles(env: Env, appId: string) {
  const app = await one(
    env,
    "SELECT profiles FROM applications WHERE id=?",
    appId,
  );
  return app ? (json(app.profiles, []) as string[]) : [];
}
