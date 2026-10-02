import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateVersion, parseWrapper, verifyChecksum, resolveVersion, parseBoolean } from '../scripts/setup.mjs';

const sha = 'a'.repeat(64);
const wrapper = `kotlin_cli_version=0.13.0\nkotlin_cli_sha256=${sha}\n`;

test('rejects version expressions, traversal, and shell injection', () => {
  for (const value of ['latest', '../0.13.0', '0.13.0\nmalicious', '0.13.0;id', '0.11.0', '$(id)', 'v0.13.0']) {
    assert.throws(() => validateVersion(value));
  }
  assert.equal(validateVersion('0.13.0-dev-123'), '0.13.0-dev-123');
});

test('reads POSIX and Windows wrappers without executing their contents', () => {
  assert.deepEqual(parseWrapper(wrapper + 'echo dangerous\n'), { version: '0.13.0', checksum: sha });
  assert.deepEqual(parseWrapper(wrapper.replace(/^/gm, 'set ').replaceAll('\n', '\r\n')), { version: '0.13.0', checksum: sha });
  assert.throws(() => parseWrapper(wrapper + wrapper));
  assert.throws(() => parseWrapper('kotlin_cli_version=0.13.0\n'));
});

test('parses real upstream wrappers including dynamic reassignment statements', async () => {
  for (const file of ['kotlin', 'kotlin.bat']) {
    const content = await readFile(new URL(`./fixtures/jvm/${file}`, import.meta.url), 'utf8');
    assert.equal(parseWrapper(content).version, '0.13.0');
  }
});

test('detects corrupt wrappers and malformed checksums', () => {
  const bytes = Buffer.from(wrapper);
  verifyChecksum(bytes, createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => verifyChecksum(bytes, sha));
  assert.throws(() => verifyChecksum(bytes, 'not a digest'));
});

test('resolves project versions, fallback, explicit override, and conflicting wrappers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ktc-test-'));
  try {
    assert.deepEqual(await resolveVersion('auto', dir), { version: '0.13.0' });
    await writeFile(path.join(dir, 'kotlin'), wrapper);
    assert.deepEqual(await resolveVersion('auto', dir), { version: '0.13.0', checksum: sha });
    await writeFile(path.join(dir, 'kotlin.bat'), wrapper.replace('0.13.0', '0.12.2'));
    await assert.rejects(resolveVersion('auto', dir), /different distributions/);
    assert.deepEqual(await resolveVersion('0.12.2', dir), { version: '0.12.2' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('boolean inputs are validated rather than treated as truthy strings', () => {
  assert.equal(parseBoolean('false', 'cache'), false);
  assert.equal(parseBoolean('true', 'cache'), true);
  assert.throws(() => parseBoolean('yes', 'cache'));
});

test('feature branches and fork PRs share keys, while platform and distribution boundaries stay isolated', async () => {
  const { cacheKeys } = await import('../scripts/setup.mjs');
  const base = { os: 'Linux', arch: 'X64', version: '0.13.0', checksum: sha, configHash: 'b'.repeat(64) };
  const main = cacheKeys(base);
  assert.equal(cacheKeys({ ...base, branch: 'feature/new', fork: true }).key, main.key);
  const changed = cacheKeys({ ...base, configHash: 'c'.repeat(64) });
  assert.notEqual(changed.key, main.key);
  assert.equal(changed.prefix, main.prefix);
  for (const variation of [{ os: 'Windows' }, { arch: 'ARM64' }, { version: '0.12.2' }, { checksum: 'c'.repeat(64) }, { suffix: 'fresh' }]) {
    assert.notEqual(cacheKeys({ ...base, ...variation }).prefix, main.prefix);
  }
  assert.throws(() => cacheKeys({ ...base, suffix: 'x\nktc-' }));
  assert.ok(main.key.length < 512);
});

test('PRs and untrusted events restore only by default; feature branch pushes can save', async () => {
  const { cachePolicy } = await import('../scripts/setup.mjs');
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', undefined]) {
    assert.equal(cachePolicy('auto', event), true);
  }
  for (const event of ['push', 'workflow_dispatch', 'schedule']) assert.equal(cachePolicy('auto', event), false);
  assert.equal(cachePolicy('true', 'push'), true);
  assert.equal(cachePolicy('false', 'pull_request'), false);
  assert.throws(() => cachePolicy('yes', 'push'));
});

test('setup exports the exact cached directories, preserves warm data, and keeps wrappers outside restored caches', async () => {
  const { prepare } = await import('../scripts/setup.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'ktc-prepare-'));
  const originalFetch = globalThis.fetch;
  const native = process.platform === 'win32' ? 'kotlin.bat' : 'kotlin';
  const bytes = await readFile(new URL(`./fixtures/jvm/${native}`, import.meta.url));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  globalThis.fetch = async url => new Response(url.endsWith('.sha256') ? checksum : bytes);
  try {
    const env = { RUNNER_TEMP: root, GITHUB_WORKSPACE: root, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      GITHUB_EVENT_NAME: 'pull_request', INPUT_VERSION: '0.13.0' };
    for (const file of ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH']) {
      env[file] = path.join(root, file);
      await writeFile(env[file], '');
    }
    const first = await prepare(env);
    const settings = Object.fromEntries((await readFile(env.GITHUB_ENV, 'utf8')).trim().split('\n').map(line => line.split('=')));
    assert.equal(settings.KOTLIN_CLI_BOOTSTRAP_CACHE_DIR, path.join(first.cacheRoot, 'cli'));
    assert.equal(settings.KOTLIN_SHARED_CACHE_DIR, path.join(first.cacheRoot, 'shared'));
    assert.ok(!first.wrapper.startsWith(first.cacheRoot));
    const marker = path.join(settings.KOTLIN_SHARED_CACHE_DIR, 'restored-dependency');
    await writeFile(marker, 'warm cache');
    const second = await prepare(env);
    assert.equal(first.cacheRoot, second.cacheRoot);
    assert.notEqual(first.wrapper, second.wrapper);
    assert.equal(await readFile(marker, 'utf8'), 'warm cache');
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /cache-read-only=true/);
    globalThis.fetch = async url => new Response(url.endsWith('.sha256') ? '0'.repeat(64) : bytes);
    await assert.rejects(prepare(env), /SHA-256 mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
