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

/** Metade do orçamento bruto de 48 MiB do envio; o leitor limita o lote. */
export const MAX_STATIC_ASSET_BYTES = 24 * 1024 * 1024;
export function checkStaticAssetSize(name, size) {
  if (size > MAX_STATIC_ASSET_BYTES)
    throw Error(
      `O arquivo estático ${name} excede 24 MiB. Reduza-o antes de publicar para caber no orçamento de envio do atualizador.`,
    );
}

/** A partir de quantos dias de emissão o índice publicado pede renovação. */
export const RENEW_AFTER_DAYS = 60;

/**
 * Aviso de renovação do índice publicado (null se ainda não é hora): a partir
 * de 60 dias da emissão, ou já vencido. Sem lembrete automático: o aviso
 * aparece quando alguém roda o release.mjs e na tela Sistema do site oficial.
 */
export function renewalNotice(index, at = Date.now()) {
  if (!index || !Number.isSafeInteger(index.expires)) return null;
  const left = Math.floor((index.expires - at) / 86400000);
  if (index.expires <= at)
    return `O índice publicado (${index.version}) VENCEU: as instalações recusam atualizar. Rode \`npm run release -- --renew\` (ou publique uma versão nova) e publique o site.`;
  if (at - index.issued_at >= RENEW_AFTER_DAYS * 86400000)
    return `O índice publicado (${index.version}) vence em ${left} dia(s). Rode \`npm run release -- --renew\` (ou publique uma versão nova) e publique o site.`;
  return null;
}

/**
 * Última versão publicada só no formato 1 (a 0.21.0). A ponte vem depois dela
 * e congela releases/latest.json em si mesma; sem o arquivo, vale esta.
 */
export const LAST_FORMAT1 = "0.21.0";

// ---------------------------------------------------------------------------
// Ponte (docs/ATUALIZACOES-FORMATO.md, "Versão ponte")
//
// A 0.21.0 só lê releases/latest.json (formato 1). A ponte é a última versão
// com pacote de formato 1: ela leva o leitor do formato 2 e congela o índice
// antigo em si mesma. Depois dela, toda versão sai só no formato 2.

/**
 * O que a publicação grava. `bridge`: esta é a ponte; `bridgeRecord`: o
 * releases/v2/bridge.json já gravado (ou null); `minVersion`: o
 * --min-version pedido (ou undefined).
 */
export function releaseOutputs({ bridge, version, bridgeRecord, minVersion }) {
  if (bridge) {
    if (bridgeRecord && bridgeRecord.version !== version)
      throw Error(
        `A ponte já foi publicada (${bridgeRecord.version}). As próximas versões saem sem --bridge.`,
      );
    if (minVersion && minVersion !== "0.0.0")
      throw Error(
        "A ponte não exige versão mínima: é ela que as instalações do formato 1 instalam.",
      );
    return { legacy: true, min_version: "0.0.0" };
  }
  if (!bridgeRecord)
    throw Error(
      "Publique antes a versão ponte (npm run release -- --bridge): sem ela, as instalações do formato 1 não chegam ao formato 2.",
    );
  // Depois da ponte, toda versão exige a ponte (ou mais) instalada.
  const min = minVersion || bridgeRecord.version;
  if (
    min !== bridgeRecord.version &&
    !versionGreater(min, bridgeRecord.version)
  )
    throw Error(
      `--min-version ${min} é menor que a ponte (${bridgeRecord.version}).`,
    );
  return { legacy: false, min_version: min };
}

/** Teto do pacote de formato 1: MAX_PACKAGE do src/release.ts da 0.21.0. */
export const LEGACY_MAX_PACKAGE = 24 * 1024 * 1024;

/**
 * Ponte enxuta (--slim): sem as telas do ERP do painel, só no pacote de
 * formato 1. São chunks carregados sob demanda (o index.html não os cita):
 * sem eles, só a tela do ERP deixa de abrir até a versão seguinte, de
 * formato 2, que traz tudo de volta.
 */
export const slimAsset = (name) => /^\/assets\/erp-[^/]+$/.test(name);

/**
 * As travas do leitor do formato 1 da 0.21.0 (src/release.ts, parsePackage
 * e validateIndex de fca4bb2) que dependem do conteúdo do pacote. O
 * scripts/erp/check-candidate.mjs passa o pacote pelo próprio leitor; esta
 * conferência para a publicação antes de gravar.
 */
export function legacyProblems(pkg, size) {
  const problems = [];
  if (size > LEGACY_MAX_PACKAGE)
    problems.push(`pacote com ${size} bytes, acima de ${LEGACY_MAX_PACKAGE}`);
  if (!(pkg.modules.length > 0 && pkg.modules.length < 64))
    problems.push(`${pkg.modules.length} módulos (precisa de 1 a 63)`);
  if (!(pkg.assets.length > 0 && pkg.assets.length <= 100))
    problems.push(`${pkg.assets.length} estáticos (precisa de 1 a 100)`);
  if (pkg.migrations.length > 100)
    problems.push(`${pkg.migrations.length} migrações (máximo 100)`);
  for (const f of pkg.modules)
    if (!/^[a-zA-Z0-9_./-]+$/.test(f.name) || f.type.length >= 120)
      problems.push(`módulo com nome ou tipo inválido: ${f.name}`);
  for (const f of pkg.assets)
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(f.name) || f.type.length >= 120)
      problems.push(`estático com nome ou tipo inválido: ${f.name}`);
  for (const m of pkg.migrations)
    if (
      !/^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) ||
      !(m.statements.length > 0 && m.statements.length <= 100) ||
      m.statements.some((s) => s.length >= 100000)
    )
      problems.push(`migração fora das travas: ${m.name}`);
  if (
    JSON.stringify(pkg.durable_migrations) !==
    JSON.stringify([{ tag: "v1", new_sqlite_classes: ["Coordinator"] }])
  )
    problems.push("durable_migrations diferente de v1/Coordinator");
  if (
    pkg.assets_config?.not_found_handling !== "single-page-application" ||
    JSON.stringify(pkg.assets_config?.run_worker_first) !==
      JSON.stringify(["/api/*", "/webhooks/*", "/internal/*"])
  )
    problems.push("assets_config diferente do que a 0.21.0 aceita");
  if (!pkg.modules.some((f) => f.name === pkg.main_module))
    problems.push("módulo principal ausente");
  return problems;
}
