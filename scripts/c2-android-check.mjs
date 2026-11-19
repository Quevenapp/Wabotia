import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runAndroidCheck, tasks, gradleInvocation } from './cn-android-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = 'mobile/android/app/src/';
const files = [
  ...['core/model/Models.kt', 'core/model/ChannelModels.kt', 'core/net/WabotiaApi.kt',
    'ui/components/ChannelBadge.kt', 'ui/components/Window.kt', 'ui/conversations/ConversationsScreen.kt',
    'ui/conversations/ConversationScreen.kt', 'ui/conversations/ConversationInfoScreen.kt',
    'ui/conversations/ConversationViewModel.kt', 'ui/conversations/Composer.kt', 'ui/conversations/MessageBubble.kt',
    'demo/DemoData.kt', 'demo/DemoServer.kt', 'demo/ChannelsSecondWave.kt',
  ].map(file => `${android}main/java/br/com/queven/wabotia/${file}`),
  ...['core/model/ChannelsSecondWaveTest.kt', 'demo/ChannelsSecondWaveDemoTest.kt']
    .map(file => `${android}test/java/br/com/queven/wabotia/${file}`),
  'tests/c2-android.test.ts', 'scripts/c2-android-check.mjs',
];

/** O verificador existente isola os insumos, desliga downloads e executa build e testes reais. */
export function runSecondWaveAndroidCheck() { return runAndroidCheck(); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--source-check')) {
    for (const file of files) {
      const bytes = readFileSync(join(root, file));
      assert.notEqual(bytes[0], 0xef, `${file}: BOM não permitido`);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert.equal(bytes.includes(13), false, `${file}: use LF`);
    }
    console.log(`${files.length} arquivos B8 em UTF-8 sem BOM e LF. Esta checagem não compila Android.`);
  } else if (process.argv.includes('--self-test')) {
    assert.deepEqual(tasks, ['--offline', ':app:assembleDebug', ':app:testDebugUnitTest']);
    for (const platform of ['win32', 'linux']) {
      const invocation = gradleInvocation(platform);
      assert.ok(invocation.args.includes('--offline'));
      assert.ok(invocation.args.includes('-Pandroid.builder.sdkDownload=false'));
    }
    console.log('Wrapper validado; nenhum build foi executado neste modo.');
  } else {
    try { process.exitCode = runSecondWaveAndroidCheck(); }
    catch (error) {
      console.error(`Compilação Android bloqueada: ${error instanceof Error ? error.message : String(error)}. Nenhum sucesso foi presumido.`);
      process.exitCode = 1;
    }
  }
}
