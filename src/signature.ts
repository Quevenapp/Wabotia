// Identifies who is writing to the customer: "Bruno - Humano", "Bia - IA".
// Added only when the message leaves for the channel; the stored message and
// the panel keep the original text and show the author on their own.
import { one } from "./db";
import type { Env } from "./types";

const clean = (name: unknown) =>
  typeof name === "string"
    ? Array.from(name.replace(/[*_~`\r\n]/g, " ").trim())
        .slice(0, 60)
        .join("")
        .trim()
    : "";

/** Label of the author of an outbox row, or "" for automatic messages. */
export async function senderSignature(env: Env, cfg: any, actor: string) {
  if (cfg?.sender_signature === false || typeof actor !== "string") return "";
  if (actor.startsWith("bot:")) {
    const name = clean(
      (await one(env, "SELECT name FROM bots WHERE id=?", actor.slice(4)))
        ?.name,
    );
    return name ? `${name} - IA` : "";
  }
  // Applications, connectors and the system itself are not a person or a bot.
  if (actor.includes(":") || actor === "system") return "";
  const name = clean(
    (await one(env, "SELECT name FROM users WHERE id=?", actor))?.name,
  );
  return name ? `${name} - Humano` : "";
}

/**
 * The payload as it goes to the channel. Only free text and captions are
 * signed: menus, buttons, templates, notifications, reactions and read
 * receipts keep their exact content.
 */
export async function signedPayload(
  env: Env,
  cfg: any,
  row: { kind: string; actor: string },
  payload: any,
) {
  const type = payload?.content?.type;
  if (
    row.kind !== "text" ||
    typeof payload?.text !== "string" ||
    !payload.text.trim() ||
    payload.template_message ||
    payload.template ||
    (type && !["text", "image", "video", "document"].includes(type))
  )
    return payload;
  const signature = await senderSignature(env, cfg, row.actor);
  return signature
    ? { ...payload, text: `*${signature}*\n${payload.text}` }
    : payload;
}
