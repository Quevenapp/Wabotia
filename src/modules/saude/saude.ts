// O descritor instala seu provedor cadastral; somente o integrador registra rotas.
import { registerCustomerProvider } from "../../customer/ports";
import { linkSaudeCustomer, saudeCustomerProvider } from "./customer-provider";
import type { BinaryReadHandler, BinaryUploadHandler, onCommand, onRoute } from "../api";
import { audit, auditPage, responsible } from "./access";
import { attachmentUpload, beginUpload, completeUpload, downloadAttachment, listAttachments } from "./documents";
import { exportRecord } from "./export";
import { purge, retentionView } from "./retention";
import { attendance, command, episodes, listSubjects, policy, readSubject, timeline } from "./store";

type CommandHandler = Parameters<typeof onCommand>[2];
type JsonRead = Parameters<BinaryReadHandler>;
const jsonRead = (handler: (...args: JsonRead) => Promise<unknown>): BinaryReadHandler =>
  async (...args) => ({ body: JSON.stringify(await handler(...args)), headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  } });
const base = "saude/subjects/:subject_id";
registerCustomerProvider("saude", saudeCustomerProvider);
export const saudeExtension: {
  binaryReads: { path: string; handler: BinaryReadHandler }[];
  binaryUploads: { path: string; handler: BinaryUploadHandler }[];
  writes: Parameters<typeof onRoute>[1][];
  commands: { op: string; handler: CommandHandler }[];
} = {
  binaryReads: [
    { path: "saude/subjects", handler: jsonRead((ctx, actor, { query }) => listSubjects(ctx, actor, query)) },
    { path: base, handler: jsonRead((ctx, actor, { params }) => readSubject(ctx, actor, params.subject_id)) },
    { path: `${base}/episodes`, handler: jsonRead((ctx, actor, { params, query }) => episodes(ctx, actor, params.subject_id, query)) },
    { path: `${base}/records`, handler: jsonRead((ctx, actor, { params, query }) => timeline(ctx, actor, params.subject_id, query)) },
    { path: `${base}/attachments`, handler: jsonRead((ctx, actor, { params, query }) => listAttachments(ctx, actor, params.subject_id, query)) },
    { path: `${base}/attachments/:document_id/content`, handler: (ctx, actor, { params }) => downloadAttachment(ctx, actor, params.subject_id, params.document_id) },
    { path: `${base}/export`, handler: (ctx, actor, { params }) => exportRecord(ctx, actor, params.subject_id) },
    { path: "saude/audit", handler: jsonRead((ctx, actor, { query }) => auditPage(ctx, actor, query)) },
    { path: "saude/retention/:subject_id", handler: jsonRead((ctx, actor, { params }) => retentionView(ctx, actor, params.subject_id)) },
    { path: "saude/attendance/:order_id", handler: jsonRead((ctx, actor, { params }) => attendance(ctx, actor, params.order_id)) },
    { path: "saude/policy", handler: jsonRead(async (ctx, actor) => {
      await responsible(ctx, actor);
      await audit(ctx, actor, "policy.read", null, ["policy"]);
      return policy(ctx);
    }) },
  ],
  binaryUploads: [{ path: `${base}/attachments/:document_id/content`, handler: attachmentUpload }],
  writes: [], commands: [
    { op: "saude.customer.link", handler: (ctx, actor, data, { requestId }) => linkSaudeCustomer(ctx, actor, data, requestId) },
    { op: "saude.attachment.upload.begin", handler: (ctx, actor, data) => beginUpload(ctx, actor, data.subject_id, data.document_id, data.version, data.upload_key) },
    { op: "saude.attachment.upload.complete", handler: (ctx, actor, data) => completeUpload(ctx, actor, data.subject_id, data.document_id, data.version, data.attempt) },
    { op: "saude.subject.purge", handler: (ctx, actor, data) => purge(ctx, actor, data.subject_id, data.confirm) },
  ],
};
const routes = [
  ["POST", "saude/subjects", "subject.create"],
  ["PUT", "saude/policy", "policy.set"],
  ["POST", `${base}/episodes`, "episode.create"],
  ["POST", `${base}/records`, "record.create"],
  ["PATCH", `${base}/records/:record_id`, "record.edit"],
  ["POST", `${base}/records/:record_id/sign`, "record.sign"],
  ["POST", `${base}/attachments`, "attachment.reserve"],
  ["PUT", `${base}/hold`, "hold.set"],
] as const;
for (const [method, path, op] of routes) {
  saudeExtension.writes.push({ method, path, op: `saude.${op}` });
  saudeExtension.commands.push({ op: `saude.${op}`, handler: (ctx, actor, data, { requestId }) => command(ctx, actor, op, data, requestId) });
}
saudeExtension.writes.push({ method: "POST", path: `${base}/purge`, op: "saude.subject.purge" });
saudeExtension.writes.push({ method: "POST", path: `${base}/contacts`, op: "saude.customer.link" });
