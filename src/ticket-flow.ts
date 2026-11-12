import { batch } from "./db";
import { type Env, type Conversation, now } from "./types";
import { enqueue, settings, createTicket, clearTicketPrompt } from "./service";
import {
  defaultTicketQuestion,
  enabledCategory,
  protocolConfirmation,
} from "./protocols";

/** How long the conversation waits for the description after the question. */
export const TICKET_PROMPT_MS = 30 * 60000;

/**
 * True while the conversation waits for the description of a protocol the
 * customer asked to open. `source` is the inbox row being processed: the row
 * that asked the question never answers it, even when it is replayed.
 */
export function awaitingTicketDescription(
  c: Conversation,
  source: string,
  arrived: number,
) {
  return (
    !!c.ticket_prompt_expires_at &&
    c.ticket_prompt_session === c.session &&
    c.ticket_prompt_source !== source &&
    arrived < c.ticket_prompt_expires_at
  );
}

/**
 * Sends the question and marks the conversation as waiting for the
 * description. Queue, state and responsible person stay as they are.
 */
export async function startTicketPrompt(
  env: Env,
  c: Conversation,
  options: { category?: unknown; question?: unknown },
  key: string,
  source: string,
) {
  const question =
    typeof options.question === "string" && options.question.trim()
      ? options.question.trim()
      : defaultTicketQuestion;
  const category = enabledCategory(
    await settings(env, c.profile_id),
    options.category,
  );
  const delivery = await enqueue(
    env,
    c,
    "system",
    "text",
    {
      text: `${question}\n\nPara cancelar, envie MENU.`,
      automation: "protocols",
    },
    key,
  );
  await batch(env, [
    // A description such as "3 dias sem acesso" must not be read as a rating.
    [
      "UPDATE surveys SET status='cancelled' WHERE conversation_id=? AND status='pending'",
      [c.id],
    ],
    [
      "UPDATE conversations SET ticket_prompt_expires_at=?,ticket_prompt_category=?,ticket_prompt_session=?,ticket_prompt_source=? WHERE id=?",
      [now() + TICKET_PROMPT_MS, category, c.session, source, c.id],
    ],
  ]);
  return { delivery_id: delivery, status: "pending" };
}

/**
 * Opens the protocol the customer asked for and sends the confirmation. It is
 * always a new protocol, without a responsible person, and the conversation is
 * not moved to the human queue. `sourceKey` makes a replay return the same one.
 */
export async function openCustomerTicket(
  env: Env,
  c: Conversation,
  description: string,
  category: unknown,
  sourceKey: string,
  key: string,
  author = "customer",
) {
  const cfg = await settings(env, c.profile_id);
  const full = description.trim();
  const title = Array.from(full.replace(/\s+/g, " ")).slice(0, 300).join("");
  const { ticket } = await createTicket(env, c, title, {
    category: enabledCategory(cfg, category),
    owner: null,
    sourceKey,
    description: full,
    descriptionActor: author,
  });
  const delivery = await enqueue(
    env,
    c,
    "system",
    "text",
    { text: protocolConfirmation(cfg, ticket), automation: "protocols" },
    key,
  );
  await clearTicketPrompt(env, c.id);
  return { ticket, delivery_id: delivery };
}
