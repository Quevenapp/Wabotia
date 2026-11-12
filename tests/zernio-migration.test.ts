import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { secret, setSecret } from "../src/security";
import { json, now, uid } from "../src/types";

it("migração Zernio pausa Meta e cancela só pendências confirmadas, preservando histórico e envios ambíguos", async () => {
  const profile = uid(),
    id = uid(),
    conversation = uid(),
    message = uid();
  const config = {
    number: "5511999990000",
    phone_id: "1234567890",
    waba_id: "9876543210",
    verified_at: now(),
    service: { mode: "human" },
    number_policy: { api: false },
  };
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,'Migrar',?)",
    profile,
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Legado','meta','direct','active',?,?)",
    id,
    profile,
    JSON.stringify(config),
    now(),
  );
  await setSecret(env, `connection:${id}`, {
    token: "legacy-token",
    app_secret: "legacy-secret",
  });
  await exec(
    env,
    "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated) VALUES(?,?,?,?,'5511888880000','5511888880000','human',?,?,?,?)",
    conversation,
    profile,
    id,
    `channel:${id}`,
    uid(),
    now(),
    now(),
    now(),
  );
  await exec(
    env,
    "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,external_id,created) VALUES(?,?,?,'inbound','customer','Mensagem histórica','wamid.history',?)",
    message,
    profile,
    conversation,
    now(),
  );
  for (const status of ["pending", "sending", "unknown", "sent"])
    await exec(
      env,
      "INSERT INTO outbox(id,profile_id,connection_id,conversation_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,?,'text','system',?,?,?,?,?)",
      uid(),
      profile,
      id,
      conversation,
      JSON.stringify({ text: status }),
      status,
      uid(),
      now(),
      now(),
    );
  const previousConversation = await one(
    env,
    "SELECT * FROM conversations WHERE id=?",
    conversation,
  );
  const previousMessage = await one(
    env,
    "SELECT * FROM messages WHERE id=?",
    message,
  );
  const previousOutbox = await all(
    env,
    "SELECT * FROM outbox WHERE connection_id=?",
    id,
  );

  // Setup already applied the additive schema. Replay the actual migration's
  // data transitions against representative pre-upgrade rows, without copying SQL.
  const migration = env.TEST_MIGRATIONS.find(
    (item: any) => item.name === "0014_zernio.sql",
  );
  expect(migration).toBeDefined();
  const transitions = migration!.queries.filter((query: string) =>
    /\bUPDATE\s+(connections|outbox)\b/i.test(query),
  );
  expect(transitions).toHaveLength(2);
  await env.DB.batch(transitions.map((query: string) => env.DB.prepare(query)));

  const line = await one(env, "SELECT * FROM connections WHERE id=?", id);
  expect(line).toMatchObject({
    kind: "meta",
    status: "paused",
    profile_id: profile,
  });
  expect(json(line.config)).toEqual({
    ...config,
    migration_required: "zernio",
  });
  expect(
    await one(env, "SELECT * FROM conversations WHERE id=?", conversation),
  ).toEqual(previousConversation);
  expect(await one(env, "SELECT * FROM messages WHERE id=?", message)).toEqual(
    previousMessage,
  );
  expect(await secret(env, `connection:${id}`)).toEqual({
    token: "legacy-token",
    app_secret: "legacy-secret",
  });
  for (const previous of previousOutbox) {
    const delivery = await one(
      env,
      "SELECT * FROM outbox WHERE id=?",
      previous.id,
    );
    if (previous.status === "pending") {
      expect(delivery).toMatchObject({
        ...previous,
        status: "cancelled",
        error:
          "Integração direta Meta removida. Reconecte o telefone pela Zernio.",
      });
    } else expect(delivery).toEqual(previous);
  }
});
