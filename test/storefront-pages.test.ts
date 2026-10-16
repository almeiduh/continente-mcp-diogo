import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogClient, OrdersClient, StorefrontClient } from '../src/clients/storefront.js';
import type { StorefrontSession } from '../src/session/browser.js';
import { double } from '../test-support/assertions.js';

interface Visit { url: string; html: string; ready: boolean }
/** A browser double that serves one visit per navigation and records what was loaded. */
function site(visits: Visit[]) {
  const loaded: string[] = []; let markerWaits = 0; let current: Visit | undefined;
  const page = {
    isClosed: () => false, async close() {}, url: () => current?.url ?? 'about:blank',
    async goto(url: string) { loaded.push(url); current = visits[Math.min(loaded.length, visits.length) - 1]; return { ok: () => true, status: () => 200 }; },
    async waitForSelector() { markerWaits++; if (!current?.ready) throw new Error('Timeout 10000ms exceeded'); return null; },
    async content() { return current?.html ?? ''; },
  };
  const session = double<StorefrontSession>({ async ensureReady() { return { page, context: { async close() {} } }; } });
  return { client: new StorefrontClient(session), loaded, markerWaits: () => markerWaits };
}
const interim: Visit = { url: 'https://www.continente.pt/conta/encomendas/', html: '<main>A preparar a sessão</main>', ready: false };
const history: Visit = { url: 'https://www.continente.pt/conta/encomendas/', html: '<div class="ct-order-history--landing-container"></div>', ready: true };

test('a first visit that lands on an interim page is loaded once more', async () => {
  const orders = site([interim, history]);
  assert.deepEqual(await new OrdersClient(orders.client).fetchOrderHistory(), { ok: true, value: history.html });
  assert.equal(orders.loaded.length, 2);
  const search = site([{ ...interim, url: 'https://www.continente.pt/pesquisa/?q=banana' }, { url: 'https://www.continente.pt/pesquisa/?q=banana', html: '<div data-search-empty></div>', ready: true }]);
  assert.equal((await new CatalogClient(search.client).searchProducts('banana', 5)).ok, true);
  assert.equal(search.loaded.length, 2);
});

test('a page that never shows its marker is loaded twice, then judged rather than retried again', async () => {
  const orders = site([interim]);
  assert.deepEqual(await new OrdersClient(orders.client).fetchOrderHistory(), { ok: true, value: interim.html });
  assert.equal(orders.loaded.length, 2);
  const search = site([{ ...interim, url: 'https://www.continente.pt/pesquisa/?q=banana' }]);
  const result = await new CatalogClient(search.client).searchProducts('banana', 5);
  assert.deepEqual(result.ok ? null : result.error.code, 'upstream_unavailable');
  assert.equal(search.loaded.length, 2);
  const ready = site([history]);
  await new OrdersClient(ready.client).fetchOrderHistory();
  assert.equal(ready.loaded.length, 1);
});

test('a product the website redirects to its home page is reported as not shown to this session', async () => {
  const gone = site([{ url: 'https://www.continente.pt/', html: '<main>Home</main>', ready: true }]);
  const result = await new CatalogClient(gone.client).fetchProductDetails('rolo-de-cozinha-6781864');
  assert.deepEqual(result.ok ? null : [result.error.code, result.error.message], ['not_found', 'The website does not show this product to this session: it may not be sold in your area, or no longer be sold']);
  assert.equal(gone.loaded.length, 1); assert.equal(gone.markerWaits(), 0);
  const product = site([{ url: 'https://www.continente.pt/produto/leite-00123.html', html: '<h1 class="product-name">Leite</h1>', ready: true }]);
  assert.equal((await new CatalogClient(product.client).fetchProductDetails('leite-00123')).ok, true);
});
