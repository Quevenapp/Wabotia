// Passo web (docs/MODULOS.md, "Passo web"): o que não cabe no chat sai por um
// link curto de uso único, amarrado à conversa, para uma página leve no
// celular. Ao concluir, o núcleo publica web_step.completed, anexa as respostas
// ao contato e ao protocolo e devolve o cliente ao WhatsApp com uma mensagem.
//
// Escritas que tocam a conversa (conclusão, mensagem de retorno, protocolo)
// rodam no Coordinator da área (POST /web-step), como o resto do atendimento.
import { all, exec, one } from "./db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";
import { access, sha } from "./security";
import { event } from "./events";
import {
  conversation,
  createTicket,
  enqueue,
  message,
  settings,
} from "./service";
import { activeTicketSql } from "./protocols";
import { webStepHook } from "./modules/hooks";
import { interactiveLine, sendInteractive } from "./line-service";
import { flowToken } from "./whatsapp-interactive";

export const WEB_STEP_PATH = "/api/w/";
export const webStepStatuses = [
  "sent",
  "opened",
  "completed",
  "expired",
  "cancelled",
] as const;
export type WebStepStatus = (typeof webStepStatuses)[number];
export type WebStepTrigger = "menu" | "agent" | "bot" | "module";
const ACTIVE = ["sent", "opened"];

/** Validade padrão e limites do link, em minutos. */
export const WEB_STEP_TTL = { default: 24 * 60, min: 5, max: 7 * 24 * 60 };

// Sem 0/O, 1/l/I: o código pode ser lido em voz alta ou digitado.
const CODE_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const CODE_LENGTH = 16;
export const webStepCode = /^[2-9A-HJ-NP-Za-km-np-z]{16}$/;

/** Código curto com ~93 bits de acaso (amostragem sem viés). */
export function newWebStepCode() {
  let code = "";
  while (code.length < CODE_LENGTH)
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte >= 224 || code.length >= CODE_LENGTH) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  return code;
}

// ---------------------------------------------------------------------------
// Campos da página

export const fieldTypes = ["text", "choice", "date", "accept"] as const;
export type FieldType = (typeof fieldTypes)[number];
export interface WebField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  help?: string;
  /** text: caixa de várias linhas. */
  multiline?: boolean;
  /** choice: opções mostradas ao cliente (2 a 20). */
  options?: string[];
}
export interface WebStepSpec {
  title: string;
  intro?: string;
  fields: WebField[];
  submit_label?: string;
  /** Texto da página depois de concluir. */
  done_text?: string;
  /** Mensagem de retorno no WhatsApp; vazia usa a padrão. */
  return_text?: string;
  /** Protocolo: anexa ao ativo da conversa, abre um se não houver, ou nada. */
  ticket?: "attach" | "open" | "none";
  ticket_category?: string | null;
}

const str = (value: unknown, max: number, what: string, required = true) => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
};

/** Valida os campos de um formulário ou de uma página de módulo. */
export function validateFields(value: unknown): WebField[] {
  requireValue(
    Array.isArray(value) && value.length >= 1 && value.length <= 30,
    "Informe de 1 a 30 campos.",
  );
  const ids = new Set<string>();
  return (value as any[]).map((raw, index) => {
    requireValue(raw && typeof raw === "object", "Campo inválido.");
    const id = str(raw.id, 60, `o identificador do campo ${index + 1}`);
    requireValue(
      /^[A-Za-z0-9_-]+$/.test(id) && !ids.has(id),
      `Identificador do campo ${index + 1} inválido ou repetido.`,
    );
    ids.add(id);
    requireValue(
      fieldTypes.includes(raw.type),
      `Tipo do campo "${id}": use text, choice, date ou accept.`,
    );
    const field: WebField = {
      id,
      type: raw.type,
      label: str(raw.label, 200, `o rótulo do campo ${index + 1}`),
      required: raw.required === undefined ? true : raw.required === true,
    };
    const help = str(raw.help, 300, "a ajuda do campo", false);
    if (help) field.help = help;
    if (raw.type === "text" && raw.multiline === true) field.multiline = true;
    if (raw.type === "choice") {
      requireValue(
        Array.isArray(raw.options) &&
          raw.options.length >= 2 &&
          raw.options.length <= 20,
        `Campo "${field.label}": informe de 2 a 20 opções.`,
      );
      const options = raw.options.map((o: unknown) =>
        str(o, 100, `a opção do campo "${field.label}"`),
      );
      requireValue(
        new Set(options).size === options.length,
        `Campo "${field.label}": opções repetidas.`,
      );
      field.options = options;
    }
    return field;
  });
}

export function validateSpec(value: any): WebStepSpec {
  requireValue(value && typeof value === "object", "Página inválida.");
  const spec: WebStepSpec = {
    title: str(value.title, 120, "o título da página"),
    fields: validateFields(value.fields),
  };
  for (const [key, max, what] of [
    ["intro", 1500, "a introdução"],
    ["submit_label", 30, "o texto do botão"],
    ["done_text", 600, "o texto de conclusão"],
    ["return_text", 900, "a mensagem de retorno"],
  ] as const) {
    const text = str(value[key], max, what, false);
    if (text) spec[key] = text;
  }
  const ticket = value.ticket ?? "attach";
  requireValue(
    ["attach", "open", "none"].includes(ticket),
    "Protocolo: use attach, open ou none.",
  );
  spec.ticket = ticket;
  if (value.ticket_category)
    spec.ticket_category = str(value.ticket_category, 100, "a categoria");
  return spec;
}

const isoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

export type Answers = Record<string, string | boolean>;

/** Confere o que o cliente enviou contra os campos fixados no passo. */
export function validateAnswers(
  fields: WebField[],
  input: Record<string, unknown>,
) {
  const answers: Answers = {},
    errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = input[field.id];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.type === "accept") {
      const accepted =
        ["on", "1", "true", "sim"].includes(value) || raw === true;
      if (field.required && !accepted)
        errors[field.id] = "Marque para continuar.";
      answers[field.id] = accepted;
      continue;
    }
    if (!value) {
      if (field.required) errors[field.id] = "Preencha este campo.";
      answers[field.id] = "";
      continue;
    }
    if (field.type === "text") {
      const max = field.multiline ? 2000 : 300;
      if (Array.from(value).length > max)
        errors[field.id] = `Use até ${max} caracteres.`;
    } else if (field.type === "choice") {
      if (!field.options?.includes(value))
        errors[field.id] = "Escolha uma das opções.";
    } else if (field.type === "date" && !isoDate(value))
      errors[field.id] = "Informe uma data válida.";
    answers[field.id] = value;
  }
  return { answers, errors, ok: !Object.keys(errors).length };
}

const brDate = (value: string) => value.split("-").reverse().join("/");
/** Respostas em texto, uma por linha, para nota, protocolo e evento. */
export function answersText(fields: WebField[], answers: Answers) {
  return fields
    .map((field) => {
      const value = answers[field.id];
      const shown =
        field.type === "accept"
          ? value
            ? "Sim"
            : "Não"
          : field.type === "date" && value
            ? brDate(String(value))
            : String(value || "—");
      return `${field.label}: ${shown}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Endereço público da instalação

let knownOrigin = "";
/** Guarda a origem vista numa requisição autenticada (painel, app, API). */
export async function rememberOrigin(env: Env, url: string) {
  let origin: string;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      return;
    origin = parsed.origin;
  } catch {
    return;
  }
  if (origin === knownOrigin) return;
  knownOrigin = origin;
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES('public_origin',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    origin,
    now(),
  );
}
export async function publicOrigin(env: Env) {
  return (
    (
      await one(
        env,
        "SELECT value FROM instance_settings WHERE key='public_origin'",
      )
    )?.value || null
  );
}

// ---------------------------------------------------------------------------
// Criar

export interface OpenWebStepInput {
  conversation: Conversation;
  /** Módulo dono ("forms", "agenda", …). */
  module: string;
  /** Tipo do passo dentro do módulo ("form", "checkin", …). */
  kind: string;
  /** Registro do módulo ligado ao passo. */
  ref?: string | null;
  spec: WebStepSpec;
  trigger: WebStepTrigger;
  /** Autor da mensagem com o link ("system", id da pessoa, "bot:…", "app:…"). */
  actor: string;
  /** Repetir a mesma chave devolve o passo já criado, sem novo link. */
  sourceKey: string;
  ttlMinutes?: number;
  /** Texto que acompanha o link; o padrão usa o título. */
  text?: string;
  /** Rótulo do botão com URL nas linhas oficiais (até 20 caracteres). */
  button?: string;
  /**
   * Flow publicado que faz o mesmo que a página, para linhas oficiais. Os
   * nomes dos campos do Flow precisam ser os ids dos campos de `spec`.
   */
  flow?: { flow_id: string; flow_cta?: string; screen?: string } | null;
}

export function webStepView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    module_id: row.module_id,
    kind: row.kind,
    ref_id: row.ref_id,
    title: row.title,
    status: row.status as WebStepStatus,
    trigger: row.trigger,
    actor: row.actor,
    expires_at: row.expires_at,
    opened_at: row.opened_at,
    completed_at: row.completed_at,
    ticket_id: row.ticket_id,
    contact_id: row.contact_id,
    answers: row.result ? json(row.result, null) : null,
    /** flow: entregue como Flow nativo; link: botão com URL ou texto. */
    delivery: row.flow_token ? "flow" : "link",
    fields: (json(row.spec).fields || []).map((f: WebField) => ({
      id: f.id,
      type: f.type,
      label: f.label,
    })),
    created: row.created,
    updated: row.updated,
  };
}

async function lineKind(env: Env, c: Conversation) {
  return c.connection_id
    ? (
        await one(
          env,
          "SELECT kind FROM connections WHERE id=?",
          c.connection_id,
        )
      )?.kind || null
    : null;
}

const clip = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");

/**
 * Cria o passo, envia o link na conversa e publica web_step.sent. Devolve a
 * URL só na criação (o código não é guardado); repetir sourceKey devolve o
 * mesmo passo com url null.
 */
export async function openWebStep(env: Env, input: OpenWebStepInput) {
  const c = input.conversation;
  const old = await one(
    env,
    "SELECT * FROM web_steps WHERE source_key=?",
    input.sourceKey,
  );
  if (old) return { step: webStepView(old)!, url: null, created: false };
  requireValue(
    c.chat_type !== "group",
    "O passo web é enviado só em conversas individuais.",
  );
  const spec = validateSpec(input.spec);
  const kind = await lineKind(env, c);
  if (input.trigger !== "menu" && ["meta", "zernio"].includes(kind || ""))
    requireValue(
      now() - c.last_customer < 86400000,
      "O cliente precisa ter escrito nas últimas 24 horas para receber o link.",
    );
  const origin = await publicOrigin(env);
  if (!origin)
    throw new ApiError(
      409,
      "origin_unknown",
      "O endereço público desta instalação ainda não é conhecido. Abra o painel pelo endereço usado pelos clientes e tente de novo.",
    );
  const ttl = Math.min(
    WEB_STEP_TTL.max,
    Math.max(
      WEB_STEP_TTL.min,
      Math.round(input.ttlMinutes || WEB_STEP_TTL.default),
    ),
  );
  const id = uid(),
    code = newWebStepCode(),
    at = now();
  const url = origin + WEB_STEP_PATH + code;
  await exec(
    env,
    "INSERT INTO web_steps(id,profile_id,conversation_id,module_id,kind,ref_id,code_hash,status,title,spec,trigger,actor,source_key,expires_at,created,updated) VALUES(?,?,?,?,?,?,?,'sent',?,?,?,?,?,?,?,?)",
    id,
    c.profile_id,
    c.id,
    input.module,
    input.kind,
    input.ref || null,
    await sha(code),
    spec.title,
    JSON.stringify(spec),
    input.trigger,
    input.actor,
    input.sourceKey,
    at + ttl * 60000,
    at,
    at,
  );
  const body = clip(
    input.text?.trim() ||
      `Para continuar, abra o link e preencha: ${spec.title}.`,
    900,
  );
  const button = clip(input.button?.trim() || "Abrir", 20);
  // Linha oficial com Flow publicado: o formulário abre dentro do WhatsApp e a
  // resposta (content.type "flow_reply") volta casada pelo flow_token. Sem
  // Flow, botão com URL; em linha QR, o texto com o link (sendInteractive).
  const flow = input.flow?.flow_id && (await interactiveLine(env, c));
  const token = flow ? flowToken(input.flow!.flow_id, id) : null;
  if (token)
    await exec(env, "UPDATE web_steps SET flow_token=? WHERE id=?", token, id);
  await sendInteractive(
    env,
    input.actor,
    c,
    token
      ? {
          type: "flow",
          body,
          flow_id: input.flow!.flow_id,
          flow_cta: clip(input.flow!.flow_cta?.trim() || button, 30),
          flow_token: token,
          ...(input.flow!.screen
            ? {
                flow_action: "navigate" as const,
                flow_action_payload: { screen: input.flow!.screen },
              }
            : {}),
          fallback: { url },
        }
      : { type: "cta_url", body, display_text: button, url },
    // O id do passo é único no sistema todo, como a chave do outbox exige.
    `web-step:${id}`,
    "web_step",
  );
  const row = await one(env, "SELECT * FROM web_steps WHERE id=?", id);
  await event(env, c.profile_id, "web_step.sent", id, {
    id,
    conversation_id: c.id,
    module_id: input.module,
    kind: input.kind,
    ref_id: input.ref || null,
    title: spec.title,
    trigger: input.trigger,
    expires_at: row.expires_at,
  });
  return { step: webStepView(row)!, url, created: true };
}

// ---------------------------------------------------------------------------
// Ler, abrir, expirar, cancelar

export async function webStepByCode(env: Env, code: unknown) {
  if (typeof code !== "string" || !webStepCode.test(code)) return null;
  return one(env, "SELECT * FROM web_steps WHERE code_hash=?", await sha(code));
}

async function markExpired(env: Env, row: any) {
  const result = await exec(
    env,
    "UPDATE web_steps SET status='expired',updated=? WHERE id=? AND status IN ('sent','opened')",
    now(),
    row.id,
  );
  if (result.meta?.changes)
    await event(env, row.profile_id, "web_step.expired", row.id, {
      id: row.id,
      conversation_id: row.conversation_id,
      module_id: row.module_id,
      kind: row.kind,
      ref_id: row.ref_id,
    });
  return { ...row, status: "expired" };
}

/** O cliente abriu o link: sent → opened (uma vez) ou expirado pelo tempo. */
export async function touchWebStep(env: Env, row: any) {
  if (ACTIVE.includes(row.status) && row.expires_at <= now())
    return markExpired(env, row);
  if (row.status !== "sent") return row;
  const at = now();
  const result = await exec(
    env,
    "UPDATE web_steps SET status='opened',opened_at=?,updated=? WHERE id=? AND status='sent'",
    at,
    at,
    row.id,
  );
  if (result.meta?.changes)
    await event(env, row.profile_id, "web_step.opened", row.id, {
      id: row.id,
      conversation_id: row.conversation_id,
      module_id: row.module_id,
      kind: row.kind,
      ref_id: row.ref_id,
    });
  return { ...row, status: "opened", opened_at: at };
}

/** Alarme da área: passos vencidos viram expired. Barato; roda sempre. */
export async function expireWebSteps(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT * FROM web_steps WHERE profile_id=? AND status IN ('sent','opened') AND expires_at<=? LIMIT 50",
    profile,
    now(),
  ))
    await markExpired(env, row);
}

export async function listWebSteps(
  env: Env,
  actor: Actor,
  profile: string,
  conversationId: string,
) {
  access(actor, profile, "conversations:read");
  await conversation(env, conversationId, profile, actor);
  return {
    data: (
      await all(
        env,
        "SELECT * FROM web_steps WHERE profile_id=? AND conversation_id=? ORDER BY created DESC,id DESC LIMIT 50",
        profile,
        conversationId,
      )
    ).map(webStepView),
  };
}

export async function getWebStep(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "conversations:read");
  const row = await one(
    env,
    "SELECT * FROM web_steps WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Passo web não encontrado.");
  await conversation(env, row.conversation_id, profile, actor);
  return webStepView(row);
}

/** Atendente ou integração cancela um link ainda não usado. */
export async function cancelWebStep(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "conversations:write");
  const row = await one(
    env,
    "SELECT * FROM web_steps WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Passo web não encontrado.");
  await conversation(env, row.conversation_id, profile, actor);
  const result = await exec(
    env,
    "UPDATE web_steps SET status='cancelled',updated=? WHERE id=? AND status IN ('sent','opened')",
    now(),
    id,
  );
  if (!result.meta?.changes)
    throw new ApiError(
      409,
      "web_step_closed",
      "Este link já foi concluído, expirou ou foi cancelado.",
    );
  await event(env, profile, "web_step.cancelled", id, {
    id,
    conversation_id: row.conversation_id,
    module_id: row.module_id,
    kind: row.kind,
    ref_id: row.ref_id,
    actor: actor.id,
  });
  return webStepView(await one(env, "SELECT * FROM web_steps WHERE id=?", id));
}

// ---------------------------------------------------------------------------
// Concluir

/** Número da linha da conversa (ou da área) para o botão Voltar ao WhatsApp. */
export async function whatsappReturnLink(env: Env, c: Conversation) {
  const rows = await all(
    env,
    "SELECT id,config FROM connections WHERE profile_id=? AND kind IN ('zernio','qr','hermes-whatsapp') ORDER BY (id=?) DESC,created",
    c.profile_id,
    c.connection_id || "",
  );
  for (const row of rows) {
    const cfg = json(row.config);
    const digits = String(cfg.number || cfg.phone || "").replace(/\D/g, "");
    if (digits.length >= 10) return `https://wa.me/${digits}`;
  }
  return null;
}

export type CompleteResult =
  | { ok: true; step: any; whatsapp: string | null }
  | {
      ok: false;
      reason: "invalid" | "used" | "expired" | "not_found";
      errors?: Record<string, string>;
      whatsapp?: string | null;
    };

/**
 * Conclui o passo com as respostas do cliente. Roda no Coordinator da área.
 * O UPDATE condicionado ao estado garante o uso único do link.
 */
export async function completeWebStep(
  env: Env,
  id: string,
  input: Record<string, unknown>,
): Promise<CompleteResult> {
  const row = await one(env, "SELECT * FROM web_steps WHERE id=?", id);
  if (!row) return { ok: false, reason: "not_found" };
  let c: Conversation | null = null;
  try {
    c = await conversation(env, row.conversation_id, row.profile_id);
  } catch {
    c = null;
  }
  const whatsapp = c ? await whatsappReturnLink(env, c) : null;
  if (row.status === "completed")
    return { ok: false, reason: "used", whatsapp };
  if (!ACTIVE.includes(row.status) || row.expires_at <= now()) {
    if (ACTIVE.includes(row.status)) await markExpired(env, row);
    return { ok: false, reason: "expired", whatsapp };
  }
  const spec: WebStepSpec = json(row.spec);
  const { answers, errors, ok } = validateAnswers(spec.fields || [], input);
  if (!ok) return { ok: false, reason: "invalid", errors, whatsapp };
  const at = now();
  const claimed = await exec(
    env,
    "UPDATE web_steps SET status='completed',result=?,completed_at=?,opened_at=coalesce(opened_at,?),updated=? WHERE id=? AND status IN ('sent','opened') AND expires_at>?",
    JSON.stringify(answers),
    at,
    at,
    at,
    id,
    at,
  );
  if (!claimed.meta?.changes) return { ok: false, reason: "used", whatsapp };
  if (c) await afterCompletion(env, c, row, spec, answers);
  const done = webStepView(
    await one(env, "SELECT * FROM web_steps WHERE id=?", id),
  )!;
  await event(env, row.profile_id, "web_step.completed", id, {
    id,
    conversation_id: row.conversation_id,
    module_id: row.module_id,
    kind: row.kind,
    ref_id: row.ref_id,
    ticket_id: done.ticket_id,
    contact_id: done.contact_id,
    answers,
  });
  // O módulo dono reage (src/modules/api.ts, onWebStepCompleted).
  const hook = webStepHook(row.module_id);
  if (hook) await hook(env, row.profile_id, done, answers);
  return { ok: true, step: done, whatsapp };
}

/**
 * Resposta de Flow (content.flow_reply) de um passo entregue como Flow: casa
 * pelo flow_token na mesma conversa e conclui com os campos de mesmo id.
 * null quando o token não é de um passo web desta conversa.
 */
export async function completeWebStepByFlow(
  env: Env,
  c: Conversation,
  reply: { flow_token?: string | null; data?: Record<string, unknown> },
) {
  if (!reply?.flow_token) return null;
  const row = await one(
    env,
    "SELECT * FROM web_steps WHERE flow_token=? AND conversation_id=?",
    reply.flow_token,
    c.id,
  );
  if (!row) return null;
  const input: Record<string, unknown> = {};
  for (const field of (json(row.spec).fields || []) as WebField[]) {
    const value = reply.data?.[field.id];
    if (value === undefined || value === null) continue;
    input[field.id] =
      field.type === "accept"
        ? value === true ||
          ["true", "on", "1", "sim"].includes(String(value).toLowerCase())
        : field.type === "date" && typeof value === "number"
          ? new Date(value).toISOString().slice(0, 10)
          : Array.isArray(value)
            ? value.join(", ")
            : String(value);
  }
  return { step: row, result: await completeWebStep(env, row.id, input) };
}

async function afterCompletion(
  env: Env,
  c: Conversation,
  row: any,
  spec: WebStepSpec,
  answers: Answers,
) {
  const summary = answersText(spec.fields, answers);
  const contact = await one(
    env,
    "SELECT contact_id FROM conversation_contacts WHERE conversation_id=? AND profile_id=?",
    c.id,
    c.profile_id,
  );
  let ticket: any = null;
  if (spec.ticket !== "none") {
    ticket = await one(
      env,
      `SELECT * FROM tickets WHERE conversation_id=? AND ${activeTicketSql()} ORDER BY created DESC,id DESC LIMIT 1`,
      c.id,
    );
    if (!ticket && spec.ticket === "open") {
      const cfg = await settings(env, c.profile_id);
      const category = (cfg.ticket_categories || []).some(
        (item: any) => item.id === spec.ticket_category,
      )
        ? spec.ticket_category
        : null;
      ticket = (
        await createTicket(env, c, spec.title, {
          category,
          owner: null,
          sourceKey: `web-step:${row.id}`,
        })
      ).ticket;
    }
  }
  if (ticket) {
    await exec(
      env,
      "INSERT OR IGNORE INTO ticket_updates(id,ticket_id,actor,text,internal,created) VALUES(?,?,?,?,0,?)",
      "web-step:" + row.id,
      ticket.id,
      "customer",
      `${spec.title}\n${summary}`.slice(0, 20000),
      now(),
    );
    await event(env, c.profile_id, "ticket.updated", ticket.id, {
      status: ticket.status,
      previous_status: ticket.status,
      owner: ticket.owner,
      previous_owner: ticket.owner,
      text_added: true,
      actor: "customer",
      reason: "web_step",
      web_step_id: row.id,
    });
  }
  await exec(
    env,
    "UPDATE web_steps SET contact_id=?,ticket_id=? WHERE id=?",
    contact?.contact_id || null,
    ticket?.id || null,
    row.id,
  );
  // A equipe vê as respostas na própria conversa, como nota interna.
  await message(
    env,
    c,
    "note",
    "system",
    `${spec.title}: respondido pelo cliente.\n${summary}`.slice(0, 20000),
  );
  // Retorno ao cliente. "notification" usa o modelo de notificação já
  // configurado quando a janela de 24 horas da linha oficial está fechada.
  const text =
    (spec.return_text ||
      `Recebemos suas respostas de "${spec.title}". Obrigado!`) +
    (ticket ? `\n\nProtocolo: ${ticket.number}` : "");
  try {
    await enqueue(
      env,
      c,
      "system",
      "notification",
      {
        text: text.slice(0, 3800),
        automation: "web_step",
        web_step_id: row.id,
        ...(ticket ? { ticket_id: ticket.number } : {}),
      },
      `web-step-done:${row.id}`,
    );
  } catch (error) {
    // Linha removida ou sem permissão: as respostas continuam registradas.
    if (!(error instanceof ApiError)) throw error;
  }
}

// ---------------------------------------------------------------------------
// Página pública

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#111b21}main{max-width:560px;margin:0 auto;padding:20px 16px 40px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(11,20,26,.08)}h1{font-size:22px;line-height:1.25;margin:0 0 8px}p{margin:0 0 14px;white-space:pre-line}.intro{color:#54656f}label,fieldset{display:block;margin:18px 0 0;border:0;padding:0}.label,legend{font-weight:600;display:block;margin-bottom:6px;padding:0}small{display:block;color:#667781;margin-top:4px}input[type=text],input[type=date],textarea{width:100%;font:inherit;padding:12px;border:1px solid #d1d7db;border-radius:10px;background:#fff;color:inherit}textarea{min-height:110px;resize:vertical}.option{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e9edef;border-radius:10px;margin-top:8px;font-weight:400}.option input{margin-top:4px;width:18px;height:18px}.error{color:#c62828;font-size:14px;margin-top:6px}.invalid input,.invalid textarea{border-color:#c62828}button,.button{display:block;width:100%;margin-top:24px;padding:14px;border:0;border-radius:24px;background:#008069;color:#fff;font:600 16px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}.button.secondary{background:#fff;color:#008069;border:1px solid #008069}.state{text-align:center}.state .icon{font-size:44px;margin-bottom:8px}footer{margin-top:20px;text-align:center;color:#8696a0;font-size:13px}@media (prefers-color-scheme:dark){body{background:#0b141a;color:#e9edef}.card{background:#111b21}.intro,small{color:#8696a0}input[type=text],input[type=date],textarea{background:#202c33;border-color:#3b4a54}.option{border-color:#2a3942}.button.secondary{background:transparent;color:#00a884;border-color:#00a884}button,.button{background:#00a884;color:#111b21}}`;

function page(title: string, body: string, appName: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}<footer>${escape(appName)}</footer></main></body></html>`;
}

function fieldHtml(field: WebField, value: unknown, error: string | undefined) {
  const name = `f_${field.id}`;
  const help = field.help ? `<small>${escape(field.help)}</small>` : "";
  const err = error ? `<div class="error">${escape(error)}</div>` : "";
  const req = field.required ? " required" : "";
  const cls = error ? ' class="invalid"' : "";
  if (field.type === "choice")
    return `<fieldset${cls}><legend>${escape(field.label)}</legend>${help}${(
      field.options || []
    )
      .map(
        (option) =>
          `<label class="option"><input type="radio" name="${name}" value="${escape(option)}"${value === option ? " checked" : ""}${req}><span>${escape(option)}</span></label>`,
      )
      .join("")}${err}</fieldset>`;
  if (field.type === "accept")
    return `<div${cls}><label class="option"><input type="checkbox" name="${name}" value="on"${value === true || value === "on" ? " checked" : ""}${req}><span>${escape(field.label)}</span></label>${help}${err}</div>`;
  const input =
    field.type === "text" && field.multiline
      ? `<textarea name="${name}" maxlength="2000"${req}>${escape(value)}</textarea>`
      : `<input type="${field.type === "date" ? "date" : "text"}" name="${name}" value="${escape(value)}"${field.type === "text" ? ' maxlength="300"' : ""}${req}>`;
  return `<label${cls}><span class="label">${escape(field.label)}</span>${input}${help}${err}</label>`;
}

export function formPage(
  row: any,
  appName: string,
  values: Record<string, unknown> = {},
  errors: Record<string, string> = {},
) {
  const spec: WebStepSpec = json(row.spec);
  const body = `<div class="card"><h1>${escape(spec.title)}</h1>${spec.intro ? `<p class="intro">${escape(spec.intro)}</p>` : ""}${
    Object.keys(errors).length
      ? `<div class="error" role="alert">Confira os campos destacados.</div>`
      : ""
  }<form method="post" novalidate>${(spec.fields || [])
    .map((field) => fieldHtml(field, values[field.id], errors[field.id]))
    .join(
      "",
    )}<button type="submit">${escape(spec.submit_label || "Enviar")}</button></form></div>`;
  return page(spec.title, body, appName);
}

export function statePage(
  kind: "done" | "used" | "expired" | "not_found",
  appName: string,
  options: { title?: string; text?: string; whatsapp?: string | null } = {},
) {
  const content = {
    done: ["✅", "Pronto!", "Recebemos suas respostas."],
    used: [
      "✅",
      "Este link já foi usado",
      "As respostas já foram enviadas. Continue a conversa pelo WhatsApp.",
    ],
    expired: [
      "⏱️",
      "Este link expirou",
      "Peça um novo link na conversa pelo WhatsApp.",
    ],
    not_found: [
      "🔗",
      "Link inválido",
      "Confira se o endereço está completo ou peça um novo link na conversa.",
    ],
  }[kind];
  const back = options.whatsapp
    ? `<a class="button" href="${escape(options.whatsapp)}">Voltar ao WhatsApp</a>`
    : "";
  return page(
    options.title || content[1],
    `<div class="card state"><div class="icon" aria-hidden="true">${content[0]}</div><h1>${escape(content[1])}</h1><p>${escape(options.text || content[2])}</p>${back}</div>`,
    appName,
  );
}

/** Respostas do formulário HTML (campos f_<id>). */
export function formInput(form: FormData | URLSearchParams) {
  const input: Record<string, string> = {};
  form.forEach((value, key) => {
    if (key.startsWith("f_") && typeof value === "string")
      input[key.slice(2)] = value.slice(0, 5000);
  });
  return input;
}
