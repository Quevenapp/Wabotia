import { one } from "../../../db";
import { type Actor, type Conversation } from "../../../types";
import type { ModuleContext } from "../../api";
import { readBinaryContent } from "../../binary";
import type { OsExtension } from "../extensions";
import { authorizedOrder } from "../public";
import { documentOrder, loadDocument } from "./access";
import { fail, versionOf } from "./model";
import { reserveDocument } from "./store";
import {
  beginUpload,
  completeDocument,
  inspectObject,
  recordUpload,
  uploadHandler,
} from "./transport";

export async function sendDocument(
  ctx: ModuleContext,
  actor: Actor,
  orderId: string,
  id: string,
  value: unknown,
  conversationId?: string,
) {
  const order = await documentOrder(ctx, actor, orderId, {
    write: true,
    conversation_id: conversationId,
  });
  const row = await loadDocument(ctx, orderId, id);
  if (row.archived_at !== null) fail(404, "not_found");
  if (!row.client_visible || row.sensitive) fail(403, "document_not_shareable");
  if (row.version !== versionOf(value)) fail(409, "version_conflict");
  if (row.state !== "ready") fail(409, "document_not_ready");
  const target = conversationId ?? order.row.conversation_id;
  if (!target) fail(409, "no_conversation");
  const c = await ctx.conversation(target, actor);
  await documentOrder(ctx, actor, orderId, {
    write: true,
    conversation_id: c.id,
  });
  if (!ctx.mayMessage(actor, c)) fail(403, "forbidden");
  const content = await inspectObject(ctx, row);
  const key = `document:${row.id}:${row.version}`;
  const media = await ctx.outgoingAttachment(actor, c, {
    name: row.name,
    mime_type: row.mime_type,
    byte_length: content.byte_length,
    body: new Response(content.bytes).body!,
    key,
    client_visible: true,
    sensitive: false,
  });
  const message_id = await ctx.sendMessage(
    c,
    { text: row.name, attachments: [media] },
    { key, notification: true },
  );
  return { id, message_id };
}

function inboundActor(ctx: ModuleContext, c: Conversation): Actor {
  // Identidade interna, nunca aceita em parâmetros HTTP. Autorização pelo titular da conversa.
  return {
    id: `module:os:document:${c.id}`,
    kind: "app",
    name: "Documentos recebidos",
    role: "service",
    profiles: [ctx.profile],
    scopes: ["conversations:read", "conversations:write"],
    bots: [],
    rate: 0,
    runLimit: 0,
    module: { id: "os", reach: [] },
  };
}

export const receiveDocument: NonNullable<
  OsExtension["onConversationTurn"]
> = async (ctx, c, turn) => {
  if (c.profile_id !== ctx.profile || !ctx.verifiedPhone(c)) return false;
  const match = /^DOCUMENTO\s+([1-9][0-9]{0,9})\s*$/i.exec(turn.text.trim());
  const attachments = await ctx.inboundAttachments(c, turn.rowId);
  if (!attachments.length && !/^DOCUMENTO\b/i.test(turn.text.trim()))
    return false;
  const reply = (text: string) =>
    ctx.sendMessage(c, { text }, { key: `document:inbound:${turn.rowId}` });
  if (!match || Number(match[1]) > 2147483647) {
    // Área somente com o embutido conserva o tratamento antigo dos anexos.
    const settings = await ctx.settings();
    if (
      !Array.isArray(settings.os_work_types) ||
      !settings.os_work_types.length
    )
      return false;
    await reply(
      "Envie o anexo com DOCUMENTO seguido do número global da ordem na mesma mensagem.",
    );
    return true;
  }
  const actor = inboundActor(ctx, c);
  const found = await one<{ id: string }>(
    ctx.env,
    "SELECT id FROM os_orders WHERE profile_id=? AND number=?",
    ctx.profile,
    Number(match[1]),
  );
  if (!found) fail(404, "not_found");
  const access = { conversation_id: c.id };
  const order = await authorizedOrder(ctx, actor, found.id, {
    ...access,
    write: true,
  });
  if (!order.type.features.documents) return false;
  if (!attachments.length) {
    await reply("Inclua o documento como anexo na mesma mensagem.");
    return true;
  }
  // A lista vem exclusivamente do adaptador que confere mensagem/área/conversa.
  for (const attachment of attachments) {
    const key = `inbound:${turn.rowId}:${attachment.id}`;
    const reserved = await reserveDocument(
      ctx,
      actor,
      found.id,
      {
        name: attachment.name,
        mime_type: attachment.mime_type,
        expected_bytes: attachment.byte_length,
        client_visible: true,
        sensitive: false,
      },
      key,
      access,
      { message_id: turn.rowId, media_id: attachment.id },
    );
    const row = await loadDocument(ctx, found.id, reserved.id);
    if (row.state === "ready") continue;
    // Mesmo transporte e confirmação do painel; os comandos já estão no Coordinator.
    const handler = uploadHandler();
    const context = ctx;
    // A identidade interna não é bound; o titular foi conferido acima e o pai é fixo.
    const uploaded = (await handler.upload(context, actor, {
      params: { id: found.id, document_id: reserved.id },
      query: {},
      request: new Request("https://document.invalid/content", {
        method: "PUT",
      }),
      key,
      version: reserved.version,
      content: async () => {
        const object = await attachment.open();
        return readBinaryContent(
          new Request("https://document.invalid/content", {
            method: "PUT",
            body: object.body,
          }),
        );
      },
      command: async (op, data) =>
        op.endsWith(".begin")
          ? beginUpload(
              ctx,
              actor,
              found.id,
              reserved.id,
              data.version,
              key,
              access,
            )
          : recordUpload(
              ctx,
              actor,
              found.id,
              reserved.id,
              data.version,
              data.upload_attempt,
              access,
            ),
    })) as { upload_attempt: string };
    await completeDocument(
      ctx,
      actor,
      found.id,
      reserved.id,
      reserved.version,
      uploaded.upload_attempt,
      key,
      access,
    );
  }
  await reply("Documento recebido e vinculado à ordem informada.");
  return true;
};
