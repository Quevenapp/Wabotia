#!/usr/bin/env node
// Troca a tabela embutida de classificações do IBS/CBS (REFORM_CLASSES em
// src/erp/domains/fiscal/reform-table.ts) pela planilha oficial do Portal da
// NF-e, exportada em CSV. Sem rede: o arquivo é baixado à mão.
//
//   node scripts/erp/reforma-cclasstrib.mjs <tabela.csv> [versão]
//
// O CSV pode usar ponto e vírgula ou vírgula. As colunas são achadas pelo
// cabeçalho (sem acento e sem caixa): cClassTrib; CST (CST-IBS/CBS); nome ou
// descrição da classificação; pRedIBS; pRedCBS; e, se houver, o artigo da
// LC 214/2025. Classificação cujo começo não é o CST, CST fora de
// REFORM_CSTS ou código repetido param o script sem gravar nada.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../../src/erp/domains/fiscal/reform-table.ts", import.meta.url));
const [file, version] = process.argv.slice(2);
if (!file) {
  console.error("Uso: node scripts/erp/reforma-cclasstrib.mjs <tabela.csv> [versão]");
  process.exit(2);
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
function parse(text) {
  const clean = text.replace(/^﻿/, "");
  const sep = (clean.split(/\r?\n/)[0].match(/;/g) ?? []).length >= (clean.split(/\r?\n/)[0].match(/,/g) ?? []).length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const rows = parse(readFileSync(file, "utf8"));
const head = rows[0].map(fold);
/** A primeira coluna pelo nome mais específico: igual antes de "começa com", na ordem dos nomes. */
const find = (...names) => {
  for (const n of names) { const exact = head.indexOf(n); if (exact >= 0) return exact; }
  for (const n of names) { const prefix = head.findIndex((h) => h.startsWith(n)); if (prefix >= 0) return prefix; }
  return -1;
};
const col = {
  code: find("cclasstrib", "codigodaclassificacao"),
  cst: find("cstibscbs", "cst"),
  name: find("nomecclasstrib", "descricaocclasstrib", "nomedaclassificacao", "descricaodaclassificacao", "nome"),
  ibs: find("predibs", "percentualreducaoibs"),
  cbs: find("predcbs", "percentualreducaocbs"),
  law: find("lcredacao", "artigo", "dispositivo", "lc214"),
};
for (const [key, index] of Object.entries(col))
  if (index < 0 && key !== "law") { console.error(`Coluna ${key} não encontrada no cabeçalho: ${rows[0].join(" | ")}`); process.exit(1); }

const source = readFileSync(target, "utf8");
const csts = new Set([...source.matchAll(/\{ cst: "(\d{3})", description: "[^"]*", kind: "(?:taxed|exempt|manual)" \}/g)].map((m) => m[1]));
const decimal = (v) => { const t = String(v ?? "").trim().replace("%", "").replace(",", "."); return /^\d{1,3}(\.\d+)?$/.test(t) ? String(Number(t)) : "0"; };
const quote = (s) => JSON.stringify(s.replace(/\s+/g, " ").trim());
const seen = new Set();
const entries = [];
for (const r of rows.slice(1)) {
  const code = String(r[col.code] ?? "").replace(/\D/g, "");
  if (!code) continue;
  const cst = String(r[col.cst] ?? "").replace(/\D/g, "").padStart(3, "0");
  if (!/^\d{6}$/.test(code) || !code.startsWith(cst)) { console.error(`Linha com classificação ${code} fora do CST ${cst}.`); process.exit(1); }
  if (!csts.has(cst)) { console.error(`CST ${cst} (classificação ${code}) não está em REFORM_CSTS: acrescente-o antes, com o tratamento no cálculo.`); process.exit(1); }
  if (seen.has(code)) { console.error(`Classificação ${code} repetida.`); process.exit(1); }
  seen.add(code);
  const ibs = decimal(r[col.ibs]), cbs = decimal(r[col.cbs]);
  const law = col.law >= 0 ? String(r[col.law] ?? "").trim() : "";
  entries.push(`  c("${code}", ${quote(String(r[col.name] ?? code))}, "${ibs}", ${quote(law || "LC 214/2025")}${cbs !== ibs ? `, "${cbs}"` : ""}),`);
}
if (!entries.length) { console.error("Nenhuma classificação no arquivo."); process.exit(1); }

const start = source.indexOf("export const REFORM_CLASSES: readonly ReformClassEntry[] = Object.freeze([");
const end = source.indexOf("]);", start);
if (start < 0 || end < 0) { console.error("Não achei REFORM_CLASSES em reform-table.ts."); process.exit(1); }
const stamp = version ?? `${new Date().toISOString().slice(0, 10)}.oficial`;
let next = source.slice(0, start) + "export const REFORM_CLASSES: readonly ReformClassEntry[] = Object.freeze([\n" + entries.join("\n") + "\n" + source.slice(end);
next = next.replace(/export const REFORM_TABLE_VERSION = "[^"]*";/, `export const REFORM_TABLE_VERSION = ${JSON.stringify(stamp)};`);
next = next.replace(/export const REFORM_TABLE_SOURCE =\n?\s*"[^"]*";/, `export const REFORM_TABLE_SOURCE =\n  ${JSON.stringify("Tabela de CST e cClassTrib do IBS e da CBS, Portal da NF-e (informe técnico 2025.002), importada da planilha oficial.")};`);
writeFileSync(target, next);
console.log(`${entries.length} classificações gravadas em src/erp/domains/fiscal/reform-table.ts (versão ${stamp}). Rode os testes da reforma.`);
