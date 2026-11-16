// Assinatura das versões (Ed25519), sem acesso a disco. Usado por
// scripts/release.mjs; testado em tests/installer.test.mjs contra o
// verificador de src/release.ts. Nunca imprime nem registra a chave privada.
import { Buffer } from "node:buffer";
import { createPublicKey, sign, verify } from "node:crypto";
import { INDEX_DAYS } from "./release-plan.mjs";

/** Mesmo texto de SIGNATURE_DOMAIN em src/release.ts (conferido nos testes). */
export const SIGNATURE_DOMAIN = {
  index: "wabotia-release-index-v2\n",
  manifest: "wabotia-release-manifest-v2\n",
};

/**
 * Arquivo de assinatura (.sig) de um índice ou manifesto. `signer` é
 * `{id, key}` com a chave privada já carregada (KeyObject); `publicKeys` é a
 * lista de src/release-keys.json. Confere a assinatura antes de devolver:
 * chave fora da lista ou assinatura que não confere param a publicação.
 */
export function signatureFile(kind, bytes, signer, publicKeys) {
  const data = Buffer.concat([
    Buffer.from(SIGNATURE_DOMAIN[kind], "utf8"),
    Buffer.from(bytes),
  ]);
  const signature = sign(null, data, signer.key);
  const entry = publicKeys.find((k) => k.id === signer.id);
  if (!entry) throw Error(`Chave ${signer.id} fora de src/release-keys.json.`);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: entry.ed25519 },
    format: "jwk",
  });
  if (!verify(null, data, publicKey, signature))
    throw Error("A assinatura gerada não confere com a chave pública embutida.");
  return JSON.stringify({
    format: 1,
    algorithm: "Ed25519",
    key_id: signer.id,
    signature: signature.toString("base64"),
  });
}

/** Qual chave pública da lista corresponde a esta chave privada. */
export function signerFor(privateKey, publicKeys) {
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw Error("A chave de assinatura precisa ser Ed25519.");
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
  const entry = publicKeys.find((k) => k.ed25519 === x);
  if (!entry)
    throw Error(
      "A chave de assinatura não corresponde a nenhuma chave pública de src/release-keys.json.",
    );
  return { id: entry.id, key: privateKey };
}

/** Índice assinado com prazo: emitido agora, vale INDEX_DAYS dias. */
export function withValidity(index, at = Date.now()) {
  return { ...index, issued_at: at, expires: at + INDEX_DAYS * 86400000 };
}
