// Rotas do envio de documentos do ERP pela conversa, em
// /api/v1/profiles/:profile/erp-conversa (operações em ./contract.ts).
//
// Conferências: pessoa da área com acesso às conversas, módulo ERP ligado (o
// middleware de módulo já recusa com 409 module_disabled), a parte do ERP do
// documento ligada, o documento visível para a pessoa no ERP (lido como ela,
// pelas rotas do painel), a privacidade de cadastro do cliente, a linha ativa
// com envio por atendentes e a conversa do número (atendente e setor). Pelo
// bot: só a operação concedida e, no envio, a proposta que a pessoa confirmou;
// o cliente só recebe documento que é dele, na conversa com identidade
// conferida. O envio em si roda no Coordinator da área (./command.ts).
import { exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { allows } from "../../access";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ERP_CONVERSA_DOC_TYPES, ERP_CONVERSA_PARTS, erpConversaOperationFor, type ErpConversaDocType } from "./contract.ts";
import { erpCall, loadDocument, type LoadedDocument, type ReceivablePayment } from "./documents.ts";
import { chargeContext, chargeSettings, confirmSuggestion, generateCharge, requireFinance, saveChargeSettings } from "./charges.ts";
import { paymentsMissing } from "../../payments";
import { formatPhone, messageText } from "./rules.ts";
import {
  assertBotRecipient, assertCanWrite, decisionFor, lineConversation, lineView, phoneInput, recordPhones, restrictedContact,
  samePhone, sendHistory, sendView, whatsappLine, whatsappLines, type SendRow,
} from "./service.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new ApiError(400, "invalid_request", "Identificador da conta inválido.");
  return value.toLowerCase();
}

/** A preferência e, para o administrador escolher, as contas financeiras e formas de pagamento do ERP. */
async function settingsView(env: Env, profile: string, actor: Actor) {
  const settings = await chargeSettings(env, profile);
  const list = async (path: string, what: string) => {
    try {
      const body = await erpCall(env, profile, actor, "GET", path, undefined, what);
      const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      return items.filter((item: any) => typeof item?.id === "string").map((item: any) => ({ id: item.id, nome: String(item.name ?? item.description ?? item.id), ativa: item.active !== false }));
    } catch { return []; }
  };
  const missing = await paymentsMissing(env, profile);
  return {
    baixar_sozinho: settings.auto_settle, conta_financeira: settings.account_id, forma_pagamento: settings.payment_method_id,
    ligada_em: settings.enabled_at, pode_mudar: actor.role === "admin" && !actor.via,
    cobranca_pronta: !missing, falta: missing?.message ?? null,
    contas: await list("/v1/financeiro/accounts", "as contas financeiras"),
    formas: await list("/v1/financeiro/formas-pagamento?kind=receivable", "as formas de pagamento"),
  };
}

function docType(value: string | undefined): ErpConversaDocType {
  if (!ERP_CONVERSA_DOC_TYPES.includes(value as ErpConversaDocType))
    throw new ApiError(404, "not_found", "Tipo de documento desconhecido: use proposta, pedido, nota ou conta.");
  return value as ErpConversaDocType;
}

/** A parte do ERP do documento está ligada? Desligada: 409 e qual ligar. */
async function requirePart(env: Env, profile: string, type: ErpConversaDocType) {
  const states = await moduleStates(env, profile);
  const part = ERP_CONVERSA_PARTS[type];
  const off = erpPartOffMessage(part, erpRequirement(part), states);
  if (off) throw new ApiError(409, "module_disabled", `${off} Sem ela, este documento não é enviado pelo WhatsApp.`);
  return states;
}

const PAYMENTS = ["pix", "link", "boleto", "sem"] as const;
function paymentChoice(value: unknown): ReceivablePayment | null {
  if (value === undefined || value === null || value === "") return null;
  if (!PAYMENTS.includes(value as ReceivablePayment)) throw new ApiError(400, "invalid_request", "pagamento: use pix, link, boleto ou sem.");
  return value as ReceivablePayment;
}

async function documentFor(env: Env, profile: string, actor: Actor, type: ErpConversaDocType, id: string, xml = false, light = false, payment: ReceivablePayment | null = null) {
  const states = await requirePart(env, profile, type);
  const doc = await loadDocument(env, profile, actor, type, id, { xml, parts: states, light, payment });
  if (await restrictedContact(env, profile, doc.contact_id))
    throw new ApiError(403, "erp_customer_restricted", "O cadastro deste cliente está restrito pela privacidade de cadastro; o documento não pode sair por aqui.");
  return { doc, phones: await recordPhones(env, profile, doc.contact_id, doc.phones) };
}

/** Tamanho null: arquivo da nota, que só vem do cofre no envio. */
const files = (doc: LoadedDocument) => doc.files.map(file => ({ nome: file.name, tipo: file.type, tamanho: file.bytes.byteLength || null }));
const sizes = (doc: LoadedDocument) => doc.files.map(file => ({ size: file.bytes.byteLength || 1 }));

async function prepare(env: Env, profile: string, actor: Actor, type: ErpConversaDocType, id: string, query: URLSearchParams) {
  const { doc, phones } = await documentFor(env, profile, actor, type, id, query.get("xml") === "1", true, paymentChoice(query.get("pagamento")));
  const lines = await whatsappLines(env, profile);
  const typed = query.get("telefone");
  const phone = typed ? phoneInput(typed) : phones[0] ?? null;
  const line = lines.find(item => item.id === query.get("linha")) ?? lines.find(item => item.kind === "zernio") ?? lines[0] ?? null;
  let destination = null;
  if (phone && line) {
    const c = await lineConversation(env, profile, phone, line.id);
    const decision = await decisionFor(env, profile, line, c, sizes(doc), doc.purpose, now());
    let problem: string | null = null;
    try { await assertCanWrite(env, actor, c); } catch (error) { if (error instanceof ApiError) problem = error.message; else throw error; }
    destination = { telefone: formatPhone(phone), digitos: phone, fora_do_cadastro: !phones.some(item => samePhone(item, phone)), linha: line.id,
      conversa: c ? { id: c.id, atendente: c.owner } : null, janela: decision.window, modo: problem ? "bloqueado" : decision.mode,
      motivo: problem ?? decision.reason, modelo: decision.template, pode_copiar_link: decision.can_copy_link, conversa_nova: decision.new_conversation };
  }
  return {
    documento: { tipo: type, id: doc.id, titulo: doc.title, cliente: doc.customer_name, abrir_no_erp: `/app/erp${doc.erp_path}` },
    telefones: phones.map(item => ({ digitos: item, numero: formatPhone(item) })),
    linhas: lines.map(lineView),
    conectar: lines.length ? null : "Conecte uma linha de WhatsApp em Conexões",
    destino: destination,
    previa: { texto: messageText(doc.facts), anexos: files(doc), xml_opcional: type === "nota", pagamento: doc.payment ?? null },
    envios: await sendHistory(env, profile, type, doc.id),
  };
}

async function coordinatorSend(env: Env, profile: string, actor: Actor, id: string, key: string, ttl: number) {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch("https://coordinator/command", {
    method: "POST",
    body: JSON.stringify({ profile, operation: "erp.conversa.enviar", actor, data: { envio_id: id, ttl_minutes: ttl }, key, requestId: uid() }),
  });
  const body = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const error = body?.error ?? body ?? {};
    throw new ApiError(response.status, typeof error.code === "string" ? error.code : "erp_conversa_failed",
      typeof error.message === "string" ? error.message : "O envio não chegou à fila da conversa. Confira o registro do documento antes de tentar de novo.");
  }
  return body;
}

async function send(env: Env, request: Request, profile: string, actor: Actor, type: ErpConversaDocType, id: string, body: Record<string, unknown>) {
  const action = body.acao ?? "enviar";
  if (action !== "enviar" && action !== "copiar_link") throw new ApiError(400, "invalid_request", "acao: use enviar ou copiar_link.");
  if (body.xml !== undefined && typeof body.xml !== "boolean") throw new ApiError(400, "invalid_request", "xml: use verdadeiro ou falso.");
  const key = request.headers.get("Idempotency-Key") ?? "";
  if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(400, "invalid_request", "Envie Idempotency-Key (até 200 caracteres ASCII).");
  const sendId = (await sha(`erp-conversa:${actor.id}:${profile}:${key}`)).slice(0, 32);
  const previous = await one<SendRow>(env, "SELECT * FROM erp_whatsapp_sends WHERE id=? AND profile_id=?", sendId, profile);
  if (previous && previous.status !== "preparado") return { envio: await sendView(env, previous), url: null, repetido: true };

  const { doc, phones } = await documentFor(env, profile, actor, type, id, body.xml === true, false, paymentChoice(body.pagamento));
  const phone = phoneInput(body.telefone);
  const inRecord = phones.some(item => samePhone(item, phone));
  const line = await whatsappLine(env, profile, body.linha);
  const c = await lineConversation(env, profile, phone, line.id);
  if (actor.via) await assertBotRecipient(env, profile, c, doc.contact_id, inRecord);
  await assertCanWrite(env, actor, c);
  const decision = await decisionFor(env, profile, line, c, sizes(doc), doc.purpose, now());
  if (action === "copiar_link" ? !decision.can_copy_link : decision.mode === "bloqueado")
    throw new ApiError(409, "erp_conversa_blocked", decision.reason ?? "Este envio não sai por esta linha agora.");
  const mode = action === "copiar_link" ? "link_copiado" : decision.mode === "mensagem" ? "arquivo" : decision.mode;

  // Anexos no armazenamento da área (o mesmo das mídias da conversa): vão
  // na mensagem ou ficam para o download da página do link.
  const media: string[] = [];
  for (const [index, file] of doc.files.entries()) {
    const mediaId = (await sha(`erp-conversa:${profile}:${sendId}:${index}`)).slice(0, 32);
    if (!await one(env, "SELECT id FROM media WHERE id=? AND profile_id=?", mediaId, profile)) {
      const objectKey = `${profile}/${mediaId}`;
      await env.MEDIA.put(objectKey, file.bytes, { httpMetadata: { contentType: file.type } });
      await exec(env, "INSERT OR IGNORE INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        mediaId, profile, file.name, file.type, file.bytes.byteLength, objectKey, actor.id, now());
    }
    media.push(mediaId);
  }
  const at = now();
  await exec(env, `INSERT OR IGNORE INTO erp_whatsapp_sends(id,profile_id,doc_type,doc_id,doc_label,erp_contact_id,phone,outside_record,connection_id,
      conversation_id,actor,actor_name,via_bot,mode,media_ids,web_step_id,text,page,status,error,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,'preparado',NULL,?,?)`,
    sendId, profile, type, doc.id, doc.title, doc.contact_id?.toLowerCase() ?? null, phone, inRecord ? 0 : 1, line.id, c?.id ?? null,
    actor.id, actor.name || actor.id, actor.via?.bot_id ?? null, mode, JSON.stringify(media), messageText(doc.facts), JSON.stringify(doc.page), at, at);
  const result = await coordinatorSend(env, profile, actor, sendId, key, doc.ttl_minutes);
  return { ...result, previa: { texto: messageText(doc.facts), anexos: files(doc) } };
}

/** GET/POST /api/v1/profiles/:profile/erp-conversa[/:tipo/:id[/envios|/enviar]]. */
export async function erpConversaRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const match = erpConversaOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "Documentos do ERP vão pelo WhatsApp por uma pessoa da área (ou pelo bot, com a confirmação dela).");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  if (operation.conversations !== false && !allows(actor, "conversations"))
    throw new ApiError(403, "forbidden", "Seu acesso não inclui as conversas. Peça ao administrador em Pessoas e acessos para enviar documentos pelo WhatsApp.");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => {
    throw new ApiError(400, "invalid_request", "Corpo do pedido inválido.");
  });
  const accepted = [...operation.body, ...(operation.optional ?? [])];
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !accepted.includes(key))))
    throw new ApiError(400, "invalid_request", `Informe só: ${accepted.join(", ")}.`);
  // Pelo bot: a operação concedida a ele e, no envio, a proposta que a pessoa confirmou.
  if (actor.via && !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação de envio pelo WhatsApp não foi liberada para este bot, ou falta a confirmação da pessoa.");

  switch (operation.name) {
    case "erp.financeiro.cobranca.preferencias":
      await requireFinance(env, profile);
      return json(await settingsView(env, profile, actor));
    case "erp.financeiro.cobranca.preferencias.salvar":
      await requireFinance(env, profile);
      await saveChargeSettings(env, actor, profile, body!);
      return json(await settingsView(env, profile, actor));
    case "erp.financeiro.cobranca.ver":
      return json(await chargeContext(env, actor, profile, uuidParam(params.id)));
    case "erp.financeiro.cobranca.gerar":
      if (!allows(actor, "payments"))
        throw new ApiError(403, "forbidden", "Seu acesso não inclui a Cobrança. Peça ao administrador em Pessoas e acessos para gerar Pix ou link de pagamento.");
      return json(await generateCharge(env, actor, profile, uuidParam(params.id), body!.forma));
    case "erp.financeiro.cobranca.confirmar_baixa":
      return json(await confirmSuggestion(env, actor, profile, uuidParam(params.id), String(params.cobranca), body!));
    case "erp.conversa.linhas": {
      const lines = await whatsappLines(env, profile);
      return json({ linhas: lines.map(lineView), conectar: lines.length ? null : "Conecte uma linha de WhatsApp em Conexões" });
    }
    case "erp.conversa.preparar":
      return json(await prepare(env, profile, actor, docType(params.tipo), params.id!, url.searchParams));
    case "erp.conversa.envios": {
      const type = docType(params.tipo);
      await requirePart(env, profile, type);
      // Quem vê o documento no ERP vê os envios dele.
      await loadDocument(env, profile, actor, type, params.id!, { parts: await moduleStates(env, profile), light: true });
      return json({ envios: await sendHistory(env, profile, type, params.id!) });
    }
    case "erp.conversa.enviar":
      return json(await send(env, request, profile, actor, docType(params.tipo), params.id!, body!));
  }
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
