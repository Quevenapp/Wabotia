import { batch, exec } from "./db";
import { conversation } from "./service";
import { event } from "./events";
import { type Env, now, json } from "./types";
export async function finishDelivery(env: Env, row: any, external: string) {
  const payload = json(row.payload),
    attachments = payload.media_id
      ? [payload.media_id]
      : payload.attachments || [];
  const writes: [string, any[]][] = [
    [
      "UPDATE outbox SET status='sent',external_id=?,error=NULL,updated=? WHERE id=?",
      [external, now(), row.id],
    ],
  ];
  if (row.kind !== "team")
    writes.push([
      "INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        "delivery:" + row.id,
        row.profile_id,
        row.conversation_id,
        "outbound",
        row.actor,
        payload.text || "",
        JSON.stringify(attachments),
        external,
        now(),
        "delivery:" + row.id,
      ],
    ]);
  await batch(env, writes);
  if (row.kind !== "team")
    await event(env, row.profile_id, "message.sent", row.id, {
      conversation_id: row.conversation_id,
      text: payload.text || "",
      attachments,
    });
  await exec(env, "UPDATE outbox SET completion_handled=1 WHERE id=?", row.id);
}
