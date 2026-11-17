#!/usr/bin/env node
// Guarda de codificação (npm run check): todo arquivo de texto versionado é
// UTF-8 válido, sem BOM, sem U+FFFD e sem as sequências de uma leitura errada
// (UTF-8 lido como Latin-1/ANSI e regravado: "Ã£", "Ã§", "Ã©", "â€"). O
// PowerShell 5.1 faz isso com Get-Content/Set-Content sem -Encoding; pegou o
// tronco duas vezes em 17/11/2026 (docs/ERP-PORTE.md, "Codificação").
// Arquivo que cita essas sequências de propósito entra em ALLOWED, com o motivo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Arquivos que podem conter as sequências (caminho exato → motivo). */
const ALLOWED = new Map([
  ["scripts/check-encoding.mjs", "a própria guarda descreve as sequências"],
  ["docs/ERP-PORTE.md", "a regra de codificação cita as sequências"],
]);
/** Extensões binárias (o resto é texto; arquivo com byte NUL também é binário). */
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|wasm|mp3|mp4|ogg|wav|webm|bin|pfx|p12|der|keystore|jks|apk|aab|ipa|db|sqlite|sqlite3)$/i;
// "Ã" seguido do segundo byte de um acento em UTF-8 lido como Latin-1
// (U+0080 a U+00BF) ou como Windows-1252 (0x80–0x9F viram € ‚ ƒ „ … † ‡ ˆ ‰
// Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ; ex.: "Ã‡" de Ç), ou "â€" (aspas e travessão).
const MOJIBAKE = /Ã[\u0080-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|â€/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })
  .toString("utf8")
  .split("\0")
  .filter((f) => f && !BINARY.test(f));
const decoder = new TextDecoder("utf-8", { fatal: true });
const problems = [];
for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // removido no disco e ainda no índice
  }
  if (bytes.includes(0)) continue;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push(`${file}: começa com BOM`);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    problems.push(`${file}: bytes inválidos em UTF-8`);
    continue;
  }
  if (ALLOWED.has(file)) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("�")) problems.push(`${file}:${i + 1}: U+FFFD (caractere de substituição)`);
    const m = MOJIBAKE.exec(line);
    if (m) problems.push(`${file}:${i + 1}: "${m[0]}" (UTF-8 lido como Latin-1)`);
  });
}
if (problems.length) {
  console.error(`Codificação: ${problems.length} problema(s). Corrija lendo e gravando em UTF-8 (Edit/Write, ou -Encoding utf8 sem BOM):`);
  for (const p of problems.slice(0, 50)) console.error("  " + p);
  if (problems.length > 50) console.error(`  … e mais ${problems.length - 50}.`);
  process.exit(1);
}
console.log(`Codificação: ${files.length} arquivos de texto em UTF-8.`);
