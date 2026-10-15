import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductIdSchema } from '../src/domain/index.js';
import { parseCartResponse } from '../src/parsers/cart.js';
import { CartService } from '../src/services/cart.js';
import { createShoppingApplication } from '../src/runtime.js';
import { ok, present, valueOf } from '../test-support/helpers.js';
import { injectedServices } from '../test-support/mcp-fixture.js';

const minicart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/minicart.json', import.meta.url), 'utf8')) as Record<string, any>;
const eur = (minorUnits: number) => ({ currency: 'EUR', minorUnits });
const line = (rates: Record<string, unknown> | undefined) => ({ action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true },
  basket: { itemsSortedByBrand: [{ items: [{ id: '00123', productName: 'Milk', secondaryQuantity: 2, price: { sales: { value: 1 } },
    ...(rates ? { measurementInfo: { quantityConversionRates: rates } } : {}) }] }] } });

test('cart lines read their unit from their own sale rules, never from the selected dimension', () => {
  const cart = valueOf(parseCartResponse(minicart()));
  assert.deepEqual(cart.items.map(item => [item.productId, item.kind, item.quantity]), [
    ['8912985', 'product', { status: 'known', quantity: { value: 3, unit: 'un' } }],
    ['7303767', 'product', { status: 'known', quantity: { value: 3, unit: 'un' } }],
    ['9999999', 'bag', { status: 'known', quantity: { value: 2, unit: 'un' } }],
  ]);
});

test('a line without usable sale rules keeps its amount with an unknown unit', () => {
  const quantity = (rates?: Record<string, unknown>) => present(valueOf(parseCartResponse(line(rates))).items[0]).quantity;
  assert.deepEqual(quantity(), { status: 'unknown', value: 2, rawText: null });
  for (const rates of [{ primaryunit: 'kg' }, { primaryunit: 'kg', secondaryunit: 'lt', hasAlternativeSaleUnit: true }, { primaryunit: 'un', selectedunit: 'primary', hasConversionRate: true }]) {
    assert.deepEqual(quantity(rates), { status: 'unknown', value: 2, rawText: null, reason: 'unsupported_unit' });
  }
});

test('cart totals keep products, bags, deposit, delivery, discounts and the amount to pay apart', () => {
  assert.deepEqual(valueOf(parseCartResponse(minicart())).totals,
    { products: eur(405), bags: eur(20), deposit: eur(10), delivery: eur(0), discounts: eur(50), grandTotal: eur(385) });
  const unreadable = minicart();
  delete unreadable.basket.resources;
  unreadable.basket.totals = { productsTotalPriceOnly: 4.05, grandTotalNumber: 'soon', totalShippingCostNumber: -1 };
  const cart = valueOf(parseCartResponse(unreadable));
  assert.ok(cart.items.every(item => item.kind === 'product'));
  assert.deepEqual(cart.totals, { products: eur(405), bags: null, deposit: null, delivery: null, discounts: null, grandTotal: null });
  assert.deepEqual(valueOf(parseCartResponse({ action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true }, basket: {} })).totals,
    { products: eur(0), bags: eur(0), deposit: eur(0), delivery: null, discounts: eur(0), grandTotal: eur(0) });
});

test('get_cart text shows units, marks bags and lists each total', async () => {
  const { services } = injectedServices();
  services.cart.getCart = async () => parseCartResponse(minicart());
  const app = createShoppingApplication({ version: 'test', services });
  const result = await app.dispatchToolCall('get_cart', {}, {});
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  assert.match(text, /Leite Meio Gordo — 3 un × €0\.85 each/);
  assert.match(text, /Saco \(bag\) — 2 un/);
  assert.match(text, /Products: €4\.05\nBags: €0\.20\nDeposit: €0\.10\nDiscounts: €0\.50\nTotal to pay: €3\.85\n/);
  assert.doesNotMatch(text, /unit unknown|Delivery/);
  await app.close();
});

test('a cart line in another unit does not confirm a change', async () => {
  const kilos = line({ primaryunit: 'un', secondaryunit: 'kg', unitConversionRate: 1, hasAlternativeSaleUnit: true });
  const service = new CartService({ async fetchCart() { return ok(kilos); } } as never);
  const result = valueOf(await service.confirmCartItemQuantity(ProductIdSchema.parse('00123'), { value: 2, unit: 'un' }, 2));
  assert.equal(result.outcome, 'unknown');
  const pieces = valueOf(await new CartService({ async fetchCart() { return ok(line({ primaryunit: 'un' })); } } as never)
    .confirmCartItemQuantity(ProductIdSchema.parse('00123'), { value: 2, unit: 'un' }, 2));
  assert.equal(pieces.outcome, 'confirmed');
});
