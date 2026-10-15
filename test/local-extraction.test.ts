import { ProductIdSchema } from '../src/domain/index.js';
import { present, fixture, rawCart, cartControls } from '../test-support/helpers.js';
import { SearchData, OrdersData, FrequencyData, ProductDetailsData } from '../src/mcp/contracts.js';
import { statusOf, dataOf, mutationOf } from '../test-support/assertions.js';
import { localStorefront } from '../test-support/local-storefront.js';
import { connect } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = process.env.CONTINENTE_LOCAL_BROWSER_TEST === '1';
test('storefront clients extract real DOM through local Chromium and preserve reliability guarantees', { skip: !enabled && 'Run npm run test:browser; no external traffic' }, async t => {
  let catalog = fixture('catalog'); let favorites = fixture('favorites'); let order = fixture('order'); let quantity = 2;
  const { services, state } = await localStorefront(t, ({ url, mutation }) => {
    if (mutation) return { status: 503, body: 'Response lost after local mutation attempt' };
    if (url.pathname.includes('Cart-MiniCartShow')) return { type: 'application/json', body: JSON.stringify(rawCart(quantity)) };
    if (url.pathname === '/produto/00123.html') return { body: fixture('product') + '<input class="add-to-cart-url"><input name="csrf_token"><script>document.querySelector(".add-to-cart-url").value="/Cart-AddProduct";document.querySelector("[name=csrf_token]").value="synthetic-dynamic";</script>' };
    if (url.pathname === '/checkout/carrinho/') return { body: cartControls() };
    if (url.pathname === '/pesquisa/') return { body: catalog };
    if (url.pathname === '/conta/lista-produtos/') return { body: favorites };
    if (url.pathname === '/conta/encomendas/') return { body: '<div class="ct-order-history--landing-container"><div class="ct-order-history--order-preview-item"><span class="ct-order-history--order-preview-number">123456789_001</span><a href="/conta/detalhe-encomenda/?orderID=fixture-order">Details</a></div></div>' };
    if (url.pathname === '/conta/detalhe-encomenda/') return { body: '<main><h2 class="order-list-title">Encomenda 123456789_001</h2>' + order + '</main>' };
  });
  const { client } = await connect(t, services);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  await t.test('valid favorites and recognized empty survive real page extraction; changed markup preserves cache', async () => {
    assert.equal((await call('list_favorites', { refresh: true })).isError, undefined); const old = state.cache;
    favorites = '<main class="favorites-list"><div class="favorite-grid" data-pids="bad-json"></div></main>';
    assert.equal((await call('list_favorites', { refresh: true })).isError, true); assert.equal(state.cache, old);
    favorites = fixture('favorites-empty'); assert.equal(statusOf((await call('list_favorites', { refresh: true }))), 'empty');
    favorites = fixture('favorites'); await call('list_favorites', { refresh: true });
  });
  await t.test('exact favorite precedes a highly similar product', async () => {
    catalog = fixture('catalog').replace('Leite Meio Gordo', 'Exact product').replace('Banana Madeira', 'Leite Meio Gordo');
    present(present(present(state.cache).favorites[0])).name = 'Exact product';
    present(state.cache).favorites = [present(present(state.cache).favorites[0]), ...['Leite', 'Meio', 'Gordo'].map((name, index) => ({ ...present(present(state.cache).favorites[0]), productId: ProductIdSchema.parse(String(900 + index)), productSlug: null, name }))];
    const result = await call('search_products', { query: 'leite', limit: 3 }); assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(present(dataOf(result, SearchData).products[0]).favorite, true);
  });
  await t.test('product inspection and dynamic quantity form run in Chromium, with step and maximum rejecting before writes', async () => {
    assert.equal(dataOf((await call('get_product', { productId: ProductIdSchema.parse('00123') })), ProductDetailsData).saleRules.status, 'available');
    for (const amount of [1.5, 11] as const) assert.equal((await call('add_cart_item', { productId: ProductIdSchema.parse('00123'), quantity: amount })).isError, true);
    assert.equal(state.writes, 0);
  });
  await t.test('post-submission failure remains unknown and is not replayed', async () => {
    const result = await call('set_cart_item_quantity', { productId: ProductIdSchema.parse('00123'), quantity: 3 });
    assert.equal(mutationOf(result).outcome, 'unknown'); assert.equal(state.writes, 1); assert.equal(state.logins, 0);
  });
  await t.test('unrecognized order details are partial and analytics failure is an error', async () => {
    order = '<div>Changed source layout</div>';
    const history = await call('list_orders'); assert.equal(statusOf(history), 'partial');
    assert.equal(present(dataOf(history, OrdersData).orders[0]).lines.status, 'unavailable');
    assert.equal((await call('list_frequently_bought_products')).isError, true);
  });
  await t.test('unknown order quantities are retained and excluded from known purchase totals', async () => {
    order = fixture('order').replace('2 un', 'unreadable quantity');
    const result = await call('list_frequently_bought_products');
    assert.equal(dataOf(result, FrequencyData).unknownQuantityLines, 1);
    assert.deepEqual(present(dataOf(result, FrequencyData).products.find(product => product.name === 'Leite Meio Gordo')).quantities, []);
  });
  quantity = 0; assert.equal(statusOf((await call('get_cart'))), 'empty');
  assert.equal(state.writes, 1);
});
