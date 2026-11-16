// Mensalidade: pagadores. Quem paga (CPF ou CNPJ e nome) e os telefones
// autorizados a falar em nome dele: uma empresa paga e vários funcionários
// pedem suporte; uma família paga as aulas de dois filhos.
import { all, exec, one } from "../../db";
import { ApiError, now, requireValue, uid } from "../../types";
import type { ModuleContext } from "../api";
import { pageLimit, phoneDigits, requireDocument, text } from "./model";
import { formatDocument } from "../../establishment";

export const PHONES_LIMIT = 50;

export const payerNotFound = () =>
  new ApiError(404, "not_found", "Pagador não encontrado.");

/**
 * Quem cadastra o pagador nascido de uma contratação paga pelo WhatsApp
 * (`contrato:<id>`): documento e telefone vieram de quem digitou, sem
 * conferência da equipe. O pagador fica "provisório" (conferência N-6).
 */
export const CONTRACT_ACTOR_PREFIX = "contrato:";
export const provisionalPayer = (row: any) =>
  String(row?.created_by || "").startsWith(CONTRACT_ACTOR_PREFIX);

export function payerView(
  row: any,
  phones: any[] = [],
  extra: Record<string, any> = {},
) {
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    document_type: row.document_type,
    document_display: row.document ? formatDocument(row.document) : null,
    email: row.email,
    notes: row.notes,
    phones: phones.map((p) => ({
      phone: p.phone,
      label: p.label,
      created_by: p.created_by,
      created: p.created,
    })),
    created_by: row.created_by,
    provisional: provisionalPayer(row),
    created: row.created,
    updated: row.updated,
    ...extra,
  };
}

export async function loadPayer(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string") throw payerNotFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM mensalidade_payers WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw payerNotFound();
  return row;
}

export const payerPhones = (ctx: ModuleContext, id: string) =>
  all(
    ctx.env,
    "SELECT * FROM mensalidade_payer_phones WHERE payer_id=? AND profile_id=? ORDER BY created,phone",
    id,
    ctx.profile,
  );

/** Pagador pelo documento já normalizado (só dígitos ou CNPJ alfanumérico). */
export const payerByDocument = (ctx: ModuleContext, document: string) =>
  one(
    ctx.env,
    "SELECT * FROM mensalidade_payers WHERE profile_id=? AND document=?",
    ctx.profile,
    document,
  );

/** Pagadores que autorizaram o telefone (pode ser mais de um). */
export const payersByPhone = (ctx: ModuleContext, phone: string) =>
  all(
    ctx.env,
    "SELECT p.* FROM mensalidade_payer_phones t JOIN mensalidade_payers p ON p.id=t.payer_id WHERE t.profile_id=? AND t.phone=? ORDER BY p.created,p.id",
    ctx.profile,
    phoneDigits(phone),
  );

const validPhone = (value: unknown) => {
  const phone = phoneDigits(text(value, 40, "o telefone", true));
  requireValue(
    phone.length >= 10 && phone.length <= 15,
    "Telefone inválido: informe com DDD.",
  );
  return phone;
};

export interface PayerInput {
  document?: unknown;
  name?: unknown;
  email?: unknown;
  notes?: unknown;
  phones?: unknown;
}

async function publishPayer(
  ctx: ModuleContext,
  kind: "mensalidade.payer_created" | "mensalidade.payer_changed",
  payer: any,
  extra: Record<string, any>,
) {
  await ctx.publish(
    kind,
    payer.id,
    {
      payer_id: payer.id,
      document_type: payer.document_type,
      ...extra,
    },
    {
      key: `${payer.id}:${kind}:${extra.change || ""}:${extra.phone || ""}:${now()}`,
    },
  );
}

/** Cria o pagador; documento repetido na área: 409 payer_exists. */
export async function createPayer(
  ctx: ModuleContext,
  input: PayerInput,
  actor: string,
) {
  const doc =
    input.document === undefined ||
    input.document === null ||
    input.document === ""
      ? null
      : requireDocument(input.document);
  if (doc) {
    const existing = await payerByDocument(ctx, doc.document);
    if (existing)
      throw new ApiError(
        409,
        "payer_exists",
        `Já existe um pagador com o ${doc.type === "cpf" ? "CPF" : "CNPJ"} ${doc.display}.`,
      );
  }
  const name = text(input.name, 120, "o nome do pagador", true);
  const phones = input.phones === undefined ? [] : input.phones;
  requireValue(
    Array.isArray(phones) && phones.length <= PHONES_LIMIT,
    `Informe até ${PHONES_LIMIT} telefones.`,
  );
  const id = uid(),
    at = now();
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_payers(id,profile_id,document,document_type,name,email,notes,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id,
    ctx.profile,
    doc?.document ?? null,
    doc?.type ?? null,
    name,
    text(input.email, 200, "o e-mail"),
    text(input.notes, 1000, "as observações"),
    actor,
    at,
    at,
  );
  for (const raw of phones as any[]) {
    const entry = typeof raw === "string" ? { phone: raw } : raw || {};
    await exec(
      ctx.env,
      "INSERT OR IGNORE INTO mensalidade_payer_phones(payer_id,profile_id,phone,label,created_by,created) VALUES(?,?,?,?,?,?)",
      id,
      ctx.profile,
      validPhone(entry.phone),
      text(entry.label, 60, "o rótulo do telefone"),
      actor,
      at,
    );
  }
  const payer = await loadPayer(ctx, id);
  await publishPayer(ctx, "mensalidade.payer_created", payer, { actor });
  return payer;
}

/** Nome, e-mail, observações e documento (se ainda não tem ou para corrigir). */
export async function updatePayer(
  ctx: ModuleContext,
  payer: any,
  data: any,
  actor: string,
) {
  const has = (key: string) => Object.hasOwn(data, key);
  const sets: Record<string, any> = {};
  if (has("name")) sets.name = text(data.name, 120, "o nome do pagador", true);
  if (has("email")) sets.email = text(data.email, 200, "o e-mail");
  if (has("notes")) sets.notes = text(data.notes, 1000, "as observações");
  if (has("document")) {
    if (data.document === null || data.document === "") {
      sets.document = null;
      sets.document_type = null;
    } else {
      const doc = requireDocument(data.document);
      const other = await payerByDocument(ctx, doc.document);
      if (other && other.id !== payer.id)
        throw new ApiError(
          409,
          "payer_exists",
          `Já existe um pagador com o documento ${doc.display}.`,
        );
      sets.document = doc.document;
      sets.document_type = doc.type;
    }
  }
  const changed = Object.keys(sets).filter((key) => sets[key] !== payer[key]);
  if (!changed.length) return payer;
  await exec(
    ctx.env,
    `UPDATE mensalidade_payers SET ${changed.map((k) => k + "=?").join(",")},updated=? WHERE id=? AND profile_id=?`,
    ...changed.map((k) => sets[k]),
    now(),
    payer.id,
    ctx.profile,
  );
  const fresh = await loadPayer(ctx, payer.id);
  await publishPayer(ctx, "mensalidade.payer_changed", fresh, {
    change: "updated",
    fields: changed,
    actor,
  });
  return fresh;
}

/** Autoriza um telefone a falar pelo pagador (repetir não duplica). */
export async function addPayerPhone(
  ctx: ModuleContext,
  payer: any,
  rawPhone: unknown,
  label: unknown,
  actor: string,
) {
  const phone = validPhone(rawPhone);
  const count = await one<{ n: number }>(
    ctx.env,
    "SELECT count(*) AS n FROM mensalidade_payer_phones WHERE payer_id=?",
    payer.id,
  );
  const result = await exec(
    ctx.env,
    "INSERT OR IGNORE INTO mensalidade_payer_phones(payer_id,profile_id,phone,label,created_by,created) SELECT ?,?,?,?,?,? WHERE ?<?",
    payer.id,
    ctx.profile,
    phone,
    text(label, 60, "o rótulo do telefone"),
    actor,
    now(),
    count?.n ?? 0,
    PHONES_LIMIT,
  );
  if (!result.meta.changes) {
    const already = await one(
      ctx.env,
      "SELECT phone FROM mensalidade_payer_phones WHERE payer_id=? AND phone=?",
      payer.id,
      phone,
    );
    requireValue(already, `O pagador já tem ${PHONES_LIMIT} telefones.`);
    return { phone, added: false };
  }
  await publishPayer(ctx, "mensalidade.payer_changed", payer, {
    change: "phone_added",
    phone,
    actor,
  });
  return { phone, added: true };
}

export async function removePayerPhone(
  ctx: ModuleContext,
  payer: any,
  rawPhone: unknown,
  actor: string,
) {
  const phone = phoneDigits(rawPhone);
  const result = await exec(
    ctx.env,
    "DELETE FROM mensalidade_payer_phones WHERE payer_id=? AND profile_id=? AND phone=?",
    payer.id,
    ctx.profile,
    phone,
  );
  if (result.meta.changes)
    await publishPayer(ctx, "mensalidade.payer_changed", payer, {
      change: "phone_removed",
      phone,
      actor,
    });
  return { phone, removed: !!result.meta.changes };
}

/**
 * Pagador para uma assinatura nova: pelo documento (criando se não existir e
 * autorizando o telefone), pelo telefone quando há um único pagador com ele,
 * ou um pagador novo só com o nome e o telefone.
 */
export async function ensurePayer(
  ctx: ModuleContext,
  input: { document?: unknown; name?: unknown; phone?: string | null },
  actor: string,
) {
  const hasDocument =
    input.document !== undefined &&
    input.document !== null &&
    input.document !== "";
  if (hasDocument) {
    const doc = requireDocument(input.document);
    const existing = await payerByDocument(ctx, doc.document);
    if (existing) {
      if (input.phone)
        await addPayerPhone(ctx, existing, input.phone, "", actor);
      return existing;
    }
    return createPayer(
      ctx,
      {
        document: doc.document,
        name: input.name,
        phones: input.phone ? [input.phone] : [],
      },
      actor,
    );
  }
  if (input.phone) {
    const byPhone = await payersByPhone(ctx, input.phone);
    if (byPhone.length === 1) return byPhone[0];
  }
  return createPayer(
    ctx,
    { name: input.name, phones: input.phone ? [input.phone] : [] },
    actor,
  );
}

/** GET mensalidade/payers: busca por nome, documento ou telefone. */
export async function listPayers(
  ctx: ModuleContext,
  query: Record<string, string>,
) {
  const where = ["p.profile_id=?"],
    args: any[] = [ctx.profile];
  if (query.document) {
    const doc = String(query.document)
      .toUpperCase()
      .replace(/[\s./-]/g, "");
    where.push("p.document=?");
    args.push(doc);
  }
  if (query.phone) {
    where.push(
      "EXISTS(SELECT 1 FROM mensalidade_payer_phones t WHERE t.payer_id=p.id AND t.phone=?)",
    );
    args.push(phoneDigits(query.phone));
  }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like =
      "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const compact = q.toUpperCase().replace(/[\s./()+-]/g, "");
    const parts = ["lower(p.name) LIKE ? ESCAPE '\\'"];
    args.push(like);
    if (compact.length >= 4 && /^[0-9A-Z]+$/.test(compact)) {
      parts.push("p.document LIKE ?");
      args.push("%" + compact + "%");
      if (/^\d+$/.test(compact)) {
        parts.push(
          "EXISTS(SELECT 1 FROM mensalidade_payer_phones t WHERE t.payer_id=p.id AND t.phone LIKE ?)",
        );
        args.push("%" + compact + "%");
      }
    }
    where.push("(" + parts.join(" OR ") + ")");
  }
  if (query.cursor) {
    where.push("p.id>?");
    args.push(query.cursor);
  }
  const limit = pageLimit(query.limit, 50, 200);
  const rows = await all(
    ctx.env,
    `SELECT p.*,(SELECT count(*) FROM mensalidade_subscriptions s WHERE s.payer_id=p.id AND s.status<>'ended') AS subscriptions FROM mensalidade_payers p WHERE ${where.join(" AND ")} ORDER BY p.id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const data = [];
  for (const row of page)
    data.push(
      payerView(row, await payerPhones(ctx, row.id), {
        subscriptions: row.subscriptions,
      }),
    );
  return {
    data,
    next_cursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}
