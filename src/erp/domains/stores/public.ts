// Lojas e filiais (structural.ts, lojas; tabelas erp_store__*, versão 27):
// o que os outros domínios usam para saber a loja de um registro e o que a
// pessoa pode ver. Só leitura e só o motor (sem RPC aqui; ./rpc.ts registra).
//
// Regras:
// - sem vínculo, o depósito e a conta financeira (os caixas do PDV são
//   contas) são da loja principal; o documento sem vínculo segue a loja do
//   depósito dele e, sem depósito, a principal; a conta a pagar ou receber sem
//   vínculo segue o documento que a gerou e, senão, a conta financeira dela;
// - com uma loja ativa só, nada filtra (viewStores devolve null);
// - o administrador vê todas; a pessoa limitada vê só as dela; o bot vê o que
//   a pessoa vê somado ao limite do bot (identity.store_scope, interseção);
// - a "loja em uso" (erp_store__selection) estreita a visão e é a loja padrão
//   do que a pessoa cria.
import { one, type SqlDriver } from "../../engine/driver.ts";
import type { RpcContext } from "../../engine/registry.ts";

export const STORE = "erp_store__store", STORE_WAREHOUSE = "erp_store__warehouse", STORE_ACCOUNT = "erp_store__account";
export const STORE_DOCUMENT = "erp_store__document", STORE_TITLE = "erp_store__title", STORE_PERSON = "erp_store__person";
export const STORE_SELECTION = "erp_store__selection", STORE_COMMAND = "erp_store__command", STORE_AUDIT = "erp_store__audit";
/** Contexto de uma leitura feita para uma loja só (relatório por loja chamando o RPC de sempre). */
export const STORE_ONLY_SETTING = "erp_store.only";

export interface StoreRow { id: string; name: string; is_main: boolean; active: boolean; default_warehouse_id: string | null }

const storeRow = (r: Record<string, unknown>): StoreRow => ({
  id: String(r.id), name: String(r.name), is_main: Number(r.is_main) === 1, active: Number(r.active) === 1,
  default_warehouse_id: (r.default_warehouse_id as string | null) ?? null,
});

/** Lojas (ativas primeiro, a principal no topo, depois pelo nome). */
export function storeRows(db: SqlDriver, activeOnly = true): StoreRow[] {
  return db.exec(`SELECT id, name, is_main, active, default_warehouse_id FROM "${STORE}" ${activeOnly ? "WHERE active=1" : ""}
    ORDER BY active DESC, is_main DESC, lower(name), id`).rows.map(storeRow);
}
export function mainStoreId(db: SqlDriver): string | null {
  return (one(db, `SELECT id FROM "${STORE}" WHERE is_main=1`)?.id as string | undefined) ?? null;
}
/** Duas lojas ativas ou mais: só então a loja aparece e filtra. */
export function multiStore(db: SqlDriver): boolean {
  return Number(one(db, `SELECT count(*) n FROM "${STORE}" WHERE active=1`)?.n ?? 0) >= 2;
}
export function roleOf(db: SqlDriver, user: string | null): string | null {
  if (!user) return null;
  return (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
}

/** Lojas a que a pessoa está limitada (só as ativas); null = todas (administrador ou sem limite). */
export function personStores(db: SqlDriver, user: string | null): string[] | null {
  if (!user || roleOf(db, user) === "admin") return null;
  const rows = db.exec(`SELECT p.store_id FROM "${STORE_PERSON}" p JOIN "${STORE}" s ON s.id=p.store_id
    WHERE p.user_id=? AND s.active=1 ORDER BY s.is_main DESC, lower(s.name), s.id`, user).rows;
  if (!rows.length) {
    // Limite só com lojas desativadas: não abre todas; cai na principal.
    const any = one(db, `SELECT 1 x FROM "${STORE_PERSON}" WHERE user_id=? LIMIT 1`, user);
    if (!any) return null;
    const main = mainStoreId(db);
    return main ? [main] : [];
  }
  return rows.map((r) => String(r.store_id));
}

/** Limite do bot por quem a pessoa age (envelope de identidade); undefined = sem limite. */
const botScope = (ctx: Pick<RpcContext, "identity">): readonly string[] | undefined => ctx.identity?.store_scope;

/** O que a pessoa (e o bot por ela) pode ver e operar; null = todas. */
export function allowedStores(ctx: Pick<RpcContext, "db" | "identity">, user: string | null): Set<string> | null {
  const person = personStores(ctx.db, user);
  const bot = botScope(ctx);
  if (bot === undefined) return person === null ? null : new Set(person);
  // O limite do bot nomeia lojas pelo id; loja que não existe mais é ignorada.
  const botSet = new Set(bot.filter((id) => person === null || person.includes(id)));
  return botSet;
}
export const storeAllowed = (allowed: Set<string> | null, store: string | null) => allowed === null || (store !== null && allowed.has(store));

/** Loja em uso gravada pela pessoa (se ainda ativa); null = todas. */
export function selectedStore(db: SqlDriver, user: string | null): string | null {
  if (!user) return null;
  return (one(db, `SELECT s.id FROM "${STORE_SELECTION}" x JOIN "${STORE}" s ON s.id=x.store_id AND s.active=1 WHERE x.user_id=?`, user)?.id as string | undefined) ?? null;
}

/**
 * Lojas que a leitura mostra para a pessoa: null (todas, sem filtrar) com uma
 * loja só ou para quem não tem limite nem loja em uso; senão o conjunto.
 */
export function viewStores(ctx: Pick<RpcContext, "db" | "identity" | "settings">, user: string | null): Set<string> | null {
  const db = ctx.db;
  if (!multiStore(db)) return null;
  const allowed = allowedStores(ctx, user);
  const only = ctx.settings?.get(STORE_ONLY_SETTING);
  if (only) return storeAllowed(allowed, only) ? new Set([only]) : new Set();
  const selected = selectedStore(db, user);
  if (selected && storeAllowed(allowed, selected)) return new Set([selected]);
  return allowed;
}

/** Loja padrão do que a pessoa cria: a loja em uso, senão a primeira das dela, senão a principal. */
export function defaultStore(ctx: Pick<RpcContext, "db" | "identity">, user: string | null): string | null {
  const db = ctx.db;
  const allowed = allowedStores(ctx, user);
  const selected = selectedStore(db, user);
  if (selected && storeAllowed(allowed, selected)) return selected;
  const main = mainStoreId(db);
  if (allowed === null || (main && allowed.has(main))) return main;
  const first = storeRows(db).find((s) => allowed.has(s.id));
  return first?.id ?? null;
}

/**
 * A loja de cada registro, com as leituras guardadas para uma consulta inteira
 * (as listas perguntam linha a linha).
 */
export class StoreResolver {
  readonly db: SqlDriver;
  readonly main: string | null;
  private warehouses: Map<string, string> | null = null;
  private accounts: Map<string, string> | null = null;
  private documents = new Map<string, string | null>();
  constructor(db: SqlDriver) {
    this.db = db;
    this.main = mainStoreId(db);
  }
  private load(table: string, key: string) {
    return new Map(this.db.exec(`SELECT ${key} k, store_id FROM "${table}"`).rows.map((r) => [String(r.k), String(r.store_id)]));
  }
  warehouse(id: unknown): string | null {
    if (typeof id !== "string" || !id) return this.main;
    this.warehouses ??= this.load(STORE_WAREHOUSE, "warehouse_id");
    return this.warehouses.get(id) ?? this.main;
  }
  account(id: unknown): string | null {
    if (typeof id !== "string" || !id) return this.main;
    this.accounts ??= this.load(STORE_ACCOUNT, "account_id");
    return this.accounts.get(id) ?? this.main;
  }
  /** Documento: o vínculo, senão a loja do depósito, senão a principal. */
  document(id: unknown, warehouse?: unknown): string | null {
    if (typeof id !== "string") return this.main;
    if (this.documents.has(id)) return this.documents.get(id)!;
    const link = one(this.db, `SELECT store_id FROM "${STORE_DOCUMENT}" WHERE document_id=?`, id)?.store_id as string | undefined;
    let store: string | null;
    if (link) store = link;
    else {
      const wh = warehouse === undefined ? one(this.db, 'SELECT warehouse_id FROM "erp_documents__document" WHERE id=?', id)?.warehouse_id : warehouse;
      store = this.warehouse(wh);
    }
    this.documents.set(id, store);
    return store;
  }
  /** Conta a pagar ou receber: o vínculo, o documento que a gerou, a conta financeira, a principal. */
  title(id: unknown, account?: unknown, group?: unknown): string | null {
    if (typeof id !== "string") return this.main;
    const link = one(this.db, `SELECT store_id FROM "${STORE_TITLE}" WHERE title_id=?`, id)?.store_id as string | undefined;
    if (link) return link;
    let g = group, a = account;
    if (g === undefined || a === undefined) {
      const t = one(this.db, 'SELECT group_id, account_id FROM "erp_finance__title" WHERE id=?', id);
      g = t?.group_id; a = t?.account_id;
    }
    if (typeof g === "string") {
      const doc = one(this.db, 'SELECT document_id FROM "erp_finance__document_posting" WHERE group_id=? ORDER BY created_at DESC LIMIT 1', g)?.document_id;
      if (typeof doc === "string") return this.document(doc);
    }
    const sale = one(this.db, 'SELECT s.account_id FROM "erp_pos__sale_payment" p JOIN "erp_pos__sale" s ON s.id=p.sale_id WHERE p.title_id=? LIMIT 1', id);
    if (sale) return this.account(sale.account_id);
    return this.account(a);
  }
}

/**
 * Filtro de uma leitura: null quando nada filtra; senão a função que diz se o
 * registro (pela loja calculada) entra.
 */
export function storeFilter(ctx: Pick<RpcContext, "db" | "identity" | "settings">, user: string | null) {
  const view = viewStores(ctx, user);
  if (view === null) return null;
  const resolver = new StoreResolver(ctx.db);
  const has = (store: string | null) => store !== null && view.has(store);
  return {
    stores: view,
    resolver,
    document: (id: unknown, warehouse?: unknown) => has(resolver.document(id, warehouse)),
    warehouse: (id: unknown) => has(resolver.warehouse(id)),
    account: (id: unknown) => has(resolver.account(id)),
    title: (id: unknown, account?: unknown, group?: unknown) => has(resolver.title(id, account, group)),
  };
}
export type StoreFilter = NonNullable<ReturnType<typeof storeFilter>>;
