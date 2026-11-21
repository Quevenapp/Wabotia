// Obrigações em arquivo no objeto da área (src/erp/hub.ts, rotas /erp-sped/*
// e o alarme). O Worker (./routes.ts) já conferiu pessoa, papel, partes e o
// portão do ERP; aqui se confere de novo o papel e a parte Fiscal, e o arquivo
// anda uma unidade por acordada, depois do trabalho operacional da área.
// As rotas /erp-sped/sistema/* não têm pessoa (o envio que espera o pacote).
import type { Env } from "../../types";
import { storageDriver } from "../engine/driver.ts";
import type { IdentityPort } from "../engine/identity.ts";
import type { ErpPartsSnapshot } from "../parts.ts";
import type { PackageMedia } from "../contador/package.ts";
import { inventoryDay, isKind, SPED_OFF_MESSAGE, SPED_READ_ROLES, SPED_WRITE_ROLES, spedPeriod, type SpedEnvironment } from "./contract.ts";
import { conference, readSpedSettings, saveSpedSettings } from "./data.ts";
import { fileParts, fileView, listFiles, readFile, runSpedUnit, spedNextWake, spedRunning, startFile, type SpedDependencies, type SpedSource } from "./job.ts";
import { applySettings, SettingsError, settingsView } from "./settings.ts";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const refuse = (status: number, code: string, message: string) => Response.json({ code, message, error: { code, message } }, { status, headers: privateHeaders });
const ok = (value: unknown) => Response.json(value, { headers: privateHeaders });

export interface SpedDoDependencies {
  env: Env | null;
  storage: DurableObjectStorage;
  readSnapshot(): Promise<ErpPartsSnapshot | null>;
  /** Testes: no lugar do emissor e do R2 da instalação. */
  source?: SpedDependencies["source"];
  media?: PackageMedia | null;
  now?(): number;
}

function sourceOf(env: Env | null, profile: string): SpedDependencies["source"] {
  if (!env) return null;
  return async () => {
    const { fiscalProviderFor } = await import("../emissor/index.ts");
    const ctx = { env, profile };
    const p = await fiscalProviderFor(ctx);
    const source: SpedSource = {
      issued: (filter) => p.issued(ctx, filter),
      xml: (kind, ref) => p.xml(ctx, kind, ref),
      voidRanges: (filter) => p.voidRanges(ctx, filter),
    };
    return source;
  };
}
function dependencies(profile: string, deps: SpedDoDependencies): SpedDependencies {
  return {
    db: storageDriver(deps.storage), profile, now: deps.now ?? (() => Date.now()),
    media: deps.media !== undefined ? deps.media : (deps.env?.MEDIA ?? null),
    source: deps.source !== undefined ? deps.source : sourceOf(deps.env, profile),
  };
}

const environmentOf = (value: unknown): SpedEnvironment => value === "homologacao" ? "homologacao" : "producao";
const ID = /^[0-9a-f]{16}$/;

/** POST /erp-sped/<operação> (pessoa) ou /erp-sped/sistema/<operação>. */
export async function handleSpedRequest(profile: string, path: string, request: Request, identity: IdentityPort | null, deps: SpedDoDependencies): Promise<Response> {
  const snapshot = await deps.readSnapshot();
  if (!snapshot?.parts.customers || !snapshot.parts.fiscal) return refuse(409, "module_disabled", SPED_OFF_MESSAGE);
  const system = path.startsWith("/erp-sped/sistema/");
  const op = path.slice(system ? "/erp-sped/sistema/".length : "/erp-sped/".length);
  const role = identity?.actor?.erp_role ?? null;
  if (!system) {
    if (!role || !SPED_READ_ROLES.includes(role)) return refuse(403, "erp_fiscal_role_required", "SPED e SINTEGRA são do papel fiscal, do administrador ou da consulta.");
    if (["pedir", "configuracao.salvar"].includes(op) && !SPED_WRITE_ROLES.includes(role))
      return refuse(403, "erp_fiscal_role_required", "Gerar arquivos e mudar a configuração são do papel fiscal ou do administrador.");
  } else if (!["ver"].includes(op)) return refuse(404, "not_found", "Rota desconhecida.");
  if (request.method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(400, "invalid_request", "Corpo do pedido inválido.");
  const d = dependencies(profile, deps);
  const { db } = d;
  switch (op) {
    case "listar": return ok({ arquivos: listFiles(db) });
    case "ver": {
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Arquivo inválido.");
      const f = readFile(db, body.id);
      return f ? ok({ arquivo: fileView(f) }) : refuse(404, "not_found", "Arquivo não encontrado. Gere o arquivo do período de novo.");
    }
    case "partes": {
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Arquivo inválido.");
      const files = fileParts(db, profile, body.id);
      return files ? ok(files) : refuse(404, "not_found", "O arquivo ainda não está pronto ou foi gerado de novo. Espere terminar ou gere de novo.");
    }
    case "conferir": {
      if (!isKind(body.kind)) return refuse(400, "invalid_request", "Tipo: efd_icms_ipi, efd_contribuicoes ou sintegra.");
      const period = spedPeriod(body.kind, body.from, body.to);
      if (typeof period === "string") return refuse(400, "invalid_request", period);
      const inventory = inventoryDay(body.inventory, period.to);
      if (inventory && typeof inventory === "object") return refuse(400, "invalid_request", inventory.error);
      const checked = await conference(db, { kind: body.kind, environment: environmentOf(body.environment), from: period.from, to: period.to, inventory });
      return ok({ pendencias: checked.problems, aviso_regime: checked.notice, crt: checked.crt, pode_gerar: !checked.problems.some((p) => p.blocking) });
    }
    case "pedir": {
      if (!isKind(body.kind)) return refuse(400, "invalid_request", "Tipo: efd_icms_ipi, efd_contribuicoes ou sintegra.");
      const period = spedPeriod(body.kind, body.from, body.to);
      if (typeof period === "string") return refuse(400, "invalid_request", period);
      if (typeof body.id !== "string" || !ID.test(body.id)) return refuse(400, "invalid_request", "Arquivo inválido.");
      const inventory = inventoryDay(body.inventory, period.to);
      if (inventory && typeof inventory === "object") return refuse(400, "invalid_request", inventory.error);
      const credit = Number(body.previous_credit ?? 0);
      if (!Number.isInteger(credit) || credit < 0) return refuse(400, "invalid_request", "Saldo credor anterior: valor em reais, zero ou mais.");
      const started = await startFile(d, { id: body.id, kind: body.kind, environment: environmentOf(body.environment), from: period.from, to: period.to,
        inventory: body.kind === "efd_contribuicoes" ? null : inventory, previousCredit: body.kind === "efd_icms_ipi" ? credit : 0, redo: body.redo === true,
        actor: identity?.actor?.user_id ?? null });
      // Primeira unidade já na resposta: a pessoa vê o progresso começar.
      if (!started.reused && started.file.state === "running") await runSpedUnit(d).catch(() => null);
      const fresh = readFile(db, body.id);
      return ok({ arquivo: fresh ? fileView(fresh) : started.file, reaproveitado: started.reused });
    }
    case "configuracao": return ok({ configuracao: settingsView(readSpedSettings(db)) });
    case "configuracao.salvar": {
      try {
        const next = applySettings(readSpedSettings(db), body);
        saveSpedSettings(db, next, identity?.actor?.user_id ?? "desconhecido", d.now());
        return ok({ configuracao: settingsView(next) });
      } catch (error) {
        if (error instanceof SettingsError) return refuse(400, "invalid_request", error.message);
        throw error;
      }
    }
  }
  return refuse(404, "not_found", "Rota de SPED desconhecida.");
}

/** Uma unidade do arquivo no alarme, depois do trabalho operacional da área. */
export async function runSpedWake(profile: string, deps: SpedDoDependencies): Promise<{ worked: boolean; nextWake: number | null }> {
  const now = deps.now ?? (() => Date.now());
  const d = dependencies(profile, deps);
  if (!spedRunning(d.db)) return { worked: false, nextWake: null };
  const snapshot = await deps.readSnapshot();
  if (!snapshot?.parts.customers || !snapshot.parts.fiscal) return { worked: false, nextWake: null };
  const unit = await runSpedUnit(d);
  const due = spedNextWake(d.db);
  return { worked: unit.worked, nextWake: unit.more ? Math.max(now() + 1_000, due ?? 0) : due };
}

export function nextSpedWake(storage: DurableObjectStorage, notBefore: number): number | null {
  const due = spedNextWake(storageDriver(storage));
  return due === null ? null : Math.max(notBefore, due);
}
