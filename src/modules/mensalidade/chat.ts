// Mensalidade no WhatsApp: itens de menu "Minhas mensalidades" e "Segunda
// via" e a escolha da parcela (toque na lista ou número na linha QR). O
// cliente só consulta e pede o código de novo; nenhuma mensagem dele dá
// baixa em parcela.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, json, now } from "../../types";
import type { InteractiveSpec, ModuleContext } from "../api";
import {
  dayLabel,
  mensalidadeSettings,
  money,
  periodLabel,
  phoneDigits,
  stamp,
} from "./model";
import { loadInstallment } from "./installments";
import { resendCharge } from "./billing";

export const REPLY_PREFIX = "mensalidade:pix:";
const PROMPT_MINUTES = 30;
const LIST_ROWS = 10;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();

/**
 * Assinaturas do telefone da conversa (ou ligadas a ela). As cadastradas só
 * com o telefone passam a ser desta conversa.
 */
async function customerScope(ctx: ModuleContext, c: Conversation) {
  const phone = phoneDigits(c.phone || c.external_id);
  if (phone.length >= 10)
    await exec(
      ctx.env,
      "UPDATE mensalidade_subscriptions SET conversation_id=? WHERE profile_id=? AND phone=? AND conversation_id IS NULL",
      c.id,
      ctx.profile,
      phone,
    );
  return { phone };
}

const SELECT =
  "SELECT i.*,p.name AS plan_name,s.customer_name FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE i.profile_id=? AND (s.conversation_id=? OR (s.phone<>'' AND s.phone=?))";

/** Parcelas em aberto do cliente da conversa (desta conversa ou do telefone). */
export async function openInstallments(ctx: ModuleContext, c: Conversation) {
  const { phone } = await customerScope(ctx, c);
  return all(
    ctx.env,
    `${SELECT} AND i.status IN ('open','overdue') ORDER BY i.due_date,i.id LIMIT 30`,
    ctx.profile,
    c.id,
    phone,
  );
}

const label = (inst: any) =>
  `${inst.plan_name ? inst.plan_name + " " : ""}${periodLabel(inst.period_key)}`;

const rowTitle = (inst: any) =>
  Array.from(`${periodLabel(inst.period_key)} ${money(inst.amount_cents)}`)
    .slice(0, 24)
    .join("");

/** Texto de "Minhas mensalidades": em aberto (todas) e as últimas pagas. */
export async function statementText(ctx: ModuleContext, c: Conversation) {
  const { phone } = await customerScope(ctx, c);
  const open = await all(
    ctx.env,
    `${SELECT} AND i.status IN ('open','overdue') ORDER BY i.due_date,i.id LIMIT 30`,
    ctx.profile,
    c.id,
    phone,
  );
  const paid = await all(
    ctx.env,
    `${SELECT} AND i.status='paid' ORDER BY i.paid_at DESC LIMIT 3`,
    ctx.profile,
    c.id,
    phone,
  );
  if (!open.length && !paid.length) return { text: "", open };
  const lines: string[] = ["Suas mensalidades"];
  if (open.length) {
    lines.push("", "Em aberto:");
    for (const inst of open)
      lines.push(
        `• ${label(inst)}: ${money(inst.amount_cents)}, ${inst.status === "overdue" ? "venceu em" : "vence em"} ${dayLabel(inst.due_date)}`,
      );
  } else lines.push("", "Nenhuma mensalidade em aberto.");
  if (paid.length) {
    lines.push("", "Pagas:");
    for (const inst of paid)
      lines.push(
        `• ${label(inst)}: ${money(inst.amount_cents)}, paga em ${stamp(inst.paid_at).slice(0, 10)}`,
      );
  }
  return { text: lines.join("\n"), open };
}

/** Lista das parcelas abertas para escolher qual Pix receber. */
async function sendChoice(
  ctx: ModuleContext,
  c: Conversation,
  body: string,
  open: any[],
  rowId: string,
) {
  const rows = open.slice(0, LIST_ROWS).map((inst) => ({
    id: REPLY_PREFIX + inst.id,
    title: rowTitle(inst),
    description: Array.from(
      `${inst.status === "overdue" ? "Venceu" : "Vence"} em ${dayLabel(inst.due_date)}${inst.plan_name ? " · " + inst.plan_name : ""}`,
    )
      .slice(0, 72)
      .join(""),
  }));
  const spec: InteractiveSpec = {
    type: "list",
    body: Array.from(body).slice(0, 1000).join(""),
    button: "Receber o Pix",
    sections: [{ title: "Em aberto", rows }],
  };
  // Linha QR: "1", "2"… escolhem a parcela por 30 minutos.
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_prompts(conversation_id,profile_id,options,expires_at,created) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET options=excluded.options,expires_at=excluded.expires_at,created=excluded.created",
    c.id,
    ctx.profile,
    JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title }))),
    now() + PROMPT_MINUTES * 60000,
    now(),
  );
  await ctx.sendInteractive(c, spec, { key: `lista:${rowId}` });
}

/** Item de menu "Minhas mensalidades". */
export async function menuStatement(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  const { text, open } = await statementText(ctx, c);
  if (!text) {
    await ctx.sendMessage(
      c,
      { text: "Não encontramos mensalidades para este número." },
      { key: `extrato:${rowId}` },
    );
    return;
  }
  if (!open.length) {
    await ctx.sendMessage(c, { text }, { key: `extrato:${rowId}` });
    return;
  }
  await sendChoice(
    ctx,
    c,
    `${text}\n\nPara receber o Pix de uma parcela em aberto, escolha abaixo.`,
    open,
    rowId,
  );
}

/** Item de menu "Segunda via": o código da parcela em aberto. */
export async function menuCopy(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  const open = await openInstallments(ctx, c);
  if (!open.length) {
    await ctx.sendMessage(
      c,
      { text: "Você não tem mensalidade em aberto neste número." },
      { key: `segunda-via:${rowId}` },
    );
    return;
  }
  if (open.length === 1) {
    await payInstallment(ctx, c, open[0].id, rowId);
    return;
  }
  await sendChoice(
    ctx,
    c,
    `Você tem ${open.length} mensalidades em aberto. Qual delas quer pagar?`,
    open,
    rowId,
  );
}

/** Reenvia o Pix (ou link) de uma parcela do próprio cliente. */
async function payInstallment(
  ctx: ModuleContext,
  c: Conversation,
  installmentId: string,
  rowId: string,
) {
  const say = (text: string) =>
    ctx.sendMessage(c, { text }, { key: `turno:${rowId}` });
  const { phone } = await customerScope(ctx, c);
  const own = await one(
    ctx.env,
    `${SELECT} AND i.id=?`,
    ctx.profile,
    c.id,
    phone,
    installmentId,
  );
  if (!own) return say("Não encontramos esta mensalidade para este número.");
  const inst = await loadInstallment(ctx, own.id);
  if (inst.status === "paid")
    return say(
      `A mensalidade ${label(inst)} já está paga (${stamp(inst.paid_at).slice(0, 10)}).`,
    );
  if (!["open", "overdue"].includes(inst.status))
    return say(`A mensalidade ${label(inst)} não está em aberto.`);
  try {
    await resendCharge(ctx, inst, c, `turno:${rowId}`);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const cfg = mensalidadeSettings(await ctx.settings());
    if (error.code === "payments_not_configured")
      return say(
        `Mensalidade ${label(inst)}: ${money(inst.amount_cents)}, ${inst.status === "overdue" ? "venceu em" : "vence em"} ${dayLabel(inst.due_date)}.\n\n${cfg.manual_instructions || "Para pagar, fale com a nossa equipe."}`,
      );
    return say(
      "Não conseguimos gerar o Pix agora. Tente de novo em alguns minutos ou envie MENU para falar com a equipe.",
    );
  }
}

const menuOpenSince = (c: Conversation) =>
  c.menu_active &&
  c.menu_token?.startsWith(c.session + ".") &&
  (c.menu_expires_at || 0) > now()
    ? (c.menu_expires_at || 0) - 86_400_000
    : null;

/**
 * Turno do cliente (onConversationTurn): toque numa parcela da lista
 * (`mensalidade:pix:<id>`) ou, na linha QR, o número da parcela logo depois
 * da lista. Devolve false para o resto (o menu e o bot seguem).
 */
export async function handleTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
) {
  if (c.chat_type === "group") return false;
  if (turn.replyId) {
    if (!turn.replyId.startsWith(REPLY_PREFIX)) return false;
    await exec(
      ctx.env,
      "DELETE FROM mensalidade_prompts WHERE conversation_id=?",
      c.id,
    );
    await payInstallment(
      ctx,
      c,
      turn.replyId.slice(REPLY_PREFIX.length),
      turn.rowId,
    );
    return true;
  }
  const prompt = await one(
    ctx.env,
    "SELECT * FROM mensalidade_prompts WHERE conversation_id=? AND profile_id=?",
    c.id,
    ctx.profile,
  );
  if (!prompt) return false;
  const value = normalize(turn.text || "");
  const stale =
    prompt.expires_at <= now() ||
    ["menu", "voltar", "sair", "0"].includes(value) ||
    (menuOpenSince(c) ?? 0) > prompt.created;
  if (stale) {
    await exec(
      ctx.env,
      "DELETE FROM mensalidade_prompts WHERE conversation_id=?",
      c.id,
    );
    return false;
  }
  const options: { id: string; title: string }[] = json(prompt.options, []);
  const chosen = /^\d+$/.test(value)
    ? options[Number(value) - 1]
    : options.find((o) => normalize(o.title) === value);
  if (!chosen) return false;
  await exec(
    ctx.env,
    "DELETE FROM mensalidade_prompts WHERE conversation_id=?",
    c.id,
  );
  await payInstallment(
    ctx,
    c,
    chosen.id.slice(REPLY_PREFIX.length),
    turn.rowId,
  );
  return true;
}
