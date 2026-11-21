#!/usr/bin/env node
// Gera um par de chaves Ed25519 para assinar as versões do Vinki
// (docs/ATUALIZACOES-FORMATO.md, "Assinatura"). Grava a chave privada num
// arquivo FORA do repositório, com acesso só do usuário atual, e imprime só a
// chave pública (para src/release-keys.json). A chave privada nunca é
// impressa, registrada em log nem copiada.
//
//   node scripts/release-keygen.mjs --id principal --out D:\chaves\principal.pem
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { insideRepository } from "./release-plan.mjs";

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const id = option("--id");
const out = option("--out");
if (!id || !/^[a-z][a-z0-9-]{1,40}$/.test(id) || !out)
  throw Error(
    "Uso: node scripts/release-keygen.mjs --id <principal|reserva> --out <arquivo .pem fora do repositório>",
  );
const path = resolve(out);
if (insideRepository(path, process.cwd()))
  throw Error("A chave privada não pode ficar dentro do repositório.");
if (existsSync(path))
  throw Error("O arquivo já existe; não substituo uma chave existente.");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
  flag: "wx",
});
// No Windows, o modo acima não restringe nada: tira a herança e deixa só o
// usuário atual com acesso.
if (process.platform === "win32")
  execFileSync(
    "icacls",
    [path, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`],
    { stdio: "ignore" },
  );
const raw = publicKey.export({ format: "jwk" }).x; // 32 bytes, base64url
console.log(JSON.stringify({ id, ed25519: raw }));
