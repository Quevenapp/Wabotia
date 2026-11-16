// Vendas: orçamento. A equipe monta, envia pelo WhatsApp (texto com os itens
// e os botões Aprovar/Recusar, ou um link do passo web com a mesma escolha),
// o cliente responde dentro da validade e a equipe converte em venda. Cada
// envio sobe a versão: botões e links antigos deixam de valer.
import { all, batch, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import type { InteractiveSpec, ModuleContext, WebStep } from "../api";
import {
  QUOTE_LABELS,
  QUOTE_STATUSES,
  clip,
  customerDocument,
  day,
  endOfDayAfter,
  money,
  phoneDigits,
  quantityLabel,
  text,
  vendasSettings,
  type QuoteStatus,
} from "./model";
import { applyTotals, buildLines, lineView, type Line } from "./lines";
import {
  createSale,
  requireSeller,
  saleView,
  type SaleView,
} from "./sales";

export function quoteView(row: any) {
  const lines: Line[] = json(row.lines, []);
  const expired =
    row.status === "sent" && !!row.valid_until && row.valid_until <= now();
  const status = (expired ? "expired" : row.status) as QuoteStatus;
  return {
    id: row.id as string,
    number: row.number as number,
    status,
    status_label: QUOTE_LABELS[status] || status,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone || null,
      document: row.customer_document || null,
      contact_id: row.contact_id || null,
      conversation_id: row.conversation_id || null,
    },
    lines: lines.map(lineView),
    item_count: lines.length,
    subtotal_cents: row.subtotal_cents as number,
    discount_cents: row.discount_cents as number,
    total_cents: row.total_cents as number,
    valid_days: row.valid_days ?? null,
    valid_until: row.valid_until ?? null,
    note: row.note,
    notes: row.notes,
    version: row.version as number,
    sent_at: row.sent_at ?? null,
    sent_via: row.sent_via ?? null,
    web_step_id: row.web_step_id ?? null,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null,
    decided_via: row.decided_via ?? null,
    decision_note: row.decision_note || "",
    sale_id: row.sale_id ?? null,
    created_by: row.created_by,
    created: row.created as number,
    updated: row.updated as number,
  };
}
export type QuoteView = ReturnType<typeof quoteView>;

export function visibleQuote<T extends Partial<QuoteView>>(
  ctx: ModuleContext,
  actor: Actor,
  view: T,
): T {
  const out: any = { ...view };
  if (out.customer && !ctx.mayRead(actor, "contacts")) {
    const { phone: _p, document: _d, ...customer } = out.customer;
    out.customer = customer;
  }
  if (!ctx.mayRead(actor, "notes")) delete out.notes;
  return out;
}

export async function loadQuote(ctx: ModuleContext, id: unknown) {
  const row = await one(
    ctx.env,
    "SELECT * FROM vendas_quotes WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Orçamento não encontrado.");
  return row;
}

const EDITABLE: QuoteStatus[] = ["draft", "sent", "approved", "declined", "expired"];

// ---------------------------------------------------------------------------
// Montar

/**
 * POST vendas/quotes e PUT vendas/quotes/:id: itens, desconto, cliente,
 * validade e textos. Editar um orçamento enviado o volta para rascunho (o
 * cliente nunca aprova um valor que não viu).
 */
export async function saveQuote(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  ctx.access(actor, "conversations:write");
  const existing = data.id ? await loadQuote(ctx, data.id) : null;
  if (existing && !EDITABLE.includes(existing.status))
    throw new ApiError(
      409,
      "quote_closed",
      `O orçamento nº ${existing.number} está "${QUOTE_LABELS[existing.status as QuoteStatus]}" e não pode ser alterado.`,
    );
  const has = (k: string) => Object.hasOwn(data, k) || !existing;
  const lines =
    has("lines") || has("discount_cents") || has("discount_percent")
      ? await applyTotals(
          ctx,
          actor,
          has("lines")
            ? await buildLines(ctx, actor, data.lines, { freePrices: true })
            : (json(existing!.lines, []) as Line[]),
          has("discount_cents") || has("discount_percent")
            ? data
            : {
                discount_cents:
                  existing!.discount_cents -
                  (json(existing!.lines, []) as Line[]).reduce(
                    (s, l) => s + l.discount_cents,
                    0,
                  ),
              },
        )
      : null;
  let c: Conversation | null = null;
  let conversationId = existing?.conversation_id ?? null;
  if (Object.hasOwn(data, "conversation_id")) {
    conversationId = null;
    if (data.conversation_id !== null && data.conversation_id !== "") {
      c = await ctx.conversation(String(data.conversation_id), actor);
      conversationId = c.id;
    }
  }
  const contact = c ? await ctx.contact(c) : null;
  const name = has("customer_name")
    ? text(data.customer_name, 80, "o nome do cliente") ||
      clip(contact?.name || "", 80)
    : existing!.customer_name || clip(contact?.name || "", 80);
  const phone = has("customer_phone")
    ? phoneDigits(
        data.customer_phone || (c && ctx.verifiedPhone(c)) || contact?.phone || "",
      )
    : existing!.customer_phone || phoneDigits((c && ctx.verifiedPhone(c)) || "");
  const document = has("customer_document")
    ? customerDocument(data.customer_document)
    : existing!.customer_document;
  let validDays = existing?.valid_days ?? null;
  if (Object.hasOwn(data, "valid_days")) {
    validDays = data.valid_days ?? null;
    requireValue(
      validDays === null ||
        (Number.isInteger(validDays) && validDays >= 1 && validDays <= 90),
      "Validade: de 1 a 90 dias.",
    );
  }
  const note = has("note")
    ? text(data.note, 1000, "a observação ao cliente")
    : existing!.note;
  const notes = has("notes")
    ? text(data.notes, 2000, "as observações internas")
    : existing!.notes;
  const at = now();
  const id = existing?.id || uid();
  if (existing) {
    const t = lines;
    await batch(ctx.env, [
      [
        "UPDATE vendas_quotes SET status='draft',conversation_id=?,contact_id=?,customer_name=?,customer_phone=?,customer_document=?,lines=?,item_count=?,subtotal_cents=?,discount_cents=?,total_cents=?,valid_days=?,valid_until=NULL,note=?,notes=?,decided_at=NULL,decided_by=NULL,decided_via=NULL,decision_note='',updated=? WHERE id=? AND profile_id=? AND updated=?",
        [
          conversationId,
          c ? (contact?.id ?? null) : existing.contact_id,
          name,
          phone,
          document,
          t ? JSON.stringify(t.lines) : existing.lines,
          t ? t.lines.length : existing.item_count,
          t ? t.subtotal_cents : existing.subtotal_cents,
          t ? t.discount_cents : existing.discount_cents,
          t ? t.total_cents : existing.total_cents,
          validDays,
          note,
          notes,
          at,
          id,
          ctx.profile,
          existing.updated,
        ],
      ],
    ]);
  } else {
    const sourceKey = `command:${actor.id}:${requestId}`;
    const repeated = await one(
      ctx.env,
      "SELECT * FROM vendas_quotes WHERE profile_id=? AND source_key=?",
      ctx.profile,
      sourceKey,
    );
    if (repeated) return quoteView(repeated);
    await batch(ctx.env, [
      [
        "INSERT INTO vendas_counters(profile_id,kind,last) VALUES(?,'quote',1) ON CONFLICT(profile_id,kind) DO UPDATE SET last=last+1",
        [ctx.profile],
      ],
      [
        "INSERT INTO vendas_quotes(id,profile_id,number,status,conversation_id,contact_id,customer_name,customer_phone,customer_document,lines,item_count,subtotal_cents,discount_cents,total_cents,valid_days,note,notes,source_key,created_by,created,updated) VALUES(?,?,(SELECT last FROM vendas_counters WHERE profile_id=? AND kind='quote'),'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          ctx.profile,
          ctx.profile,
          conversationId,
          contact?.id ?? null,
          name,
          phone,
          document,
          JSON.stringify(lines!.lines),
          lines!.lines.length,
          lines!.subtotal_cents,
          lines!.discount_cents,
          lines!.total_cents,
          validDays,
          note,
          notes,
          sourceKey,
          actor.id,
          at,
          at,
        ],
      ],
    ]);
  }
  const row = await loadQuote(ctx, id);
  await ctx.publish(
    "vendas.quote_saved",
    id,
    { quote_id: id, number: row.number, total_cents: row.total_cents, actor: actor.id },
    { key: `saved:${id}:${row.updated}` },
  );
  return quoteView(row);
}

// ---------------------------------------------------------------------------
// Texto ao cliente

export function quoteSummary(row: any, cfg: ReturnType<typeof vendasSettings>) {
  const lines: Line[] = json(row.lines, []);
  const out: string[] = [`*Orçamento nº ${row.number}*`];
  if (cfg.quote_intro) out.push(cfg.quote_intro);
  out.push("");
  for (const l of lines) {
    const q = quantityLabel(l.quantity_milli);
    out.push(
      l.quantity_milli === 1000 && l.unit === "UN"
        ? `• ${l.name}: ${money(l.total_cents)}`
        : `• ${q} ${l.unit} x ${l.name}: ${money(l.total_cents)} (${money(l.unit_cents)} cada)`,
    );
    if (l.discount_cents) out.push(`   desconto de ${money(l.discount_cents)}`);
  }
  out.push("");
  if (row.discount_cents) {
    out.push(`Subtotal: ${money(row.subtotal_cents)}`);
    out.push(`Desconto: ${money(row.discount_cents)}`);
  }
  out.push(`*Total: ${money(row.total_cents)}*`);
  if (row.valid_until) out.push(`Válido até ${day(row.valid_until)}.`);
  if (row.note) out.push("", row.note);
  if (cfg.quote_footer) out.push("", cfg.quote_footer);
  return Array.from(out.join("\n")).slice(0, 3900).join("");
}

export const replyId = (row: any, decision: "approve" | "decline") =>
  `vendas:q:${row.id}:${row.version}:${decision}`;

export function quoteButtons(row: any): InteractiveSpec {
  return {
    type: "button",
    body: `Você aprova o orçamento nº ${row.number} (${money(row.total_cents)})?`,
    buttons: [
      { id: replyId(row, "approve"), title: "Aprovar" },
      { id: replyId(row, "decline"), title: "Recusar" },
    ],
  };
}

const DECISION_OPTIONS = ["Aprovar orçamento", "Recusar orçamento"];

// ---------------------------------------------------------------------------
// Enviar

/**
 * POST vendas/quotes/:id/send {via?: "buttons"|"link", notify?}. Fixa a
 * validade, sobe a versão e manda ao cliente: o texto com os itens e os
 * botões Aprovar/Recusar (padrão), ou o link do passo web com a mesma
 * escolha. notify=false só registra o envio (orçamento entregue em mãos).
 */
export async function sendQuote(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  ctx.access(actor, "conversations:write");
  const row = await loadQuote(ctx, data.id);
  if (!EDITABLE.includes(row.status))
    throw new ApiError(
      409,
      "quote_closed",
      `O orçamento nº ${row.number} está "${QUOTE_LABELS[row.status as QuoteStatus]}" e não pode ser enviado.`,
    );
  const via = data.via ?? "buttons";
  requireValue(via === "buttons" || via === "link", "via: buttons ou link.");
  const notify =
    data.notify !== false &&
    (await ctx.mayNotify(actor, row.conversation_id ?? null));
  if (data.notify !== false && !row.conversation_id)
    throw new ApiError(
      409,
      "no_conversation",
      "Este orçamento não está ligado a uma conversa do WhatsApp. Ligue uma conversa (conversation_id) ou registre o envio sem mensagem (notify: false).",
    );
  const cfg = vendasSettings(await ctx.settings());
  const at = now();
  const days = row.valid_days || cfg.quote_valid_days;
  const validUntil = endOfDayAfter(at, days);
  const version = row.version + 1;
  await batch(ctx.env, [
    [
      "UPDATE vendas_quotes SET status='sent',version=?,sent_at=?,sent_via=?,valid_until=?,web_step_id=NULL,decided_at=NULL,decided_by=NULL,decided_via=NULL,decision_note='',updated=? WHERE id=? AND profile_id=? AND updated=?",
      [
        version,
        at,
        notify ? via : "manual",
        validUntil,
        at,
        row.id,
        ctx.profile,
        row.updated,
      ],
    ],
  ]);
  let next = await loadQuote(ctx, row.id);
  if (next.version !== version)
    throw new ApiError(
      409,
      "quote_conflict",
      "O orçamento mudou enquanto isso. Atualize e tente de novo.",
    );
  let step: WebStep | null = null;
  if (notify) {
    const c = await ctx.conversation(row.conversation_id);
    const summary = quoteSummary(next, cfg);
    const bot = actor.id.startsWith("bot:");
    if (via === "buttons") {
      await ctx.sendMessage(
        c,
        { text: summary },
        { key: `quote:${row.id}:${version}:text`, notification: true, actor: actor.id },
      );
      await ctx.sendInteractive(c, quoteButtons(next), {
        key: `quote:${row.id}:${version}:buttons`,
        notification: true,
        actor: actor.id,
      });
    } else {
      const minutes = Math.max(
        5,
        Math.min(7 * 24 * 60, Math.floor((validUntil - at) / 60000)),
      );
      const opened = await ctx.openWebStep(c, {
        kind: "quote",
        ref: `${row.id}:${version}`,
        trigger: bot ? "bot" : "agent",
        actor: actor.id,
        sourceKey: `quote:${row.id}:${version}`,
        ttlMinutes: minutes,
        text: `Orçamento nº ${next.number}: ${money(next.total_cents)}, válido até ${day(validUntil)}. Veja os itens e responda pelo link:`,
        button: "Ver orçamento",
        spec: {
          title: `Orçamento nº ${next.number}`,
          intro: Array.from(summary.replace(/\*/g, "")).slice(0, 1500).join(""),
          fields: [
            {
              id: "decision",
              type: "choice",
              label: "Sua resposta",
              required: true,
              options: DECISION_OPTIONS,
            },
            {
              id: "note",
              type: "text",
              label: "Observação (opcional)",
              required: false,
              multiline: true,
            },
          ],
          submit_label: "Enviar resposta",
          done_text: "Resposta enviada! A confirmação chega no WhatsApp.",
          return_message: "module",
          ticket: "none",
        },
      } as any);
      step = opened.step;
      await batch(ctx.env, [
        [
          "UPDATE vendas_quotes SET web_step_id=? WHERE id=? AND profile_id=?",
          [opened.step.id, row.id, ctx.profile],
        ],
      ]);
      next = await loadQuote(ctx, row.id);
    }
  }
  await ctx.publish(
    "vendas.quote_sent",
    row.id,
    {
      quote_id: row.id,
      number: next.number,
      total_cents: next.total_cents,
      valid_until: validUntil,
      version,
      via: notify ? via : "manual",
      sent: notify,
      actor: actor.id,
    },
    { key: `sent:${row.id}:${version}` },
  );
  return { ...quoteView(next), web_step: step };
}

// ---------------------------------------------------------------------------
// Resposta do cliente (ou da equipe em nome dele)

export async function decide(
  ctx: ModuleContext,
  row: any,
  decision: unknown,
  by: string,
  via: "whatsapp" | "link" | "panel" | "api",
  note: unknown = "",
) {
  requireValue(
    decision === "approve" || decision === "decline",
    "Informe decision como approve ou decline.",
  );
  const memo = text(clip(note, 500), 500, "a observação");
  if (row.status !== "sent")
    throw new ApiError(
      409,
      "quote_not_pending",
      `O orçamento nº ${row.number} não está aguardando resposta.`,
    );
  if (!row.valid_until || row.valid_until <= now())
    throw new ApiError(
      409,
      "quote_expired",
      `O orçamento nº ${row.number} venceu em ${row.valid_until ? day(row.valid_until) : "—"}. Peça um novo orçamento.`,
    );
  const to = decision === "approve" ? "approved" : "declined";
  const at = now();
  await batch(ctx.env, [
    [
      "UPDATE vendas_quotes SET status=?,decided_at=?,decided_by=?,decided_via=?,decision_note=?,updated=? WHERE id=? AND profile_id=? AND status='sent' AND version=?",
      [to, at, by, via, memo, at, row.id, ctx.profile, row.version],
    ],
  ]);
  const next = await loadQuote(ctx, row.id);
  if (next.status !== to)
    throw new ApiError(
      409,
      "quote_conflict",
      "O orçamento mudou enquanto isso. Atualize e tente de novo.",
    );
  await ctx.publish(
    to === "approved" ? "vendas.quote_approved" : "vendas.quote_declined",
    row.id,
    {
      quote_id: row.id,
      number: row.number,
      total_cents: row.total_cents,
      version: row.version,
      by,
      via,
      note: memo,
    },
    { key: `${to}:${row.id}:${row.version}` },
  );
  if (row.conversation_id && (via === "whatsapp" || via === "link")) {
    const c = await ctx.conversation(row.conversation_id);
    await ctx.note(
      c,
      `Orçamento nº ${row.number} (${money(row.total_cents)}) ${to === "approved" ? "aprovado" : "recusado"} pelo cliente${memo ? `: ${memo}` : "."}`,
      { key: `decision:${row.id}:${row.version}` },
    );
  }
  return next;
}

const decisionReply = (row: any, approved: boolean) =>
  approved
    ? `Orçamento nº ${row.number} aprovado! Já avisamos a equipe, que segue com a venda por aqui.`
    : `Orçamento nº ${row.number} recusado. Se quiser outra proposta, é só responder por aqui.`;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();

/**
 * Resposta pelo WhatsApp: botão (vendas:q:<id>:<versão>:approve|decline),
 * "1"/"2" até 24 h depois do envio (texto numerado da linha QR) ou
 * "APROVAR"/"RECUSAR" (com o número, opcional). true quando era do módulo.
 */
export async function quoteTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId?: string | null; rowId: string },
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const say = (message: string) =>
    ctx.sendMessage(c, { text: message }, { key: `reply:${turn.rowId}` });
  let row: any = null;
  let decision: "approve" | "decline";
  if (turn.replyId) {
    if (!turn.replyId.startsWith("vendas:")) return false;
    const m = /^vendas:q:([^:]+):(\d+):(approve|decline)$/.exec(turn.replyId);
    if (!m) {
      await say("Esta opção não está mais disponível.");
      return true;
    }
    row = await one(
      ctx.env,
      "SELECT * FROM vendas_quotes WHERE id=? AND profile_id=? AND conversation_id=?",
      m[1],
      ctx.profile,
      c.id,
    );
    if (!row) {
      await say("Não encontramos este orçamento.");
      return true;
    }
    if (Number(m[2]) !== row.version) {
      await say(
        `O orçamento nº ${row.number} foi atualizado. Responda à mensagem mais recente.`,
      );
      return true;
    }
    decision = m[3] as "approve" | "decline";
  } else {
    const value = normalize(turn.text || "");
    const digit = /^([12])$/.exec(value);
    const word =
      /^(aprovar|aprovo|aprovado|recusar|recuso|recusado)(?:\s+(?:o\s+)?(?:orcamento\s+)?(?:n[o°º]?\s*)?(\d{1,9}))?$/.exec(
        value,
      );
    if (!digit && !word) return false;
    decision = digit
      ? digit[1] === "1"
        ? "approve"
        : "decline"
      : word![1].startsWith("aprov")
        ? "approve"
        : "decline";
    row = await one(
      ctx.env,
      `SELECT * FROM vendas_quotes WHERE profile_id=? AND conversation_id=? AND status='sent'${word?.[2] ? " AND number=?" : ""} ORDER BY sent_at DESC LIMIT 1`,
      ctx.profile,
      c.id,
      ...(word?.[2] ? [Number(word[2])] : []),
    );
    // "1"/"2" só logo depois do envio; senão é de outro assunto (menu).
    if (!row || (digit && (row.sent_at || 0) < now() - 86_400_000)) return false;
  }
  try {
    const next = await decide(
      ctx,
      row,
      decision,
      `customer:${c.id}`,
      "whatsapp",
    );
    await say(decisionReply(next, decision === "approve"));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await say(
      error.code === "quote_expired"
        ? `O orçamento nº ${row.number} venceu. Peça um novo orçamento por aqui.`
        : `O orçamento nº ${row.number} já foi respondido.`,
    );
  }
  return true;
}

/** Passo web do orçamento concluído: a escolha vale como resposta. */
export async function quoteStepCompleted(
  ctx: ModuleContext,
  step: { ref_id: string | null; id: string; conversation_id: string },
  answers: Record<string, unknown>,
) {
  const [id, version] = String(step.ref_id || "").split(":");
  const row = await one(
    ctx.env,
    "SELECT * FROM vendas_quotes WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) return "Não encontramos este orçamento.";
  if (Number(version) !== row.version)
    return `O orçamento nº ${row.number} foi atualizado. Responda à mensagem mais recente.`;
  const approve = answers.decision === DECISION_OPTIONS[0];
  try {
    const next = await decide(
      ctx,
      row,
      approve ? "approve" : "decline",
      `customer:${step.conversation_id}`,
      "link",
      answers.note,
    );
    return decisionReply(next, approve);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return error.code === "quote_expired"
      ? `O orçamento nº ${row.number} venceu. Peça um novo orçamento por aqui.`
      : `O orçamento nº ${row.number} já foi respondido.`;
  }
}

// ---------------------------------------------------------------------------
// Converter, cancelar, vencer

/**
 * POST vendas/quotes/:id/convert {payments, conversation_id?}: vira venda com
 * os preços e descontos do orçamento (sem o limite de desconto, já aceito).
 * Equipe: só aprovado; administrador: também rascunho, enviado ou vencido.
 */
export async function convertQuote(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
): Promise<{ quote: QuoteView; sale: SaleView }> {
  requireSeller(ctx, actor);
  const row = await loadQuote(ctx, data.id);
  if (row.status === "converted" && row.sale_id) {
    const sale = await one(
      ctx.env,
      "SELECT * FROM vendas_sales WHERE id=? AND profile_id=?",
      row.sale_id,
      ctx.profile,
    );
    return { quote: quoteView(row), sale: saleView(sale) };
  }
  const admin = actor.kind === "user" && actor.role === "admin";
  const allowed: QuoteStatus[] = admin
    ? ["draft", "sent", "approved", "expired"]
    : ["approved"];
  if (!allowed.includes(row.status))
    throw new ApiError(
      409,
      "quote_not_approved",
      admin
        ? `O orçamento nº ${row.number} está "${QUOTE_LABELS[row.status as QuoteStatus]}".`
        : `Só orçamentos aprovados viram venda (o nº ${row.number} está "${QUOTE_LABELS[row.status as QuoteStatus]}"). Um administrador pode converter mesmo assim.`,
    );
  const lines: Line[] = json(row.lines, []);
  const lineDiscount = lines.reduce((s, l) => s + l.discount_cents, 0);
  const sale = await createSale(ctx, actor, {
    lines: null,
    fixedLines: lines,
    fixedTotals: { discount_cents: row.discount_cents - lineDiscount },
    payments: data.payments,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_document: row.customer_document,
    conversation_id:
      data.conversation_id !== undefined
        ? data.conversation_id
        : row.conversation_id,
    note: data.note,
    notes: data.notes,
    source: "quote",
    quote_id: row.id,
    session_id: data.session_id ?? null,
    sourceKey: `quote:${row.id}`,
  });
  const at = now();
  await batch(ctx.env, [
    [
      "UPDATE vendas_quotes SET status='converted',sale_id=?,updated=? WHERE id=? AND profile_id=?",
      [sale.id, at, row.id, ctx.profile],
    ],
  ]);
  await ctx.publish(
    "vendas.quote_converted",
    row.id,
    {
      quote_id: row.id,
      number: row.number,
      sale_id: sale.id,
      sale_number: sale.number,
      actor: actor.id,
    },
    { key: `converted:${row.id}` },
  );
  return { quote: quoteView(await loadQuote(ctx, row.id)), sale };
}

/** POST vendas/quotes/:id/cancel: desiste do orçamento (não volta). */
export async function cancelQuote(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  ctx.access(actor, "conversations:write");
  const row = await loadQuote(ctx, data.id);
  if (row.status === "cancelled") return quoteView(row);
  if (row.status === "converted")
    throw new ApiError(
      409,
      "quote_closed",
      `O orçamento nº ${row.number} já virou venda. Cancele a venda.`,
    );
  const at = now();
  await batch(ctx.env, [
    [
      "UPDATE vendas_quotes SET status='cancelled',decision_note=?,updated=? WHERE id=? AND profile_id=?",
      [text(data.reason, 300, "o motivo"), at, row.id, ctx.profile],
    ],
  ]);
  if (row.web_step_id)
    try {
      await ctx.cancelWebStep(row.web_step_id);
    } catch {
      // Link já fechado.
    }
  return quoteView(await loadQuote(ctx, row.id));
}

/** Tarefa periódica: orçamentos enviados que passaram da validade. */
export async function expireDue(ctx: ModuleContext, at: number) {
  const rows = await all(
    ctx.env,
    "SELECT id,number,version,total_cents,web_step_id FROM vendas_quotes WHERE profile_id=? AND status='sent' AND valid_until<=? LIMIT 50",
    ctx.profile,
    at,
  );
  for (const row of rows) {
    await batch(ctx.env, [
      [
        "UPDATE vendas_quotes SET status='expired',updated=? WHERE id=? AND profile_id=? AND status='sent'",
        [at, row.id, ctx.profile],
      ],
    ]);
    await ctx.publish(
      "vendas.quote_expired",
      row.id,
      { quote_id: row.id, number: row.number, total_cents: row.total_cents },
      { key: `expired:${row.id}:${row.version}` },
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Listas

/** GET vendas/quotes?status=&conversation_id=&q=&limit=&cursor=. */
export async function listQuotes(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"];
  const args: any[] = [ctx.profile];
  if (query.status) {
    const list = query.status.split(",");
    requireValue(
      list.every((s) => (QUOTE_STATUSES as readonly string[]).includes(s)),
      `status: ${QUOTE_STATUSES.join(", ")}.`,
    );
    // "expired" inclui os enviados já vencidos que a rodada ainda não marcou.
    const parts = list.map((s) =>
      s === "expired"
        ? "(status='expired' OR (status='sent' AND valid_until<=?))"
        : s === "sent"
          ? "(status='sent' AND (valid_until IS NULL OR valid_until>?))"
          : "status=?",
    );
    where.push(`(${parts.join(" OR ")})`);
    for (const s of list) args.push(s === "expired" || s === "sent" ? now() : s);
  }
  if (query.conversation_id) {
    where.push("conversation_id=?");
    args.push(query.conversation_id);
  }
  if (query.q) {
    const q = query.q.trim();
    if (/^\d{1,9}$/.test(q)) {
      where.push("(number=? OR customer_phone LIKE ?)");
      args.push(Number(q), `%${q}%`);
    } else {
      where.push("customer_name LIKE ? COLLATE NOCASE");
      args.push(`%${q.slice(0, 60)}%`);
    }
  }
  if (query.cursor) {
    where.push("number<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM vendas_quotes WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    data: page.map(quoteView),
    next_cursor: rows.length > limit ? String(page.at(-1)!.number) : null,
  };
}

/**
 * Orçamentos do cliente da conversa (a própria conversa ou o mesmo telefone
 * autenticado), menos rascunhos e cancelados: para o menu e o bot.
 */
export async function quotesOfCustomer(ctx: ModuleContext, c: Conversation) {
  const phone = ctx.verifiedPhone(c);
  const rows = await all(
    ctx.env,
    `SELECT * FROM vendas_quotes WHERE profile_id=? AND status NOT IN ('draft','cancelled') AND (conversation_id=?${phone ? " OR (customer_phone<>'' AND customer_phone=?)" : ""}) ORDER BY number DESC LIMIT 10`,
    ctx.profile,
    c.id,
    ...(phone ? [phone] : []),
  );
  return rows.map(quoteView);
}

/** Item de menu "Meus orçamentos". */
export async function sendMyQuotes(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  const quotes = (await quotesOfCustomer(ctx, c)).slice(0, 5);
  if (!quotes.length) {
    await ctx.sendMessage(
      c,
      { text: "Você não tem orçamentos com a gente. Envie MENU para ver as opções." },
      { key: `my-quotes:${rowId}` },
    );
    return;
  }
  const lines = quotes.map(
    (q) =>
      `• Nº ${q.number}: ${money(q.total_cents)} · ${q.status_label}${q.status === "sent" && q.valid_until ? ` (válido até ${day(q.valid_until)})` : ""}`,
  );
  await ctx.sendMessage(
    c,
    { text: ["Seus orçamentos:", ...lines].join("\n") },
    { key: `my-quotes:${rowId}` },
  );
  const pending = quotes.find(
    (q) => q.status === "sent" && q.customer.conversation_id === c.id,
  );
  if (pending) {
    const row = await loadQuote(ctx, pending.id);
    await ctx.sendInteractive(c, quoteButtons(row), {
      key: `my-quotes:${rowId}:buttons`,
    });
  }
}
