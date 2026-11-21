// Bot da conversa interna agindo em nome da pessoa que pediu (docs/API.md
// "Ações pelo bot", docs/MODULOS.md "Ações pelo bot"). Regras:
// - só numa execução de conversa interna pedida por uma pessoa ativa, nunca
//   no atendimento ao cliente (decidido aqui, em código, não no prompt);
// - cada chamada roda como a pessoa (relida do banco), com o acesso dela e
//   `via` só para auditoria;
// - leitura direta; escrita vira proposta que só a pessoa confirma, pela
//   sessão dela, dentro do prazo; operação sensível exige segundo fator;
// - dado pessoal mascarado no que vai ao modelo, salvo regra da instalação.
import { all, exec, one } from "../db";
import { actorForUser, canProfile } from "../security";
import { allows } from "../access";
import { event } from "../events";
import { internalCall } from "../internal-api";
import { BOT_HIDDEN } from "../modules/api";
import {
  ApiError,
  type Actor,
  type BotVia,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "../types";
import {
  catalogFor,
  operationViews,
  searchCatalog,
  type CatalogOperation,
} from "./catalog";
import { requireFinancialAal } from "../mfa";
import { moduleById } from "../modules/registry";
import { describeFields, describeWith } from "./describe";
import { ERP_BOT_OPERATIONS, erpBotOperationGranted } from "../modules/erp/bot-access";
import { areaBotGrants, areaGrantsFor, areaOperation, areaOperationByRoute, logAreaUse, personFor, stripSensitive } from "./area";

/** Teto de chamadas de ferramenta por turno do bot. */
export const MAX_TOOL_CALLS = 6;
/** Teto de propostas por turno. */
export const MAX_PROPOSALS = 3;
/** Tamanho máximo de um resultado devolvido ao modelo (caracteres). */
export const MAX_RESULT = 6000;
/** Validade de uma proposta. */
export const PROPOSAL_TTL = 10 * 60000;

/** Regra da instalação: dado pessoal completo nas consultas do bot. */
export const FULL_PERSONAL_DATA_KEY = "bot_full_personal_data";

export async function fullPersonalData(env: Env) {
  const row = await one(
    env,
    "SELECT value FROM instance_settings WHERE key=?",
    FULL_PERSONAL_DATA_KEY,
  );
  return row?.value === "1";
}

export async function setFullPersonalData(env: Env, enabled: boolean) {
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    FULL_PERSONAL_DATA_KEY,
    enabled ? "1" : "0",
    now(),
  );
}

export interface BotActionContext {
  env: Env;
  profile: string;
  run: any;
  chatId: string;
  /** A pessoa, com `via` preenchido. */
  actor: Actor;
}

/**
 * Contexto para a execução do bot agir pela pessoa, ou null. Null sempre que
 * não é conversa interna de uma pessoa com este bot: atendimento ao cliente
 * (conversa, bot:attendant), execução pedida por integração, pessoa
 * desabilitada, fora da área ou sem acesso à conversa interna.
 */
export async function botActionContext(
  env: Env,
  run: any,
): Promise<BotActionContext | null> {
  if (!run || run.conversation_id) return null;
  const context = json(run.context, {});
  const chatId = context.internal_chat_id;
  if (typeof chatId !== "string" || !chatId) return null;
  const personId = String(run.actor || "");
  if (!personId || personId.startsWith("bot:") || personId.startsWith("app:"))
    return null;
  const person = await actorForUser(env, personId);
  if (!person || person.kind !== "user") return null;
  if (!canProfile(person, run.profile_id) || !allows(person, "team"))
    return null;
  const chat = await one(
    env,
    "SELECT * FROM internal_chats WHERE id=? AND profile_id=?",
    chatId,
    run.profile_id,
  );
  const members = chat ? [chat.member_a, chat.member_b] : [];
  if (!members.includes(person.id) || !members.includes(`bot:${run.bot_id}`))
    return null;
  const via: BotVia = {
    kind: "bot",
    bot_id: run.bot_id,
    run_id: run.id,
    masked: !(await fullPersonalData(env)),
  };
  return {
    env,
    profile: run.profile_id,
    run,
    chatId,
    actor: { ...person, via },
  };
}

// ---------------------------------------------------------------------------
// Ferramentas (formato neutro; src/bot-tools.ts traduz para cada provedor)

export interface BotTool {
  name: string;
  description: string;
  schema: Record<string, any>;
}

export const BOT_TOOLS: BotTool[] = [
  {
    name: "buscar_operacoes",
    description:
      "Procura, entre as operações do Wabotia que a pessoa pode usar agora, as que servem ao pedido. Devolve até 10, com o nome da operação, se é consulta ou ação, o resumo e os parâmetros. Use antes de consultar ou propor.",
    schema: {
      type: "object",
      properties: {
        texto: {
          type: "string",
          description:
            "O que a pessoa quer, em poucas palavras (ex.: 'ordens de serviço abertas', 'baixar parcela').",
        },
        tipo: { type: "string", enum: ["consulta", "acao"] },
      },
      required: ["texto"],
    },
  },
  {
    name: "consultar",
    description:
      "Executa uma operação de consulta (tipo consulta) como a pessoa e devolve o resultado. Não muda nada. Dados pessoais podem vir mascarados.",
    schema: {
      type: "object",
      properties: {
        operacao: {
          type: "string",
          description: "Nome exato devolvido por buscar_operacoes.",
        },
        parametros: { type: "object", description: "Parâmetros da operação." },
      },
      required: ["operacao"],
    },
  },
  {
    name: "propor_acao",
    description:
      "Prepara uma operação de ação (tipo acao), ou uma consulta marcada exige_proposta, para a PESSOA confirmar com um toque. Não executa nada: a pessoa vê a proposta com Confirmar e Cancelar. Você nunca confirma; diga à pessoa que confirme.",
    schema: {
      type: "object",
      properties: {
        operacao: {
          type: "string",
          description: "Nome exato devolvido por buscar_operacoes.",
        },
        parametros: { type: "object", description: "Parâmetros da operação." },
        resumo: {
          type: "string",
          description:
            "Frase curta, em português, do que será feito (ex.: 'Mudar a OS nº 12 para Pronta').",
        },
      },
      required: ["operacao", "resumo"],
    },
  },
];

export interface ToolState {
  calls: number;
  proposals: number;
}
export const newToolState = (): ToolState => ({ calls: 0, proposals: 0 });

const SECRET_KEYS =
  /^(token|secret|password|api_key|apikey|access_token|refresh_token|authorization|code_hash|key_hash|webhook_secret)$/i;
const SECRET_VALUES = /\b(wab[ul]?_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g;

/** Tira segredos sempre e dados pessoais quando mascarado. */
export function sanitize(value: any, masked: boolean, depth = 0): any {
  if (depth > 12) return null;
  if (typeof value === "string")
    return value.replace(SECRET_VALUES, "[oculto]");
  if (Array.isArray(value))
    return value.map((v) => sanitize(v, masked, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue;
    if (masked && BOT_HIDDEN.has(key)) continue;
    out[key] = sanitize(item, masked, depth + 1);
  }
  return out;
}

function clip(value: any) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= MAX_RESULT
    ? text
    : text.slice(0, MAX_RESULT) +
        `… [cortado: ${text.length} caracteres; peça menos itens ou filtre]`;
}

const toolError = (message: string) => JSON.stringify({ erro: message });

/** Monta a chamada HTTP de uma operação a partir dos parâmetros do modelo. */
export function buildCall(
  profile: string,
  op: Pick<CatalogOperation, "path" | "kind" | "method">,
  params: Record<string, any>,
) {
  const rest: Record<string, any> = { ...params };
  const missing: string[] = [];
  const path = op.path.replace(/:(\w+)/g, (_, name) => {
    const value = rest[name];
    delete rest[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      return "_";
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length)
    throw new ApiError(
      400,
      "invalid_request",
      `Informe ${missing.join(", ")}.`,
    );
  const full = `/profiles/${encodeURIComponent(profile)}/${path}`;
  return op.kind === "read"
    ? { method: "GET" as const, path: full, query: rest }
    : { method: op.method, path: full, body: rest };
}

async function findOperation(ctx: BotActionContext, name: unknown) {
  const ops = await catalogFor(ctx.env, ctx.actor, ctx.profile);
  return ops.find((op) => op.name === name) || null;
}

/**
 * Consulta ou escrita direta de módulo de área (src/bot-actions/area.ts): a
 * concessão é relida agora; a chamada roda como a pessoa (o guarda do módulo
 * confere os papéis dela) e o resultado volta sem os campos sensíveis, salvo
 * a opção do bot para o módulo. Cada uso fica no registro.
 */
async function runAreaOperation(
  ctx: BotActionContext,
  op: CatalogOperation,
  params: Record<string, any>,
) {
  const found = areaOperation(op.name);
  const grants = await areaGrantsFor(ctx.env, ctx.actor, ctx.profile);
  const direct = op.kind === "write";
  if (!found || !grants.operations.has(op.name) || (direct && !grants.direct.has(op.name)))
    throw new ApiError(403, "area_bot_grant_required", "Esta operação não está liberada para este bot. Peça ao administrador na página do bot.");
  requireValue(params && typeof params === "object" && !Array.isArray(params), "Parâmetros inválidos.");
  const call = buildCall(ctx.profile, op, params);
  await logAreaUse(ctx.env, ctx.profile, ctx.run.bot_id, ctx.actor.id, found.module.module, op.name, direct ? "execução direta" : "consulta");
  const response = await internalCall(
    ctx.env,
    personFor(ctx.actor),
    call,
    direct ? `area:${ctx.run.id}:${op.name}:${await digest(JSON.stringify(params))}` : undefined,
  );
  const body = await response.json<any>().catch(() => null);
  if (!response.ok)
    return toolError(body?.error?.message || `Falha HTTP ${response.status}.`);
  const visible = stripSensitive(found.module, found.op, body, grants.sensitive.has(found.module.module));
  return clip(sanitize(visible, !!ctx.actor.via?.masked));
}

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Executa uma ferramenta pedida pelo modelo e devolve o texto do resultado.
 * Erros viram resultado de erro (o modelo explica à pessoa); nada lança.
 */
export async function runBotTool(
  ctx: BotActionContext,
  state: ToolState,
  name: string,
  args: any,
): Promise<string> {
  state.calls++;
  if (state.calls > MAX_TOOL_CALLS)
    return toolError(
      `Limite de ${MAX_TOOL_CALLS} chamadas por resposta atingido. Responda com o que já tem.`,
    );
  const input = args && typeof args === "object" ? args : {};
  try {
    if (name === "buscar_operacoes") {
      const ops = await catalogFor(ctx.env, ctx.actor, ctx.profile);
      const kind =
        input.tipo === "consulta"
          ? "read"
          : input.tipo === "acao"
            ? "write"
            : undefined;
      const found = searchCatalog(ops, String(input.texto || ""), { kind });
      return clip({
        // Folga para o aviso e a chave operacoes dentro de MAX_RESULT.
        operacoes: operationViews(found, MAX_RESULT - 200),
        ...(found.length
          ? {}
          : {
              aviso:
                "Nada encontrado para essa busca entre o que a pessoa pode usar.",
            }),
      });
    }
    if (name === "consultar") {
      const op = await findOperation(ctx, input.operacao);
      if (!op || op.kind !== "read")
        return toolError(
          "Consulta desconhecida ou fora do acesso da pessoa. Use buscar_operacoes.",
        );
      if (op.area) return await runAreaOperation(ctx, op, input.parametros || {});
      const response = await internalCall(
        ctx.env,
        ctx.actor,
        buildCall(ctx.profile, op, input.parametros || {}),
      );
      const body = await response.json<any>().catch(() => null);
      if (!response.ok)
        return toolError(
          body?.error?.message || `Falha HTTP ${response.status}.`,
        );
      return clip(sanitize(body, !!ctx.actor.via?.masked));
    }
    if (name === "propor_acao") {
      if (state.proposals >= MAX_PROPOSALS)
        return toolError(`Limite de ${MAX_PROPOSALS} propostas por resposta.`);
      const op = await findOperation(ctx, input.operacao);
      // Leitura sensível também se propõe: a pessoa confirma e recebe o resultado.
      if (!op || (op.kind !== "write" && !op.sensitive))
        return toolError(
          "Ação desconhecida ou fora do acesso da pessoa. Use buscar_operacoes.",
        );
      // Escrita de módulo de área com execução direta liberada pelo administrador.
      if (op.area && op.direct) {
        state.proposals++;
        return await runAreaOperation(ctx, op, input.parametros || {});
      }
      const proposal = await createProposal(
        ctx,
        op,
        input.parametros || {},
        input.resumo,
      );
      state.proposals++;
      return JSON.stringify({
        proposta: proposal.id,
        estado: "aguardando_confirmacao",
        expira_em_minutos: PROPOSAL_TTL / 60000,
        aviso:
          "A pessoa precisa tocar em Confirmar na conversa. Você não confirma e não deve dizer que foi feito.",
      });
    }
    return toolError(`Ferramenta desconhecida: ${name}.`);
  } catch (error) {
    if (error instanceof ApiError) return toolError(error.message);
    console.error(
      JSON.stringify({
        component: "bot-actions",
        run: ctx.run.id,
        tool: name,
        error: String((error as Error)?.message || error).slice(0, 300),
      }),
    );
    return toolError("Falha ao executar a ferramenta.");
  }
}

// ---------------------------------------------------------------------------
// Propostas

const MAX_SUMMARY = 300;

export function proposalView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    operation: row.operation,
    // Montado no servidor: o que roda ao confirmar (src/bot-actions/describe.ts).
    description: row.description ?? null,
    // Escrito pelo modelo: só contexto, não conferido.
    summary: row.summary,
    params: json(row.params, {}),
    sensitive: !!row.sensitive,
    expires_at: row.expires_at,
    decided_at: row.decided_at,
    result: row.result ? json(row.result, null) : null,
    error: row.error,
    bot_id: row.bot_id,
    chat_id: row.chat_id,
    created: row.created,
  };
}

async function postMessage(
  env: Env,
  profile: string,
  chatId: string,
  author: string,
  kind: "proposal" | "result",
  text: string,
  payload: any,
  id: string,
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,kind,payload,status,source_key,created) VALUES(?,?,?,?,?,?,'sent',?,?)",
    ).bind(
      id,
      chatId,
      author,
      text.slice(0, 60000),
      kind,
      JSON.stringify(payload),
      id,
      now(),
    ),
    env.DB.prepare("UPDATE internal_chats SET updated=? WHERE id=?").bind(
      now(),
      chatId,
    ),
  ]);
  await event(
    env,
    profile,
    "internal.message",
    id,
    { chat_id: chatId },
    `internal:${id}`,
  );
}

export async function createProposal(
  ctx: BotActionContext,
  op: CatalogOperation,
  params: Record<string, any>,
  summary: unknown,
) {
  if (op.path.startsWith("erp/") || op.path.startsWith("erp-comercial-nfe/")) {
    const contract = ERP_BOT_OPERATIONS.find(entry => entry.method === op.method && entry.path === op.path);
    if (!contract || !await erpBotOperationGranted(ctx.env, ctx.actor, ctx.profile, contract.id))
      throw new ApiError(403, "erp_bot_grant_required", "Esta operação do ERP não foi liberada para este bot na área.");
  }
  if (op.area && !(await areaGrantsFor(ctx.env, ctx.actor, ctx.profile)).operations.has(op.name))
    throw new ApiError(403, "area_bot_grant_required", "Esta operação não está liberada para este bot. Peça ao administrador na página do bot.");
  requireValue(
    params && typeof params === "object" && !Array.isArray(params),
    "Parâmetros inválidos.",
  );
  const text = String(summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY);
  requireValue(
    text.length >= 3,
    "Escreva o resumo da ação para a pessoa confirmar.",
  );
  // Confere o caminho agora (parâmetros do caminho presentes).
  buildCall(ctx.profile, op, params);
  const serialized = JSON.stringify(params);
  requireValue(serialized.length <= 20000, "Parâmetros grandes demais.");
  // Execução repetida (provedor caiu no meio): a mesma proposta, sem outra.
  const same = await one(
    ctx.env,
    "SELECT * FROM bot_proposals WHERE run_id=? AND operation=? AND params=? AND status='pending'",
    ctx.run.id,
    op.name,
    serialized,
  );
  if (same) return same;
  // O que a pessoa confirma: texto do módulo ou a lista dos parâmetros, nunca
  // o resumo do modelo (que vai à parte, marcado como não conferido).
  const describe = moduleById(op.module)?.bot?.describe?.[op.name];
  const description = await describeWith(
    describe ? () => describe(ctx.env, ctx.profile, params) : null,
    () => describeFields(op.summary, params),
  );
  const id = uid(),
    at = now(),
    messageId = `proposal:${id}`;
  await exec(
    ctx.env,
    "INSERT INTO bot_proposals(id,profile_id,actor,bot_id,run_id,chat_id,message_id,operation,method,path,params,summary,description,sensitive,status,expires_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
    id,
    ctx.profile,
    ctx.actor.id,
    ctx.run.bot_id,
    ctx.run.id,
    ctx.chatId,
    messageId,
    op.name,
    op.method,
    op.path,
    serialized,
    text,
    description,
    op.sensitive ? 1 : 0,
    at + PROPOSAL_TTL,
    at,
    at,
  );
  const row = await one(ctx.env, "SELECT * FROM bot_proposals WHERE id=?", id);
  await postMessage(
    ctx.env,
    ctx.profile,
    ctx.chatId,
    `bot:${ctx.run.bot_id}`,
    "proposal",
    `Proposta do bot:\n${description}\nTexto do bot (não conferido): ${text}\nConfirme no painel ou no app atualizado (vale ${PROPOSAL_TTL / 60000} minutos).`,
    {
      proposal: proposalView(row),
      operation_summary: op.summary,
      module: op.module,
      actions: ["confirm", "cancel"],
    },
    messageId,
  );
  return row;
}

async function loadProposal(
  env: Env,
  actor: Actor,
  profile: string,
  chatId: string,
  id: string,
) {
  const row = await one(
    env,
    "SELECT * FROM bot_proposals WHERE id=? AND profile_id=? AND chat_id=? AND actor=?",
    id,
    profile,
    chatId,
    actor.id,
  );
  if (!row) throw new ApiError(404, "not_found", "Proposta não encontrada.");
  return row;
}

/** Só a própria pessoa, com sessão dela (nunca chave de aplicação nem o bot). */
function requirePerson(actor: Actor) {
  if (actor.kind !== "user" || actor.via || actor.id.startsWith("bot:"))
    throw new ApiError(
      403,
      "person_required",
      "Só a pessoa que pediu confirma, pela sessão dela.",
    );
}

async function expireIfDue(env: Env, row: any) {
  if (row.status === "pending" && row.expires_at <= now()) {
    await exec(
      env,
      "UPDATE bot_proposals SET status='expired',updated=? WHERE id=? AND status='pending'",
      now(),
      row.id,
    );
    return { ...row, status: "expired" };
  }
  return row;
}

/**
 * Confirma: roda a operação como a pessoa (via bot, com a proposta), com
 * Idempotency-Key "proposal:<id>". Repetir devolve o mesmo resultado.
 */
export async function confirmProposal(
  env: Env,
  actor: Actor,
  profile: string,
  chatId: string,
  id: string,
) {
  requirePerson(actor);
  let row = await expireIfDue(
    env,
    await loadProposal(env, actor, profile, chatId, id),
  );
  if (row.status === "expired")
    throw new ApiError(
      409,
      "proposal_expired",
      "A proposta venceu. Peça de novo ao bot.",
    );
  if (row.status === "cancelled")
    throw new ApiError(409, "proposal_cancelled", "A proposta foi cancelada.");
  if (row.status !== "pending") return proposalView(row);
  // Operação sensível (billing:write ou marcada pelo módulo): segundo fator
  // conforme a política da instalação (src/mfa.ts). As operações financeiras
  // dos módulos pedem de novo no próprio guarda, com o ator abaixo.
  if (row.sensitive) requireFinancialAal(actor);
  // Módulo de área: a concessão do administrador é relida agora; desligada
  // depois da proposta, não roda.
  const area = areaOperationByRoute(row.method, row.path);
  if (area && !(await areaBotGrants(env, profile, row.bot_id)).operations.has(area.op.id))
    throw new ApiError(403, "area_bot_grant_required", "O administrador desligou esta operação para o bot depois da proposta. Peça a ele na página do bot ou faça pela tela.");
  const claimedAt = now();
  const claimed = await exec(
    env,
    "UPDATE bot_proposals SET status='running',decided_at=?,updated=? WHERE id=? AND status='pending' AND expires_at>?",
    claimedAt,
    now(),
    id,
    now(),
  );
  if (!claimed.meta.changes)
    return proposalView(await loadProposal(env, actor, profile, chatId, id));
  const person = await actorForUser(env, actor.id);
  if (!person) throw new ApiError(403, "forbidden", "Pessoa desabilitada.");
  const via: BotVia = {
    kind: "bot",
    bot_id: row.bot_id,
    run_id: row.run_id,
    proposal_id: row.id,
    masked: false,
  };
  let status = "done",
    result: any = null,
    error: string | null = null;
  if (area) await logAreaUse(env, profile, row.bot_id, actor.id, area.module.module, area.op.id, "proposta confirmada pela pessoa");
  try {
    const response = await internalCall(
      env,
      // Nível, sessão e política de quem confirmou: os guardas do núcleo e
      // dos módulos (requireFinancialAal) valem como numa chamada da tela.
      // Módulo de área: a pessoa confirmou e a concessão foi conferida; o
      // guarda do módulo recusa toda chamada por bot e confere os papéis dela.
      {
        ...person,
        aal: actor.aal ?? 1,
        sessionId: actor.sessionId,
        mfa: actor.mfa ?? person.mfa,
        ...(area ? {} : { via }),
      } as Actor,
      // GET continua GET (leitura sensível proposta): parâmetros na consulta.
      buildCall(
        profile,
        { path: row.path, kind: row.method === "GET" ? "read" : "write", method: row.method },
        json(row.params, {}),
      ),
      // Uma chave por tentativa: um 403 mfa_required não roda nada e devolve
      // a proposta a aberta; a próxima confirmação (já com o código) não pode
      // receber a resposta guardada da anterior.
      `proposal:${row.id}:${claimedAt}`,
    );
    const body = await response.json<any>().catch(() => null);
    // O guarda do módulo pediu o código (requireFinancialAal): a proposta
    // volta a aberta e a pessoa confirma de novo depois do código.
    if (response.status === 403 && body?.error?.code === "mfa_required") {
      await exec(
        env,
        "UPDATE bot_proposals SET status='pending',decided_at=NULL,updated=? WHERE id=? AND status='running'",
        now(),
        id,
      );
      throw new ApiError(403, "mfa_required", body.error.message);
    }
    if (!response.ok) {
      status = "failed";
      error = body?.error?.message || `Falha HTTP ${response.status}.`;
    } else result = body;
  } catch (e) {
    if (e instanceof ApiError && e.code === "mfa_required") throw e;
    status = "failed";
    error = e instanceof ApiError ? e.message : "Falha ao executar.";
  }
  const stored =
    result === null
      ? null
      : JSON.stringify(sanitize(result, false)).slice(0, 20000);
  await exec(
    env,
    "UPDATE bot_proposals SET status=?,result=?,error=?,updated=? WHERE id=?",
    status,
    stored,
    error,
    now(),
    id,
  );
  row = await loadProposal(env, actor, profile, chatId, id);
  await postMessage(
    env,
    profile,
    chatId,
    `bot:${row.bot_id}`,
    "result",
    status === "done"
      ? `Feito:\n${row.description || row.summary}`
      : `Não foi possível:\n${row.description || row.summary}\n${error}`,
    { proposal: proposalView(row) },
    `proposal-result:${row.id}`,
  );
  return proposalView(row);
}

export async function cancelProposal(
  env: Env,
  actor: Actor,
  profile: string,
  chatId: string,
  id: string,
) {
  requirePerson(actor);
  const row = await expireIfDue(
    env,
    await loadProposal(env, actor, profile, chatId, id),
  );
  if (row.status === "pending") {
    await exec(
      env,
      "UPDATE bot_proposals SET status='cancelled',decided_at=?,updated=? WHERE id=? AND status='pending'",
      now(),
      now(),
      id,
    );
    const fresh = await loadProposal(env, actor, profile, chatId, id);
    await postMessage(
      env,
      profile,
      chatId,
      `bot:${fresh.bot_id}`,
      "result",
      `Cancelado:\n${fresh.description || fresh.summary}`,
      { proposal: proposalView(fresh) },
      `proposal-result:${fresh.id}`,
    );
    return proposalView(fresh);
  }
  if (row.status === "cancelled" || row.status === "expired")
    return proposalView(row);
  throw new ApiError(409, "proposal_closed", "A proposta já foi confirmada.");
}

/** Propostas pendentes vencidas (rodada periódica do núcleo, se houver). */
export async function expireProposals(env: Env, profile: string) {
  await exec(
    env,
    "UPDATE bot_proposals SET status='expired',updated=? WHERE profile_id=? AND status='pending' AND expires_at<=?",
    now(),
    profile,
    now(),
  );
}

/** Propostas de uma execução (para o resumo do bot e os testes). */
export const proposalsOfRun = (env: Env, runId: string) =>
  all(
    env,
    "SELECT * FROM bot_proposals WHERE run_id=? ORDER BY created",
    runId,
  );
