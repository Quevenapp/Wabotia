// Regras de publicação do formato 2, sem acesso a disco (testadas em
// tests/release-v2.test.ts). Usado por scripts/release.mjs e
// scripts/release-keygen.mjs.
import { relative, resolve, isAbsolute } from "node:path";

/** Estáticos que não vão no pacote: o catálogo e o guia em PDF ficam só no site. */
export const excludedAsset = (path) =>
  path === "releases" ||
  path.startsWith("releases/") ||
  /^guide\/.*\.pdf$/.test(path);

const semver = /^\d+\.\d+\.\d+$/;
const parts = (v) => v.split(".").map(Number);
/** a > b, em versões x.y.z. */
export function versionGreater(a, b) {
  if (!semver.test(a) || !semver.test(b)) return false;
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Ordem das versões: uma versão nova precisa ser maior que a publicada no
 * índice v2 e que a última do formato 1 (releases/latest.json, parado na
 * 0.20.0). Republicar a mesma versão só com o mesmo manifesto.
 */
export function checkVersionOrder({ version, current, frozen, manifestSha }) {
  if (!semver.test(version)) throw Error("Versão inválida.");
  if (frozen && !versionGreater(version, frozen.version))
    throw Error(
      `A versão ${version} precisa ser maior que a ${frozen.version}, a última do formato antigo.`,
    );
  if (current) {
    if (current.version === version) {
      if (current.manifest_sha256 !== manifestSha)
        throw Error(
          "Use uma versão nova; não substitua uma publicação existente.",
        );
    } else if (!versionGreater(version, current.version))
      throw Error(
        `A versão ${version} é menor que a publicada (${current.version}); as instalações recusam voltar de versão.`,
      );
  }
}

/** O caminho fica dentro da pasta do repositório? */
export function insideRepository(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Prazo de validade do índice assinado (dias); src/release.ts aceita até 180. */
export const INDEX_DAYS = 90;

/** Última versão do formato 1: releases/latest.json fica parado nela. */
export const LAST_FORMAT1 = "0.20.0";
