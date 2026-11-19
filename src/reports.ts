import { all } from "./db";
import { access } from "./security";
import { type Actor, type Env, requireValue, ApiError } from "./types";
import { isChannelId } from "./channels";
import { channelExtension } from "./channel-extension-registry";
export async function report(
  env: Env,
  actor: Actor,
  profile: string,
  query: URLSearchParams,
) {
  access(actor, profile, "reports:read");
  if (query.get("section") === "google.reviews") {
    const extension = channelExtension("googlebusiness/review");
    if (!extension.report) throw new ApiError(503, "channel_not_ready", "O relatório de avaliações ainda não está disponível.");
    return extension.report({ env, actor, profileId: profile, query });
  }
  const tables: Record<string, string> = {
    conversations: "conversations",
    tickets: "tickets",
    messages: "messages",
    deliveries: "outbox",
    surveys: "surveys",
    consents: "consents",
    runs: "bot_runs",
    knowledge: "documents",
  };
  const section = query.get("section") || "tickets",
    table = tables[section];
  requireValue(table, "Seção inválida.");
  const channel = query.get("channel");
  if (channel !== null && !isChannelId(channel))
    throw new ApiError(400, "invalid_channel", "Canal inválido.");
  const conversational = section !== "knowledge";
  const conversation = section === "conversations" ? "r" : "c";
  // Mesma regra das leituras do painel: somente origem reconhecida pode
  // preencher o canal legado; aplicações e conexões de IA permanecem nulas.
  const channelSql = conversational ? `CASE
    WHEN ${conversation}.external_namespace LIKE 'app:%' OR ${conversation}.chat_type IN ('team','internal') OR n.kind='ai' THEN NULL
    WHEN ${conversation}.channel IS NOT NULL THEN ${conversation}.channel
    WHEN ${conversation}.external_namespace='channel:'||n.id AND n.kind IN ('zernio','qr','meta') THEN n.channel
    ELSE NULL END` : "NULL";
  const joins = conversational
    ? `${section === "conversations" ? "" : " LEFT JOIN conversations c ON c.id=r.conversation_id AND c.profile_id=r.profile_id"}
       LEFT JOIN connections n ON n.id=${conversation}.connection_id AND n.profile_id=${conversation}.profile_id`
    : "";
  const start = Date.parse(
      (query.get("start") || "1970-01-01") + "T00:00:00-03:00",
    ),
    end = Date.parse(
      (query.get("end") || "2999-01-01") + "T23:59:59.999-03:00",
    );
  requireValue(
    Number.isFinite(start) && Number.isFinite(end) && start <= end,
    "Período inválido.",
  );
  let filter = "",
    params: any[] = [profile, start, end];
  if (section === "runs") {
    filter +=
      " AND (json_extract(r.context,'$.internal_chat_id') IS NULL OR r.actor=?)";
    params.push(actor.id);
  }
  if (actor.kind === "app") {
    if (section === "runs") {
      access(actor, profile, "bots:invoke");
      filter += " AND r.actor=?";
      params.push(actor.id);
    }
    if (section === "messages" && !actor.scopes.includes("notes:read"))
      filter += " AND r.direction!='note'";
    if (section === "conversations") {
      filter +=
        " AND (r.external_namespace NOT LIKE 'app:%' OR r.external_namespace=?)";
      params.push("app:" + actor.id);
    } else if (
      ["tickets", "messages", "deliveries", "surveys", "consents"].includes(
        section,
      )
    ) {
      filter +=
        " AND r.conversation_id IN (SELECT id FROM conversations WHERE profile_id=r.profile_id AND (external_namespace NOT LIKE 'app:%' OR external_namespace=?))";
      params.push("app:" + actor.id);
    }
  }
  if (channel !== null) {
    filter += ` AND (${channelSql})=?`;
    params.push(channel);
  }
  async function page(cursor: string, limit: number) {
    const rows = await all(
      env,
      `SELECT r.*,${channelSql} AS resolved_channel FROM ${table} r ${joins} WHERE r.profile_id=? AND r.created BETWEEN ? AND ? ${filter} AND r.id>? ORDER BY r.id LIMIT ?`,
      ...params,
      cursor,
      limit,
    );
    return rows.map((r) => {
      r.channel = r.resolved_channel;
      delete r.resolved_channel;
      delete r.input;
      delete r.context;
      delete r.request_body;
      delete r.payload;
      delete r.source_key;
      return r;
    });
  }
  if (query.get("format") === "jsonl") {
    let cursor = "",
      finished = false;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (finished) {
            controller.close();
            return;
          }
          try {
            const rows = await page(cursor, 100);
            if (rows.length) {
              cursor = rows.at(-1).id;
              controller.enqueue(
                encoder.encode(
                  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
                ),
              );
            }
            if (rows.length < 100) finished = true;
          } catch (e) {
            controller.error(e);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Disposition": `attachment; filename="wabotia-${section}.jsonl"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 100)),
    rows = await page(query.get("cursor") || "", limit + 1);
  const more = rows.length > limit;
  rows.splice(limit);
  return Response.json({
    section,
    data: rows,
    count: rows.length,
    next_cursor: more ? rows.at(-1).id : null,
  });
}
