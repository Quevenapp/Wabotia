// Cadastro de clientes: ficha, telefones, consentimento, auditoria e vínculo
// com notas fiscais. Só as tabelas clientes_*.
import { all, exec, one } from "../../db";
import { ApiError, type Actor, now, requireValue, uid } from "../../types";
import { sha } from "../../security";
import type { ModuleContext } from "../api";
import {
  addressView,
  canReveal,
  clientesSettings,
  documentDisplay,
  fiscalRetentionUntil,
  maskEmail,
  maskPhone,
  parseDocument,
  personal,
  phoneDigits,
  REVEAL_FIELDS,
  requireDocument,
  searchText,
  text,
  validCep,
  validEmail,
  validIbge,
  validIe,
  validIeIndicator,
  validPhone,
  validUf,
  type ClientesSettings,
  type RevealField,
} from "./model";

export const PHONES_LIMIT = 10;

export const customerNotFound = () =>
  new ApiError(404, "not_found", "Cliente não encontrado.");

export async function settingsOf(ctx: ModuleContext) {
  return clientesSettings(await ctx.settings());
}

export async function loadCustomer(ctx: ModuleContext, id: unknown) {
  if (typeof id !== "string" || !id) throw customerNotFound();
  const row = await one(
    ctx.env,
    "SELECT * FROM clientes_customers WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw customerNotFound();
  return row;
}

export const customerPhones = (ctx: ModuleContext, id: string) =>
  all(
    ctx.env,
    "SELECT phone,label,verified,created_by,created FROM clientes_phones WHERE customer_id=? AND profile_id=? ORDER BY verified DESC,created,phone",
    id,
    ctx.profile,
  );

/** Variações do telefone com e sem o 9 do celular. */
export function phoneVariants(phone: string) {
  const out = new Set([phone]);
  if (/^55\d{2}9\d{8}$/.test(phone)) out.add(phone.slice(0, 4) + phone.slice(5));
  else if (/^55\d{2}[6-9]\d{7}$/.test(phone))
    out.add(phone.slice(0, 4) + "9" + phone.slice(4));
  return [...out];
}

/**
 * Ficha do telefone: a que confirmou o telefone pelo próprio canal; sem
 * ela, a única ficha ativa com esse telefone. Mais de uma sem confirmação:
 * null (não adivinha).
 */
export async function customerByPhone(ctx: ModuleContext, phone: string) {
  const rows = await all(
    ctx.env,
    "SELECT c.*,p.verified FROM clientes_phones p JOIN clientes_customers c ON c.id=p.customer_id WHERE p.profile_id=? AND p.phone IN (SELECT value FROM json_each(?)) AND c.status<>'erased' ORDER BY p.verified DESC,c.created",
    ctx.profile,
    JSON.stringify(phoneVariants(phoneDigits(phone))),
  );
  if (!rows.length) return null;
  if (rows[0].verified) return rows[0];
  const ids = new Set(rows.map((r) => r.id));
  return ids.size === 1 ? rows[0] : null;
}

export const customerByDocument = (ctx: ModuleContext, document: string) =>
  one(
    ctx.env,
    "SELECT * FROM clientes_customers WHERE profile_id=? AND document=?",
    ctx.profile,
    document,
  );

// ---------------------------------------------------------------------------
// Visão

export interface ViewOptions {
  /** Sem máscara (revelação auditada, emissão de nota). */
  reveal?: boolean;
  /** O ator pode pedir a revelação. */
  revealable?: boolean;
}

export function customerView(row: any, phones: any[], options: ViewOptions = {}) {
  const masked = !options.reveal;
  const erased = row.status === "erased";
  const ieMasked = masked && personal(row) && row.ie;
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    name: row.name,
    trade_name: row.trade_name,
    document_type: row.document_type,
    individual_business: !!row.individual_business,
    has_document: !!row.document,
    document_display: documentDisplay(row, masked),
    ...(masked ? {} : { document: row.document }),
    ie: ieMasked ? "•••" : row.ie,
    ie_indicator: row.ie_indicator,
    im: masked && personal(row) && row.im ? "•••" : row.im,
    email: masked ? maskEmail(row.email) : row.email,
    phones: phones.map((p) => ({
      phone: masked ? maskPhone(p.phone) : p.phone,
      label: p.label,
      verified: !!p.verified,
    })),
    address: addressView(row, masked),
    country_code: row.country_code,
    notes: row.notes,
    source: row.source,
    masked,
    revealable: !!options.revealable && !erased && row.status === "active",
    fiscal_ready: {
      nfce: !erased,
      nfe: !!(row.document && row.street && row.city_ibge && row.uf && row.cep),
      nfse: !!row.document,
    },
    version: row.version,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
    erased_at: row.erased_at,
  };
}

export async function viewFor(
  ctx: ModuleContext,
  actor: Actor,
  row: any,
  settings?: ClientesSettings,
) {
  const rules = settings || (await settingsOf(ctx));
  return customerView(row, await customerPhones(ctx, row.id), {
    revealable: canReveal(actor, rules),
  });
}

// ---------------------------------------------------------------------------
// Escrita

export interface CustomerInput {
  kind?: unknown;
  name?: unknown;
  trade_name?: unknown;
  document?: unknown;
  individual_business?: unknown;
  ie?: unknown;
  ie_indicator?: unknown;
  im?: unknown;
  email?: unknown;
  cep?: unknown;
  street?: unknown;
  number?: unknown;
  complement?: unknown;
  district?: unknown;
  city?: unknown;
  city_ibge?: unknown;
  uf?: unknown;
  notes?: unknown;
  phones?: unknown;
}

/** Campos validados de uma entrada parcial (só os presentes). */
export function customerFields(input: CustomerInput, partial: boolean) {
  const has = (key: keyof CustomerInput) =>
    Object.hasOwn(input, key) && input[key] !== undefined;
  const out: Record<string, any> = {};
  if (has("kind") || !partial) {
    const kind = input.kind ?? "pf";
    requireValue(["pf", "pj"].includes(kind as string), "Tipo: pf ou pj.");
    out.kind = kind;
  }
  if (has("name") || !partial)
    out.name = text(input.name, 150, "o nome ou razão social", true);
  if (has("trade_name"))
    out.trade_name = text(input.trade_name, 150, "o nome fantasia");
  if (has("document")) {
    if (input.document === null || input.document === "") {
      out.document = null;
      out.document_type = null;
    } else {
      const doc = requireDocument(input.document);
      out.document = doc.document;
      out.document_type = doc.type;
    }
  }
  if (has("individual_business"))
    out.individual_business = input.individual_business === true ? 1 : 0;
  if (has("ie")) {
    const ie = validIe(input.ie);
    out.ie = ie.ie;
    if (ie.isento) out.ie_indicator = "2";
  }
  if (has("ie_indicator")) out.ie_indicator = validIeIndicator(input.ie_indicator);
  if (has("im")) out.im = text(input.im, 20, "a inscrição municipal");
  if (has("email")) out.email = validEmail(input.email);
  if (has("cep")) out.cep = validCep(input.cep);
  if (has("street")) out.street = text(input.street, 120, "o logradouro");
  if (has("number")) out.number = text(input.number, 20, "o número");
  if (has("complement")) out.complement = text(input.complement, 60, "o complemento");
  if (has("district")) out.district = text(input.district, 60, "o bairro");
  if (has("city")) out.city = text(input.city, 60, "o município");
  if (has("city_ibge")) out.city_ibge = validIbge(input.city_ibge);
  if (has("uf")) out.uf = validUf(input.uf);
  if (has("notes")) out.notes = text(input.notes, 2000, "as observações");
  return out;
}

export function checkShape(row: Record<string, any>) {
  // CPF é de pessoa física; CNPJ, de jurídica (empresário individual também).
  if (row.document_type === "cpf")
    requireValue(
      row.kind === "pf",
      "CPF é de pessoa física: marque Pessoa física.",
    );
  if (row.document_type === "cnpj")
    requireValue(
      row.kind === "pj",
      "CNPJ é de empresa: marque Pessoa jurídica.",
    );
}

async function assertDocumentFree(
  ctx: ModuleContext,
  document: string | null | undefined,
  selfId: string | null,
) {
  if (!document) return;
  const other = await customerByDocument(ctx, document);
  if (other && other.id !== selfId)
    throw new ApiError(
      409,
      "customer_exists",
      "Já existe uma ficha com este CPF/CNPJ nesta área.",
    );
}

export async function addPhone(
  ctx: ModuleContext,
  customerId: string,
  rawPhone: unknown,
  options: { label?: unknown; verified?: boolean; actor: string },
) {
  const phone = validPhone(rawPhone);
  if (options.verified) {
    // Telefone confirmado pelo canal: sai de outra ficha em que estava
    // confirmado (o dono do telefone é quem preencheu agora).
    await exec(
      ctx.env,
      "UPDATE clientes_phones SET verified=0 WHERE profile_id=? AND phone IN (SELECT value FROM json_each(?)) AND customer_id<>? AND verified=1",
      ctx.profile,
      JSON.stringify(phoneVariants(phone)),
      customerId,
    );
  }
  const count = await one<{ n: number }>(
    ctx.env,
    "SELECT count(*) n FROM clientes_phones WHERE customer_id=?",
    customerId,
  );
  const existing = await one(
    ctx.env,
    "SELECT phone FROM clientes_phones WHERE customer_id=? AND phone IN (SELECT value FROM json_each(?))",
    customerId,
    JSON.stringify(phoneVariants(phone)),
  );
  if (existing) {
    if (options.verified)
      await exec(
        ctx.env,
        "UPDATE clientes_phones SET verified=1 WHERE customer_id=? AND phone=?",
        customerId,
        existing.phone,
      );
    return { phone: existing.phone, added: false };
  }
  requireValue(
    (count?.n ?? 0) < PHONES_LIMIT,
    `A ficha já tem ${PHONES_LIMIT} telefones.`,
  );
  await exec(
    ctx.env,
    "INSERT INTO clientes_phones(customer_id,profile_id,phone,label,verified,created_by,created) VALUES(?,?,?,?,?,?,?)",
    customerId,
    ctx.profile,
    phone,
    text(options.label, 60, "o rótulo do telefone"),
    options.verified ? 1 : 0,
    options.actor,
    now(),
  );
  return { phone, added: true };
}

export async function removePhone(
  ctx: ModuleContext,
  customerId: string,
  rawPhone: unknown,
) {
  const phone = phoneDigits(rawPhone);
  const result = await exec(
    ctx.env,
    "DELETE FROM clientes_phones WHERE customer_id=? AND profile_id=? AND phone=?",
    customerId,
    ctx.profile,
    phone,
  );
  return { phone, removed: !!result.meta.changes };
}

async function publishCustomer(
  ctx: ModuleContext,
  kind: "clientes.customer_created" | "clientes.customer_updated",
  row: any,
  extra: Record<string, any>,
) {
  // Sem dado pessoal: quem quiser os dados lê a ficha (mascarada).
  await ctx.publish(
    kind,
    row.id,
    {
      customer_id: row.id,
      kind: row.kind,
      source: row.source,
      version: row.version,
      ...extra,
    },
    { key: `${row.id}:${row.version}` },
  );
}

export async function createCustomer(
  ctx: ModuleContext,
  input: CustomerInput,
  options: { source: "self" | "panel" | "api"; actor: string; verifiedPhone?: string | null },
) {
  const fields = customerFields(input, false);
  checkShape(fields);
  await assertDocumentFree(ctx, fields.document, null);
  const phones = input.phones === undefined ? [] : input.phones;
  requireValue(
    Array.isArray(phones) && phones.length <= PHONES_LIMIT,
    `Informe até ${PHONES_LIMIT} telefones.`,
  );
  const id = uid(),
    at = now();
  const columns = Object.keys(fields);
  await exec(
    ctx.env,
    `INSERT INTO clientes_customers(id,profile_id,${columns.join(",")},source,search_text,created_by,updated_by,created,updated) VALUES(?,?,${columns.map(() => "?").join(",")},?,?,?,?,?,?)`,
    id,
    ctx.profile,
    ...columns.map((k) => fields[k]),
    options.source,
    searchText(`${fields.name} ${fields.trade_name || ""}`),
    options.actor,
    options.actor,
    at,
    at,
  );
  if (options.verifiedPhone)
    await addPhone(ctx, id, options.verifiedPhone, {
      verified: true,
      actor: options.actor,
    });
  for (const raw of phones as any[]) {
    const entry = typeof raw === "string" ? { phone: raw } : raw || {};
    await addPhone(ctx, id, entry.phone, { label: entry.label, actor: options.actor });
  }
  const row = await loadCustomer(ctx, id);
  await publishCustomer(ctx, "clientes.customer_created", row, {
    actor: options.actor,
  });
  return row;
}

/** Atualiza só os campos presentes; `expected_version` confere a edição. */
export async function updateCustomer(
  ctx: ModuleContext,
  row: any,
  input: CustomerInput & { expected_version?: unknown },
  options: { actor: string; source?: string; checkVersion?: boolean },
) {
  if (row.status !== "active")
    throw new ApiError(
      409,
      "customer_erased",
      "Esta ficha teve os dados excluídos a pedido do titular.",
    );
  if (options.checkVersion !== false) {
    requireValue(
      Number.isSafeInteger(input.expected_version),
      "Informe a versão da ficha que está editando (expected_version).",
    );
    if (input.expected_version !== row.version)
      throw new ApiError(
        409,
        "customer_conflict",
        "Esta ficha foi alterada. Reabra-a antes de salvar.",
      );
  }
  const fields = customerFields(input, true);
  const merged = { ...row, ...fields };
  checkShape(merged);
  if (Object.hasOwn(fields, "document"))
    await assertDocumentFree(ctx, fields.document, row.id);
  const changed = Object.keys(fields).filter((k) => fields[k] !== row[k]);
  if (!changed.length) return { row, changed };
  await exec(
    ctx.env,
    `UPDATE clientes_customers SET ${changed.map((k) => k + "=?").join(",")},search_text=?,version=version+1,updated_by=?,updated=? WHERE id=? AND profile_id=? AND version=?`,
    ...changed.map((k) => fields[k]),
    searchText(`${merged.name} ${merged.trade_name || ""}`),
    options.actor,
    now(),
    row.id,
    ctx.profile,
    row.version,
  );
  const fresh = await loadCustomer(ctx, row.id);
  // Só os nomes dos campos (nunca os valores) vão no evento.
  await publishCustomer(ctx, "clientes.customer_updated", fresh, {
    actor: options.actor,
    fields: changed,
  });
  return { row: fresh, changed };
}

// ---------------------------------------------------------------------------
// Lista

const pageLimit = (value: unknown, fallback: number, max: number) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/**
 * Busca por nome; o documento (exato) e o telefone (exato, com e sem o 9)
 * só para quem pode ver dado pessoal (a lista não vira oráculo: o resultado
 * continua mascarado).
 */
export async function listCustomers(
  ctx: ModuleContext,
  actor: Actor,
  query: Record<string, string>,
) {
  const where = ["c.profile_id=?"],
    args: any[] = [ctx.profile];
  const status = query.status || "active";
  if (status !== "all") {
    requireValue(
      ["active", "erasing", "erased"].includes(status),
      "Situação: active, erasing, erased ou all.",
    );
    where.push("c.status=?");
    args.push(status);
  }
  const q = String(query.q || "").trim().slice(0, 100);
  if (q) {
    const parts = ["c.search_text LIKE ? ESCAPE '\\'"];
    args.push(
      "%" + searchText(q).replace(/[%_\\]/g, (m) => "\\" + m) + "%",
    );
    const compact = q.toUpperCase().replace(/[\s./()+-]/g, "");
    if (/^[0-9A-Z]{8,15}$/.test(compact) && /\d/.test(compact)) {
      const doc = parseDocument(compact);
      if (doc) {
        parts.push("c.document=?");
        args.push(doc.document);
      }
      if (/^\d+$/.test(compact)) {
        parts.push(
          "EXISTS(SELECT 1 FROM clientes_phones p WHERE p.customer_id=c.id AND p.phone IN (SELECT value FROM json_each(?)))",
        );
        args.push(JSON.stringify(phoneVariants(phoneDigits(compact))));
      }
    }
    where.push("(" + parts.join(" OR ") + ")");
  }
  if (query.cursor) {
    let after: [number, string];
    try {
      after = JSON.parse(atob(query.cursor));
      if (!Array.isArray(after) || !Number.isSafeInteger(after[0])) throw 0;
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
    }
    where.push("(c.updated<? OR (c.updated=? AND c.id<?))");
    args.push(after[0], after[0], String(after[1]));
  }
  const limit = pageLimit(query.limit, 50, 100);
  const rows = await all(
    ctx.env,
    `SELECT c.* FROM clientes_customers c WHERE ${where.join(" AND ")} ORDER BY c.updated DESC,c.id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const settings = await settingsOf(ctx);
  const phones = page.length
    ? await all(
        ctx.env,
        "SELECT customer_id,phone,label,verified,created FROM clientes_phones WHERE profile_id=? AND customer_id IN (SELECT value FROM json_each(?)) ORDER BY verified DESC,created,phone",
        ctx.profile,
        JSON.stringify(page.map((r) => r.id)),
      )
    : [];
  const last = page.at(-1);
  return {
    data: page.map((row) =>
      customerView(
        row,
        phones.filter((p) => p.customer_id === row.id),
        { revealable: canReveal(actor, settings) },
      ),
    ),
    next_cursor:
      rows.length > limit && last
        ? btoa(JSON.stringify([last.updated, last.id]))
        : null,
  };
}

// ---------------------------------------------------------------------------
// Revelação auditada

export function revealFields(value: unknown): RevealField[] {
  if (value === undefined || value === null || value === "")
    return [...REVEAL_FIELDS];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out = list.map((f) => String(f).trim()).filter(Boolean);
  requireValue(
    out.length > 0 &&
      out.every((f) => (REVEAL_FIELDS as readonly string[]).includes(f)),
    `Campos: ${REVEAL_FIELDS.join(", ")}.`,
  );
  return [...new Set(out)] as RevealField[];
}

export async function logAccess(
  ctx: ModuleContext,
  actor: Actor | { id: string; kind: string },
  customerId: string,
  action: "reveal" | "fiscal",
  fields: string[],
  reason: string,
) {
  await exec(
    ctx.env,
    "INSERT INTO clientes_access_log(id,profile_id,customer_id,actor,actor_kind,action,fields,reason,created) VALUES(?,?,?,?,?,?,?,?,?)",
    uid(),
    ctx.profile,
    customerId,
    actor.id,
    actor.kind,
    action,
    JSON.stringify(fields),
    reason,
    now(),
  );
}

export function requireReason(value: unknown) {
  const reason = String(value ?? "").replace(/\s+/g, " ").trim();
  requireValue(
    Array.from(reason).length >= 5 && Array.from(reason).length <= 300,
    "Informe o motivo para ver os dados (de 5 a 300 caracteres).",
  );
  return reason;
}

/**
 * Dados sem máscara dos campos pedidos, com registro de quem, quando e por
 * quê. Quem não pode revelar: 403 reveal_forbidden.
 */
export async function revealCustomer(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
  query: { reason?: unknown; fields?: unknown },
) {
  const settings = await settingsOf(ctx);
  if (!canReveal(actor, settings))
    throw new ApiError(
      403,
      "reveal_forbidden",
      actor.kind === "app"
        ? "Permissão necessária: contacts:read."
        : "Somente administradores podem ver os dados sem máscara nesta área.",
    );
  const reason = requireReason(query.reason);
  const fields = revealFields(query.fields);
  const row = await loadCustomer(ctx, id);
  if (row.status !== "active")
    throw new ApiError(
      409,
      "customer_erased",
      "Os dados desta ficha foram excluídos a pedido do titular.",
    );
  await logAccess(ctx, actor, row.id, "reveal", fields, reason);
  const phones = await customerPhones(ctx, row.id);
  const masked = customerView(row, phones, { revealable: true });
  const full = customerView(row, phones, { reveal: true, revealable: true });
  // Só os campos pedidos saem sem máscara.
  const out: Record<string, any> = { ...masked, masked: false, revealed: fields };
  for (const field of fields) {
    if (field === "document") {
      out.document = full.document;
      out.document_display = full.document_display;
    } else out[field] = (full as any)[field];
  }
  return out;
}

export async function accessLog(
  ctx: ModuleContext,
  query: { customer_id?: string; cursor?: string; limit?: string },
) {
  const limit = pageLimit(query.limit, 50, 200);
  const rows = await all(
    ctx.env,
    `SELECT * FROM clientes_access_log WHERE profile_id=?${query.customer_id ? " AND customer_id=?" : ""}${query.cursor ? " AND created<?" : ""} ORDER BY created DESC,id DESC LIMIT ?`,
    ctx.profile,
    ...(query.customer_id ? [query.customer_id] : []),
    ...(query.cursor ? [Number(query.cursor)] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    data: page.map((r) => ({
      id: r.id,
      customer_id: r.customer_id,
      actor: r.actor,
      actor_kind: r.actor_kind,
      action: r.action,
      fields: JSON.parse(r.fields || "[]"),
      reason: r.reason,
      created: r.created,
    })),
    next_cursor: rows.length > limit ? String(page.at(-1)!.created) : null,
  };
}

// ---------------------------------------------------------------------------
// Consentimento

export async function recordConsent(
  ctx: ModuleContext,
  customerId: string,
  record: {
    status?: "granted" | "revoked";
    source: "web_step" | "panel" | "whatsapp";
    settings: ClientesSettings;
    evidence: Record<string, unknown>;
    key?: string;
  },
) {
  const id = record.key ? `${customerId}:${record.key}` : uid();
  await exec(
    ctx.env,
    "INSERT OR IGNORE INTO clientes_consents(id,profile_id,customer_id,purpose,status,source,terms_version,terms_hash,evidence,created) VALUES(?,?,?,'cadastro',?,?,?,?,?,?)",
    id,
    ctx.profile,
    customerId,
    record.status || "granted",
    record.source,
    record.settings.terms_version,
    await sha(record.settings.consent_text),
    JSON.stringify(record.evidence),
    now(),
  );
  return id;
}

export const consentsOf = (ctx: ModuleContext, customerId: string) =>
  all(
    ctx.env,
    "SELECT id,purpose,status,source,terms_version,terms_hash,evidence,created FROM clientes_consents WHERE customer_id=? AND profile_id=? ORDER BY created DESC,id DESC LIMIT 20",
    customerId,
    ctx.profile,
  ).then((rows) =>
    rows.map((r) => ({ ...r, evidence: JSON.parse(r.evidence || "{}") })),
  );

// ---------------------------------------------------------------------------
// Notas fiscais emitidas para a ficha

export const FISCAL_MODELS = ["nfe", "nfce", "nfse"] as const;

export async function linkFiscalDocument(
  ctx: ModuleContext,
  input: {
    customer_id: unknown;
    module_id: unknown;
    ref_id: unknown;
    model: unknown;
    series?: unknown;
    number?: unknown;
    access_key?: unknown;
    issued_at?: unknown;
  },
) {
  const customer = await loadCustomer(ctx, input.customer_id);
  const module = text(input.module_id, 40, "o módulo emissor", true);
  requireValue(/^[a-z0-9_:-]+$/.test(module), "Módulo emissor inválido.");
  const ref = text(input.ref_id, 100, "o id da nota no emissor", true);
  requireValue(
    (FISCAL_MODELS as readonly string[]).includes(input.model as string),
    "Modelo: nfe, nfce ou nfse.",
  );
  const issued =
    input.issued_at === undefined ? now() : Number(input.issued_at);
  requireValue(
    Number.isSafeInteger(issued) && issued > 0 && issued <= now() + 86400000,
    "Data de emissão inválida (ms Unix).",
  );
  const key = String(input.access_key ?? "").replace(/\D/g, "");
  requireValue(!key || key.length === 44, "Chave de acesso: 44 dígitos.");
  const settings = await settingsOf(ctx);
  const until = fiscalRetentionUntil(issued, settings.fiscal_retention_years);
  await exec(
    ctx.env,
    "INSERT INTO clientes_fiscal_documents(profile_id,module_id,ref_id,customer_id,model,series,number,access_key,issued_at,retain_until,created) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,module_id,ref_id) DO UPDATE SET model=excluded.model,series=excluded.series,number=excluded.number,access_key=excluded.access_key",
    ctx.profile,
    module,
    ref,
    customer.id,
    input.model,
    text(String(input.series ?? ""), 10, "a série"),
    text(String(input.number ?? ""), 20, "o número"),
    key,
    issued,
    until,
    now(),
  );
  return { customer_id: customer.id, module_id: module, ref_id: ref, retain_until: until };
}

export const fiscalDocumentsOf = (ctx: ModuleContext, customerId: string) =>
  all(
    ctx.env,
    "SELECT module_id,ref_id,model,series,number,access_key,issued_at,retain_until FROM clientes_fiscal_documents WHERE customer_id=? AND profile_id=? ORDER BY issued_at DESC LIMIT 200",
    customerId,
    ctx.profile,
  );
