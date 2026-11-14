// Conhecimento: busca de trechos para o bot e texto completo de uma fonte.
import { all } from "./db";
import type { Env } from "./types";

// Trechos de 1600 caracteres a cada 1300: cada um repete os 300 finais do
// anterior, para uma frase cortada aparecer inteira em algum trecho.
const STEP = 1300,
  SIZE = 1600;

export function chunkWrites(
  profile: string,
  documentId: string,
  text: string,
  url = "",
): [string, any[]][] {
  const writes: [string, any[]][] = [];
  for (let i = 0; i < text.length; i += STEP)
    writes.push([
      "INSERT INTO chunks(profile_id,document_id,text,url) VALUES(?,?,?,?)",
      [profile, documentId, text.slice(i, i + SIZE), url],
    ]);
  return writes;
}

/** Texto completo de uma fonte, remontado dos trechos sem a sobreposição. */
export async function documentText(
  env: Env,
  profile: string,
  documentId: string,
) {
  const rows = await all(
    env,
    "SELECT text FROM chunks WHERE document_id=? AND profile_id=? ORDER BY rowid",
    documentId,
    profile,
  );
  return rows
    .map((row: any, index: number) =>
      index < rows.length - 1 ? String(row.text).slice(0, STEP) : row.text,
    )
    .join("");
}

/** Até cinco trechos para as palavras do pedido, com o título da fonte e a
 * orientação de uso que o administrador escreveu para ela. */
export async function searchKnowledge(
  env: Env,
  profile: string,
  words: string[],
) {
  if (!words.length) return [];
  const rows = await all(
    env,
    `SELECT chunks.rowid id,chunks.document_id,chunks.text,chunks.url,d.title,d.usage
     FROM chunks LEFT JOIN documents d ON d.id=chunks.document_id
     WHERE chunks.profile_id=? AND chunks MATCH ? ORDER BY rank LIMIT 5`,
    profile,
    words.map((w) => '"' + w.replaceAll('"', "") + '"').join(" OR "),
  );
  // Only what the bot needs: no empty fields in the source list.
  return rows.map((row: any) => {
    const source: Record<string, any> = {
      id: row.id,
      document_id: row.document_id,
      text: row.text,
      url: row.url,
    };
    if (row.title) source.title = row.title;
    if (row.usage) source.usage = row.usage;
    return source;
  });
}
