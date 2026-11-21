// Pacote do contador no objeto da área (src/erp/hub.ts, rotas /erp-contador/*
// e o alarme). O Worker (./routes.ts) já conferiu pessoa, papel, partes e o
// portão do ERP; aqui se confere de novo o papel e a parte Fiscal, e o pacote
// anda uma unidade por acordada, depois do trabalho operacional da área.
// As rotas /erp-contador/sistema/* não têm pessoa: são o envio automático e o
// link do contador (o objeto só é alcançado pelo Worker); conferem a parte.
import type { Env } from "../../types";
import { storageDriver, type SqlDriver } from "../engine/driver.ts";
import type { IdentityPort } from "../engine/identity.ts";
import type { ErpPartsSnapshot } from "../parts.ts";
import { CONTADOR_READ_ROLES, CONTADOR_WRITE_ROLES, contadorPeriod, type ContadorEnvironment } from "./contract.ts";
import {
  contadorNextWake, contadorRunning, listPackages, packageFiles, packageView, readPackage, runPackageUnit, startPackage,
  type ContadorSource, type PackageDependencies, type PackageMedia,
} from "./package.ts";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const refuse = (status: number, code: string, message: string) => Response.json({ code, message, error: { code, message } }, { status, headers: privateHeaders });
const ok = (value: unknown) => Response.json(value, { headers: privateHeaders });

export interface ContadorDoDependencies {
  env: Env | null;
  storage: DurableObjectStorage;
  readSnapshot(): Promise<ErpPartsSnapshot | null>;
  /** Testes: no lugar do emissor e do R2 da instalação. */
  source?: PackageDependencies["source"];
  media?: PackageMedia | null;
  now?(): number;
}

/** O emissor da área, com o contexto já ligado (null: sem ambiente). */
function sourceOf(env: Env | null, profile: string): PackageDependencies["source"] {
  if (!env) return null;
  return async () => {
    const { fiscalProviderFor } = await import("../emissor/index.ts");
    const ctx = { env, profile };
    const p = await fiscalProviderFor(ctx);
    const source: ContadorSource = {
      issued: (filter) => p.issued(ctx, filter),
      get: (kind, ref) => p.get(ctx, kind, ref),
      xml: (kind, ref) => p.xml(ctx, kind, ref),
      cancellationXml: (kind, ref) => p.cancellationXml(ctx, kind, ref),
      correctionXml: (ref, sequence) => p.correctionXml(ctx, ref, sequence),
      danfe: (ref) => p.danfe(ctx, ref),
      danfce: (ref) => p.danfce(ctx, ref),
      voidRanges: (filter) => p.voidRanges(ctx, filter),
      voidRangeXml: (ref) => p.voidRangeXml(ctx, ref),
      receivedDanfe: (ref) => p.receivedDanfe(ctx, ref),
    };
    return source;
  };
}

async function packageDependencies(profile: string, deps: ContadorDoDependencies, db: SqlDriver): Promise<PackageDependencies> {
  const { verifiedXmlOf } = await import("../bling/xml.ts");
  return {
    db, profile, now: deps.now ?? (() => Date.now()),
    media: deps.media !== undefined ? deps.media : (deps.env?.MEDIA ?? null),
    source: deps.source !== undefined ? deps.source : sourceOf(deps.env, profile),
    blingXml: (database, area, entity, sourceId) => { try { return verifiedXmlOf(database, area, entity, sourceId); } catch { return null; } },
  };
}

/** Notas recebidas do período por natureza, CFOP e situação (as lançadas no ERP), para o relatório. */
export function receivedSummary(db: SqlDriver, environment: string, from: string, to: string) {
  const empty = { by_nature: [], by_cfop: [], by_status: [], with_entry: { count: 0, amount: 0 } };
  try {
    const base = `FROM erp_purchase_inbound__note n WHERE n.environment=? AND n.role='destinatario' AND n.issued_on BETWEEN ? AND ?`;
    const money = (cents: unknown) => Number(cents ?? 0) / 100;
    const authorized = `${base} AND n.situation='autorizada'`;
    return {
      by_nature: db.exec(`SELECT coalesce(n.nature,'') AS nature, count(*) AS count, sum(coalesce(n.total_cents,0)) AS cents ${authorized} GROUP BY 1 ORDER BY cents DESC LIMIT 200`, environment, from, to).rows
        .map((r) => ({ nature: String(r.nature) || "Sem natureza informada", count: Number(r.count), amount: money(r.cents) })),
      by_cfop: db.exec(`SELECT coalesce(json_extract(n.cfops,'$[0]'),'') AS cfop, count(*) AS count, sum(coalesce(n.total_cents,0)) AS cents ${authorized} GROUP BY 1 ORDER BY cents DESC LIMIT 200`, environment, from, to).rows
        .map((r) => ({ cfop: String(r.cfop) || "Sem CFOP", count: Number(r.count), amount: money(r.cents) })),
      by_status: db.exec(`SELECT n.situation AS status, count(*) AS count, sum(coalesce(n.total_cents,0)) AS cents ${base} GROUP BY 1 ORDER BY 1`, environment, from, to).rows
        .map((r) => ({ status: String(r.status), count: Number(r.count), amount: money(r.cents) })),
      with_entry: (() => {
        const r = db.exec(`SELECT count(*) AS count, sum(coalesce(n.total_cents,0)) AS cents ${base} AND EXISTS(SELECT 1 FROM erp_purchase_inbound__entry e WHERE e.note_id=n.id AND e.state='active')`, environment, from, to).rows[0];
        return { count: Number(r?.count ?? 0), amount: money(r?.cents) };
      })(),
    };
  } catch { return empty; } // Esquema sem a compra pela nota recebida.
}

/** Regime da empresa (CRT: 1 Simples, 2 Simples com excesso de sublimite, 3 normal, 4 MEI), ou null. */
export function companyCrt(db: SqlDriver): string | null {
  try { const r = db.exec('SELECT crt FROM "erp_company__fiscal" WHERE singleton=1').rows[0]; return r?.crt == null ? null : String(r.crt); } catch { return null; }
}
/** Naturezas de operação cadastradas (descrição), para escolher o anexo do Simples de cada uma. */
export function natureList(db: SqlDriver): string[] {
  try {
    return db.exec('SELECT DISTINCT description FROM "erp_fiscal_invoices__nature" WHERE description IS NOT NULL ORDER BY description LIMIT 300').rows
      .map((r) => String(r.description)).filter(Boolean);
  } catch { return []; }
}

const environmentOf = (value: unknown): ContadorEnvironment => value === "homologacao" ? "homologacao" : "producao";
const ID = /^[0-9a-f]{16}$/;

/** POST /erp-contador/<operação> (pessoa) ou /erp-contador/sistema/<operação> (envio automático e link). */
export async function handleContadorRequest(profile: string, path: string, request: Request, identity: IdentityPort | null, deps: ContadorDoDependencies): Promise<Response> {
  const snapshot = await deps.readSnapshot();
  if (!snapshot?.parts.customers || !snapshot.parts.fiscal)
    return refuse(409, "module_disabled", "Para o contador, ligue o módulo Fiscal em Gestão → Módulos.");
  const system = path.startsWith("/erp-contador/sistema/");
  const op = path.slice(system ? "/erp-contador/sistema/".length : "/erp-contador/".length);
  if (!system) {
    const role = identity?.actor?.erp_role ?? null;
    if (!role || !CONTADOR_READ_ROLES.includes(role)) return refuse(403, "erp_fiscal_role_required", "O que é do contador é do papel fiscal, do administrador ou da consulta.");
    if (["pedir"].includes(op) && !CONTADOR_WRITE_ROLES.includes(role)) return refuse(403, "erp_fiscal_role_required", "Montar o pacote do contador é do papel fiscal ou do administrador.");
  } else if (!["pedir", "ver", "arquivos"].includes(op)) return refuse(404, "not_found", "Rota desconhecida.");
  if (request.method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(400, "invalid_request", "Corpo do pedido inválido.");
  const db = storageDriver(deps.storage);
  const now = deps.now ?? (() => Date.now());
  switch (op) {
    case "listar": return ok({ pacotes: listPackages(db) });
    case "ver": {
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Pacote inválido.");
      const p = readPackage(db, body.id);
      return p ? ok({ pacote: packageView(p) }) : refuse(404, "not_found", "Pacote não encontrado. Monte o pacote do período de novo.");
    }
    case "arquivos": {
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Pacote inválido.");
      const files = packageFiles(db, profile, body.id);
      if (!files) return refuse(404, "not_found", "O pacote ainda não está pronto ou foi refeito. Espere terminar ou monte de novo.");
      return ok(files);
    }
    case "pedir": {
      const period = contadorPeriod(body.from, body.to);
      if (typeof period === "string") return refuse(400, "invalid_request", period);
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Pacote inválido.");
      const actor = system ? "sistema" : identity?.actor?.user_id ?? null;
      const started = startPackage({ db, profile, now }, { id: body.id, environment: environmentOf(body.environment), from: period.from, to: period.to, redo: body.redo === true, actor });
      // Primeira unidade já na resposta: a pessoa vê o progresso começar.
      if (!started.reused) await runPackageUnit(await packageDependencies(profile, deps, db)).catch(() => null);
      const fresh = readPackage(db, body.id);
      return ok({ pacote: fresh ? packageView(fresh) : started.package, reaproveitado: started.reused });
    }
    case "resumo": {
      // Para o relatório: as recebidas lançadas no ERP, o regime da empresa e as naturezas cadastradas.
      const period = contadorPeriod(body.from, body.to);
      if (typeof period === "string") return refuse(400, "invalid_request", period);
      return ok({ recebidas: receivedSummary(db, environmentOf(body.environment), period.from, period.to), crt: companyCrt(db), naturezas: natureList(db) });
    }
    case "naturezas": return ok({ crt: companyCrt(db), naturezas: natureList(db) });
  }
  return refuse(404, "not_found", "Rota do contador desconhecida.");
}

/** Uma unidade do pacote no alarme, depois do trabalho operacional da área. */
export async function runContadorWake(profile: string, deps: ContadorDoDependencies): Promise<{ worked: boolean; nextWake: number | null }> {
  const now = deps.now ?? (() => Date.now());
  const db = storageDriver(deps.storage);
  if (!contadorRunning(db)) return { worked: false, nextWake: null };
  const snapshot = await deps.readSnapshot();
  // Fiscal desligado: o pacote espera, sem acordar a área.
  if (!snapshot?.parts.customers || !snapshot.parts.fiscal) return { worked: false, nextWake: null };
  const unit = await runPackageUnit(await packageDependencies(profile, deps, db));
  const due = contadorNextWake(db);
  return { worked: unit.worked, nextWake: unit.more ? Math.max(now() + 1_000, due ?? 0) : due };
}

/** Próxima acordada do pacote sem trabalhar agora (acordada com trabalho operacional). */
export function nextContadorWake(storage: DurableObjectStorage, notBefore: number): number | null {
  const due = contadorNextWake(storageDriver(storage));
  return due === null ? null : Math.max(notBefore, due);
}
