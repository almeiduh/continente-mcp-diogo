import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, valueOf } from '../test-support/helpers.js';
import { parsePickupStores } from '../src/parsers/stores.js';
import { PickupStoresClient } from '../src/clients/stores.js';
import { success } from '../src/domain/index.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

test('store locator parsing returns only pickup-capable stores and marks context unchanged', () => {
  const result = valueOf(parsePickupStores(fixture('stores')));
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0]?.storeId, 'synthetic-store-001');
  assert.equal(result.stores[0]?.name, 'Continente Teste');
  assert.deepEqual(result.stores[0]?.storeHours, { weekdays: '09:00-21:00' });
  assert.equal(result.selectedStoreChanged, false);
});

test('store locator does not claim completeness while a next chunk is advertised', () => {
  const html = fixture('stores').replace('<div class="delivery-nearest">', '<div class="delivery-nearest" data-stores-per-load="20" data-stores-per-load-next="20">');
  assert.equal(valueOf(parsePickupStores(html)).completeness, 'unknown');
  const finalChunk = html.replace('data-stores-per-load-next="20"', 'data-stores-per-load-next=""')
    .replace('</div>\n', '<div class="coverage-area-no-stores-chunk"></div></div>\n');
  assert.equal(valueOf(parsePickupStores(finalChunk)).completeness, 'complete');
});

test('store lookup sends the observed geocoded query and makes no context mutation', async () => {
  const calls: { url: string; maxRedirects?: number }[] = [];
  const lease = { context: { request: { async get(url: string, options: { maxRedirects?: number }) {
    calls.push({ url, ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}) });
    return { ok: () => true, status: () => 200, url: () => url, async text() { return fixture('stores'); } };
  } } } };
  const site = { session: { async ensureReady() { return lease; } }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
  const client = new PickupStoresClient(site);
  assert.equal((await client.fetchPickupStores({ postalCode: 'Mafra', latitude: 38.9, longitude: -9.3 })).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await client.fetchPickupStores({ postalCode: '2640-000', latitude: 38.9, longitude: -9.3, city: 'Mafra' })).ok, true);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/on/demandware.store/Sites-continente-Site/default/Stores-GetStores');
  assert.deepEqual(Object.fromEntries(url.searchParams), { isQuerySearch: 'true', deliveryLocation: '2640-000',
    deliveryPostalCode: '2640-000', latitude: '38.9', longitude: '-9.3', searchLatitude: '38.9', searchLongitude: '-9.3', city: 'Mafra' });
  assert.equal(calls[0]?.maxRedirects, 0);
  assert.equal(calls.some(call => /SetStoreContext/.test(call.url)), false);
});

test('list_pickup_stores reports the observed store locator result schema', async t => {
  const { services } = injectedServices();
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'list_pickup_stores', arguments: { postalCode: '2640-000', latitude: 38.9, longitude: -9.3 } });
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { result: { data: { stores: unknown[]; selectedStoreChanged: boolean } } };
  assert.equal(payload.result.data.stores.length, 1);
  assert.equal(payload.result.data.selectedStoreChanged, false);
  assert.match(JSON.stringify(result.content), /Pickup-slot availability is not included/);
});
