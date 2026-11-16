// Envio de e-mail pelo Cloudflare Email Sending, pela API REST (não pelo
// binding: a instalação não precisa republicar o Worker para ligar). Guia de
// configuração em docs/EMAIL.md.
//
// - Configuração em Gestão → Sistema: Account ID, token (guardado cifrado),
//   endereço e nome do remetente. Sem ela, o e-mail fica indisponível e os
//   links do administrador continuam valendo.
// - Nenhum segredo no assunto: links de uso único vão no corpo, com o código
//   no fragmento da URL (src/install-links.ts).
// - Cada envio fica em email_log, com o endereço mascarado e o hash, sem o
//   corpo. `key` torna o envio idempotente na área.
import { all, exec, one } from "./db";
import { ApiError, type Actor, type Env, now, uid } from "./types";
import { admin, safeFetch, secret, setSecret, sha } from "./security";

const CONFIG_ID = "email:config";
const API = "https://api.cloudflare.com/client/v4";
/** Limite diário de e-mails de módulos por área (ctx.sendEmail). */
export const EMAIL_AREA_DAILY = 200;

export interface EmailConfig {
  account_id?: string;
  token?: string;
  from_address?: string;
  from_name?: string;
  updated?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailMeta {
  /** Finalidade (account.reset, account.invite, test, billing…). */
  purpose: string;
  profileId?: string | null;
  moduleId?: string | null;
  userId?: string | null;
  /** Idempotência na área: o mesmo `key` não sai duas vezes. */
  key?: string | null;
}

export type EmailStatus = "sent" | "queued" | "bounced";

const emailShape = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const validEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && emailShape.test(value);

export async function emailConfig(env: Env): Promise<EmailConfig> {
  return (await secret(env, CONFIG_ID)) as EmailConfig;
}

export const configured = (cfg: EmailConfig) =>
  !!(cfg.account_id && cfg.token && cfg.from_address);

/** O e-mail está configurado (esqueci a senha, convites e alertas). */
export async function emailReady(env: Env) {
  try {
    return configured(await emailConfig(env));
  } catch {
    // Sem MASTER_KEY, nada a decifrar: sem e-mail.
    return false;
  }
}

export function publicEmailConfig(cfg: EmailConfig) {
  return {
    configured: configured(cfg),
    account_id: cfg.account_id || "",
    token_configured: !!cfg.token,
    from_address: cfg.from_address || "",
    from_name: cfg.from_name || "",
    updated: cfg.updated || 0,
  };
}

/** system.email.configure: grava (ou, com `remove`, apaga) a configuração. */
export async function configureEmail(env: Env, actor: Actor, data: any) {
  admin(actor);
  if (data?.remove === true) {
    await exec(env, "DELETE FROM secrets WHERE id=?", CONFIG_ID);
    return publicEmailConfig({});
  }
  const accountId = String(data?.account_id || "").trim();
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new ApiError(
      400,
      "invalid_request",
      "Informe o Account ID da Cloudflare (32 caracteres).",
    );
  const from = String(data?.from_address || "")
    .trim()
    .toLowerCase();
  if (!validEmail(from))
    throw new ApiError(
      400,
      "invalid_request",
      "Informe o endereço do remetente, no domínio cadastrado na Cloudflare.",
    );
  const name = String(data?.from_name ?? "").trim();
  if (name.length > 80 || /[\r\n<>"]/.test(name))
    throw new ApiError(
      400,
      "invalid_request",
      "Use um nome de remetente com até 80 caracteres, sem aspas nem < >.",
    );
  const old = await emailConfig(env);
  // Token vazio mantém o atual, se a conta for a mesma.
  const token =
    data?.token || (old.account_id === accountId ? old.token || "" : "");
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 1024 ||
    /\s/.test(token)
  )
    throw new ApiError(
      400,
      "invalid_request",
      "Informe um token de API da Cloudflare com permissão de envio de e-mail.",
    );
  const cfg: EmailConfig = {
    account_id: accountId,
    token,
    from_address: from,
    from_name: name,
    updated: now(),
  };
  await setSecret(env, CONFIG_ID, cfg);
  return publicEmailConfig(cfg);
}

/** Endereço mascarado para o registro: "an***@exemplo.com". */
export function maskEmail(address: string) {
  const [user, domain] = address.split("@");
  return `${user.slice(0, Math.min(2, user.length - 1))}***@${domain}`;
}

/**
 * Assunto sem segredo: sem quebra de linha, sem endereço de link e sem
 * sequência longa que pareça um código (link, token, senha).
 */
export function assertSafeSubject(subject: string) {
  if (
    !subject.trim() ||
    subject.length > 200 ||
    /[\r\n]/.test(subject) ||
    /[a-z][a-z0-9+.-]*:\/\//i.test(subject) ||
    /#(reset|invite|setup)=/i.test(subject) ||
    /[A-Za-z0-9_-]{24,}/.test(subject)
  )
    throw new ApiError(
      400,
      "invalid_subject",
      "Assunto inválido: até 200 caracteres, sem links nem códigos.",
    );
}

/** Erros da API de envio da Cloudflare (docs/EMAIL.md, "Problemas"). */
const PROVIDER_ERRORS: Record<number, [number, string, string]> = {
  10105: [
    409,
    "email_not_entitled",
    "A conta Cloudflare não tem o envio de e-mail liberado. Ele exige o plano Workers Paid (docs/EMAIL.md).",
  ],
  10203: [
    409,
    "email_sending_disabled",
    "O envio de e-mail está desligado para este domínio na Cloudflare. Confira o domínio em Email Sending (docs/EMAIL.md).",
  ],
  10207: [
    409,
    "email_account_suspended",
    "A Cloudflare suspendeu o envio de e-mail desta conta. Veja o aviso no painel da Cloudflare.",
  ],
  10101: [
    502,
    "email_unauthorized",
    "A Cloudflare recusou o token. Crie um token com a permissão de envio de e-mail (docs/EMAIL.md).",
  ],
  10102: [
    502,
    "email_unauthorized",
    "O token não tem permissão de envio de e-mail nesta conta (docs/EMAIL.md).",
  ],
  10103: [
    502,
    "email_unauthorized",
    "Use um token de API (não a chave global) com a permissão de envio de e-mail.",
  ],
  10004: [
    429,
    "email_throttled",
    "A Cloudflare limitou os envios por agora. Tente de novo em alguns minutos.",
  ],
  10001: [400, "email_invalid", "A Cloudflare recusou a mensagem."],
  10200: [400, "email_invalid", "A mensagem passou do tamanho permitido."],
  10202: [
    400,
    "email_invalid",
    "A Cloudflare recusou o remetente ou o destinatário. Confira o endereço do remetente no domínio cadastrado.",
  ],
};

class ProviderError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly providerCode: string,
  ) {
    super(status, code, message);
  }
}

async function deliver(
  cfg: EmailConfig,
  msg: EmailMessage,
): Promise<EmailStatus> {
  let response: Response;
  try {
    response = await safeFetch(
      `${API}/accounts/${cfg.account_id}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: msg.to,
          from: cfg.from_name
            ? { address: cfg.from_address, name: cfg.from_name }
            : cfg.from_address,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      },
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ProviderError(
      502,
      "email_failed",
      "Não foi possível falar com a Cloudflare para enviar o e-mail.",
      "network",
    );
  }
  const body: any = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const code = Number(body?.errors?.[0]?.code) || 0;
    const known = PROVIDER_ERRORS[code];
    throw new ProviderError(
      known?.[0] ?? 502,
      known?.[1] ?? "email_failed",
      known?.[2] ??
        `A Cloudflare não enviou o e-mail (HTTP ${response.status}).`,
      String(code || response.status),
    );
  }
  const result = body.result ?? body;
  const has = (list: unknown) =>
    Array.isArray(list) &&
    list.some((item) => String(item).toLowerCase() === msg.to);
  if (has(result.permanent_bounces)) return "bounced";
  if (has(result.queued)) return "queued";
  return "sent";
}

/**
 * Envia um e-mail e registra em email_log. Sem configuração, 409
 * email_unavailable. Com `key` já usada na área, devolve o envio anterior
 * sem mandar de novo.
 */
export async function sendEmail(
  env: Env,
  msg: EmailMessage,
  meta: EmailMeta,
): Promise<{ id: string; status: EmailStatus | string; repeated?: true }> {
  const to = String(msg.to || "")
    .trim()
    .toLowerCase();
  if (!validEmail(to))
    throw new ApiError(
      400,
      "invalid_request",
      "E-mail do destinatário inválido.",
    );
  assertSafeSubject(msg.subject);
  if (
    typeof msg.text !== "string" ||
    !msg.text.trim() ||
    msg.text.length > 50000
  )
    throw new ApiError(400, "invalid_request", "Informe o texto do e-mail.");
  if (
    msg.html !== undefined &&
    (typeof msg.html !== "string" || msg.html.length > 200000)
  )
    throw new ApiError(400, "invalid_request", "HTML do e-mail inválido.");
  const cfg = await emailConfig(env);
  if (!configured(cfg))
    throw new ApiError(
      409,
      "email_unavailable",
      "O envio de e-mail não está configurado nesta instalação (Gestão → Sistema).",
    );
  const id = uid();
  const inserted = await exec(
    env,
    "INSERT OR IGNORE INTO email_log(id,profile_id,module_id,user_id,purpose,to_masked,to_hash,status,key,created) VALUES(?,?,?,?,?,?,?,'sending',?,?)",
    id,
    meta.profileId ?? null,
    meta.moduleId ?? null,
    meta.userId ?? null,
    meta.purpose,
    maskEmail(to),
    await sha(to),
    meta.key ?? null,
    now(),
  );
  if (!inserted.meta?.changes) {
    const previous = await one(
      env,
      "SELECT id,status FROM email_log WHERE profile_id IS ? AND key=?",
      meta.profileId ?? null,
      meta.key,
    );
    return { id: previous.id, status: previous.status, repeated: true };
  }
  try {
    const status = await deliver(cfg, { ...msg, to });
    await exec(env, "UPDATE email_log SET status=? WHERE id=?", status, id);
    return { id, status };
  } catch (e) {
    await exec(
      env,
      "UPDATE email_log SET status='failed',error_code=? WHERE id=?",
      e instanceof ProviderError ? e.providerCode : "error",
      id,
    );
    throw e;
  }
}

/** Envios de módulos na área nas últimas 24 h (limite EMAIL_AREA_DAILY). */
export async function areaEmailCount(env: Env, profileId: string) {
  return (
    await one(
      env,
      "SELECT count(*) n FROM email_log WHERE profile_id=? AND created>?",
      profileId,
      now() - 86400000,
    )
  ).n as number;
}

/** Últimos envios (Gestão → Sistema), sem corpo e com o endereço mascarado. */
export async function emailLog(env: Env, limit = 50) {
  return all(
    env,
    "SELECT id,profile_id,module_id,purpose,to_masked,status,error_code,created FROM email_log ORDER BY created DESC LIMIT ?",
    Math.min(200, Math.max(1, limit)),
  );
}

// ---- Mensagens da conta ----------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

const brasilia = (at: number) =>
  new Date(at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });

export type AccountEmailKind =
  "reset" | "invite" | "password_changed" | "mfa_reset" | "test";

/**
 * Texto dos e-mails da conta. O assunto nunca leva o link nem o código; o
 * link vai no corpo, com o código no fragmento.
 */
export function accountEmail(
  kind: AccountEmailKind,
  input: { name?: string; url?: string; expiresAt?: number; at?: number },
): Omit<EmailMessage, "to"> {
  const hello = `Olá${input.name ? ", " + input.name : ""}.`;
  const until = input.expiresAt ? brasilia(input.expiresAt) : "";
  const when = brasilia(input.at ?? now());
  const content: Record<AccountEmailKind, [string, string[], string?]> = {
    reset: [
      "Redefinir sua senha do Wabotia",
      [
        hello,
        "Recebemos um pedido para redefinir a senha da sua conta. Use o link abaixo para criar uma senha nova. Ele vale uma vez só" +
          (until ? `, até ${until}.` : "."),
        "Se não foi você, ignore este e-mail: sua senha continua a mesma.",
      ],
      "Criar senha nova",
    ],
    invite: [
      "Convite para o Wabotia",
      [
        hello,
        "Você foi convidado para a equipe de atendimento. Use o link abaixo para criar sua senha e entrar. Ele vale uma vez só" +
          (until ? `, até ${until}.` : "."),
      ],
      "Criar minha senha",
    ],
    password_changed: [
      "Sua senha do Wabotia foi trocada",
      [
        hello,
        `A senha da sua conta foi trocada em ${when} (horário de Brasília) e as sessões abertas foram encerradas.`,
        "Se não foi você, fale com o administrador da sua empresa agora.",
      ],
    ],
    mfa_reset: [
      "O segundo fator da sua conta foi removido",
      [
        hello,
        `O segundo fator (aplicativo autenticador) da sua conta foi removido em ${when} (horário de Brasília) e as sessões abertas foram encerradas. Ao entrar, cadastre-o de novo em Minha conta.`,
        "Se você não pediu isso, fale com o administrador da sua empresa agora.",
      ],
    ],
    test: [
      "Teste de e-mail do Wabotia",
      [
        hello,
        "Este é um teste do envio de e-mail da sua instalação. Se chegou, os e-mails de senha, convite e alertas da conta também vão chegar.",
      ],
    ],
  };
  const [subject, paragraphs, action] = content[kind];
  const link = action && input.url ? input.url : "";
  const text = [
    ...paragraphs,
    ...(link ? [`${action}: ${link}`] : []),
    "— Wabotia",
  ].join("\n\n");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;max-width:560px">` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    (link
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#128c7e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action!)}</a></p><p style="font-size:13px;color:#52606d">Se o botão não abrir, copie o endereço: ${escapeHtml(link)}</p>`
      : "") +
    `<p style="font-size:13px;color:#52606d">— Wabotia</p></div>`;
  return { subject, text, html };
}

/**
 * Link de convite ou de nova senha por e-mail, quando o administrador pede
 * (`send_email`). A falha não desfaz o link, que ele ainda pode copiar.
 */
export async function mailAccountLink(
  env: Env,
  user: { id: string; name?: string; email: string },
  kind: "reset" | "invite",
  link: { url: string; expires_at: number },
) {
  try {
    const sent = await sendEmail(
      env,
      {
        to: user.email,
        ...accountEmail(kind, {
          name: user.name,
          url: link.url,
          expiresAt: link.expires_at,
        }),
      },
      { purpose: `account.${kind}`, userId: user.id },
    );
    return { email_status: sent.status };
  } catch (e: any) {
    return {
      email_status: "failed",
      email_error: {
        code: e?.code || "email_failed",
        message: e?.message || "Não foi possível enviar o e-mail.",
      },
    };
  }
}

/**
 * Alerta da conta (senha trocada, segundo fator removido) sem atrapalhar a
 * ação: sem e-mail configurado ou com falha, só fica no registro.
 */
export async function alertAccount(
  env: Env,
  userId: string,
  kind: "password_changed" | "mfa_reset",
) {
  try {
    if (!(await emailReady(env))) return;
    const user = await one(
      env,
      "SELECT id,name,email FROM users WHERE id=?",
      userId,
    );
    if (!user?.email) return;
    await sendEmail(
      env,
      { to: user.email, ...accountEmail(kind, { name: user.name }) },
      { purpose: `account.${kind}`, userId },
    );
  } catch {
    // Registrado em email_log; o alerta não desfaz a ação.
  }
}
