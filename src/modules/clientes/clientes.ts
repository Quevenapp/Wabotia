// Cadastro de clientes (módulo "clientes"): ganchos e rotas. Ficha em
// ./store.ts, autocadastro em ./selfservice.ts, exclusão em ./erasure.ts,
// linha do tempo em ./timeline.ts. Uso: docs/CLIENTES.md.
import { ApiError, type Actor, requireValue } from "../../types";
import {
  filteredHandlers,
  onMenuChoice,
  onConversationTurn,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  onWebStepValidate,
  type ModuleContext,
} from "../api";
import { normalizeKeyword, validateClientesSettings } from "./model";
import {
  accessLog,
  addPhone,
  consentsOf,
  createCustomer,
  customerPhones,
  fiscalDocumentsOf,
  linkFiscalDocument,
  loadCustomer,
  listCustomers,
  logAccess,
  removePhone,
  requireReason,
  revealCustomer,
  settingsOf,
  updateCustomer,
  viewFor,
} from "./store";
import {
  completeSelfService,
  customerOfConversation,
  SELF_KIND,
  sendRegistrationLink,
  validateSelfService,
} from "./selfservice";
import {
  cancelErasure,
  confirmErasure,
  customerForErasure,
  ERASE_KIND,
  erasureView,
  handleErasureTurn,
  listErasures,
  loadErasure,
  requestErasure,
  runDueErasures,
} from "./erasure";
import { customerTimeline } from "./timeline";
import { fiscalRecipient } from "./model";

const M = "clientes";

// Observações da equipe só para aplicação com notes:read. Os dados pessoais
// já saem mascarados de toda leitura; sem máscara, só pela revelação.
function visible(ctx: ModuleContext, actor: Actor, value: any): any {
  if (actor.kind !== "app" || ctx.mayRead(actor, "notes")) return value;
  const strip = (v: any): any =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => k !== "notes")
              .map(([k, x]) => [k, strip(x)]),
          )
        : v;
  return strip(value);
}
const { onRead, onCommand } = filteredHandlers(visible);

/** Pessoas da equipe; aplicação com a permissão dada. */
function team(ctx: ModuleContext, actor: Actor, appScope: string) {
  ctx.access(actor, appScope);
}
function adminOrScope(ctx: ModuleContext, actor: Actor, scope: string) {
  ctx.access(actor, scope);
  if (actor.kind === "user" && actor.role !== "admin")
    throw new ApiError(403, "admin_required", "Somente administradores.");
  if (actor.kind !== "user" && actor.kind !== "app")
    throw new ApiError(403, "forbidden", "Sem permissão.");
}

onSettingsSave(M, "clientes", validateClientesSettings);

// ---------------------------------------------------------------------------
// WhatsApp: menu, palavras e respostas

onMenuChoice("clientes_cadastro", async (ctx, c, _item, { rowId }) => {
  try {
    await sendRegistrationLink(ctx, c, {
      trigger: "menu",
      actor: "system",
      sourceKey: `menu:${rowId}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await ctx.sendMessage(c, { text: error.message }, { key: `menu:${rowId}` });
  }
});

async function askErasure(
  ctx: ModuleContext,
  c: any,
  via: "menu" | "whatsapp",
  rowId: string,
) {
  try {
    const customer = await customerForErasure(ctx, c);
    if (!customer)
      throw new ApiError(
        409,
        "phone_unverified",
        "Não foi possível confirmar o seu telefone por esta conversa. Fale com a equipe.",
      );
    if (customer.status === "erasing")
      throw new ApiError(409, "customer_erasing", "A exclusão dos seus dados já está em andamento.");
    await requestErasure(ctx, customer, c, {
      via,
      by: "system",
      channel: "button",
      sourceKey: `${via}:${rowId}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await ctx.sendMessage(c, { text: error.message }, { key: `erase-ask:${rowId}` });
  }
}

onMenuChoice("clientes_exclusao", async (ctx, c, _item, { rowId }) => {
  await askErasure(ctx, c, "menu", rowId);
});

onConversationTurn(M, async (ctx, c, turn) => {
  if (await handleErasureTurn(ctx, c, turn)) return true;
  if (turn.replyId) return false;
  const word = normalizeKeyword(turn.text);
  if (!word || word.length > 40) return false;
  const settings = await settingsOf(ctx);
  if (settings.erase_keywords.includes(word)) {
    await askErasure(ctx, c, "whatsapp", turn.rowId);
    return true;
  }
  if (settings.register_keywords.includes(word)) {
    try {
      await sendRegistrationLink(ctx, c, {
        trigger: "menu",
        actor: "system",
        sourceKey: `keyword:${turn.rowId}`,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await ctx.sendMessage(c, { text: error.message }, { key: `turn:${turn.rowId}` });
    }
    return true;
  }
  return false;
});

onWebStepValidate(M, async (ctx, step, answers) => {
  if (step.kind === SELF_KIND) return validateSelfService(ctx, step, answers);
  if (step.kind === ERASE_KIND) {
    const row = step.ref_id ? await loadErasure(ctx, step.ref_id).catch(() => null) : null;
    if (!row || (row.status !== "awaiting_confirmation" && row.status !== "processing"))
      return "Este pedido de exclusão não está mais aberto. Peça de novo pelo WhatsApp.";
  }
  return null;
});

onWebStepCompleted(M, async (ctx, step, answers) => {
  if (step.kind === SELF_KIND) return completeSelfService(ctx, step, answers);
  if (step.kind === ERASE_KIND && answers.confirmo === true && step.ref_id) {
    const c = await ctx.conversation(step.conversation_id);
    try {
      await confirmErasure(ctx, await loadErasure(ctx, step.ref_id), c, "link");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return error.message;
    }
  }
});

onSchedule(M, async (ctx, { now }) => {
  await runDueErasures(ctx, now);
});

// ---------------------------------------------------------------------------
// Leituras: /api/v1/profiles/:profile/clientes/…

onRead(M, "clientes/customers", async (ctx, actor, { query }) => {
  team(ctx, actor, "conversations:read");
  return listCustomers(ctx, actor, ctx.safeQuery(actor, query));
});

async function detail(ctx: ModuleContext, actor: Actor, id: string) {
  const row = await loadCustomer(ctx, id);
  const settings = await settingsOf(ctx);
  const open = await ctx.env.DB.prepare(
    "SELECT * FROM clientes_erasures WHERE customer_id=? AND profile_id=? AND status IN ('awaiting_confirmation','processing') ORDER BY created DESC LIMIT 1",
  )
    .bind(row.id, ctx.profile)
    .first();
  return {
    ...(await viewFor(ctx, actor, row, settings)),
    consents: (await consentsOf(ctx, row.id)).map((c) => ({
      id: c.id,
      status: c.status,
      source: c.source,
      terms_version: c.terms_version,
      created: c.created,
    })),
    fiscal_documents: await fiscalDocumentsOf(ctx, row.id),
    erasure: erasureView(open),
  };
}

onRead(M, "clientes/customers/:id", async (ctx, actor, { params }) => {
  team(ctx, actor, "conversations:read");
  return detail(ctx, actor, params.id);
});

onRead(M, "clientes/customers/:id/timeline", async (ctx, actor, { params, query }) => {
  team(ctx, actor, "conversations:read");
  return customerTimeline(ctx, actor, await loadCustomer(ctx, params.id), query);
});

// Revelar: GET com motivo; cada chamada fica na auditoria.
onRead(M, "clientes/customers/:id/reveal", async (ctx, actor, { params, query }) => {
  team(ctx, actor, "conversations:read");
  return revealCustomer(ctx, actor, params.id, query);
});

// Destinatário completo para emitir nota (registro "fiscal").
onRead(M, "clientes/customers/:id/fiscal-recipient", async (ctx, actor, { params, query }) => {
  team(ctx, actor, "contacts:read");
  const row = await loadCustomer(ctx, params.id);
  if (row.status !== "active")
    throw new ApiError(409, "customer_erased", "Os dados deste cliente foram excluídos a pedido do titular.");
  await logAccess(ctx, actor, row.id, "fiscal", ["document", "address", "ie", "im", "email"], requireReason(query.reason));
  return fiscalRecipient(row);
});

onRead(M, "clientes/customers/:id/access-log", async (ctx, actor, { params, query }) => {
  adminOrScope(ctx, actor, "contacts:read");
  await loadCustomer(ctx, params.id);
  return accessLog(ctx, { ...query, customer_id: params.id });
});

onRead(M, "clientes/access-log", async (ctx, actor, { query }) => {
  adminOrScope(ctx, actor, "contacts:read");
  return accessLog(ctx, query);
});

onRead(M, "clientes/conversations/:id", async (ctx, actor, { params }) => {
  team(ctx, actor, "conversations:read");
  const c = await ctx.conversation(params.id, actor);
  const row = c.chat_type === "group" ? null : await customerOfConversation(ctx, c);
  return {
    conversation_id: c.id,
    phone_verified: !!ctx.verifiedPhone(c),
    customer: row ? await detail(ctx, actor, row.id) : null,
  };
});

onRead(M, "clientes/erasures", async (ctx, actor, { query }) => {
  adminOrScope(ctx, actor, "contacts:read");
  return listErasures(ctx, query);
});

onRead(M, "clientes/erasures/:id", async (ctx, actor, { params }) => {
  adminOrScope(ctx, actor, "contacts:read");
  return erasureView(await loadErasure(ctx, params.id));
});

// ---------------------------------------------------------------------------
// Escritas (Coordinator, Idempotency-Key)

onRoute(M, { method: "POST", path: "clientes/customers", op: "clientes.customer.create" });
onCommand(M, "clientes.customer.create", async (ctx, actor, data) => {
  team(ctx, actor, "contacts:write");
  const row = await createCustomer(ctx, data || {}, {
    source: actor.kind === "app" ? "api" : "panel",
    actor: actor.id,
  });
  return viewFor(ctx, actor, row);
});

onRoute(M, { method: "PATCH", path: "clientes/customers/:id", op: "clientes.customer.update" });
onCommand(M, "clientes.customer.update", async (ctx, actor, data) => {
  team(ctx, actor, "contacts:write");
  const { id, phones: _phones, ...input } = data || {};
  const { row } = await updateCustomer(ctx, await loadCustomer(ctx, id), input, {
    actor: actor.id,
  });
  return viewFor(ctx, actor, row);
});

onRoute(M, { method: "POST", path: "clientes/customers/:id/phones", op: "clientes.phone.add" });
onCommand(M, "clientes.phone.add", async (ctx, actor, data) => {
  team(ctx, actor, "contacts:write");
  const row = await loadCustomer(ctx, data.id);
  requireValue(row.status === "active", "Esta ficha não aceita mudanças.");
  await addPhone(ctx, row.id, data.phone, { label: data.label, actor: actor.id });
  return viewFor(ctx, actor, row);
});

onRoute(M, { method: "POST", path: "clientes/customers/:id/phones/remove", op: "clientes.phone.remove" });
onCommand(M, "clientes.phone.remove", async (ctx, actor, data) => {
  team(ctx, actor, "contacts:write");
  const row = await loadCustomer(ctx, data.id);
  requireValue(row.status === "active", "Esta ficha não aceita mudanças.");
  // Telefone confirmado pelo canal: só administrador tira (é a identidade
  // que confirma a exclusão).
  const phones = await customerPhones(ctx, row.id);
  const target = phones.find((p) => p.phone === String(data.phone || "").replace(/\D/g, ""));
  if (target?.verified && actor.kind === "user" && actor.role !== "admin")
    throw new ApiError(403, "admin_required", "Somente administradores tiram um telefone confirmado pelo cliente.");
  await removePhone(ctx, row.id, data.phone);
  return viewFor(ctx, actor, row);
});

// Link do autocadastro na conversa (pela equipe ou integração que atende).
onRoute(M, { method: "POST", path: "clientes/invites", op: "clientes.invite" });
onCommand(M, "clientes.invite", async (ctx, actor, data, { requestId }) => {
  team(ctx, actor, "conversations:write");
  const c = await ctx.conversation(data?.conversation_id, actor);
  if (actor.kind === "app" && !ctx.mayMessage(actor, c))
    throw new ApiError(403, "forbidden", "Só quem atende a conversa envia o link.");
  const result = await sendRegistrationLink(ctx, c, {
    trigger: actor.kind === "app" && actor.id.startsWith("bot:") ? "module" : "agent",
    actor: actor.id,
    sourceKey: `invite:${requestId}`,
  });
  return { step: result.step, customer_id: result.customer_id, sent: result.created };
});

// Pedido de exclusão iniciado pela equipe: só manda a confirmação ao
// titular. Ninguém da equipe confirma por ele.
onRoute(M, { method: "POST", path: "clientes/customers/:id/erasure", op: "clientes.erasure.request" });
onCommand(M, "clientes.erasure.request", async (ctx, actor, data, { requestId }) => {
  team(ctx, actor, "contacts:write");
  const row = await loadCustomer(ctx, data.id);
  const channel = data.channel === "link" ? "link" : "button";
  let c;
  if (data.conversation_id) c = await ctx.conversation(data.conversation_id, actor);
  else {
    const phones = (await customerPhones(ctx, row.id)).map((p) => p.phone);
    const [recent] = await ctx.customerConversations(phones, { limit: 1 });
    if (!recent)
      throw new ApiError(
        409,
        "no_conversation",
        "O cliente não tem conversa pelo WhatsApp com um telefone da ficha: a confirmação precisa sair por lá.",
      );
    c = await ctx.conversation(recent.id);
  }
  const result = await requestErasure(ctx, row, c, {
    via: "panel",
    by: actor.id,
    channel,
    trigger: "agent",
    sourceKey: `panel:${requestId}`,
  });
  return result.erasure;
});

onRoute(M, { method: "POST", path: "clientes/erasures/:id/cancel", op: "clientes.erasure.cancel" });
onCommand(M, "clientes.erasure.cancel", async (ctx, actor, data) => {
  team(ctx, actor, "contacts:write");
  return cancelErasure(ctx, await loadErasure(ctx, data.id), actor.id);
});

// Nota emitida fora do Wabotia (NFapi, integração): vínculo e prazo legal.
onRoute(M, { method: "POST", path: "clientes/fiscal-documents", op: "clientes.fiscal.link" });
onCommand(M, "clientes.fiscal.link", async (ctx, actor, data) => {
  adminOrScope(ctx, actor, "contacts:write");
  return linkFiscalDocument(ctx, data || {});
});
