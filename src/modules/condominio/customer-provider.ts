import { z } from "zod";
import { all, batch, one } from "../../db";
import { canonical, seal, sha, unseal } from "../../security";
import { requireAccess } from "../../access";
import { now, type Actor } from "../../types";
import type { Statement } from "../../customer/contracts";
import type { CustomerModuleProvider, Json, SectionView, SectionWrite } from "../../customer/profile-contracts";
import { modulesApi, type ModuleContext } from "../api";
import { fail, id, instant, parse, publicPerson, staff } from "./common";

const functionRole = z.enum(["sindico", "zelador", "porteiro", "prestador", "visitante_recorrente"]);
const period = { startsAt: instant, endsAt: instant.nullable() };
// Listas são operações de inclusão/alteração por ID, nunca substituições integrais.
// IDs existentes, pessoa e unidade de cada vínculo não podem ser reapontados.
const changesSchema = z.object({
  memberships: z.array(z.object({
    id, personId: id, unitId: id,
    role: z.enum(["proprietario", "inquilino", "empregado_unidade"]),
    ...period, notices: z.boolean(),
  }).strict()).max(10).default([]),
  functions: z.array(z.object({
    id, personId: id, unitId: id.nullable(), role: functionRole,
    ...period, expectedVersion: z.number().int().nonnegative(),
  }).strict()).max(10).default([]),
  subscriptions: z.array(z.object({
    unitId: id, subscriptionId: id, linked: z.boolean(),
  }).strict()).max(10).default([]),
}).strict();

type Membership = { id: string; personId: string; unitId: string; role: string; startsAt: number; endsAt: number | null; notices: number | boolean; block: string; number: string };
type FunctionRow = { id: string; personId: string; unitId: string | null; role: string; startsAt: number; endsAt: number | null; version: number };
type Subscription = { unitId: string; subscriptionId: string };
type Snapshot = { people: { id: string }[]; memberships: Membership[]; functions: FunctionRow[]; subscriptions: Subscription[] };
const labels: Record<string, string> = {
  morador: "Morador", proprietario: "Proprietário", inquilino: "Inquilino",
  empregado_unidade: "Empregado de unidade", sindico: "Síndico", zelador: "Zelador",
  porteiro: "Porteiro", prestador: "Prestador", visitante_recorrente: "Visitante recorrente",
};
const current = (row: { startsAt: number; endsAt: number | null }, at: number) =>
  row.startsAt <= at && (row.endsAt === null || row.endsAt > at);
const presentedRole = (role: string) => role === "funcionario" ? "empregado_unidade" : role;

async function contact(ctx: ModuleContext, contactId: string) {
  const row = await one(ctx.env, `SELECT id FROM contacts WHERE profile_id=? AND id=?
    AND namespace='team' AND identity_state='active'`, ctx.profile, parse(id, contactId));
  if (!row) fail();
  // Nem contagem, nome ou resumo de dependentes sai pela ficha comum.
  if (await one(ctx.env, `SELECT p.id FROM cond_people p WHERE p.profile_id=? AND p.contact_id=?
    AND NOT (${publicPerson}) LIMIT 1`, ctx.profile, contactId)) fail("forbidden", 403);
}
async function sectionVersion(ctx: ModuleContext, contactId: string) {
  return (await one(ctx.env, `SELECT version FROM customer_sections WHERE profile_id=?
    AND contact_id=? AND module_id='condominio' AND section_id='units'`, ctx.profile, contactId))?.version ?? 1;
}
async function snapshot(ctx: ModuleContext, contactId: string): Promise<Snapshot> {
  const people = await all(ctx.env, `SELECT p.id FROM cond_people p WHERE p.profile_id=? AND p.contact_id=? AND ${publicPerson} ORDER BY p.id LIMIT 201`, ctx.profile, contactId);
  const memberships = await all<Membership>(ctx.env, `SELECT m.id,m.person_id AS personId,m.unit_id AS unitId,m.role,
    m.starts_at AS startsAt,m.ends_at AS endsAt,m.notices,b.name AS block,u.number
    FROM cond_memberships m JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
    JOIN cond_units u ON u.profile_id=m.profile_id AND u.id=m.unit_id
    JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE p.profile_id=? AND p.contact_id=? AND ${publicPerson} ORDER BY m.id LIMIT 201`, ctx.profile, contactId);
  const functions = await all<FunctionRow>(ctx.env, `SELECT f.id,f.person_id AS personId,f.unit_id AS unitId,f.role,
    f.starts_at AS startsAt,f.ends_at AS endsAt,f.version FROM cond_person_functions f
    JOIN cond_people p ON p.profile_id=f.profile_id AND p.id=f.person_id
    WHERE p.profile_id=? AND p.contact_id=? AND ${publicPerson} ORDER BY f.id LIMIT 201`, ctx.profile, contactId);
  const subscriptions = await all<Subscription>(ctx.env, `SELECT us.unit_id AS unitId,us.subscription_id AS subscriptionId
    FROM cond_unit_subscriptions us JOIN mensalidade_subscriptions s ON s.profile_id=us.profile_id AND s.id=us.subscription_id
    WHERE us.profile_id=? AND EXISTS(SELECT 1 FROM cond_memberships m
      JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
      WHERE m.profile_id=us.profile_id AND m.unit_id=us.unit_id AND p.contact_id=? AND ${publicPerson})
    ORDER BY us.unit_id,us.subscription_id LIMIT 201`, ctx.profile, contactId);
  if ([people, memberships, functions, subscriptions].some(rows => rows.length > 200))
    fail("contact_conflict", 409, "Revise a quantidade de vínculos na administração.");
  return { people, memberships, functions, subscriptions };
}
function view(snapshot: Snapshot, version: number, at: number): SectionView {
  const roles = new Set<string>();
  const memberships = snapshot.memberships.map(row => {
    const role = presentedRole(row.role), active = current(row, at);
    if (active) {
      roles.add(role);
      if (["proprietario", "inquilino"].includes(role)) roles.add("morador");
    }
    return { ...row, notices: !!row.notices, role, label: labels[role], active };
  });
  const functions = snapshot.functions.map(row => {
    const active = current(row, at);
    if (active) roles.add(row.role);
    return { ...row, label: labels[row.role], active };
  });
  return { version, writable: true, schema: "condominio.units.v1", data: {
    people: snapshot.people, memberships, functions, subscriptions: snapshot.subscriptions.map(row => ({ ...row, linked: true })),
    personTypes: [...roles].sort().map(key => ({ key, label: labels[key] })),
  } as Json };
}
async function section(ctx: ModuleContext, actor: Actor, contactId: string, sectionId: string) {
  await staff(ctx, actor, ["admin"]);
  if (sectionId !== "units") fail();
  await contact(ctx, contactId);
  const version = await sectionVersion(ctx, contactId);
  const data = await snapshot(ctx, contactId);
  if (version !== await sectionVersion(ctx, contactId)) fail("contact_conflict", 409);
  return view(data, version, now());
}

async function saveSection(ctx: ModuleContext, actor: Actor, contactId: string, sectionId: string, input: SectionWrite) {
  await staff(ctx, actor, ["admin"], true);
  if (sectionId !== "units") fail();
  await contact(ctx, contactId);
  const command = parse(z.object({ commandId: id, expectedVersion: z.number().int().positive(), data: changesSchema }).strict(), input);
  const d = command.data;
  // Lote pequeno: cada escrita condicionada inclui seu guardião de versão.
  if (d.memberships.length + d.functions.length + d.subscriptions.length > 10)
    fail("invalid_request", 400, "Salve no máximo dez alterações de vínculo por vez.");
  for (const rows of [d.memberships, d.functions]) {
    if (new Set(rows.map(r => r.id)).size !== rows.length) fail("invalid_request", 400);
    for (const row of rows) if (row.endsAt !== null && row.endsAt <= row.startsAt) fail("invalid_request", 400);
  }
  if (new Set(d.subscriptions.map(r => canonical([r.unitId, r.subscriptionId]))).size !== d.subscriptions.length)
    fail("invalid_request", 400);
  if (d.subscriptions.length) {
    await modulesApi(ctx.env, ctx.profile, "mensalidade").requireEnabled();
    requireAccess(actor, "mensalidade");
  }
  const requestHash = await sha(canonical({ actor: actor.id, contactId, module: "condominio", sectionId, command }));
  const jobId = `cond-units:${await sha(canonical([ctx.profile, command.commandId]))}`;
  const receipt = () => one(ctx.env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", ctx.profile, command.commandId);
  async function replay(job: any): Promise<SectionView & { replayed: boolean }> {
    if (job.request_hash !== requestHash || job.kind !== "section" || job.contact_id !== contactId) fail("idempotency_conflict", 409);
    if (job.state !== "done" || !job.result_cipher) fail("sync_pending", 409);
    const result = await unseal(ctx.env, job.result_cipher) as SectionView;
    return { ...result, replayed: true };
  }
  const prior = await receipt();
  if (prior) return replay(prior);
  if (await sectionVersion(ctx, contactId) !== command.expectedVersion) fail("contact_conflict", 409);
  const data = await snapshot(ctx, contactId), at = now();
  // Validação em conjuntos, sem uma viagem ao D1 para cada unidade/vínculo.
  const unitIds = [...new Set([...d.memberships, ...d.functions, ...d.subscriptions].map(r => r.unitId).filter((value): value is string => value !== null))];
  const units = new Map((unitIds.length ? await all(ctx.env, `SELECT u.id,u.number,b.name AS block
    FROM cond_units u JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    WHERE u.profile_id=? AND u.id IN (SELECT value FROM json_each(?))`, ctx.profile, JSON.stringify(unitIds)) : []).map(r => [r.id, r]));
  if (units.size !== unitIds.length) fail();
  const oldMemberships = new Map((d.memberships.length ? await all(ctx.env,
    "SELECT * FROM cond_memberships WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
    ctx.profile, JSON.stringify(d.memberships.map(r => r.id))) : []).map(r => [r.id, r]));
  const oldFunctions = new Map((d.functions.length ? await all(ctx.env,
    "SELECT * FROM cond_person_functions WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
    ctx.profile, JSON.stringify(d.functions.map(r => r.id))) : []).map(r => [r.id, r]));
  if (d.subscriptions.length) {
    const subscriptionIds = [...new Set(d.subscriptions.map(r => r.subscriptionId))];
    const found = await all(ctx.env, "SELECT id FROM mensalidade_subscriptions WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))", ctx.profile, JSON.stringify(subscriptionIds));
    if (found.length !== subscriptionIds.length) fail();
  }
  const statements: Statement[] = [];
  const guard = `${jobId}:version`;
  const assertChanged = (step: string) => {
    statements.push(["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)", [`${jobId}:${step}`]]);
    statements.push(["DELETE FROM customer_assert WHERE id=?", [`${jobId}:${step}`]]);
  };
  for (const change of d.memberships) {
    if (!data.people.some(p => p.id === change.personId)) fail();
    const unit = units.get(change.unitId)!;
    const existing = oldMemberships.get(change.id);
    const role = change.role === "empregado_unidade" ? "funcionario" : change.role;
    if (existing && (existing.person_id !== change.personId || existing.unit_id !== change.unitId || existing.role !== role || existing.starts_at !== change.startsAt))
      fail("contact_conflict", 409);
    if (existing) statements.push([`UPDATE cond_memberships SET ends_at=?,notices=?,verified_by=?
      WHERE profile_id=? AND id=? AND person_id=? AND unit_id=? AND role=?`,
      [change.endsAt, +change.notices, actor.id, ctx.profile, change.id, change.personId, change.unitId, role]]);
    else statements.push([`INSERT INTO cond_memberships(profile_id,id,person_id,unit_id,role,starts_at,ends_at,verified_by,notices)
      VALUES(?,?,?,?,?,?,?,?,?)`, [ctx.profile, change.id, change.personId, change.unitId, role, change.startsAt, change.endsAt, actor.id, +change.notices]]);
    assertChanged(`membership:${change.id}`);
    data.memberships = data.memberships.filter(r => r.id !== change.id);
    data.memberships.push({ ...change, role, block: unit.block, number: unit.number });
  }
  for (const change of d.functions) {
    if (!data.people.some(p => p.id === change.personId)) fail();
    if (change.role === "visitante_recorrente" && !change.unitId) fail("invalid_request", 400);
    const existing = oldFunctions.get(change.id);
    if (existing && (existing.person_id !== change.personId || existing.unit_id !== change.unitId || existing.role !== change.role || existing.starts_at !== change.startsAt))
      fail("contact_conflict", 409);
    if ((existing?.version ?? 0) !== change.expectedVersion) fail("contact_conflict", 409);
    if (existing) statements.push([`UPDATE cond_person_functions SET ends_at=?,verified_by=?,version=version+1
      WHERE profile_id=? AND id=? AND version=?`, [change.endsAt, actor.id, ctx.profile, change.id, change.expectedVersion]]);
    else statements.push([`INSERT INTO cond_person_functions(profile_id,id,person_id,unit_id,role,starts_at,ends_at,verified_by)
      VALUES(?,?,?,?,?,?,?,?)`, [ctx.profile, change.id, change.personId, change.unitId, change.role, change.startsAt, change.endsAt, actor.id]]);
    assertChanged(`function:${change.id}`);
    data.functions = data.functions.filter(r => r.id !== change.id);
    const { expectedVersion, ...row } = change;
    data.functions.push({ ...row, version: expectedVersion + 1 });
  }
  for (const change of d.subscriptions) {
    if (!data.memberships.some(m => m.unitId === change.unitId && current(m, at))) fail();
    if (change.linked) statements.push([`INSERT INTO cond_unit_subscriptions(profile_id,unit_id,subscription_id)
      SELECT ?,?,s.id FROM mensalidade_subscriptions s WHERE s.profile_id=? AND s.id=?
      ON CONFLICT(profile_id,unit_id,subscription_id) DO NOTHING`, [ctx.profile, change.unitId, ctx.profile, change.subscriptionId]]);
    else statements.push(["DELETE FROM cond_unit_subscriptions WHERE profile_id=? AND unit_id=? AND subscription_id=?", [ctx.profile, change.unitId, change.subscriptionId]]);
    data.subscriptions = data.subscriptions.filter(r => r.unitId !== change.unitId || r.subscriptionId !== change.subscriptionId);
    if (change.linked) data.subscriptions.push({ unitId: change.unitId, subscriptionId: change.subscriptionId });
  }
  if (d.subscriptions.length) statements.push([
    `INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id,version)
      SELECT DISTINCT p.profile_id,p.contact_id,'condominio','units',2 FROM cond_memberships m
      JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
      WHERE m.profile_id=? AND m.unit_id IN (SELECT value FROM json_each(?))
      AND p.contact_id IS NOT NULL AND p.contact_id<>?
      ON CONFLICT(profile_id,contact_id,module_id,section_id) DO UPDATE SET version=version+1`,
    [ctx.profile, JSON.stringify([...new Set(d.subscriptions.map(r => r.unitId))]), contactId],
  ]);
  data.memberships.sort((a, b) => a.id.localeCompare(b.id));
  data.functions.sort((a, b) => a.id.localeCompare(b.id));
  data.subscriptions.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.subscriptionId.localeCompare(b.subscriptionId));
  const result = view(data, command.expectedVersion + 1, at);
  const resultCipher = await seal(ctx.env, result);
  // Versão, relações e recibo são uma única transação D1. Queda antes dela não
  // grava nada; queda após confirmação é recuperada pelo recibo do comando.
  try {
    await batch(ctx.env, [
      [`INSERT INTO customer_sections(profile_id,contact_id,module_id,section_id,version) VALUES(?,?,'condominio','units',1)
        ON CONFLICT(profile_id,contact_id,module_id,section_id) DO NOTHING`, [ctx.profile, contactId]],
      [`UPDATE customer_sections SET version=version+1 WHERE profile_id=? AND contact_id=? AND module_id='condominio' AND section_id='units' AND version=?
        AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active')
        AND NOT EXISTS(SELECT 1 FROM cond_people p WHERE p.profile_id=? AND p.contact_id=? AND NOT (${publicPerson}))`,
        [ctx.profile, contactId, command.expectedVersion, ctx.profile, contactId, ctx.profile, contactId]],
      ["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)", [guard]],
      ...statements,
      [`INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,state,command_id,request_hash,expected_version,result_cipher,retry_at,created,updated)
        VALUES(?,?,'team',?,'section','done',?,?,?,?,?,?,?)`,
        [ctx.profile, jobId, contactId, command.commandId, requestHash, command.expectedVersion, resultCipher, at, at, at]],
      ["DELETE FROM customer_assert WHERE id=?", [guard]],
    ]);
  } catch (error) {
    const committed = await receipt();
    if (committed) return replay(committed);
    if (await sectionVersion(ctx, contactId) !== command.expectedVersion) fail("contact_conflict", 409);
    throw error;
  }
  return { ...result, replayed: false };
}

async function list(ctx: ModuleContext, actor: Actor, contactId: string, collectionId: string, query: { limit: number; cursor?: string }) {
  const kind = { deliveries: "encomenda", visits: "visitante", occurrences: "ocorrencia" }[collectionId];
  if (!kind && collectionId !== "dues") fail();
  await staff(ctx, actor, kind && kind !== "ocorrencia" ? ["admin", "portaria"] : ["admin"]);
  await contact(ctx, contactId);
  if (collectionId === "dues") {
    await modulesApi(ctx.env, ctx.profile, "mensalidade").requireEnabled();
    requireAccess(actor, "mensalidade");
  }
  const limit = parse(z.number().int().min(1).max(100), query.limit);
  const scope = canonical({ profile: ctx.profile, namespace: "team", contactId, collectionId, actor: actor.id, access: actor.access ?? null, limit });
  let cutoff = now(), lastAt = cutoff, lastId = "", hasLast = false;
  if (query.cursor) {
    try {
      const cursor = await unseal(ctx.env, query.cursor);
      if (cursor.scope !== scope || !Number.isSafeInteger(cursor.cutoff) || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string" || cursor.cutoff > now()) throw new Error();
      cutoff = cursor.cutoff; lastAt = cursor.at; lastId = cursor.id; hasLast = true;
    } catch { fail("invalid_cursor", 400); }
  }
  const at = now();
  // Autorização e vínculo são filtrados antes do LIMIT; nenhum fallback telefônico.
  const rows = kind ? await all(ctx.env, `SELECT w.id,w.created_at AS occurredAt,w.kind,u.number AS unit,b.name AS block
    FROM cond_works w JOIN cond_units u ON u.profile_id=w.profile_id AND u.id=w.unit_id
    JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
    JOIN cond_people p ON p.profile_id=w.profile_id AND p.id=w.person_id
    WHERE w.profile_id=? AND p.contact_id=? AND ${publicPerson} AND w.kind=? AND w.created_at<=?
    AND (?=0 OR w.created_at<? OR (w.created_at=? AND w.id<?))
    ORDER BY w.created_at DESC,w.id DESC LIMIT ?`, ctx.profile, contactId, kind, cutoff, +hasLast, lastAt, lastAt, lastId, limit + 1)
    : await all(ctx.env, `SELECT i.id,i.created AS occurredAt,i.status,i.due_date AS dueDate,i.amount_cents AS amountCents
      FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.profile_id=i.profile_id AND s.id=i.subscription_id
      WHERE i.profile_id=? AND i.created<=? AND EXISTS(SELECT 1 FROM cond_unit_subscriptions us
        JOIN cond_memberships m ON m.profile_id=us.profile_id AND m.unit_id=us.unit_id
        JOIN cond_people p ON p.profile_id=m.profile_id AND p.id=m.person_id
        WHERE us.profile_id=i.profile_id AND us.subscription_id=i.subscription_id AND p.contact_id=? AND ${publicPerson}
        AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?))
      AND (?=0 OR i.created<? OR (i.created=? AND i.id<?)) ORDER BY i.created DESC,i.id DESC LIMIT ?`,
      ctx.profile, cutoff, contactId, at, at, +hasLast, lastAt, lastAt, lastId, limit + 1);
  const items = rows.slice(0, limit).map(row => ({
    id: row.id as string,
    cells: (kind ? { unit: row.unit, block: row.block, createdAt: row.occurredAt }
      : { dueDate: row.dueDate, amountCents: row.amountCents, status: row.status }) as Record<string, string | number | null>,
    target: { module: kind ? "condominio" : "mensalidade", resource: kind ? "works" : "installments", id: row.id as string },
  }));
  const last = rows[Math.min(rows.length, limit) - 1];
  return { items, incomplete: false, nextCursor: rows.length > limit
    ? await seal(ctx.env, { scope, cutoff, at: last.occurredAt, id: last.id }) : null };
}

export const condominioCustomerProvider: CustomerModuleProvider = { section, saveSection, list };
