// Suporte pago: sessões de liberação, compras avulsas e liberações
// (banco e visões da API). A conversa no WhatsApp está em ./flow.ts.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, json, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
import {
  money,
  packageValidity,
  phoneDigits,
  stamp,
  suporteSettings,
  type SupportPackage,
} from "./model";
import { passToTeam } from "./handoff";

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
) {
  await exec(
    ctx.env,
    "UPDATE suporte_sessions SET status='closed',updated=? WHERE conversation_id=? AND profile_id=? AND status='active'",
    at,
    c.id,
    ctx.profile,
  );
  const id = uid();
  await exec(
    ctx.env,
    "INSERT INTO suporte_sessions(id,profile_id,conversation_id,phone,status,step,expires_at,created,updated) VALUES(?,?,?,?,'active',?,?,?,?)",
    id,
    ctx.profile,
    c.id,
    phoneDigits(c.phone || c.external_id),
    step,
    at + SESSION_MINUTES * 60_000,
    at,
    at,
  );
  return (await loadSession(ctx, id))!;
}

export async function updateSession(
  ctx: ModuleContext,
  session: any,
  sets: Record<string, any>,
) {
  const at = now();
  const keys = Object.keys(sets);
  await exec(
    ctx.env,
    `UPDATE suporte_sessions SET ${keys.map((k) => k + "=?").join(",")},updated=?,expires_at=? WHERE id=?`,
    ...keys.map((k) => sets[k]),
    at,
    Math.max(session.expires_at, at + SESSION_MINUTES * 60_000),
    session.id,
  );
  return (await loadSession(ctx, session.id))!;
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
  valid_until?: number | null;
  until_ticket?: boolean;
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
  if (existing) return { release: existing, created: false };
  const cfg = suporteSettings(await ctx.settings());
  const at = now();
  const c = input.c;
  const linked = input.phone_linked !== false;
  const lines = [
    `Suporte pago: ${KIND_LABELS[input.kind]}${input.detail ? ` (${input.detail})` : ""}.`,
    input.payer
      ? `Pagador: ${input.payer.name || "sem nome"}${input.payer.document_display ? ` · ${input.payer.document_display}` : ""}.`
      : "",
    !linked && input.payer
      ? `Atenção: telefone não vinculado ao pagador ${input.payer.name || ""}. Confira e vincule em Dados da conversa → Suporte pago.`
      : "",
    input.valid_until ? `Liberado até ${stamp(input.valid_until)}.` : "",
    input.reason ? `Motivo: ${input.reason}` : "",
  ].filter(Boolean);
  const summary = lines.join(" ");
  const id = uid();
  const inserted = await exec(
    ctx.env,
    "INSERT INTO suporte_releases(id,profile_id,conversation_id,session_id,phone,payer_id,payer_name,kind,ref_id,phone_linked,valid_until,until_ticket,reason,summary,actor,status,source_key,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(source_key) DO NOTHING",
    id,
    ctx.profile,
    c.id,
    input.session?.id ?? null,
    phoneDigits(c.phone || c.external_id),
    input.payer?.id ?? null,
    input.payer?.name ?? "",
    input.kind,
    input.ref ?? null,
    linked ? 1 : 0,
    input.valid_until ?? null,
    input.until_ticket ? 1 : 0,
    input.reason ?? "",
    summary,
    input.actor,
    input.sourceKey,
    at,
  );
  if (!inserted.meta.changes)
    return {
      release: await one(
        ctx.env,
        "SELECT * FROM suporte_releases WHERE source_key=?",
        input.sourceKey,
      ),
      created: false,
    };
  if (input.session)
    await exec(
      ctx.env,
      "UPDATE suporte_sessions SET status='released',release_id=?,updated=? WHERE id=?",
      id,
      at,
      input.session.id,
    );
  const row = await one(
    ctx.env,
    "SELECT * FROM suporte_releases WHERE id=?",
    id,
  );
  await ctx.publish(
    "suporte.released",
    id,
    {
      release_id: id,
      conversation_id: c.id,
      kind: input.kind,
      ref_id: input.ref ?? null,
      payer_id: input.payer?.id ?? null,
      phone_linked: linked,
      valid_until: input.valid_until ?? null,
      actor: input.actor,
    },
    { key: id },
  );
  if (input.pass !== false) {
    const fresh = await ctx.conversation(c.id);
    if (!["human", "waiting"].includes(fresh.state)) {
      await ctx.sendMessage(
        fresh,
        { text: cfg.texts.released },
        { key: `liberado:${id}` },
      );
      await passToTeam(ctx, fresh, summary, {
        flags: [
          `Suporte pago: ${KIND_LABELS[input.kind]}`,
          ...(!linked && input.payer ? ["telefone não vinculado"] : []),
        ],
        key: `liberacao:${id}`,
      });
    }
  }
  return { release: row, created: true };
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
    const values = (query[key] || "").split(",").filter(Boolean);
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
      `(lower(payer_name) LIKE ?${digits.length >= 4 ? " OR phone LIKE ?" : ""})`,
    );
    args.push(`%${q}%`);
    if (digits.length >= 4) args.push(`%${digits}%`);
  }
  if (query.cursor) {
    where.push("created<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
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
  return { ...result, data: result.data.map(releaseView), counts };
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
  const statuses = (query.status || "").split(",").filter(Boolean);
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
    where.push("(lower(name) LIKE ? OR document LIKE ? OR phone LIKE ?)");
    args.push(`%${q}%`, `%${compact}%`, `%${compact}%`);
  }
  if (query.cursor) {
    where.push("created<?");
    args.push(Number(query.cursor) || 0);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
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

/**
 * Compra um pacote avulso: grava a compra e cobra pela Cobrança do núcleo
 * (Pix ou link na conversa). A liberação vem só com o pagamento confirmado
 * pelo provedor (onPaymentUpdated).
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
  const existing = await one(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE source_key=?",
    input.sourceKey,
  );
  if (existing?.payment_id) return existing;
  const at = now();
  const id = existing?.id || uid();
  if (!existing)
    await exec(
      ctx.env,
      "INSERT INTO suporte_purchases(id,profile_id,conversation_id,session_id,payer_id,document,name,phone,package_id,package_name,price_cents,mode,hours,method,status,source_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
      id,
      ctx.profile,
      input.c.id,
      input.session?.id ?? null,
      input.payer_id ?? null,
      input.document ?? null,
      input.name ?? "",
      phoneDigits(input.c.phone || input.c.external_id),
      input.pkg.id,
      input.pkg.name,
      input.pkg.price_cents,
      input.pkg.mode,
      input.pkg.hours ?? null,
      input.method,
      input.sourceKey,
      at,
      at,
    );
  const payment = await ctx.charge(input.c, {
    method: input.method,
    amount_cents: input.pkg.price_cents,
    description: `Suporte avulso: ${input.pkg.name}`,
    ref: id,
    sourceKey: `compra:${id}`,
    expiresMinutes: 24 * 60,
    notification: true,
  });
  await exec(
    ctx.env,
    "UPDATE suporte_purchases SET payment_id=?,pix_code=?,pay_url=?,payment_expires_at=?,updated=? WHERE id=?",
    payment.id,
    payment.pix_code,
    payment.url,
    payment.expires_at,
    now(),
    id,
  );
  const row = await one(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE id=?",
    id,
  );
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
  if (!payment.ref_id) return;
  const purchase = await one(
    ctx.env,
    "SELECT * FROM suporte_purchases WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!purchase) return;
  const at = now();
  if (payment.status === "paid") {
    const paidAt = payment.paid_at || at;
    const changed = await exec(
      ctx.env,
      "UPDATE suporte_purchases SET status='paid',paid_at=?,payment_id=?,updated=? WHERE id=? AND status IN ('pending','expired','cancelled')",
      paidAt,
      payment.id,
      at,
      purchase.id,
    );
    if (!changed.meta.changes) return;
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
      until_ticket: purchase.mode === "ticket",
      actor: "provider",
      sourceKey: `compra:${purchase.id}`,
      detail: `${purchase.package_name}, ${money(purchase.price_cents)}${purchase.document ? `, documento ${purchase.document}` : ""}`,
    });
    return;
  }
  if (payment.status === "refunded") {
    await exec(
      ctx.env,
      "UPDATE suporte_purchases SET status='refunded',updated=? WHERE id=?",
      at,
      purchase.id,
    );
    const rel = await one(
      ctx.env,
      "SELECT id FROM suporte_releases WHERE source_key=? AND status='active'",
      `compra:${purchase.id}`,
    );
    if (rel) await endRelease(ctx, rel.id, "provider", "Pagamento estornado.");
    return;
  }
  const changed = await exec(
    ctx.env,
    "UPDATE suporte_purchases SET status=?,updated=? WHERE id=? AND status='pending'",
    payment.status === "cancelled" ? "cancelled" : "expired",
    at,
    purchase.id,
  );
  if (changed.meta.changes)
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
