import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { authenticate, setSecret } from "../src/security";
import { processRun } from "../src/engine";
import { perform } from "../src/service";
import { boundAllows, isBound } from "../src/visibility";
import { now, uid } from "../src/types";
import {
  api,
  application,
  bearer,
  bot,
  fixture,
  receive,
  quietCoordinator,
} from "./service-center-fixture";

afterEach(() => vi.unstubAllGlobals());
const internal = ["conversations:bound", "conversations:all"];

describe("escopos internos não são credenciais de API", () => {
  it.each(internal)(
    "recusa emitir e editar aplicação ou chave com %s",
    async (scope) => {
      const f = await fixture();
      const token = await bearer(f.admin);
      const response = await api(token, "/applications", "POST", {
        name: "Integração",
        profiles: [f.profile],
        scopes: [scope, "conversations:read"],
      });
      expect(response.status).toBe(400);
      expect((await response.json<any>()).error.code).toBe("scope_internal");
      const app = await application(f, ["conversations:read"]);
      const edited = await api(token, `/applications/${app.id}`, "PATCH", {
        scopes: [scope, "conversations:read"],
      });
      expect(edited.status).toBe(400);
      expect((await edited.json<any>()).error.code).toBe("scope_internal");
      const key = await api(token, `/applications/${app.id}/keys`, "POST", {
        scopes: [scope],
      });
      expect(key.status).toBe(400);
      expect((await key.json<any>()).error.code).toBe("scope_internal");
      expect(
        JSON.parse(
          (await one(env, "SELECT scopes FROM applications WHERE id=?", app.id))
            .scopes,
        ),
      ).toEqual(["conversations:read"]);
    },
  );

  it.each(
    [[], ["conversations:bound"], ["conversations:all"], internal].map(
      (legacy) => ({ legacy }),
    ),
  )(
    "chave antiga ignora $legacy e segue as permissões comuns, sem vínculo por bot",
    async ({ legacy }) => {
      const f = await fixture();
      const botId = await bot(f);
      // application insere a linha diretamente por SQL: simula uma instalação antiga.
      const app = await application(f, [...legacy, "conversations:read"]);
      await exec(
        env,
        "UPDATE applications SET bots=? WHERE id=?",
        JSON.stringify([botId]),
        app.id,
      );
      const owned = await receive(f, f.line, "oi", "5511970000001");
      const unrelated = await receive(f, f.line, "oi", "5511970000002");
      await exec(
        env,
        "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,input,created,updated) VALUES(?,?,?,?,?,'oi',?,?)",
        uid(),
        f.profile,
        botId,
        app.id,
        owned.id,
        now(),
        now(),
      );
      const actor = await authenticate(
        env,
        new Request("https://test/api/v1/profiles", {
          headers: { Authorization: "Bearer " + app.token },
        }),
      );
      expect(actor.scopes).toEqual(["conversations:read"]);
      expect(isBound(actor)).toBe(false);
      expect(await boundAllows(env, actor, owned)).toBe(true);
      expect(await boundAllows(env, actor, unrelated)).toBe(true);
      // Listagem e leitura permitidas por conversations:read, inclusive fora do bot.
      const list = await api(app.token, `/profiles/${f.profile}/conversations`);
      expect(list.status).toBe(200);
      expect((await list.json<any>()).data.map((row: any) => row.id)).toEqual(
        expect.arrayContaining([owned.id, unrelated.id]),
      );
      expect(
        (
          await api(
            app.token,
            `/profiles/${f.profile}/conversations/${unrelated.id}`,
          )
        ).status,
      ).toBe(200);
      // O bot não dá permissão de escrita à chave.
      expect(
        (
          await api(
            app.token,
            `/profiles/${f.profile}/conversations/${owned.id}/actions`,
            "POST",
            { action: "claim" },
          )
        ).status,
      ).toBe(403);
      // Nem cabeçalhos do protocolo removido fabricam ator interno.
      const forged = await SELF.fetch(
        `https://test/api/v1/profiles/${f.profile}/conversations/${owned.id}/actions`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + app.token,
            "Content-Type": "application/json",
            "Idempotency-Key": uid(),
            "X-Wabotia-Run": "execucao.assinatura-falsa",
            "X-Wabotia-Internal-Actor": uid(),
          },
          body: JSON.stringify({ action: "claim" }),
        },
      );
      expect(forged.status).toBe(403);
    },
  );
});

it("run.create pela API executa o bot interno com o provedor simulado", async () => {
  const f = await fixture();
  const botId = await bot(f);
  const connection = (
    await one(env, "SELECT connection_id FROM bots WHERE id=?", botId)
  ).connection_id;
  await setSecret(env, "connection:" + connection, {
    api_key: "test-provider-key",
  });
  const app = await perform(
    env,
    f.admin,
    f.profile,
    "application.create",
    {
      name: "Executor",
      profiles: [f.profile],
      scopes: ["bots:invoke"],
      bots: [botId],
    },
    uid(),
  );
  const key = await perform(
    env,
    f.admin,
    f.profile,
    "key.create",
    { app_id: app.id },
    uid(),
  );
  const provider = vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(init.body)).messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user" })]),
    );
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "Resposta do provedor simulado." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  vi.stubGlobal("fetch", provider);
  const created = await api(key.token, "/bot-runs", "POST", {
    profile_id: f.profile,
    bot_id: botId,
    input: "Responda ao teste.",
  });
  expect(created.status).toBe(202);
  const run = await created.json<any>();
  await quietCoordinator(f.profile);
  await processRun(
    env,
    await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id),
  );
  const done = await one(
    env,
    "SELECT status,result,completion_handled,phase FROM bot_runs WHERE id=?",
    run.id,
  );
  // completed é o estado de sucesso do contrato atual da API.
  expect(done).toEqual({
    status: "completed",
    result: "Resposta do provedor simulado.",
    completion_handled: 1,
    phase: "direct",
  });
  expect(provider).toHaveBeenCalledTimes(1);
  const read = await api(key.token, "/bot-runs/" + run.id);
  expect(read.status).toBe(200);
  expect(await read.json<any>()).toMatchObject({
    status: "completed",
    result: "Resposta do provedor simulado.",
  });
});
