import { DurableObject } from "cloudflare:workers";
import { type Env, type Actor, type Run, ApiError, now, json } from "./types";
import { one, all, exec } from "./db";
import { sha, seal, unseal, canonical } from "./security";
import { perform, inbound } from "./service";
import { finishDelivery } from "./delivery";
import { channelEvent } from "./whatsapp";
import { callWebhook, expireCalls } from "./calls";
import { expireUploads } from "./media";
import { transport } from "./transport";
import { routerLink } from "./number-router";
import { audit } from "./events";
import { processCloudflareJob } from "./cloudflare";
import { processUpdate, updatePending, automaticUpdateTick } from "./updates";
import { processPush } from "./push";
import { HermesLinkHub } from "./hermes-link";
import { closeDay, overview as queueOverview } from "./queue";
import {
  processInbox,
  processRun,
  deliver,
  deliverWebhook,
  importDocument,
} from "./engine";
export class Coordinator extends DurableObject<Env> {
  private profile = "";
  private busy = false;
  private link = new HermesLinkHub(this.env, this.ctx);
  async fetch(request: Request) {
    // Instâncias "hermes-link:<conexão>" só atendem o vínculo do plugin: não
    // gravam perfil nem agendam alarme.
    const linkPath = new URL(request.url).pathname;
    if (linkPath.startsWith("/link-"))
      return this.link.handle(linkPath, request);
    if (linkPath === "/queue-ws") return this.acceptQueueSocket(request);
    const body = await request.json<any>();
    this.profile = body.profile;
    await this.ctx.storage.put("profile", this.profile);
    if (new URL(request.url).pathname === "/router-link")
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          return Response.json(
            await routerLink(this.env, this.profile, body.token),
          );
        } catch (error) {
          if (error instanceof ApiError)
            return Response.json(
              { error: { code: error.code, message: error.message } },
              { status: error.status },
            );
          throw error;
        }
      });
    if (new URL(request.url).pathname === "/command")
      return this.ctx.blockConcurrencyWhile(async () => {
        const actor: Actor = body.actor,
          scope = `${actor.id}:${this.profile}:${body.operation}`,
          fingerprint = await sha(canonical(body.data));
        const old = await one(
          this.env,
          "SELECT * FROM receipts WHERE scope=? AND key=?",
          scope,
          body.key,
        );
        if (old) {
          if (old.fingerprint !== fingerprint)
            return Response.json(
              {
                error: {
                  code: "idempotency_conflict",
                  message: "Esta chave já foi usada com outro conteúdo.",
                },
              },
              { status: 409 },
            );
          if (!old.response)
            return Response.json(
              {
                error: {
                  code: "operation_unknown",
                  message:
                    "A operação anterior não concluiu o recibo. Reconcilie antes de repetir.",
                },
              },
              { status: 409 },
            );
          return new Response(
            old.response.startsWith("sealed:")
              ? JSON.stringify(await unseal(this.env, old.response.slice(7)))
              : old.response,
            {
              status: old.status,
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Replayed": "true",
              },
            },
          );
        }
        await exec(
          this.env,
          "INSERT INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)",
          scope,
          body.key,
          fingerprint,
          now(),
        );
        let status = 200,
          value: any;
        try {
          value = await perform(
            this.env,
            actor,
            this.profile,
            body.operation,
            body.data,
            body.key,
          );
          await audit(
            this.env,
            actor,
            this.profile,
            body.operation,
            value?.id || body.data.id || "",
            body.requestId,
          );
          if (["run.create", "inbound", "router.send"].includes(body.operation))
            status = 202;
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          status = error.status;
          value = {
            error: {
              code: error.code,
              message: error.message,
              request_id: body.requestId,
            },
          };
        }
        await exec(
          this.env,
          "UPDATE receipts SET response=?,status=? WHERE scope=? AND key=?",
          "sealed:" + (await seal(this.env, value)),
          status,
          scope,
          body.key,
        );
        await this.schedule();
        if (/^(queue|counter)\./.test(body.operation))
          await this.broadcastQueue();
        return Response.json(value, { status });
      });
    if (new URL(request.url).pathname === "/transport")
      return this.ctx.blockConcurrencyWhile(async () =>
        Response.json(
          await transport(
            this.env,
            body.connectionId,
            body.operation,
            body.data,
          ),
        ),
      );
    if (new URL(request.url).pathname === "/channel-event") {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const conn = await one(
          this.env,
          "SELECT * FROM connections WHERE id=? AND profile_id=?",
          body.connectionId,
          this.profile,
        );
        if (!conn)
          throw new ApiError(404, "not_found", "Conexão não encontrada.");
        return body.data.event === "call"
          ? callWebhook(this.env, conn, body.data)
          : channelEvent(this.env, conn, body.data);
      });
      await this.schedule();
      return Response.json(result);
    }
    if (new URL(request.url).pathname === "/inbound") {
      const result = await this.ctx.blockConcurrencyWhile(() =>
        inbound(
          this.env,
          this.profile,
          body.data,
          body.namespace,
          body.connectionId,
        ),
      );
      await this.schedule();
      return Response.json(result, { status: 202 });
    }
    await this.schedule();
    return Response.json({ scheduled: true });
  }
  /** TV panels, Senhapp and the team's queue screen (hibernatable sockets). */
  private async acceptQueueSocket(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket esperado.", { status: 426 });
    this.profile = request.headers.get("X-Wabotia-Profile") || "";
    await this.ctx.storage.put("profile", this.profile);
    const filter = json(request.headers.get("X-Wabotia-Queues"), []);
    if ((await this.ctx.storage.get<number>("queue_cursor")) === undefined) {
      const last = await one(
        this.env,
        "SELECT max(id) id FROM events WHERE profile_id=?",
        this.profile,
      );
      await this.ctx.storage.put("queue_cursor", last?.id || 0);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["queue"]);
    server.serializeAttachment({ filter });
    server.send(
      JSON.stringify({
        type: "snapshot",
        data: await queueOverview(this.env, this.profile, filter),
      }),
    );
    // Browsers send the display token as a subprotocol; answer with ours.
    const offered = request.headers
      .get("Sec-WebSocket-Protocol")
      ?.split(",")
      .map((s) => s.trim());
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: offered?.includes("wabotia-display")
        ? { "Sec-WebSocket-Protocol": "wabotia-display" }
        : {},
    });
  }
  /** Sends new calls and a fresh snapshot to every connected panel. */
  private async broadcastQueue() {
    const sockets = this.ctx.getWebSockets("queue");
    if (!sockets.length || !this.profile) return;
    const cursor = (await this.ctx.storage.get<number>("queue_cursor")) || 0;
    const rows = await all(
      this.env,
      "SELECT id,kind,payload FROM events WHERE profile_id=? AND id>? AND kind LIKE 'queue.%' ORDER BY id LIMIT 200",
      this.profile,
      cursor,
    );
    if (!rows.length) return;
    await this.ctx.storage.put("queue_cursor", rows.at(-1)!.id);
    const calls = rows
      .filter((r) => ["queue.called", "queue.recalled"].includes(r.kind))
      .map((r) => json(r.payload));
    const snapshots = new Map<string, string>();
    for (const ws of sockets) {
      const filter: string[] = ws.deserializeAttachment()?.filter || [];
      const key = JSON.stringify(filter);
      try {
        for (const call of calls)
          if (!filter.length || filter.includes(call.queue_id)) {
            const { n, ...frame } = call;
            ws.send(JSON.stringify({ type: "call", data: frame }));
          }
        if (!snapshots.has(key))
          snapshots.set(
            key,
            JSON.stringify({
              type: "snapshot",
              data: await queueOverview(this.env, this.profile, filter),
            }),
          );
        ws.send(snapshots.get(key)!);
      } catch {
        // A closed socket is dropped by the runtime.
      }
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string" && json(message, {}).type === "ping")
      ws.send(JSON.stringify({ type: "pong" }));
  }
  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      // Already closed.
    }
  }
  private async schedule() {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > now() + 1000)
      await this.ctx.storage.setAlarm(now() + 1000);
  }
  async alarm() {
    if (this.busy) return;
    this.busy = true;
    this.profile ||= (await this.ctx.storage.get<string>("profile")) || "";
    try {
      if (this.profile === "_admin") {
        await automaticUpdateTick(this.env);
        await processUpdate(this.env);
        await processCloudflareJob(this.env);
        return;
      }
      await exec(
        this.env,
        "UPDATE outbox SET status='unknown',error='Processo interrompido durante envio; reconcilie antes de repetir.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await exec(
        this.env,
        "UPDATE inbox SET status='pending' WHERE profile_id=? AND status='processing'",
        this.profile,
      );
      for (const row of await all(
        this.env,
        "SELECT * FROM outbox WHERE profile_id=? AND status='sent' AND completion_handled=0 LIMIT 20",
        this.profile,
      ))
        await finishDelivery(this.env, row, row.external_id || row.id);
      await exec(
        this.env,
        "UPDATE group_operations SET status='unknown',error='Conector interrompido; confira o grupo antes de reconciliar.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await expireCalls(this.env, this.profile);
      await expireUploads(this.env, this.profile);
      await closeDay(this.env, this.profile);
      await processInbox(this.env, this.profile);
      await this.broadcastQueue();
      for (const run of await all<Run>(
        this.env,
        "SELECT * FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)) ORDER BY created LIMIT 5",
        this.profile,
      ))
        await processRun(this.env, run);
      for (const row of await all(
        this.env,
        "SELECT * FROM outbox o WHERE profile_id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.conversation_id=o.conversation_id AND (p.kind='team')=(o.kind='team') AND (p.created<o.created OR (p.created=o.created AND p.rowid<o.rowid)) AND p.status IN ('pending','sending','unknown')) ORDER BY created,rowid LIMIT 10",
        this.profile,
      ))
        await deliver(this.env, row);
      for (const row of await all(
        this.env,
        "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending' AND d.next_at<=? LIMIT 10",
        this.profile,
        now(),
      ))
        await deliverWebhook(this.env, row);
      const doc = await one(
        this.env,
        "SELECT * FROM documents WHERE profile_id=? AND status='pending' LIMIT 1",
        this.profile,
      );
      if (doc) await importDocument(this.env, doc);
      await processPush(this.env, this.profile);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "coordinator",
          profile: this.profile,
          error: error instanceof ApiError ? error.code : "processing_error",
        }),
      );
    } finally {
      this.busy = false;
      const pending =
        this.profile === "_admin"
          ? await one(
              this.env,
              "SELECT count(*) n FROM cloudflare_jobs WHERE status IN ('pending','running')",
            )
          : await one(
              this.env,
              "SELECT (SELECT count(*) FROM inbox WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)))+(SELECT count(*) FROM outbox WHERE profile_id=? AND status IN ('pending','sending'))+(SELECT count(*) FROM documents WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending')+(SELECT count(*) FROM group_operations WHERE profile_id=? AND status IN ('pending','sending'))+(SELECT count(*) FROM events WHERE profile_id=? AND id>coalesce((SELECT last_event_id FROM push_cursors WHERE profile_id=?),0)) n",
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
            );
      if (
        pending?.n ||
        (this.profile !== "_admin" &&
          (await one(
            this.env,
            "SELECT id FROM calls WHERE profile_id=? AND status IN ('active','preaccepted','dialing','connecting','ringing') LIMIT 1",
            this.profile,
          ))) ||
        (this.profile === "_admin" && (await updatePending(this.env)))
      )
        await this.ctx.storage.setAlarm(now() + 5000);
    }
  }
}
