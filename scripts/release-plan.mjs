// Regras de publicação do formato 2, sem acesso a disco (testadas em
// tests/release-v2.test.ts). Usado por scripts/release.mjs.
//
// - A ponte (--bridge) é a última versão de formato 1: escreve o pacote
//   antigo, congela releases/latest.json nela e abre o índice v2.
// - Depois dela, toda versão sai só no formato 2: releases/latest.json nunca
//   mais muda, então uma instalação antiga só enxerga a ponte.

/** Índices a gravar. `bridge`: a versão ponte, registrada em v2/bridge.json. */
export function releaseOutputs({ bridge, version, existingBridge }) {
  if (bridge) {
    if (existingBridge && existingBridge.version !== version)
      throw Error(
        `A ponte já foi publicada (${existingBridge.version}). As próximas versões saem sem --bridge.`,
      );
    return {
      legacy: true,
      files: ["releases/latest.json", "releases/v2/latest.json", "releases/v2/bridge.json"],
      min_version: version,
    };
  }
  if (!existingBridge)
    throw Error(
      "Publique antes a versão ponte (npm run release -- --bridge): sem ela, as instalações antigas não chegam ao formato 2.",
    );
  return {
    legacy: false,
    files: ["releases/v2/latest.json"],
    min_version: existingBridge.version,
  };
}

/** Teto do pacote de formato 1 da ponte: as instalações até a 0.17.0 aceitam 20 MB. */
export const BRIDGE_LEGACY_LIMIT = 20 * 1024 * 1024;

/** Estáticos que não vão no pacote: o guia em PDF fica só no site oficial. */
export const excludedAsset = (path) =>
  path === "releases" ||
  path.startsWith("releases/") ||
  /^guide\/.*\.pdf$/.test(path);
