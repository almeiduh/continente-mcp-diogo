import { having, double, statusOf, dataOf, toolError, mutationOf } from '../test-support/assertions.js';
import type { OrdersGateway } from '../src/ports.js';
import { present, valueOf, errorOf, ok, fail, rawCart, cartControls, fixture } from '../test-support/helpers.js';
import type { StorefrontClient } from '../src/clients/storefront.js';
import { SingleOrderOutput } from '../src/mcp/contracts.js';
import { MutationData } from '../src/mcp/contracts.js';
import { CartService } from '../src/services/cart.js';
import { OrderService } from '../src/services/orders.js';
import { OrdersClient } from '../src/clients/storefront.js';
import { responseStatus } from '../src/clients/policy.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

const singleOrderData = SingleOrderOutput.shape.result.options[0].shape.data;

import assert from 'node:assert/strict';
import test from 'node:test';

test('get_order makes one detail request with a safe identifier and retains separate display identity and unknown quantities', async t => {
  let reads = 0;
  const { services } = injectedServices();
  services.orders = new OrderService({ async fetchOrderHistory() { throw new Error('Must not scan history'); }, async fetchOrderLines(url) {
    reads++; assert.equal(new URL(url).searchParams.get('orderID'), 'opaque-id');
    return ok('<h2 class="order-list-title">Encomenda 123456789_001</h2>' + fixture('order').replace('2 un', 'unknown'));
  } });
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'get_order', arguments: { orderId: 'opaque-id' } });
  assert.equal(statusOf(result), 'partial'); const { order, unknownQuantityLines } = dataOf(result, singleOrderData);
  assert.equal(order.orderId, 'opaque-id'); assert.equal(order.orderNumber, '123456789_001'); assert.equal(unknownQuantityLines, 1);
  assert.equal(having(present(having(order.lines, 'items').items[0]).quantity, 'rawText').rawText, 'unknown'); assert.equal(reads, 1);
  await assert.rejects(client.callTool({ name: 'get_order', arguments: { orderId: 'bad id' } })); assert.equal(reads, 1);
  assert.equal(present(present((await client.listTools()).tools.find(tool => tool.name === 'get_order')).annotations).readOnlyHint, true);
});
test('get_order distinguishes not found, authentication and unreadable details; redirects cannot change identity', async () => {
  const gateway: OrdersGateway = { async fetchOrderHistory() { throw new Error('Unexpected history read'); }, async fetchOrderLines() { return fail('not_found'); } }; const service = new OrderService(gateway);
  assert.equal(errorOf((await service.getOrder('id'))).code, 'not_found');
  gateway.fetchOrderLines = async () => fail('not_authenticated'); assert.equal(errorOf((await service.getOrder('id'))).code, 'not_authenticated');
  gateway.fetchOrderLines = async () => ok('<main>Changed</main>'); assert.equal(errorOf((await service.getOrder('id'))).code, 'order_details_unavailable');
  assert.equal(errorOf(responseStatus({ ok: () => false, status: () => 404 }, 'https://www.continente.pt/conta/detalhe-encomenda/')).code, 'not_found');
  const client = new OrdersClient(double<StorefrontClient>({ async navigateToStorefrontPage() { return ok({ page: { url: () => 'https://www.continente.pt/conta/detalhe-encomenda/?orderID=other' } }); } }));
  assert.equal(errorOf((await client.fetchOrderLines('/conta/detalhe-encomenda/?orderID=target'))).code, 'order_details_unavailable');
});
test('remove_cart_item and zero quantity verify absence and converge without another write', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  let result = await client.callTool({ name: 'remove_cart_item', arguments: { productId: '00123' } });
  assert.equal(dataOf(result, MutationData).disposition, 'removed'); assert.equal(state.writes, 1);
  result = await client.callTool({ name: 'remove_cart_item', arguments: { productId: '00123' } });
  assert.equal(dataOf(result, MutationData).disposition, 'already_absent'); assert.equal(state.writes, 1);
  const zero = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: '00123', quantity: 0 } });
  assert.equal(dataOf(zero, MutationData).disposition, 'already_absent'); assert.equal(state.writes, 1);
  const annotations = present((await client.listTools()).tools.find(tool => tool.name === 'remove_cart_item')).annotations;
  assert.equal(present(annotations).destructiveHint, true); assert.equal(present(annotations).idempotentHint, true); assert.equal(present(annotations).readOnlyHint, false);
});
test('removal rejects ambiguity and mismatched product/UUID before writing and never accepts a present zero-quantity line', async () => {
  let rows = [{ ...rawCart(2).cart.items[0], UUID: 'a' }, { ...rawCart(3).cart.items[0], UUID: 'b' }]; let writes = 0;
  const service = new CartService({ async fetchProductForm() { throw new Error('Unexpected product read'); }, async fetchCart() { return ok({ resources: { customerAuthenticated: true }, cart: { items: rows } }); },
    async fetchCartControls() { return ok(cartControls().replaceAll('line-abc', 'a')); }, async submitCartMutation() { writes++; present(rows[0]).quantity = 0; return ok({}); } });
  assert.equal(errorOf((await service.removeCartItem('00123'))).code, 'invalid_input');
  assert.equal(errorOf((await service.removeCartItem('999', 'a'))).code, 'invalid_input'); assert.equal(writes, 0);
  assert.equal(valueOf((await service.removeCartItem('00123', 'a'))).outcome, 'unknown'); assert.equal(writes, 1);
  rows = [];
  assert.equal(having(valueOf((await service.removeCartItem('00123', 'a'))), 'disposition').disposition, 'already_absent'); assert.equal(writes, 1);
});
test('uncertain removal exposes recovery without replaying or refreshing authentication', async t => {
  const { services, state } = injectedServices(); let writes = 0;
  services.cart = new CartService({ async fetchProductForm() { throw new Error('Unexpected product read'); }, async fetchCart() { return ok(rawCart(2)); }, async fetchCartControls() { return ok(cartControls()); },
    async submitCartMutation() { writes++; return fail('not_authenticated'); } });
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'remove_cart_item', arguments: { productId: '00123' } });
  assert.equal(result.isError, true); assert.deepEqual(mutationOf(result), { outcome: 'unknown', recovery: { action: 'get_cart', automaticReplay: false } });
  assert.equal(writes, 1); assert.equal(state.refreshes, 0);
});
