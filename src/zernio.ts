import { normalizeCustomerPhone } from "./customer/phone";
import { one, exec } from "./db";
import { consentFor, payloadPurpose } from "./consents";
import { templateParam } from "./template-params";
import { ApiError, Env, json, now, requireValue } from "./types";
import { equal, hmac, publicUrl, secret, sha } from "./security";
import { approvedTemplate, storeRemoteMedia } from "./integrations";
import { mediaKind, multipartStream } from "./media";
import { applyChannelEvents, applySocialConversationEvents, validateMedia } from "./whatsapp";
import { zernioPresignType } from "./zernio-media";
import { normalizeZernioError } from "./zernio-errors";
import {
  type InteractiveSpec,
  buildInteractive,
  interactiveFallbackText,
} from "./whatsapp-interactive";
import { normalizeZernioMetadata } from "./whatsapp-inbound";
import { socialTransportPort } from "./channel-ports";
import { channelExtension, extensionKey } from "./channel-extension-registry";
import { signVerifiedIngress } from "./channel-extension-kernel";
import type { ExtensionKey, ExtensionConnection } from "./channel-c2-contracts";
import type { ChannelId } from "./channel-contracts";
import type { NormalizedSocialEvent, SocialDelivery, SocialEventScope } from "./channel-contracts";
import type { Statement } from "./customer/contracts";
import { copySocialMedia } from "./zernio-social-media";
import { socialDeliveryPayload, socialEchoHint, socialExternalId, socialInteractiveReplyId, socialProviderError, socialProviderMessageId } from "./zernio-social";
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
/** The Zernio Account ID of this line's phone. */
export const zernioAccountId = accountId;

/** Paths are always relative to the fixed Zernio API origin. */
export async function zernioRequest(
  env: Env,
  conn: any,
  path: string,
  method = "GET",
  body?: any,
  idempotencyKey?: string,
  beforeFetch?: () => Promise<void>,
) {
  return zernioRawRequest(
    env,
    conn,
    path,
    method,
    body === undefined ? undefined : typeof body === "function" ? () => JSON.stringify(body()) : JSON.stringify(body),
    "application/json",
    idempotencyKey,
    undefined,
    beforeFetch,
  );
}

async function zernioRawRequest(
  env: Env,
  conn: any,
  path: string,
  method: string,
  body: string | ReadableStream<Uint8Array> | (() => string) | undefined,
  contentType: string,
  idempotencyKey?: string,
  contentLength?: number,
  beforeFetch?: () => Promise<void>,
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
  // A guarda roda depois da leitura da credencial, imediatamente antes da rede.
  // Erro de janela não é resultado indeterminado do fornecedor.
  await beforeFetch?.();
  const requestBody = typeof body === "function" ? body() : body;
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
      body: requestBody,
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

/** Seleção sem I/O. Os detalhes do envelope pertencem ao leitor do descritor;
 * esta função é consultada depois da assinatura e não altera o parser de DM. */
export function zernioExtensionKey(channel: ChannelId | null | undefined, input: unknown): ExtensionKey | null {
  if (channel === "tiktok") return "tiktok/direct";
  if (channel === "googlebusiness") return "googlebusiness/review";
  if (channel !== "instagram" && channel !== "facebook") return null;
  const key = extensionKey(channel, "comment");
  return key && channelExtension(key).ingress?.zernio?.matches(input) ? key : null;
}

/** Chamada somente pelo webhook que acabou de validar o HMAC bruto.
 * O Coordinator confere o ticket, o vínculo atual e o lote de deduplicação. */
export async function zernioExtensionInbound(env: Env, conn: ExtensionConnection, input: unknown, key: ExtensionKey) {
  const extension = channelExtension(key);
  if (conn.status !== "active" || !extension.enabled?.(conn))
    return Response.json({ received: true, ignored: true, reason: "channel_not_ready" });
  const config = json(conn.config);
  const scope = { profileId: conn.profile_id, connectionId: conn.id, channel: extension.spec.id,
    context: key.endsWith("/comment") ? "comment" as const : key.endsWith("/review") ? "review" as const : "direct" as const,
    accountId: String(config.account_id || ""), source: "zernio_hmac" as const };
  const ticket = await signVerifiedIngress(env, scope, input);
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(conn.profile_id)).fetch("https://coordinator/c2-inbound", {
    method: "POST", body: JSON.stringify({ profile: conn.profile_id, ticket }),
  });
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
  // Social só responde ao thread autenticado já associado à conversa local.
  // Não descobrir/importar histórico remoto nem iniciar por telefone/modelo.
  if (conn.channel && conn.channel !== "whatsapp") return null;
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

/**
 * Shows "digitando…" in a conversation already known to this line. On WhatsApp
 * it lasts up to 25 seconds and marks the last inbound message as read.
 * Best-effort: resolves false when the channel did not show it.
 */
export async function zernioTyping(env: Env, conn: any, externalId: string) {
  if (conn.channel && conn.channel !== "whatsapp") return false;
  const saved = await one(
    env,
    "SELECT conversation_id FROM zernio_conversations WHERE connection_id=? AND external_id=?",
    conn.id,
    externalId,
  );
  if (!saved) return false;
  const result = await zernioRequest(
    env,
    conn,
    `inbox/conversations/${segment(saved.conversation_id)}/typing`,
    "POST",
    { accountId: accountId(conn) },
  );
  return result?.success === true;
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
  // Finalidade da notificação (módulo) ou o consentimento de protocolo.
  const consent = await consentFor(
    env,
    conversation.id,
    payloadPurpose(payload),
  );
  // A queue call is a notice the customer asked for when taking the ticket.
  const queueTicket = payload.queue_ticket_id
    ? await one(
        env,
        "SELECT id FROM queue_tickets WHERE id=? AND conversation_id=? AND status IN ('waiting','called','serving')",
        payload.queue_ticket_id,
        conversation.id,
      )
    : null;
  if (
    (consent?.status !== "granted" && !queueTicket) ||
    !cfg.notifications?.enabled
  )
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
            {
              type: "text",
              text: templateParam(payload.ticket_id || "Atendimento", 100),
            },
            { type: "text", text: templateParam(payload.text) },
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
  beforeFetch?: () => Promise<void>,
) {
  if (conn.channel && conn.channel !== "whatsapp")
    return zernioSendSocial(env, conn, to, payload, idempotencyKey, beforeFetch);
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
        } else {
          // The documented `interactive` sends carry their text inside the
          // object; `payload.text` is the numbered fallback kept as history.
          body.interactive = content.interactive;
          delete body.message;
        }
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

/**
 * Sends one typed interactive message (CTA URL, list, media carousel, location
 * request, product, product list, catalog or Flow) in an open conversation.
 * Outside the 24-hour window WhatsApp refuses it: use a template first.
 * Automated replies should go through the outbox (sendInteractive in
 * line-service.ts), which also covers lines without interactive messages.
 */
export async function zernioSendInteractive(
  env: Env,
  conn: any,
  to: string,
  spec: InteractiveSpec,
  idempotencyKey?: string,
) {
  const interactive = buildInteractive(spec);
  return zernioSend(
    env,
    conn,
    to,
    {
      text: interactiveFallbackText(spec),
      content: { type: "interactive", interactive },
    },
    idempotencyKey,
  );
}

const date = (value: any) =>
  typeof value === "string" ? Date.parse(value) : NaN;

export async function zernioInbound(
  env: Env,
  conn: any,
  body: any,
  dispatch: (data: any) => Promise<Response>,
) {
  if (conn.channel && conn.channel !== "whatsapp")
    return zernioInboundSocial(env, conn, body, dispatch);
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
  const explicitGroup = [body.conversation?.platformConversationId, destination]
    .find((value) => typeof value === "string" && value.endsWith("@g.us"));
  const group = await one(
    env,
    "SELECT external_id FROM conversations WHERE connection_id=? AND chat_type='group' AND external_id IN (?,?) LIMIT 1",
    conn.id,
    body.conversation?.platformConversationId || "",
    destination || "",
  ) || (explicitGroup ? { external_id: explicitGroup } : null);
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
    // Status time belongs to the delivery event, not the original send. Using
    // sentAt here could charge a delivery to the wrong billing month.
    const statusAt = date(body.statusAt),
      eventAt = date(body.timestamp),
      sentAt = body.event === "message.sent" ? date(m.sentAt) : NaN;
    const timestamp =
      [statusAt, eventAt, sentAt].find(
        (value) => Number.isFinite(value) && value > 0,
      ) || 0;
    return dispatch({
      event: "status",
      external_id: typeof destination === "string" ? destination : "",
      message_id: m.platformMessageId,
      status: body.event.slice(8),
      pricing: body.pricing,
      timestamp,
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
      m.platformMessageId,
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
  // Location (numeric coordinates), Flow answers, catalog carts and product
  // questions; see whatsapp-inbound.ts for the content the engine receives.
  const normalized = normalizeZernioMetadata(
    metadata,
    typeof m.text === "string" ? m.text : "",
  );
  Object.assign(content, normalized.content);
  if (metadata.contacts) {
    content.type = "contacts";
    content.contacts = metadata.contacts.map((c: any) => ({
      name: c.name?.formatted_name || "",
      phone: c.phones?.[0]?.phone || "",
    }));
  }
  let text = normalized.text;
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
  const rawPhone = normalizeCustomerPhone(m.sender?.phoneNumber, "international");
  const sentAt = date(m.sentAt),
    receivedAt = now();
  // Keep malformed/future-dated messages, but do not open a free-form window
  // from an unknown customer time. Small platform clock skew is capped at now.
  const customerAt =
    Number.isFinite(sentAt) && sentAt > 0 && sentAt <= receivedAt + 300000
      ? Math.min(receivedAt, sentAt)
      : 0;
  return dispatch({
    external_id: destination,
    phone: !group && rawPhone ? rawPhone.replace(/^\+/, "") : null,
    message_id: m.platformMessageId,
    customer_at: customerAt,
    text,
    attachments,
    content,
    chat_type: group ? "group" : "direct",
  });
}

/** Uma entrega social equivale a uma única chamada de envio. A outbox prepara
 * assinatura, divisão e origem; esta fronteira não cria entregas escondidas. */
async function zernioSendSocial(
  env: Env, conn: any, to: string, payload: any, key?: string,
  beforeFetch?: () => Promise<void>,
) {
  if (!["instagram", "facebook"].includes(conn.channel))
    throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
  const delivery = payload.social_delivery as SocialDelivery | undefined;
  if (!delivery || !beforeFetch || !key || key !== delivery.idempotencyKey)
    throw new ApiError(422, "unsupported_content", "Envio social exige uma entrega preparada pela outbox.");
  const check = async () => {
    if (typeof payload.expires_at === "number" && payload.expires_at <= now())
      throw new ApiError(410, "message_expired", "Validade da mensagem encerrada antes do envio.");
    await beforeFetch();
  };
  await check();
  const thread = await zernioConversation(env, conn, to);
  if (!thread)
    throw new ApiError(409, "cannot_initiate", "Aguarde uma mensagem do cliente para responder neste canal.");
  let upload: { url: string; name: string } | undefined;
  if (delivery.content.type === "media")
    upload = await zernioUpload(env, conn, delivery.content.attachment.mediaId, delivery.content.attachment.kind);
  try {
    const result = await zernioRequest(env, conn,
      `inbox/conversations/${segment(thread)}/messages`, "POST",
      () => ({ accountId: accountId(conn), ...socialDeliveryPayload(delivery, upload) }), key, check);
    return socialProviderMessageId(result);
  } catch (error) {
    throw socialProviderError(error);
  }
}

/** cn-servidor inclui esta instrução no MESMO lote da identidade/inbox/mensagem.
 * O parser nunca confirma um thread antes de a entrada ter sido confirmada. */
export function zernioSocialThreadStatement(event: NormalizedSocialEvent): Statement {
  return [
    "INSERT INTO zernio_conversations(connection_id,external_id,conversation_id) VALUES(?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET conversation_id=excluded.conversation_id",
    [event.scope.connectionId, socialExternalId(event.subject.id), event.threadId],
  ];
}

// Evita cópia dupla no mesmo isolate. A unicidade no lote do Coordinator/D1
// continua obrigatória entre isolates e após falhas; isto não é uma trava D1.
// O corpo de uma Response recebida do Coordinator pertence à requisição que
// fez o fetch. Workerd não permite compartilhar esse stream com outro webhook.
// Leia-o na requisição original e compartilhe somente valores, sem I/O pendente.
type SocialInboundResponse = { body: ArrayBuffer | null; status: number; statusText: string; headers: [string, string][] };
const socialInboundWork = new WeakMap<Env, Map<string, Promise<SocialInboundResponse>>>();
const socialInboundResponse = (result: SocialInboundResponse) => new Response(result.body, {
  status: result.status, statusText: result.statusText, headers: result.headers,
});

async function zernioInboundSocial(
  env: Env, conn: any, body: unknown, dispatch: (data: any) => Promise<Response>,
) {
  const mediaDeadline = now() + 3000;
  if (!["instagram", "facebook"].includes(conn.channel))
    return Response.json({ received: true, ignored: true, reason: "channel_not_ready" });
  const cfg = json(conn.config);
  const binding = await one(env,
    `SELECT a.* FROM zernio_channel_accounts a JOIN connections c ON c.id=a.connection_id AND c.profile_id=a.profile_id
     WHERE a.connection_id=? AND a.profile_id=? AND a.integration_id=? AND a.channel=? AND a.account_id=? AND c.kind='zernio' AND c.channel=a.channel`,
    conn.id, conn.profile_id, cfg.zernio_workspace_id || "", conn.channel, cfg.account_id || "");
  if (!binding)
    return Response.json({ received: true, ignored: true, reason: "scope_mismatch" });
  const scope: SocialEventScope = {
    profileId: conn.profile_id, connectionId: conn.id, channel: conn.channel,
    integrationId: binding.integration_id, accountId: binding.account_id,
    providerProfileId: binding.provider_profile_id || null,
  };
  const result = await socialTransportPort.normalizeEvent(body, scope);
  if (result.status === "ignored")
    return Response.json({ received: true, ignored: true, reason: result.reason });
  const e = result.event, externalId = socialExternalId(e.subject.id);
  const mapped = await one(env,
    "SELECT external_id FROM zernio_conversations WHERE connection_id=? AND conversation_id=?",
    conn.id, e.threadId);
  if (mapped && mapped.external_id !== externalId)
    return Response.json({ received: true, ignored: true, reason: "scope_mismatch" });
  const key = `${scope.profileId}:channel:${conn.id}:${externalId}:${e.messageId}`;
  let work = socialInboundWork.get(env);
  if (!work) { work = new Map(); socialInboundWork.set(env, work); }
  const workKey = JSON.stringify([key, e.type, e.type === "message.received" ? null : e.eventId]);
  const running = work.get(workKey);
  if (running) return socialInboundResponse(await running);
  const pending = (async () => {
    if (e.type === "message.received") {
      const known = await one(env, "SELECT id FROM inbox WHERE event_key=?", key);
      if (known) {
        await applyChannelEvents(env, conn.id, e.messageId);
        await applySocialConversationEvents(env, conn.id, externalId);
        return Response.json({ received: true, duplicate: true });
      }
    } else {
      const stored = await one(env,
        "SELECT event_key FROM channel_events WHERE connection_id=? AND external_id=? AND json_extract(payload,'$.event_id')=?",
        conn.id, e.messageId, e.eventId);
      if (stored) {
        await applyChannelEvents(env, conn.id, e.messageId);
        return Response.json({ received: true, duplicate: true });
      }
    }
    const common = { external_id: externalId, message_id: e.messageId,
      event_id: e.eventId, timestamp: e.occurredAt ?? 0, channel: scope.channel };
    if (e.type === "message.read" || e.type === "message.delivered")
      return dispatch({ ...common, event: "status", status: e.type.slice(8) });
    if (e.type === "message.deleted") return dispatch({ ...common, event: "delete" });
    if (e.type === "message.reaction")
      return dispatch({ ...common, event: "reaction", participant: e.subject.id, emoji: e.reaction || "" });
    if (e.type !== "message.received" && e.type !== "message.sent" && e.type !== "message.edited")
      return Response.json({ received: true, ignored: true });
    if (e.type === "message.edited")
      return dispatch({ ...common, event: "edit", text: e.text });
    // Correlação opaca é só uma pista do fornecedor; confirme conta/conversa na outbox.
    const hint = e.type === "message.sent" ? socialEchoHint(body) : null;
    const local = hint ? await one(env,
      `SELECT o.id FROM outbox o JOIN conversations c ON c.id=o.conversation_id AND c.profile_id=o.profile_id
       WHERE o.profile_id=? AND o.connection_id=? AND c.external_id=? AND c.channel=?
         AND (o.id=? OR json_extract(o.payload,'$.social_delivery.idempotencyKey')=?)`,
      scope.profileId, conn.id, externalId, scope.channel, hint, hint) : null;
    if (e.type === "message.sent" && local)
      return dispatch({ ...common, event: "external", local_delivery_id: local.id, text: "", attachments: [] });
    const copied = await copySocialMedia(env, scope, e.messageId, e.media, { deadline: mediaDeadline });
    const text = e.text + (copied.unavailable ? "\n[Anexo indisponível. Solicite o reenvio ou verifique o tamanho e a conexão.]" : "");
    const content = {
      type: e.media[0]?.kind || "text", zernio_conversation_id: e.threadId,
      participant: e.subject.id, participant_name: e.subject.displayName || "Contato",
      ...(socialInteractiveReplyId(body) ? { interactive_reply_id: socialInteractiveReplyId(body) } : {}),
      ...(copied.unavailable ? { media_error: true } : {}),
    };
    if (e.type === "message.sent")
      return dispatch({ ...common, event: "external", text, attachments: copied.attachments, content });
    // Este DTO é consumido pelo ramo social de service.inbound (cn-servidor).
    // phone:null e external_id com prefixo impedem interpretar ID numérico como telefone.
    const response = await dispatch({
      ...common, phone: null, customer_at: e.occurredAt ?? 0, text,
      attachments: copied.attachments, content, chat_type: "direct",
      channel_account_id: scope.accountId, channel_subject_id: e.subject.id,
      account_label: conn.account_label || "", channel_context: e.context,
      display_name: e.subject.displayName || "", username: e.subject.username || "",
      evidence: { channel: scope.channel, provider: "zernio", accountId: scope.accountId,
        subjectNamespace: "dm", subjectId: e.subject.id,
        displayName: e.subject.displayName, username: e.subject.username },
      // Normalizado, sem URL ou corpo bruto: o servidor constrói a instrução do lote.
      channel_thread: { connectionId: conn.id, externalId, threadId: e.threadId },
    });
    if (response.ok) await applySocialConversationEvents(env, conn.id, externalId);
    return response;
  })().then(async response => ({
    body: response.body === null ? null : await response.arrayBuffer(),
    status: response.status, statusText: response.statusText, headers: [...response.headers],
  } satisfies SocialInboundResponse));
  work.set(workKey, pending);
  try { return socialInboundResponse(await pending); }
  finally { work.delete(workKey); }
}
