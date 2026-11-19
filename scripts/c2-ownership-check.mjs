#!/usr/bin/env node
// Matriz B + exceções expressas do orquestrador. Não atribui autoria pelo Git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { ownershipIndex, contactReferences, mergeAllowlist, checkRelations } from './cn-ownership-check.mjs';

export const REFERENCE = '13a9d9c3';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const words = value => value.trim().split(/\s+/);
const prefix = (base, names) => words(names).map(name => base + name);
const A = 'mobile/android/app/src/main/java/br/com/queven/wabotia/';
const I = 'mobile/ios/Wabotia/';
export const OWNERS = {
  'c2-base': words(`package.json package-lock.json src/types.ts src/channels.ts src/channel-contracts.ts
    src/channel-ports.ts src/channel-runtime.ts src/index.ts src/service.ts src/coordinator.ts src/engine.ts
    src/delivery.ts src/zernio.ts src/channel-accounts.ts src/integrations.ts src/connection-removal.ts
    src/line-service.ts src/whatsapp.ts src/signature.ts src/email.ts src/pii-mask.ts src/push.ts src/reports.ts
    src/customer/contracts.ts src/customer/channel-identity.ts src/customer/identity.ts src/customer/history.ts
    src/protocol-lookup.ts web/channels.ts web/ui/ChannelBadge.tsx web/conversations/model.tsx
    web/conversations/ChatView.tsx web/conversations/Composer.tsx web/conversations/MessageList.tsx
    web/conversations/InfoPanel.tsx web/admin/ConnectionDialog.tsx web/admin/ConnectionsPage.tsx
    web/admin/RecordsPages.tsx web/NumberRouter.tsx web/ServicePanels.tsx web/contact-profile/ContactProfile.tsx
    web/contact-profile/ChannelsSection.tsx web/lib/demo-channels.ts src/channel-c2-contracts.ts
    src/channel-extension-registry.ts src/channel-extension-kernel.ts src/channel-extension-stubs.ts
    web/channel-extension-contracts.ts web/channel-extensions.ts migrations/0144_channel_extensions.sql
    migrations/0145_comments_telegram_tiktok.sql migrations/0146_google_reviews.sql migrations/0147_email_channel.sql
    tests/c2-base.test.ts tests/c2-migrations.test.ts tests/c2-fixtures.ts scripts/c2-dependency-size.mjs`),
  'c2-comentarios': words(`src/c2/comments.ts src/c2/comments-provider.ts tests/c2-comentarios.test.ts tests/c2-comentarios-outbox.test.ts`),
  'c2-telegram': words(`src/c2/telegram.ts src/c2/telegram-provider.ts src/c2/telegram-media.ts tests/c2-telegram.test.ts tests/c2-telegram-media.test.ts`),
  'c2-google': words(`src/c2/google-reviews.ts src/c2/google-provider.ts tests/c2-google.test.ts tests/c2-google-sync.test.ts`),
  'c2-email': words(`src/c2/email-channel.ts src/c2/email-ingress.ts src/c2/email-mime.ts src/c2/email-provider.ts tests/c2-email.test.ts tests/c2-email-mime.test.ts tests/c2-email-outbox.test.ts`),
  'c2-tiktok': words(`src/c2/tiktok.ts src/c2/tiktok-provider.ts tests/c2-tiktok.test.ts tests/c2-tiktok-quota.test.ts`),
  'c2-web': [
    ...prefix('web/c2/', `register.ts CommentsPanel.tsx TelegramConnectionFields.tsx GoogleReviewsPage.tsx
      EmailConnectionFields.tsx EmailConversationFields.tsx ContactChannelActions.tsx ChannelMessageMeta.tsx
      TikTokQuota.tsx ChannelMarks.tsx styles.css demo.ts`),
    ...words('tests/c2-web.test.ts tests/c2-demo.test.ts'),
  ],
  'c2-android': [
    ...prefix(A, `core/model/Models.kt core/model/ChannelModels.kt core/net/WabotiaApi.kt
      ui/components/ChannelBadge.kt ui/components/Window.kt ui/conversations/ConversationsScreen.kt
      ui/conversations/ConversationScreen.kt ui/conversations/ConversationInfoScreen.kt
      ui/conversations/ConversationViewModel.kt ui/conversations/Composer.kt ui/conversations/MessageBubble.kt
      demo/DemoData.kt demo/DemoServer.kt demo/ChannelsSecondWave.kt`),
    ...words(`mobile/android/app/src/test/java/br/com/queven/wabotia/core/model/ChannelsSecondWaveTest.kt
      mobile/android/app/src/test/java/br/com/queven/wabotia/demo/ChannelsSecondWaveDemoTest.kt
      tests/c2-android.test.ts scripts/c2-android-check.mjs`),
  ],
  'c2-ios': [
    ...prefix(I, `Core/Models.swift Core/ChannelModels.swift Core/WindowClock.swift Core/API/Endpoints.swift
      Features/Conversations/ChannelBadge.swift Features/Conversations/ConversationsView.swift
      Features/Conversations/ConversationView.swift Features/Conversations/ConversationInfoView.swift
      Features/Conversations/ConversationViewModel.swift Features/Conversations/ComposerView.swift
      Features/Conversations/MessageBubbleView.swift Core/Demo/DemoServer.swift Core/Demo/ChannelsSecondWave.swift`),
    ...words(`mobile/ios/WabotiaTests/ChannelsSecondWaveTests.swift mobile/ios/WabotiaTests/ChannelsSecondWaveDemoTests.swift tests/c2-ios.test.ts`),
  ],
  'c2-integra': words('wrangler.jsonc web/main.tsx src/c2-entry/index.ts src/c2-entry/install.ts tests/c2-integra.test.ts tests/c2-entry.test.ts'),
  'c2-aceite': words(`docs/EMAIL.md mobile/README.md mobile/DESIGN.md tests/c2-aceite.test.ts tests/c2-orcamento.test.ts
    tests/c2-baseline-probe.test.ts scripts/c2-baseline.mjs scripts/c2-bundle-check.mjs scripts/c2-ownership-check.mjs
    docs/CANAIS-SEGUNDA-LEVA.md docs/CANAIS-SEGUNDA-LEVA-ACEITE.md docs/CANAIS-EMAIL-RECEBIMENTO.md docs/CANAIS-FORMATOS-PENDENTES.md`),
  // Expectativas autorizadas e hooks centrais observados na integração recebida.
  'orquestrador': words('tests/cn-contas.test.ts tests/cn-servidor.test.ts src/contacts.ts src/customer/http.ts'),
};

export const EXCEPTIONS = [
  { files: ['src/c2-entry/install.ts', 'src/index.ts', 'wrangler.jsonc'], reason: 'Composição instalada em src/index.ts, que continua main. A configuração de infraestrutura permanece idêntica.' },
  { files: OWNERS['c2-base'].filter(file => /^(src|web)\//.test(file)), reason: 'Arquivos centrais alterados pela base e pela integração, autorizado pelo orquestrador; propriedade original preservada.' },
  { files: ['src/contacts.ts', 'src/customer/http.ts'], reason: 'Integração já presente: exclusão e replay retomam limpeza de e-mail via eraseContactChannels; não muda módulos.' },
  { files: ['tests/cn-contas.test.ts', 'tests/cn-servidor.test.ts'], reason: 'Duas expectativas da primeira leva atualizadas pela integração com autorização.' },
  { files: prefix(I, 'Core/ChannelModels.swift Core/Demo/ChannelsSecondWave.swift Core/Demo/DemoServer.swift'), reason: 'Orquestrador corrigiu inferência de literal, acesso sobreposto a rows e validação CRLF do assunto no iOS.' },
  { files: ['src/channel-extension-registry.ts', 'tests/c2-fixtures.ts', 'tests/c2-base.test.ts'], reason: 'Orquestrador isolou troca de descritores de teste da instalação automática de produção.' },
  { files: ['scripts/c2-dependency-size.mjs'], reason: 'Aceite corrigiu leitura de JSONC com vírgula final e isolou ambiente/credenciais do dry-run; autotestes cobrem os dois casos.' },
];

export function protectedFile(file) {
  return /^(?:src\/(?:erp|integrations|area-templates|modules)\/|web\/(?:erp|management)\/)/.test(file)
    || ['src/access.ts', 'web/admin/ModulesPage.tsx', 'web/lib/demo.ts'].includes(file);
}
export function checkChanges(changes) {
  const index = ownershipIndex(OWNERS), errors = [];
  for (const { path, status } of changes) {
    if (!index.has(path)) errors.push(`Arquivo fora da matriz B/exceções: ${path}.`);
    if (protectedFile(path)) errors.push(`Frente protegida alterada: ${path}.`);
    if (status === 'D') errors.push(`Remoção não autorizada: ${path}.`);
  }
  return { errors, files: changes.map(change => ({ ...change, owner: index.get(change.path) ?? null,
    exceptions: EXCEPTIONS.filter(item => item.files.includes(change.path)).map(item => item.reason) })) };
}

export function checkInfrastructure(base, current) {
  const errors = [];
  try { assert.deepEqual(current, base); } catch { errors.push('wrangler.jsonc mudou: bindings, main, classe, nome, cron e assets devem permanecer iguais.'); }
  if (current.main !== 'src/index.ts') errors.push('main deve continuar src/index.ts.');
  if (JSON.stringify(current.durable_objects?.bindings) !== JSON.stringify([{ name: 'COORDINATOR', class_name: 'Coordinator' }]))
    errors.push('Durable Object diferente do Coordinator único.');
  return errors;
}
export function checkDependency(baseManifest, manifest, baseLock, lock) {
  const errors = [];
  if (manifest.dependencies?.['postal-mime'] !== '4.2.1' || lock.packages?.['']?.dependencies?.['postal-mime'] !== '4.2.1'
      || lock.packages?.['node_modules/postal-mime']?.version !== '4.2.1')
    errors.push('postal-mime deve estar fixado em 4.2.1 no manifesto e lock.');
  const cleanManifest = structuredClone(manifest), cleanLock = structuredClone(lock);
  delete cleanManifest.dependencies?.['postal-mime'];
  delete cleanLock.packages?.['']?.dependencies?.['postal-mime'];
  delete cleanLock.packages?.['node_modules/postal-mime'];
  try { assert.deepEqual(cleanManifest, baseManifest); assert.deepEqual(cleanLock, baseLock); }
  catch { errors.push('Dependência, script ou metadado alterado além de postal-mime.'); }
  return errors;
}
export const TABLES = words(`channel_delivery_state channel_public_grants channel_comments telegram_callbacks
  tiktok_send_slots reviews channel_sync_state email_channel_addresses email_channel_inbox email_channel_blocks email_channel_probes`);
export function checkMigrations(sources) {
  const errors = [], tables = [];
  for (const source of sources) {
    const sql = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
      const table = /^CREATE TABLE\s+(\w+)\s*\(/i.exec(statement);
      const index = /^CREATE (?:UNIQUE )?INDEX\s+\w+\s+ON\s+(\w+)\s*\(/i.exec(statement);
      if (table) { tables.push(table[1]); if (!TABLES.includes(table[1])) errors.push(`Tabela inesperada: ${table[1]}.`); }
      else if (!index || !TABLES.includes(index[1])) errors.push('Migração não aditiva ou índice em tabela legada; revisar custo antes de aceitar.');
    }
  }
  if (new Set(tables).size !== TABLES.length || tables.length !== TABLES.length) errors.push('Conjunto de tabelas 0144–0147 incompleto ou duplicado.');
  return errors;
}
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const read = file => readFileSync(join(root, file), 'utf8');
const hash = data => createHash('sha256').update(data).digest('hex');
const config = text => { const errors = []; const value = parseJsonc(text, errors, { allowTrailingComma: true }); assert.equal(errors.length, 0, 'JSONC inválido.'); return value; };

export function selfTest() {
  assert.throws(() => ownershipIndex({ a: ['x'], b: ['x'] }), /duas donas/);
  assert.equal(ownershipIndex(OWNERS).get('src/integrations.ts'), 'c2-base');
  assert.equal(checkChanges([{ path: 'src/integrations.ts', status: 'M' }]).errors.length, 0);
  for (const path of ['src/integrations/x.ts', 'web/lib/demo.ts', 'src/access.ts', 'migrations/0140_channels.sql', 'tests/legado.test.ts'])
    assert.ok(checkChanges([{ path, status: 'M' }]).errors.length);
  assert.ok(checkChanges([{ path: 'src/c2/email-channel.ts', status: 'D' }]).errors.length);
  const cfg = { main: 'src/index.ts', durable_objects: { bindings: [{ name: 'COORDINATOR', class_name: 'Coordinator' }] } };
  assert.deepEqual(checkInfrastructure(cfg, structuredClone(cfg)), []);
  assert.ok(checkInfrastructure(cfg, { ...cfg, queues: { producers: [] } }).length);
  assert.ok(checkMigrations(['DROP TABLE messages;']).length);
  const valid = TABLES.map(table => `CREATE TABLE ${table} (id TEXT);`).join('\n');
  assert.deepEqual(checkMigrations([valid]), []);
  assert.ok(checkMigrations([valid, 'CREATE INDEX extra ON messages(id);']).length);
  const pkg = { dependencies: { x: '1' } }, lock = { packages: { '': pkg } };
  const next = { dependencies: { x: '1', 'postal-mime': '4.2.1' } };
  const nextLock = { packages: { '': next, 'node_modules/postal-mime': { version: '4.2.1' } } };
  assert.deepEqual(checkDependency(pkg, next, lock, nextLock), []);
  const wrongRoot = structuredClone(nextLock); wrongRoot.packages[''].dependencies['postal-mime'] = '^4.2.1';
  assert.ok(checkDependency(pkg, next, lock, wrongRoot).length);
  assert.ok(checkDependency(pkg, { ...next, scripts: { install: 'x' } }, lock, nextLock).length);
  console.log('c2-ownership-check: autotestes aprovados; sem Git, rede ou escrita.');
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  assert.equal(args.length, 0, 'Use sem argumentos ou --self-test.');
  const commit = git(['rev-parse', '--verify', `${REFERENCE}^{commit}`]).trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  const parts = git(['diff', '--no-renames', '--name-status', '-z', commit, '--']).split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) changes.push({ status: parts[i], path: parts[i + 1] });
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) changes.push({ status: '?', path });
  const checked = checkChanges(changes), index = ownershipIndex(OWNERS);
  const errors = [...checked.errors];
  const base = file => git(['show', `${commit}:${file}`]);
  errors.push(...checkInfrastructure(config(base('wrangler.jsonc')), config(read('wrangler.jsonc'))));
  errors.push(...checkDependency(JSON.parse(base('package.json')), JSON.parse(read('package.json')),
    JSON.parse(base('package-lock.json')), JSON.parse(read('package-lock.json'))));
  const migrationNames = readdirSync(join(root, 'migrations')).filter(file => file.endsWith('.sql')).sort();
  const migrations = migrationNames.filter(file => /^014[4-7]_/.test(file)).map(file => read(`migrations/${file}`));
  errors.push(...checkMigrations(migrations));
  const references = [...new Set(migrationNames.flatMap(file => contactReferences(read(`migrations/${file}`))))].sort();
  const relations = checkRelations(references, mergeAllowlist(read('src/customer/merge-relations.ts')));
  errors.push(...relations.errors);
  for (const file of index.keys()) if (!existsSync(join(root, file))) errors.push(`Arquivo da matriz ausente: ${file}.`);
  for (const file of OWNERS['c2-aceite']) {
    if (!existsSync(join(root, file))) continue;
    const bytes = readFileSync(join(root, file));
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { errors.push(`UTF-8 inválido: ${file}.`); }
    if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) errors.push(`BOM proibido: ${file}.`);
    if (bytes.includes(13)) errors.push(`Quebra diferente de LF: ${file}.`);
  }
  const sourceFiles = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src']).split('\0').filter(file => file.endsWith('.ts'));
  const classes = sourceFiles.flatMap(file => [...read(file).matchAll(/class\s+(\w+)\s+extends\s+DurableObject\b/g)].map(match => ({ file, name: match[1] })));
  if (classes.length !== 1 || classes[0].name !== 'Coordinator' || classes[0].file !== 'src/coordinator.ts') errors.push('Classe de Durable Object fora do Coordinator único.');
  const report = { schemaVersion: 1, reference: REFERENCE, commit, head, generatedAt: new Date().toISOString(),
    passed: errors.length === 0, ownerCount: Object.keys(OWNERS).length, matrixFiles: index.size,
    files: checked.files.map(file => ({ ...file, sha256: existsSync(join(root, file.path)) ? hash(readFileSync(join(root, file.path))) : null })),
    exceptions: EXCEPTIONS, infrastructure: { identical: !checkInfrastructure(config(base('wrangler.jsonc')), config(read('wrangler.jsonc'))).length, classes },
    relations, errors, limitation: 'Confere caminhos, dependências, DDL e infraestrutura; não prova autoria humana nem substitui revisão dos trechos centrais.' };
  const directory = join(root, 'output/c2-aceite'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ownership.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`c2-ownership-check: ${changes.length} arquivos, ${report.ownerCount} donas, sem sobreposição; infraestrutura idêntica. Evidência em output/c2-aceite/ownership.json.`);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
