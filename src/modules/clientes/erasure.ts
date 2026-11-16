// Cadastro de clientes: exclusão dos dados a pedido do titular (LGPD, art.
// 18, VI). Pedido pela conversa (palavra-chave, item de menu), pelo link ou
// pela equipe; a confirmação só vale vinda do próprio WhatsApp do cliente
// (botão, resposta digitada ou link de uso único na conversa do telefone da
// ficha). Ficam a guarda fiscal das notas emitidas e os vínculos (ids de
// conversas e protocolos), sem dado pessoal. docs/CLIENTES.md.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, now, uid } from "../../types";
import { seal } from "../../security";
import {
  customerEraseHandlers,
  type CustomerErasure,
  type ModuleContext,
} from "../api";
import { fiscalRecipient, normalizeKeyword } from "./model";
import {
  createCustomer,
  customerPhones,
  loadCustomer,
  phoneVariants,
  settingsOf,
} from "./store";
import { customerOfConversation } from "./selfservice";

export const ERASE_KIND = "exclusao";
/** Prazo para o titular confirmar. */
export const CONFIRM_TTL = 48 * 3600000;
/** Envio da confirmação preso há mais que isto: a conversa é liberada mesmo assim. */
const FORCE_AFTER = 24 * 3600000;
export const REPLY_PREFIX = "clientes:";

const brDate = (ms: number) =>
  new Date(ms - 3 * 3600000).toISOString().slice(0, 10).split("-").reverse().join("/");

export function erasureView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    customer_id: row.customer_id,
    status: row.status,
    requested_via: row.requested_via,
    requested_by: row.requested_by,
    conversation_id: row.conversation_id,
    confirmed_via: row.confirmed_via,
    confirmed_at: row.confirmed_at,
    expires_at: row.expires_at,
    kept: {
      conversation_ids: JSON.parse(row.conversation_ids || "[]"),
      ticket_ids: JSON.parse(row.ticket_ids || "[]"),
      fiscal_documents: row.fiscal_documents,
      fiscal_retention_until: row.fiscal_retention_until,
    },
    modules: JSON.parse(row.modules || "{}"),
    core: row.core ? JSON.parse(row.core) : null,
    attempts: row.attempts,
    error: row.error,
    completed_at: row.completed_at,
    created: row.created,
    updated: row.updated,
  };
}

export const loadErasure = async (ctx: ModuleContext, id: unknown) => {
  const row =
    typeof id === "string"
      ? await one(
          ctx.env,
          "SELECT * FROM clientes_erasures WHERE id=? AND profile_id=?",
          id,
          ctx.profile,
        )
      : null;
  if (!row) throw new ApiError(404, "not_found", "Pedido de exclusão não encontrado.");
  return row;
};

const openErasureOf = (ctx: ModuleContext, customerId: string) =>
  one(
    ctx.env,
    "SELECT * FROM clientes_erasures WHERE customer_id=? AND profile_id=? AND status IN ('awaiting_confirmation','processing') ORDER BY created DESC LIMIT 1",
    customerId,
    ctx.profile,
  );

async function fiscalSummary(ctx: ModuleContext, customerId: string, at: number) {
  return (await one(
    ctx.env,
    "SELECT count(*) n,max(retain_until) until FROM clientes_fiscal_documents WHERE customer_id=? AND profile_id=? AND retain_until>?",
    customerId,
    ctx.profile,
    at,
  )) as { n: number; until: number | null };
}

/**
 * O telefone autenticado da conversa é um dos da ficha. Com telefone
 * confirmado pelo próprio cliente, só ele vale: um número acrescentado pela
 * equipe (talvez errado) não confirma a exclusão de outra pessoa.
 */
async function conversationOwnsCustomer(
  ctx: ModuleContext,
  c: Conversation,
  customerId: string,
) {
  const phone = ctx.verifiedPhone(c);
  if (!phone) return false;
  const phones = await customerPhones(ctx, customerId);
  const trusted = phones.some((p) => p.verified)
    ? phones.filter((p) => p.verified)
    : phones;
  const variants = new Set(phoneVariants(phone));
  return trusted.some((p) => variants.has(p.phone));
}

/** "1"/"2" só logo depois da pergunta; depois, só a palavra. */
const NUMBER_WINDOW = 30 * 60000;

function requestText(fiscal: { n: number; until: number | null }) {
  return [
    "Você pediu para excluir seus dados. Vamos apagar sua ficha (nome, CPF/CNPJ, endereço, e-mail e telefones), o histórico das conversas e os dados pessoais em pedidos, agendamentos e outros registros.",
    "",
    "Ficam guardados só:",
    ...(fiscal.n
      ? [
          `• as notas fiscais emitidas para você, como a lei fiscal exige, até ${brDate(fiscal.until!)};`,
        ]
      : []),
    "• o número dos atendimentos e protocolos, sem dados pessoais.",
    "",
    "Para confirmar, toque em Confirmar exclusão (ou responda CONFIRMAR). Para manter seus dados, toque em Manter meus dados (ou responda MANTER). O pedido vale por 48 horas.",
  ].join("\n");
}

/**
 * Abre o pedido e manda a confirmação na conversa do cliente. Repetir com
 * pedido aberto reenvia a mesma confirmação. `channel: "link"` manda um link
 * de uso único no lugar dos botões.
 */
export async function requestErasure(
  ctx: ModuleContext,
  customer: any,
  c: Conversation,
  options: {
    via: "whatsapp" | "menu" | "link" | "panel";
    by: string;
    channel?: "button" | "link";
    trigger?: "menu" | "agent" | "module";
    sourceKey: string;
  },
) {
  if (customer.status === "erased")
    throw new ApiError(409, "customer_erased", "Os dados deste cliente já foram excluídos.");
  if (!(await conversationOwnsCustomer(ctx, c, customer.id)))
    throw new ApiError(
      409,
      "phone_unverified",
      "A confirmação precisa ir para a conversa de um telefone da ficha, confirmado pelo WhatsApp.",
    );
  const at = now();
  let row = await openErasureOf(ctx, customer.id);
  if (row?.status === "processing")
    return { erasure: erasureView(row)!, sent: false };
  if (!row) {
    const id = uid();
    await exec(
      ctx.env,
      "INSERT OR IGNORE INTO clientes_erasures(id,profile_id,customer_id,status,requested_via,requested_by,conversation_id,expires_at,source_key,created,updated) VALUES(?,?,?,'awaiting_confirmation',?,?,?,?,?,?,?)",
      id,
      ctx.profile,
      customer.id,
      options.via,
      options.by,
      c.id,
      at + CONFIRM_TTL,
      options.sourceKey,
      at,
      at,
    );
    row = await one(
      ctx.env,
      "SELECT * FROM clientes_erasures WHERE source_key=?",
      options.sourceKey,
    );
    await ctx.publish(
      "clientes.erasure_requested",
      row.id,
      { erasure_id: row.id, customer_id: customer.id, requested_via: options.via },
      { key: row.id },
    );
  } else {
    // Reenvio: a pergunta é nova (o "1"/"2" volta a valer por 30 min).
    await exec(
      ctx.env,
      "UPDATE clientes_erasures SET conversation_id=?,updated=? WHERE id=?",
      c.id,
      at,
      row.id,
    );
  }
  const fiscal = await fiscalSummary(ctx, customer.id, at);
  const body = requestText(fiscal);
  const open = at - c.last_customer < 86400000;
  if (options.channel === "link") {
    await ctx.openWebStep(c, {
      kind: ERASE_KIND,
      ref: row.id,
      trigger: options.trigger || "agent",
      actor: options.by,
      sourceKey: `erase:${row.id}:${options.sourceKey}`,
      ttlMinutes: CONFIRM_TTL / 60000,
      text: body.split("\n\nPara confirmar")[0],
      button: "Excluir meus dados",
      spec: {
        title: "Excluir meus dados",
        intro: body.split("\n\nPara confirmar")[0],
        fields: [
          {
            id: "confirmo",
            type: "accept",
            label: "Confirmo que quero excluir meus dados pessoais.",
            required: true,
          },
        ],
        submit_label: "Excluir meus dados",
        done_text: "Pedido confirmado. Seus dados estão sendo excluídos.",
        return_message: "module",
        ticket: "none",
        private_answers: true,
      } as any,
    });
  } else {
    await ctx.sendInteractive(
      c,
      {
        type: "button",
        body,
        buttons: [
          { id: `${REPLY_PREFIX}apagar:${row.id}`, title: "Confirmar exclusão" },
          { id: `${REPLY_PREFIX}manter:${row.id}`, title: "Manter meus dados" },
        ],
      } as any,
      {
        key: `erase:${row.id}:${options.sourceKey}`,
        actor: options.by,
        notification: !open,
      },
    );
  }
  return { erasure: erasureView(row)!, sent: true };
}

/** Ficha da conversa; sem ficha, uma mínima (só o telefone) para excluir o histórico. */
export async function customerForErasure(ctx: ModuleContext, c: Conversation) {
  const found = await customerOfConversation(ctx, c);
  if (found) return found;
  const phone = ctx.verifiedPhone(c);
  if (!phone) return null;
  return createCustomer(
    ctx,
    { kind: "pf", name: "Cliente sem cadastro" },
    { source: "self", actor: `customer:${c.id}`, verifiedPhone: phone },
  );
}

export async function cancelErasure(
  ctx: ModuleContext,
  row: any,
  by: string,
  c?: Conversation | null,
) {
  if (row.status !== "awaiting_confirmation")
    throw new ApiError(
      409,
      "erasure_closed",
      row.status === "processing"
        ? "A exclusão já foi confirmada pelo titular e está em andamento."
        : "Este pedido de exclusão já foi encerrado.",
    );
  await exec(
    ctx.env,
    "UPDATE clientes_erasures SET status='cancelled',error=?,updated=? WHERE id=? AND status='awaiting_confirmation'",
    `Cancelado por ${by}.`,
    now(),
    row.id,
  );
  await ctx.publish(
    "clientes.erasure_cancelled",
    row.id,
    { erasure_id: row.id, customer_id: row.customer_id, by },
    { key: row.id },
  );
  if (c)
    await ctx.sendMessage(
      c,
      { text: "Tudo certo: seus dados continuam cadastrados." },
      { key: `erase:${row.id}:kept` },
    );
  return erasureView(await loadErasure(ctx, row.id))!;
}

/**
 * Confirmação do titular, vinda da conversa de um telefone da ficha. Quem
 * chama já garantiu o canal (botão do próprio canal, resposta digitada ou
 * link de uso único); aqui se confere o telefone e o prazo.
 */
export async function confirmErasure(
  ctx: ModuleContext,
  row: any,
  c: Conversation,
  via: "button" | "text" | "link",
) {
  if (row.status === "processing" || row.status === "done")
    return erasureView(row)!;
  if (row.status !== "awaiting_confirmation" || row.expires_at <= now())
    throw new ApiError(409, "erasure_closed", "Este pedido de exclusão venceu. Peça de novo.");
  if (!(await conversationOwnsCustomer(ctx, c, row.customer_id)))
    throw new ApiError(
      403,
      "not_titular",
      "Só o titular, pelo WhatsApp do telefone cadastrado, confirma a exclusão.",
    );
  const at = now();
  const claimed = await exec(
    ctx.env,
    "UPDATE clientes_erasures SET status='processing',confirmed_via=?,confirmed_at=?,updated=? WHERE id=? AND status='awaiting_confirmation'",
    via,
    at,
    at,
    row.id,
  );
  if (!claimed.meta.changes) return erasureView(await loadErasure(ctx, row.id))!;
  await exec(
    ctx.env,
    "UPDATE clientes_customers SET status='erasing',updated=? WHERE id=? AND profile_id=? AND status='active'",
    at,
    row.customer_id,
    ctx.profile,
  );
  // Última mensagem com o telefone: a conversa só perde o destino depois
  // que ela sair (runErasure tenta de novo na rodada periódica).
  await ctx.sendMessage(
    c,
    {
      text: "Pedido confirmado. Seus dados estão sendo excluídos agora. Se escrever de novo, começamos do zero.",
    },
    { key: `erase:${row.id}:confirmed` },
  );
  return runErasure(ctx, await loadErasure(ctx, row.id), at);
}

/**
 * Executa (ou continua) a exclusão confirmada. Repassa aos módulos
 * (onCustomerErase), apaga no núcleo e, quando tudo terminou, anonimiza a
 * ficha. Idempotente: a rodada periódica repete o que faltou.
 */
export async function runErasure(ctx: ModuleContext, row: any, at = now()) {
  if (row.status !== "processing") return erasureView(row)!;
  const customer = await loadCustomer(ctx, row.customer_id);
  const phones = (await customerPhones(ctx, customer.id)).map((p) => p.phone as string);
  const known: string[] = JSON.parse(row.conversation_ids || "[]");
  const found = (await ctx.customerConversations(phones, { limit: 200 })).map((c) => c.id);
  const conversationIds = [...new Set([...known, ...found, ...(row.conversation_id ? [row.conversation_id] : [])])];
  const tickets = (await ctx.customerTickets(conversationIds)).map((t) => t.id as string);
  const knownTickets: string[] = JSON.parse(row.ticket_ids || "[]");
  const ticketIds = [...new Set([...knownTickets, ...tickets])];
  const fiscal = await fiscalSummary(ctx, customer.id, at);
  // Guarda fiscal: os dados de destinatário das notas, cifrados, fora da ficha.
  if (fiscal.n && customer.status !== "erased")
    await exec(
      ctx.env,
      "INSERT OR IGNORE INTO clientes_fiscal_holds(customer_id,profile_id,sealed,retain_until,created) VALUES(?,?,?,?,?)",
      customer.id,
      ctx.profile,
      await seal(ctx.env, {
        recipient: fiscalRecipient(customer),
        kept_because:
          "Notas fiscais emitidas: guarda obrigatória pela legislação tributária (LGPD, art. 16, I).",
      }),
      fiscal.until,
      at,
    );
  const erasure: CustomerErasure = {
    erasure_id: row.id,
    customer_id: customer.id,
    phones,
    document: customer.document ?? null,
    conversation_ids: conversationIds,
    fiscal_retention_until: fiscal.n ? fiscal.until : null,
  };
  const modules: Record<string, any> = JSON.parse(row.modules || "{}");
  for (const [moduleId, hook] of customerEraseHandlers()) {
    if (moduleId === ctx.module.id || modules[moduleId]?.status === "done") continue;
    try {
      const result = (await hook(ctx.env, ctx.profile, erasure)) || {};
      modules[moduleId] = {
        status: "done",
        erased: Number(result.erased) || 0,
        kept: Number(result.kept) || 0,
        note: typeof result.note === "string" ? result.note.slice(0, 300) : null,
        at,
      };
    } catch (error) {
      modules[moduleId] = {
        status: "error",
        error: String((error as Error)?.message || error).slice(0, 300),
        at,
      };
      console.error(
        JSON.stringify({ component: "clientes-erasure", erasure: row.id, module: moduleId, error: modules[moduleId].error }),
      );
    }
  }
  const core = await ctx.eraseConversations(conversationIds, phones, {
    releaseIdentity: true,
    force: !!row.confirmed_at && at - row.confirmed_at > FORCE_AFTER,
  });
  const failed = Object.entries(modules).filter(([, m]) => m.status !== "done");
  const done = !failed.length && core.identity_released;
  await exec(
    ctx.env,
    "UPDATE clientes_erasures SET status=?,conversation_ids=?,ticket_ids=?,modules=?,core=?,fiscal_documents=?,fiscal_retention_until=?,attempts=attempts+1,error=?,completed_at=?,updated=? WHERE id=?",
    done ? "done" : "processing",
    JSON.stringify(conversationIds),
    JSON.stringify(ticketIds),
    JSON.stringify(modules),
    JSON.stringify(core),
    fiscal.n,
    fiscal.n ? fiscal.until : null,
    failed.length
      ? `Falta: ${failed.map(([id]) => id).join(", ")}`
      : core.identity_released
        ? null
        : "Aguardando a última mensagem sair.",
    done ? at : null,
    at,
    row.id,
  );
  if (done) {
    await anonymizeCustomer(ctx, customer.id, at);
    await ctx.publish(
      "clientes.customer_erased",
      customer.id,
      {
        customer_id: customer.id,
        erasure_id: row.id,
        conversations_kept: conversationIds.length,
        tickets_kept: ticketIds.length,
        fiscal_documents_kept: fiscal.n,
        fiscal_retention_until: fiscal.n ? fiscal.until : null,
      },
      { key: row.id },
    );
  }
  return erasureView(await loadErasure(ctx, row.id))!;
}

/** Ficha sem dado pessoal: a linha (id) fica como vínculo. */
async function anonymizeCustomer(ctx: ModuleContext, id: string, at: number) {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE clientes_customers SET status='erased',name='',trade_name='',document=NULL,document_type=NULL,individual_business=0,ie='',im='',email='',cep='',street='',number='',complement='',district='',city='',city_ibge='',uf='',notes='',search_text='',version=version+1,updated_by='titular',updated=?,erased_at=? WHERE id=? AND profile_id=?",
    ).bind(at, at, id, ctx.profile),
    ctx.env.DB.prepare(
      "DELETE FROM clientes_phones WHERE customer_id=? AND profile_id=?",
    ).bind(id, ctx.profile),
  ]);
}

/** Resposta do cliente a um pedido aberto nesta conversa. */
export async function handleErasureTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
) {
  const match = turn.replyId?.match(/^clientes:(apagar|manter):(.+)$/);
  // Toque em botão de outro módulo: não é resposta a este pedido.
  if (turn.replyId && !match) return false;
  let row: any = null;
  if (match) {
    row = await one(
      ctx.env,
      "SELECT * FROM clientes_erasures WHERE id=? AND profile_id=?",
      match[2],
      ctx.profile,
    );
    if (!row || row.status !== "awaiting_confirmation" || row.expires_at <= now()) {
      await ctx.sendMessage(
        c,
        { text: "Este pedido de exclusão não está mais aberto. Para pedir de novo, escreva EXCLUIR MEUS DADOS." },
        { key: `turn:${turn.rowId}` },
      );
      return true;
    }
  } else {
    row = await one(
      ctx.env,
      "SELECT * FROM clientes_erasures WHERE conversation_id=? AND profile_id=? AND status='awaiting_confirmation' AND expires_at>? ORDER BY created DESC LIMIT 1",
      c.id,
      ctx.profile,
      now(),
    );
    if (!row) return false;
  }
  const word = normalizeKeyword(turn.text);
  // Um "1" digitado horas depois é mais provável para o menu do que para
  // este pedido: número só vale logo depois da pergunta.
  const recent = now() - row.updated < NUMBER_WINDOW;
  const confirm = match
    ? match[1] === "apagar"
    : ["CONFIRMAR", "CONFIRMAR EXCLUSAO", "CONFIRMO"].includes(word) || (recent && word === "1");
  const keep = match
    ? match[1] === "manter"
    : ["MANTER", "MANTER MEUS DADOS", "CANCELAR"].includes(word) || (recent && word === "2");
  if (!confirm && !keep) return false;
  try {
    if (keep) await cancelErasure(ctx, row, `customer:${c.id}`, c);
    else await confirmErasure(ctx, row, c, match ? "button" : "text");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await ctx.sendMessage(c, { text: error.message }, { key: `turn:${turn.rowId}` });
  }
  return true;
}

/** Rodada periódica: vence pedidos, repete exclusões e encerra guardas. */
export async function runDueErasures(ctx: ModuleContext, at: number) {
  await exec(
    ctx.env,
    "UPDATE clientes_erasures SET status='expired',updated=? WHERE profile_id=? AND status='awaiting_confirmation' AND expires_at<=?",
    at,
    ctx.profile,
    at,
  );
  const pending = await all(
    ctx.env,
    "SELECT * FROM clientes_erasures WHERE profile_id=? AND status='processing' ORDER BY updated LIMIT 5",
    ctx.profile,
  );
  for (const row of pending) {
    // Intervalo dobrando de 1 min até 1 h entre tentativas.
    const wait = Math.min(3600000, 60000 * 2 ** Math.max(0, row.attempts - 1));
    if (row.updated + wait > at) continue;
    await runErasure(ctx, row, at);
  }
  // Fim do prazo legal: a guarda fiscal e o vínculo das notas somem.
  await exec(
    ctx.env,
    "DELETE FROM clientes_fiscal_holds WHERE profile_id=? AND retain_until<=?",
    ctx.profile,
    at,
  );
  await exec(
    ctx.env,
    "DELETE FROM clientes_fiscal_documents WHERE profile_id=? AND retain_until<=? AND customer_id IN (SELECT id FROM clientes_customers WHERE profile_id=? AND status='erased')",
    ctx.profile,
    at,
    ctx.profile,
  );
}

export async function listErasures(
  ctx: ModuleContext,
  query: { status?: string; customer_id?: string; limit?: string },
) {
  const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit)) || 50));
  const rows = await all(
    ctx.env,
    `SELECT * FROM clientes_erasures WHERE profile_id=?${query.status ? " AND status=?" : ""}${query.customer_id ? " AND customer_id=?" : ""} ORDER BY created DESC,id DESC LIMIT ?`,
    ctx.profile,
    ...(query.status ? [query.status] : []),
    ...(query.customer_id ? [query.customer_id] : []),
    limit,
  );
  return { data: rows.map(erasureView) };
}

export { settingsOf };
