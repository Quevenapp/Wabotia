// Fotografia dos leitores que recebem só o driver. Este módulo não importa
// domínios nem registra RPCs: o núcleo do catálogo também é importado sozinho.
import type { SqlDriver } from "../../engine/driver.ts";
import { normalizeErpParts, type ErpParts } from "../../parts.ts";

const snapshots = new WeakMap<SqlDriver, Readonly<ErpParts>>();
const allParts = normalizeErpParts();

export const catalogParts = (db: SqlDriver) => snapshots.get(db) ?? allParts;
export const setCatalogParts = (db: SqlDriver, parts: Readonly<ErpParts>) => { snapshots.set(db, parts); };
