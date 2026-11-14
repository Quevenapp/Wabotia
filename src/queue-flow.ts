// WhatsApp side of the ticket queue (docs/FILA-SENHAS.md, "WhatsApp").
// Called from processInbox; every reply goes through enqueue with a key tied
// to the inbox row, so a replayed row never repeats a message or a ticket.
import { all, one, exec } from "./db";
import { ApiError, type Conversation, type Env, json, now } from "./types";
import { enqueue, settings } from "./service";
import {
  activeBlock,
  activeTicketFor,
  blockMessage,
  customerCancel,
  estimateMinutes,
  issueTicket,
  linkKioskTicket,
  normalizePhone,
  queueSettings,
  serviceDay,
  serviceMinutes,
  ticketView,
} from "./queue";

export const QUEUE_PROMPT_MS = 10 * 60000;
export const QUEUE_REPLY = "wqueue:";

type Step = "pick" | "confirm" | "type";

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();

async function interactiveLine(env: Env, c: Conversation) {
  if (!c.connection_id || c.chat_type === "group") return false;
  const line = await one(
    env,
    "SELECT kind FROM connections WHERE id=?",
    c.connection_id,
  );
  return ["meta", "zernio"].includes(line?.kind);
}

/** Text with numbered options; reply buttons (≤3) or a list where supported. */
async function ask(
  env: Env,
  c: Conversation,
  body: string,
  options: { id: string; title: string }[],
  key: string,
) {
  const numbered = `${body}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join("\n")}`;
  const interactive = await interactiveLine(env, c);
  const buttons =
    options.length <= 3 &&
    options.every((o) => Array.from(o.title).length <= 20);
  return enqueue(
    env,
    c,
    "system",
    "text",
    {
      text: numbered,
      automation: "queue",
      ...(interactive && options.length <= 10
        ? {
            content: {
              type: "interactive",
              interactive: buttons
                ? {
                    type: "button",
                    body: { text: Array.from(body).slice(0, 1024).join("") },
                    action: {
                      buttons: options.map((o) => ({
                        type: "reply",
                        reply: {
                          id: `${QUEUE_REPLY}${c.session}:${o.id}`,
                          title: o.title,
                        },
                      })),
                    },
                  }
                : {
                    type: "list",
                    body: { text: Array.from(body).slice(0, 1024).join("") },
                    action: {
                      button: "Escolher fila",
                      sections: [
                        {
                          title: "Filas",
                          rows: options.map((o) => ({
                            id: `${QUEUE_REPLY}${c.session}:${o.id}`,
                            title: Array.from(o.title).slice(0, 24).join(""),
                          })),
                        },
                      ],
                    },
                  },
            },
          }
        : {}),
    },
    key,
  );
}

const say = (env: Env, c: Conversation, text: string, key: string) =>
  enqueue(env, c, "system", "text", { text, automation: "queue" }, key);

async function setPrompt(
  env: Env,
  c: Conversation,
  step: Step | null,
  queueId: string | null,
  source: string | null,
) {
  await exec(
    env,
    "UPDATE conversations SET queue_prompt_step=?,queue_prompt_queue_id=?,queue_prompt_session=?,queue_prompt_source=?,queue_prompt_expires_at=? WHERE id=?",
    step,
    queueId,
    step ? c.session : null,
    source,
    step ? now() + QUEUE_PROMPT_MS : null,
    c.id,
  );
}
export const clearQueuePrompt = (env: Env, c: Conversation) =>
  setPrompt(env, c, null, null, null);

/** Queues offered on WhatsApp, optionally only the one a menu points to. */
export async function whatsappQueues(
  env: Env,
  profile: string,
  only?: string | null,
) {
  return (
    await all(
      env,
      "SELECT * FROM queues WHERE profile_id=? AND enabled=1 ORDER BY sort,name,id",
      profile,
    )
  ).filter(
    (q) =>
      json(q.channels, []).includes("whatsapp") && (!only || q.id === only),
  );
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

async function statusText(env: Env, ticket: any) {
  const view = await ticketView(env, ticket, { link: false });
  if (view.status === "waiting")
    return `Sua senha é *${view.code}* (${view.queue_name}${view.preferential ? ", preferencial" : ""}).\n${
      view.ahead
        ? `${plural(view.ahead, "pessoa", "pessoas")} à sua frente, espera estimada de ${view.wait_minutes} min.`
        : "Você é o próximo!"
    }\n\nAvisaremos aqui quando for chamada. Envie SENHA para ver sua posição ou SAIR para desistir.`;
  return `Sua senha *${view.code}* foi chamada${view.counter_name ? `: dirija-se ao ${view.counter_name}` : ""}.`;
}

/** "Fila Geral — Senha normal: 4 pessoas aguardando, ~35 min…" */
async function waitText(env: Env, queue: any) {
  const counts = await one(
    env,
    "SELECT sum(preferential=0) normal,sum(preferential=1) preferential FROM queue_tickets WHERE queue_id=? AND service_day=? AND status='waiting'",
    queue.id,
    serviceDay(),
  );
  const normal = counts?.normal || 0,
    preferential = counts?.preferential || 0;
  const minutes = await serviceMinutes(env, queue);
  const open =
    (
      await one(
        env,
        "SELECT count(*) n FROM counters c WHERE c.profile_id=? AND c.enabled=1 AND c.status='open' AND EXISTS(SELECT 1 FROM json_each(c.queue_ids) WHERE value=?)",
        queue.profile_id,
        queue.id,
      )
    )?.n || 0;
  const line = (label: string, waiting: number, ahead: number) =>
    `Senha ${label}: ${plural(waiting, "pessoa aguardando", "pessoas aguardando")}, espera estimada de ${estimateMinutes(ahead, minutes, open)} min.`;
  return `*${queue.name}*\n${line("normal", normal, normal + preferential)}\n${line("preferencial", preferential, preferential)}${
    open
      ? ""
      : "\n\nNo momento nenhum guichê está aberto; a espera pode ser maior."
  }`;
}

const confirmOptions = [
  { id: "yes", title: "Sim" },
  { id: "no", title: "Não" },
  { id: "menu", title: "Voltar ao menu" },
];
const typeOptions = [
  { id: "normal", title: "Normal" },
  { id: "preferential", title: "Preferencial" },
  { id: "back", title: "Voltar" },
];

async function askConfirm(
  env: Env,
  c: Conversation,
  queue: any,
  key: string,
  source: string,
) {
  await ask(
    env,
    c,
    `${await waitText(env, queue)}\n\nDeseja entrar na fila?`,
    confirmOptions,
    key,
  );
  await setPrompt(env, c, "confirm", queue.id, source);
}
async function askType(
  env: Env,
  c: Conversation,
  queue: any,
  key: string,
  source: string,
) {
  await ask(
    env,
    c,
    `Qual tipo de senha?${queue.preferential_notice ? `\n\n${queue.preferential_notice}` : ""}`,
    typeOptions,
    key,
  );
  await setPrompt(env, c, "type", queue.id, source);
}

/**
 * Menu option "Entrar na fila de espera". Shows the active ticket, the block
 * notice, the queue choice or the wait with Sim / Não / Voltar ao menu.
 */
export async function startQueue(
  env: Env,
  c: Conversation,
  queueId: string | null,
  rowId: string,
) {
  const phone = normalizePhone(c.phone || c.external_id);
  const active = await activeTicketFor(env, c.profile_id, phone);
  if (active) {
    await say(env, c, await statusText(env, active), `queue-status:${rowId}`);
    return;
  }
  const block = await activeBlock(env, c.profile_id, phone);
  if (block) {
    await say(env, c, blockMessage(block), `queue-blocked:${rowId}`);
    return;
  }
  const queues = await whatsappQueues(env, c.profile_id, queueId);
  if (!queues.length) {
    await say(
      env,
      c,
      "No momento a fila de espera pelo WhatsApp não está disponível. Envie MENU para ver as opções.",
      `queue-none:${rowId}`,
    );
    return;
  }
  if (queues.length === 1) {
    await askConfirm(env, c, queues[0], `queue-confirm:${rowId}`, rowId);
    return;
  }
  await ask(
    env,
    c,
    "Em qual fila você quer entrar?",
    queues.slice(0, 10).map((q) => ({ id: "q-" + q.id, title: q.name })),
    `queue-pick:${rowId}`,
  );
  await setPrompt(env, c, "pick", null, rowId);
}

/** Maps a button id or typed answer to an option id of the current step. */
function answer(
  c: Conversation,
  step: Step,
  value: string,
  replyId: string | undefined,
  queues: any[],
) {
  if (replyId) {
    const prefix = `${QUEUE_REPLY}${c.session}:`;
    return replyId.startsWith(prefix) ? replyId.slice(prefix.length) : null;
  }
  const n = normalize(value);
  if (["menu"].includes(n)) return "menu";
  if (step === "pick") {
    const index = /^\d+$/.test(n) ? Number(n) - 1 : -1;
    const q =
      queues[index] || queues.find((item) => normalize(item.name) === n);
    return q ? "q-" + q.id : null;
  }
  if (step === "confirm") {
    if (/^(1|sim|s|quero|yes|ok|pode)$/.test(n)) return "yes";
    if (/^(2|nao|n|no|agora nao)$/.test(n)) return "no";
    if (/^(3|voltar|voltar ao menu)$/.test(n)) return "menu";
    return null;
  }
  if (/^(1|normal|comum)$/.test(n)) return "normal";
  if (/^(2|preferencial|prioritaria|prioridade)$/.test(n))
    return "preferential";
  if (/^(3|voltar)$/.test(n)) return "back";
  return null;
}

export interface QueueTurn {
  /** true when the message was fully handled here. */
  handled: boolean;
  /** Show the main menu (Voltar ao menu). */
  menu?: boolean;
}

/**
 * Handles the queue part of an inbound message: kiosk link, commands of a
 * contact with an active ticket and the open prompt. `handled: false` lets the
 * engine continue with menus, bots and handoff.
 */
export async function queueTurn(
  env: Env,
  c: Conversation,
  row: { id: string; created: number },
  value: string,
  replyId: string | undefined,
): Promise<QueueTurn> {
  if (c.chat_type === "group") return { handled: false };
  const n = normalize(value);
  const phone = normalizePhone(c.phone || c.external_id);

  // Coupon QR: "SENHA N023 AB12CD".
  const kiosk = /^senha\s+([a-z]{1,3}\d{3,4})\s+([a-z2-9]{6})$/i.exec(
    value.trim(),
  );
  if (kiosk && !replyId) {
    const { ticket, blocked } = await linkKioskTicket(
      env,
      c,
      kiosk[1],
      kiosk[2],
    );
    await say(
      env,
      c,
      !ticket
        ? "Não encontramos essa senha ativa hoje. Confira o código no cupom ou procure o atendimento."
        : blocked
          ? `${blockMessage(blocked)} Sua senha ${ticket.code} continua válida no balcão.`
          : `Pronto! Vamos avisar por aqui.\n\n${await statusText(env, ticket)}`,
      `queue-link:${row.id}`,
    );
    return { handled: true };
  }

  const prompt =
    !!c.queue_prompt_step &&
    c.queue_prompt_session === c.session &&
    c.queue_prompt_source !== row.id &&
    row.created < (c.queue_prompt_expires_at || 0);

  if (!prompt && replyId?.startsWith(QUEUE_REPLY)) {
    await say(
      env,
      c,
      "Esta opção expirou. Envie MENU para ver as opções de novo.",
      `queue-expired:${row.id}`,
    );
    return { handled: true };
  }

  const active = !prompt
    ? await activeTicketFor(env, c.profile_id, phone)
    : null;
  if (active && !replyId) {
    if (/^(senha|minha senha|status|posicao|fila|minha vez)$/.test(n)) {
      await say(
        env,
        c,
        await statusText(env, active),
        `queue-status:${row.id}`,
      );
      return { handled: true };
    }
    if (/^(sair|desistir|cancelar senha|sair da fila)$/.test(n)) {
      const done = await customerCancel(env, active);
      await say(
        env,
        c,
        done
          ? `Senha ${active.code} cancelada. Se precisar, envie MENU para entrar na fila de novo.`
          : `A senha ${active.code} já está em atendimento e não pode ser cancelada por aqui.`,
        `queue-leave:${row.id}`,
      );
      return { handled: true };
    }
  }
  if (!prompt) return { handled: false };

  const step = c.queue_prompt_step as Step;
  const queues = await whatsappQueues(env, c.profile_id);
  const choice = answer(c, step, value, replyId, queues);
  if (choice === "menu") {
    await clearQueuePrompt(env, c);
    return { handled: true, menu: true };
  }
  if (!choice) {
    // Something else: leave the prompt and let the message follow its path.
    await clearQueuePrompt(env, c);
    return { handled: false };
  }
  if (step === "pick") {
    const queue = queues.find((q) => "q-" + q.id === choice);
    if (!queue) {
      await clearQueuePrompt(env, c);
      return { handled: false };
    }
    await askConfirm(env, c, queue, `queue-confirm:${row.id}`, row.id);
    return { handled: true };
  }
  const queue = queues.find((q) => q.id === c.queue_prompt_queue_id);
  if (!queue) {
    await clearQueuePrompt(env, c);
    await say(
      env,
      c,
      "Esta fila não está mais disponível. Envie MENU para ver as opções.",
      `queue-gone:${row.id}`,
    );
    return { handled: true };
  }
  if (step === "confirm") {
    if (choice === "no") {
      await clearQueuePrompt(env, c);
      await say(
        env,
        c,
        "Tudo bem! Se mudar de ideia, envie MENU.",
        `queue-no:${row.id}`,
      );
      return { handled: true };
    }
    await askType(env, c, queue, `queue-type:${row.id}`, row.id);
    return { handled: true };
  }
  // step === "type"
  if (choice === "back") {
    await askConfirm(env, c, queue, `queue-confirm:${row.id}`, row.id);
    return { handled: true };
  }
  await clearQueuePrompt(env, c);
  try {
    const { ticket } = await issueTicket(env, c.profile_id, {
      queueId: queue.id,
      preferential: choice === "preferential",
      source: "whatsapp",
      actorId: "customer",
      conversationId: c.id,
      phone,
      sourceKey: `queue-inbox:${row.id}`,
    });
    // The contact may have had a ticket from the kiosk without a conversation.
    if (!ticket.conversation_id)
      await exec(
        env,
        "UPDATE queue_tickets SET conversation_id=? WHERE id=?",
        c.id,
        ticket.id,
      );
    await say(env, c, await statusText(env, ticket), `queue-issued:${row.id}`);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await say(env, c, error.message, `queue-refused:${row.id}`);
  }
  return { handled: true };
}

/**
 * Front door of the queue: with `queue.front_door` on, the first message of
 * each session gets the main menu (or the active ticket), whatever its text,
 * even when a bot would answer. Returns true when it answered.
 */
export async function queueFrontDoor(
  env: Env,
  c: Conversation,
  rowId: string,
  showMenu: () => Promise<boolean>,
) {
  if (c.chat_type === "group" || c.queue_menu_session === c.session)
    return false;
  const cfg = queueSettings(await settings(env, c.profile_id));
  if (!cfg.front_door) return false;
  const active = await activeTicketFor(
    env,
    c.profile_id,
    normalizePhone(c.phone || c.external_id),
  );
  if (active) {
    await say(env, c, await statusText(env, active), `queue-front:${rowId}`);
  } else if (!(await showMenu())) return false;
  await exec(
    env,
    "UPDATE conversations SET queue_menu_session=? WHERE id=?",
    c.session,
    c.id,
  );
  return true;
}
