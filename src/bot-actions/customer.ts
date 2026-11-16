// Modo cliente: o bot do provedor de IA direto atendendo o cliente no
// WhatsApp usa só as ferramentas que os módulos declaram para a conversa
// (onMcpTool, as mesmas da chave presa à conversa do Hermes). Nunca o
// catálogo nem ferramenta de equipe. Regras (docs/MODULOS.md "Ferramentas
// para bots"):
// - a identidade é a conversa: o `conversation_id` é sempre o da execução,
//   nunca o do modelo; o ator é o bot preso a ela (conversations:bound);
// - leitura sem dado pessoal além do que o módulo libera sem contacts:read;
// - escrita vira proposta que o próprio cliente confirma por botão na
//   conversa; preço, desconto e estado financeiro vêm do módulo, nunca do
//   modelo; "já paguei" não muda nada (só o webhook do provedor).
import { exec, one } from "../db";
import { internalCall } from "../mcp";
import { sha } from "../security";
import { moduleMcpTools, type ModuleMcpTool } from "../modules/hooks";
import { moduleStates } from "../modules/registry";
import { enqueue } from "../service";
import { sendInteractive } from "../line-service";
import { ApiError, type Actor, type Conversation, type Env, json, now, uid } from "../types";
import {
  MAX_PROPOSALS,
  MAX_TOOL_CALLS,
  PROPOSAL_TTL,
  sanitize,
  type BotTool,
  type ToolState,
} from "./actions";

const MAX_RESULT = 4000;
const normalize = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
export const CUSTOMER_REPLY = "botacao:";
/** Respostas digitadas que podem ser a uma proposta (o resto nem consulta). */
// Sem "1"/"2": são as escolhas do menu, e cada uma custaria uma consulta.
const REPLY_WORDS = new Set(["CONFIRMAR", "CONFIRMO", "SIM", "CANCELAR", "NAO"]);

export interface CustomerToolContext {
  env: Env;
  profile: string;
  run: any;
  conversation: Conversation;
  /** Bot preso à conversa (como a chave conversations:bound). */
  bound: Actor;
}

/**
 * Contexto do modo cliente, ou null. Só execução de uma conversa individual
 * de linha (telefone autenticado pelo canal), nunca conversa interna.
 */
export async function customerToolContext(
  env: Env,
  run: any,
): Promise<CustomerToolContext | null> {
  if (!run?.conversation_id) return null;
  const context = json(run.context, {});
  if (context.internal_chat_id) return null;
  const c = await one<Conversation>(
    env,
    "SELECT * FROM conversations WHERE id=? AND profile_id=?",
    run.conversation_id,
    run.profile_id,
  );
  if (
    !c ||
    c.chat_type === "group" ||
    !c.connection_id ||
    c.external_namespace !== `channel:${c.connection_id}`
  )
    return null;
  return {
    env,
    profile: run.profile_id,
    run,
    conversation: c,
    bound: {
      id: `bot:${run.bot_id}`,
      kind: "app",
      name: "Bot",
      role: "service",
      profiles: [run.profile_id],
      scopes: ["conversations:read", "conversations:write", "conversations:bound"],
      bots: [run.bot_id],
      rate: 120,
      runLimit: 3,
      // Auditoria e o cartão de aprovação sabem de qual execução veio.
      via: { kind: "bot", bot_id: run.bot_id, run_id: run.id, masked: true },
    },
  };
}

const kindOf = (tool: ModuleMcpTool) =>
  tool.customer === false
    ? null
    : tool.customer || (tool.write ? "propose" : "read");

/** Ferramentas do cliente dos módulos ligados na área. */
export async function customerTools(env: Env, profile: string) {
  const states = await moduleStates(env, profile);
  return moduleMcpTools().filter((t) => states[t.module] && kindOf(t));
}

/** Definições para o modelo: sem conversation_id, profile e idempotency_key. */
export function customerToolDefs(tools: ModuleMcpTool[]): BotTool[] {
  return tools.map((t) => {
    const properties = Object.fromEntries(
      Object.entries(t.input || {}).filter(
        ([k]) => !["conversation_id", "profile", "idempotency_key"].includes(k),
      ),
    );
    const required = (t.required || []).filter(
      (k) => !["conversation_id", "profile", "idempotency_key"].includes(k),
    );
    if (kindOf(t) === "propose")
      properties.resumo = {
        type: "string",
        description: "Frase curta, para o cliente, do que será feito ao confirmar.",
      };
    return {
      name: t.name,
      description:
        t.description +
        (kindOf(t) === "propose"
          ? " Não executa na hora: o cliente recebe um botão para confirmar; diga que ele precisa confirmar."
          : ""),
      schema: { type: "object", properties, required },
    };
  });
}

/** A chamada do módulo com a conversa da execução, conferida. */
function callFor(ctx: CustomerToolContext, tool: ModuleMcpTool, args: any) {
  const input: Record<string, any> = {};
  for (const key of Object.keys(tool.input || {}))
    if (args && Object.hasOwn(args, key)) input[key] = args[key];
  // A conversa é sempre a da execução, seja o que for que o modelo mandou.
  if ("conversation_id" in (tool.input || {}))
    input.conversation_id = ctx.conversation.id;
  delete input.profile;
  delete input.idempotency_key;
  const call = tool.call(input, ctx.profile);
  const prefix = `/profiles/${ctx.profile}/`;
  if (!call.path.startsWith(prefix) || /\.\.|[?#]/.test(call.path))
    throw new ApiError(400, "invalid_request", "Caminho da ferramenta inválido.");
  // Toda escrita do cliente é ação da própria conversa.
  if (
    (call.method || "GET") !== "GET" &&
    call.path !== `${prefix}conversations/${ctx.conversation.id}/actions`
  )
    throw new ApiError(400, "invalid_request", "Ação fora da conversa do cliente.");
  return call;
}

const err = (message: string) => JSON.stringify({ erro: message });

/** Executa uma ferramenta do modo cliente; erros viram resultado de erro. */
export async function runCustomerTool(
  ctx: CustomerToolContext,
  state: ToolState,
  name: string,
  args: any,
): Promise<string> {
  state.calls++;
  if (state.calls > MAX_TOOL_CALLS)
    return err(`Limite de ${MAX_TOOL_CALLS} consultas por resposta. Responda com o que já tem.`);
  const tool = (await customerTools(ctx.env, ctx.profile)).find((t) => t.name === name);
  if (!tool) return err("Ferramenta indisponível.");
  try {
    const call = callFor(ctx, tool, args);
    if (kindOf(tool) === "propose") {
      if (state.proposals >= MAX_PROPOSALS)
        return err(`Limite de ${MAX_PROPOSALS} pedidos por resposta.`);
      const id = await proposeToCustomer(ctx, tool, call, args?.resumo);
      state.proposals++;
      return JSON.stringify({
        proposta: id,
        estado: "aguardando_confirmacao_do_cliente",
        aviso: "O cliente recebeu um botão para confirmar. Não diga que foi feito.",
      });
    }
    // Mesma chamada na mesma execução (provedor repetido): a mesma chave.
    const key = `bot:${ctx.run.id}:${await sha(JSON.stringify([name, call]))}`;
    const response = await internalCall(ctx.env, ctx.bound, call, key.slice(0, 200));
    const body = await response.json<any>().catch(() => null);
    if (!response.ok) return err(body?.error?.message || `Falha HTTP ${response.status}.`);
    const text = JSON.stringify(sanitize(body, true));
    return text.length <= MAX_RESULT ? text : text.slice(0, MAX_RESULT) + "… [cortado]";
  } catch (error) {
    if (error instanceof ApiError) return err(error.message);
    return err("Falha ao executar a ferramenta.");
  }
}

/** Grava a proposta e manda ao cliente o botão de confirmar. */
async function proposeToCustomer(
  ctx: CustomerToolContext,
  tool: ModuleMcpTool,
  call: ReturnType<ModuleMcpTool["call"]>,
  summary: unknown,
) {
  // Execução repetida (provedor caiu no meio): a mesma proposta, sem outro botão.
  const same = await one(
    ctx.env,
    "SELECT id FROM bot_proposals WHERE run_id=? AND operation=? AND params=? AND status='pending'",
    ctx.run.id,
    tool.name,
    JSON.stringify(call.body ?? {}),
  );
  if (same) return same.id as string;
  const id = uid(),
    at = now();
  const text =
    String(summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200) ||
    tool.description.slice(0, 120);
  await exec(
    ctx.env,
    "INSERT INTO bot_proposals(id,profile_id,mode,actor,bot_id,run_id,conversation_id,operation,method,path,params,summary,sensitive,status,expires_at,created,updated) VALUES(?,?,'customer',?,?,?,?,?,?,?,?,?,0,'pending',?,?,?)",
    id,
    ctx.profile,
    `customer:${ctx.conversation.id}`,
    ctx.run.bot_id,
    ctx.run.id,
    ctx.conversation.id,
    tool.name,
    call.method || "POST",
    call.path,
    JSON.stringify(call.body ?? {}),
    text,
    at + PROPOSAL_TTL,
    at,
    at,
  );
  await sendInteractive(
    ctx.env,
    "system",
    ctx.conversation,
    {
      type: "button",
      body: `Para eu fazer isto, confirme:\n${text}\n\n(Ou responda CONFIRMAR ou CANCELAR.)`,
      buttons: [
        { id: `${CUSTOMER_REPLY}sim:${id}`, title: "Confirmar" },
        { id: `${CUSTOMER_REPLY}nao:${id}`, title: "Cancelar" },
      ],
    } as any,
    `bot-proposal:${id}`,
    "bot",
  );
  return id;
}

/**
 * Resposta do cliente a uma proposta aberta desta conversa (botão do próprio
 * canal, ou CONFIRMAR/CANCELAR digitado). true quando era a resposta.
 */
export async function handleCustomerProposalTurn(
  env: Env,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
) {
  const match = turn.replyId?.match(/^botacao:(sim|nao):(.+)$/);
  if (turn.replyId && !match) return false;
  // Mensagem comum: nenhuma consulta ao D1 (docs/LIMITES.md).
  if (!match && !REPLY_WORDS.has(normalize(turn.text))) return false;
  const row = match
    ? await one(
        env,
        "SELECT * FROM bot_proposals WHERE id=? AND conversation_id=? AND mode='customer'",
        match[2],
        c.id,
      )
    : await one(
        env,
        "SELECT * FROM bot_proposals WHERE conversation_id=? AND mode='customer' AND status='pending' ORDER BY created DESC LIMIT 1",
        c.id,
      );
  if (!row) return !!match;
  const word = normalize(turn.text);
  const yes = match ? match[1] === "sim" : ["CONFIRMAR", "CONFIRMO", "SIM"].includes(word);
  const no = match ? match[1] === "nao" : ["CANCELAR", "NAO"].includes(word);
  if (!yes && !no) return false;
  const reply = (text: string) =>
    enqueue(env, c, "system", "text", { text, automation: "bot" }, `bot-proposal-reply:${row.id}:${turn.rowId}`);
  if (row.status !== "pending" || row.expires_at <= now()) {
    if (row.status === "pending")
      await exec(env, "UPDATE bot_proposals SET status='expired',updated=? WHERE id=? AND status='pending'", now(), row.id);
    await reply("Este pedido não está mais aberto. Peça de novo, por favor.");
    return true;
  }
  if (no) {
    await exec(env, "UPDATE bot_proposals SET status='cancelled',decided_at=?,updated=? WHERE id=? AND status='pending'", now(), now(), row.id);
    await reply("Tudo bem, não fiz nada.");
    return true;
  }
  const claimed = await exec(
    env,
    "UPDATE bot_proposals SET status='running',decided_at=?,updated=? WHERE id=? AND status='pending'",
    now(),
    now(),
    row.id,
  );
  if (!claimed.meta.changes) return true;
  // O cliente confirmou na própria conversa: a ação roda como o bot, presa à
  // mesma conversa (o caminho foi conferido ao propor).
  const actor: Actor = {
    id: `bot:${row.bot_id}`,
    kind: "app",
    name: "Bot",
    role: "service",
    profiles: [row.profile_id],
    scopes: ["conversations:read", "conversations:write"],
    bots: [row.bot_id],
    rate: 120,
    runLimit: 3,
    via: { kind: "bot", bot_id: row.bot_id, run_id: row.run_id, proposal_id: row.id, masked: true },
  };
  let status = "done",
    error: string | null = null;
  try {
    const response = await internalCall(
      env,
      actor,
      { method: row.method, path: row.path, body: json(row.params, {}) },
      `proposal:${row.id}`,
    );
    if (!response.ok) {
      status = "failed";
      error = (await response.json<any>().catch(() => null))?.error?.message || `Falha HTTP ${response.status}.`;
    }
  } catch (e) {
    status = "failed";
    error = e instanceof ApiError ? e.message : "Falha ao executar.";
  }
  await exec(env, "UPDATE bot_proposals SET status=?,error=?,updated=? WHERE id=?", status, error, now(), row.id);
  if (status === "failed") await reply(`Não consegui concluir: ${error}`);
  return true;
}
