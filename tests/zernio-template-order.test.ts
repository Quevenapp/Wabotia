import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { paidTemplate } from "../src/router-templates";
import { routerCommand } from "../src/number-router";
import { zernioSend } from "../src/zernio";
import { setSecret } from "../src/security";
import { type Actor, now, uid } from "../src/types";

afterEach(() => vi.restoreAllMocks());

it("envia variáveis nomeadas na ordem do modelo ao abrir conversa Zernio", async () => {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,'Templates',?)",
    profile,
    now(),
  );
  const conn = {
    id,
    profile_id: profile,
    kind: "zernio",
    config: JSON.stringify({ account_id: "a".repeat(24) }),
  };
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,config,created) VALUES(?,?,'Zernio','zernio','direct',?,?)",
    id,
    profile,
    conn.config,
    now(),
  );
  await setSecret(env, `connection:${id}`, { api_key: "test-key" });
  const admin: Actor = {
    id: "admin",
    kind: "user",
    role: "admin",
    name: "Admin",
    profiles: [],
    scopes: [],
    bots: [],
    rate: 300,
    runLimit: 3,
  };
  let body: any;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.pathname === "/api/v1/whatsapp/templates")
      return Response.json({
        templates: [
          {
            name: "named_order",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            parameter_format: "NAMED",
            components: [
              { type: "BODY", text: "{{company}} atende {{name}}" },
              {
                type: "HEADER",
                format: "TEXT",
                text: "{{department}} / {{city}}",
              },
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "URL",
                    text: "Consultar",
                    url: "https://example.com/{{1}}",
                  },
                ],
              },
            ],
          },
        ],
      });
    if (request.method === "GET")
      return Response.json({ data: [], pagination: { hasMore: false } });
    body = await request.json();
    return Response.json({
      success: true,
      data: {
        messageId: "wamid.created",
        conversationId: "remote-conversation",
      },
    });
  });
  const payload = await paidTemplate(env, admin, conn, {
    allow_paid: true,
    consent: {
      granted: true,
      category: "utility",
      reference: "Pedido autorizado",
    },
    template: {
      name: "named_order",
      language: "pt_BR",
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", parameter_name: "name", text: "Ana" },
            { type: "text", parameter_name: "company", text: "Acme" },
          ],
        },
        {
          type: "header",
          parameters: [
            { type: "text", parameter_name: "city", text: "Recife" },
            { type: "text", parameter_name: "department", text: "Suporte" },
          ],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "pedido-42" }],
        },
      ],
    },
  });
  expect(await zernioSend(env, conn, "5511999990000", payload, uid())).toBe(
    "wamid.created",
  );
  expect(body.templateParams).toEqual([
    "Suporte",
    "Recife",
    "Acme",
    "Ana",
    "pedido-42",
  ]);
});

it.each([
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])(
  "recusa cabeçalho pago %s antes de reservar cota, vincular cliente ou gravar consentimento",
  async (mime) => {
    const profile = uid(),
      connection = uid(),
      account = uid(),
      media = uid();
    const admin: Actor = {
      id: "admin",
      kind: "user",
      role: "admin",
      name: "Admin",
      profiles: [],
      scopes: [],
      bots: [],
      rate: 300,
      runLimit: 3,
    };
    await exec(
      env,
      "INSERT INTO profiles(id,name,created) VALUES(?,'Mídia paga',?)",
      profile,
      now(),
    );
    await exec(
      env,
      "INSERT INTO meta_accounts(id,profile_id,name,waba_id,provider,created) VALUES(?,?,'Zernio',?,'zernio',?)",
      account,
      profile,
      uid(),
      now(),
    );
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Zernio','zernio','direct','active',?,?)",
      connection,
      profile,
      JSON.stringify({ account_id: "b".repeat(24), number: "5511999990000" }),
      now(),
    );
    await exec(
      env,
      "INSERT INTO meta_numbers(connection_id,account_id,phone_id,baseline_period,monitored_at) VALUES(?,?,?,'2026-11',?)",
      connection,
      account,
      uid(),
      now(),
    );
    await setSecret(env, `connection:${connection}`, { api_key: "test-key" });
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,'documento',?,10,?,'admin',?)",
      media,
      profile,
      mime,
      `${profile}/${media}`,
      now(),
    );
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(new Request(input, init).url).toContain("/whatsapp/templates?");
        return Response.json({
          templates: [
            {
              name: "documento",
              language: "pt_BR",
              category: "UTILITY",
              status: "APPROVED",
              components: [
                { type: "HEADER", format: "DOCUMENT" },
                { type: "BODY", text: "Seu documento" },
              ],
            },
          ],
        });
      });
    await expect(
      routerCommand(
        env,
        admin,
        profile,
        "router.send",
        {
          number_id: connection,
          to: "5511888880000",
          external_id: uid(),
          allow_paid: true,
          consent: {
            granted: true,
            category: "utility",
            reference: "Pedido autorizado",
          },
          template: {
            name: "documento",
            language: "pt_BR",
            components: [
              {
                type: "header",
                parameters: [{ type: "document", media_id: media }],
              },
            ],
          },
        },
        uid(),
      ),
    ).rejects.toThrow(/cabeçalho de um template Zernio/);
    expect(mock).toHaveBeenCalledTimes(1);
    for (const table of [
      "outbox",
      "conversations",
      "consents",
      "router_affinities",
    ])
      expect(
        (
          await one(
            env,
            `SELECT count(*) AS n FROM ${table} WHERE profile_id=?`,
            profile,
          )
        ).n,
      ).toBe(0);
  },
);
