import { one, exec } from "./db";
import { ApiError, Env, json, now, requireValue } from "./types";
import { equal, hmac, publicUrl, secret, sha } from "./security";
import { approvedTemplate, storeRemoteMedia } from "./integrations";
import { mediaKind, multipartStream } from "./media";
import { validateMedia } from "./whatsapp";
import { zernioPresignType } from "./zernio-media";
import { normalizeZernioError } from "./zernio-errors";
export { zernioPresignType } from "./zernio-media";

const API = "https://zernio.com/api/v1/";
const segment = (value: string) => encodeURIComponent(value);

export async function zernioCredentials(env: Env, conn: any) {
  const workspace = json(conn.config).zernio_workspace_id;
  if (!workspace) return secret(env, `connection:${conn.id}`);
  requireValue(
    await one(
      env,
      "SELECT id FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'",
      workspace,
      conn.profile_id,
    ),
    "Integração Zernio não pertence a esta área de atendimento.",
  );
  return secret(env, `zernio-account:${workspace}`);
}

function accountId(conn: any): string {
  const id = json(conn.config).account_id;
  requireValue(
    typeof id === "string" && id.length > 0,
    "Configure o ID do telefone na Zernio.",
  );
  return id;
}

/** Paths are always relative to the fixed Zernio API origin. */
export async function zernioRequest(
  env: Env,
  conn: any,
  path: string,
  method = "GET",
  body?: any,
  idempotencyKey?: string,
) {
  return zernioRawRequest(
    env,
    conn,
    path,
    method,
    body === undefined ? undefined : JSON.stringify(body),
    "application/json",
    idempotencyKey,
  );
}

async function zernioRawRequest(
  env: Env,
  conn: any,
  path: string,
  method: string,
  body: string | ReadableStream<Uint8Array> | undefined,
  contentType: string,
  idempotencyKey?: string,
  contentLength?: number,
) {
  requireValue(
    !path.startsWith("/") && !path.includes("\\") && !path.includes("://"),
    "Caminho Zernio inválido.",
  );
  const url = new URL(path, API);
  requireValue(
    url.origin === "https://zernio.com" &&
      url.pathname.startsWith("/api/v1/") &&
      !url.hash,
    "Caminho Zernio inválido.",
  );
  const keys = await zernioCredentials(env, conn);
  requireValue(
    typeof keys.api_key === "string" && keys.api_key,
    "Configure a API key da Zernio.",
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${keys.api_key}`,
        "Content-Type": contentType,
        ...(contentLength === undefined
          ? {}
          : { "Content-Length": String(contentLength) }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(contentLength === undefined ? 15000 : 60000),
    });
  } catch {
    throw new ApiError(
      502,
      "zernio_unknown",
      "A Zernio não confirmou a operação. Consulte a entrega antes de repetir.",
    );
  }
  const result = await response.json<any>().catch(() => null);
  if (!response.ok || result?.success === false) {
    const failure = normalizeZernioError(response.status, result, [
      keys.api_key,
      keys.webhook_secret,
    ]);
    throw new ApiError(failure.status, failure.code, failure.message);
  }
  if (!result || typeof result !== "object")
    throw new ApiError(
      502,
      "zernio_unknown",
      "Resposta incompleta da Zernio. Consulte a entrega antes de repetir.",
    );
  return result;
}

export async function verifyZernioWebhook(
  key: string,
  rawBody: string,
  signature: string | null,
) {
  // There is no signed delivery timestamp; retries retain the original body for
  // up to 51 hours. Inbox event/message deduplication handles replay safely.
  return (
    !!key &&
    /^[a-f0-9]{64}$/.test(signature || "") &&
    equal(await hmac(key, rawBody), signature!)
  );
}

export async function zernioRememberConversation(
  env: Env,
  conn: any,
  externalId: string,
  conversationId: string,
) {
  requireValue(
    typeof externalId === "string" &&
      externalId.length > 0 &&
      typeof conversationId === "string" &&
      conversationId.length > 0,
    "Conversa Zernio inválida.",
  );
  await exec(
    env,
    "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET conversation_id=excluded.conversation_id",
    conn.id,
    externalId,
    conversationId,
  );
}

export async function zernioConversation(
  env: Env,
  conn: any,
  externalId: string,
): Promise<string | null> {
  const saved = await one(
    env,
    "SELECT conversation_id FROM zernio_conversations WHERE connection_id=? AND external_id=?",
    conn.id,
    externalId,
  );
  if (saved) return saved.conversation_id;
  const cursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({
      accountId: accountId(conn),
      platform: "whatsapp",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const result = await zernioRequest(
      env,
      conn,
      `inbox/conversations?${query}`,
    );
    requireValue(
      Array.isArray(result.data),
      "Lista de conversas Zernio inválida.",
    );
    const found = result.data.find(
      (c: any) =>
        c.accountId === accountId(conn) &&
        c.platform === "whatsapp" &&
        (c.participantId === externalId ||
          c.businessScopedUserId === externalId),
    );
    if (found && typeof found.id === "string") {
      await zernioRememberConversation(env, conn, externalId, found.id);
      return found.id;
    }
    if (!result.pagination?.hasMore) return null;
    const next = result.pagination.nextCursor;
    requireValue(
      typeof next === "string" && next && !cursors.has(next),
      "Paginação Zernio inválida.",
    );
    cursors.add(next);
    cursor = next;
  }
  throw new ApiError(
    409,
    "zernio_conversation_unresolved",
    "A conversa ainda não foi localizada na Zernio. Aguarde uma mensagem do cliente.",
  );
}

export async function zernioTemplates(env: Env, conn: any, name?: string) {
  const query = new URLSearchParams({
    accountId: accountId(conn),
    ...(name ? { name } : {}),
  });
  const result = await zernioRequest(env, conn, `whatsapp/templates?${query}`);
  requireValue(
    Array.isArray(result.templates),
    "A Zernio não retornou os templates.",
  );
  return { data: result.templates };
}

export async function zernioTemplatePayload(
  env: Env,
  conn: any,
  conversation: any,
  payload: any,
  cfg: any,
) {
  const consent = await one(
    env,
    "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
    conversation.id,
  );
  if (consent?.status !== "granted" || !cfg.notifications?.enabled)
    throw new ApiError(
      409,
      "notification_waiting",
      "Aguardando consentimento e template.",
    );
  const result = await zernioTemplates(
    env,
    conn,
    cfg.notifications.template_name,
  );
  const template = result.data.find(
    (t: any) =>
      t.name === cfg.notifications.template_name &&
      t.language === cfg.notifications.language &&
      approvedTemplate(t),
  );
  requireValue(
    template,
    "Configure um template UTILITY aprovado, com as variáveis {{1}} e {{2}}.",
  );
  return {
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: payload.ticket_id || "Atendimento" },
            { type: "text", text: String(payload.text || "").slice(0, 1000) },
          ],
        },
      ],
    },
  };
}

export async function zernioUpload(
  env: Env,
  conn: any,
  mediaId: string,
  kind: string,
) {
  const media = await one(
    env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    mediaId,
    conn.profile_id,
  );
  requireValue(media, "Anexo não encontrado.");
  const mime = zernioPresignType(media.type);
  requireValue(
    mime,
    "Este formato não pode ser usado no cabeçalho de um template Zernio. Use PDF, JPG/PNG ou MP4.",
  );
  requireValue(
    kind !== "sticker",
    "O envio de figurinhas não está disponível pela Zernio.",
  );
  validateMedia(media, kind, {
    ...conn,
    config: JSON.stringify({
      ...json(conn.config),
      platform: "whatsapp_cloud",
    }),
  });
  const object = await env.MEDIA.get(media.object_key);
  requireValue(object, "Arquivo ausente.");
  const result = await zernioRequest(env, conn, "media/presign", "POST", {
    filename: media.name,
    contentType: mime,
    size: media.size,
  });
  const uploadUrl = publicUrl(result.uploadUrl),
    url = publicUrl(result.publicUrl);
  requireValue(
    uploadUrl.startsWith("https:") && url.startsWith("https:"),
    "Endereço de upload Zernio inválido.",
  );
  let response: Response;
  try {
    // Storage receives only the signed URL, never the Zernio API key.
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mime,
        "Content-Length": String(media.size),
      },
      body: object.body,
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new ApiError(
      502,
      "zernio_media_error",
      "Não foi possível enviar o arquivo para a Zernio.",
    );
  }
  requireValue(response.ok, "A Zernio não confirmou o upload do arquivo.");
  return { url, name: media.name };
}

function openingTemplate(template: any) {
  const body: any = {
    templateName: template.name,
    templateLanguage:
      typeof template.language === "string"
        ? template.language
        : template.language?.code,
    templateParams: [],
  };
  const order: Record<string, number> = { header: 0, body: 1, button: 2 };
  const components = [...(template.components || [])].sort(
    (a: any, b: any) =>
      (order[a.type] ?? 3) - (order[b.type] ?? 3) ||
      Number(a.index || 0) - Number(b.index || 0),
  );
  for (const component of components) {
    requireValue(
      ["header", "body", "button"].includes(component.type),
      "Componente de template não suportado para iniciar uma conversa Zernio.",
    );
    if (
      component.type === "button" &&
      !["url", "copy_code"].includes(component.sub_type)
    )
      throw new ApiError(
        422,
        "unsupported_template",
        "A abertura de uma conversa pela Zernio não aceita payload personalizado em botão QUICK_REPLY. Use um template sem esse payload ou uma conversa já existente.",
      );
    if (component.type === "button" && component.sub_type === "copy_code") {
      const index = Number(component.index),
        parameter = component.parameters?.[0];
      requireValue(
        Number.isInteger(index) &&
          index >= 0 &&
          index <= 9 &&
          component.parameters?.length === 1 &&
          parameter?.type === "coupon_code" &&
          typeof parameter.coupon_code === "string" &&
          parameter.coupon_code.length > 0,
        "Botão de copiar código inválido no template Zernio.",
      );
      body.templateButtonParams ||= [];
      requireValue(
        !body.templateButtonParams.some(
          (button: any) => button.index === index,
        ),
        "Índice de botão duplicado no template Zernio.",
      );
      body.templateButtonParams.push({
        index,
        subType: "copy_code",
        value: parameter.coupon_code,
      });
      continue;
    }
    for (const parameter of component.parameters || []) {
      if (parameter.type === "text") {
        requireValue(
          component.type !== "button" || component.sub_type === "url",
          "Botão de template não suportado para iniciar esta conversa.",
        );
        body.templateParams.push(parameter.text);
      } else if (
        component.type === "header" &&
        ["image", "video", "document"].includes(parameter.type)
      ) {
        requireValue(
          parameter[parameter.type]?.link,
          "O cabeçalho do template exige uma URL de mídia.",
        );
        body.headerMedia = {
          type: parameter.type,
          link: parameter[parameter.type].link,
          ...(parameter[parameter.type].filename
            ? { filename: parameter[parameter.type].filename }
            : {}),
        };
      } else if (component.type === "header" && parameter.type === "location") {
        body.headerLocation = parameter.location;
      } else
        throw new ApiError(
          422,
          "unsupported_template",
          "Este componente de template ainda não é suportado para iniciar uma conversa Zernio.",
        );
    }
  }
  return body;
}

export async function zernioSend(
  env: Env,
  conn: any,
  to: string,
  payload: any,
  idempotencyKey?: string,
) {
  if (typeof payload.expires_at === "number" && payload.expires_at <= now())
    throw new ApiError(
      410,
      "message_expired",
      "Validade da mensagem encerrada antes do envio.",
    );
  const account = accountId(conn),
    content = payload.content || {},
    kind = content.type || "text";
  const template = payload.template || payload.template_message?.template;
  const conversation = await zernioConversation(env, conn, to);
  if (typeof payload.expires_at === "number" && payload.expires_at <= now())
    throw new ApiError(
      410,
      "message_expired",
      "Validade da mensagem encerrada antes do envio.",
    );
  let result: any;
  if (!conversation) {
    requireValue(
      template && payload.chat_type !== "group",
      "Aguarde uma mensagem do cliente ou envie um template aprovado para iniciar a conversa pela Zernio.",
    );
    result = await zernioRequest(
      env,
      conn,
      "inbox/conversations",
      "POST",
      { accountId: account, participantId: to, ...openingTemplate(template) },
      idempotencyKey,
    );
    if (typeof result.data?.conversationId === "string")
      await zernioRememberConversation(
        env,
        conn,
        to,
        result.data.conversationId,
      );
  } else {
    const path = `inbox/conversations/${segment(conversation)}`;
    if (kind === "read") {
      await zernioRequest(
        env,
        conn,
        `${path}/read`,
        "POST",
        { accountId: account },
        idempotencyKey,
      );
      return content.target_external_id;
    }
    if (kind === "reaction") {
      requireValue(
        content.target_external_id && typeof content.emoji === "string",
        "Reação inválida.",
      );
      // Removal uses DELETE; the provider does not guarantee that a reaction
      // actually appeared, only that the request was accepted.
      result = await zernioRequest(
        env,
        conn,
        `${path}/messages/${segment(content.target_external_id)}/reactions${content.emoji ? "" : `?accountId=${segment(account)}`}`,
        content.emoji ? "POST" : "DELETE",
        content.emoji
          ? { accountId: account, emoji: content.emoji }
          : undefined,
        idempotencyKey,
      );
      return content.target_external_id;
    }
    const body: any = { accountId: account };
    let multipart: ReturnType<typeof multipartStream> | undefined;
    if (template)
      body.template = {
        elements: [
          {
            ...template,
            language:
              typeof template.language === "string"
                ? template.language
                : template.language?.code,
          },
        ],
      };
    else {
      requireValue(
        [
          "text",
          "image",
          "video",
          "audio",
          "voice",
          "document",
          "location",
          "contacts",
          "interactive",
        ].includes(kind),
        "Conteúdo não suportado pela conexão Zernio.",
      );
      if (payload.text) body.message = payload.text;
      if (kind === "location") body.location = content.location;
      if (kind === "contacts")
        body.contacts = content.contacts.map((c: any) => ({
          name: { formatted_name: c.name, first_name: c.name },
          phones: [{ phone: c.phone, type: "CELL" }],
        }));
      if (kind === "interactive") {
        if (content.interactive?.type === "button") {
          body.message = content.interactive.body?.text || payload.text;
          body.buttons = content.interactive.action?.buttons?.map((b: any) => ({
            type: "postback",
            title: b.reply.title,
            payload: b.reply.id,
          }));
        } else body.interactive = content.interactive;
      }
      const mediaId = payload.media_id || payload.attachments?.[0];
      requireValue(
        !payload.attachments || payload.attachments.length <= 1,
        "Envie cada anexo como uma entrega separada.",
      );
      if (mediaId) {
        const media = await one(
          env,
          "SELECT * FROM media WHERE id=? AND profile_id=?",
          mediaId,
          conn.profile_id,
        );
        requireValue(media, "Anexo não encontrado.");
        const mediaType = kind === "text" ? mediaKind(media.type) : kind;
        if (zernioPresignType(media.type)) {
          const upload = await zernioUpload(env, conn, mediaId, mediaType);
          body.attachmentUrl = upload.url;
          body.attachmentType =
            mediaType === "document"
              ? "file"
              : mediaType === "voice"
                ? "audio"
                : mediaType;
          body.attachmentName = upload.name;
          if (mediaType === "voice") body.voiceNote = true;
        } else {
          // Office/TXT, AMR and 3GPP are valid WhatsApp formats but are absent
          // from Zernio's presign MIME enum. Stream them to the documented
          // multipart inbox endpoint instead of re-labelling their bytes.
          validateMedia(media, mediaType, {
            ...conn,
            config: JSON.stringify({
              ...json(conn.config),
              platform: "whatsapp_cloud",
            }),
          });
          requireValue(
            media.size <= 25 * 1024 * 1024,
            "Este formato aceita arquivos de até 25 MB pela Zernio. Para documentos maiores, use PDF.",
          );
          requireValue(
            !body.interactive && !body.location && !body.contacts,
            "Este conteúdo não pode ser combinado com um anexo multipart Zernio.",
          );
          const object = await env.MEDIA.get(media.object_key);
          requireValue(object, "Arquivo ausente.");
          const fields: Record<string, string> = { accountId: account };
          if (body.message) fields.message = body.message;
          if (body.buttons) fields.buttons = JSON.stringify(body.buttons);
          if (content.reply_external_id)
            fields.replyTo = content.reply_external_id;
          if (mediaType === "voice") fields.voiceNote = "true";
          multipart = multipartStream(
            fields,
            "attachment",
            media.name,
            media.type.split(";")[0].trim().toLowerCase(),
            object.body,
            media.size,
          );
        }
      }
      if (content.reply_external_id) body.replyTo = content.reply_external_id;
    }
    if (typeof payload.expires_at === "number" && payload.expires_at <= now())
      throw new ApiError(
        410,
        "message_expired",
        "Validade da mensagem encerrada antes do envio.",
      );
    result = multipart
      ? await zernioRawRequest(
          env,
          conn,
          `${path}/messages`,
          "POST",
          multipart.stream,
          multipart.type,
          idempotencyKey,
          multipart.length,
        )
      : await zernioRequest(
          env,
          conn,
          `${path}/messages`,
          "POST",
          body,
          idempotencyKey,
        );
  }
  if (typeof result.data?.messageId !== "string" || !result.data.messageId)
    throw new ApiError(
      502,
      "zernio_unknown",
      "A Zernio não informou o ID da mensagem. Confira a entrega antes de repetir.",
    );
  return result.data.messageId;
}

const date = (value: any) =>
  typeof value === "string" ? Date.parse(value) : NaN;

export async function zernioInbound(
  env: Env,
  conn: any,
  body: any,
  dispatch: (data: any) => Promise<Response>,
) {
  if (body.test || body.event === "webhook.test")
    return Response.json({ received: true, test: true });
  if (
    (body.account?.accountId || body.account?.id) !== accountId(conn) ||
    body.account?.platform !== "whatsapp" ||
    (body.account?.profileId &&
      json(conn.config).zernio_profile_id &&
      body.account.profileId !== json(conn.config).zernio_profile_id)
  )
    return Response.json({ received: true, ignored: true });
  const m = body.message,
    remoteConversation = m?.conversationId || body.conversation?.id;
  let destination =
    body.conversation?.participantId ||
    (m?.direction === "incoming"
      ? m?.sender?.businessScopedUserId || m?.sender?.id
      : "");
  // Zernio's shared webhook schema does not expose a WhatsApp group flag.
  // Resolve groups against the number's synchronized group records, rather
  // than mistaking the participant who wrote for the conversation identity.
  const group = await one(
    env,
    "SELECT external_id FROM conversations WHERE connection_id=? AND chat_type='group' AND external_id IN (?,?) LIMIT 1",
    conn.id,
    body.conversation?.platformConversationId || "",
    destination || "",
  );
  if (group) destination = group.external_id;
  else if (typeof remoteConversation === "string") {
    // A customer's visible phone can disappear during WhatsApp's BSUID
    // rollout. The provider thread remains stable: keep its original local
    // identity instead of creating another conversation or conflicting with
    // the unique provider-thread mapping.
    const mapped = await one(
      env,
      "SELECT external_id FROM zernio_conversations WHERE connection_id=? AND conversation_id=?",
      conn.id,
      remoteConversation,
    );
    if (mapped) destination = mapped.external_id;
  }
  if (
    typeof remoteConversation === "string" &&
    typeof destination === "string" &&
    destination
  )
    await zernioRememberConversation(
      env,
      conn,
      destination,
      remoteConversation,
    );
  if (
    [
      "message.sent",
      "message.delivered",
      "message.read",
      "message.played",
      "message.failed",
    ].includes(body.event)
  ) {
    if (!m?.platformMessageId)
      return Response.json({ received: true, ignored: true });
    return dispatch({
      event: "status",
      external_id: typeof destination === "string" ? destination : "",
      message_id: m.platformMessageId,
      status: body.event.slice(8),
      pricing: body.pricing,
      timestamp: date(body.statusAt || m.sentAt || body.timestamp) || now(),
    });
  }
  if (body.event === "reaction.received") {
    const r = body.reaction;
    if (!r?.platformMessageId || !body.id)
      return Response.json({ received: true, ignored: true });
    return dispatch({
      event: "reaction",
      external_id: typeof destination === "string" ? destination : "",
      message_id: r.platformMessageId,
      event_id: body.id,
      participant: r.sender?.id,
      emoji: r.action === "removed" ? "" : r.emoji,
      timestamp: date(r.reactedAt || body.timestamp) || now(),
    });
  }
  // Another app/Meta Business Agent owns standby conversations. Dispatching
  // these to our engine would cause an automatic reply that steals ownership.
  if (
    body.event !== "message.received" ||
    m?.direction !== "incoming" ||
    m.platform !== "whatsapp" ||
    body.metadata?.standby === true
  )
    return Response.json({ received: true, ignored: true });
  requireValue(
    typeof destination === "string" &&
      destination &&
      typeof m.platformMessageId === "string" &&
      m.platformMessageId &&
      Number.isFinite(date(m.sentAt)),
    "Mensagem Zernio inválida.",
  );
  const known = await one(
    env,
    "SELECT id FROM inbox WHERE event_key=?",
    `${conn.profile_id}:channel:${conn.id}:${destination}:${m.platformMessageId}`,
  );
  if (known) return Response.json({ received: true, duplicate: true });
  const content: any = {
    type: "text",
    participant: m.sender?.id,
    participant_name: m.sender?.name || m.sender?.id,
    zernio_conversation_id: remoteConversation,
  };
  const metadata = body.metadata || {};
  if (metadata.interactiveId)
    content.interactive_reply_id = metadata.interactiveId;
  if (metadata.quotedMessage?.platformMessageId || metadata.quotedMessageId)
    content.reply_external_id =
      metadata.quotedMessage?.platformMessageId || metadata.quotedMessageId;
  if (metadata.location) {
    content.type = "location";
    content.location = metadata.location;
  }
  if (metadata.contacts) {
    content.type = "contacts";
    content.contacts = metadata.contacts.map((c: any) => ({
      name: c.name?.formatted_name || "",
      phone: c.phones?.[0]?.phone || "",
    }));
  }
  let text = typeof m.text === "string" ? m.text : "";
  const attachments: string[] = [];
  for (let index = 0; index < (m.attachments || []).length; index++) {
    const attachment = m.attachments[index];
    const id = (await sha(`${conn.id}:${m.platformMessageId}:${index}`)).slice(
      0,
      32,
    );
    const existing = await one(
      env,
      "SELECT id FROM media WHERE id=? AND profile_id=?",
      id,
      conn.profile_id,
    );
    const kind =
      attachment.type === "file"
        ? "document"
        : attachment.payload?.voice
          ? "voice"
          : attachment.type;
    content.type = kind;
    if (existing) {
      attachments.push(id);
      continue;
    }
    try {
      const url = new URL(attachment.url);
      requireValue(
        url.origin === "https://zernio.com" &&
          /^\/api\/v1\/whatsapp\/media\/[^/]+$/.test(url.pathname) &&
          !url.username &&
          !url.password &&
          (!url.searchParams.has("accountId") ||
            url.searchParams.get("accountId") === accountId(conn)),
        "Endereço de mídia Zernio inválido.",
      );
      url.searchParams.set("accountId", accountId(conn));
      const keys = await zernioCredentials(env, conn);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${keys.api_key}` },
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      const mime =
        response.headers.get("Content-Type") ||
        attachment.mimeType ||
        "application/octet-stream";
      attachments.push(
        await storeRemoteMedia(
          env,
          conn.profile_id,
          attachment.payload?.filename ||
            `${kind}-${m.platformMessageId.slice(-10)}`,
          mime,
          response,
          { id, actor: `transport:${conn.id}` },
        ),
      );
    } catch {
      text +=
        "\n[Anexo indisponível. Solicite o reenvio ou verifique o tamanho e a conexão.]";
      content.media_error = true;
    }
  }
  const rawPhone =
    m.sender?.phoneNumber ||
    (/^\d{8,16}$/.test(m.sender?.id || "") ? m.sender.id : null);
  return dispatch({
    external_id: destination,
    phone: !group && rawPhone ? rawPhone.replace(/^\+/, "") : null,
    message_id: m.platformMessageId,
    customer_at: date(m.sentAt),
    text,
    attachments,
    content,
    chat_type: group ? "group" : "direct",
  });
}
