import { present, valueOf, errorOf, fixture, ok, fail } from '../test-support/helpers.js';
import { z } from 'zod';
import { ProductIdSchema } from '../src/domain/index.js';
import { FrequencyData, OrdersData } from '../src/mcp/contracts.js';
import type { OrderLine } from '../src/domain/index.js';
import type { OrdersGateway } from '../src/ports.js';

import { statusOf, dataOf, toolError } from '../test-support/assertions.js';
import { OrderService, PurchaseHistoryService } from '../src/services/orders.js';
import { aggregatePurchaseFrequency } from '../src/parsers/orders.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const card = (id: number) => `<div class="ct-order-history--order-preview-item"><div class="ct-order-history--order-preview-number">123456789_${String(id).padStart(3, '0')}</div><span class="ct-order-history--order-preview-delivery-date">1 outubro 2026</span><a href="/conta/detalhe-encomenda/?orderID=${id}">Details</a><a href="/conta/detalhe-encomenda/?orderID=${id}">Duplicate mobile link</a></div>`;
const page = (ids: number[], next: number | null = null, total = 3) => `<div class="ct-order-history--landing-container" data-order-count="${total}">${ids.map(card).join('')}${next ? `<a rel="next" href="/conta/encomendas/?start=${next}">Next</a>` : ''}</div>`;
const line = (id: string | null, name: string, quantity = 1, unit: 'un' | 'kg' = 'un'): OrderLine => ({ productId: id === null ? null : ProductIdSchema.parse(id), name, quantity: { status: 'known', quantity: { value: quantity, unit } } });
test('frequency uses stable IDs, separates name-only fallbacks and variants, counts once per order and breaks ties deterministically', () => {
  const unknown: OrderLine = { ...line('1', 'Renamed'), quantity: { status: 'unknown', value: null, rawText: '?', reason: 'unrecognized_format' } };
  const products = valueOf(aggregatePurchaseFrequency([[line('1', 'Newest name', 2), line('1', 'Newest name', 3), line('2', 'Newest name'), line(null, 'Newest name'), line('1', 'Newest name', 0.5, 'kg')], [unknown]]));
  assert.deepEqual(products.map(p => p.productId), ['1', '2', null]);
  assert.equal(present(products[0]).name, 'Newest name'); assert.equal(present(products[0]).orders, 2); assert.equal(present(products[0]).unknownQuantityLines, 1);
  assert.deepEqual(present(products[0]).quantities, [{ value: 5, unit: 'un' }, { value: 0.5, unit: 'kg' }]);
  assert.equal(present(products[2]).identityBasis, 'name');
  for (const ids of [['9', '3'], ['3', '9']] as const) assert.deepEqual(valueOf(aggregatePurchaseFrequency([ids.map(id => line(id, 'Same'))])).map(p => p.productId), ['3', '9']);
});
test('order summary limit and detail budget are independent across pages with duplicate links', async () => {
  const lists = []; const details = [];
  const client: OrdersGateway = { async fetchOrderHistory(cursor) { lists.push(cursor); return ok(cursor?.includes('start=2') ? page([2, 3]) : page([1, 2], 2)); },
    async fetchOrderLines(url) { details.push(url); return ok(fixture('order')); } };
  const service = new OrderService(client);
  const result = valueOf((await service.listOrders(3, { detailLimit: 1 })));
  assert.deepEqual(result.items.map(o => o.orderId), ['1', '2', '3']); assert.equal(result.detailsRead, 1); assert.equal(details.length, 1);
  assert.deepEqual(result.items.map(o => o.lines.status), ['available', 'not_requested', 'not_requested']);
  assert.equal(result.completeness, 'complete'); assert.equal(result.hasMore, false); assert.equal(result.nextCursor, null); assert.equal(lists.length, 2);
  await service.listOrders(3, { includeLines: false }); assert.equal(details.length, 1);
});
test('opaque cursors retain the last returned summary within a page and reject changed anchors and foreign paths', async () => {
  let source = page([1, 2, 3]); let calls = 0;
  const service = new OrderService({ async fetchOrderHistory() { calls++; return ok(source); }, async fetchOrderLines() { throw new Error('not requested'); } });
  const first = valueOf((await service.listOrders(1, { includeLines: false })));
  assert.equal(first.hasMore, true); assert.equal(present(first.items[0]).orderId, '1');
  const second = valueOf((await service.listOrders(1, { includeLines: false, cursor: present(first.nextCursor) })));
  assert.equal(present(second.items[0]).orderId, '2');
  const third = valueOf((await service.listOrders(1, { includeLines: false, cursor: present(second.nextCursor) })));
  assert.equal(present(third.items[0]).orderId, '3'); assert.equal(third.hasMore, false);
  source = page([2, 3]); assert.equal(errorOf((await service.listOrders(1, { cursor: present(first.nextCursor) }))).code, 'invalid_input');
  const before = calls;
  for (const url of ['https://other.invalid/conta/encomendas/', 'https://www.continente.pt/Cart-RemoveProduct?uuid=secret'] as const) {
    assert.equal(errorOf((await service.listOrders(1, { cursor: Buffer.from(JSON.stringify({ url })).toString('base64url') }))).code, 'invalid_input');
  }
  assert.equal(calls, before);
});
test('listing and detail failures are separately attributed and earlier data survives', async () => {
  const client: OrdersGateway = { async fetchOrderHistory(cursor) { return cursor?.includes('start=2') ? fail() : ok(page([1, 2], 2)); },
    async fetchOrderLines(url) { return url.includes('orderID=1') ? ok(fixture('order')) : ok('<main>Changed</main>'); } };
  const result = valueOf((await new OrderService(client).listOrders(5)));
  assert.equal(result.items.length, 2); assert.equal(result.completeness, 'partial'); assert.ok(result.nextCursor);
  assert.deepEqual(result.scanFailures.map(f => f.stage), ['listing', 'detail']);
  const frequency = valueOf((await new PurchaseHistoryService(client).listFrequentlyBoughtProducts(5)));
  assert.equal(frequency.listed, 2); assert.equal(frequency.scanned, 2); assert.equal(frequency.succeeded, 1); assert.equal(frequency.failed, 1);
  assert.equal(frequency.failures.length, 2); assert.ok(frequency.products.length);
});
test('complete empty history, empty orders, and unreadable detail scans have different MCP outcomes', async t => {
  const { services } = injectedServices(); let mode = 'no-orders';
  const upstream = { async fetchOrderHistory() { return ok(mode === 'no-orders' ? page([], null, 0) : page([1], null, 1)); },
    async fetchOrderLines() { return ok(mode === 'empty-order' ? '<input name="orderLineItems" value="[]"><div class="ct-order-history--products-list-container"></div>' : '<main>Unrecognized</main>'); } };
  services.orders = new OrderService(upstream); services.history = new PurchaseHistoryService(upstream);
  const { client } = await connect(t, services);
  let result = await client.callTool({ name: 'list_frequently_bought_products' });
  assert.equal(statusOf(result), 'empty'); assert.equal(dataOf(result, FrequencyData).listed, 0); assert.equal(dataOf(result, FrequencyData).completeness, 'complete');
  mode = 'empty-order'; result = await client.callTool({ name: 'list_frequently_bought_products' });
  assert.equal(statusOf(result), 'empty'); assert.equal(dataOf(result, FrequencyData).succeeded, 1);
  mode = 'unreadable'; result = await client.callTool({ name: 'list_frequently_bought_products' });
  assert.equal(result.isError, true); assert.equal(toolError(result).code, 'order_details_unavailable');
  const scan = z.object({ result: z.object({ status: z.literal('error'), scan: FrequencyData }) }).parse(result.structuredContent).result.scan;
  assert.equal(scan.failed, 1); assert.equal(present(scan.failures[0]).stage, 'detail');
  const summaries = await client.callTool({ name: 'list_orders', arguments: { includeLines: false } });
  assert.equal(dataOf(summaries, OrdersData).detailBudget, 0); assert.equal(present(dataOf(summaries, OrdersData).orders[0]).lines.status, 'not_requested');
});
