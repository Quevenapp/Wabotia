import { DurableObject } from "cloudflare:workers";
import { type Env, type Actor, type Run, ApiError, now, json } from "./types";
import {
  one,
  all,
  exec,
  batch,
  MODULE_STATES_SQL,
  PROFILE_SETTINGS_SQL,
  PUBLIC_ORIGIN_SQL,
  seedRead,
  seedPrefetch,
  WEBHOOK_SUBS_SQL,
  withReadCache,
  type Read,
} from "./db";
import { serverTiming, timedEnv } from "./d1-timing";
import { sha, seal, unseal, canonical, access, storedAccess, legacyKeyScopes } from "./security";
import { allows, requireAccess, requireOperationAccess } from "./access";
import { contactRow, customerAccess, human, namespaceFor, validateCustomerSelfActor } from "./customer/local";
import { requireCustomerModule } from "./customer/http";
import { visibleConversation } from "./visibility";
import { REVOKED_CLOSE } from "./sockets";
import { perform, inbound, receiveExtensionIngress, authorizeChannelDeliveryReconciliation } from "./service";
import { channelMaintenance, registeredChannelMaintenance } from "./channel-extension-registry";
import { authorizeChannelActionReplay, authorizeChannelConnectionReplay, authorizeExtensionReplay, performExtensionRoute, verifyIngressTicket } from "./channel-extension-kernel";
import { customerMaintenanceEnv, maintainCustomers, profilePort, erpBridge } from "./customer/ports";
import { finishDelivery } from "./delivery";
import { channelEvent } from "./whatsapp";
import { callWebhook, expireCalls } from "./calls";
import { expireUploads } from "./media";
import { transport } from "./transport";
import { routerLink } from "./number-router";
import { auditStatement } from "./events";
import { processUpdate, updatePending, automaticUpdateTick } from "./updates";
import { processPush } from "./push";
import { ErpHub } from "./erp/hub";
import {
  closeDay,
  overview as queueOverview,
  overviewData,
  overviewOf,
  queuePrefetch,
  queueReplay,
  QUEUE_CLOSING_OPS,
} from "./queue";
import { withCommandClosing } from "./command-context";
import { completeWebStep, expireWebSteps } from "./web-steps";
import { authorizeChannelReplay, installChannelRuntime, isChannelOperation, performChannelOperation } from "./channel-runtime";
import {
  expirePayments,
  refreshFromProvider,
  retryPaymentHooks,
} from "./payments";
import "./modules/runtime";
import { credentialHook } from "./modules/hooks";
import { claim as claimCredential } from "./module-credentials";
import { SCHEDULE_INTERVAL_MS, runModuleSchedules } from "./modules/schedule";
import { withLocalModuleWake } from "./modules/local-wake";
import {
  processInbox,
  processRun,
  deliver,
  deliverWebhook,
  importDocument,
  listReadyChannelDeliveries,
  nextChannelDeliveryAt,
  recoverChannelDeliveries,
  withChannelDeliveryWake,
} from "./engine";

/** Recibos, inclusive os anteriores a esta versão, não são credenciais. */
export async function authorizeCustomerReplay(env: Env, actor: Actor, profile: string,
  operation: string, data: any, value: any,
  options?: { remote?: boolean; actorCheck?: (actor: Actor) => void }) {
  const missing = (): never => { throw new ApiError(404, "not_found", "Recurso não encontrado."); };
  if (actor.expiresAt && actor.expiresAt <= now()) missing();
  if (actor.kind === "user") {
    const current = await one(env, "SELECT role,profiles,access FROM users WHERE id=? AND disabled=0", actor.id);
    if (!current) missing();
    actor = { ...actor, role: current.role, profiles: json(current.profiles, []), access: storedAccess(current.access) };
  } else if (actor.kind === "app") {
    const current = await one(env, "SELECT profiles,scopes FROM applications WHERE id=? AND disabled=0", actor.id.replace(/^app:/, ""));
    if (!current) missing();
    if (actor.keyId && !await one(env, "SELECT 1 FROM api_keys WHERE id=? AND app_id=? AND revoked=0 AND expires>?", actor.keyId, actor.id.replace(/^app:/, ""), now())) missing();
    actor = { ...actor, profiles: json(current.profiles, []), scopes: legacyKeyScopes(json(current.scopes, [])) };
  }
  options?.actorCheck?.(actor);
  access(actor, profile, "contacts:write");
  requireOperationAccess(actor, operation);
  const section = operation === "contact.section" || operation.endsWith(".customer-section");
  const module = section ? (operation === "contact.section" ? data.module : operation.split(".")[0]) : "";
  const erpOperation = ["contact.promote", "contact.from-erp"].includes(operation);
  const jobOperation = ["contact.resolve-job", "contact.job-cancel"].includes(operation);
  if (section) await requireCustomerModule(env, actor, profile, module);
  else if (erpOperation || (jobOperation && !allows(actor, "contacts"))) await requireCustomerModule(env, actor, profile, "erp");
  else customerAccess(actor, profile, true);
  if (jobOperation || operation === "contact.resolve-phone") human(actor);
  if (operation === "contact.erasure") {
    human(actor);
    if (actor.role !== "admin") throw new ApiError(403, "forbidden", "A exclusão exige um administrador.");
  }
  // Erros e importação só retornam uma projeção sem dados cadastrais.
  if (value?.error) return { error: { code: value.error.code, message: "A operação anterior não foi concluída." } };
  if (operation === "contact.import") return { imported: value?.imported, skipped: value?.skipped, total: value?.total };
  const ids = new Set<string>();
  for (const id of [operation === "contact.resolve-phone" ? data.contactId : null,
    operation === "contact.from-conversation" ? data.contact_id : null,
    operation === "contact.unlink" ? data.expected_contact_id : null, value?.contactId, value?.result?.contactId])
    if (typeof id === "string" && id) ids.add(id);
  const association = ["contact.from-conversation", "contact.unlink"].includes(operation);
  let associationNamespace: string | undefined;
  if (association) {
    access(actor, profile, "conversations:read"); requireAccess(actor, "conversations");
    const conv = await one(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, data.id);
    if (!conv || !visibleConversation(actor, conv) || (actor.kind === "app" && conv.external_namespace !== namespaceFor(actor))) missing();
    associationNamespace = conv.external_namespace.startsWith("app:") ? conv.external_namespace : "team";
    if (operation === "contact.from-conversation") {
      if (["blocked", "excluded"].includes(conv.customer_link_state)) missing();
      const link = await one(env, "SELECT contact_id FROM conversation_contacts WHERE profile_id=? AND conversation_id=?", profile, data.id);
      if (!link || link.contact_id !== (value?.contactId ?? value?.id)) missing();
      ids.add(link.contact_id);
    }
  } else if ((section || ["contact.update", "contact.promote", "contact.erasure"].includes(operation)) && typeof data.id === "string") ids.add(data.id);
  if (["contact.create", "contact.update", "contact.from-conversation"].includes(operation) && typeof value?.id === "string") ids.add(value.id);
  let jobNamespace: string | undefined;
  if (jobOperation || value?.jobId || operation === "contact.erasure") {
    const job = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, jobOperation ? data.id : value.jobId ?? value.id);
    if (!job || (actor.kind !== "user" && job.namespace !== namespaceFor(actor))) missing();
    jobNamespace = job.namespace;
    if (job.contact_id && value?.contactId && job.contact_id !== value.contactId) missing();
    if (job.contact_id) ids.add(job.contact_id);
  }
  // Sem recurso identificável não há reconstrução por nova mutação.
  if (!ids.size) missing();
  for (const id of ids) {
    const row = await contactRow(env, actor, profile, id);
    if (jobNamespace && row.namespace !== jobNamespace) missing();
    if (associationNamespace && row.namespace !== associationNamespace) missing();
    if (value?.namespace && value.namespace !== row.namespace) missing();
    if (operation === "contact.resolve-phone" && data.namespace !== row.namespace) missing();
    if (actor.kind === "connector") await validateCustomerSelfActor(env, actor, profile, id);
    if (erpOperation || (jobOperation && !allows(actor, "contacts"))) {
      if (row.namespace !== "team") missing();
      const erpId = row.erp_contact_id ?? (operation === "contact.from-erp" ? data.erpId : null);
      if (operation === "contact.from-erp" && row.erp_contact_id && row.erp_contact_id !== data.erpId) missing();
      if (erpId) { if (options?.remote !== false) await erpBridge.read(env, actor, profile, erpId); }
      else if (!allows(actor, "contacts")) missing();
    }
  }
  if (operation === "contact.resolve-phone") {
    const current = await one(env, "SELECT contact_id,state FROM customer_phones WHERE profile_id=? AND namespace=? AND phone=?", profile, data.namespace, value.phone);
    if (!current || current.contact_id !== value.contactId || current.state !== value.state) missing();
  }
  if (section) {
    const current = await profilePort.section(env, actor, profile, data.id, module, data.section);
    if (!current.writable) throw new ApiError(403, "forbidden", "Você não pode editar esta seção.");
  }
  return value;
}

export class Coordinator extends DurableObject<Env> {
  private profile = "";
  private busy = false;
  private customerMaintenanceRunning = false;
  private channelWork: Record<string, number> | null = null;
  private channelTickRunning = false;
  /**
   * Gravações da resposta exata no recibo em andamento (/command), por
   * "escopo\nchave": a repetição com a mesma Idempotency-Key espera antes do
   * bloqueio e, depois, lê a resposta gravada.
   */
  private closing = new Map<string, Promise<void>>();
  private erp = new ErpHub(this.env, this.ctx);
  async fetch(request: Request) {
    installChannelRuntime();
    // Instâncias "erp:<área>" (src/erp/hub.ts): só "/erp-*", antes de ler o
    // corpo e de gravar o perfil da área.
    const erpPath = new URL(request.url).pathname;
    if (erpPath.startsWith("/erp-")) return this.erp.handle(erpPath, request);
    if (await this.erp.isErp())
      return new Response("Instância do ERP.", { status: 404 });
    // Instâncias históricas "hermes-link:<conexão>" ficam ociosas: não
    // gravam perfil nem agendam alarme.
    const linkPath = new URL(request.url).pathname;
    if (linkPath.startsWith("/link-"))
      return new Response("Hermes retirado: escolha um bot interno.", { status: 410 });
    if (linkPath === "/queue-ws") return this.acceptQueueSocket(request);
    const body = await request.json<any>();
    if (linkPath === "/c2-inbound") {
      try {
        const verified = await verifyIngressTicket(this.env, body.ticket);
        if (request.method !== "POST" || verified.scope.profileId !== body.profile)
          throw new ApiError(403, "invalid_channel_evidence", "Origem da entrada inválida.");
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
    }
    // A rota interna antiga não é uma alternativa ao ticket autenticado.
    if ((linkPath === "/inbound" || linkPath === "/channel-event" ||
        linkPath === "/command" && body.operation === "inbound") &&
        (["telegram", "email", "tiktok", "googlebusiness"].includes(body.data?.channel) ||
          ["comment", "review"].includes(body.data?.channel_context?.context)))
      return Response.json({ error: { code: "invalid_channel_evidence", message: "Este canal exige entrada autenticada." } }, { status: 403 });
    // Credencial revogada: fecha os sockets dela nesta área (src/sockets.ts).
    if (linkPath === "/close-sockets") {
      let closed = 0;
      for (const tag of Array.isArray(body.tags) ? body.tags : [])
        for (const ws of this.ctx.getWebSockets(String(tag)))
          try {
            ws.close(REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
            closed++;
          } catch {
            // Já fechado.
          }
      return Response.json({ closed });
    }
    if (linkPath === "/customer-tick" &&
        (request.method !== "POST" || typeof body.profile !== "string" || !body.profile))
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    this.profile = body.profile;
    await this.ctx.storage.put("profile", this.profile);
    if (linkPath === "/c2-inbound") {
      try {
        const result = await this.ctx.blockConcurrencyWhile(() => receiveExtensionIngress(this.env, this.profile, body.ticket));
        if (result.wake || result.maintenance?.length) {
          await this.markChannelWork(result.maintenance ?? [], now(), result.wake);
          await this.schedule();
        }
        return Response.json(result, { status: 202 });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
    }
    if (linkPath === "/c2-wake") {
      await this.markChannelWork(Array.isArray(body.keys) ? body.keys : [],
        Number.isFinite(body.at) ? Math.max(now(), body.at) : now(), true);
      return Response.json({ scheduled: true });
    }
    if (linkPath === "/c2-recover") {
      await this.recoverChannelWork();
      return Response.json({ scheduled: true });
    }
    // Também o comando legado passa pela reserva dedicada. Nunca deixe
    // contact.maintain chegar ao perform dentro da fila do atendimento.
    if (linkPath === "/customer-tick" || (linkPath === "/command" && body.operation === "contact.maintain")) {
      if (linkPath === "/command" && (body.actor?.kind !== "connector" || body.actor?.id !== "customer-maintenance"))
        return Response.json({ error: { code: "forbidden", message: "Manutenção interna." } }, { status: 403 });
      return this.customerTick(body.profile);
    }
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
    if (new URL(request.url).pathname === "/command") {
      // F0: reservas/confirmações de upload e aplicação de modelo usam esta
      // mesma fila e os mesmos recibos. Bytes ficam no Worker/R2; nunca no
      // JSON, na auditoria ou no recibo do Coordinator.
      // Repetição de um comando cujo recibo ainda está fechando (depois da
      // resposta, abaixo): espera o fechamento aqui, fora do bloqueio, e
      // segue; lá dentro, o recibo já tem a resposta e ela volta igual.
      // NUNCA espere o fechamento dentro do blockConcurrencyWhile: o bloqueio
      // segura a entrega da resposta do D1 que o fechamento espera, e o
      // objeto trava até o limite do runtime (30 s) e reinicia. Achado pelo
      // teste "repetições durante a gravação da resposta" em
      // tests/command-receipt-closing.test.ts.
      const pending = this.closing.get(
        `${(body.actor as Actor).id}:${this.profile}:${body.operation}\n${body.key}`,
      );
      if (pending) await pending;
      const commandResult = await this.ctx.blockConcurrencyWhile(async () => {
        const actor: Actor = body.actor,
          scope = `${actor.id}:${this.profile}:${body.operation}`,
          fingerprint = await sha(canonical(body.data));
        // Idas ao D1 deste comando (Server-Timing) e o cache de leituras dele
        // inteiro (perform reaproveita o escopo).
        const { env: timed, timing } = timedEnv(this.env);
        const env = withReadCache(withChannelDeliveryWake(
          withLocalModuleWake(timed, this.profile, (options) => this.wakeModules(options)),
          this.profile, () => this.markChannelWork([], now(), true),
        ));
        // Abertura numa ida só (docs/LIMITES.md): o recibo anterior, a
        // reserva do recibo (INSERT OR IGNORE: só a primeira grava) e as
        // leituras de configuração que quase todo comando faz.
        const warmReads: Read[] = [
          { sql: MODULE_STATES_SQL, args: [this.profile] },
          { sql: PROFILE_SETTINGS_SQL, args: [this.profile], first: true },
          { sql: WEBHOOK_SUBS_SQL, args: [this.profile] },
          { sql: PUBLIC_ORIGIN_SQL, args: [], first: true },
        ];
        // Identificador da operação para as chaves derivadas (sourceKey, ids
        // de registro): único por credencial, área, operação e
        // Idempotency-Key, estável nas repetições e só com hexadecimais. A
        // chave do cliente nunca vira id direto: outra credencial ou outra
        // área com a mesma chave é outra operação, e "/" não quebra URL.
        const operationId = (await sha(`${scope}\n${body.key}`)).slice(0, 32);
        // O começo da operação também vai neste lote (a emissão e a chamada
        // da fila): o comando inteiro fica em duas idas ao D1, a abertura e
        // a gravação. Os resultados valem uma vez só (src/db.ts).
        const prefetch = queuePrefetch(
          body.operation,
          body.data,
          actor,
          this.profile,
          operationId,
        );
        const opening = await batch(
          env,
          [
            [
              "SELECT * FROM receipts WHERE scope=? AND key=?",
              [scope, body.key],
            ],
            [
              "INSERT OR IGNORE INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)",
              [scope, body.key, fingerprint, now()],
            ],
            ...warmReads.map((r) => [r.sql, r.args] as [string, any[]]),
            ...prefetch,
          ],
          // Repetir é seguro: a reserva só grava uma vez (e o +1 do contador
          // por minuto do totem pode contar uma repetição a mais).
          { retry: true },
        );
        warmReads.forEach((r, i) => seedRead(env, r, opening[i + 2].results));
        seedPrefetch(env, prefetch, opening.slice(2 + warmReads.length));
        const old: any = opening[0].results[0];
        // A emissão e a chamada da fila fecham o recibo no lote da própria
        // escrita (src/command-context.ts): a auditoria e a marca
        // "ref:<operação>:<id>" gravam junto com a senha, ou nada grava.
        const closingOp = QUEUE_CLOSING_OPS.has(body.operation);
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
          if (old.response?.startsWith("ref:")) {
            // A escrita gravou, mas a resposta exata não (o objeto reiniciou
            // depois de responder, ou a gravação dela falhou): reconstrói
            // pelo recurso e fecha o recibo aqui.
            try {
              const value = await queueReplay(
                env,
                actor,
                this.profile,
                old.response,
              );
              await batch(env, [
                [
                  "UPDATE receipts SET response=? WHERE scope=? AND key=? AND response=?",
                  [
                    "sealed:" + (await seal(this.env, value)),
                    scope,
                    body.key,
                    old.response,
                  ],
                ],
              ]);
              return Response.json(value, {
                status: old.status ?? 200,
                headers: { "Idempotency-Replayed": "true" },
              });
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              // O recurso sumiu: não há como reconstruir.
            }
          }
          const recoverableWork = /^(area-template\.apply|os\.(?:private\.)?(?:task|person|entry)\.(?:create|update|archive|revise)|os\.(?:private\.)?document\.(?:reserve|complete|archive)|os\.stage(?:\.approval|\.decision)?|os\.private\.update)$/.test(body.operation);
          const recoverableCustomer = body.operation.startsWith("contact.") && body.operation !== "contact.maintain";
          const recoverableExtension = body.operation === "c2.route" ||
            body.operation === "message.action" && body.data.action === "channel" ||
            body.operation === "connection.save" && ["telegram_bot", "email"].includes(body.data.kind);
          if (!old.response && (closingOp || recoverableWork || recoverableCustomer || recoverableExtension || isChannelOperation(body.operation))) {
            // Sem a marca, a escrita não gravou (o lote é atômico): a
            // operação roda de novo, abaixo. Na emissão, a chave de origem
            // ainda devolve a senha de antes, se houver.
            // Filhos/etapas do motor recuperam a mutação pelo operationId
            // estável, incluindo publicação que faltou após confirmar o D1.
          } else if (!old.response || old.response.startsWith("ref:")) {
            // Recibo sem resposta de outra operação (o objeto caiu no meio
            // do comando): o código de sempre, que os apps repetem com a
            // mesma chave (Senhapp, Android e iOS: operation_unknown).
            return Response.json(
              {
                error: {
                  code: "operation_unknown",
                  message:
                    "A operação anterior não concluiu o recibo. Reconcilie antes de repetir.",
                },
              },
              { status: 409, headers: { "Retry-After": "1" } },
            );
          } else {
            let response = old.response;
            if (body.operation === "connection.save" && ["telegram_bot", "email"].includes(body.data.kind)) {
              try { await authorizeChannelConnectionReplay(this.env, actor, this.profile); }
              catch (error) {
                if (!(error instanceof ApiError)) throw error;
                return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
              }
            }
            if (body.operation === "conversation.action" && body.data.action === "reply") {
              const value = old.response.startsWith("sealed:") ? await unseal(this.env, old.response.slice(7)) : JSON.parse(old.response);
              if (value?.channel_extension) {
                try {
                  await authorizeChannelActionReplay(this.env, actor, this.profile, body.data.id,
                    { type: "message.send", text: String(body.data.text || "").trim() });
                  return Response.json(value, { status: old.status, headers: { "Idempotency-Replayed": "true" } });
                } catch (error) {
                  if (!(error instanceof ApiError)) throw error;
                  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
                }
              }
            }
            if (body.operation === "delivery.reconcile") {
              const value = old.response.startsWith("sealed:") ? await unseal(this.env, old.response.slice(7)) : JSON.parse(old.response);
              if (value?.channel_extension) {
                try {
                  await authorizeChannelDeliveryReconciliation(this.env, actor, this.profile, body.data.id);
                  return Response.json(value, { status: old.status, headers: { "Idempotency-Replayed": "true" } });
                } catch (error) {
                  if (!(error instanceof ApiError)) throw error;
                  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
                }
              }
            }
            if (body.operation === "c2.route" || body.operation === "message.action" && body.data.action === "channel") {
              try {
                if (body.operation === "c2.route") await authorizeExtensionReplay(this.env, actor, this.profile,
                  body.data.method, body.data.path, body.data.input);
                else await authorizeChannelActionReplay(this.env, actor, this.profile, body.data.id, body.data.channel_action);
                const value = old.response.startsWith("sealed:") ? await unseal(this.env, old.response.slice(7)) : JSON.parse(old.response);
                return Response.json(value, { status: old.status, headers: { "Idempotency-Replayed": "true" } });
              } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
              }
            } else if (isChannelOperation(body.operation)) {
              try {
                const value = await authorizeChannelReplay(this.env, actor, this.profile, body.operation, body.data,
                  old.response.startsWith("sealed:") ? await unseal(this.env, old.response.slice(7)) : JSON.parse(old.response));
                return Response.json(value, { status: old.status, headers: { "Idempotency-Replayed": "true" } });
              } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
              }
            } else if (body.operation.startsWith("contact.") || body.operation.endsWith(".customer-section")) {
              return { customerReplay: old.response.startsWith("sealed:")
                ? await unseal(this.env, old.response.slice(7)) : JSON.parse(old.response), status: old.status };
            } else if (old.response.startsWith("sealed:")) response = JSON.stringify(await unseal(this.env, old.response.slice(7)));
            return new Response(
              response,
              {
                status: old.status,
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Replayed": "true",
                },
              },
            );
          }
        }
        let status = 200,
          value: any,
          audited: [string, any[]] | null = null;
        // Fechamento no lote da escrita (emissão e chamada da fila).
        const closingRef = { ref: null as string | null };
        if (closingOp)
          withCommandClosing(env, {
            operation: body.operation,
            get ref() {
              return closingRef.ref;
            },
            statements: (id, guard) => {
              const [sql, args] = auditStatement(
                actor,
                this.profile,
                body.operation,
                id,
                body.requestId,
              );
              const where = guard ? guard[0] : "1";
              const guardArgs = guard ? guard[1] : [];
              return [
                // INSERT … VALUES(…) vira INSERT … SELECT … WHERE <condição>.
                [
                  sql.replace(" VALUES(", " SELECT ").replace(/\)$/, "") +
                    ` WHERE ${where}`,
                  [...args, ...guardArgs],
                ],
                [
                  `UPDATE receipts SET response=?,status=200 WHERE scope=? AND key=? AND ${where}`,
                  [
                    `ref:${body.operation}:${id}`,
                    scope,
                    body.key,
                    ...guardArgs,
                  ],
                ],
              ];
            },
            committed: (id) => {
              closingRef.ref = `ref:${body.operation}:${id}`;
            },
          });
        try {
          value = body.operation === "c2.route" ? await performExtensionRoute(env, actor, this.profile,
            body.data.method, body.data.path, body.data.input, operationId) : await (isChannelOperation(body.operation) ? performChannelOperation : perform)(
            env,
            actor,
            this.profile,
            body.operation,
            body.data,
            operationId,
          );
          if (body.operation === "c2.route" || body.operation === "message.action" && body.data.action === "channel" ||
              body.operation === "connection.save" && ["telegram_bot", "email"].includes(body.data.kind) ||
              body.operation === "channel.import" && ["tiktok", "googlebusiness"].includes(body.data.channel) ||
              value?.channel_extension || value?.channel_extensions?.length)
            await this.markChannelWork(registeredChannelMaintenance().map(item => item.key), now(), true);
          // Auditoria no mesmo lote do fechamento do recibo (abaixo).
          audited = auditStatement(
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
        const sealed = "sealed:" + (await seal(this.env, value));
        const closeReceipt: [string, any[]] = [
          "UPDATE receipts SET response=?,status=? WHERE scope=? AND key=?",
          [sealed, status, scope, body.key],
        ];
        if (closingRef.ref) {
          // A auditoria e a marca do recibo já gravaram no lote da escrita.
          // A resposta exata vai depois da resposta ao cliente: enquanto
          // grava, uma repetição com a mesma chave espera por ela (antes do
          // bloqueio, acima); se ela se perder (reinício), a repetição
          // reconstrói pela marca.
          const closingKey = `${scope}\n${body.key}`;
          const closing = batch(env, [closeReceipt])
            .then(() => undefined)
            .catch((error) => {
              console.error(
                JSON.stringify({
                  component: "receipt",
                  error: String(error?.message ?? error).slice(0, 200),
                }),
              );
            })
            .finally(() => this.closing.delete(closingKey));
          this.closing.set(closingKey, closing);
          this.ctx.waitUntil(closing);
        } else {
          // As outras operações (e a emissão que devolveu a senha de antes,
          // ou um erro): fechamento numa ida, antes da resposta, com a
          // auditoria se a operação deu certo.
          await batch(env, [...(audited ? [audited] : []), closeReceipt]);
        }
        await this.schedule();
        // "settings": o cupom da senha vai no snapshot dos aparelhos. Fora do
        // caminho da resposta: o totem e o painel não esperam o snapshot.
        if (/^(queue\.|counter\.|settings$)/.test(body.operation))
          this.ctx.waitUntil(this.broadcastQueueSoon());
        return Response.json(value, {
          status,
          headers: { "Server-Timing": serverTiming(timing) },
        });
      });
      if (commandResult instanceof Response) return commandResult;
      try {
        let authorization = "";
        // A política do registro ERP pode exigir RPC: também fora do bloqueio.
        if (["contact.promote", "contact.from-erp", "contact.resolve-job", "contact.job-cancel"].includes(body.operation))
          await authorizeCustomerReplay(this.env, body.actor, body.profile, body.operation, body.data, commandResult.customerReplay, {
            actorCheck: actor => { authorization = canonical(actor); },
          });
        // Depois da espera remota, relê restrições e ator na fila curta, sem
        // repetir o RPC nem a mutação. O Env é novo, sem cache da abertura.
        return await this.ctx.blockConcurrencyWhile(async () => {
          try {
            const value = await authorizeCustomerReplay(this.env, body.actor, body.profile, body.operation, body.data, commandResult.customerReplay, {
              remote: false,
              actorCheck: actor => {
                if (authorization && canonical(actor) !== authorization) throw new ApiError(403, "forbidden", "O acesso mudou. Reabra a ficha.");
              },
            });
            return Response.json(value, { status: commandResult.status, headers: { "Idempotency-Replayed": "true" } });
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
          }
        });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
    }
    // Passo web concluído pela página pública: a mensagem de retorno, o
    // protocolo e a nota entram na fila da área como o resto do atendimento.
    if (new URL(request.url).pathname === "/web-step") {
      const result = await this.ctx.blockConcurrencyWhile(() =>
        completeWebStep(this.env, body.id, body.answers || {}),
      );
      await this.schedule();
      return Response.json(result);
    }
    // QR de módulo lido pelo app (src/module-credentials.ts): a leitura e o
    // gancho do módulo na mesma fila de escrita da área.
    if (new URL(request.url).pathname === "/credential-claim") {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        try {
          return {
            status: 200,
            value: await claimCredential(this.env, body, async (row) => {
              const hook = credentialHook(row.module_id);
              if (!hook)
                throw new ApiError(404, "claim_not_found", "QR inválido.");
              return hook(this.env, row.profile_id, row);
            }),
          };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return {
            status: error.status,
            value: { error: { code: error.code, message: error.message } },
          };
        }
      });
      await this.schedule();
      return Response.json(result.value, { status: result.status });
    }
    // Webhook de pagamento já assinado: consulta o provedor e muda o estado
    // na mesma fila de escrita da área.
    if (new URL(request.url).pathname === "/payment-webhook") {
      const result = await this.ctx.blockConcurrencyWhile(() =>
        refreshFromProvider(this.env, body.account, body.payment_id),
      );
      await this.schedule();
      return Response.json(result);
    }
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
      const { env, timing } = timedEnv(this.env);
      const result = await this.ctx.blockConcurrencyWhile(() =>
        inbound(
          env,
          this.profile,
          body.data,
          body.namespace,
          body.connectionId,
        ),
      );
      await this.schedule();
      return Response.json(result, { status: 202, headers: { "Server-Timing": serverTiming(timing) } });
    }
    if (linkPath === "/wake" && body.modules === true) {
      await this.wakeModules({ modules: true });
      return Response.json({ scheduled: true });
    }
    // Qualquer outro caminho só agenda o alarme; o /wake dos módulos
    // (ctx.wake, rotas de telemetria) usa este caminho.
    await this.schedule();
    return Response.json({ scheduled: true });
  }
  private async customerTick(profile: string) {
    const reservation = await this.ctx.blockConcurrencyWhile(async () => {
      const lease = await this.ctx.storage.get<{ token: string; until: number }>("customer_maintenance_lease");
      if (this.customerMaintenanceRunning || (lease && lease.until > now())) return null;
      const turn = await this.ctx.storage.get<number>("customer_maintenance_turn") ?? 0;
      const next = { token: crypto.randomUUID(), until: now() + 60_000 };
      // Avança ANTES de chamar a porta: queda/falha não monopoliza a vez.
      // Controle fica no storage do DO, sem instruções D1 adicionais.
      await this.ctx.storage.put({ customer_maintenance_turn: turn + 1, customer_maintenance_lease: next });
      this.customerMaintenanceRunning = true;
      return { ...next, turn };
    });
    if (!reservation) return Response.json({ pending: true, progress: false, leased: true, statements: 0, items: 0 });
    const { env, timing } = timedEnv(this.env);
    let progress = false;
    let active = true;
    const check = () => { if (!active || now() >= reservation.until) throw new Error("Reserva de manutenção vencida."); };
    const meter = customerMaintenanceEnv(env, 40, check);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = maintainCustomers(withReadCache(meter.env), profile, {
        remainingStatements: 40, remainingItems: 20,
      }, reservation.turn, {
        fair: true,
        onProgress: () => { progress = true; },
        // Um retorno ERP após o vencimento não pode confirmar D1 com lease
        // velha. A intenção da porta será reconciliada na próxima passagem.
        check,
      });
      // Um transporte que nunca retorna também não pode monopolizar a
      // manutenção. Ao vencer, libera a vez; o trabalho antigo fica impedido
      // de confirmar D1 pelo guardião acima, mesmo se o ERP responder depois.
      const result = await Promise.race([work, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(0, reservation.until - now()));
      })]);
      return Response.json(result ? { ...result, progress } : {
        pending: true, progress: false, timedOut: true, statements: meter.count(), items: 20,
      }, { headers: { "Server-Timing": serverTiming(timing) } });
    } finally {
      active = false;
      clearTimeout(timer);
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.ctx.storage.get<{ token: string }>("customer_maintenance_lease");
        if (current?.token === reservation.token) await this.ctx.storage.delete("customer_maintenance_lease");
        this.customerMaintenanceRunning = false;
      });
    }
  }
  private async wakeModules(options?: { modules?: boolean }) {
    if (options?.modules) {
      await this.ctx.storage.put("modules_pending", true);
      const last = (await this.ctx.storage.get<number>("modules_tick")) || 0;
      await this.schedule(Math.max(now() + 1000, last + SCHEDULE_INTERVAL_MS));
    } else await this.schedule();
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
    // Tags da credencial (pessoa, sessão, aplicação, chave ou painel de TV)
    // para fechar o socket quando ela for revogada.
    const credential = (
      json(request.headers.get("X-Wabotia-Credential"), []) as unknown[]
    )
      .filter((t): t is string => typeof t === "string" && t.length <= 200)
      .slice(0, 8);
    this.ctx.acceptWebSocket(server, ["queue", ...credential]);
    // Validade da credencial (revisão B4): o socket fecha quando ela vencer.
    const expires = Number(request.headers.get("X-Wabotia-Expires")) || null;
    server.serializeAttachment({ filter, expires });
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
  /** Fecha os sockets cuja credencial venceu (sessão ou chave). */
  private closeExpiredSockets() {
    const at = now();
    return this.ctx.getWebSockets("queue").filter((ws) => {
      const expires = ws.deserializeAttachment()?.expires;
      if (!expires || expires > at) return true;
      try {
        ws.close(REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
      } catch {
        // Já fechado.
      }
      return false;
    });
  }
  private broadcasting: Promise<void> | null = null;
  private broadcastAgain = false;
  /**
   * O envio aos painéis fora do caminho da resposta do comando, um de cada
   * vez: um pedido que chega durante um envio faz mais uma volta no fim, para
   * o último snapshot ser sempre o mais novo (nunca um antigo depois).
   */
  private broadcastQueueSoon(): Promise<void> {
    if (this.broadcasting) {
      this.broadcastAgain = true;
      return this.broadcasting;
    }
    this.broadcasting = (async () => {
      try {
        do {
          this.broadcastAgain = false;
          await this.broadcastQueue();
        } while (this.broadcastAgain);
      } finally {
        this.broadcasting = null;
      }
    })();
    return this.broadcasting;
  }
  /** Sends new calls and a fresh snapshot to every connected panel. */
  private async broadcastQueue() {
    const sockets = this.closeExpiredSockets();
    if (!sockets.length || !this.profile) return;
    const cursor = (await this.ctx.storage.get<number>("queue_cursor")) || 0;
    // Há evento novo? (Leitura barata: o alarme também chama o envio.)
    const fresh = await one(
      this.env,
      "SELECT id FROM events WHERE profile_id=? AND id>? AND kind LIKE 'queue.%' LIMIT 1",
      this.profile,
      cursor,
    );
    if (!fresh) return;
    // Os eventos e o panorama no mesmo lote, do mesmo instante: o envio roda
    // fora do comando (ctx.waitUntil), e outro comando pode terminar no
    // meio. Lidos em separado, o painel recebia a chamada da senha A e um
    // panorama em que a atual já era a B, antes da chamada da B
    // (tests/queue-panel-race.test.ts). Uma leitura só do panorama para
    // todos os filtros (overviewData).
    const data = await overviewData(this.env, this.profile, [
      {
        sql: "SELECT id,kind,payload FROM events WHERE profile_id=? AND id>? AND kind LIKE 'queue.%' ORDER BY id LIMIT 200",
        args: [this.profile, cursor],
      },
    ]);
    const rows: any[] = data.extra[0];
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
              data: await overviewOf(data, filter),
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
  private async schedule(at = now() + 1000) {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > at)
      await this.ctx.storage.setAlarm(at);
  }
  private async loadChannelWork() {
    return this.channelWork ??= await this.ctx.storage.get<Record<string, number>>("c2_pending") ?? {};
  }
  private async markChannelWork(keys: readonly string[], at: number, deliveries = false) {
    const pending = await this.loadChannelWork();
    for (const key of keys) if (channelMaintenance(key)) pending[key] = Math.min(pending[key] ?? Infinity, at);
    if (deliveries) pending.$deliveries = Math.min(pending.$deliveries ?? Infinity, at);
    await this.ctx.storage.put("c2_pending", pending);
    if (Object.keys(pending).length) await this.schedule(Math.max(now() + 1000, Math.min(...Object.values(pending))));
  }
  /** Só cron invoca recover: perda de marcador não acrescenta consultas às
   * mensagens antigas. Os descritores limitam a rodada de recuperação. */
  private async recoverChannelWork() {
    const time = now();
    for (const item of registeredChannelMaintenance()) {
      if (!item.recover) continue;
      const result = await item.recover({ env: this.env, profileId: this.profile, now: time });
      if (result.pending || result.nextAt !== null)
        await this.markChannelWork([item.key], result.nextAt ?? time + 5000);
    }
    await recoverChannelDeliveries(this.env, this.profile);
    const due = await nextChannelDeliveryAt(this.env, this.profile);
    if (due !== null) await this.markChannelWork([], due, true);
  }
  private async runChannelWork() {
    if (this.channelTickRunning) return;
    const pending = await this.loadChannelWork();
    const due = Object.entries(pending).filter(([, at]) => at <= now());
    if (!due.length) return;
    this.channelTickRunning = true;
    try {
      for (const [key, at] of due) {
        // Reserva antes da chamada. Uma queda conserva o marcador durável;
        // uma nova ativação durante a espera remota antecipa a próxima rodada.
        if (pending[key] !== at) continue;
        const reservedUntil = now() + 30000;
        pending[key] = reservedUntil;
        await this.ctx.storage.put("c2_pending", pending);
        try {
          let nextAt: number | null = null;
          if (key === "$deliveries") {
            await recoverChannelDeliveries(this.env, this.profile);
            for (const row of await listReadyChannelDeliveries(this.env, this.profile, 10)) await deliver(this.env, row);
            nextAt = await nextChannelDeliveryAt(this.env, this.profile);
          } else {
            const task = channelMaintenance(key);
            if (task) {
              const result = await task.run({
                env: withChannelDeliveryWake(this.env, this.profile, () => this.markChannelWork([], now(), true)),
                profileId: this.profile, now: now(),
              });
              nextAt = result.nextAt ?? (result.pending ? now() + 5000 : null);
            }
          }
          if (pending[key] === reservedUntil) delete pending[key];
          if (nextAt !== null) pending[key] = Math.min(pending[key] ?? Infinity, Math.max(now() + 1000, nextAt));
        } catch {
          pending[key] = Math.min(pending[key] ?? Infinity, now() + 30000);
          // Erros remotos não passam pela saída de console nem contêm segredo.
        }
        await this.ctx.storage.put("c2_pending", pending);
      }
    } finally {
      this.channelTickRunning = false;
    }
  }
  async alarm() {
    installChannelRuntime();
    // Instância do ERP: alarme próprio, nunca o pipeline da área.
    if (await this.erp.isErp()) return this.erp.alarm();
    if (this.busy) return;
    this.busy = true;
    this.profile ||= (await this.ctx.storage.get<string>("profile")) || "";
    try {
      if (this.profile === "_admin") {
        await automaticUpdateTick(this.env);
        await processUpdate(this.env);
        return;
      }
      // Uma invocação: leituras de configuração lembradas no alarme inteiro
      // (as entregas releem a área a cada linha; docs/LIMITES.md).
      const env = withReadCache(withChannelDeliveryWake(this.env, this.profile, () => this.markChannelWork([], now(), true)));
      await exec(
        env,
        "UPDATE outbox SET status='unknown',error='Processo interrompido durante envio; reconcilie antes de repetir.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await exec(
        env,
        "UPDATE inbox SET status='pending' WHERE profile_id=? AND status='processing'",
        this.profile,
      );
      for (const row of await all(
        env,
        "SELECT * FROM outbox WHERE profile_id=? AND status='sent' AND completion_handled=0 LIMIT 20",
        this.profile,
      ))
        await finishDelivery(env, row, row.external_id || row.id);
      await exec(
        env,
        "UPDATE group_operations SET status='unknown',error='Conector interrompido; confira o grupo antes de reconciliar.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await expireCalls(env, this.profile);
      await expireUploads(env, this.profile);
      await closeDay(env, this.profile);
      await expireWebSteps(env, this.profile);
      await expirePayments(env, this.profile);
      await retryPaymentHooks(env, this.profile);
      // Tarefas periódicas dos módulos (onSchedule): no máximo uma rodada por
      // minuto; o cron de 5 minutos garante a frequência mínima.
      const tick = now();
      const last = (await this.ctx.storage.get<number>("modules_tick")) || 0;
      if (tick - last >= SCHEDULE_INTERVAL_MS) {
        await this.ctx.storage.put("modules_tick", tick);
        // Consumir antes da rodada: um novo wake durante ela fica pendente.
        await this.ctx.storage.delete("modules_pending");
        try {
          // Sem blockConcurrencyWhile: a rodada de todos os módulos pode
          // chamar provedores (cobrança) e não deve segurar webhooks, comandos
          // e painel nem arriscar o limite de 30 s do bloqueio. Corridas com
          // comandos ficam com cada módulo (tarefas de OS: reserva condicionada
          // à versão antes do envio, src/modules/os/tasks/reminders.ts).
          await runModuleSchedules(
            withLocalModuleWake(env, this.profile, (options) => this.wakeModules(options)), this.profile, tick,
          );
        } catch (error) {
          await this.ctx.storage.put("modules_pending", true);
          throw error;
        }
      }
      await this.runChannelWork();
      await processInbox(env, this.profile);
      await this.broadcastQueueSoon();
      for (const run of await all<Run>(
        env,
        "SELECT * FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)) ORDER BY created LIMIT 5",
        this.profile,
      ))
        await processRun(env, run);
      const channelQueueFilter = Object.keys(await this.loadChannelWork()).length ? " AND kind<>'channel'" : "";
      for (const row of await all(
        env,
        `SELECT * FROM outbox o WHERE profile_id=? AND status='pending'${channelQueueFilter} AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.conversation_id=o.conversation_id AND (p.kind='team')=(o.kind='team') AND (p.created<o.created OR (p.created=o.created AND p.rowid<o.rowid)) AND p.status IN ('pending','sending','unknown')) ORDER BY created,rowid LIMIT 10`,
        this.profile,
      ))
        await deliver(env, row);
      for (const row of await all(
        env,
        "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending' AND d.next_at<=? LIMIT 10",
        this.profile,
        now(),
      ))
        await deliverWebhook(env, row);
      const doc = await one(
        env,
        "SELECT * FROM documents WHERE profile_id=? AND status='pending' LIMIT 1",
        this.profile,
      );
      if (doc) await importDocument(env, doc);
      await processPush(env, this.profile);
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
      const channelQueueFilter = Object.keys(await this.loadChannelWork()).length ? " AND kind<>'channel'" : "";
      const pending =
        this.profile === "_admin"
          ? { n: 0 }
          : await one(
              this.env,
              `SELECT (SELECT count(*) FROM inbox WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)))+(SELECT count(*) FROM outbox WHERE profile_id=? AND status IN ('pending','sending')${channelQueueFilter})+(SELECT count(*) FROM documents WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending')+(SELECT count(*) FROM group_operations WHERE profile_id=? AND status IN ('pending','sending'))+(SELECT count(*) FROM events WHERE profile_id=? AND id>coalesce((SELECT last_event_id FROM push_cursors WHERE profile_id=?),0)) n`,
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
      if (await this.ctx.storage.get<boolean>("modules_pending")) {
        const last = (await this.ctx.storage.get<number>("modules_tick")) || 0;
        await this.schedule(Math.max(now() + 1000, last + SCHEDULE_INTERVAL_MS));
      }
      const channelPending = await this.loadChannelWork();
      if (Object.keys(channelPending).length)
        await this.schedule(Math.max(now() + 1000, Math.min(...Object.values(channelPending))));
    }
  }
}
