// Suporte pago: sessões de liberação, compras avulsas e liberações
// (banco e visões da API). A conversa no WhatsApp está em ./flow.ts.
import { all, batch, exec, one } from "../../db";
import { ApiError, type Conversation, json, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
// Sem ctx para abrir protocolo: a liberação abre o da conversa pelo núcleo.
import { createTicket } from "../../service";
import {
  csv,
  likeAny,
  money,
  pageLimit,
  packageValidity,
  phoneDigits,
  RELEASE_MAX_MS,
  releaseDeadline,
  stamp,
  suporteSettings,
  TICKET_RELEASE_MAX_MS,
  UNLINKED_RELEASE_MS,
  type SupportPackage,
} from "./model";
import { passToTeam, releaseEffectiveEnd } from "./handoff";

import { supportCustomerStatements } from "./customer-provider";
import { eventStatement } from "../../events";
import { integrationCasGuard } from "../../integrations/outbox";
import { IntegrationError } from "../../integrations/privacy";
import {
  supportCommercialContext,
  supportIntegrationStatements,
  supportPaymentEvidence,
  supportReceiptKey,
} from "./integration";

export const SESSION_MINUTES = 120;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Sessões

export async function loadSession(ctx: ModuleContext, id: string) {
  return one(
    ctx.env,
    "SELECT * FROM suporte_sessions WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
}

/** Sessão aberta da conversa (ativa e dentro da validade). */
export async function activeSession(
  ctx: ModuleContext,
  c: Conversation,
  at: number,
) {
  return one(
    ctx.env,
    "SELECT * FROM suporte_sessions WHERE conversation_id=? AND profile_id=? AND status='active' AND expires_at>? ORDER BY created DESC LIMIT 1",
    c.id,
    ctx.profile,
    at,
  );
}

/** Abre uma sessão nova, fechando as anteriores da conversa. */
export async function openSession(
  ctx: ModuleContext,
  c: Conversation,
  step: string,
  at: number,
): Promise<Record<string, any>> {
  const id = uid();
  const customerLinks = await supportCustomerStatements(ctx, c, "sessions", id, at, "conversation");
  // Fecha a anterior e abre a nova no mesmo lote. A linha devolvida pelo
  // INSERT evita uma ida ao D1 só para reler o que acabou de ser gravado.
  const [, inserted] = await batch(ctx.env, [
    [
      "UPDATE suporte_sessions SET status='closed',updated=? WHERE conversation_id=? AND profile_id=? AND status='active'",
      [at, c.id, ctx.profile],
    ],
    [
      "INSERT INTO suporte_sessions(id,profile_id,conversation_id,phone,status,step,expires_at,created,updated) VALUES(?,?,?,?,'active',?,?,?,?) RETURNING *",
      [
        id,
        ctx.profile,
        c.id,
        phoneDigits(ctx.verifiedPhone(c) ?? ""),
        step,
        at + SESSION_MINUTES * 60_000,
        at,
        at,
      ],
    ],
    ...customerLinks,
  ]);
  return inserted.results[0] as Record<string, any>;
}

export async function updateSession(
  ctx: ModuleContext,
  session: any,
  sets: Record<string, any>,
) {
  const at = now();
  const keys = Object.keys(sets);
  // Cada resposta do cliente muda a sessão; RETURNING preserva a linha
  // atualizada sem uma consulta separada a cada mudança de passo.
  return one(
    ctx.env,
    `UPDATE suporte_sessions SET ${keys.map((k) => k + "=?").join(",")},updated=?,expires_at=? WHERE id=? AND profile_id=? RETURNING *`,
    ...keys.map((k) => sets[k]),
    at,
    Math.max(session.expires_at, at + SESSION_MINUTES * 60_000),
    session.id,
    ctx.profile,
  );
}

export function sessionView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    phone: row.phone,
    status: row.status,
    step: row.step,
    attempts: row.attempts,
    payer_id: row.payer_id,
    matched_by: row.matched_by,
    phone_linked: row.phone_linked === null ? null : !!row.phone_linked,
    document: row.document,
    name: row.name,
    offer_kind: row.offer_kind,
    offer_ref: row.offer_ref,
    method: row.method,
    purchase_id: row.purchase_id,
    installment_id: row.installment_id,
    release_id: row.release_id,
    expires_at: row.expires_at,
    created: row.created,
    updated: row.updated,
  };
}

// ---------------------------------------------------------------------------
// Liberações

export const KIND_LABELS: Record<string, string> = {
  subscription: "Assinatura em dia",
  installment: "Mensalidade paga",
  package: "Suporte avulso",
  courtesy: "Cortesia",
  team: "Confirmado pela equipe",
};

export function releaseView(row: any) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    phone: row.phone,
    payer_id: row.payer_id,
    payer_name: row.payer_name,
    kind: row.kind,
    kind_label: KIND_LABELS[row.kind] || row.kind,
    ref_id: row.ref_id,
    phone_linked: !!row.phone_linked,
    valid_until: row.valid_until,
    until_ticket: !!row.until_ticket,
    ticket_id: row.ticket_id ?? null,
    expires_at: releaseDeadline(row),
    reason: row.reason,
    summary: row.summary,
    actor: row.actor,
    status: row.status,
    ended_at: row.ended_at,
    ended_by: row.ended_by,
    created: row.created,
  };
}

export interface ReleaseInput {
  c: Conversation;
  session?: any | null;
  kind: "subscription" | "installment" | "package" | "courtesy" | "team";
  ref?: string | null;
  payer?: { id: string; name: string; document_display?: string | null } | null;
  phone_linked?: boolean;
  /**
   * Fim em horas; sem ele, vale até o protocolo da conversa (aberto agora se
   * não houver) fechar ou a conversa ser resolvida. Telefone não vinculado:
   * no máximo UNLINKED_RELEASE_MS. Prazo absoluto em ./model.ts.
   */
  valid_until?: number | null;
  reason?: string;
  actor: string;
  /** Repetir a chave não grava outra liberação nem passa de novo. */
  sourceKey: string;
  /** false: só registra (o atendente já está com a conversa). */
  pass?: boolean;
  /** Detalhe extra para o atendente (plano, pacote, valor…). */
  detail?: string;
}

/**
 * Grava a liberação (quem, como, por qual pagador e até quando), avisa o
 * cliente e passa a conversa ao setor configurado com um resumo para o
 * atendente. Idempotente pela `sourceKey`.
 */
export async function release(ctx: ModuleContext, input: ReleaseInput) {
  const existing = await one(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE source_key=?",
    input.sourceKey,
  );
  if (existing) {
    // Repetição (gancho repetido pelo núcleo depois de uma falha no meio):
    // completa a sessão, o evento, o aviso e a passagem que podem ter ficado
    // para trás, todos com chave pela liberação (conferência N-4).
    if (existing.status === "active") {
      if (input.session) await markSession(ctx, input.session.id, existing);
      await publishRelease(ctx, existing);
      if (input.pass !== false) await deliverRelease(ctx, existing);
    }
    return { release: existing, created: false };
  }
  const at = now();
  const c = await ctx.conversation(input.c.id);
  const linked = input.phone_linked !== false;
  // Telefone não vinculado ao pagador: sempre curta, em horas.
  let validUntil = input.valid_until ?? null;
  let untilTicket = validUntil === null;
  if (!linked && input.payer) {
    validUntil = Math.min(validUntil ?? Infinity, at + UNLINKED_RELEASE_MS);
    untilTicket = false;
  }
  const expiresAt = Math.min(
    validUntil ?? Infinity,
    at + (untilTicket ? TICKET_RELEASE_MAX_MS : RELEASE_MAX_MS),
  );
  // Presa ao protocolo e à sessão da conversa de agora: protocolo fechado ou
  // conversa resolvida encerram; um protocolo aberto depois não a revive.
  const ticket =
    (await ctx.activeTicket(c)) ??
    (
      await createTicket(
        ctx.env,
        c,
        `Suporte pago: ${KIND_LABELS[input.kind]}`,
        {
          dedupe: true,
          sourceKey: `suporte:${input.sourceKey}`,
        },
      )
    ).ticket;
  const lines = [
    `Suporte pago: ${KIND_LABELS[input.kind]}${input.detail ? ` (${input.detail})` : ""}.`,
    input.payer
      ? `Pagador: ${input.payer.name || "sem nome"}${input.payer.document_display ? ` · ${input.payer.document_display}` : ""}.`
      : "",
    !linked && input.payer
      ? `Atenção: telefone não vinculado ao pagador ${input.payer.name || ""}. Confira e vincule em Dados da conversa → Suporte pago.`
      : "",
    validUntil
      ? `Liberado até ${stamp(validUntil)}.`
      : `Liberado até o protocolo ${ticket.number} fechar.`,
    input.reason ? `Motivo: ${input.reason}` : "",
  ].filter(Boolean);
  const summary = lines.join(" ");
  const id = uid();
  const customerLinks = await supportCustomerStatements(ctx, c, "releases", id, at, input.actor, input.session?.id);
  const [inserted] = await batch(ctx.env, [
    [
      "INSERT INTO suporte_releases(id,profile_id,conversation_id,session_id,phone,payer_id,payer_name,kind,ref_id,phone_linked,valid_until,until_ticket,reason,summary,actor,status,source_key,created,ticket_id,conv_session,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING",
      [
        id,
        ctx.profile,
        c.id,
        input.session?.id ?? null,
        phoneDigits(ctx.verifiedPhone(c) ?? ""),
        input.payer?.id ?? null,
        input.payer?.name ?? "",
        input.kind,
        input.ref ?? null,
        linked ? 1 : 0,
        validUntil,
        untilTicket ? 1 : 0,
        input.reason ?? "",
        summary,
        input.actor,
        input.sourceKey,
        at,
        ticket.id,
        c.session,
        expiresAt,
      ],
    ],
    ...customerLinks,
  ]);
  if (!inserted.meta.changes)
    return {
      release: await one(
        ctx.env,
        "SELECT * FROM suporte_releases WHERE source_key=?",
        input.sourceKey,
      ),
      created: false,
    };
  const row = await one(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE id=?",
    id,
  );
  if (input.session) await markSession(ctx, input.session.id, row);
  await publishRelease(ctx, row);
  if (input.pass !== false) await deliverRelease(ctx, row);
  return { release: row, created: true };
}

/** Sessão que levou à liberação deixa de esperar pagamento. */
async function markSession(ctx: ModuleContext, sessionId: string, row: any) {
  await exec(
    ctx.env,
    "UPDATE suporte_sessions SET status='released',release_id=?,updated=? WHERE id=? AND status<>'released'",
    row.id,
    now(),
    sessionId,
  );
}

/** Evento da liberação, com chave pela liberação (repetir não duplica). */
async function publishRelease(ctx: ModuleContext, row: any) {
  await ctx.publish(
    "suporte.released",
    row.id,
    {
      release_id: row.id,
      conversation_id: row.conversation_id,
      kind: row.kind,
      ref_id: row.ref_id ?? null,
      payer_id: row.payer_id ?? null,
      phone_linked: !!row.phone_linked,
      valid_until: row.valid_until ?? null,
      ticket_id: row.ticket_id,
      expires_at: row.expires_at,
      actor: row.actor,
    },
    { key: row.id },
  );
}

/**
 * Avisa o cliente e passa a conversa ao setor, se ela ainda não está com a
 * equipe. Mensagem e passagem têm chave pela liberação: repetir (o núcleo
 * repete o gancho de pagamento até concluir) não duplica nada.
 */
async function deliverRelease(ctx: ModuleContext, row: any) {
  const cfg = suporteSettings(await ctx.settings());
  const fresh = await ctx.conversation(row.conversation_id);
  if (["human", "waiting"].includes(fresh.state)) return;
  await ctx.sendMessage(
    fresh,
    { text: cfg.texts.released },
    // O pagamento pode ser confirmado depois da janela de 24 h.
    { key: `liberado:${row.id}`, notification: true, purpose: "billing" },
  );
  await passToTeam(ctx, fresh, row.summary, {
    flags: [
      `Suporte pago: ${KIND_LABELS[row.kind]}`,
      ...(!row.phone_linked && row.payer_id ? ["telefone não vinculado"] : []),
    ],
    key: `liberacao:${row.id}`,
  });
}

export async function endRelease(
  ctx: ModuleContext,
  id: unknown,
  actor: string,
  reason = "",
) {
  const row =
    typeof id === "string"
      ? await one(
          ctx.env,
          "SELECT * FROM suporte_releases WHERE id=? AND profile_id=?",
          id,
          ctx.profile,
        )
      : null;
  if (!row) throw new ApiError(404, "not_found", "Liberação não encontrada.");
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE suporte_releases SET status='ended',ended_at=?,ended_by=? WHERE id=? AND status='active'",
    at,
    actor,
    row.id,
  );
  if (result.meta.changes)
    await ctx.publish(
      "suporte.release_ended",
      row.id,
      {
        release_id: row.id,
        conversation_id: row.conversation_id,
        actor,
        reason,
      },
      { key: `${row.id}:ended` },
    );
  return releaseView(
    await one(ctx.env, "SELECT * FROM suporte_releases WHERE id=?", row.id),
  );
}

const page = <T>(rows: T[], limit: number, cursor: (row: T) => string) => ({
  data: rows.slice(0, limit),
  next_cursor: rows.length > limit ? cursor(rows[limit - 1]) : null,
});

/** GET suporte/releases: filtro por forma, estado, conversa, período e busca. */
export async function listReleases(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  for (const [key, column] of [
    ["kind", "kind"],
    ["status", "status"],
    ["conversation_id", "conversation_id"],
    ["payer_id", "payer_id"],
  ] as const) {
    // Sem repetição e com teto: a lista IN fica dentro do limite do D1.
    const values = csv(query[key]);
    if (values.length) {
      where.push(`${column} IN (${values.map(() => "?").join(",")})`);
      args.push(...values);
    }
  }
  if (query.from) {
    where.push("created>=?");
    args.push(Number(query.from) || 0);
  }
  if (query.to) {
    where.push("created<?");
    args.push(Number(query.to) || 0);
  }
  const q = (query.q || "").trim().toLowerCase().slice(0, 100);
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.push(
      `(lower(payer_name) LIKE ? ESCAPE '\\'${digits.length >= 4 ? " OR phone LIKE ?" : ""})`,
    );
    args.push(likeAny(q));
    if (digits.length >= 4) args.push(`%${digits}%`);
  }
  if (query.cursor) {
    where.push("created<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = pageLimit(query.limit, 50, 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM suporte_releases WHERE ${where.join(" AND ")} ORDER BY created DESC,id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        "SELECT kind,count(*) AS n FROM suporte_releases WHERE profile_id=? GROUP BY kind",
        ctx.profile,
      )
    ).map((r) => [r.kind, r.n]),
  );
  const result = page(rows, limit, (row: any) => String(row.created));
  // Ativa que já não vale (protocolo fechado, prazo…): aparece encerrada,
  // com o motivo, mesmo antes de o próximo pedido de humano gravar o fim.
  const at = now();
  const data = [];
  for (const row of result.data) {
    const ended = await releaseEffectiveEnd(ctx, row, at);
    data.push(
      ended
        ? { ...releaseView(row), status: "ended", ended_reason: ended }
        : releaseView(row),
    );
  }
  return { ...result, data, counts };
}

// ---------------------------------------------------------------------------
// Compras avulsas

export const PURCHASE_LABELS: Record<string, string> = {
  pending: "Aguardando pagamento",
  paid: "Paga",
  expired: "Expirada",
  cancelled: "Cancelada",
  refunded: "Estornada",
};

export function purchaseView(row: any) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    payer_id: row.payer_id,
    document: row.document,
    name: row.name,
    phone: row.phone,
    package_id: row.package_id,
    package_name: row.package_name,
    price_cents: row.price_cents,
    mode: row.mode,
    hours: row.hours,
    validity: packageValidity(row),
    method: row.method,
    payment: row.payment_id
      ? {
          id: row.payment_id,
          pix_code: row.pix_code,
          url: row.pay_url,
          expires_at: row.payment_expires_at,
        }
      : null,
    status: row.status,
    status_label: PURCHASE_LABELS[row.status] || row.status,
    /** duplicate_payment | paid_after_cancel | refunded: a equipe confere. */
    attention: row.attention ?? null,
    paid_at: row.paid_at,
    created: row.created,
    updated: row.updated,
  };
}

export async function listPurchases(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  const statuses = csv(query.status);
  if (statuses.length) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (query.conversation_id) {
    where.push("conversation_id=?");
    args.push(query.conversation_id);
  }
  const q = (query.q || "").trim().toLowerCase().slice(0, 100);
  if (q) {
    const compact = q.toUpperCase().replace(/[\s./()+-]/g, "");
    where.push(
      "(lower(name) LIKE ? ESCAPE '\\' OR document LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')",
    );
    args.push(likeAny(q), likeAny(compact), likeAny(compact));
  }
  if (query.cursor) {
    where.push("created<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = pageLimit(query.limit, 50, 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM suporte_purchases WHERE ${where.join(" AND ")} ORDER BY created DESC,id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const counts = Object.fromEntries(
    (
      await all(
        ctx.env,
        "SELECT status,count(*) AS n,sum(price_cents) AS cents FROM suporte_purchases WHERE profile_id=? GROUP BY status",
        ctx.profile,
      )
    ).map((r) => [r.status, r.n]),
  );
  const paid = await one(
    ctx.env,
    "SELECT coalesce(sum(price_cents),0) AS cents FROM suporte_purchases WHERE profile_id=? AND status='paid'",
    ctx.profile,
  );
  const result = page(rows, limit, (row: any) => String(row.created));
  return {
    ...result,
    data: result.data.map(purchaseView),
    counts,
    paid_cents: paid?.cents || 0,
  };
}

/** Pendência para a equipe numa compra (dinheiro em dobro, estorno). */
async function purchaseAttention(
  ctx: ModuleContext,
  purchase: any,
  reason: "duplicate_payment" | "paid_after_cancel" | "refunded",
  payment: Payment,
) {
  await exec(
    ctx.env,
    "UPDATE suporte_purchases SET attention=?,updated=? WHERE id=?",
    reason,
    now(),
    purchase.id,
  );
  await ctx.publish(
    "suporte.purchase_attention",
    purchase.id,
    {
      purchase_id: purchase.id,
      conversation_id: purchase.conversation_id,
      reason,
      payment_id: payment.id,
      amount_cents: payment.amount_cents,
    },
    { key: `${purchase.id}:${reason}:${payment.id}` },
  );
}

/**
 * Cancela a cobrança aberta de uma compra. Já paga no provedor: devolve false
 * (a confirmação conclui a compra); vencida ou cancelada: segue.
 */
async function cancelPurchaseCharge(ctx: ModuleContext, purchase: any) {
  if (!purchase.payment_id || purchase.status !== "pending") return true;
  try {
    await ctx.cancelCharge(purchase.payment_id);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "payment_closed") return false;
  }
  return true;
}

/**
 * Compra um pacote avulso: uma compra por sessão e pacote (`sourceKey`), com
 * uma cobrança valendo por vez. Mesma forma e ainda válida: devolve a mesma.
 * Outra forma, ou vencida: cancela a aberta e cobra de novo. Compras abertas
 * de outra sessão ou pacote na conversa são canceladas, para o cliente não
 * pagar duas. A liberação vem só com o pagamento confirmado pelo provedor
 * (onPaymentUpdated).
 */
export async function buyPackage(
  ctx: ModuleContext,
  input: {
    c: Conversation;
    session: any;
    pkg: SupportPackage;
    method: "pix" | "link";
    payer_id?: string | null;
    document?: string | null;
    name?: string | null;
    sourceKey: string;
  },
) {
  if (input.c.profile_id !== ctx.profile) throw new IntegrationError("not_found", 404);
  if (!Number.isSafeInteger(input.pkg.price_cents) || input.pkg.price_cents < 100 || input.pkg.price_cents > 100_000_00)
    throw new IntegrationError("invalid_request", 400);
  const existing = await one(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE source_key=?",
    input.sourceKey,
  );
  if (existing && (existing.profile_id !== ctx.profile || existing.conversation_id !== input.c.id ||
      existing.package_id !== input.pkg.id || existing.price_cents !== input.pkg.price_cents ||
      (existing.payer_id ?? null) !== (input.payer_id ?? null) || (existing.session_id ?? null) !== (input.session?.id ?? null) ||
      existing.mode !== input.pkg.mode || (existing.hours ?? null) !== (input.pkg.hours ?? null)))
    throw new IntegrationError("idempotency_conflict", 409);
  // Estabelece o corte antes do aceite. Lê apenas D1, inclusive com ERP desligado.
  const commercial = !existing ? await supportCommercialContext(ctx) : undefined;
  const at = now();
  if (existing?.status === "paid") return existing;
  if (existing?.status === "refunded")
    throw new ApiError(409, "purchase_closed", "Esta compra foi estornada. Inicie uma nova compra.");
  if (
    existing?.payment_id &&
    existing.status === "pending" &&
    existing.method === input.method &&
    (existing.payment_expires_at || 0) > at + 60_000
  )
    return existing;
  const id = existing?.id || uid();
  const others = await all(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE conversation_id=? AND profile_id=? AND status='pending' AND id<>?",
    input.c.id,
    ctx.profile,
    id,
  );
  for (const other of others)
    if (await cancelPurchaseCharge(ctx, other)) {
      const current = await one(ctx.env, "SELECT * FROM suporte_purchases WHERE profile_id=? AND id=?", ctx.profile, other.id);
      if (!current) throw new IntegrationError("version_conflict", 409);
      if (!["pending", "cancelled", "expired"].includes(current.status)) continue;
      if (current.payment_id !== other.payment_id || current.charge_seq !== other.charge_seq) throw new IntegrationError("version_conflict", 409);
      const commercialStatements = await supportIntegrationStatements(ctx, { ...current, status: "cancelled" }, "cancel", at,
        { reason: "purchase_replaced" });
      await batch(ctx.env, [
        ["UPDATE suporte_purchases SET status='cancelled',updated=? WHERE id=? AND profile_id=? AND status=? AND payment_id IS ? AND charge_seq=?",
          [at, other.id, ctx.profile, current.status, other.payment_id, other.charge_seq]],
        integrationCasGuard,
        eventStatement(ctx.profile, "suporte.purchase_expired", other.id,
          { module_id: "suporte", purchase_id: other.id, conversation_id: other.conversation_id, status: "cancelled" },
          `module:suporte:${ctx.profile}:suporte.purchase_expired:${other.id}:cancelled`),
        ...commercialStatements,
      ]);
    }
  if (existing && !(await cancelPurchaseCharge(ctx, existing)))
    throw new ApiError(
      409,
      "payment_closed",
      "O pagamento anterior já foi concluído; aguarde a confirmação.",
    );
  if (!existing) {
    const customerLinks = await supportCustomerStatements(ctx, input.c, "purchases", id, at, "buyer:whatsapp", input.session?.id);
    const commercialStatements = await supportIntegrationStatements(ctx, {
      id, profile_id: ctx.profile, conversation_id: input.c.id, session_id: input.session?.id ?? null,
      payer_id: input.payer_id ?? null, package_id: input.pkg.id, price_cents: input.pkg.price_cents,
      status: "pending", created: at,
    }, "recognize", at, { setup: commercial, conversation: input.c });
    await batch(ctx.env, [
      [
        "INSERT INTO suporte_purchases(id,profile_id,conversation_id,session_id,payer_id,document,name,phone,package_id,package_name,price_cents,mode,hours,method,status,source_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
        [
          id,
          ctx.profile,
          input.c.id,
          input.session?.id ?? null,
          input.payer_id ?? null,
          input.document ?? null,
          input.name ?? "",
          phoneDigits(ctx.verifiedPhone(input.c) ?? ""),
          input.pkg.id,
          input.pkg.name,
          input.pkg.price_cents,
          input.pkg.mode,
          input.pkg.hours ?? null,
          input.method,
          input.sourceKey,
          at,
          at,
        ],
      ],
      integrationCasGuard,
      ...customerLinks,
      eventStatement(ctx.profile, "suporte.purchase_accepted", id,
        { module_id: "suporte", purchase_id: id, price_cents: input.pkg.price_cents }, `module:suporte:${ctx.profile}:suporte.purchase_accepted:${id}`),
      ...commercialStatements,
    ]);
  }
  await ctx.publish("suporte.purchase_accepted", id,
    { purchase_id: id, price_cents: input.pkg.price_cents }, { key: id });
  // Comprou pela conversa: aceita receber a cobrança e a liberação por aqui.
  await ctx.recordConsent(input.c, {
    purpose: "billing",
    source: "whatsapp",
    evidence: {
      action: "buy_support_package",
      package_id: input.pkg.id,
      price_cents: input.pkg.price_cents,
      purchase_id: id,
    },
    key: `compra:${id}`,
  });
  const seq = (existing?.charge_seq ?? 0) + 1;
  const payment = await ctx.charge(input.c, {
    method: input.method,
    amount_cents: input.pkg.price_cents,
    description: "Suporte avulso",
    ref: id,
    // A primeira mantém a chave antiga (compras de antes desta versão).
    sourceKey: seq === 1 ? `compra:${id}` : `compra:${id}:${seq}`,
    expiresMinutes: 24 * 60,
    notification: true,
  });
  const beforeCharge = await one(ctx.env, "SELECT * FROM suporte_purchases WHERE profile_id=? AND id=?", ctx.profile, id);
  // Uma confirmação que ganhou a corrida jamais é sobrescrita pela cobrança.
  if (["paid", "refunded"].includes(beforeCharge.status)) return beforeCharge;
  if (beforeCharge.charge_seq !== seq - 1) {
    if (beforeCharge.charge_seq === seq && beforeCharge.payment_id === payment.id) return beforeCharge;
    throw new IntegrationError("version_conflict", 409);
  }
  const chargeAt = now();
  const commercialStatements = await supportIntegrationStatements(ctx, { ...beforeCharge, status: "pending" }, null, chargeAt);
  const [changed] = await batch(ctx.env, [
    ["UPDATE suporte_purchases SET payment_id=?,pix_code=?,pay_url=?,payment_expires_at=?,method=?,charge_seq=?,status='pending',updated=? WHERE id=? AND profile_id=? AND status=? AND payment_id IS ? AND charge_seq=? RETURNING *",
      [payment.id, payment.pix_code, payment.url, payment.expires_at, payment.method, seq, chargeAt,
        id, ctx.profile, beforeCharge.status, beforeCharge.payment_id, beforeCharge.charge_seq]],
    integrationCasGuard,
    eventStatement(ctx.profile, "suporte.purchase_created", id,
      { module_id: "suporte", purchase_id: id, conversation_id: input.c.id, package_id: input.pkg.id,
        price_cents: input.pkg.price_cents, method: input.method, payment_id: payment.id },
      `module:suporte:${ctx.profile}:suporte.purchase_created:${id}`),
    ...commercialStatements,
  ]);
  const row = changed.results[0];
  await ctx.publish(
    "suporte.purchase_created",
    id,
    {
      purchase_id: id,
      conversation_id: input.c.id,
      package_id: input.pkg.id,
      price_cents: input.pkg.price_cents,
      method: input.method,
      payment_id: payment.id,
    },
    { key: id },
  );
  return row;
}

/**
 * Gancho da Cobrança para as compras avulsas: pago libera (validade em horas
 * a partir do pagamento ou até o protocolo fechar); vencido ou cancelado
 * marca a compra; estornado encerra a liberação.
 */
export async function purchasePaymentUpdated(
  ctx: ModuleContext,
  payment: Payment,
) {
  // Cobranças de planos nunca entram no produtor avulso, mesmo com IDs iguais.
  if (!payment.ref_id || payment.module_id !== "suporte" || payment.status === "created") return;
  const purchase = await one(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!purchase) return;
  const evidence = await supportPaymentEvidence(ctx, purchase, payment);
  // Estorno já confirmado vence um gancho paid atrasado; não libera por instantes.
  if (payment.status === "paid" && evidence.status === "refunded") payment = { ...payment, status: "refunded" };
  const at = now();
  if (payment.status === "paid") {
    const paidAt = evidence.paid_at || at;
    let changed = false;
    if (["pending", "expired", "cancelled"].includes(purchase.status)) {
      const commercialStatements = await supportIntegrationStatements(ctx, { ...purchase, status: "paid" }, "receive", paidAt,
        { payment: evidence });
      await batch(ctx.env, [
        ["UPDATE suporte_purchases SET status='paid',paid_at=?,payment_id=?,updated=? WHERE id=? AND profile_id=? AND status=? AND payment_id IS ? AND charge_seq=?",
          [paidAt, payment.id, at, purchase.id, ctx.profile, purchase.status, purchase.payment_id, purchase.charge_seq]],
        integrationCasGuard,
        eventStatement(ctx.profile, "suporte.purchase_paid", purchase.id,
          { module_id: "suporte", purchase_id: purchase.id, conversation_id: purchase.conversation_id, price_cents: purchase.price_cents, payment_id: payment.id },
          `module:suporte:${ctx.profile}:suporte.purchase_paid:${purchase.id}:paid`),
        ...commercialStatements,
      ]);
      changed = true;
    }
    // O núcleo repete o gancho até concluir: a mesma confirmação de novo
    // refaz a liberação (com chave), sem virar "em dobro".
    const originalPayment = !changed && purchase.status === "paid" && purchase.payment_id !== payment.id
      ? await one(ctx.env, "SELECT profile_id,provider,account_id,provider_payment_id,amount_cents FROM payments WHERE profile_id=? AND id=?", ctx.profile, purchase.payment_id)
      : null;
    const sameRemote = originalPayment && supportReceiptKey(evidence) !== null &&
      supportReceiptKey(originalPayment) === supportReceiptKey(evidence);
    if (sameRemote && originalPayment.amount_cents !== evidence.amount_cents)
      throw new IntegrationError("idempotency_conflict", 409);
    const retry = !changed && purchase.status === "paid" && (purchase.payment_id === payment.id || sameRemote);
    if (!changed && !retry) {
      // Outro pagamento da mesma compra (cobrança antiga paga junto com a
      // nova, link pago duas vezes): dinheiro em dobro para a equipe estornar.
      if (purchase.payment_id !== payment.id)
        await purchaseAttention(ctx, purchase, "duplicate_payment", payment);
      return;
    }
    // Paga depois de cancelada (o cliente trocou de pacote ou de sessão):
    // libera, mas a equipe confere se não pagou a outra também.
    if (purchase.status === "cancelled")
      await purchaseAttention(ctx, purchase, "paid_after_cancel", payment);
    await ctx.publish(
      "suporte.purchase_paid",
      purchase.id,
      {
        purchase_id: purchase.id,
        conversation_id: purchase.conversation_id,
        price_cents: purchase.price_cents,
        payment_id: payment.id,
      },
      { key: `${purchase.id}:paid` },
    );
    let c: Conversation;
    try {
      c = await ctx.conversation(purchase.conversation_id);
    } catch {
      return;
    }
    const session = purchase.session_id
      ? await loadSession(ctx, purchase.session_id)
      : null;
    await release(ctx, {
      c,
      session,
      kind: "package",
      ref: purchase.id,
      payer: purchase.payer_id
        ? { id: purchase.payer_id, name: purchase.name, document_display: null }
        : null,
      phone_linked: session?.phone_linked === 0 ? false : true,
      valid_until:
        purchase.mode === "hours" ? paidAt + purchase.hours * HOUR : null,
      actor: "provider",
      sourceKey: `compra:${purchase.id}`,
      detail: `Suporte avulso, ${money(purchase.price_cents)}`,
    });
    return;
  }
  if (payment.status === "refunded") {
    // Estorno (ou chargeback) do pagamento que valeu: a compra volta e a
    // liberação acaba; a equipe fica sabendo para conferir o atendimento.
    if (purchase.payment_id !== payment.id) {
      const original = await one(ctx.env, "SELECT profile_id,provider,account_id,provider_payment_id,amount_cents FROM payments WHERE profile_id=? AND id=?", ctx.profile, purchase.payment_id);
      if (!original || !supportReceiptKey(evidence) || supportReceiptKey(original) !== supportReceiptKey(evidence)) return;
      if (original.amount_cents !== evidence.amount_cents) throw new IntegrationError("idempotency_conflict", 409);
    }
    // Sem "já estornada, sai": a repetição do gancho refaz o encerramento e o
    // aviso, que têm chave.
    if (purchase.status !== "refunded") {
      const commercialStatements = await supportIntegrationStatements(ctx, { ...purchase, status: "refunded" }, "reverse", evidence.updated,
        { payment: evidence, reason: "payment_refunded" });
      await batch(ctx.env, [
        ["UPDATE suporte_purchases SET status='refunded',updated=? WHERE id=? AND profile_id=? AND status=? AND payment_id IS ? AND charge_seq=?",
          [at, purchase.id, ctx.profile, purchase.status, purchase.payment_id, purchase.charge_seq]],
        integrationCasGuard,
        eventStatement(ctx.profile, "suporte.purchase_attention", purchase.id,
          { module_id: "suporte", purchase_id: purchase.id, conversation_id: purchase.conversation_id, reason: "refunded", payment_id: payment.id, amount_cents: payment.amount_cents },
          `module:suporte:${ctx.profile}:suporte.purchase_attention:${purchase.id}:refunded:${payment.id}`),
        ...commercialStatements,
      ]);
    }
    const rel = await one(
      ctx.env,
      "SELECT id FROM suporte_releases WHERE source_key=? AND status='active'",
      `compra:${purchase.id}`,
    );
    if (rel) await endRelease(ctx, rel.id, "provider", "Pagamento estornado.");
    await purchaseAttention(ctx, purchase, "refunded", payment);
    return;
  }
  // Vencida ou cancelada: só a cobrança que vale agora muda a compra.
  if (purchase.status === "pending" && purchase.payment_id === payment.id) {
    const status = payment.status === "cancelled" ? "cancelled" : "expired";
    const commercialStatements = await supportIntegrationStatements(ctx, { ...purchase, status }, "cancel", at,
      { reason: status === "expired" ? "purchase_expired" : "purchase_cancelled" });
    await batch(ctx.env, [
      ["UPDATE suporte_purchases SET status=?,updated=? WHERE id=? AND profile_id=? AND status='pending' AND payment_id=? AND charge_seq=?",
        [status, at, purchase.id, ctx.profile, payment.id, purchase.charge_seq]],
      integrationCasGuard,
      eventStatement(ctx.profile, "suporte.purchase_expired", purchase.id,
        { module_id: "suporte", purchase_id: purchase.id, conversation_id: purchase.conversation_id, status: payment.status },
        `module:suporte:${ctx.profile}:suporte.purchase_expired:${purchase.id}:${payment.status}`),
      ...commercialStatements,
    ]);
  }
  if (["pending", "expired", "cancelled"].includes(purchase.status) && purchase.payment_id === payment.id)
    await ctx.publish(
      "suporte.purchase_expired",
      purchase.id,
      {
        purchase_id: purchase.id,
        conversation_id: purchase.conversation_id,
        status: payment.status,
      },
      { key: `${purchase.id}:${payment.status}` },
    );
}

export const sessionOptions = (session: any): { id: string; title: string }[] =>
  json(session?.options, []);
