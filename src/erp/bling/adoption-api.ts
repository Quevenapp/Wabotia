/** Despacho das operações de adoção dentro do objeto da área. O Worker só
 * encaminha nomes conhecidos; aqui se conferem pessoa, papel, partes e, para
 * bots, a concessão nominal e a confirmação da pessoa. */
import { createHash } from "node:crypto";
import type { IdentityPort } from "../engine/identity.ts";
import { storageDriver } from "../engine/driver.ts";
import { readErpPartsSnapshot, type ErpPartsSnapshot } from "../parts.ts";
import {
  BLING_ADOPTION_OPERATIONS, BlingAdoptionError, adoptionOutputs, parseAdoptionInput,
  type BlingAdoptionAuthorization, type BlingAdoptionOperationName,
} from "./adoption-contracts.ts";
import {
  adoptionLinks, adoptionPause, adoptionResolve, adoptionReviews, adoptionStart, adoptionStatus, adoptionUnlink, runAdoptionUnit, type AdoptionCall,
} from "./adoption.ts";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export const adoptionRequestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function adoptionFailureResponse(error: unknown): Response {
  const failure = error instanceof BlingAdoptionError ? error : new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
  return Response.json({ error: failure.toJSON() }, { status: failure.status, headers: privateHeaders });
}

export interface AdoptionDispatch {
  name: BlingAdoptionOperationName;
  identity: IdentityPort;
  profile: string;
  input: unknown;
  authorization: BlingAdoptionAuthorization | null;
}

/** Quem pode: administrador do ERP com sessão; bot só pela operação concedida e,
 * nas sensíveis, com a proposta confirmada pela própria pessoa. */
export function authorizeAdoption(call: AdoptionDispatch): void {
  const actor = call.identity.actor;
  if (!actor || actor.erp_role !== "admin") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
  if (!actor.is_agent) {
    if (!actor.session_id || call.authorization) throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
    return;
  }
  const authorization = call.authorization;
  if (!authorization || authorization.bot.operation !== call.name || authorization.request_hash !== adoptionRequestHash(call.input))
    throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  if (BLING_ADOPTION_OPERATIONS[call.name].sensitive && (!authorization.confirmed || !authorization.delegation.proposal_id))
    throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
}

export interface AdoptionDependencies {
  storage: DurableObjectStorage;
  readSnapshot(): Promise<ErpPartsSnapshot | null>;
  now?(): number;
}
export async function handleAdoptionOperation(call: AdoptionDispatch, dependencies: AdoptionDependencies): Promise<Response> {
  try {
    const now = dependencies.now ?? (() => Date.now());
    const snapshot = readErpPartsSnapshot(await dependencies.readSnapshot(), call.profile, now());
    if (!snapshot?.parts.customers) throw new BlingAdoptionError("BLING_ADOPTION_DISABLED");
    authorizeAdoption(call);
    const input = parseAdoptionInput(call.name, call.input);
    const context: AdoptionCall = { db: storageDriver(dependencies.storage), profile: call.profile, now, parts: snapshot.parts,
      identity: { ...call.identity, parts: snapshot.parts }, request_hash: adoptionRequestHash(input) };
    let result: unknown;
    switch (call.name) {
      case "erp_bling_adoption_status": result = adoptionStatus(context); break;
      case "erp_bling_adoption_reviews": result = adoptionReviews(context, input as never); break;
      case "erp_bling_adoption_links": result = adoptionLinks(context, input as never); break;
      case "erp_bling_adoption_start": {
        result = adoptionStart(context, input as never);
        // Primeira unidade já na resposta: a pessoa vê o progresso começar.
        runAdoptionUnit({ db: context.db, profile: call.profile, now, parts: snapshot.parts });
        result = { ...(result as object), job: adoptionStatus(context).job };
        break;
      }
      case "erp_bling_adoption_pause": result = adoptionPause(context, input as never); break;
      case "erp_bling_adoption_resolve": result = adoptionResolve(context, input as never); break;
      case "erp_bling_adoption_unlink": result = adoptionUnlink(context, input as never); break;
    }
    const output = adoptionOutputs[call.name].safeParse(result);
    if (!output.success) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
    return Response.json(output.data, { headers: privateHeaders });
  } catch (error) { return adoptionFailureResponse(error); }
}

/** Uma unidade no alarme, depois do trabalho operacional da área. */
export async function runAdoptionWake(profile: string, dependencies: AdoptionDependencies): Promise<{ worked: boolean; nextWake: number | null }> {
  const now = dependencies.now ?? (() => Date.now());
  const snapshot = readErpPartsSnapshot(await dependencies.readSnapshot(), profile, now());
  if (!snapshot?.parts.customers) return { worked: false, nextWake: null };
  const result = runAdoptionUnit({ db: storageDriver(dependencies.storage), profile, now, parts: snapshot.parts });
  return { worked: result.worked, nextWake: result.more ? now() + 1_000 : null };
}
