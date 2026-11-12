import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { hmac, setSecret } from "../src/security";
import { defaults, now, uid } from "../src/types";
import { syncGroup } from "../src/whatsapp";
import {
  zernioCredentials,
  zernioInbound,
  zernioRememberConversation,
  zernioRequest,
  zernioSend,
  zernioUpload,
  verifyZernioWebhook,
} from "../src/zernio";

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Zernio",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    id,
    profile,
    "WhatsApp",
    JSON.stringify({
      account_id: "remote-account",
      platform: "whatsapp_cloud",
    }),
    now(),
  );
  await setSecret(env, `connection:${id}`, {
    api_key: "zernio-test-key",
    webhook_secret: "webhook-test-key",
  });
  return one(env, "SELECT * FROM connections WHERE id=?", id);
}

function inbound() {
  return {
    id: "event-1",
    event: "message.received",
    account: { accountId: "remote-account", platform: "whatsapp" },
    conversation: { id: "remote-thread", participantId: "5511999991111" },
    message: {
      id: "message-1",
      conversationId: "remote-thread",
      platform: "whatsapp",
      platformMessageId: "wamid.inbound",
      direction: "incoming",
      text: "Olá",
      sender: {
        id: "5511999991111",
        phoneNumber: "+5511999991111",
        name: "Cliente",
      },
      attachments: [],
      sentAt: "2026-11-10T15:00:00.000Z",
    },
    timestamp: "2026-11-10T15:00:01.000Z",
  };
}

it("authenticates to the fixed Zernio origin using Workers-supported fetch options", async () => {
  const conn = await seed();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://zernio.com/api/v1/accounts");
      expect(request.headers.get("Authorization")).toBe(
        "Bearer zernio-test-key",
      );
      expect(request.redirect).toBe("manual");
      return Response.json({ accounts: [] });
    });
  await expect(zernioRequest(env, conn, "accounts")).resolves.toEqual({
    accounts: [],
  });
  await expect(
    zernioRequest(env, conn, "https://evil.example/accounts"),
  ).rejects.toBeDefined();
  await expect(
    zernioRequest(env, conn, "../../../accounts"),
  ).rejects.toBeDefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects a credential redirect and never repeats an ambiguous write", async () => {
  const conn = await seed();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example/" },
    }),
  );
  await expect(zernioRequest(env, conn, "accounts")).rejects.toMatchObject({
    code: "zernio_rejected",
  });
  fetch.mockRejectedValue(new Error("timeout"));
  await expect(
    zernioRequest(env, conn, "inbox/conversations", "POST", {}),
  ).rejects.toMatchObject({ code: "zernio_unknown" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("checks workspace ownership before reading shared provider credentials", async () => {
  const conn = await seed();
  await expect(
    zernioCredentials(env, {
      ...conn,
      config: JSON.stringify({ zernio_workspace_id: "another-profile" }),
    }),
  ).rejects.toThrow("não pertence");
});

it("verifies the raw body HMAC and rejects tampering, empty secrets and Meta signatures", async () => {
  const body = JSON.stringify(inbound()),
    signature = await hmac("test-secret", body);
  expect(await verifyZernioWebhook("test-secret", body, signature)).toBe(true);
  expect(await verifyZernioWebhook("test-secret", body + " ", signature)).toBe(
    false,
  );
  expect(
    await verifyZernioWebhook("test-secret", body, `sha256=${signature}`),
  ).toBe(false);
  expect(await verifyZernioWebhook("", body, signature)).toBe(false);
  expect(await verifyZernioWebhook("test-secret", body, null)).toBe(false);
});

it("maps incoming messages and provider delivery IDs without treating outgoing events as customer messages", async () => {
  const conn = await seed(),
    dispatch = vi.fn(async () => Response.json({ ok: true }));
  await zernioInbound(env, conn, inbound(), dispatch);
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      external_id: "5511999991111",
      phone: "5511999991111",
      message_id: "wamid.inbound",
      text: "Olá",
      customer_at: Date.parse("2026-11-10T15:00:00.000Z"),
    }),
  );
  expect(
    await one(
      env,
      "SELECT conversation_id FROM zernio_conversations WHERE connection_id=?",
      conn.id,
    ),
  ).toEqual({ conversation_id: "remote-thread" });
  await zernioInbound(
    env,
    conn,
    {
      ...inbound(),
      event: "message.read",
      statusAt: "2026-11-10T15:03:00.000Z",
    },
    dispatch,
  );
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: "status",
      message_id: "wamid.inbound",
      status: "read",
    }),
  );
});

it("ignores other accounts, sandbox samples and standby messages", async () => {
  const conn = await seed(),
    dispatch = vi.fn(async () => Response.json({ ok: true }));
  await zernioInbound(
    env,
    conn,
    {
      ...inbound(),
      account: { accountId: "someone-else", platform: "whatsapp" },
    },
    dispatch,
  );
  await zernioInbound(env, conn, { ...inbound(), test: true }, dispatch);
  await zernioInbound(
    env,
    conn,
    { ...inbound(), metadata: { standby: true } },
    dispatch,
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it("keeps synchronized group identity separate from the participant and replies in the same provider thread", async () => {
  const conn = await seed(),
    payload: any = inbound();
  await syncGroup(env, conn, {
    external_id: "120363418596621542",
    subject: "Equipe",
  });
  payload.conversation.platformConversationId = "120363418596621542";
  const dispatch = vi.fn(async () => Response.json({ ok: true }));
  await zernioInbound(env, conn, payload, dispatch);
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      external_id: "120363418596621542",
      chat_type: "group",
      phone: null,
      content: expect.objectContaining({ participant: "5511999991111" }),
    }),
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(new Request(input, init).url).toBe(
        "https://zernio.com/api/v1/inbox/conversations/remote-thread/messages",
      );
      return Response.json({ data: { messageId: "wamid.group" } });
    });
  await expect(
    zernioSend(env, conn, "120363418596621542", {
      text: "Olá grupo",
      chat_type: "group",
    }),
  ).resolves.toBe("wamid.group");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("accepts the legacy account id but rejects events naming a different provider profile", async () => {
  const conn = await seed(),
    payload: any = inbound();
  conn.config = JSON.stringify({
    account_id: "remote-account",
    zernio_profile_id: "my-profile",
  });
  payload.account = {
    id: "remote-account",
    platform: "whatsapp",
    profileId: "someone-else",
  };
  const dispatch = vi.fn(async () => Response.json({ ok: true }));
  await zernioInbound(env, conn, payload, dispatch);
  expect(dispatch).not.toHaveBeenCalled();
  payload.account.profileId = "my-profile";
  await zernioInbound(env, conn, payload, dispatch);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("does not re-download an inbound message already accepted into the inbox", async () => {
  const conn = await seed(),
    dispatch = vi.fn(async () => Response.json({ ok: true }));
  await exec(
    env,
    "INSERT INTO inbox(id,profile_id,event_key,payload,created) VALUES(?,?,?,?,?)",
    uid(),
    conn.profile_id,
    `${conn.profile_id}:channel:${conn.id}:5511999991111:wamid.inbound`,
    "{}",
    now(),
  );
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await zernioInbound(env, conn, inbound(), dispatch);
  expect(await result.json()).toMatchObject({ duplicate: true });
  expect(dispatch).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("replies via the provider conversation id with an idempotency key and native reply buttons", async () => {
  const conn = await seed();
  await zernioRememberConversation(env, conn, "5511999991111", "thread/id");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://zernio.com/api/v1/inbox/conversations/thread%2Fid/messages",
      );
      expect(request.headers.get("Idempotency-Key")).toBe("delivery-1");
      expect(await request.json()).toEqual({
        accountId: "remote-account",
        message: "Escolha",
        buttons: [{ type: "postback", title: "Ajuda", payload: "help" }],
        replyTo: "wamid.quoted",
      });
      return Response.json({
        success: true,
        data: { messageId: "wamid.sent" },
      });
    });
  await expect(
    zernioSend(
      env,
      conn,
      "5511999991111",
      {
        content: {
          type: "interactive",
          reply_external_id: "wamid.quoted",
          interactive: {
            type: "button",
            body: { text: "Escolha" },
            action: { buttons: [{ reply: { id: "help", title: "Ajuda" } }] },
          },
        },
      },
      "delivery-1",
    ),
  ).resolves.toBe("wamid.sent");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("opens new conversations with templates and remembers the returned thread", async () => {
  const conn = await seed();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET")
        return Response.json({ data: [], pagination: { hasMore: false } });
      expect(await request.json()).toEqual({
        accountId: "remote-account",
        participantId: "5511999991111",
        templateName: "status",
        templateLanguage: "pt_BR",
        templateParams: ["123"],
      });
      return Response.json({
        success: true,
        data: { conversationId: "opened-thread", messageId: "wamid.opened" },
      });
    });
  await expect(
    zernioSend(env, conn, "5511999991111", {
      template_message: {
        template: {
          name: "status",
          language: { code: "pt_BR" },
          components: [
            { type: "body", parameters: [{ type: "text", text: "123" }] },
          ],
        },
      },
    }),
  ).resolves.toBe("wamid.opened");
  expect(
    await one(
      env,
      "SELECT conversation_id FROM zernio_conversations WHERE connection_id=?",
      conn.id,
    ),
  ).toEqual({ conversation_id: "opened-thread" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not start a free-form conversation or resend after missing confirmation", async () => {
  const conn = await seed();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ data: [], pagination: { hasMore: false } }),
    );
  await expect(
    zernioSend(env, conn, "5511999991111", { text: "Oi" }),
  ).rejects.toThrow("template aprovado");
  expect(fetch).toHaveBeenCalledTimes(1);
  await zernioRememberConversation(env, conn, "5511999991111", "thread");
  fetch.mockResolvedValue(Response.json({ success: true, data: {} }));
  await expect(
    zernioSend(env, conn, "5511999991111", { text: "Oi" }),
  ).rejects.toMatchObject({ code: "zernio_unknown" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("uploads media with a presigned URL without forwarding the API key to storage", async () => {
  const conn = await seed(),
    id = uid(),
    key = `${conn.profile_id}/${id}`;
  await env.MEDIA.put(key, "test-pdf");
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    conn.profile_id,
    "teste.pdf",
    "application/pdf",
    8,
    key,
    "test",
    now(),
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/media/presign")) {
        expect(await request.json()).toEqual({
          filename: "teste.pdf",
          contentType: "application/pdf",
          size: 8,
        });
        return Response.json({
          uploadUrl: "https://storage.example.com/upload?signature=opaque",
          publicUrl: "https://storage.example.com/teste.pdf",
        });
      }
      expect(request.method).toBe("PUT");
      expect(request.headers.has("Authorization")).toBe(false);
      expect(request.redirect).toBe("manual");
      expect(new TextDecoder().decode(await request.arrayBuffer())).toBe(
        "test-pdf",
      );
      return new Response(null, { status: 200 });
    });
  await expect(zernioUpload(env, conn, id, "document")).resolves.toEqual({
    url: "https://storage.example.com/teste.pdf",
    name: "teste.pdf",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("downloads inbound WhatsApp media only from the authenticated Zernio endpoint", async () => {
  const conn = await seed(),
    payload: any = inbound();
  payload.message.attachments = [
    {
      type: "file",
      mimeType: "application/pdf",
      url: "https://evil.example/api/v1/whatsapp/media/123",
    },
  ];
  const dispatch = vi.fn(async () => Response.json({ ok: true }));
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://zernio.com/api/v1/whatsapp/media/123?accountId=remote-account",
      );
      expect(request.headers.get("Authorization")).toBe(
        "Bearer zernio-test-key",
      );
      expect(request.redirect).toBe("manual");
      return new Response("pdf", {
        headers: { "Content-Type": "application/pdf" },
      });
    });
  await zernioInbound(env, conn, payload, dispatch);
  expect(fetch).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      content: expect.objectContaining({ media_error: true }),
    }),
  );
  payload.message.attachments[0].url =
    "https://zernio.com/api/v1/whatsapp/media/123?accountId=another-account";
  await zernioInbound(env, conn, payload, dispatch);
  expect(fetch).not.toHaveBeenCalled();
  payload.message.attachments[0].url =
    "https://zernio.com/api/v1/whatsapp/media/123";
  await zernioInbound(env, conn, payload, dispatch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    await all(env, "SELECT id FROM media WHERE profile_id=?", conn.profile_id),
  ).toHaveLength(1);
});

it("expires a new template after a slow conversation lookup without posting it", async () => {
  const conn = await seed(),
    expires = now() + 1000;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    vi.spyOn(Date, "now").mockReturnValue(expires + 1);
    return Response.json({ data: [], pagination: { hasMore: false } });
  });
  await expect(
    zernioSend(env, conn, "5511999991111", {
      expires_at: expires,
      template: { name: "update", language: "pt_BR", components: [] },
    }),
  ).rejects.toMatchObject({ code: "message_expired" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses the stored quoted message id and keeps the thread identity when the provider switches to BSUID", async () => {
  const conn = await seed(),
    dispatch = vi.fn(async () => Response.json({ ok: true }));
  await zernioRememberConversation(env, conn, "5511999991111", "remote-thread");
  const payload: any = inbound();
  payload.conversation.participantId = "business-scoped-user";
  payload.message.sender = {
    id: "business-scoped-user",
    businessScopedUserId: "business-scoped-user",
  };
  payload.metadata = {
    quotedMessageId: "perspective-wamid",
    quotedMessage: { platformMessageId: "stored-wamid" },
  };
  await zernioInbound(env, conn, payload, dispatch);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      external_id: "5511999991111",
      phone: null,
      content: expect.objectContaining({ reply_external_id: "stored-wamid" }),
    }),
  );
  expect(
    await all(
      env,
      "SELECT external_id FROM zernio_conversations WHERE connection_id=?",
      conn.id,
    ),
  ).toEqual([{ external_id: "5511999991111" }]);
});

it("applies status events by platform message id when optional participant identity is absent", async () => {
  const conn = await seed(),
    payload: any = inbound(),
    dispatch = vi.fn(async () => Response.json({ ok: true }));
  payload.event = "message.played";
  payload.message.direction = "outgoing";
  payload.message.sender.id = "business-number";
  delete payload.conversation.participantId;
  await zernioInbound(env, conn, payload, dispatch);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "status",
      status: "played",
      message_id: "wamid.inbound",
      external_id: "",
    }),
  );
  expect(
    await all(
      env,
      "SELECT external_id FROM zernio_conversations WHERE connection_id=?",
      conn.id,
    ),
  ).toHaveLength(0);
});

async function addMedia(conn: any, mime: string, name: string, size?: number) {
  const id = uid(),
    key = `${conn.profile_id}/${id}`;
  const bytes = new TextEncoder().encode("example-file-bytes");
  await env.MEDIA.put(key, bytes);
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    conn.profile_id,
    name,
    mime,
    size ?? bytes.length,
    key,
    "test",
    now(),
  );
  return { id, bytes };
}

it.each([
  ["text/plain; charset=utf-8", "document", "anotacoes.txt"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "document",
    "pedido.docx",
  ],
  ["audio/amr", "audio", "gravacao.amr"],
  ["video/3gpp", "video", "video.3gp"],
])(
  "sends %s as a streamed inbox attachment without using presign",
  async (mime, kind, name) => {
    const conn = await seed(),
      media = await addMedia(conn, mime, name);
    await zernioRememberConversation(
      env,
      conn,
      "5511999991111",
      "remote-thread",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(
          "https://zernio.com/api/v1/inbox/conversations/remote-thread/messages",
        );
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("Authorization")).toBe(
          "Bearer zernio-test-key",
        );
        expect(request.headers.get("Idempotency-Key")).toBe(
          "multipart-delivery",
        );
        expect(request.headers.get("Content-Type")).toMatch(
          /^multipart\/form-data; boundary=wabotia-/,
        );
        const form = await request.formData(),
          file = form.get("attachment") as File;
        expect(form.get("accountId")).toBe("remote-account");
        expect(form.get("message")).toBe("Segue o arquivo");
        expect(form.get("replyTo")).toBe("wamid.quoted");
        expect(form.has("attachmentType")).toBe(false);
        expect(file.name).toBe(name);
        expect(file.type).toBe(mime.split(";")[0]);
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(media.bytes);
        return Response.json({
          success: true,
          data: { messageId: "wamid.multipart" },
        });
      });
    await expect(
      zernioSend(
        env,
        conn,
        "5511999991111",
        {
          text: "Segue o arquivo",
          media_id: media.id,
          content: { type: kind, reply_external_id: "wamid.quoted" },
        },
        "multipart-delivery",
      ),
    ).resolves.toBe("wamid.multipart");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("normalizes OGG MIME parameters for presign and preserves voice note and quote flags", async () => {
  const conn = await seed(),
    media = await addMedia(conn, "audio/ogg; codecs=opus", "voz.ogg");
  await zernioRememberConversation(env, conn, "5511999991111", "remote-thread");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/media/presign")) {
        expect(await request.json()).toEqual({
          filename: "voz.ogg",
          contentType: "audio/ogg",
          size: media.bytes.length,
        });
        return Response.json({
          uploadUrl: "https://storage.example.com/voice",
          publicUrl: "https://storage.example.com/voice.ogg",
        });
      }
      if (request.method === "PUT") {
        expect(request.headers.get("Content-Type")).toBe("audio/ogg");
        expect(request.headers.has("Authorization")).toBe(false);
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(
          media.bytes,
        );
        return new Response(null);
      }
      expect(await request.json()).toEqual({
        accountId: "remote-account",
        attachmentUrl: "https://storage.example.com/voice.ogg",
        attachmentType: "audio",
        attachmentName: "voz.ogg",
        voiceNote: true,
        replyTo: "wamid.quoted",
      });
      return Response.json({ data: { messageId: "wamid.voice" } });
    });
  await expect(
    zernioSend(env, conn, "5511999991111", {
      media_id: media.id,
      content: { type: "voice", reply_external_id: "wamid.quoted" },
    }),
  ).resolves.toBe("wamid.voice");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("rejects non-presign template media and oversized multipart files locally", async () => {
  const conn = await seed(),
    ordinary = await addMedia(conn, "text/plain", "texto.txt"),
    large = await addMedia(
      conn,
      "application/msword",
      "grande.doc",
      25 * 1024 * 1024 + 1,
    );
  await zernioRememberConversation(env, conn, "5511999991111", "remote-thread");
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(
    zernioUpload(env, conn, ordinary.id, "document"),
  ).rejects.toThrow("cabeçalho de um template");
  await expect(
    zernioSend(env, conn, "5511999991111", {
      media_id: large.id,
      content: { type: "document" },
    }),
  ).rejects.toThrow("25 MB");
  expect(fetch).not.toHaveBeenCalled();
});

it("never automatically repeats a multipart send after an ambiguous provider failure", async () => {
  const conn = await seed(),
    media = await addMedia(conn, "text/plain", "texto.txt");
  await zernioRememberConversation(env, conn, "5511999991111", "remote-thread");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      await request.arrayBuffer();
      return Response.json({ error: "upstream unavailable" }, { status: 502 });
    });
  await expect(
    zernioSend(
      env,
      conn,
      "5511999991111",
      { media_id: media.id, content: { type: "document" } },
      "same-delivery-key",
    ),
  ).rejects.toMatchObject({ code: "zernio_unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("maps COPY_CODE template buttons to the documented opening-conversation field", async () => {
  const conn = await seed();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET")
        return Response.json({ data: [], pagination: { hasMore: false } });
      expect(request.url).toBe("https://zernio.com/api/v1/inbox/conversations");
      expect(await request.json()).toEqual({
        accountId: "remote-account",
        participantId: "5511999991111",
        templateName: "cupom",
        templateLanguage: "pt_BR",
        templateParams: ["Ana"],
        templateButtonParams: [
          { index: 1, subType: "copy_code", value: "PROMO20" },
        ],
      });
      return Response.json({
        data: { messageId: "wamid.coupon", conversationId: "coupon-thread" },
      });
    });
  await expect(
    zernioSend(env, conn, "5511999991111", {
      template: {
        name: "cupom",
        language: { code: "pt_BR" },
        components: [
          {
            type: "button",
            sub_type: "copy_code",
            index: "1",
            parameters: [{ type: "coupon_code", coupon_code: "PROMO20" }],
          },
          { type: "body", parameters: [{ type: "text", text: "Ana" }] },
        ],
      },
    }),
  ).resolves.toBe("wamid.coupon");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects custom QUICK_REPLY template payloads before opening a new conversation", async () => {
  const conn = await seed();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ data: [], pagination: { hasMore: false } }),
    );
  await expect(
    zernioSend(env, conn, "5511999991111", {
      template: {
        name: "resposta",
        language: "pt_BR",
        components: [
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: "custom-action" }],
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "unsupported_template" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    new Request(fetch.mock.calls[0][0], fetch.mock.calls[0][1]).method,
  ).toBe("GET");
});
