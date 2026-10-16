import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProductIdSchema, lisbonDate, parsePromotionDates, parsePromotionLabel, previousPriceOf } from '../src/domain/index.js';
import type { Promotion } from '../src/domain/index.js';
import { parseProductSearchPage } from '../src/parsers/catalog.js';
import { parseProductDetails } from '../src/parsers/product.js';
import { parseCartResponse } from '../src/parsers/cart.js';
import { createShoppingServices } from '../src/runtime.js';
import { createSerialTaskQueue } from '../src/session/queue.js';
import { fixture, ok, valueOf } from '../test-support/helpers.js';
import { connect } from '../test-support/mcp-fixture.js';
import { textOf } from '../test-support/assertions.js';

const eur = (minorUnits: number) => ({ currency: 'EUR' as const, minorUnits });
const none = { previousPrice: null, percentOff: null, amountOff: null, bundle: null, nthUnit: null, validFrom: null, validTo: null };
const promotion = (kind: Promotion['kind'], label: string, fields: Partial<Promotion> = {}): Promotion => ({ kind, label, ...none, ...fields });
const minicart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/promotions-minicart.json', import.meta.url), 'utf8')) as unknown;

test('promotion labels as the website prints them are recognised, and anything else is kept as shown', () => {
  assert.deepEqual(parsePromotionLabel('PVP Recomendado: 2,71€/un'), promotion('recommended_price', 'PVP Recomendado: 2,71€/un'));
  assert.deepEqual(parsePromotionLabel('Desconto Imediato: 6%'), promotion('immediate_discount', 'Desconto Imediato: 6%', { percentOff: 6 }));
  assert.deepEqual(parsePromotionLabel('Desconto Imediato: 31€'), promotion('immediate_discount', 'Desconto Imediato: 31€', { amountOff: eur(3100) }));
  assert.deepEqual(parsePromotionLabel(' Leve 3 Por 1€ '), promotion('multi_buy', 'Leve 3 Por 1€', { bundle: { quantity: 3, total: eur(100) } }));
  assert.deepEqual(parsePromotionLabel('Leve 2 Por 12€'), promotion('multi_buy', 'Leve 2 Por 12€', { bundle: { quantity: 2, total: eur(1200) } }));
  assert.deepEqual(parsePromotionLabel('Leve 3 unidades por 1€'), promotion('multi_buy', 'Leve 3 unidades por 1€', { bundle: { quantity: 3, total: eur(100) } }));
  assert.deepEqual(parsePromotionLabel('20% na 2ª un'), promotion('nth_unit_discount', '20% na 2ª un', { percentOff: 20, nthUnit: 2 }));
  // Unknown or impossible offers keep their label and nothing else.
  for (const label of ['Oferta especial no Dia do Cliente', 'Leve 1 Por 1€', '20% na 1ª un', 'Desconto Imediato: 150%']) assert.deepEqual(parsePromotionLabel(label), promotion('other', label));
  assert.equal(parsePromotionLabel('  '), null);
});

test('previous prices take the current unit when the website leaves it out, and dates are Lisbon calendar days', () => {
  assert.deepEqual(previousPriceOf(' 7,99€ ', { amount: eur(749), per: 'kg' }), { amount: eur(799), per: 'kg' });
  assert.deepEqual(previousPriceOf('3,79€', { amount: eur(329), per: 'item' }), { amount: eur(379), per: 'item' });
  assert.equal(previousPriceOf('', { amount: eur(329), per: 'item' }), null);
  assert.deepEqual(parsePromotionDates('Promoção válida de 13/10/2026 a 26/10/2026'), { validFrom: '2026-10-13', validTo: '2026-10-26' });
  assert.deepEqual(parsePromotionDates('Promoção válida de 31/02/2026 a 26/10/2026'), { validFrom: null, validTo: '2026-10-26' });
  assert.equal(parsePromotionDates('Promoção válida'), null);
  // Summer time (UTC+1) and winter time (UTC+0) both end on the same Lisbon day.
  assert.equal(lisbonDate('2026-10-19T22:59:59Z'), '2026-10-19');
  assert.equal(lisbonDate('2026-10-26T23:59:59Z'), '2026-10-26');
  assert.equal(lisbonDate('2026-10-12T23:00:00Z'), '2026-10-13');
  assert.equal(lisbonDate('soon'), null);
});

test('search tiles carry each kind of promotion with the price before it', () => {
  const page = valueOf(parseProductSearchPage(fixture('promotions-search')));
  assert.deepEqual(page.problems, []);
  assert.deepEqual(Object.fromEntries(page.products.map(product => [product.productId, product.promotions])), {
    7477288: [promotion('recommended_price', 'PVP Recomendado: 2,71€/un', { previousPrice: { amount: eur(271), per: 'item' } })],
    7023912: [promotion('immediate_discount', 'Desconto Imediato: 6%', { percentOff: 6, previousPrice: { amount: eur(799), per: 'kg' } })],
    7949141: [promotion('immediate_discount', 'Desconto Imediato: 3€', { amountOff: eur(300), previousPrice: { amount: eur(500), per: 'item' } })],
    8607640: [promotion('multi_buy', 'Leve 3 Por 1€', { bundle: { quantity: 3, total: eur(100) } })],
    7462865: [promotion('nth_unit_discount', '20% na 2ª un', { percentOff: 20, nthUnit: 2 })],
    1234567: [promotion('other', 'Oferta especial no Dia do Cliente')],
  });
  // The "Indisponível" badge every tile carries is not a promotion, and a plain tile has none.
  assert.ok(valueOf(parseProductSearchPage(fixture('catalog'))).products.every(product => product.promotions.length === 0));
});

test('product pages give their own promotion with its dates, never a recommendation tile\'s', () => {
  const url = 'https://www.continente.pt/produto/leite-00123.html'; const id = ProductIdSchema.parse('00123');
  const badge = (alt: string) => `<div class="product-name-details--wrapper"><div class="col-12"><div class="ct-product-tile-badge ct-product-tile-badge--promotional"><img alt="${alt}" title="%"></div></div></div>`;
  const dates = '<div class="ct-pdp--promo-time"><span class="ct-pdp--promo-time-text">Promoção válida de 13/10/2026 a 26/10/2026</span></div>';
  const recommendation = '<div class="product-tile"><div class="dual-badge-00123 dual-badge-message"><span class="dual-badge-message-text">Leve 9 Por 1€</span></div></div>';
  const page = fixture('product').replace('<div class="list"><span class="pvpr-info">PVPR</span> 1,49&euro;</div>',
    '<div class="list"><span class="strike-through"><span class="value"> 1,49€ </span></span></div>') + badge('Desconto Imediato: 13%') + dates + recommendation;
  assert.deepEqual(valueOf(parseProductDetails(page, url, id)).promotions,
    [promotion('immediate_discount', 'Desconto Imediato: 13%', { percentOff: 13, previousPrice: { amount: eur(149), per: 'item' }, validFrom: '2026-10-13', validTo: '2026-10-26' })]);
  // Two promotions share one date line, so neither gets it.
  const multi = '<div class="dual-badge"><div class="dual-badge-00123 dual-badge-message"><span class="dual-badge-message-text">Leve 3 Por 1€</span></div></div>';
  assert.deepEqual(valueOf(parseProductDetails(page + multi, url, id)).promotions.map(item => [item.kind, item.validTo]), [['immediate_discount', null], ['multi_buy', null]]);
  assert.deepEqual(valueOf(parseProductDetails(fixture('product'), url, id)).promotions, []);
});

test('cart lines carry the badge promotion with its dates, and a multi-buy with the total before its discount', () => {
  const cart = valueOf(parseCartResponse(minicart()));
  assert.deepEqual(cart.items.map(item => [item.productId, item.promotions, item.lineTotalBeforeDiscount]), [
    ['7477288', [promotion('recommended_price', 'PVP Recomendado: 2,71€/un', { previousPrice: { amount: eur(271), per: 'item' }, validFrom: '2026-10-07', validTo: '2026-10-19' })], null],
    ['7082533', [promotion('immediate_discount', 'Desconto Imediato: 13%', { percentOff: 13, previousPrice: { amount: eur(379), per: 'item' }, validFrom: '2026-10-13', validTo: '2026-10-26' })], null],
    ['8607640', [promotion('multi_buy', 'Leve 3 Por 1€', { bundle: { quantity: 3, total: eur(100) }, validFrom: '2026-09-29', validTo: '2026-10-18' })], eur(117)],
    ['8912985', [], null],
  ]);
  assert.deepEqual(cart.items[2]?.lineTotal, eur(100));
});

test('search, product and cart text show promotions beside the price', async t => {
  const services = createShoppingServices({ env: { CONTINENTE_CREDENTIALS_FILE: join(tmpdir(), 'continente-fixture-absent.env'), CONTINENTE_DATA_DIR: join(tmpdir(), 'continente-fixture-promotions'), CONTINENTE_EMAIL: '', CONTINENTE_PASSWORD: '' },
    session: { async ensureReady(): Promise<never> { throw new Error('no browser'); }, run: createSerialTaskQueue(), async closeBrowserSession() {}, async refreshAuthentication() { return false; } },
    logger: () => {}, clock: { now: () => new Date('2026-10-14T12:00:00Z') },
    favoritesStore: { async load() { return ok(null); }, async save() { return ok(); } },
    catalogClient: { async searchProducts() { return ok({ pages: [fixture('promotions-search')], failures: [] }); },
      async fetchProductDetails() { return ok({ html: fixture('product') + '<div class="product-name-details--wrapper"><div class="ct-product-tile-badge--promotional"><img alt="PVP Recomendado: 1,49€/un"></div></div>' +
        '<span class="ct-pdp--promo-time-text">Promoção válida de 07/10/2026 a 19/10/2026</span>', url: 'https://www.continente.pt/produto/leite-00123.html' }); } },
    favoritesClient: { async fetchFavorites() { return ok({ pages: [], failures: [] }); } },
    ordersClient: { async fetchOrderHistory() { return ok(''); }, async fetchOrderLines() { return ok(''); } },
    cartClient: { async fetchCart() { return ok(minicart()); }, async fetchProductForm() { return ok({}); }, async fetchCartControls() { return ok(''); },
      async submitCartMutation() { throw new Error('read only'); } },
  });
  const { client } = await connect(t, services);
  const search = textOf(await client.callTool({ name: 'search_products', arguments: { query: 'promo', limit: 10 } }));
  assert.match(search, /Queijo Flamengo Fatiado no Balcão Continente — €7\.49\/kg; offer: Desconto Imediato: 6% \(was €7\.99\/kg\)/);
  assert.match(search, /Paté com Bacalhau Continente Pet — €0\.39; offer: Leve 3 Por 1€ \(3 for €1\.00, applied in the cart\)/);
  assert.match(search, /Vaca e Borrego — €4\.59; offer: 20% na 2ª un \(20% off the 2nd unit, applied in the cart\)/);
  assert.match(search, /Iogurte Grego Natural Mimosa — €1\.89, PVPR €2\.71, pack/);
  const product = textOf(await client.callTool({ name: 'get_product', arguments: { productId: '00123' } }));
  assert.match(product, /Promotions: PVP Recomendado: 1,49€\/un \(PVPR €1\.49\) until 2026-10-19/);
  const cart = textOf(await client.callTool({ name: 'get_cart', arguments: {} }));
  assert.match(cart, /× €0\.39, line €1\.00 \(€1\.17 before the discount\); offer: Leve 3 Por 1€ \(3 for €1\.00, applied in the cart\) until 2026-10-18/);
  assert.match(cart, /Azeite Continente — 1 un × €3\.29, line €3\.29; offer: Desconto Imediato: 13% \(was €3\.79\) until 2026-10-26/);
});
