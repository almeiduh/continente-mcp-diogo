import { present } from '../test-support/helpers.js';
import { CartItemIdSchema, CartMutationResultSchema, CartSchema, FavoritesCacheSchema, MoneySchema, ObservedQuantitySchema, OrderIdSchema, OrderSchema, ProductIdSchema, ProductReferenceSchema, ProductSaleRulesSchema, ProductSchema, PurchaseFrequencySchema, QuantitySchema, ToolErrorSchema, pageResultSchema, parseJson, parseMoneyAmount, parseProductReference, parseValue } from '../src/domain/index.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const failure = { code: 'upstream_unavailable', message: 'Unavailable', retryable: false };
const quantity = { value: 2, unit: 'un' };
const product = {
  productId: '00123', productSlug: 'milk-00123', name: 'Milk',
  price: { amount: { currency: 'EUR', minorUnits: 120 }, per: 'item' }, url: 'https://www.continente.pt/produto/milk-00123.html',
};
const rules = {
  saleUnit: 'un', storefrontUnit: 'kg', storefrontUnitsPerSaleUnit: 0.2,
  minimum: { value: 3, unit: 'un' }, maximum: null, step: null,
};

test('product references preserve string identity separately from slugs', () => {
  for (const [input, expected] of [
    ['00123', { productId: '00123', productSlug: null }],
    ['00123-master.html', { productId: '00123', productSlug: null }],
    ['milk-00123.html', { productId: '00123', productSlug: 'milk-00123' }],
    ['milk-00123-master.html', { productId: '00123', productSlug: 'milk-00123-master' }],
  ] as const) assert.deepEqual(parseProductReference(input), { ok: true, value: expected });
  for (const input of [123, null, [], {}, '', ' 123', '123\n', '../123', 'milk', 'https://www.continente.pt/produto/123.html', 'x'.repeat(251)] as const) {
    assert.equal(parseProductReference(input).ok, false, String(input));
  }
  assert.equal(ProductReferenceSchema.safeParse({ productId: '123', productSlug: 'milk-00123' }).success, false);
  assert.equal(ProductIdSchema.safeParse(123).success, false);
  assert.equal(CartItemIdSchema.safeParse('line-uuid').success, true);
  assert.equal(OrderIdSchema.safeParse('internal-order-id').success, true);
  assert.equal(OrderIdSchema.safeParse('bad\nidentifier').success, false);
});

test('money parsing uses exact integer cents and distinguishes missing from malformed amounts', () => {
  for (const [input, minorUnits] of [[0, 0], [8.03, 803], [' 1,20€ ', 120], ['12.9', 1290], ['90071992547409.91', Number.MAX_SAFE_INTEGER]] as const) {
    assert.deepEqual(parseMoneyAmount(input), { ok: true, value: { currency: 'EUR', minorUnits } });
  }
  for (const input of [null, undefined, ''] as const) assert.deepEqual(parseMoneyAmount(input), { ok: true, value: null });
  for (const input of [' ', 'unavailable', '1.234', '1,234.56', '1e2', '2 USD', true, [], {}, NaN, Infinity, -1, '90071992547409.92', 0.1 + 0.2] as const) {
    const result = parseMoneyAmount(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.error.code, 'invalid_data');
  }
  assert.equal(MoneySchema.safeParse({ currency: 'USD', minorUnits: 120 }).success, false);
  assert.equal(MoneySchema.safeParse({ currency: 'EUR', minorUnits: 1.2 }).success, false);
});

test('quantities require explicit known units and retain unknown observations without defaults', () => {
  assert.deepEqual(parseValue(QuantitySchema, quantity, 'quantity'), { ok: true, value: quantity });
  for (const input of [{ value: -1, unit: 'un' }, { value: NaN, unit: 'un' }, { value: Infinity, unit: 'kg' }, { value: 1 }, { value: '1', unit: 'un' }, { value: 1, unit: 'box' }] as const) {
    assert.equal(parseValue(QuantitySchema, input, 'quantity').ok, false);
  }
  const unknown = { status: 'unknown', value: null, rawText: 'unreadable quantity' };
  assert.deepEqual(ObservedQuantitySchema.parse(unknown), unknown);
  assert.equal(ObservedQuantitySchema.safeParse({ ...unknown, quantity }).success, false);
  assert.equal(ObservedQuantitySchema.safeParse({ status: 'known' }).success, false);
});

test('sale-rule models reject contradictory units, bounds and conversions', () => {
  assert.equal(ProductSaleRulesSchema.safeParse(rules).success, true);
  for (const invalid of [
    { ...rules, minimum: { value: 0.6, unit: 'kg' } },
    { ...rules, maximum: { value: 2, unit: 'un' } },
    { ...rules, step: { value: 0, unit: 'un' } },
    { ...rules, storefrontUnitsPerSaleUnit: 0 },
    { ...rules, storefrontUnitsPerSaleUnit: Infinity },
    { ...rules, storefrontUnit: 'un' },
  ] as const) assert.equal(ProductSaleRulesSchema.safeParse(invalid).success, false);
});

test('cart outcomes prevent contradictory confirmation, failure and automatic replay', () => {
  const base = { productId: '00123', requested: quantity };
  const confirmed = { ...base, outcome: 'confirmed', confirmedQuantity: { value: 6, unit: 'un' } };
  const notApplied = { ...base, outcome: 'not_applied', error: failure };
  const unknown = { ...base, outcome: 'unknown', error: failure, recovery: { action: 'get_cart', automaticReplay: false } };
  for (const input of [confirmed, notApplied, unknown] as const) assert.equal(CartMutationResultSchema.safeParse(input).success, true);
  for (const input of [
    { ...confirmed, error: failure },
    { ...confirmed, confirmedQuantity: { value: 1.2, unit: 'kg' } },
    { ...notApplied, confirmedQuantity: quantity },
    { ...unknown, confirmedQuantity: quantity },
    { ...unknown, recovery: undefined },
    { ...unknown, recovery: { action: 'get_cart', automaticReplay: true } },
    { ...unknown, error: { ...failure, retryable: true } },
    { ...base, outcome: 'success' },
  ] as const) assert.equal(CartMutationResultSchema.safeParse(input).success, false);
});

test('cart models preserve unknown prices and unresolved quantity units', () => {
  const cart = {
    customerAuthenticated: true, totals: { products: null, bags: null, deposit: null, delivery: null, discounts: null, grandTotal: null, estimated: false }, items: [{
      productId: '00123', cartItemId: null, name: 'Milk', kind: 'product',
      quantity: { status: 'unknown', value: 2, rawText: null },
      price: null, lineTotal: null, estimated: false,
    }],
  };
  assert.deepEqual(parseJson(CartSchema, JSON.stringify(cart), 'cart'), { ok: true, value: cart });
  assert.equal(parseJson(CartSchema, '{}', 'cart').ok, false);
  assert.equal(parseJson(CartSchema, 'null', 'cart').ok, false);
  assert.equal(parseValue(CartSchema, { ...cart, items: [{}] }, 'cart').ok, false);
});

test('page results distinguish valid empty data, partial failure and unknown completeness', () => {
  const schema = pageResultSchema(ProductIdSchema);
  const empty = { items: [], completeness: 'complete', failures: [], nextCursor: null };
  assert.deepEqual(schema.parse(empty), empty);
  assert.equal(schema.safeParse({ ...empty, items: ['00123'], completeness: 'partial', failures: [failure] }).success, true);
  assert.equal(schema.safeParse({ ...empty, completeness: 'unknown', nextCursor: 'next-page' }).success, true);
  for (const input of [
    { ...empty, failures: [failure] }, { ...empty, completeness: 'partial' },
    { ...empty, nextCursor: 'next-page' }, { ...empty, items: [123] },
    { ...empty, completeness: 'unknown', failures: [failure] },
  ] as const) assert.equal(schema.safeParse(input).success, false);
});

test('cache parsing validates versions, account scope, timestamps and every product', () => {
  const cache = { schemaVersion: 2, accountScope: 'account-hash', fetchedAt: '2026-10-14T12:00:00Z', favorites: [product] };
  assert.deepEqual(parseJson(FavoritesCacheSchema, JSON.stringify(cache), 'favorites cache'), { ok: true, value: cache });
  assert.equal(FavoritesCacheSchema.safeParse({ ...cache, favorites: [] }).success, true);
  for (const input of [
    { ...cache, schemaVersion: 1 }, { ...cache, accountScope: '' },
    { ...cache, fetchedAt: 'yesterday' }, { ...cache, fetchedAt: '2026-02-30T12:00:00Z' },
    { ...cache, favorites: [{}] }, { ...cache, favorites: [{ ...product, productId: '999' }] },
    { ...cache, favorites: [{ ...product, price: 1.20 }] }, { ...cache, favorites: [{ ...product, price: { currency: 'EUR', minorUnits: 120 } }] },
    { ...cache, favorites: [{ ...product, price: { amount: { currency: 'EUR', minorUnits: 120 }, per: 'dozen' } }] },
    { favorites: [], lastUpdated: cache.fetchedAt },
  ] as const) assert.equal(parseValue(FavoritesCacheSchema, input, 'favorites cache').ok, false);
  assert.equal(parseJson(FavoritesCacheSchema, '{bad json}', 'favorites cache').ok, false);
  assert.equal(parseJson(FavoritesCacheSchema, cache, 'favorites cache').ok, false);
});

test('validation failures expose paths and codes without copying upstream values', () => {
  const secret = 'private-upstream-value';
  const result = parseValue(ProductSchema, { ...product, productId: secret, price: secret }, 'product');
  assert.equal(result.ok, false);
  assert.equal(ToolErrorSchema.safeParse(result.error).success, true);
  assert.equal(JSON.stringify(result.error).includes(secret), false);
  assert.ok(present(result.error.issues).some(issue => issue.path === 'productId'));
});

test('history models retain unavailable lines and separate totals by unit', () => {
  const order = { orderId: 'internal-id', orderNumber: '123456789_001', date: null, lines: { status: 'unavailable', error: failure } };
  assert.deepEqual(OrderSchema.parse(order), order);
  assert.equal(OrderSchema.safeParse({ ...order, lines: { status: 'unavailable', items: [] } }).success, false);
  const frequency = { productId: null, identityBasis: 'name', name: 'Bananas', orders: 2, quantities: [{ value: 3, unit: 'un' }, { value: 1.2, unit: 'kg' }] };
  assert.equal(PurchaseFrequencySchema.safeParse(frequency).success, true);
  assert.equal(PurchaseFrequencySchema.safeParse({ ...frequency, identityBasis: 'product' }).success, false);
  assert.equal(PurchaseFrequencySchema.safeParse({ ...frequency, quantities: [quantity, quantity] }).success, false);
});
