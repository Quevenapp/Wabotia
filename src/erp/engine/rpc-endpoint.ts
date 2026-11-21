import { ERP_PARTS_REFERENCE_HEADER, readErpPartsReference, type ErpPartsReference } from "../parts.ts";
import { applyErpPartsSnapshot, requireCurrentErpParts, ErpPartsControlError } from "../parts-control.ts";
import { ERP_PARTS_DENIED_HEADER, ERP_MAINTENANCE_HEADER, COM1_EVIDENCE_RPCS, ErpPartDisabled, requireRpcParts, readErpMaintenance, withErpMaintenance } from "./parts-gate.ts";
// /erp-rpc/<nome> dentro do objeto erp:<área>: o lado de dentro da costura.
// O corpo é o mesmo JSON que o PostgREST receberia ({p_user_id, …}); a
// resposta é o JSON da função, ou {code, message} com 400 (como o PostgREST
// devolve um raise exception), que o upstream() da erp-api já traduz.
import "../domains/index.ts";
import { storageDriver, type SqlDriver } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { prepareArgs } from "./args.ts";
import { ErpGateDenied, callRpc, inTransaction, isPorted, rpcObjectKeys, rpcWakes, rpcWantsListing, type StoredListing, type StoredObject } from "./registry.ts";
import { CUSTOMER_BRIDGE_FIELDS, CUSTOMER_BRIDGE_SCAN, CUSTOMER_BRIDGE_USER_ID, GATE_DENIED_HEADER, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, decodeIdentity, containsRestrictedContact, customerPrivacyUnsupported } from "./identity.ts";
import { SIGNATURES } from "./signatures.generated.ts";
import { ENGINE_SIGNATURES } from "./signatures-engine.ts";
import { MODULE_RPCS, verifyModuleTransport } from "./module-origin.ts";
import { requestModuleState } from "./module-state.ts";
import { COM1_AUTHORITY_HEADER, com1ActionForRpc, com1ExecutionActor, readCom1Authority, runWithCom1Authority, type Com1Authority } from "../domains/fiscal/comnfe/access.ts";
import { COM1_CONNECTION_HEADER, readCommercialConnectionCheck, runWithCommercialConnection } from "../domains/fiscal/comnfe/settings.ts";

// SYSTEM_RPCS e COM1_INTERNAL_RPCS: inventário em system-rpcs.ts (sem
// dependências), compartilhado com a costura da erp-api.
import { SYSTEM_RPCS, COM1_INTERNAL_RPCS } from "./system-rpcs.ts";
import { backupFence, ErpBackupFencedError, fencedResponse, fencedWrite } from "./backup-state.ts";
export { SYSTEM_RPCS, COM1_INTERNAL_RPCS };
import { Clock } from "./time.ts";

const clocks = new WeakMap<DurableObjectState, Clock>();

const mirrorRecord = (record: Record<string, unknown>) => Object.fromEntries(
  ["id", "version", "name", "phone", "mobile", "email", "document", "person_type"].map((key) => [key, record[key]]),
);
/** O executor técnico não recebe classificações, observações ou ficha ampliada. */
function bridgeResponse(name: string, value: unknown): unknown {
  const result = value as Record<string, any>;
  if (name === "erp_catalog_contact_get" || name === "erp_catalog_contact_save")
    return { entity: "contacts", record: mirrorRecord(result.record), replayed: result.replayed === true };
  if (name === "erp_catalog_contact_page")
    return { items: result.items.map(mirrorRecord), total: result.total };
  return { warnings: result.warnings.map((warning: Record<string, any>) => ({
    code: warning.code, total: warning.total, blocked: warning.blocked,
    matches: warning.matches?.map((match: Record<string, unknown>) => ({ id: match.id })),
  })) };
}

/** O relógio monotônico do objeto, o mesmo para os RPCs e o agendador (src/erp/scheduler/). */
export function engineClock(ctx: DurableObjectState): Clock {
  let clock = clocks.get(ctx);
  if (!clock) clocks.set(ctx, (clock = new Clock()));
  return clock;
}

/** Chave no R2 de um objeto do ERP ("bucket/nome" do Supabase), por área. */
export const erpObjectKey = (profile: string, key: string) => `erp-storage/${profile}/${key}`;

/**
 * O que o RPC lê do armazenamento, do R2, antes da transação (que é
 * síncrona): os objetos que ele declarou em registerRpc(…, { objects }) e,
 * com { listing: true }, todos os objetos da área. Usado pela rota /erp-rpc e
 * pelo agendador (src/erp/scheduler/files.ts).
 */
export async function rpcStorage(
  profile: string,
  name: string,
  args: Record<string, unknown>,
  media?: R2Bucket,
  db?: SqlDriver,
): Promise<{ objects: (key: string) => StoredObject | null; listing: StoredListing[] }> {
  const found = new Map<string, StoredObject>();
  for (const key of rpcObjectKeys(name, args, db)) {
    const head = media ? await media.head(erpObjectKey(profile, key)) : null;
    if (head) found.set(key, { size: head.size, mimetype: head.httpMetadata?.contentType ?? "" });
  }
  // Todos os objetos da área, para quem soma o armazenamento (erp_access_storage).
  const listing: StoredListing[] = [];
  if (media && rpcWantsListing(name)) {
    const prefix = erpObjectKey(profile, "");
    let cursor: string | undefined;
    do {
      const page = await media.list({ prefix, cursor });
      for (const o of page.objects) {
        const [bucket, ...rest] = o.key.slice(prefix.length).split("/");
        // Partes temporárias de um envio em andamento (src/erp-storage.ts,
        // <bucket>/.upload/<id>/<n>): no Supabase não aparecem em storage.objects.
        if (rest[0] === ".upload") continue;
        if (bucket && rest.length) listing.push({ bucket, name: rest.join("/"), size: o.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return { objects: (k) => found.get(k) ?? null, listing };
}

/** Em quanto tempo o agendador acorda depois de um RPC com { wake: true }. */
export const RPC_WAKE_MS = 1_000;

/** Antecipa o alarme do objeto para daqui a RPC_WAKE_MS; nunca adia um alarme mais cedo. */
export async function wakeSoon(ctx: DurableObjectState) {
  const at = Date.now() + RPC_WAKE_MS;
  const current = await ctx.storage.getAlarm();
  if (current === null || current > at) await ctx.storage.setAlarm(at);
}

export async function handleRpc(
  ctx: DurableObjectState,
  profile: string,
  name: string,
  request: Request,
  media?: R2Bucket,
  d1?: D1Database,
): Promise<Response> {
  const moduleRpc = MODULE_RPCS.includes(name as any);
  // Nome fora do registro e fora do oráculo: erro claro, como o PGRST202 do
  // PostgREST (função que o oráculo tem e o motor ainda não portou continua
  // 0A000 visível, pelo callRpc).
  if (name !== CUSTOMER_BRIDGE_SCAN && !isPorted(name) && !(name in SIGNATURES) && !(name in ENGINE_SIGNATURES))
    return Response.json({ code: "PGRST202", message: `erp_rpc_unknown:${name}`, details: null, hint: null }, { status: 404 });
  if ((SYSTEM_RPCS.has(name) || moduleRpc || COM1_INTERNAL_RPCS.has(name)) && request.headers.get(SYSTEM_HEADER) !== "1")
    return Response.json({ code: "42501", message: "erp_rpc_system_only", details: null, hint: null }, { status: 403 });
  let args: unknown;
  try {
    args = await request.json();
  } catch {
    args = null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return Response.json({ code: "22023", message: "erp_rpc_body_invalid" }, { status: 400 });
  const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
  const a = args as Record<string, unknown>;
  const connectionHeader = request.headers.get(COM1_CONNECTION_HEADER);
  let commercialConnection: ReturnType<typeof readCommercialConnectionCheck>;
  if (connectionHeader !== null) {
    if (name !== "erp_com1_config_save" || request.headers.get(SYSTEM_HEADER) !== "1")
      return Response.json({ code: "42501", message: "com1_connection_internal_only" }, { status: 403 });
    try { commercialConnection = readCommercialConnectionCheck(JSON.parse(connectionHeader)); } catch { /* Recusa abaixo. */ }
    if (commercialConnection === undefined)
      return Response.json({ code: "22023", message: "com1_connection_invalid" }, { status: 400 });
  }
  const authorityHeader = request.headers.get(COM1_AUTHORITY_HEADER);
  let com1Authority: Com1Authority | undefined;
  if (authorityHeader !== null) {
    if (!name.startsWith("erp_com1_") || request.headers.get(SYSTEM_HEADER) !== "1")
      return Response.json({ code: "42501", message: "com1_authority_internal_only" }, { status: 403 });
    try { com1Authority = readCom1Authority(JSON.parse(authorityHeader)) ?? undefined; } catch { /* Recusa abaixo. */ }
    if (!com1Authority)
      return Response.json({ code: "42501", message: "com1_authority_invalid" }, { status: 403 });
    const actor = identity.actor, action = com1ActionForRpc(name, a.p_input);
    if (actor && action) {
      // SYSTEM_HEADER e o inventário acima limitam a normalização à fatia.
      // O portão continua conferindo horário/MFA e o motor revalida o papel.
      try { identity.actor = com1ExecutionActor(actor, action, com1Authority); }
      catch (error) {
        return Response.json({ code: "42501", message: error instanceof ErpError ? error.message : "fiscal_forbidden" }, { status: 403 });
      }
    }
  }

  const restricted = new Set(identity.customer_privacy?.restricted_contact_ids ?? []);
  const privacyDenied = () => Response.json({ code: "42501", message: "erp_customer_restricted" }, { status: 403 });
  const references = name === CUSTOMER_BRIDGE_SCAN ? { ...a, p_after: null } : a;
  if (containsRestrictedContact(references, restricted) || (restricted.size && customerPrivacyUnsupported(name, a))) return privacyDenied();
  const bridge = identity.actor?.user_id === CUSTOMER_BRIDGE_USER_ID;
  const denied = () => Response.json({ code: "42501", message: "erp_customer_bridge_scope" }, { status: 403 });
  if (bridge) {
    if (!identity.actor?.is_agent || identity.actor.erp_role !== "vendas" || identity.actor.session_id !== null ||
        identity.actor.aal !== "aal1" || identity.actor.verified_factor ||
        a.p_user_id !== CUSTOMER_BRIDGE_USER_ID || request.headers.get(GATE_HEADER) !== "1") return denied();
    if (![CUSTOMER_BRIDGE_SCAN, "erp_catalog_contact_get", "erp_catalog_contact_page",
      "erp_catalog_contact_check", "erp_catalog_contact_save"].includes(name)) return denied();
    if (name.endsWith("_save") || name.endsWith("_check")) {
      const data = a.p_data;
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) =>
        !CUSTOMER_BRIDGE_FIELDS.includes(key) && !(key === "roles" && a.p_id === null &&
          JSON.stringify((data as Record<string, unknown>).roles) === '["customer"]'))) return denied();
      if (name.endsWith("_save") && JSON.stringify(a.p_acknowledged) !== "[]") return denied();
    }
  }
  if (name === CUSTOMER_BRIDGE_SCAN && !bridge) return denied();
  const clock = engineClock(ctx);
  try {
    if (moduleRpc && request.headers.get(GATE_HEADER) !== "1")
      return Response.json({ code: "42501", message: "module_origin_denied" }, { status: 403 });
    let moduleProof = moduleRpc ? await verifyModuleTransport(d1, profile, name, a, identity) : undefined;
    if (["parts", "partsControl", "maintenance", "bypass"].some(key => Object.hasOwn(a, key)))
      return Response.json({ code: "22023", message: "erp_rpc_body_invalid" }, { status: 400 });
    if (COM1_EVIDENCE_RPCS.has(name)) {
      // SYSTEM_HEADER já foi conferido. requireRpcParts e o registro exigem
      // emissão, comando e token persistidos. Nenhuma identidade ou parte da
      // chamada externa autoriza outro envio ou efeito neste commit estreito.
      // Não reabrir o portão: a pessoa pode ter perdido acesso durante o I/O.
      // Barreira do backup: a evidência espera (a mesma emissão é retomada depois).
      const result = fencedWrite(ctx.storage, backupFence(ctx.storage), () => callRpc(storageDriver(ctx.storage), name, a, clock, {
        identity: { actor: null, people: null },
        parts: { customers: false, products: false, sales: false, purchases: false,
          stock: false, finance: false, fiscal: false, billing: false, pos: false, shipping: false },
      }));
      if (containsRestrictedContact(result, restricted)) return privacyDenied();
      return Response.json(result);
    }
    const input = { ...identity.partsControl, parts: identity.parts };
    await applyErpPartsSnapshot(ctx.storage, profile, input);
    const snapshot = await requireCurrentErpParts(ctx.storage, profile, input);
    const maintenanceHeader = request.headers.get(ERP_MAINTENANCE_HEADER);
    let maintenance = null;
    if (maintenanceHeader) {
      try { maintenance = readErpMaintenance(JSON.parse(maintenanceHeader)); } catch { /* Envelope interno malformado: recusa abaixo. */ }
    }
    if (maintenanceHeader && (!maintenance || request.headers.get(SYSTEM_HEADER) !== "1" || bridge))
      return Response.json({ code: "42501", message: "erp_maintenance_scope_denied" }, { status: 403 });
    const referenceHeader = request.headers.get(ERP_PARTS_REFERENCE_HEADER);
    let partsReference: ErpPartsReference | undefined;
    if (referenceHeader) {
      try { partsReference = readErpPartsReference(JSON.parse(referenceHeader)) ?? undefined; } catch { /* Recusa abaixo. */ }
      if (!partsReference || request.headers.get(SYSTEM_HEADER) !== "1" || bridge)
        return Response.json({ code: "22023", message: "erp_parts_reference_invalid" }, { status: 400 });
    }
    const preflightName = name === CUSTOMER_BRIDGE_SCAN ? "erp_catalog_contact_page" : name;
    if (!moduleRpc) inTransaction(storageDriver(ctx.storage), context => {
      const prepared = prepareArgs(preflightName, name === CUSTOMER_BRIDGE_SCAN ? { p_user_id: a.p_user_id } : a);
      const check = () => requireRpcParts(context, preflightName, prepared);
      if (maintenance) withErpMaintenance(context, maintenance, check); else check();
    }, clock, { identity, parts: snapshot.parts, partsReference });
    const storage = await rpcStorage(profile, name, a, media, storageDriver(ctx.storage));
    // O R2 cede a vez: uma entrega mais nova pode ter chegado nesse intervalo.
    await requireCurrentErpParts(ctx.storage, profile, input);

    if (name === CUSTOMER_BRIDGE_SCAN) {
      // Só leitura por ID, sem novo esquema, registro de domínio ou D1 no objeto.
      const after = a.p_after ?? "";
      const limit = a.p_limit;
      if (typeof after !== "string" || (after !== "" && !/^[0-9a-f-]{36}$/.test(after)) ||
          !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20)
        return Response.json({ code: "22023", message: "invalid_cursor" }, { status: 400 });
      const db = storageDriver(ctx.storage);
      const fence = backupFence(ctx.storage);
      const call = (rpc: string, input: Record<string, unknown>) => fencedWrite(ctx.storage, fence, () => callRpc(db, rpc,
        { ...input, p_user_id: a.p_user_id }, clock, { identity, parts: snapshot.parts, gate: true }));
      const rows = db.exec("SELECT id FROM erp_catalog__record WHERE entity='contacts' AND id>? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?",
        after, JSON.stringify([...restricted]), Number(limit) + 1).rows;
      // Cada GET aplica autorização/portão antes de devolver qualquer dado.
      // Na página vazia também precisa conferir o acesso. Evita executar a
      // listagem (que filtra toda a base) a cada página da varredura por ID.
      if (!rows.length) call("erp_catalog_contact_page", { p_page: 1, p_size: 1, p_sort: "created_desc", p_situation: "all" });
      const items = rows.slice(0, Number(limit)).map(({ id }) => {
        const result = call("erp_catalog_contact_get", { p_id: id }) as { record: Record<string, unknown> };
        const record = result.record;
        return mirrorRecord(record);
      });
      return Response.json({ items, nextCursor: rows.length > Number(limit) ? String(items.at(-1)!.id) : null });
    }
    const workEnabled = d1 && !moduleRpc && (a.p_kind === "service_orders" || name.includes("convert_to_service"))
      ? (await d1.prepare("SELECT enabled FROM profile_modules WHERE profile_id=? AND module_id='os'").bind(profile).first<{ enabled: number }>())?.enabled === 1 : false;
    // Revalidar depois de qualquer I/O; o motor segue síncrono até o commit.
    if (moduleRpc) moduleProof = await verifyModuleTransport(d1, profile, name, a, identity);
    const currentParts = await requireCurrentErpParts(ctx.storage, profile, input);
    // invoke roda logo abaixo, sem espera no meio: a revalidação acima continua valendo.
    const invoke = () => callRpc(storageDriver(ctx.storage, profile), name, args as Record<string, unknown>, clock, {
      ...storage,
      identity,
      moduleProof,
      workEnabled,
      parts: currentParts.parts,
      partsReference,
      maintenance: maintenance ?? undefined,
      modules: requestModuleState(request.headers, request.headers.get(SYSTEM_HEADER) === "1"),
      gate: request.headers.get(GATE_HEADER) === "1",
    });
    const withConnection = () => runWithCommercialConnection(commercialConnection ?? null, invoke);
    // Backup ou restauração em andamento: leitura passa; escrita é desfeita e
    // volta 503 com código próprio (engine/backup-state.ts).
    const fence = backupFence(ctx.storage);
    const result = fencedWrite(ctx.storage, fence, () => com1Authority ? runWithCom1Authority(com1Authority, withConnection) : withConnection());
    // Recibos podem anteceder a restrição e não passam novamente pelo DTO.
    if (containsRestrictedContact(result, restricted)) return privacyDenied();
    // RPC que cria tarefa da plataforma (exportação pedida no painel): o
    // agendador acorda em 1 s, sem esperar a próxima acordada (até 1 h).
    if (rpcWakes(name)) await wakeSoon(ctx);
    return Response.json(bridge ? bridgeResponse(name, result) : result);
  } catch (error) {
    if (error instanceof ErpBackupFencedError) return fencedResponse(error);
    if (error instanceof ErpPartDisabled || error instanceof ErpPartsControlError) {
      const status = error instanceof ErpPartDisabled ? 409 : error.status;
      return Response.json({ code: error.code, message: error.message, error: { code: error.code, message: error.message } },
        { status, headers: { [ERP_PARTS_DENIED_HEADER]: error.code } });
    }
    // Portão fechado: o RPC não rodou; a costura devolve o erro do Fagoo.
    if (error instanceof ErpGateDenied)
      return Response.json(
        { code: error.code, message: error.message, details: null, hint: null },
        { status: 403, headers: { [GATE_DENIED_HEADER]: error.reason } },
      );
    if (error instanceof ErpError) {
      // Os RPCs humanos mantêm HTTP 400: upstream() traduz o código SQL.
      // Só a integração usa diretamente 403/409 para autorização e repetição.
      let status = error.code === "erp_route_removed" ? 404 : error.code === "0A000" ? 501 : 400;
      if (moduleRpc && error.code === "42501") status = 403;
      if (error.code === "work_required" || moduleRpc && ["40001", "epoch_closed", "part_disabled"].includes(error.code)) status = 409;
      return Response.json(
        { code: error.code, message: moduleRpc && !/^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? "module_request_invalid" : error.message, details: null, hint: null },
        { status: name.startsWith("erp_com1_") && error.code === "42501" ? 403 : status },
      );
    }
    throw error;
  }
}
