import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { checkForUpdate, isNewerRelease, updateNotice, UPDATE_CHECK_INTERVAL_MS } from '../src/services/updates.js';
import { createShoppingApplication } from '../src/runtime.js';
import { loadSettings } from '../src/config.js';
import { injectedServices } from '../test-support/mcp-fixture.js';
import { dataOf } from '../test-support/assertions.js';
import { SessionStatusOutput } from '../src/mcp/contracts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import assert from 'node:assert/strict';
import test from 'node:test';

async function dataDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'continente-updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const noon = new Date('2026-10-15T12:00:00Z');
const options = (dir: string, fetchLatest: () => Promise<string>, now = noon) =>
  ({ currentVersion: '0.3.1', packageName: 'continentept-mcp', dataDir: dir, now: () => now, fetchLatest });

test('only later stable releases count as updates', () => {
  assert.equal(isNewerRelease('0.4.0', '0.3.1'), true);
  assert.equal(isNewerRelease('0.3.10', '0.3.9'), true);
  assert.equal(isNewerRelease('1.0.0', '0.9.9'), true);
  for (const [candidate, current] of [['0.3.1', '0.3.1'], ['0.3.0', '0.3.1'], ['0.4.0-rc.1', '0.3.1'], ['latest', '0.3.1'], ['0.4.0', 'dev']]) {
    assert.equal(isNewerRelease(String(candidate), String(current)), false, `${candidate} vs ${current}`);
  }
});

test('a newer release is reported and the answer is cached for a day', async t => {
  const dir = await dataDir(t); let lookups = 0;
  const lookup = async () => { lookups++; return '0.4.0'; };
  assert.deepEqual(await checkForUpdate(options(dir, lookup)), { currentVersion: '0.3.1', latestVersion: '0.4.0', available: true });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'update-check.json'), 'utf8')), { checkedAt: noon.toISOString(), latestVersion: '0.4.0' });
  const later = new Date(noon.getTime() + UPDATE_CHECK_INTERVAL_MS - 1000);
  assert.equal((await checkForUpdate(options(dir, lookup, later))).available, true);
  assert.equal(lookups, 1);
  const nextDay = new Date(noon.getTime() + UPDATE_CHECK_INTERVAL_MS + 1000);
  await checkForUpdate(options(dir, async () => { lookups++; return '0.3.1'; }, nextDay));
  assert.equal(lookups, 2);
});

test('offline, slow or broken lookups never fail and keep the last known answer', async t => {
  const dir = await dataDir(t);
  assert.deepEqual(await checkForUpdate(options(dir, async () => { throw new Error('offline'); })),
    { currentVersion: '0.3.1', latestVersion: null, available: false });
  const started = Date.now();
  const slow = await checkForUpdate({ ...options(dir, () => new Promise<string>(() => {})), timeoutMs: 50 });
  assert.equal(slow.available, false); assert.ok(Date.now() - started < 1000);
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: '2026-10-01T00:00:00Z', latestVersion: '0.4.0' }));
  assert.equal((await checkForUpdate(options(dir, async () => { throw new Error('offline'); }))).latestVersion, '0.4.0');
  await writeFile(join(dir, 'update-check.json'), '{broken');
  assert.equal((await checkForUpdate(options(dir, async () => '0.3.1'))).available, false);
});

test('an answer cached before an upgrade is checked again and never reported below the running version', async t => {
  const dir = await dataDir(t); let lookups = 0;
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: noon.toISOString(), latestVersion: '0.3.0' }));
  assert.deepEqual(await checkForUpdate(options(dir, async () => { lookups++; return '0.3.1'; })),
    { currentVersion: '0.3.1', latestVersion: '0.3.1', available: false });
  assert.equal(lookups, 1);
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: noon.toISOString(), latestVersion: '0.3.0' }));
  assert.deepEqual(await checkForUpdate(options(dir, async () => { throw new Error('offline'); })),
    { currentVersion: '0.3.1', latestVersion: null, available: false });
  assert.deepEqual(await checkForUpdate(options(dir, async () => '0.2.0')), { currentVersion: '0.3.1', latestVersion: null, available: false });
});

test('the check can be turned off', async t => {
  const dir = await dataDir(t); let lookups = 0;
  const result = await checkForUpdate({ ...options(dir, async () => { lookups++; return '9.9.9'; }), enabled: false });
  assert.equal(result.available, false); assert.equal(lookups, 0);
  for (const value of ['0', 'false', 'OFF', 'no']) assert.equal(loadSettings({ HOME: dir, CONTINENTE_UPDATE_CHECK: value }).updateCheck, false);
  assert.equal(loadSettings({ HOME: dir }).updateCheck, true);
});

test('an available update reaches the instructions and the session status', async t => {
  const update = { currentVersion: '0.3.1', latestVersion: '0.4.0', available: true };
  assert.match(updateNotice(update) ?? '', /0\.4\.0 is out \(this is 0\.3\.1\).*continente-mcp\.mcpb/);
  assert.equal(updateNotice({ ...update, available: false }), null);
  const { services } = injectedServices();
  const application = createShoppingApplication({ version: '0.3.1', services, update });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'updates-test', version: '1' });
  await application.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await application.close(); });
  assert.match(client.getInstructions() ?? '', /Update available: continentept-mcp 0\.4\.0/);
  const status = await client.callTool({ name: 'get_session_status', arguments: {} });
  assert.deepEqual(dataOf(status, SessionStatusOutput.shape.result.options[0].shape.data).update, update);
  assert.match(JSON.stringify(status.content), /Update available: 0\.4\.0 \(running 0\.3\.1\)/);
});
