import { all, one, batch } from "./db";
import { access, sha, seal, unseal, canonical } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  requireValue,
  json,
  now,
  uid,
} from "./types";
import {
  contactValues,
  contactChanges,
  parseContactCsv,
  searchText,
  type ContactValues,
} from "./contact-csv";
import { visibleConversation } from "./visibility";
import { allows, requireAccess } from "./access";
import { moduleEnabled } from "./modules/registry";
import { identityPort, installWritePort } from "./customer/ports";
import { registerCommand } from "./modules/hooks";
import { customerProfileDeclarations } from "./customer/declarations";
import { enrichLocal, maintainJobs, bindFromErp, dispatchCustomerMaintenance, jobInsert, jobView, replayJob, requestHash, writeResult, resolveCustomerJob, cancelCustomerJob, enqueueImport, importResult } from "./customer/jobs";
import { customerAccess, activeContact, contactRow, namespaceFor, phoneSafetyStatements, guardedBatch } from "./customer/local";
import { eraseContact, resolvePhone, saveCustomerSection, requireCustomerModule } from "./customer/http";
import type { CustomerWrite, Namespace, Statement } from "./customer/contracts";

export const contactNamespace = namespaceFor;
export const conversationContactNamespace = (conv: any): Namespace =>
  conv.external_namespace.startsWith("app:") ? conv.external_namespace : "team";
export function publicContact(row: any) {
  if (!row) return null;
  return {
    id: row.id, profile_id: row.profile_id, namespace: row.namespace,
    name: row.name, phone: row.phone, email: row.email, company: row.company, notes: row.notes,
    source: row.source, created_by: row.created_by, updated_by: row.updated_by,
    created: row.created, updated: row.updated, version: row.version,
    document: row.document ?? null, person_type: row.person_type ?? null,
    erp_contact_id: row.erp_contact_id ?? null, erp_version: row.erp_version ?? null,
    identityState: row.identity_state,
    ...(row.conversation_count === undefined ? {} : { conversation_count: row.conversation_count }),
  };
}
export async function getContact(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  customerAccess(actor, profile);
  const row = await contactRow(env, actor, profile, id);
  return publicContact(row)!;
}
export async function conversationContact(
  env: Env,
  actor: Actor,
  profile: string,
  conversation: string,
) {
  if (actor.kind === "app" && !actor.scopes.includes("contacts:read"))
    return null;
  return publicContact(
    await one(
      env,
      `SELECT c.* FROM conversations v LEFT JOIN conversation_contacts l ON l.conversation_id=v.id AND l.profile_id=v.profile_id LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace=CASE WHEN v.external_namespace LIKE 'app:%' THEN v.external_namespace ELSE 'team' END AND p.phone=v.verified_phone AND p.state='ready' AND v.customer_link_state='ready' JOIN contacts c ON c.id=coalesce(l.contact_id,p.contact_id) AND c.profile_id=v.profile_id WHERE v.profile_id=? AND v.id=? AND c.identity_state='active' AND (?=1 OR c.namespace=?)`,
      profile,
      conversation,
      actor.kind === "user" ? 1 : 0,
      contactNamespace(actor),
    ),
  );
}
export async function listContacts(
  env: Env,
  actor: Actor,
  profile: string,
  query: { q?: string; cursor?: string; limit?: string; namespace?: string; identity?: string; review?: string },
) {
  customerAccess(actor, profile);
  const identity = query.identity ?? "all";
  requireValue(["all", "identified", "phone_only"].includes(identity), "Filtro de identidade inválido.");
  requireValue(!query.review || query.review === "inactive180", "Filtro de revisão inválido.");
  const cursorContext = canonical({ profile, actor: actor.id, access: actor.access ?? null,
    namespace: query.namespace ?? "", identity, review: query.review ?? "", q: query.q ?? "" });
  let cut = now();
  let after: [number, string] | null = null;
  try {
    if (query.cursor) {
      const cursor = await unseal(env, atob(query.cursor));
      if (cursor.context !== cursorContext || !Number.isSafeInteger(cursor.cut)) throw Error();
      cut = cursor.cut;
      after = cursor.after;
      if (
        !Array.isArray(after) ||
        after.length !== 2 ||
        !Number.isSafeInteger(after[0]) ||
        typeof after[1] !== "string" ||
        after[1].length > 100
      )
        throw Error();
    }
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
  }
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(Number(query.limit)) || 50),
  );
  const q = searchText((query.q || "").slice(0, 200)).replace(/[!%_]/g, "!$&");
  const namespace = (query.namespace || "").slice(0, 100);
  const rows = await all(
    env,
    "SELECT c.*, (SELECT count(*) FROM conversations v LEFT JOIN conversation_contacts l ON l.conversation_id=v.id AND l.profile_id=v.profile_id LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace=c.namespace AND p.phone=v.verified_phone AND p.state='ready' AND v.customer_link_state='ready' WHERE v.profile_id=c.profile_id AND coalesce(l.contact_id,p.contact_id)=c.id) conversation_count FROM contacts c WHERE c.profile_id=? AND c.created<=? AND c.identity_state='active' AND (?='all' OR (?='identified' AND (trim(c.name)<>'' OR coalesce(c.document,'')<>'' OR c.erp_contact_id IS NOT NULL)) OR (?='phone_only' AND c.phone<>'' AND trim(c.name)='' AND coalesce(c.document,'')='' AND c.erp_contact_id IS NULL)) AND (?='' OR (c.phone<>'' AND c.email='' AND c.company='' AND trim(c.name)='' AND coalesce(c.document,'')='' AND c.erp_contact_id IS NULL AND c.created<? AND NOT EXISTS(SELECT 1 FROM agenda_appointments rel WHERE rel.profile_id=c.profile_id AND rel.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM os_orders rel WHERE rel.profile_id=c.profile_id AND rel.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM pedido_orders rel WHERE rel.profile_id=c.profile_id AND rel.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM reserva_bookings rel WHERE rel.profile_id=c.profile_id AND rel.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM mensalidade_subscriptions rel WHERE rel.profile_id=c.profile_id AND rel.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM conversation_contacts l JOIN conversations v ON v.id=l.conversation_id AND v.profile_id=l.profile_id WHERE l.profile_id=c.profile_id AND l.contact_id=c.id AND v.last_customer>=?) AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=c.profile_id AND r.contact_id=c.id AND max(r.occurred_at,coalesce((SELECT v.last_customer FROM conversations v WHERE v.profile_id=r.profile_id AND v.id=r.conversation_id AND r.module_id='conversations' AND r.kind='session' AND r.record_id=v.id||':'||v.session),0),coalesce((SELECT q.finished_at FROM queue_tickets q WHERE q.profile_id=r.profile_id AND q.id=r.record_id AND r.module_id='queue'),0))>=?) AND NOT EXISTS(SELECT 1 FROM queue_tickets q JOIN conversation_contacts l ON l.conversation_id=q.conversation_id AND l.profile_id=q.profile_id WHERE l.profile_id=c.profile_id AND l.contact_id=c.id AND max(q.created_at,coalesce(q.finished_at,0))>=?) AND NOT EXISTS(SELECT 1 FROM web_steps w LEFT JOIN conversation_contacts l ON l.conversation_id=w.conversation_id AND l.profile_id=w.profile_id WHERE w.profile_id=c.profile_id AND coalesce(w.contact_id,l.contact_id)=c.id AND coalesce(w.completed_at,w.created)>=?))) AND (?=1 OR c.namespace=?) AND (?='' OR c.namespace=?) AND c.search_text LIKE ? ESCAPE '!' AND (? IS NULL OR c.created<? OR (c.created=? AND c.id<?)) ORDER BY c.created DESC,c.id DESC LIMIT ?",
    profile,
    cut, identity, identity, identity, query.review ?? "",
    ...Array(5).fill(cut - 180 * 86400000),
    actor.kind === "user" ? 1 : 0,
    contactNamespace(actor),
    namespace,
    namespace,
    `%${q}%`,
    after?.[0] ?? null,
    after?.[0] ?? 0,
    after?.[0] ?? 0,
    after?.[1] ?? "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  const last = rows.at(-1);
  return {
    data: rows.map(publicContact),
    incomplete: !!(await one(env, "SELECT 1 pending FROM contacts c WHERE c.profile_id=? AND (?=1 OR c.namespace=?) AND (?='' OR c.namespace=?) AND c.identity_state='active' AND c.phone<>'' AND NOT EXISTS(SELECT 1 FROM customer_phone_candidates p WHERE p.profile_id=c.profile_id AND p.namespace=c.namespace AND p.contact_id=c.id) LIMIT 1", profile, actor.kind === "user" ? 1 : 0, contactNamespace(actor), namespace, namespace)),
    next_cursor:
      more && last ? btoa(await seal(env, { context: cursorContext, cut, after: [last.created, last.id] })) : null,
  };
}
export async function contactDetail(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  customerAccess(actor, profile);
  const contact = await getContact(env, actor, profile, id);
  const canReadConversations = allows(actor, "conversations") &&
    (actor.kind !== "app" || actor.scopes.includes("conversations:read"));
  const conversations =
    !canReadConversations
      ? []
      : await all(
          env,
          "SELECT c.id,c.phone,c.external_id,c.state,c.updated FROM conversations c LEFT JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id LEFT JOIN customer_phones p ON p.profile_id=c.profile_id AND p.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END AND p.phone=c.verified_phone AND p.state='ready' AND c.customer_link_state='ready' WHERE c.profile_id=? AND coalesce(l.contact_id,p.contact_id)=? AND (?=1 OR c.external_namespace=?) ORDER BY c.updated DESC,c.id DESC LIMIT 50",
          profile,
          id,
          actor.kind === "user" ? 1 : 0,
          contactNamespace(actor),
        );
  // Dono histórico prevalece. Sem proprietário persistido não há fallback
  // pela associação atual da conversa, mesmo que o telefone coincida.
  const forms = canReadConversations ? await all(env,
    `SELECT w.id,w.conversation_id,w.module_id,w.kind,w.status,w.created,w.completed_at,w.updated,w.result
     FROM web_steps w WHERE w.profile_id=? AND w.status='completed'
       AND coalesce(w.contact_id,(SELECT r.contact_id FROM customer_records r
         WHERE r.profile_id=w.profile_id AND r.module_id=w.module_id AND r.kind=w.kind AND r.record_id=w.id))=?
       AND EXISTS(SELECT 1 FROM conversations c WHERE c.profile_id=w.profile_id AND c.id=w.conversation_id
         AND (?=1 OR c.external_namespace=?)) ORDER BY w.completed_at DESC,w.id DESC LIMIT 50`,
    profile, id, actor.kind === "user" ? 1 : 0, contactNamespace(actor)) : [];
  const allowedModules = new Set<string>();
  for (const module of new Set<string>(forms.map(row => row.module_id))) {
    if (["saude", "ensino", "juridico"].includes(module)) continue;
    if (allows(actor, module) && await moduleEnabled(env, profile, module)) allowedModules.add(module);
  }
  // O detalhe publicado conserva as respostas para quem pode ler a conversa
  // e o módulo. Histórico e listas da ficha única usam a projeção administrativa
  // de customer/history, que continua sem respostas ou campos do formulário.
  const answers = forms.filter(row => allowedModules.has(row.module_id))
    .map(({ result, ...row }) => ({ ...row, answers: result ? json(result, null) : null }));
  const identity = contact.phone ? await one(env, "SELECT state,contact_id FROM customer_phones WHERE profile_id=? AND namespace=? AND phone=?", profile, contact.namespace, contact.phone) : null;
  const linkState = identity?.state === "ambiguous" ? "ambiguous" : identity?.state === "ready" && identity.contact_id === id ? "ready" : "pending";
  const synchronization = await one(env, "SELECT id,state,error_code FROM customer_jobs WHERE profile_id=? AND contact_id=? ORDER BY created DESC,id DESC LIMIT 1", profile, id);
  return { contact, conversations, web_steps: answers,
    reference: { profileId: profile, namespace: contact.namespace, contactId: id, version: contact.version,
      state: linkState, verifiedPhone: null, erp: contact.erp_contact_id ? { id: contact.erp_contact_id, version: contact.erp_version } : null },
    state: contact.identityState,
    synchronization: synchronization ? { jobId: synchronization.id, state: synchronization.state, errorCode: synchronization.error_code,
      pending: !["done", "retained", "cancelled"].includes(synchronization.state) } : null,
  };
}
function insertContact(
  actor: Actor,
  profile: string,
  namespace: string,
  values: ContactValues,
  source: string,
  fingerprint: string | null = null,
): { id: string; statement: [string, any[]] } {
  const id = uid(),
    time = now();
  return {
    id,
    statement: [
      "INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,import_fingerprint,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        profile,
        namespace,
        values.name,
        values.phone,
        values.email,
        values.company,
        values.notes,
        searchText(
          [values.name, values.phone, values.email, values.company].join(" "),
        ),
        source,
        fingerprint,
        actor.id,
        actor.id,
        time,
        time,
      ],
    ],
  };
}
async function importPlan(
  env: Env,
  actor: Actor,
  profile: string,
  csv: unknown,
  phoneMode: "international" | "human_br" = "international",
) {
  requireValue(phoneMode === "international" || phoneMode === "human_br", "Convenção de telefone inválida.");
  const parsed = parseContactCsv(csv, { phoneMode });
  const hashed = await Promise.all(
    parsed.rows.map(async (row) => ({
      ...row,
      fingerprint: await sha(JSON.stringify(row.values)),
    })),
  );
  const existing = new Set(
    (
      await all(
        env,
        "SELECT import_fingerprint FROM contacts WHERE profile_id=? AND namespace=? AND import_fingerprint IN (SELECT value FROM json_each(?))",
        profile,
        contactNamespace(actor),
        JSON.stringify(hashed.map((r) => r.fingerprint)),
      )
    ).map((r) => r.import_fingerprint),
  );
  const rows = hashed.map((row) => {
    const duplicate = existing.has(row.fingerprint);
    existing.add(row.fingerprint);
    return { ...row, duplicate };
  });
  return {
    ...parsed,
    rows,
    new_count: rows.filter((r) => !r.duplicate).length,
    skipped_count: rows.filter((r) => r.duplicate).length,
  };
}
export async function previewContactCsv(
  env: Env,
  actor: Actor,
  profile: string,
  csv: unknown,
  phoneMode: "international" | "human_br" = "international",
) {
  customerAccess(actor, profile, true);
  const plan = await importPlan(env, actor, profile, csv, phoneMode);
  return { ...plan, rows: plan.rows.map(({ fingerprint, ...row }) => row) };
}
export async function contactCommand(
  env: Env,
  actor: Actor,
  profile: string,
  operation: string,
  data: any,
  commandId: string = uid(),
) {
  if (operation === "contact.section") return saveCustomerSection(env, actor, profile, data, commandId);
  if (operation === "contact.from-erp") {
    await requireCustomerModule(env, actor, profile, "erp");
    return bindFromErp(env, actor, profile, data.erpId, commandId);
  }
  customerAccess(actor, profile, true);
  if (operation === "contact.promote") {
    await requireCustomerModule(env, actor, profile, "erp");
    return enrichLocal(env, actor, profile, data.id, { ...data, commandId }, "promote");
  }
  if (operation === "contact.job-cancel") return cancelCustomerJob(env, actor, profile, data.id, data, commandId);
  if (operation === "contact.resolve-phone") return resolvePhone(env, actor, profile, data, commandId);
  if (operation === "contact.resolve-job") return resolveCustomerJob(env, actor, profile, data.id, data, commandId);
  if (operation === "contact.erasure") return eraseContact(env, actor, profile, data.id, data, commandId);
  const legacyHash = await requestHash(actor, { operation, data });
  if (["contact.create", "contact.import", "contact.from-conversation", "contact.unlink"].includes(operation)) {
    const replay = await replayJob(env, profile, commandId, legacyHash);
    if (replay) {
      if (operation === "contact.import") return importResult(env, replay);
      const result = await unseal(env, replay.result_cipher);
      return result.contactId ? getContact(env, actor, profile, result.contactId) : result;
    }
  }
  const commitLocal = async (statements: Statement[], contactId: string | null, namespace: Namespace, result: unknown) => {
    const receipt = jobInsert(profile, namespace, contactId, "enrich", commandId, legacyHash, await seal(env, { operation }), null, null);
    await guardedBatch(env, [...statements, receipt.statement,
      ["UPDATE customer_jobs SET state='done',payload_cipher=NULL,result_cipher=?,cursor_json=? WHERE profile_id=? AND id=?",
        [await seal(env, result), JSON.stringify({ receipt: operation }), profile, receipt.id]],
    ]);
  };
  if (operation === "contact.create") {
    const row = insertContact(
      actor,
      profile,
      contactNamespace(actor),
      contactValues(data),
      "manual",
    );
    await commitLocal([...phoneSafetyStatements(profile, contactNamespace(actor), contactValues(data).phone ? [contactValues(data).phone] : [], commandId), row.statement, ...await identityPort.indexContact(env, {
      profileId: profile, namespace: contactNamespace(actor), contactId: row.id,
      phones: contactValues(data).phone ? [contactValues(data).phone] : [], origin: "local",
    })], row.id, contactNamespace(actor), { contactId: row.id });
    return getContact(env, actor, profile, row.id);
  }
  if (operation === "contact.update") {
    const replay = await replayJob(env, profile, commandId, legacyHash);
    if (replay) return { ...await getContact(env, actor, profile, data.id), result: await writeResult(env, replay) };
    const old = await contactRow(env, actor, profile, data.id, true);
    activeContact(old);
    const values = { ...old, ...contactChanges(data, old.source === "automatic", old.phone) };
    const patch: CustomerWrite["patch"] = {};
    if ("name" in data) patch.name = values.name;
    if ("phone" in data) patch.phones = values.phone ? [values.phone] : [];
    if ("email" in data) patch.email = values.email;
    if ("document" in data) patch.document = data.document;
    const input: CustomerWrite = data.customer ? { ...data.customer, commandId } : {
      commandId, expectedVersion: data.expected_version, expectedErpVersion: old.erp_version,
      patch, mode: "replace_confirmed",
    };
    if (data.customer && ["name", "phone", "email", "document"].some(k => k in data))
      throw new ApiError(400, "invalid_request", "Envie os campos cadastrais em customer.patch.");
    const local = "company" in data || "notes" in data ? { ...("company" in data ? { company: values.company } : {}), ...("notes" in data ? { notes: values.notes } : {}) } : undefined;
    const result = await enrichLocal(env, actor, profile, old.id, input, "enrich", local, !data.customer, { operation, data });
    return { ...await getContact(env, actor, profile, old.id), result };
  }
  if (operation === "contact.import") {
    const plan = await importPlan(env, actor, profile, data.csv, data.phone_mode);
    if (plan.errors.length)
      throw new ApiError(
        400,
        "invalid_csv",
        `Nenhum contato foi importado. Corrija ${plan.errors.length} linha(s): linha ${plan.errors[0].line}, ${plan.errors[0].message}`,
      );
    return enqueueImport(env, actor, profile, contactNamespace(actor), commandId, legacyHash,
      plan.rows.filter(row => !row.duplicate), plan.skipped_count, plan.total);
  }
  if (["contact.from-conversation", "contact.unlink"].includes(operation)) {
    access(actor, profile, "conversations:read");
    requireAccess(actor, "conversations");
    const conv = await one(
      env,
      "SELECT * FROM conversations WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    if (
      !conv ||
      !visibleConversation(actor, conv) ||
      (actor.kind === "app" &&
        conv.external_namespace !== contactNamespace(actor))
    )
      throw new ApiError(404, "not_found", "Conversa não encontrada.");
    requireValue(
      conv.chat_type !== "group",
      "Um grupo não pode ser salvo como uma pessoa na agenda.",
    );
    const linked = await one(
      env,
      "SELECT contact_id FROM conversation_contacts WHERE conversation_id=? AND profile_id=?",
      conv.id,
      profile,
    );
    if (operation === "contact.unlink") {
      const currentContact = linked?.contact_id ?? (conv.customer_link_state === "ready" ? (await identityPort.resolve(env, conv)).contactId : null);
      requireValue(
        typeof data.expected_contact_id === "string" &&
          data.expected_contact_id.length > 0,
        "Informe o contato que deseja desvincular.",
      );
      if (currentContact && currentContact !== data.expected_contact_id)
        throw new ApiError(
          409,
          "contact_conflict",
          "O contato desta conversa mudou. Reabra a conversa antes de desvincular.",
        );
      await commitLocal([
        ["DELETE FROM conversation_contacts WHERE conversation_id=? AND profile_id=?", [conv.id, profile]],
        ["UPDATE conversations SET customer_link_state='blocked' WHERE id=? AND profile_id=?", [conv.id, profile]],
      ], currentContact ?? null, conversationContactNamespace(conv), { id: conv.id, unlinked: true });
      return { id: conv.id, unlinked: true };
    }
    if (linked) {
      if (data.contact_id === linked.contact_id)
        return getContact(env, actor, profile, linked.contact_id);
      throw new ApiError(
        409,
        "contact_already_linked",
        "A conversa já tem um contato. Reabra a conversa para editar ou desvincular.",
      );
    }
    const namespace = conversationContactNamespace(conv);
    let id: string;
    const statements: [string, any[]][] = [];
    if (data.contact_id) {
      requireValue(typeof data.contact_id === "string", "Informe o contato.");
      const chosen = await getContact(env, actor, profile, data.contact_id);
      if (chosen.namespace !== namespace)
        throw new ApiError(
          409,
          "namespace_conflict",
          "Escolha um contato desta equipe ou desta mesma integração.",
        );
      id = chosen.id;
    } else {
      const automatic = conv.customer_link_state === "ready" && namespace === "team" ? await one(env,
        `SELECT c.* FROM customer_phones p JOIN contacts c ON c.id=p.contact_id AND c.profile_id=p.profile_id AND c.namespace=p.namespace
         WHERE p.profile_id=? AND p.namespace='team' AND p.phone=? AND p.state='ready' AND c.identity_state='active' AND c.source='automatic'`,
        profile, conv.verified_phone) : null;
      if (automatic) {
        // A ficha telefônica já existe. Associá-la conserva seu histórico; os
        // dados seguem pelo comando cadastral, inclusive pela ponte quando ligada.
        id = automatic.id;
        const values = contactValues(data);
        const enrichmentId = `${commandId}:details`;
        const previous = await one(env, "SELECT expected_version,expected_erp_version FROM customer_jobs WHERE profile_id=? AND command_id=?", profile, enrichmentId);
        await enrichLocal(env, actor, profile, id, {
          commandId: enrichmentId, expectedVersion: previous?.expected_version ?? automatic.version,
          expectedErpVersion: previous ? previous.expected_erp_version : automatic.erp_version,
          mode: "fill_empty", patch: { name: values.name, ...(values.phone ? { phones: [values.phone] } : {}), ...(values.email ? { email: values.email } : {}) },
        }, "enrich", { company: values.company, notes: values.notes });
      } else {
        const row = insertContact(
          actor,
          profile,
          namespace,
          contactValues(data),
          "conversation",
        );
        id = row.id;
        statements.push(...phoneSafetyStatements(profile, namespace, contactValues(data).phone ? [contactValues(data).phone] : [], commandId), row.statement, ...await identityPort.indexContact(env, {
          profileId: profile, namespace, contactId: row.id,
          phones: contactValues(data).phone ? [contactValues(data).phone] : [], origin: "local",
        }));
      }
    }
    statements.push([
      "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      [conv.id, profile, id, actor.id, now()],
    ]);
    statements.push(["UPDATE conversations SET customer_link_state='pending' WHERE id=? AND profile_id=?", [conv.id, profile]]);
    await commitLocal(statements, id, namespace, { contactId: id });
    return getContact(env, actor, profile, id);
  }
  throw new ApiError(400, "unknown_operation", "Operação de contato inválida.");
}

// O registro recebe o operationId estável de perform, nunca o X-Request-Id.
installWritePort({ enrich: enrichLocal, maintain: maintainJobs }, { default: true });
for (const operation of ["contact.create", "contact.update", "contact.import", "contact.from-conversation", "contact.unlink", "contact.promote", "contact.from-erp", "contact.resolve-phone", "contact.resolve-job", "contact.job-cancel", "contact.erasure", "contact.section"])
  registerCommand(operation, (env, actor, profile, data, operationId) => contactCommand(env, actor, profile, operation, data, operationId));
for (const moduleId of Object.keys(customerProfileDeclarations))
  registerCommand(`${moduleId}.customer-section`, (env, actor, profile, data, operationId) =>
    saveCustomerSection(env, actor, profile, { ...data, module: moduleId }, operationId));
registerCommand("contact.maintain", async (env, actor, profile) => {
  if (actor.kind !== "connector" || actor.id !== "customer-maintenance")
    throw new ApiError(403, "forbidden", "Manutenção interna.");
  // Dez instruções reservadas à abertura/fechamento do comando no Coordinator.
  return dispatchCustomerMaintenance(env, profile);
});

/** Recupera intenção já gravada quando o recibo externo ficou sem resposta. */
export async function recoverContactCommand(env: Env, actor: Actor, profile: string, operation: string, key: string) {
  customerAccess(actor, profile, operation !== "contact.erasure" && operation !== "contact.from-erp", operation === "contact.from-erp" ? "erp" : "contacts");
  const commandId = (await sha(`${actor.id}:${profile}:${operation}\n${key}`)).slice(0, 32);
  if (operation === "contact.job-cancel") {
    const cancelled = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND json_extract(cursor_json,'$.cancel.command')=?", profile, commandId);
    return cancelled ? jobView(cancelled) : null;
  }
  const job = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=? AND (?=1 OR namespace=?)", profile, commandId, actor.kind === "user" ? 1 : 0, contactNamespace(actor));
  if (!job) return null;
  if (operation === "contact.import") return importResult(env, job);
  if (operation === "contact.erasure") {
    if (actor.kind !== "user" || actor.role !== "admin" || actor.via) throw new ApiError(403, "forbidden", "A exclusão exige um administrador.");
    return jobView(job);
  }
  const receipt = JSON.parse(job.cursor_json || "{}").receipt;
  if (receipt || operation === "contact.resolve-phone") {
    const result = await unseal(env, job.result_cipher);
    return receipt && result.contactId ? getContact(env, actor, profile, result.contactId) : result;
  }
  const result = await writeResult(env, job);
  return operation === "contact.update" ? { ...await getContact(env, actor, profile, job.contact_id), result } : result;
}
