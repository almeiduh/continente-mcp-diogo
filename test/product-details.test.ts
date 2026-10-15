import { having, double, dataOf } from '../test-support/assertions.js';
import type { FavoritesService } from '../src/services/catalog.js';
import { ProductIdSchema } from '../src/domain/index.js';
import { ProductDetailsData } from '../src/mcp/contracts.js';
import { present, valueOf, errorOf, fixture, fail } from '../test-support/helpers.js';
import { parseProductDetails } from '../src/parsers/product.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';
import { CatalogService } from '../src/services/catalog.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const url = 'https://www.continente.pt/produto/leite-00123.html';
test('product detail retains stable identity, bounded sale rules and explicit price basis', () => {
  const result = parseProductDetails(fixture('product'), url, ProductIdSchema.parse('00123')); assert.equal(result.ok, true);
  const product = result.value; assert.equal(product.productId, '00123'); assert.equal(product.productSlug, 'leite-00123');
  assert.deepEqual(product.price, { amount: { currency: 'EUR', minorUnits: 129 }, per: 'item' });
  assert.deepEqual(product.recommendedPrice, { amount: { currency: 'EUR', minorUnits: 149 }, per: 'item' });
  assert.equal(product.availability, 'available'); assert.deepEqual(having(product.saleRules, 'rules').rules.maximum, { value: 10, unit: 'un' });
  assert.equal(having(product.saleRules, 'rules').rules.storefrontUnitsPerSaleUnit, 1);
});
test('product detail fails closed on changed identity and never invents missing metadata or recommendation prices', () => {
  assert.equal(errorOf(parseProductDetails(fixture('product'), url.replace('00123', '999'), ProductIdSchema.parse('00123'))).code, 'invalid_data');
  assert.equal(errorOf(parseProductDetails('<main>Changed</main>', url, ProductIdSchema.parse('00123'))).code, 'invalid_data');
  const html = '<h1 class="product-name">Leite</h1><input name="productID" value="00123"><aside><div class="list"><span class="pvpr-info">PVPR</span> 12,99€</div><span class="pwc-tile--price-primary">9,99€</span></aside>';
  const product = valueOf(parseProductDetails(html, url, ProductIdSchema.parse('00123')));
  assert.equal(product.price, null); assert.equal(product.recommendedPrice, null); assert.equal(product.availability, 'unknown');
  assert.equal(product.saleRules.status, 'unavailable');
  const unavailable = fixture('product').replace('InStock', 'OutOfStock').replace('"primaryunit":"un"', '"primaryunit":"unknown"');
  assert.equal(valueOf(parseProductDetails(unavailable, url, ProductIdSchema.parse('00123'))).availability, 'unavailable');
  assert.equal(valueOf(parseProductDetails(unavailable, url, ProductIdSchema.parse('00123'))).saleRules.status, 'unavailable');
});
test('get_product is read-only, validates input before I/O and preserves not-found errors', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'get_product', arguments: { productId: '00123' } });
  assert.equal(dataOf(result, ProductDetailsData).productId, '00123'); assert.equal(state.writes, 0); assert.equal(state.refreshes, 0);
  await assert.rejects(client.callTool({ name: 'get_product', arguments: { productId: '../bad' } })); assert.equal(state.reads, 1);
  assert.equal(present(present((await client.listTools()).tools.find(tool => tool.name === 'get_product')).annotations).readOnlyHint, true);
  const service = new CatalogService({ async searchProducts() { throw new Error('Unexpected search'); }, async fetchProductDetails() { return fail('not_found'); } }, double<FavoritesService>({}));
  assert.equal(errorOf((await service.getProduct('00123'))).code, 'not_found');
});
