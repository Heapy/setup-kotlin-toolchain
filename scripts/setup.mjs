import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'https://packages.jetbrains.team/maven/p/amper/amper/org/jetbrains/kotlin/kotlin-cli';
export const defaultVersion = '0.13.0';

export function validateVersion(value) {
  if (!/^0\.(?:1[2-9]|[2-9]\d|\d{3,})\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(value)) {
    throw new Error('version must be an exact Kotlin Toolchain version >= 0.12.0 (for example 0.13.0)');
  }
  return value;
}

export function parseWrapper(text) {
  const versions = [...text.matchAll(/^(?:set )?kotlin_cli_version=(\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?)\r?$/gm)];
  const checksums = [...text.matchAll(/^(?:set )?kotlin_cli_sha256=([a-fA-F0-9]{64})\r?$/gm)];
  if (versions.length !== 1 || checksums.length !== 1) {
    throw new Error('Project wrapper must contain exactly one version and distribution SHA-256');
  }
  return { version: validateVersion(versions[0][1]), checksum: checksums[0][1].toLowerCase() };
}

export function verifyChecksum(bytes, expected) {
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) throw new Error('Invalid SHA-256');
  if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
    throw new Error('Wrapper SHA-256 mismatch');
  }
}

async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function resolveVersion(requested, directory) {
  if (requested !== 'auto') return { version: validateVersion(requested) };
  const wrappers = [];
  for (const name of ['kotlin', 'kotlin.bat']) {
    const content = await optionalRead(path.join(directory, name));
    if (content !== undefined) wrappers.push(parseWrapper(content));
  }
  if (!wrappers.length) return { version: defaultVersion };
  if (wrappers.some(wrapper => wrapper.version !== wrappers[0].version || wrapper.checksum !== wrappers[0].checksum)) {
    throw new Error('kotlin and kotlin.bat pin different distributions');
  }
  return wrappers[0];
}

export function parseBoolean(value, name) {
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

export function cachePolicy(value, event) {
  if (value === 'auto') return !['push', 'workflow_dispatch', 'schedule'].includes(event);
  return parseBoolean(value, 'cache-read-only');
}

export function cacheKeys({ os, arch, version, checksum, suffix = '', configHash = '' }) {
  for (const value of [os, arch, suffix]) {
    if (!/^[a-zA-Z0-9_.-]{0,64}$/.test(value)) throw new Error('Invalid cache namespace component');
  }
  if (!/^[a-f0-9]{0,64}$/.test(configHash)) throw new Error('Invalid configuration hash');
  const identity = createHash('sha256').update(`${validateVersion(version)}:${checksum}`).digest('hex').slice(0, 16);
  const prefix = `ktc-v1-${os}-${arch}-${identity}-${suffix || 'default'}-`;
  return { key: `${prefix}${configHash || 'no-config'}`, prefix };
}

async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

function record(file, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid multiline value for ${key}`);
  return appendFile(file, `${key}=${value}\n`);
}

export async function prepare(env = process.env) {
  const cacheEnabled = parseBoolean(env.INPUT_CACHE ?? 'true', 'cache');
  const readOnly = cachePolicy(env.INPUT_CACHE_READ_ONLY ?? 'auto', env.GITHUB_EVENT_NAME);
  parseBoolean(env.INPUT_VERIFY ?? 'true', 'verify');
  const directory = path.resolve(env.GITHUB_WORKSPACE ?? process.cwd(), env.INPUT_DIRECTORY ?? '.');
  const selected = await resolveVersion(env.INPUT_VERSION ?? 'auto', directory);
  const version = selected.version;
  const bin = await mkdtemp(path.join(env.RUNNER_TEMP ?? tmpdir(), 'kotlin-toolchain-bin-'));
  const cacheRoot = path.join(env.RUNNER_TEMP ?? tmpdir(), 'setup-kotlin-toolchain-cache');
  const bootstrap = path.join(cacheRoot, 'cli');
  const shared = path.join(cacheRoot, 'shared');
  await mkdir(bootstrap, { recursive: true });
  await mkdir(shared, { recursive: true });
  const wrapperName = process.platform === 'win32' ? 'kotlin.bat' : 'kotlin';
  const artifact = `kotlin-cli-${version}-wrapper${process.platform === 'win32' ? '.bat' : ''}`;
  const base = `${repository}/${version}/${artifact}`;
  const [bytes, checksumBytes] = await Promise.all([download(base), download(`${base}.sha256`)]);
  const expected = env.INPUT_SHA256 || checksumBytes.toString('utf8').trim();
  verifyChecksum(bytes, expected);
  const upstream = parseWrapper(bytes.toString('utf8'));
  if (upstream.version !== version || (selected.checksum && upstream.checksum !== selected.checksum)) {
    throw new Error('Downloaded wrapper does not match the selected project distribution');
  }
  const keys = cacheKeys({ os: env.RUNNER_OS ?? process.platform, arch: env.RUNNER_ARCH ?? process.arch,
    version, checksum: upstream.checksum, suffix: env.INPUT_CACHE_SUFFIX ?? '', configHash: env.INPUT_CONFIG_HASH ?? '' });
  const wrapper = path.join(bin, wrapperName);
  await writeFile(wrapper, bytes);
  if (process.platform !== 'win32') await chmod(wrapper, 0o755);
  // Git Bash needs a shell launcher that uses the same native Windows wrapper.
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'kotlin'), '#!/bin/sh\nexec node "$(dirname "$0")/launch.mjs" "$@"\n');
    await writeFile(path.join(bin, 'launch.mjs'), windowsLauncher);
  }
  await appendFile(env.GITHUB_PATH, `${bin}\n`);
  for (const [key, value] of Object.entries({
    KOTLIN_CLI_BOOTSTRAP_CACHE_DIR: bootstrap,
    KOTLIN_SHARED_CACHE_DIR: shared,
    KOTLIN_CLI_NO_WELCOME_BANNER: '1',
    KOTLIN_CLI_WRAPPER_ALWAYS_USE_INTRINSIC_VERSION: '1',
    KOTLIN_TOOLCHAIN_BIN: bin,
  })) await record(env.GITHUB_ENV, key, value);
  for (const [key, value] of Object.entries({ version, bin, wrapper, 'cache-path': cacheRoot,
    'cache-enabled': String(cacheEnabled), 'cache-read-only': String(readOnly),
    'cache-key': keys.key, 'cache-prefix': keys.prefix })) {
    await record(env.GITHUB_OUTPUT, key, value);
  }
  console.log(`Installed Kotlin Toolchain ${version} wrapper to ${bin}`);
  return { version, wrapper, cacheRoot };
}

export function bootstrap(env = process.env) {
  const wrapper = env.TOOLCHAIN_WRAPPER;
  if (!wrapper || /[\r\n"%]/.test(wrapper)) throw new Error('Invalid wrapper path');
  const result = process.platform === 'win32'
    ? spawnSync(process.execPath, [path.join(path.dirname(wrapper), 'launch.mjs'), '--version'], { stdio: 'inherit', env })
    : spawnSync(wrapper, ['--version'], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Toolchain bootstrap failed (exit ${result.status})`);
}

export const windowsLauncher = `import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kotlin.bat');
const args = [wrapper, ...process.argv.slice(2)];
if (args.some(arg => /["%\\r\\n]/.test(arg))) throw new Error('Unsupported Windows argument');
const env = { ...process.env };
const oldPath = (env.Path || env.PATH || '').split(';').filter(dir => !/strawberry|[\\\\/]git[\\\\/](usr|mingw64)[\\\\/]bin/i.test(dir)).join(';');
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = path.join(env.SystemRoot || 'C:\\\\Windows', 'System32') + ';' + oldPath;
const command = '"' + args.map(arg => '"' + arg + '"').join(' ') + '"';
const result = spawnSync('cmd.exe', ['/d', '/v:off', '/s', '/c', command], { env, stdio: 'inherit', windowsVerbatimArguments: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'bootstrap') bootstrap();
    else throw new Error('Expected prepare or bootstrap command');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
