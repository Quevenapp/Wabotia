#!/usr/bin/env node
// Matriz contratual B. Esta prova identifica a dona permitida, não atribui autoria humana por Git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REFERENCE = "20e15da9";
const words = value => value.trim().split(/\s+/);
const prefix = (base, names) => words(names).map(name => base + name);
const A = "mobile/android/app/src/main/java/br/com/queven/wabotia/";
const I = "mobile/ios/Wabotia/";
export const OWNERS = {
  "cn-base": words(`src/types.ts src/customer/contracts.ts src/customer/profile-contracts.ts src/customer/ports.ts
    src/channels.ts src/channel-contracts.ts src/channel-ports.ts migrations/0140_channels.sql
    migrations/0141_zernio_channel_accounts.sql migrations/0142_customer_channels_and_merges.sql
    migrations/0143_conversation_email.sql tests/cn-base.test.ts tests/cn-migrations.test.ts`),
  "cn-transporte": words(`src/zernio.ts src/engine.ts src/whatsapp.ts src/line-service.ts src/queue.ts src/web-steps.ts
    src/transport.ts src/signature.ts src/pii-mask.ts src/zernio-social.ts src/zernio-social-media.ts
    tests/cn-transporte.test.ts tests/cn-media.test.ts tests/cn-janelas.test.ts`),
  "cn-contas": words(`src/zernio-accounts.ts src/zernio-profile-resolution.ts src/integrations.ts src/connection-removal.ts
    src/number-router.ts web/NumberRouter.tsx web/admin/ConnectionDialog.tsx web/admin/ConnectionsPage.tsx
    web/ServicePanels.tsx src/channel-accounts.ts tests/cn-contas.test.ts tests/cn-contas-ui.test.ts`),
  "cn-identidade": words(`src/customer/identity.ts src/customer/local.ts src/customer/http.ts src/customer/profile.ts
    src/customer/history.ts src/contacts.ts src/contact-csv.ts src/protocol-lookup.ts web/ContactsPanel.tsx
    web/contact-profile/ContactProfile.tsx web/contact-profile/registry.ts web/contact-profile/model.ts
    web/contact-profile/profile.css src/customer/channel-identity.ts src/customer/merge.ts src/customer/merge-relations.ts
    web/contact-profile/ChannelsSection.tsx web/contact-profile/MergeContactsDialog.tsx tests/cn-identidade.test.ts
    tests/cn-juncao.test.ts tests/cn-identidade-ui.test.ts`),
  "cn-email": words(`src/email.ts src/access.ts web/EmailSection.tsx web/admin/UsersPage.tsx web/admin/ApplicationsPage.tsx
    src/conversation-email.ts tests/cn-email.test.ts tests/cn-email-ui.test.ts`),
  "cn-servidor": words(`src/index.ts src/service.ts src/coordinator.ts src/push.ts src/reports.ts src/channel-runtime.ts
    tests/cn-servidor.test.ts tests/cn-api.test.ts`),
  "cn-web": words(`web/ui/Avatar.tsx web/styles/tokens.css web/styles/base.css web/styles/chat.css web/app/AppContext.tsx
    web/lib/window.ts web/conversations/ConversationList.tsx web/conversations/useConversationList.ts
    web/conversations/ChatView.tsx web/conversations/Composer.tsx web/conversations/InfoPanel.tsx
    web/conversations/model.tsx web/conversations/dialogs.tsx web/conversations/TransferDialog.tsx
    web/admin/RecordsPages.tsx web/lib/demo.ts web/channels.ts web/ui/ChannelBadge.tsx
    web/conversations/EmailTranscriptDialog.tsx web/lib/demo-channels.ts tests/cn-web.test.ts tests/cn-demo.test.ts`),
  "cn-android": [
    ...prefix(A, `core/model/Models.kt core/net/WabotiaApi.kt ui/components/Avatar.kt ui/components/Window.kt
      ui/conversations/ConversationsScreen.kt ui/conversations/ConversationsViewModel.kt
      ui/conversations/ConversationScreen.kt ui/conversations/ConversationViewModel.kt
      ui/conversations/ConversationInfoScreen.kt ui/conversations/Composer.kt ui/conversations/Sheets.kt
      core/push/WabotiaMessagingService.kt core/push/Notifications.kt demo/DemoData.kt demo/DemoServer.kt
      core/model/ChannelModels.kt ui/components/ChannelBadge.kt ui/conversations/EmailTranscriptSheet.kt`),
    ...words(`mobile/android/app/src/test/java/br/com/queven/wabotia/core/model/ChannelModelsTest.kt
      mobile/android/app/src/test/java/br/com/queven/wabotia/demo/ChannelsDemoTest.kt tests/cn-android.test.ts scripts/cn-android-check.mjs`),
  ],
  "cn-ios": [
    ...prefix(I, `Core/Models.swift Core/Workspace.swift Core/WindowClock.swift Core/API/Endpoints.swift
      Core/Theme/Components.swift Core/Demo/DemoServer.swift Features/Conversations/ConversationsView.swift
      Features/Conversations/ConversationsViewModel.swift Features/Conversations/ConversationView.swift
      Features/Conversations/ConversationViewModel.swift Features/Conversations/ConversationInfoView.swift
      Features/Conversations/ConversationDetail+Contact.swift Features/Conversations/ComposerView.swift
      Core/ChannelModels.swift Features/Conversations/ChannelBadge.swift Features/Conversations/EmailTranscriptSheet.swift`),
    ...words(`mobile/ios/WabotiaTests/ChannelsTests.swift mobile/ios/WabotiaTests/ChannelsDemoTests.swift tests/cn-ios.test.ts`),
  ],
  "cn-aceite": words(`docs/EMAIL.md mobile/README.md mobile/DESIGN.md tests/cn-aceite.test.ts tests/cn-orcamento.test.ts
    tests/cn-baseline-probe.test.ts scripts/cn-baseline.mjs scripts/cn-bundle-check.mjs scripts/cn-ownership-check.mjs
    docs/CANAIS-PRIMEIRA-LEVA.md docs/CANAIS-ACEITE.md docs/CANAIS-ZERNIO.md`),
};

/** Exceções declaradas pelo orquestrador; não transferem a propriedade do arquivo. */
export const INTEGRATION_FIXES = [
  { file: "src/zernio.ts", owner: "cn-transporte", integrator: "cn-servidor",
    reason: "Respostas concorrentes compartilham os bytes já lidos, não um stream consumível uma vez.",
    test: "tests/cn-servidor.test.ts" },
  { file: "src/customer/channel-identity.ts", owner: "cn-identidade", integrator: "cn-servidor",
    reason: "Preservar o limite contratual de 1.024 caracteres para identificador opaco social.",
    test: "tests/cn-servidor.test.ts" },
];

export function ownershipIndex(owners = OWNERS) {
  const index = new Map();
  for (const [owner, files] of Object.entries(owners)) for (const file of files) {
    if (index.has(file)) throw Error(`Arquivo com duas donas: ${file} (${index.get(file)} / ${owner}).`);
    index.set(file, owner);
  }
  return index;
}

export function protectedFile(path) {
  return /^(?:src\/(?:erp|integrations|area-templates|modules)\/|web\/(?:erp|management)\/)/.test(path)
    || ["web/admin/ModulesPage.tsx", "package.json", "package-lock.json", "wrangler.jsonc", "src/release-keys.json"].includes(path)
    || /(?:^|\/)(?:gradle\.libs\.versions\.toml|libs\.versions\.toml)$/.test(path);
}

export function checkChanges(changes, owners = OWNERS) {
  const index = ownershipIndex(owners), errors = [];
  for (const { path, status } of changes) {
    if (protectedFile(path)) errors.push(`Frente protegida/configuração alterada: ${path}.`);
    if (!index.has(path)) errors.push(`Arquivo fora da matriz B: ${path}.`);
    if (status === "D") errors.push(`Arquivo removido nesta leva: ${path}.`);
  }
  for (const fix of INTEGRATION_FIXES) {
    if (index.get(fix.file) !== fix.owner || !fix.reason || !index.has(fix.test))
      errors.push(`Exceção integradora inválida: ${fix.file}.`);
  }
  return { errors, files: changes.map(change => ({ ...change, owner: index.get(change.path) || null,
    integrationFixes: INTEGRATION_FIXES.filter(fix => fix.file === change.path) })) };
}

/** Relações atuais de A6. Atualizar só após revisão explícita se outra frente acrescentar relações. */
export const REVIEWED_RELATIONS = words(`conversation_contacts.contact_id web_steps.contact_id agenda_appointments.contact_id
  os_orders.contact_id pedido_orders.contact_id reserva_bookings.contact_id mensalidade_subscriptions.contact_id
  os_people.contact_id mensalidade_payers.contact_id cond_people.contact_id ensino_guardians.contact_id
  ensino_enrollments.billing_contact_id saude_contact_links.contact_id customer_records.contact_id
  customer_sections.contact_id customer_phones.contact_id customer_phone_candidates.contact_id
  customer_phone_proofs.contact_id customer_channel_ids.contact_id`);
export const RELATION_EXCEPTIONS = {
  "contacts.erp_contact_id": "Identificador no ERP, não uma referência a contacts local; conflito bloqueia junção.",
  "customer_jobs.contact_id": "Jobs concluídos são históricos; jobs pendentes bloqueiam junção (A6).",
  "customer_merges.source_id": "Recibo histórico cifrado da junção; não reapontar o próprio registro.",
  "customer_merges.target_id": "Recibo histórico cifrado da junção; não reapontar o próprio registro.",
};

const identifier = value => value.replace(/^[`"\[]|[`"\]]$/g, "").toLowerCase();
const tokenPattern = /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[(),;]/g;

/** Lê DDL, inclusive FK com nome diferente de contact_id; não executa SQL ou código do módulo. */
export function contactReferences(sql) {
  const tokens = (sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").match(tokenPattern) || []).map(identifier);
  const found = new Set();
  const examine = (table, columns) => {
    for (const column of columns) {
      if (!column.length) continue;
      if (/^(?:.*_)?contact_id$/.test(column[0])) found.add(`${table}.${column[0]}`);
      const foreign = column.indexOf("foreign"), references = column.indexOf("references");
      if (references < 0 || column[references + 1] !== "contacts") continue;
      if (foreign < 0) { found.add(`${table}.${column[0]}`); continue; }
      const left = column.indexOf("(", foreign), right = column.indexOf(")", left);
      const local = column.slice(left + 1, right).filter(token => token !== ",");
      const remoteLeft = column.indexOf("(", references), remoteRight = column.indexOf(")", remoteLeft);
      const remote = column.slice(remoteLeft + 1, remoteRight).filter(token => token !== ",");
      remote.forEach((name, index) => { if (name === "id" && local[index]) found.add(`${table}.${local[index]}`); });
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "create" && tokens[i + 1] === "table") {
      let at = i + 2;
      if (tokens[at] === "if") at += 3;
      const table = tokens[at++];
      if (tokens[at] !== "(") continue;
      let depth = 1, column = [], columns = [];
      for (at++; at < tokens.length && depth; at++) {
        const token = tokens[at];
        if (token === "(") depth++;
        if (token === ")") depth--;
        if ((token === "," && depth === 1) || depth === 0) { columns.push(column); column = []; }
        else column.push(token);
      }
      examine(table, columns); i = at - 1;
    } else if (tokens[i] === "alter" && tokens[i + 1] === "table") {
      const table = tokens[i + 2];
      let at = i + 3;
      if (tokens[at] !== "add") continue;
      if (tokens[++at] === "column") at++;
      const end = tokens.indexOf(";", at);
      examine(table, [tokens.slice(at, end < 0 ? undefined : end)]);
    }
  }
  return [...found].sort();
}

/** Sintaxe fechada do registro atual: objetos literais e lista literal com map de contact_id. */
export function mergeAllowlist(source) {
  const start = source.indexOf("export const MERGE_RELATIONS");
  const end = source.indexOf("export interface ManifestTable", start);
  if (start < 0 || end < 0) throw Error("Registro de relações mudou de formato; revisar o verificador da allowlist.");
  const declaration = source.slice(start, end), refs = new Set();
  for (const match of declaration.matchAll(/\{\s*table:\s*"([\w]+)",\s*owner:\s*"([\w]+)"/g)) refs.add(`${match[1]}.${match[2]}`);
  for (const match of declaration.matchAll(/\.\.\.\[([^\]]+)\]\.map\(table\s*=>\s*\(\{\s*table,\s*owner:\s*"(\w+)"/g))
    for (const table of match[1].matchAll(/"(\w+)"/g)) refs.add(`${table[1]}.${match[2]}`);
  if (!refs.size) throw Error("Não foi possível conferir a allowlist real de junção.");
  return [...refs].sort();
}

export function checkRelations(references, allowlist) {
  const reviewed = new Set(REVIEWED_RELATIONS), actual = new Set(allowlist), errors = [];
  for (const reference of references) {
    if (!(reference in RELATION_EXCEPTIONS) && !reviewed.has(reference))
      errors.push(`Relação cadastral nova exige revisão da allowlist antes do aceite: ${reference}.`);
    if (reviewed.has(reference) && !actual.has(reference)) errors.push(`Relação não coberta pelo adaptador de junção: ${reference}.`);
  }
  for (const reference of reviewed) {
    if (!references.includes(reference)) errors.push(`Relação contratual ausente do schema lido: ${reference}.`);
    if (!actual.has(reference)) errors.push(`Allowlist de junção omite relação de A6: ${reference}.`);
  }
  for (const reference of actual) if (!reviewed.has(reference))
    errors.push(`Adaptador contém relação sem revisão registrada: ${reference}.`);
  return { references, allowlist, exceptions: RELATION_EXCEPTIONS, errors };
}

function inspectSources() {
  const index = ownershipIndex();
  const migrations = readdirSync(join(root, "migrations")).filter(name => name.endsWith(".sql")).sort();
  const references = [...new Set(migrations.flatMap(name => contactReferences(readFileSync(join(root, "migrations", name), "utf8"))))].sort();
  const allowlist = mergeAllowlist(readFileSync(join(root, "src", "customer", "merge-relations.ts"), "utf8"));
  const relations = checkRelations(references, allowlist);
  const missing = [...index.keys()].filter(file => !existsSync(join(root, file)));
  const encodingErrors = [];
  for (const file of OWNERS["cn-aceite"]) {
    if (!existsSync(join(root, file))) continue;
    const bytes = readFileSync(join(root, file));
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { encodingErrors.push(`UTF-8 inválido: ${file}.`); }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encodingErrors.push(`BOM proibido: ${file}.`);
    if (bytes.includes(13)) encodingErrors.push(`Quebra de linha diferente de LF: ${file}.`);
  }
  return { ownerCount: Object.keys(OWNERS).length, fileCount: index.size,
    missing, relations, encoding: { files: OWNERS["cn-aceite"].length, errors: encodingErrors },
    errors: [...relations.errors, ...encodingErrors, ...missing.map(file => `Arquivo da matriz ausente: ${file}.`)] };
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function selfTest() {
  assert.throws(() => ownershipIndex({ a: ["x"], b: ["x"] }), /duas donas/);
  assert.equal(ownershipIndex().get("src/integrations.ts"), "cn-contas");
  assert.equal(protectedFile("src/integrations.ts"), false);
  assert.equal(protectedFile("src/integrations/example.ts"), true);
  assert.ok(checkChanges([{ path: "package.json", status: "M" }]).errors.length);
  assert.ok(checkChanges([{ path: "tests/legado.test.ts", status: "M" }]).errors.length);
  assert.equal(checkChanges([{ path: "src/zernio.ts", status: "M" }]).errors.length, 0);
  const refs = contactReferences(`-- comentário\nCREATE TABLE nova (id TEXT, pessoa TEXT, contact_id TEXT,
    FOREIGN KEY(pessoa,profile_id) REFERENCES contacts(id,profile_id));
    ALTER TABLE outra ADD COLUMN responsavel TEXT REFERENCES contacts(id);`);
  assert.deepEqual(refs, ["nova.contact_id", "nova.pessoa", "outra.responsavel"]);
  assert.ok(checkRelations([...REVIEWED_RELATIONS, "outra.responsavel"], REVIEWED_RELATIONS).errors.some(error => error.includes("nova exige revisão")));
  assert.equal(checkRelations(REVIEWED_RELATIONS, REVIEWED_RELATIONS).errors.length, 0);
  console.log("Autotestes da propriedade e detecção de relações aprovados; nenhum Git foi executado.");
}

function main() {
  if (process.argv.includes("--self-test")) { selfTest(); return; }
  const sourceOnly = process.argv.includes("--source-check");
  if (process.argv.slice(2).some(arg => arg !== "--source-check")) throw Error("Use sem argumentos, --source-check ou --self-test.");
  const sources = inspectSources();
  if (sourceOnly) {
    console.log(JSON.stringify(sources, null, 2));
    if (sources.errors.length) throw Error("Inspeção local reprovada; o diff Git ainda não foi conferido.");
    console.log("Matriz e relações locais conferidas. Propriedade do diff pendente da verificação externa com Git.");
    return;
  }
  const commit = git(["rev-parse", `${REFERENCE}^{commit}`]).trim();
  const resultCommit = git(["rev-parse", "HEAD"]).trim();
  const parts = git(["diff", "--name-status", "--no-renames", "-z", commit, "--"]).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) changes.push({ status: parts[i], path: parts[i + 1] });
  for (const path of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))
    changes.push({ status: "?", path });
  const checked = checkChanges(changes);
  checked.files = checked.files.map(file => ({ ...file,
    sha256: existsSync(join(root, file.path)) ? createHash("sha256").update(readFileSync(join(root, file.path))).digest("hex") : null }));
  const errors = [...sources.errors, ...checked.errors];
  const diff = git(["diff", "--no-ext-diff", "--binary", commit, "--"]);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), reference: REFERENCE, commit, resultCommit,
    diffSha256: createHash("sha256").update(diff).digest("hex"), ...sources, ...checked, errors,
    integrationFixes: INTEGRATION_FIXES, passed: errors.length === 0,
    limitation: "Dona contratual conferida por caminho. Git não prova a autoria por tarefa; trechos autorizados de arquivos compartilhados também exigem revisão humana do diff." };
  const directory = join(root, "output", "cn-aceite");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ownership.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (errors.length) throw Error(errors.join("\n"));
  console.log(`Propriedade conferida: ${changes.length} arquivos alterados, ${sources.ownerCount} donas, nenhuma sobreposição ou arquivo protegido alterado.`);
  console.log("Relações cadastrais conferidas contra a allowlist. Relatório: output/cn-aceite/ownership.json.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
