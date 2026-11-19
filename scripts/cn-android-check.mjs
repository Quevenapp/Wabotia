import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, cpSync, writeFileSync, realpathSync, statSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const tasks = ['--offline', ':app:assembleDebug', ':app:testDebugUnitTest'];
const kotlinRoot = 'mobile/android/app/src/main/java/br/com/queven/wabotia/';
const sourceFiles = [
  ...['core/model/Models.kt', 'core/model/ChannelModels.kt', 'core/net/WabotiaApi.kt',
    'ui/components/Avatar.kt', 'ui/components/Window.kt', 'ui/components/ChannelBadge.kt',
    'ui/conversations/ConversationsScreen.kt', 'ui/conversations/ConversationsViewModel.kt',
    'ui/conversations/ConversationScreen.kt', 'ui/conversations/ConversationViewModel.kt',
    'ui/conversations/ConversationInfoScreen.kt', 'ui/conversations/Composer.kt',
    'ui/conversations/Sheets.kt', 'ui/conversations/EmailTranscriptSheet.kt',
    'core/push/Notifications.kt', 'core/push/WabotiaMessagingService.kt', 'demo/DemoData.kt', 'demo/DemoServer.kt',
  ].map(file => kotlinRoot + file),
  'mobile/android/app/src/test/java/br/com/queven/wabotia/core/model/ChannelModelsTest.kt',
  'mobile/android/app/src/test/java/br/com/queven/wabotia/demo/ChannelsDemoTest.kt',
  'tests/cn-android.test.ts', 'scripts/cn-android-check.mjs',
];

/** .bat exige cmd no Windows; argumentos fixos, sem interpolar caminhos em código de shell. */
export function gradleInvocation(platform = process.platform, kitPath) {
  // Caminho relativo gerado por nós: passa também como propriedade, que prevalece sobre a variável.
  if (kitPath != null && !/^\.gradle\/cn-check\/thermal-printer-kit-[\w-]+$/.test(kitPath)) {
    throw new Error('Caminho temporário do ThermalPrinterKit inválido.');
  }
  const options = ['--no-daemon', '-Pandroid.builder.sdkDownload=false', '-Pkotlin.compiler.execution.strategy=in-process'];
  if (kitPath) options.push(`-PthermalPrinterKitDir=${kitPath}`);
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', '.\\gradlew.bat', ...tasks, ...options] }
    : { command: 'sh', args: ['gradlew', ...tasks, ...options] };
}

function distributionUrl(properties) {
  const url = properties.match(/^distributionUrl=(.+)$/m)?.[1]?.trim().replaceAll('\\:', ':');
  if (!url) throw new Error('distributionUrl do wrapper ausente; nenhum download foi iniciado.');
  return url;
}

export function distributionName(properties) {
  const url = distributionUrl(properties);
  const name = url?.match(/\/(gradle-[\w.-]+)\.zip$/)?.[1];
  if (!name) throw new Error('distributionUrl do wrapper não reconhecida; nenhum download foi iniciado.');
  return name;
}

/** Mesmo MD5/base36 usado por PathAssembler no Gradle Wrapper. --offline não controla o wrapper. */
export function distributionHash(properties) {
  const hex = createHash('md5').update(distributionUrl(properties)).digest('hex');
  return BigInt(`0x${hex}`).toString(36);
}

function cachedDistribution(home, name, hash) {
  const folder = join(home, 'wrapper', 'dists', name);
  const hashed = join(folder, hash);
  if (!existsSync(hashed)) return null;
  const installed = readdirSync(hashed, { withFileTypes: true }).find(entry => entry.isDirectory() && /^gradle-/.test(entry.name) && existsSync(join(hashed, entry.name, 'bin', 'gradle')));
  // Só a pasta da URL exata e com marcador impede tentativa de download pelo wrapper.
  if (installed && existsSync(join(hashed, `${name}.zip.ok`))) return { folder, hash };
  return null;
}

function inside(parent, child) {
  const rel = relative(realpathSync(parent), realpathSync(child));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

/** Snapshot de fontes já instaladas. O includeBuild só pode gerar saídas dentro desta cópia. */
export function stageThermalPrinterKit(source, work, workspace = root) {
  if (!inside(workspace, work)) throw new Error('O diretório temporário resolve para fora da cópia de trabalho.');
  const sourceRoot = realpathSync(source);
  if (!statSync(join(sourceRoot, 'android')).isDirectory()) throw new Error('ThermalPrinterKit local sem diretório Android.');
  const staged = mkdtempSync(join(work, 'thermal-printer-kit-'));
  const ignored = new Set(['.git', '.gradle', '.kotlin', '.idea', '.cxx', '.externalNativeBuild', 'build', 'node_modules', 'local.properties', 'keystore.properties']);
  // O settings da biblioteca inclui ../printher, ../android-lab e ../jvm/core.
  // Preservar a árvore de fontes mantém esses caminhos locais sem alterar nenhum Gradle.
  cpSync(sourceRoot, staged, {
    recursive: true,
    dereference: true,
    filter: path => {
      const parts = relative(sourceRoot, path).split(/[\\/]/);
      if (parts.some(part => ignored.has(part) || /\.(?:jks|keystore)$/.test(part))) return false;
      // Não transportar junctions/symlinks que apontem para outro repositório ou cache.
      if (!inside(sourceRoot, path)) throw new Error('ThermalPrinterKit contém vínculo para fora de suas fontes.');
      return true;
    },
  });
  return staged;
}

/** Copia insumos instalados: o javac/ZipFS do Windows também precisa resolver seus caminhos locais. */
function stageBuildInputs(sdk, sourceHome, gradleHome, work) {
  const localSdk = join(work, 'android-sdk');
  mkdirSync(localSdk, { recursive: true });
  if (!inside(root, localSdk) || !inside(root, gradleHome)) throw new Error('Os insumos de build devem ficar na cópia de trabalho.');
  // Estas tarefas não precisam de emulador, imagens de sistema, NDK ou ferramentas de publicação.
  for (const directory of ['platforms/android-36', 'build-tools', 'licenses']) {
    const source = join(sdk, directory);
    if (!existsSync(source)) continue;
    cpSync(source, join(localSdk, directory), { recursive: true, dereference: true });
  }
  const dependencyCache = join(sourceHome, 'caches', 'modules-2');
  if (existsSync(dependencyCache)) {
    const localCache = join(gradleHome, 'caches', 'modules-2');
    if (resolve(dependencyCache) !== resolve(localCache)) {
      cpSync(dependencyCache, localCache, {
        recursive: true, dereference: true,
        filter: path => !path.endsWith('.lock') && !path.endsWith('.lck') && !path.endsWith('gc.properties'),
      });
    }
  }
  return localSdk;
}

/** Usa cache externo só para leitura; todo lock, daemon, temporário e saída ficam na cópia de trabalho. */
export function runAndroidCheck() {
  const android = join(root, 'mobile', 'android');
  const work = join(android, '.gradle', 'cn-check');
  mkdirSync(work, { recursive: true });
  if (!inside(root, work)) throw new Error('O diretório de build resolve para fora da cópia de trabalho.');
  const log = join(work, 'result.log');
  const report = message => { console.error(message); writeFileSync(log, `${message}\n`, 'utf8'); return 1; };
  writeFileSync(log, 'Preparando verificação Android offline.\n', 'utf8');
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const jdk = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (jdk.error || jdk.status !== 0) return report(`Compilação Android pendente: JDK indisponível. ${jdk.error?.message || jdk.stderr}`);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(join(sdk, 'platforms', 'android-36', 'android.jar'))) return report('Compilação Android pendente: SDK Android 36 ausente (ANDROID_HOME/ANDROID_SDK_ROOT). Nenhum download foi iniciado.');
  // settings.gradle.kts inclui esta biblioteca local. Nunca deixar seu build escrever em outra cópia.
  let kit = process.env.THERMAL_PRINTER_KIT_DIR;
  if (!kit) {
    for (let parent = android; ; parent = dirname(parent)) {
      const candidate = join(parent, 'ThermalPrinterKit');
      if (existsSync(join(candidate, 'android'))) { kit = candidate; break; }
      if (dirname(parent) === parent) break;
    }
  }
  if (kit) kit = resolve(android, kit);
  if (!kit || !existsSync(join(kit, 'android'))) return report('Compilação Android pendente: ThermalPrinterKit local ausente. Nenhuma dependência foi baixada.');
  console.log('Preparando cópia local das fontes Android do ThermalPrinterKit já instalado (sem rede)…');
  kit = stageThermalPrinterKit(kit, work);
  const gradleHome = join(work, 'gradle-home');
  mkdirSync(gradleHome, { recursive: true });
  const sourceHome = resolve(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'));
  const wrapperProperties = readFileSync(join(android, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  const distName = distributionName(wrapperProperties);
  const distHash = distributionHash(wrapperProperties);
  const existing = cachedDistribution(gradleHome, distName, distHash);
  const source = existing || cachedDistribution(sourceHome, distName, distHash);
  if (!source) return report(`Compilação Android pendente: distribuição ${distName} da URL exata do wrapper ausente do cache (${distHash}). O wrapper não foi iniciado para evitar download.`);
  if (!existing) {
    const destination = join(gradleHome, 'wrapper', 'dists', distName, source.hash);
    mkdirSync(destination, { recursive: true });
    console.log('Preparando cópia local da distribuição Gradle já instalada (sem rede)…');
    cpSync(join(source.folder, source.hash), destination, {
      recursive: true, dereference: true,
      filter: path => !path.endsWith('.lck') && !path.endsWith('.zip') && !['docs', 'src'].includes(path.split(/[\\/]/).at(-1)),
    });
  }
  console.log('Preparando cópia local do SDK e das dependências já em cache (sem rede)…');
  const localSdk = stageBuildInputs(sdk, sourceHome, gradleHome, work);
  const temp = join(work, 'tmp');
  mkdirSync(temp, { recursive: true });
  const userHome = join(work, 'user-home');
  const androidHome = join(userHome, '.android');
  mkdirSync(androidHome, { recursive: true });
  // Ferramentas antigas do SDK/analytics ignoram ANDROID_USER_HOME e consultam user.home.
  const javaOptions = [process.env.JAVA_TOOL_OPTIONS, `-Duser.home="${userHome.replaceAll('\\', '/')}"`, `-Djava.io.tmpdir="${temp.replaceAll('\\', '/')}"`].filter(Boolean).join(' ');
  const env = {
    ...process.env,
    GRADLE_USER_HOME: gradleHome,
    JAVA_TOOL_OPTIONS: javaOptions,
    ANDROID_USER_HOME: androidHome,
    ANDROID_EMULATOR_HOME: androidHome,
    ANDROID_SDK_HOME: userHome,
    ANDROID_HOME: localSdk,
    ANDROID_SDK_ROOT: localSdk,
    THERMAL_PRINTER_KIT_DIR: resolve(kit),
    TEMP: temp, TMP: temp, TMPDIR: temp,
  };
  delete env.GRADLE_RO_DEP_CACHE;
  const invocation = gradleInvocation(process.platform, relative(android, kit).replaceAll('\\', '/'));
  console.log(`${invocation.command} ${invocation.args.join(' ')}`);
  // O log cresce durante o build e continua disponível mesmo se o processo for interrompido.
  const logFile = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(invocation.command, invocation.args, {
      cwd: android, env, stdio: ['ignore', logFile, logFile], windowsHide: true, timeout: 20 * 60_000,
    });
  } finally {
    closeSync(logFile);
  }
  if (result.error) appendFileSync(log, `\n${result.error.message}\n`, 'utf8');
  const output = readFileSync(log, 'utf8');
  process.stdout.write(output);
  if (result.error || result.status !== 0) {
    console.error(`Compilação/testes Android pendentes ou falharam (saída ${result.status ?? 'indisponível'}). Log: ${relative(root, log)}. Nenhum download foi autorizado.`);
    return result.status || 1;
  }
  console.log('Compilação Android e testes nativos aprovados, em modo offline.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--source-check')) {
    for (const file of sourceFiles) {
      const source = readFileSync(join(root, file));
      assert.notEqual(source[0], 0xef, `${file}: BOM não permitido`);
      new TextDecoder('utf-8', { fatal: true }).decode(source);
      assert.equal(source.includes(13), false, `${file}: use LF`);
    }
    console.log(`${sourceFiles.length} arquivos B8 em UTF-8 sem BOM, com LF.`);
  } else if (process.argv.includes('--self-test')) {
    assert.equal(gradleInvocation('win32').command, 'cmd.exe');
    assert.ok(gradleInvocation('win32').args.includes('.\\gradlew.bat'));
    assert.deepEqual(gradleInvocation('linux').args.slice(0, 4), ['gradlew', ...tasks]);
    assert.equal(distributionName('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip\n'), 'gradle-8.14.3-all');
    assert.throws(() => distributionName('distributionUrl=invalid'));
    const kitPath = '.gradle/cn-check/thermal-printer-kit-fixture';
    for (const platform of ['win32', 'linux', 'darwin']) {
      const invocation = gradleInvocation(platform, kitPath);
      assert.ok(invocation.args.includes(`-PthermalPrinterKitDir=${kitPath}`));
      assert.ok(invocation.args.includes('--offline'));
      assert.ok(invocation.args.includes('-Pandroid.builder.sdkDownload=false'));
    }
    assert.throws(() => gradleInvocation('win32', '../external & command'));
    const checkWork = join(root, 'mobile', 'android', '.gradle', 'cn-check');
    mkdirSync(checkWork, { recursive: true });
    assert.ok(inside(root, checkWork));
    const fixture = mkdtempSync(join(checkWork, 'self-test-'));
    const source = join(fixture, 'existing-kit');
    const workspace = join(fixture, 'workspace');
    const work = join(workspace, '.gradle');
    mkdirSync(join(source, 'android', 'src'), { recursive: true });
    mkdirSync(work, { recursive: true });
    const wrapperProperties = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip\n';
    const distName = distributionName(wrapperProperties);
    const distHash = distributionHash(wrapperProperties);
    const mirrorHash = distributionHash(wrapperProperties.replace('services.gradle.org', 'mirror.example.test'));
    assert.notEqual(distHash, mirrorHash);
    const installFixture = hash => {
      const cached = join(work, 'wrapper', 'dists', distName, hash);
      mkdirSync(join(cached, 'gradle-8.14.3', 'bin'), { recursive: true });
      writeFileSync(join(cached, 'gradle-8.14.3', 'bin', 'gradle'), '# fixture\n');
      return cached;
    };
    writeFileSync(join(installFixture(mirrorHash), `${distName}.zip.ok`), '');
    assert.equal(cachedDistribution(work, distName, distHash), null);
    const correctCache = installFixture(distHash);
    assert.equal(cachedDistribution(work, distName, distHash), null);
    writeFileSync(join(correctCache, `${distName}.zip.ok`), '');
    assert.equal(cachedDistribution(work, distName, distHash)?.hash, distHash);
    const sourceFile = join(source, 'android', 'src', 'Printer.kt');
    writeFileSync(sourceFile, '// Impressão sintética\n', 'utf8');
    const before = statSync(sourceFile).mtimeMs;
    for (const directory of ['printher', 'android-lab', 'jvm/core']) {
      mkdirSync(join(source, directory), { recursive: true });
      writeFileSync(join(source, directory, 'build.gradle.kts'), '// Projeto incluído\n', 'utf8');
    }
    for (const directory of ['build', '.gradle', '.git', 'node_modules']) {
      mkdirSync(join(source, 'android', directory));
      writeFileSync(join(source, 'android', directory, 'not-a-source'), 'excluded');
    }
    writeFileSync(join(source, 'android', 'local.properties'), 'sdk.dir=outside');
    const staged = stageThermalPrinterKit(source, work, workspace);
    assert.ok(inside(workspace, staged));
    assert.equal(readFileSync(join(staged, 'android', 'src', 'Printer.kt'), 'utf8'), '// Impressão sintética\n');
    for (const directory of ['printher', 'android-lab', 'jvm/core']) {
      assert.equal(readFileSync(join(staged, directory, 'build.gradle.kts'), 'utf8'), '// Projeto incluído\n');
    }
    for (const excluded of ['build', '.gradle', '.git', 'node_modules', 'local.properties']) {
      assert.equal(existsSync(join(staged, 'android', excluded)), false);
    }
    writeFileSync(join(staged, 'android', 'src', 'Printer.kt'), '// Saída local\n');
    assert.equal(readFileSync(sourceFile, 'utf8'), '// Impressão sintética\n');
    assert.equal(statSync(sourceFile).mtimeMs, before);
    const repeated = stageThermalPrinterKit(source, work, workspace);
    assert.notEqual(repeated, staged);
    assert.equal(readFileSync(join(repeated, 'android', 'src', 'Printer.kt'), 'utf8'), '// Impressão sintética\n');
    assert.throws(() => stageThermalPrinterKit(source, fixture, workspace), /fora da cópia/);
    assert.throws(() => stageThermalPrinterKit(join(fixture, 'missing'), work, workspace));
    const sdkFixture = join(fixture, 'installed-sdk');
    const cacheFixture = join(fixture, 'installed-cache');
    for (const directory of ['platforms/android-36', 'build-tools/36.0.0', 'licenses']) {
      mkdirSync(join(sdkFixture, directory), { recursive: true });
      writeFileSync(join(sdkFixture, directory, 'fixture'), 'installed');
    }
    const sourceModules = join(cacheFixture, 'caches', 'modules-2');
    mkdirSync(join(sourceModules, 'files-2.1'), { recursive: true });
    writeFileSync(join(sourceModules, 'files-2.1', 'dependency.jar'), 'jar fixture');
    writeFileSync(join(sourceModules, 'modules-2.lock'), 'do not copy');
    const localSdk = stageBuildInputs(sdkFixture, cacheFixture, work, work);
    assert.ok(inside(workspace, localSdk));
    assert.equal(readFileSync(join(localSdk, 'platforms/android-36/fixture'), 'utf8'), 'installed');
    assert.equal(readFileSync(join(work, 'caches/modules-2/files-2.1/dependency.jar'), 'utf8'), 'jar fixture');
    assert.equal(existsSync(join(work, 'caches/modules-2/modules-2.lock')), false);
    writeFileSync(join(localSdk, 'platforms/android-36/fixture'), 'local only');
    assert.equal(readFileSync(join(sdkFixture, 'platforms/android-36/fixture'), 'utf8'), 'installed');
    assert.equal(readFileSync(join(sourceModules, 'modules-2.lock'), 'utf8'), 'do not copy');
    console.log('Verificações do wrapper, ThermalPrinterKit, SDK e cache locais passaram; nenhuma rede ou compilação executada.');
  } else {
    try { process.exitCode = runAndroidCheck(); }
    catch (error) {
      const message = `Compilação Android pendente: ${error.message}`;
      console.error(message);
      const work = join(root, 'mobile', 'android', '.gradle', 'cn-check');
      try {
        if (existsSync(work) && inside(root, work)) writeFileSync(join(work, 'result.log'), `${message}\n`, 'utf8');
      } catch (logError) {
        console.error(`Não foi possível registrar o log local: ${logError.message}`);
      }
      process.exitCode = 1;
    }
  }
}
