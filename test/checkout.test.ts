import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENTREGA_ZERO_FREE_FROM, ProductIdSchema, checkoutFor } from '../src/domain/index.js';
import type { ProductDetails } from '../src/domain/index.js';
import { minimumOrderOf, parseCartResponse } from '../src/parsers/cart.js';
import { CartData, PreviewData } from '../src/mcp/contracts.js';
import { ok, valueOf } from '../test-support/helpers.js';
import { dataOf, textOf } from '../test-support/assertions.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

const eur = (minorUnits: number) => ({ currency: 'EUR' as const, minorUnits });
/** The mini-cart fixture (€4.05 of products) with the account resources a signed-in cart carries. */
function minicart(options: { entregaZero?: boolean; products?: number; signedIn?: boolean } = {}) {
  const cart = JSON.parse(readFileSync(new URL('../../test/fixtures/minicart.json', import.meta.url), 'utf8')) as {
    resources: Record<string, unknown>; basket: { totals: Record<string, unknown> } };
  cart.resources = { ...cart.resources, customerAuthenticated: options.signedIn ?? true, minimumOrderValueWarning: 'Encomenda mínima: 20€.', isEntregaZero: options.entregaZero ?? false };
  if (options.products !== undefined) cart.basket.totals.productsTotalPriceOnly = options.products;
  return cart;
}

test('the minimum order comes from the cart\'s message, and delivery is free only with EntregaZero from €50', () => {
  assert.deepEqual(minimumOrderOf('Encomenda mínima: 20€.'), eur(2000));
  assert.deepEqual(minimumOrderOf('Encomenda mínima: 25,50 €'), eur(2550));
  for (const message of ['Encomenda: 20€', '', null, 20]) assert.equal(minimumOrderOf(message), null);
  assert.deepEqual(ENTREGA_ZERO_FREE_FROM, eur(5000));
  assert.deepEqual(checkoutFor(eur(5000), eur(2000), true), { minimumOrder: eur(2000), meetsMinimum: true, entregaZero: true, freeDeliveryFrom: eur(5000), deliveryFee: 'free' });
  assert.deepEqual(checkoutFor(eur(4999), eur(2000), true), { minimumOrder: eur(2000), meetsMinimum: true, entregaZero: true, freeDeliveryFrom: eur(5000), deliveryFee: 'set_at_checkout' });
  assert.deepEqual(checkoutFor(eur(9000), eur(2000), false), { minimumOrder: eur(2000), meetsMinimum: true, entregaZero: false, freeDeliveryFrom: null, deliveryFee: 'set_at_checkout' });
  assert.deepEqual(checkoutFor(eur(1999), eur(2000), null), { minimumOrder: eur(2000), meetsMinimum: false, entregaZero: null, freeDeliveryFrom: null, deliveryFee: 'set_at_checkout' });
  assert.deepEqual(checkoutFor(null, eur(2000), true), { minimumOrder: eur(2000), meetsMinimum: null, entregaZero: true, freeDeliveryFrom: eur(5000), deliveryFee: 'set_at_checkout' });
});

test('the cart\'s checkout reads the minimum and EntregaZero, which a signed-out cart cannot have', () => {
  assert.deepEqual(valueOf(parseCartResponse(minicart({ entregaZero: true }))).checkout,
    { minimumOrder: eur(2000), meetsMinimum: false, entregaZero: true, freeDeliveryFrom: eur(5000), deliveryFee: 'set_at_checkout' });
  assert.deepEqual(valueOf(parseCartResponse(minicart({ entregaZero: true, products: 62.4 }))).checkout.deliveryFee, 'free');
  assert.equal(valueOf(parseCartResponse(minicart({ entregaZero: true, signedIn: false }))).checkout.entregaZero, null);
});

test('get_cart and preview_cart_changes say the minimum order and the delivery fee', async t => {
  const { services } = injectedServices();
  let cart = minicart({ entregaZero: true, products: 62.4 });
  services.cart.getCart = async () => parseCartResponse(cart);
  const atum: ProductDetails = { productId: ProductIdSchema.parse('3697794'), productSlug: null, name: 'Atum', url: 'https://www.continente.pt/produto/atum-3697794.html',
    price: { amount: eur(115), per: 'item' }, secondaryPrice: null, recommendedPrice: null, promotions: [], packageText: null, package: null, minimumText: null,
    drainedPrice: null, unitPrice: null, imageUrl: null, availability: 'available',
    saleRules: { status: 'available', rules: { saleUnit: 'un', storefrontUnit: 'un', storefrontUnitsPerSaleUnit: 1, minimum: { value: 1, unit: 'un' }, maximum: { value: 99, unit: 'un' }, step: { value: 1, unit: 'un' } } } };
  services.catalog.getProduct = async () => ok(atum);
  const { client } = await connect(t, services);

  const free = await client.callTool({ name: 'get_cart' });
  assert.equal(dataOf(free, CartData).checkout.deliveryFee, 'free');
  assert.match(textOf(free), /\nMinimum order: €20\.00, reached\.\nDelivery: free with your EntregaZero \(orders of €50\.00 or more\)\.\nCheckout happens/);

  cart = minicart({ entregaZero: true });
  assert.match(textOf(await client.callTool({ name: 'get_cart' })),
    /\nMinimum order: €20\.00, €15\.95 to go\.\nDelivery fee: set at checkout by day, time slot and area; not included here\. Your EntregaZero makes it free from €50\.00: €45\.95 to go\.\n/);
  cart = minicart();
  assert.match(textOf(await client.callTool({ name: 'get_cart' })), /\nDelivery fee: set at checkout by day, time slot and area; not included here\.\nCheckout happens/);

  // 40 tins at €1.15 take €4.05 of products to €50.05: over the minimum and, with EntregaZero, free delivery.
  cart = minicart({ entregaZero: true });
  const preview = await client.callTool({ name: 'preview_cart_changes', arguments: { items: [{ productId: '3697794', quantity: 40 }] } });
  const data = dataOf(preview, PreviewData);
  assert.deepEqual([data.productsAfter, data.checkout.meetsMinimum, data.checkout.deliveryFee], [eur(5005), true, 'free']);
  assert.match(textOf(preview), /Products in the cart after these changes: €50\.05\nMinimum order: €20\.00, reached\.\nDelivery: free with your EntregaZero/);
});
