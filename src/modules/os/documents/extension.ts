import type { OsExtension } from "../extensions";
import { archiveDocument, listDocuments, reserveDocument } from "./store";
import {
  beginUpload,
  completeDocument,
  downloadDocument,
  recordUpload,
  uploadHandler,
} from "./transport";
import { receiveDocument, sendDocument } from "./delivery";
import { cleanupDocuments } from "./cleanup";

/** Só I registra este descritor. A importação não altera registros do núcleo. */
export const documentsExtension: OsExtension = {
  id: "documents",
  reads: [],
  writes: [],
  commands: [],
  binaryReads: [],
  binaryUploads: [],
  onConversationTurn: receiveDocument,
  runDue: cleanupDocuments,
  tools: [
    {
      name: "os_documentos",
      description: "Lista documentos compartilháveis do titular da conversa.",
      input: {
        conversation_id: { type: "string" },
        order_id: { type: "string" },
        cursor: { type: "string" },
      },
      required: ["conversation_id", "order_id"],
      call: (args, profile) => ({
        path: `/profiles/${encodeURIComponent(profile)}/service-orders/conversation/${encodeURIComponent(args.conversation_id)}/orders/${encodeURIComponent(args.order_id)}/documents`,
        query: args.cursor ? { cursor: args.cursor } : {},
      }),
    },
  ],
};

for (const privateRoute of [false, true]) {
  const collection = privateRoute ? "private-documents" : "documents";
  const path = `service-orders/:id/${collection}`;
  const op = privateRoute ? "os.private.document" : "os.document";
  const access = { private: privateRoute };
  documentsExtension.reads.push({
    path,
    handler: (ctx, actor, { params, query }) =>
      listDocuments(ctx, actor, params.id, query, access),
  });
  documentsExtension.binaryReads!.push({
    path: `${path}/:document_id/content`,
    handler: (ctx, actor, { params }) =>
      downloadDocument(ctx, actor, params.id, params.document_id, access),
  });
  documentsExtension.binaryUploads!.push({
    path: `${path}/:document_id/content`,
    handler: uploadHandler(privateRoute),
  });
  documentsExtension.writes.push(
    { method: "POST", path, op: `${op}.reserve` },
    {
      method: "POST",
      path: `${path}/:document_id/complete`,
      op: `${op}.complete`,
    },
    {
      method: "POST",
      path: `${path}/:document_id/archive`,
      op: `${op}.archive`,
    },
  );
  documentsExtension.commands.push(
    {
      op: `${op}.reserve`,
      handler: (ctx, actor, data, { requestId }) =>
        reserveDocument(ctx, actor, data.id, data, requestId, access),
    },
    {
      op: `${op}.upload.begin`,
      handler: (ctx, actor, data) =>
        beginUpload(
          ctx,
          actor,
          data.id,
          data.document_id,
          data.version,
          data.upload_key,
          access,
        ),
    },
    {
      op: `${op}.upload.record`,
      handler: (ctx, actor, data) =>
        recordUpload(
          ctx,
          actor,
          data.id,
          data.document_id,
          data.version,
          data.upload_attempt,
          access,
        ),
    },
    {
      op: `${op}.complete`,
      handler: (ctx, actor, data, { requestId }) =>
        completeDocument(
          ctx,
          actor,
          data.id,
          data.document_id,
          data.version,
          data.upload_attempt,
          requestId,
          access,
        ),
    },
    {
      op: `${op}.archive`,
      handler: (ctx, actor, data, { requestId }) =>
        archiveDocument(
          ctx,
          actor,
          data.id,
          data.document_id,
          data.version,
          requestId,
          access,
        ),
    },
  );
}
documentsExtension.reads.unshift({
  path: "service-orders/conversation/:id/orders/:order_id/documents",
  handler: (ctx, actor, { params, query }) =>
    listDocuments(ctx, actor, params.order_id, query, {
      conversation_id: params.id,
    }),
});
documentsExtension.writes.push({
  method: "POST",
  path: "service-orders/:id/documents/:document_id/send",
  op: "os.document.send",
});
documentsExtension.commands.push({
  op: "os.document.send",
  handler: (ctx, actor, data) =>
    sendDocument(
      ctx,
      actor,
      data.id,
      data.document_id,
      data.version,
      data.conversation_id,
    ),
});
