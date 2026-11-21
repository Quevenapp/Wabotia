// Guarda da marca: o produto se chama Vinki (decisão do dono, 21/11/2026).
// Falha se "Wabotia" (em qualquer caixa) aparecer em texto que chega à tela:
//   - painel e site (web/**, index.html, manifest do PWA);
//   - servidor (src/** e packages/**): strings que viram mensagem, e-mail, PDF,
//     impressão, notificação, menu ou modelo de área;
//   - apps: strings.xml e strings do Kotlin (Android), strings do Swift e
//     nomes/avisos do Info.plist em project.yml (iOS).
// Comentários não contam. Identificadores técnicos que ficam como estão
// (prefixos, variáveis de ambiente, cabeçalhos, chaves guardadas, cookies,
// domínios, id do app) estão na lista explícita ALLOWED abaixo; cada token com
// "wabotia" precisa casar inteiro com uma das entradas.
//
// Rodar: node --test tests/marca-vinki.test.mjs  (ou npm run test:marca)
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
function walk(dir) {
  if (!existsSync(`${root}/${dir}`)) return [];
  return readdirSync(`${root}/${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "node_modules" ? [] : walk(`${dir}/${entry.name}`)
      : [`${dir}/${entry.name}`]);
}

/**
 * Identificadores técnicos permitidos (item 4 da tarefa do rebrand): mudar não
 * traz nada a quem usa e arrisca quebrar instalações, apps e integrações.
 */
export const ALLOWED = [
  // Id técnico curto: cookie de sessão, serviço do /api/health, nome do plugin e do
  // perfil do Hermes, id da categoria de protocolo "wabotia".
  /^wabotia$/,
  // Id do app nas lojas (Android applicationId e bundle do iOS) e esquema de URL.
  /^br\.com\.queven\.wabotia(\.[\w.]+)?$/,
  // Variáveis de ambiente e marcadores de teste do atualizador.
  /^(env\.|process\.env\.)?WABOTIA_[A-Z0-9_]+$/,
  /^__WABOTIA_[A-Z0-9_]+__$/,
  // Cabeçalhos HTTP (internos, webhooks assinados, e-mail de teste, plugin) e user agents.
  /^X-Wabotia-[A-Za-z-]+$/,
  /^x-wabotia-[a-z-]+$/,
  /^Wabotia-(Signature|Timestamp|Event-Id)$/,
  /^Wabotia-(Android|iOS|Connector|ERP|Example)(\/.*)?$/,
  // Códigos de erro trocados entre o motor do ERP e o servidor/app (não são texto de tela).
  /^ERP_WABOTIA_[A-Z_]+$/,
  /^not_wabotia$/,
  // Assinatura fictícia do token interno que o servidor entrega ao motor do ERP.
  /^\.wabotia$/,
  // Chaves guardadas no navegador e no app (localStorage, sessionStorage, UserDefaults).
  /^wabotia:[\w:.-]*$/,
  /^wabotia\.(cache|secure|secure\.fallback|prefs|notifications|device|queue)$/,
  /^wabotia-demo-[a-z]+:[\w$]*$/,
  /^wabotiaRouteIndex$/,
  // Chaves de Symbol.for no servidor (cache de leitura do banco, fechamento de comandos).
  /^wabotia\.(readCache|prefetch|commandClosing)$/,
  // Separador de partes MIME dos e-mails enviados.
  /^wabotia_$/,
  // Domínios: site e catálogo de atualização, gateway de notificações, instalação de
  // teste do dono e domínios reservados de exemplo/teste.
  /^(https?:\/\/)?(push\.|demo\.|erp\.|erp-api\.)?wabotia\.(queven\.app|queven\.com\.br|fagoo\.com\.br|invalid|test|localhost|example|internal|local|empresa\.example|exemplo\.com\.br|suaempresa\.com\.br)(:\d+)?(\/[\w\-./#?=&%{}~:]*)?$/,
  /^[\w.+-]+@wabotia\.(invalid|test|example)$/,
  // Arquivos e caminhos: instalador, guias em PDF, rotas internas, pastas de configuração.
  /^(\/|\.\\|https?:\/\/[\w.-]+\/)?(guide\/)?(install-wabotia\.mjs|wabotia-instalacao\.pdf|wabotia-meta-whatsapp\.pdf)$/,
  // Caminhos de API e de rotas internas do ERP.
  /^\/v1\/system\/wabotia(\/[a-z]+)?$/,
  /^\/p\/wabotia\/v1\/?$/,
  /^\/preferencias\/sistema\/wabotia$/,
  /^\/rest\/v1\/rpc\/erp_wabotia_[a-z_]+$/,
  /^fagoo\/wabotia\/v1\/$/,
  // Pastas de configuração e trabalho nas máquinas do Hermes e do instalador.
  /^(~?\/\.config\/|\.config\/|\/opt\/data\/|\/tmp\/)wabotia[\w./-]*$/,
  // Prefixos técnicos com hífen: protocolos de WebSocket, assinaturas e hashes
  // versionados, nomes de recursos e pacotes, escopo de CSS, plugin e transporte do Hermes.
  // Inclui pastas temporárias do app iOS (voz, mídia, vídeo, demonstração), o apelido da chave
  // do aparelho no Android Keystore e o token de sessão fictício da porta do ERP.
  /^wabotia-(display|media|media\/|voice|video|export|demo|demo-indisponivel|demo-caixa|device|cookie|qr|seed|seed-|restore-|exportacao-[\w.{}$-]*|module-origin-v1|release-(index|manifest)-v2\\?n?|customer-command-v1|contador-v1\|?|sped-v1\|?|erp-[a-z-]+-v1:?|erp-system:|fagoo-scope|connector\.json|transport\/?|hermes(-local|-vps)?|push-gateway|atendimento|staging-verticais|prepare-hermes\.py|conector-linux\.sh|connection[\w./-]*|)$/,
  /^(hermes-wabotia-admin|cloudflared-wabotia)\.service$/,
  /^exportacao-wabotia$/,
  // Tabelas e restrições do banco (nomes ficam).
  /^(public\.|public__)?erp_wabotia_(state|pairing)(_pkey|_id_check|_[a-z_]+_check)?$/,
  /^wabotia_(transport|mentioned|native_content|media_id)$/,
  /^parameter\.wabotia_media_id$/,
  /^gateway\.platforms\.wabotia(\.[a-z]+)?$/,
];

const TOKEN = /[A-Za-z0-9_.:/@~${}\\|-]*wabotia[A-Za-z0-9_.:/@~${}\\|-]*/gi;
const allowed = (token) => ALLOWED.some((pattern) => pattern.test(token));
function offending(text) {
  const tokens = [];
  for (const raw of text.match(TOKEN) ?? []) {
    // Pontuação de fim de frase não faz parte do identificador.
    const token = raw.replace(/[.:,;|\\-]+$/, "").replace(/^[-:|]+/, "");
    if (!allowed(token) && !allowed(raw)) tokens.push(raw);
  }
  return tokens;
}

/** Strings e textos JSX de um arquivo TS/TSX/JS, sem comentários. */
function tsTexts(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(m?js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  (function visit(node) {
    // Caminho de módulo em import/export (nome de arquivo, não texto de tela).
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      if (/wabotia/i.test(node.text)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        out.push([line, node.text]);
      }
    }
    ts.forEachChild(node, visit);
  })(file);
  return out;
}

/** Strings de Kotlin e Swift (inclusive """…""" e #"…"#), sem comentários. */
function cLikeTexts(text) {
  const out = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < n && depth) {
        if (text[i] === "\n") line++;
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; continue; }
        if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    let hashes = 0;
    while (text[i + hashes] === "#") hashes++;
    if (text[i + hashes] === '"') {
      const start = line;
      const triple = text.startsWith('"""', i + hashes);
      const close = (triple ? '"""' : '"') + "#".repeat(hashes);
      i += hashes + (triple ? 3 : 1);
      let body = "";
      while (i < n && !text.startsWith(close, i)) {
        if (text[i] === "\\" && !hashes) { body += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
        if (text[i] === "\n") { line++; if (!triple) break; }
        body += text[i++];
      }
      i += close.length;
      if (/wabotia/i.test(body)) out.push([start, body]);
      continue;
    }
    i += hashes || 1;
  }
  return out;
}

function lineTexts(text, keep = () => true) {
  return text.split("\n").map((value, index) => [index + 1, value])
    .filter(([, value]) => /wabotia/i.test(value) && keep(value));
}

const isTest = (path) => /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(path);
const sources = [
  // Painel, site e o ERP do painel.
  ...walk("web").filter((p) => /\.(tsx?|mjs)$/.test(p) && !isTest(p) && !/\.d\.ts$/.test(p) && !p.startsWith("web/erp/qa/")),
  // Servidor: o que vira texto de tela, e-mail, PDF, impressão e mensagem dos canais.
  ...walk("src").filter((p) => /\.(ts|mjs|js)$/.test(p) && !isTest(p) && !/\.d\.ts$/.test(p)),
  ...walk("packages").filter((p) => /\/src\/.*\.(ts|mjs|js)$/.test(p) && !isTest(p) && !/\.d\.m?ts$/.test(p)),
].map((path) => ({ path, texts: () => tsTexts(path, read(path)) }));

const android = "mobile/android/app/src/main";
const others = [
  ...walk(`${android}/java`).filter((p) => p.endsWith(".kt")).map((path) => ({ path, texts: () => cLikeTexts(read(path)) })),
  ...walk(`${android}/res`).filter((p) => /\/values[^/]*\/strings\.xml$/.test(p))
    .map((path) => ({ path, texts: () => lineTexts(read(path)) })),
  ...walk("mobile/ios/Wabotia").filter((p) => p.endsWith(".swift")).map((path) => ({ path, texts: () => cLikeTexts(read(path)) })),
  // Info.plist do iOS: nome exibido e avisos de permissão.
  { path: "mobile/ios/project.yml", texts: () => lineTexts(read("mobile/ios/project.yml"),
    (value) => /^\s*(CFBundleDisplayName|CFBundleName|NS\w+UsageDescription)\s*:/.test(value)) },
  // Título da aba, metadados de compartilhamento e manifest do PWA.
  { path: "index.html", texts: () => lineTexts(read("index.html")) },
  { path: "public/manifest.webmanifest", texts: () => lineTexts(read("public/manifest.webmanifest")) },
];

function scan(files) {
  const failures = [];
  for (const { path, texts } of files) {
    if (!/wabotia/i.test(read(path))) continue;
    for (const [line, text] of texts()) {
      const bad = offending(text);
      if (bad.length) failures.push(`${path}:${line}: ${bad.join(", ")} em "${text.trim().replace(/\s+/g, " ").slice(0, 140)}"`);
    }
  }
  return failures;
}

test("o painel, o site e o servidor não mostram o nome antigo (Wabotia)", () => {
  assert.ok(sources.length > 500, "a varredura achou poucos arquivos: o caminho da raiz mudou?");
  assert.deepEqual(scan(sources), [], "troque por Vinki ou, se for identificador técnico, acrescente-o a ALLOWED com o motivo");
});

test("os apps (Android e iOS) não mostram o nome antigo (Wabotia)", () => {
  assert.ok(others.length > 100, "a varredura dos apps achou poucos arquivos");
  assert.deepEqual(scan(others), [], "troque por Vinki ou, se for identificador técnico, acrescente-o a ALLOWED com o motivo");
  assert.match(read(`${android}/res/values/strings.xml`), /<string name="app_name">Vinki<\/string>/);
  assert.match(read("mobile/ios/project.yml"), /^\s*CFBundleDisplayName: Vinki$/m);
});

test("a lista de permitidos não libera o nome como palavra de tela", () => {
  for (const phrase of ["Wabotia", "O Wabotia", "Wabotia.", "Atualizar Wabotia", "wabotia-chaves-nova-instalacao.txt", "Wabotia · Queven"])
    assert.notDeepEqual(offending(phrase), [], phrase);
  for (const id of ["X-Wabotia-Profile", "WABOTIA_UPDATE_TOKEN", "wabotia:theme", "https://wabotia.queven.app/install", "br.com.queven.wabotia", "Wabotia-Signature"])
    assert.deepEqual(offending(id), [], id);
});

test("a marca nova está nas telas de entrada: título, manifest, logo e rodapé", () => {
  assert.match(read("index.html"), /<title>Vinki — /);
  assert.match(read("index.html"), /rel="manifest" href="\/manifest\.webmanifest"/);
  const manifest = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(manifest.name, "Vinki");
  for (const icon of manifest.icons) assert.ok(existsSync(`${root}/public${icon.src}`), icon.src);
  assert.match(read("web/ui/misc.tsx"), /aria-label="Vinki"/);
  assert.match(read("web/admin/AdminArea.tsx"), /Vinki · Queven/);
});
