// Entregador sem login (QR da entrega) e conversa da entrega. Regras em
// docs/ENTREGA.md, "Entregador pelo QR" e "Conversa".
//
// - A loja gera o QR da entrega (painel ao despachar, via impressa). O app lê
//   em "Escanear pedido" e troca por uma credencial só desta entrega
//   (src/module-credentials.ts): ver o destino e o resumo, mandar posição,
//   conversar e concluir. Revogada ao concluir ou cancelar.
// - Conversa: canal "store" (entregador e loja, interna, também como nota na
//   conversa do cliente) e "customer" (entregador e cliente: sai pelo
//   WhatsApp da loja como "Nome - Entregador: …"; a resposta do cliente volta
//   ao app enquanto a entrega está aberta). O entregador nunca vê o telefone.
import { all, exec, one } from "../../db";
import { ApiError, type Actor, type Conversation, now, requireValue } from "../../types";
import type { ModuleContext } from "../api";
import {
  appParams,
  config,
  courierSafe,
  deliveryView,
  eventPayload,
  hhmm,
  history,
  isCourierOf,
  loadDelivery,
  OPEN,
  pedidoActor,
  pedidoOrder,
  type DeliveryRow,
} from "./store";
import { windowOpen } from "./notify";
import { storeRef } from "./address";

const firstName = (name: string) =>
  String(name || "").trim().split(/\s+/)[0]?.slice(0, 40) || "";

// ---------------------------------------------------------------------------
// QR

/**
 * QR da entrega (equipe): revoga o anterior e a credencial ativa. Devolve o
 * endereço do QR, a validade e o que a via impressa leva.
 */
export async function issueQr(ctx: ModuleContext, actor: Actor, data: any) {
  ctx.access(actor, "conversations:write");
  requireValue(!actor.credential, "Este acesso vale só para a entrega do QR.");
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  requireValue(OPEN.includes(row.status), "A entrega já terminou.");
  const qr = await ctx.issueCredential(row.id, {
    actor: actor.id,
    claimMinutes: cfg.qr.claim_minutes,
    ttlMinutes: cfg.qr.credential_hours * 60,
  });
  await history(ctx, row.id, "qr", actor.id, "QR gerado.");
  const est = await ctx.establishment();
  return {
    delivery_id: row.id,
    qr: { url: qr.url, expires_at: qr.claim_expires_at },
    // Via impressa (comanda): o QR, o rótulo e como usar. O endereço e os
    // itens já estão na comanda do pedido.
    slip: {
      title: `ENTREGA · ${row.label}`,
      qr: qr.url,
      lines: [
        est.name,
        `Entregador: abra o app Vinki e toque em Escanear pedido.`,
        `QR válido até ${hhmm(qr.claim_expires_at)}; vale para uma leitura.`,
      ],
    },
    access: await ctx.credentials(row.id),
  };
}

/**
 * O app leu o QR (onCredentialClaim, no Coordinator): quem leu vira o
 * entregador da entrega. A primeira leitura vence; a loja vê o nome, o
 * aparelho e a hora em `access` e pode gerar outro QR, que revoga este.
 */
export async function qrClaimed(ctx: ModuleContext, credential: any) {
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, credential.subject);
  if (!OPEN.includes(row.status))
    throw new ApiError(410, "delivery_closed", "Esta entrega já terminou.");
  const courierId = `cred:${credential.id}`;
  const name = firstName(credential.label);
  const at = now();
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET courier_id=?,courier_name=?,courier_kind='qr',status=CASE WHEN status='pending' THEN 'assigned' ELSE status END,assigned_at=?,updated=? WHERE id=?",
    courierId,
    name,
    at,
    at,
    row.id,
  );
  await history(
    ctx,
    row.id,
    "assigned",
    courierId,
    `QR lido por ${credential.label}${credential.device ? ` (${credential.device})` : ""}.`,
  );
  const fresh = await loadDelivery(ctx, row.id);
  const view = deliveryView(fresh, cfg);
  await ctx.publish("entrega.qr_claimed", row.id, {
    ...eventPayload(view),
    credential_id: credential.id,
    name: credential.label,
    device: credential.device,
  }, { key: `${row.id}:qr:${credential.id}` });
  await ctx.publish("entrega.assigned", row.id, eventPayload(view), {
    key: `${row.id}:assigned:${courierId}`,
  });
  // Aviso imediato à loja (revisão A, item 4): nota na conversa do pedido,
  // com quem leu, para conferir no balcão e gerar outro QR se não for ele.
  if (fresh.conversation_id)
    try {
      await ctx.note(
        await ctx.conversation(fresh.conversation_id),
        `QR da entrega (${row.label}) lido por ${credential.label}${credential.device ? `, ${credential.device}` : ""}, às ${hhmm(at)}. Não é o entregador? Gere outro QR na entrega: o acesso de quem leu cai na hora.`,
        { key: `qr-claimed:${credential.id}` },
      );
    } catch {
      // A leitura vale mesmo sem a nota (conversa apagada ou de grupo).
    }
  return {
    delivery: courierSafe(view),
    // A loja como referência: o app procura o destino perto dela.
    store: await storeRef(ctx),
    app: appParams(cfg, fresh),
  };
}

// ---------------------------------------------------------------------------
// Visão do entregador

/**
 * GET entrega/deliveries/:id/courier: o que o app do entregador mostra (pela
 * credencial do QR ou pela pessoa atribuída): destino, resumo do pedido para
 * conferir e cobrar, situação, conversa e os parâmetros do GPS.
 */
export async function courierDelivery(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  const row = await loadDelivery(ctx, id);
  if (!isCourierOf(actor, row))
    throw new ApiError(
      403,
      "not_your_delivery",
      "Só o entregador desta entrega pode fazer isso.",
    );
  const cfg = await config(ctx);
  let order: any = null;
  if (row.source === "pedido" && OPEN.includes(row.status))
    try {
      const o = await pedidoOrder(ctx, pedidoActor(ctx, actor), row.source_ref);
      order = {
        number: o.number,
        lines: (o.lines || []).map((l: any) => ({
          name: l.name,
          quantity: l.quantity,
          options: (l.options || []).map((x: any) => x.name),
          note: l.note || "",
        })),
        item_count: o.item_count,
        total_cents: o.total_cents,
        customer_note: o.note || "",
        payment: o.payment
          ? {
              method_label: o.payment.method_label,
              status: o.payment.status,
              status_label: o.payment.status_label,
              paid: o.payment.status === "paid",
              change_for_cents: o.payment.change_for_cents ?? null,
            }
          : null,
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  return {
    ...courierSafe(deliveryView(row, cfg)),
    order,
    // Código de confirmação: só se é exigido e quantas tentativas restam
    // (o código em si nunca vai ao entregador).
    confirm: {
      required: !!(row as any).confirm_code,
      attempts_left: (row as any).confirm_code
        ? Math.max(0, cfg.confirm_code.attempts - ((row as any).confirm_attempts || 0))
        : null,
    },
    chat: {
      last_seq: await lastSeq(ctx, row.id),
      customer_open: await customerChannelOpen(ctx, row),
    },
    // A loja como referência: sem `destination`, o app procura o endereço
    // perto dela (não perto do entregador).
    store: await storeRef(ctx),
    app: appParams(cfg, row),
  };
}

// ---------------------------------------------------------------------------
// Conversa

export const lastSeq = async (ctx: ModuleContext, id: string) =>
  (
    await one(
      ctx.env,
      "SELECT max(seq) seq FROM entrega_messages WHERE delivery_id=?",
      id,
    )
  )?.seq || 0;

async function conversationOf(ctx: ModuleContext, row: DeliveryRow) {
  if (!row.conversation_id) return null;
  try {
    return await ctx.conversation(row.conversation_id);
  } catch {
    return null;
  }
}

/** Canal com o cliente: entrega aberta, com conversa e janela de 24 h aberta. */
async function customerChannelOpen(ctx: ModuleContext, row: DeliveryRow) {
  if (!OPEN.includes(row.status) || !row.courier_id) return false;
  const c = await conversationOf(ctx, row);
  return !!c && windowOpen(c);
}

const messageView = (m: any) => ({
  seq: m.seq,
  channel: m.channel as "store" | "customer",
  sender: m.sender as "courier" | "store" | "customer",
  author_name: m.author_name,
  text: m.text,
  created: m.created,
});

async function insertMessage(
  ctx: ModuleContext,
  m: {
    id: string;
    delivery: string;
    channel: "store" | "customer";
    sender: "courier" | "store" | "customer";
    author: string;
    author_name: string;
    text: string;
  },
) {
  await exec(
    ctx.env,
    "INSERT OR IGNORE INTO entrega_messages(id,profile_id,delivery_id,channel,sender,author,author_name,text,created) VALUES(?,?,?,?,?,?,?,?,?)",
    m.id,
    ctx.profile,
    m.delivery,
    m.channel,
    m.sender,
    m.author,
    m.author_name,
    m.text,
    now(),
  );
  return one(ctx.env, "SELECT * FROM entrega_messages WHERE id=?", m.id);
}

/** GET …/messages?after=<seq>: até 100 mensagens dos dois canais, em ordem. */
export async function listMessages(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
  query: Record<string, string>,
) {
  const row = await loadDelivery(ctx, id);
  if (!isCourierOf(actor, row)) {
    if (actor.credential)
      throw new ApiError(403, "not_your_delivery", "Só o entregador desta entrega pode fazer isso.");
    ctx.access(actor, "conversations:read");
  }
  const after = Math.max(0, Number(query.after) || 0);
  const rows = await all(
    ctx.env,
    "SELECT * FROM entrega_messages WHERE delivery_id=? AND profile_id=? AND seq>? ORDER BY seq LIMIT 100",
    row.id,
    ctx.profile,
    after,
  );
  return {
    data: rows.map(messageView),
    last_seq: rows.length ? rows[rows.length - 1].seq : after,
    customer_open: await customerChannelOpen(ctx, row),
    open: OPEN.includes(row.status),
  };
}

/**
 * POST …/messages {channel, text}: o entregador escreve à loja ("store") ou
 * ao cliente ("customer"); a equipe escreve ao entregador ("store").
 */
export async function sendMessage(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  const row = await loadDelivery(ctx, data.id);
  const courier = isCourierOf(actor, row);
  if (!courier) {
    if (actor.credential)
      throw new ApiError(403, "not_your_delivery", "Só o entregador desta entrega pode fazer isso.");
    ctx.access(actor, "conversations:write");
  }
  requireValue(
    OPEN.includes(row.status) && row.courier_id,
    "A conversa desta entrega está fechada.",
  );
  const channel = data.channel ?? "store";
  requireValue(
    channel === "store" || (courier && channel === "customer"),
    courier ? "channel: store ou customer." : "A equipe escreve ao entregador pelo canal store.",
  );
  const text = typeof data.text === "string" ? data.text.trim() : "";
  requireValue(
    text && Array.from(text).length <= 1000,
    "Mensagem de 1 a 1000 caracteres.",
  );
  const name = courier ? row.courier_name || "Entregador" : actor.name || "Loja";
  const c = await conversationOf(ctx, row);
  if (channel === "customer") {
    if (!c)
      throw new ApiError(409, "no_conversation", "Esta entrega não tem conversa com o cliente.");
    // Mensagem livre só com a janela de 24 h aberta (regra da Meta).
    if (!windowOpen(c))
      throw new ApiError(
        409,
        "window_closed",
        "O cliente não escreve para a loja há mais de 24 horas: a mensagem não pode sair pelo WhatsApp. Fale com a loja.",
      );
    await ctx.sendMessage(
      c,
      { text: `${name} - Entregador: ${text}` },
      { key: `chat:${requestId}`, actor: actor.id },
    );
  } else if (c && courier) {
    // A equipe vê a conversa interna também na conversa do cliente.
    await ctx
      .note(c, `Entregador ${name} (${row.label}): ${text}`, {
        key: `chat:${requestId}`,
      })
      .catch(() => undefined);
  }
  const saved = await insertMessage(ctx, {
    id: `${row.id}:${requestId}`,
    delivery: row.id,
    channel,
    sender: courier ? "courier" : "store",
    author: actor.id,
    author_name: name,
    text,
  });
  await ctx.publish(
    "entrega.message",
    row.id,
    {
      id: row.id,
      conversation_id: row.conversation_id,
      channel,
      sender: saved.sender,
      seq: saved.seq,
    },
    { key: `${row.id}:message:${saved.seq}` },
  );
  return messageView(saved);
}

/** Tempo depois da última mensagem do entregador em que a resposta é para ele. */
const REPLY_WINDOW_MS = 30 * 60000;

/**
 * Mensagem do cliente com uma entrega aberta: vai para o app do entregador.
 * Só é "da Entrega" (não segue para menu e bot) quando responde a uma
 * mensagem do entregador dos últimos 30 minutos; senão, segue o caminho de
 * sempre e o entregador recebe uma cópia.
 */
export async function customerTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
) {
  const text = (turn.text || "").trim();
  if (!text || turn.replyId) return false;
  if (/^(menu|voltar|sair)$/i.test(text)) return false;
  const row = await one(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE conversation_id=? AND profile_id=? AND status IN ('assigned','en_route') AND courier_id IS NOT NULL ORDER BY status='en_route' DESC,created DESC LIMIT 1",
    c.id,
    ctx.profile,
  );
  if (!row) return false;
  await insertMessage(ctx, {
    id: `${row.id}:in:${turn.rowId}`,
    delivery: row.id,
    channel: "customer",
    sender: "customer",
    author: "customer",
    author_name: firstName(row.customer_name) || "Cliente",
    text: text.slice(0, 1000),
  });
  const last = await one(
    ctx.env,
    "SELECT max(created) at FROM entrega_messages WHERE delivery_id=? AND channel='customer' AND sender='courier'",
    row.id,
  );
  return !!last?.at && now() - last.at <= REPLY_WINDOW_MS;
}

/** Retenção: a conversa some junto com a posição. */
export async function purgeMessages(ctx: ModuleContext, ids: string[]) {
  for (const id of ids)
    await exec(ctx.env, "DELETE FROM entrega_messages WHERE delivery_id=?", id);
}
