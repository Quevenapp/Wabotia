// Para o contador, a parte do Worker: o cadastro do contador (D1), a conversa
// com o objeto do ERP da área (o pacote, ./do.ts), o envio do link seguro de
// 7 dias pelo WhatsApp da área ou por e-mail, o download pelo link e o envio
// automático do mês anterior (desligado por padrão).
//
// O link: um código aleatório de 256 bits que só vai na mensagem; o D1 guarda
// o SHA-256 dele, a validade e o pacote. Vale enquanto a parte Fiscal estiver
// ligada e o pacote não tiver sido refeito.
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { sha } from "../../security";
import { audit } from "../../events";
import { moduleStates } from "../../modules/registry";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import {
  CONTADOR_LINK_DAYS, CONTADOR_LINK_MS, contadorPackageId, periodLabel, previousMonth,
  type ContadorChannel, type ContadorPackageView,
} from "./contract.ts";
import { SIMPLES_ANNEXES } from "./report.ts";

// ---------------------------------------------------------------------------
// Objeto do ERP

/** Chama o objeto do ERP da área: com a pessoa (identidade) ou sem (envio automático e link). */
export async function contadorDo<T = any>(env: Env, profile: string, op: string, body: Record<string, unknown>, identity: IdentityPort | null): Promise<T> {
  let response: Response;
  try {
    const { erpFetch } = await import("../hub.ts");
    response = await erpFetch(env, profile, identity ? `/erp-contador/${op}` : `/erp-contador/sistema/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(identity ? { [IDENTITY_HEADER]: encodeIdentity(identity) } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  }
  const data = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = data?.error ?? data ?? {};
    const code = typeof error.code === "string" ? error.code : "";
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "module_disabled") throw new ApiError(409, "module_disabled", "Para o contador, ligue o módulo Fiscal em Gestão → Módulos.");
    if (code === "erp_parts_stale") throw new ApiError(409, "erp_parts_stale", "O estado dos módulos mudou agora. Tente de novo.");
    if (code === "erp_backup_fence" || response.status === 423) throw new ApiError(409, "erp_busy", "O ERP está fazendo backup agora. Tente de novo em alguns minutos.");
    if (response.status === 404) throw new ApiError(404, "not_found", message || "Pacote não encontrado.");
    if (response.status === 400) throw new ApiError(400, "invalid_request", message || "Confira o período e tente de novo.");
    if (response.status === 403) throw new ApiError(403, code || "forbidden", message || "Seu papel no ERP não alcança o que é do contador.");
    throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  }
  return data as T;
}

/** Parte Fiscal ligada (com o ERP); senão a mensagem de qual módulo ligar. */
export async function fiscalOffMessage(env: Env, profile: string): Promise<string | null> {
  return erpPartOffMessage("erp-fiscal", erpRequirement("erp-fiscal"), await moduleStates(env, profile));
}

// ---------------------------------------------------------------------------
// Cadastro do contador

export interface ContadorSettings {
  name: string | null; email: string | null; phone: string | null; channel: ContadorChannel; connection_id: string | null;
  auto_enabled: boolean; auto_day: number; auto_last_month: string | null; annexes: Record<string, string>;
  updated: number | null; updated_by: string | null;
}
const EMPTY: ContadorSettings = { name: null, email: null, phone: null, channel: "whatsapp", connection_id: null, auto_enabled: false, auto_day: 5,
  auto_last_month: null, annexes: {}, updated: null, updated_by: null };

export async function readSettings(env: Env, profile: string): Promise<ContadorSettings> {
  const r = await one(env, "SELECT * FROM erp_contador_settings WHERE profile_id=?", profile);
  if (!r) return { ...EMPTY };
  let annexes: Record<string, string> = {};
  try { const parsed = JSON.parse(String(r.annexes ?? "{}")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) annexes = parsed; } catch { /* vazio */ }
  return {
    name: r.name ?? null, email: r.email ?? null, phone: r.phone ?? null, channel: r.channel === "email" ? "email" : "whatsapp",
    connection_id: r.connection_id ?? null, auto_enabled: Number(r.auto_enabled) === 1, auto_day: Number(r.auto_day) || 5,
    auto_last_month: r.auto_last_month ?? null, annexes, updated: Number(r.updated) || null, updated_by: r.updated_by ?? null,
  };
}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
/** Telefone digitado: dígitos com DDI (55 quando vem só com DDD e número). */
export function contadorPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (/^\d{10,11}$/.test(digits)) return "55" + digits;
  if (/^55\d{10,11}$/.test(digits) || (value.trim().startsWith("+") && /^\d{8,15}$/.test(digits))) return digits;
  return null;
}

/** Confere e grava o cadastro. Campos ausentes ficam como estavam. */
export async function saveSettings(env: Env, profile: string, actor: Actor, body: Record<string, unknown>): Promise<ContadorSettings> {
  const current = await readSettings(env, profile);
  const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
  const text = (value: unknown, max: number, label: string) => {
    if (value === null || value === "") return null;
    if (typeof value !== "string") return bad(`${label}: informe um texto.`);
    const t = value.trim();
    if (t.length > max) bad(`${label}: até ${max} caracteres.`);
    return t || null;
  };
  const next = { ...current };
  if ("nome" in body) next.name = text(body.nome, 120, "Nome do contador");
  if ("email" in body) {
    const email = text(body.email, 200, "E-mail do contador");
    if (email && !EMAIL.test(email)) bad("E-mail do contador inválido. Confira o endereço (ex.: contador@escritorio.com.br).");
    next.email = email ? email.toLowerCase() : null;
  }
  if ("whatsapp" in body) {
    const raw = text(body.whatsapp, 30, "WhatsApp do contador");
    const phone = raw ? contadorPhone(raw) : null;
    if (raw && !phone) bad("WhatsApp do contador inválido: informe DDD e número (ex.: 11 98765-4321), ou + e o DDI fora do Brasil.");
    next.phone = phone;
  }
  if ("canal" in body) { if (body.canal !== "whatsapp" && body.canal !== "email") bad("Canal: whatsapp ou email."); next.channel = body.canal as ContadorChannel; }
  if ("linha" in body) next.connection_id = text(body.linha, 80, "Linha de WhatsApp");
  if ("automatico" in body) { if (typeof body.automatico !== "boolean") bad("Envio automático: verdadeiro ou falso."); next.auto_enabled = body.automatico as boolean; }
  if ("dia" in body) {
    const day = Number(body.dia);
    if (!Number.isInteger(day) || day < 1 || day > 28) bad("Dia do envio automático: de 1 a 28 (todo mês tem esse dia).");
    next.auto_day = day;
  }
  if ("anexos" in body) {
    const value = body.anexos;
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("Anexos: para cada natureza, o anexo do Simples (I a V).");
    const entries = Object.entries(value as Record<string, unknown>).filter(([, annex]) => annex !== null && annex !== "");
    if (entries.length > 300) bad("Anexos: até 300 naturezas.");
    for (const [nature, annex] of entries)
      if (!nature.trim() || nature.length > 160 || !(SIMPLES_ANNEXES as readonly unknown[]).includes(annex)) bad(`Anexo da natureza "${nature.slice(0, 60)}": escolha de I a V.`);
    next.annexes = Object.fromEntries(entries.map(([nature, annex]) => [nature.trim(), String(annex)]));
  }
  if (next.auto_enabled && !(next.channel === "email" ? next.email : next.phone))
    bad(next.channel === "email" ? "Para o envio automático por e-mail, informe o e-mail do contador." : "Para o envio automático pelo WhatsApp, informe o WhatsApp do contador.");
  const at = now();
  await exec(env, `INSERT INTO erp_contador_settings(profile_id,name,email,phone,channel,connection_id,auto_enabled,auto_day,auto_last_month,annexes,updated,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,channel=excluded.channel,
      connection_id=excluded.connection_id,auto_enabled=excluded.auto_enabled,auto_day=excluded.auto_day,annexes=excluded.annexes,updated=excluded.updated,updated_by=excluded.updated_by`,
  profile, next.name, next.email, next.phone, next.channel, next.connection_id, next.auto_enabled ? 1 : 0, next.auto_day, current.auto_last_month,
  JSON.stringify(next.annexes), at, actor.id);
  await audit(env, actor, profile, "erp_contador.settings", next.auto_enabled ? `automatico dia ${next.auto_day}` : "manual", uid());
  return readSettings(env, profile);
}

// ---------------------------------------------------------------------------
// Envio

/** Comando do Coordinator da área que põe a mensagem na fila (./command.ts). */
export const CONTADOR_WHATSAPP_COMMAND = "nfe.contador.whatsapp";
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const linkPath = (token: string) => `/api/public/contador/${token}`;
const maskPhone = (digits: string) => digits.length > 6 ? `+${digits.slice(0, 4)}…${digits.slice(-4)}` : "telefone";
const maskEmail = (address: string) => { const [user, domain] = address.split("@"); return `${user.slice(0, Math.min(2, Math.max(1, user.length - 1)))}***@${domain}`; };

export interface SendRow {
  id: string; profile_id: string; package_id: string; environment: string; period_from: string; period_to: string; channel: string; destination: string;
  contact_name: string | null; token_hash: string; expires: number; status: string; error: string | null; conversation_id: string | null; auto: number;
  actor: string; actor_name: string; via_bot: string | null; downloads: number; last_download: number | null; created: number; updated: number;
}
export const sendView = (r: SendRow) => ({
  id: r.id, pacote: r.package_id, periodo: periodLabel(r.period_from, r.period_to), de: r.period_from, ate: r.period_to, canal: r.channel,
  destino: r.destination, contador: r.contact_name, situacao: r.status, erro: r.error, automatico: Number(r.auto) === 1, por: r.actor_name,
  pelo_bot: !!r.via_bot, enviado_em: r.created, vale_ate: r.expires, vencido: r.expires <= Date.now(), downloads: Number(r.downloads) || 0,
  ultimo_download: r.last_download ?? null,
});
export async function listSends(env: Env, profile: string, limit = 50) {
  return (await all<SendRow>(env, "SELECT * FROM erp_contador_sends WHERE profile_id=? ORDER BY created DESC LIMIT ?", profile, limit)).map(sendView);
}

/** O texto da mensagem: o período, o link e a validade. */
export function sendText(company: string | null, pkg: { from: string; to: string }, link: string, contact: string | null): string {
  const hello = contact ? `Olá, ${contact.split(/\s+/)[0]}!` : "Olá!";
  return `${hello} Seguem os arquivos fiscais${company ? ` de ${company}` : ""} de ${periodLabel(pkg.from, pkg.to)} (XML e PDF das notas e a planilha de índice), num arquivo ZIP: ${link}\nO link vale por ${CONTADOR_LINK_DAYS} dias.`;
}

/** Nome da área (o que o contador reconhece). */
async function areaName(env: Env, profile: string): Promise<string | null> {
  const r = await one(env, "SELECT name FROM profiles WHERE id=?", profile).catch(() => null);
  return typeof r?.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : null;
}

async function publicBase(env: Env): Promise<string> {
  const { publicOrigin } = await import("../../web-steps");
  const origin = await publicOrigin(env);
  if (!origin) throw new ApiError(409, "public_origin_missing", "A instalação ainda não tem endereço público para o link do contador. O administrador configura em Gestão → Sistema.");
  return origin.replace(/\/+$/, "");
}

/**
 * Envia ao contador o link de um pacote pronto. `actor` é a pessoa (ou o
 * sistema, no automático). Grava o envio (enviado ou falhou) e devolve a visão.
 */
export async function sendToAccountant(env: Env, profile: string, input: {
  actor: Actor | null; packageId: string; channel?: ContadorChannel; auto?: boolean; identity: IdentityPort | null;
}): Promise<ReturnType<typeof sendView>> {
  const settings = await readSettings(env, profile);
  const channel: ContadorChannel = input.channel ?? settings.channel;
  const destination = channel === "email" ? settings.email : settings.phone;
  if (!destination)
    throw new ApiError(409, "contador_missing", channel === "email"
      ? "Cadastre o e-mail do contador em Fiscal › Para o contador › Contador e anexos, e envie de novo."
      : "Cadastre o WhatsApp do contador em Fiscal › Para o contador › Contador e anexos, e envie de novo.");
  if (channel === "email") {
    const { emailReady } = await import("../../email");
    if (!await emailReady(env)) throw new ApiError(409, "email_unavailable", "Esta instalação não envia e-mail (Gestão → Sistema → E-mail). Envie pelo WhatsApp.");
  }
  const files = await contadorDo<{ package: ContadorPackageView }>(env, profile, "arquivos", { id: input.packageId }, input.identity);
  const pkg = files.package;
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const link = `${await publicBase(env)}${linkPath(token)}`;
  const at = now(), id = uid();
  const actorId = input.actor?.id ?? "sistema", actorName = input.actor?.name ?? "Envio automático";
  const masked = channel === "email" ? maskEmail(destination) : maskPhone(destination);
  await exec(env, `INSERT INTO erp_contador_sends(id,profile_id,package_id,environment,period_from,period_to,channel,destination,contact_name,token_hash,expires,status,
      auto,actor,actor_name,via_bot,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'preparado',?,?,?,?,?,?)`,
  id, profile, pkg.id, pkg.environment, pkg.from, pkg.to, channel, masked, settings.name, await sha(token), at + CONTADOR_LINK_MS, input.auto ? 1 : 0,
  actorId, actorName, input.actor?.via?.bot_id ?? null, at, at);
  const text = sendText(await areaName(env, profile), pkg, link, settings.name);
  try {
    let conversation: string | null = null;
    if (channel === "email") {
      const { sendEmail } = await import("../../email");
      await sendEmail(env, { to: destination, subject: `Arquivos fiscais de ${periodLabel(pkg.from, pkg.to)}`, text },
        { purpose: "erp.contador", profileId: profile, moduleId: "erp-fiscal", userId: input.actor?.id ?? null, key: `erp-contador:${id}` });
    } else {
      const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch("https://coordinator/command", {
        method: "POST",
        body: JSON.stringify({ profile, operation: CONTADOR_WHATSAPP_COMMAND, actor: input.actor ?? systemActor(profile),
          data: { envio_id: id, phone: destination, text, line: settings.connection_id }, key: `erp-contador:${id}`, requestId: uid() }),
      });
      const body = await response.json().catch(() => null) as any;
      if (!response.ok) {
        const error = body?.error ?? body ?? {};
        throw new ApiError(response.status, typeof error.code === "string" ? error.code : "erp_contador_send_failed",
          typeof error.message === "string" ? error.message : "O envio não entrou na fila da conversa. Confira as conexões de WhatsApp e tente de novo.");
      }
      conversation = typeof body?.conversation_id === "string" ? body.conversation_id : null;
    }
    await exec(env, "UPDATE erp_contador_sends SET status='enviado',conversation_id=?,updated=? WHERE id=?", conversation, now(), id);
  } catch (error) {
    const reason = error instanceof ApiError ? error.message : "O envio não saiu. Tente de novo.";
    await exec(env, "UPDATE erp_contador_sends SET status='falhou',error=?,updated=? WHERE id=?", reason.slice(0, 500), now(), id);
    if (input.actor) await audit(env, input.actor, profile, "erp_contador.send_failed", `${pkg.id} ${channel}`, uid());
    throw error;
  }
  if (input.actor) await audit(env, input.actor, profile, "erp_contador.send", `${pkg.id} ${channel} ${pkg.from}..${pkg.to}`, uid());
  const row = await one<SendRow>(env, "SELECT * FROM erp_contador_sends WHERE id=?", id);
  return sendView(row!);
}

/** Quem envia no automático: o sistema, sem papel de pessoa. */
export function systemActor(profile: string): Actor {
  return { id: "sistema", kind: "app", name: "Envio automático ao contador", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 60, runLimit: 1 } as unknown as Actor;
}

// ---------------------------------------------------------------------------
// Link do contador (sem sessão)

const page = (status: number, title: string, text: string) => new Response(
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`
  + `<title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" } });

/** GET /api/public/contador/:código: o ZIP do pacote, enquanto o link valer. */
export async function contadorPublicDownload(env: Env, token: string): Promise<Response> {
  if (!LINK_TOKEN.test(token)) return page(404, "Link não encontrado", "Confira se o endereço chegou inteiro na mensagem, ou peça um link novo a quem enviou.");
  const row = await one<SendRow>(env, "SELECT * FROM erp_contador_sends WHERE token_hash=?", await sha(token));
  if (!row || row.status !== "enviado") return page(404, "Link não encontrado", "Confira se o endereço chegou inteiro na mensagem, ou peça um link novo a quem enviou.");
  if (row.expires <= Date.now()) return page(410, "Link vencido", `Este link valia por ${CONTADOR_LINK_DAYS} dias e já venceu. Peça um link novo à empresa que enviou.`);
  if (await fiscalOffMessage(env, row.profile_id)) return page(404, "Arquivos indisponíveis", "A empresa desligou esta parte do sistema. Peça os arquivos de novo a quem enviou.");
  let files: { keys: string[]; bytes: number; filename: string; package: ContadorPackageView };
  try { files = await contadorDo(env, row.profile_id, "arquivos", { id: row.package_id }, null); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return page(404, "Pacote refeito", "A empresa montou este pacote de novo depois do envio. Peça um link novo a quem enviou.");
    return page(503, "Tente de novo em instantes", "O sistema da empresa não respondeu agora. Tente abrir o link de novo em alguns minutos.");
  }
  if (files.package.from !== row.period_from || files.package.to !== row.period_to) return page(404, "Link não encontrado", "Peça um link novo a quem enviou.");
  await exec(env, "UPDATE erp_contador_sends SET downloads=downloads+1,last_download=?,updated=? WHERE id=?", now(), now(), row.id);
  return zipResponse(env, files, "attachment");
}

/** O ZIP: as partes do R2 na ordem, sem montar tudo na memória. */
export function zipResponse(env: Env, files: { keys: string[]; bytes: number; filename: string }, disposition = "attachment"): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= files.keys.length) { controller.close(); return; }
      const object = await env.MEDIA.get(files.keys[index++]);
      if (!object) { controller.error(new Error("parte do pacote ausente")); return; }
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/zip", "Content-Length": String(files.bytes),
    "Content-Disposition": `${disposition}; filename="${files.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" } });
}

// ---------------------------------------------------------------------------
// Envio automático (desligado por padrão)

/** Dia de hoje em São Paulo (AAAA-MM-DD). */
export const saoPauloToday = (at: number) => new Date(at - 3 * 3_600_000).toISOString().slice(0, 10);

/**
 * Uma passada do agendador do módulo (a cada poucos minutos, por área): no
 * dia escolhido (ou depois, se o dia passou parado), pede o pacote do mês
 * anterior e, pronto, envia ao contador. Um mês é tratado uma vez só: a
 * reivindicação no D1 vem antes do envio.
 */
export async function runAutoSend(env: Env, profile: string, at: number): Promise<"off" | "waiting" | "sent" | "failed" | "skipped"> {
  const settings = await readSettings(env, profile);
  if (!settings.auto_enabled) return "off";
  const today = saoPauloToday(at);
  if (Number(today.slice(8, 10)) < settings.auto_day) return "skipped";
  const period = previousMonth(today), month = period.from.slice(0, 7);
  if (settings.auto_last_month === month) return "skipped";
  if (await fiscalOffMessage(env, profile)) return "skipped";
  const id = await contadorPackageId("producao", period.from, period.to);
  let asked = await contadorDo<{ pacote: ContadorPackageView }>(env, profile, "pedir", { id, environment: "producao", from: period.from, to: period.to }, null);
  // Pacote pronto montado antes de o mês acabar pode não ter as últimas notas: monta de novo.
  const monthEnd = Date.parse(`${period.to}T00:00:00-03:00`) + 86_400_000;
  if (asked.pacote.state === "done" && asked.pacote.finished_at && Date.parse(asked.pacote.finished_at) < monthEnd)
    asked = await contadorDo(env, profile, "pedir", { id, environment: "producao", from: period.from, to: period.to, redo: true }, null);
  if (asked.pacote.state === "running") return "waiting";
  const claimed = await exec(env, "UPDATE erp_contador_settings SET auto_last_month=? WHERE profile_id=? AND auto_enabled=1 AND (auto_last_month IS NULL OR auto_last_month<>?)",
    month, profile, month);
  if (!claimed?.meta?.changes) return "skipped";
  if (asked.pacote.state === "failed") {
    const at2 = now();
    await exec(env, `INSERT INTO erp_contador_sends(id,profile_id,package_id,environment,period_from,period_to,channel,destination,contact_name,token_hash,expires,status,error,
        auto,actor,actor_name,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'falhou',?,1,'sistema','Envio automático',?,?)`,
    uid(), profile, id, "producao", period.from, period.to, settings.channel, settings.channel === "email" ? maskEmail(settings.email ?? "-@-") : maskPhone(settings.phone ?? ""),
    settings.name, `falhou:${uid()}`, at2, `O pacote do mês não pôde ser montado: ${asked.pacote.error ?? "erro desconhecido"}`.slice(0, 500), at2, at2);
    return "failed";
  }
  try { await sendToAccountant(env, profile, { actor: null, packageId: id, auto: true, identity: null }); return "sent"; }
  catch { return "failed"; } // O envio que falhou fica registrado com o motivo.
}
