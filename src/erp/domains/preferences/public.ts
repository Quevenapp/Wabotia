// Preferências (erp_preferences): leitura de um valor. Portado de
// erp_preferences.get(p_key, p_user_id default null).
import { one, type SqlDriver } from "../../engine/driver.ts";

export * from "./stubs.generated.ts";
// As leituras de situações, transições e Meu Negócio que outros domínios usam
// estão em ./shared.ts: este arquivo fica leve (sem importar outros domínios),
// porque Catálogo, Estoque, Financeiro e Documentos o importam para o get() e um
// import pesado aqui muda a ordem de carga deles (ciclo com o Catálogo).

/**
 * erp_attachments.storage_ready(): no Fagoo confere o bucket em
 * storage.buckets e lança 55000 sem ele. No Wabotia o armazenamento é o R2
 * (binding MEDIA), sempre presente: não lança. O harness cria o bucket no
 * oráculo (existe em produção), e os dois motores concordam.
 */
export function storageReady(): void {}

/** Valor da preferência (JSON) ou null quando a chave não existe. */
export function get(db: SqlDriver, key: string, user: string | null = null): unknown {
  const row = one(
    db,
    `SELECT CASE WHEN p.scope='company'
       THEN coalesce((SELECT c.value FROM "erp_preferences__company_value" c WHERE c.key=d.key), d.default_value)
       ELSE coalesce((SELECT u.value FROM "erp_preferences__user_value" u WHERE u.key=d.key AND u.user_id=?), d.default_value) END v
     FROM "erp_preferences__definition" d JOIN "erp_preferences__page" p ON p.id=d.page_id WHERE d.key=?`,
    user,
    key,
  );
  return row?.v === null || row?.v === undefined ? null : JSON.parse(String(row.v));
}
