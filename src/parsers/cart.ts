import { load } from 'cheerio';
import { z } from 'zod';
import { CartSchema, ProductSaleRulesSchema, QuantityUnitSchema, failure, parseMoneyAmount, parseProductReference, parseValue, success } from '../domain/index.js';
import type { Cart, CartItem, CartTotals, Money, ProductId, ProductSaleRules, Quantity, QuantityUnit, Result, ToolError } from '../domain/index.js';
import { field, record } from './records.js';
import { storefrontUrl } from './catalog.js';

const unrecognizedCart = () => failure('invalid_data', 'The cart response was not recognised');

/**
 * The add-to-cart response lists lines under `cart.items`; the mini-cart groups them under
 * `basket.itemsSortedByBrand`. A session that never had a basket gets an empty `basket` object.
 */
function cartLines(input: unknown): unknown[] | null {
  const direct = field(input, 'cart', 'items');
  if (Array.isArray(direct)) return direct;
  const groups = field(input, 'basket', 'itemsSortedByBrand');
  if (Array.isArray(groups)) {
    const lines = groups.map(group => field(group, 'items'));
    return lines.every(Array.isArray) ? lines.flat() : null;
  }
  const basket = record(field(input, 'basket'));
  return field(input, 'action') === 'Cart-MiniCartShow' && basket && Object.keys(basket).length === 0 ? [] : null;
}

/**
 * The unit of a line's `secondaryQuantity`, from the line's own sale rules: pieces for products sold
 * by the piece but priced per kg, units otherwise. The line's `selectedunit` and `selectedDimension`
 * do not follow the quantity, so they are not used.
 */
function lineUnit(line: unknown): QuantityUnit | null | undefined {
  const rates = record(field(line, 'measurementInfo', 'quantityConversionRates'));
  if (!rates) return undefined;
  const alternative = rates.hasAlternativeSaleUnit === true || rates.hasConversionRate === true;
  const unit = QuantityUnitSchema.safeParse(alternative ? rates.secondaryunit : rates.primaryunit);
  return unit.success && (alternative || unit.data === 'un') ? unit.data : null;
}

function cartLine(line: unknown, bag: ProductId | null): Result<CartItem, ToolError> {
  const reference = parseProductReference(field(line, 'id'));
  const reported = field(line, 'secondaryQuantity') ?? field(line, 'quantity');
  const rawQuantity = typeof reported === 'string' && reported.trim() !== '' ? Number(reported) : reported;
  const unitPrice = field(line, 'price', 'sales', 'value');
  const lineTotal = field(line, 'priceTotal', 'basePriceValue');
  const price = parseMoneyAmount(unitPrice ?? lineTotal);
  if (!reference.ok || typeof rawQuantity !== 'number' || !Number.isFinite(rawQuantity) || rawQuantity < 0 || !price.ok) return unrecognizedCart();
  const unit = lineUnit(line);
  return parseValue(CartSchema.shape.items.element, {
    productId: reference.value.productId,
    cartItemId: field(line, 'UUID') ?? field(line, 'uuid') ?? null,
    name: field(line, 'productName'),
    kind: bag !== null && reference.value.productId === bag ? 'bag' : 'product',
    quantity: unit ? { status: 'known', quantity: { value: rawQuantity, unit } }
      : { status: 'unknown', value: rawQuantity, rawText: null, ...(unit === null ? { reason: 'unsupported_unit' } : {}) },
    price: { amount: price.value, basis: unitPrice != null ? 'unit' : lineTotal != null ? 'line' : 'unknown' },
  }, 'cart line');
}

const money = (value: unknown): Money | null => { const parsed = parseMoneyAmount(value); return parsed.ok ? parsed.value : null; };
const euro = (minorUnits: number): Money => ({ currency: 'EUR', minorUnits });
/** Mini-cart totals. An amount the website does not report, or reports unreadably, stays null. */
function cartTotals(input: unknown, lines: unknown[], bag: ProductId | null): CartTotals {
  const totals = field(input, 'basket', 'totals');
  if (lines.length === 0 && field(input, 'action') === 'Cart-MiniCartShow' && !record(totals)) {
    return { products: euro(0), bags: euro(0), deposit: euro(0), delivery: null, discounts: euro(0), grandTotal: euro(0) };
  }
  const products = money(field(input, 'cart', 'totalProductsValueNumber') ?? field(totals, 'productsTotalPriceOnly'));
  const withDeposit = money(field(totals, 'productsTotalPriceOnlyWithSDR'));
  const bagLines = bag === null ? null : lines.filter(line => { const reference = parseProductReference(field(line, 'id')); return reference.ok && reference.value.productId === bag; })
    .map(line => money(field(line, 'priceTotal', 'value')));
  const discountParts = [field(totals, 'orderLevelDiscountTotal', 'value'), field(totals, 'shippingLevelDiscountTotal', 'value')]
    .filter(value => value != null).map(value => typeof value === 'number' ? money(Math.abs(value)) : null);
  const sum = (amounts: (Money | null)[] | null) => amounts && amounts.every(amount => amount !== null)
    ? euro(amounts.reduce((total, amount) => total + amount.minorUnits, 0)) : null;
  return {
    products,
    bags: sum(bagLines),
    deposit: products && withDeposit && withDeposit.minorUnits >= products.minorUnits ? euro(withDeposit.minorUnits - products.minorUnits) : null,
    delivery: money(field(totals, 'totalShippingCostNumber')),
    discounts: discountParts.length ? sum(discountParts) : null,
    grandTotal: money(field(totals, 'grandTotalNumber')),
  };
}

export function parseCartResponse(input: unknown): Result<Cart, ToolError> {
  const lines = cartLines(input);
  if (!lines) return unrecognizedCart();
  const bagReference = parseProductReference(field(input, 'basket', 'resources', 'plasticBagID'));
  const bag = bagReference.ok ? bagReference.value.productId : null;
  const items: CartItem[] = [];
  for (const line of lines) {
    const item = cartLine(line, bag);
    if (!item.ok) return item;
    items.push(item.value);
  }
  const lineIds = items.map(item => item.cartItemId).filter(id => id !== null);
  if (new Set(lineIds).size !== lineIds.length) return failure('invalid_data', 'The cart contains duplicate line identifiers');
  const customerAuthenticated = field(input, 'resources', 'customerAuthenticated') === true;
  return success({ customerAuthenticated, items, totals: cartTotals(input, lines, bag) });
}

export interface SaleMetadata {
  rules: ProductSaleRules;
  /** Sold in a unit other than the storefront's primary unit (for example pieces of a product priced per kg). */
  alternativeUnit: boolean;
  /** `step` parameter for quantity updates, in storefront units. */
  storefrontStep: string;
  /** `dimension` parameter for quantity updates. */
  updateDimension: string;
}

const amount = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)]).pipe(z.number().finite().nonnegative());
const MeasureOptionsSchema = z.object({
  primaryunit: z.string().min(1),
  secondaryunit: z.string().nullish(),
  selectedunit: z.string().nullish(),
  hasAlternativeSaleUnit: z.boolean().nullish(),
  hasConversionRate: z.boolean().nullish(),
  primaryToSecondary: amount.nullish(),
  unitConversionRate: amount.nullish(),
  minOrderQuantity: amount.nullish(),
  stepQuantity: amount.nullish(),
  maxNumberOfUnitsPerSale: amount.nullish(),
});
const MEASURES: Partial<Record<string, { dimension: 'mass' | 'volume'; grams: number }>> = {
  kg: { dimension: 'mass', grams: 1000 }, g: { dimension: 'mass', grams: 1 },
  l: { dimension: 'volume', grams: 1000 }, ml: { dimension: 'volume', grams: 1 },
};
const unknownRules = (message: string) => failure('sale_rules_unknown', message);
/** Storefront amount converted to sale units, without binary noise such as 98.99999999999999. */
const inSaleUnits = (value: number, factor: number) => Number((value / factor).toPrecision(12));
const isWholeMultiple = (value: number, step: number) => { const ratio = value / step; return Math.abs(ratio - Math.round(ratio)) < 1e-6; };

/** Interpret the storefront's `data-measure-options`. Anything ambiguous is rejected rather than guessed. */
export function parseSaleRules(input: unknown): Result<SaleMetadata, ToolError> {
  let raw = input;
  if (typeof input === 'string') { try { raw = JSON.parse(input); } catch { return unknownRules('Sale rules are not valid JSON'); } }
  const parsed = MeasureOptionsSchema.safeParse(raw);
  if (!parsed.success) return unknownRules('Sale rules are missing or malformed');
  const options = parsed.data;
  const alternativeUnit = options.hasAlternativeSaleUnit === true || options.hasConversionRate === true;

  let saleUnit: unknown = 'un';
  let factor = 1;
  if (alternativeUnit) {
    const rates = [options.primaryToSecondary, options.unitConversionRate].filter(rate => rate != null);
    if (!rates.length || rates.some(rate => rate !== rates[0]) || !rates[0]) return unknownRules('The unit conversion is missing or inconsistent');
    factor = rates[0];
    saleUnit = options.secondaryunit;
    const sale = MEASURES[String(saleUnit)]; const storefront = MEASURES[options.primaryunit];
    if (sale && storefront && (sale.dimension !== storefront.dimension || Math.abs(factor - sale.grams / storefront.grams) > 1e-12)) {
      return unknownRules('The unit conversion contradicts the declared units');
    }
  } else if (options.primaryunit !== 'un' || (options.selectedunit != null && options.selectedunit !== 'primary')) {
    return unknownRules('Only unit sales and declared alternative units are supported');
  }

  const step = options.stepQuantity ?? (saleUnit === 'un' ? factor : null);
  const max = options.maxNumberOfUnitsPerSale;
  // Minimum, step and maximum are all in the storefront unit (kg for weighted products): the site's
  // own quantity control compares one quantity against all three and snaps the maximum to the step.
  // A maximum that is not a whole number of steps is not a shape we have seen, so refuse it.
  if (alternativeUnit && max != null && step && !isWholeMultiple(max, step)) {
    return unknownRules('The maximum quantity is not a whole number of steps');
  }
  if (!step || !milliquantity(step).ok) return unknownRules('A positive step with at most three decimals is required');
  const unit = saleUnit as QuantityUnit;
  const minimum = options.minOrderQuantity ? { value: inSaleUnits(options.minOrderQuantity, factor), unit } : null;
  const maximum = max != null ? { value: inSaleUnits(max, factor), unit } : null;
  const rules = ProductSaleRulesSchema.safeParse({ saleUnit, storefrontUnit: alternativeUnit ? options.primaryunit : 'un',
    storefrontUnitsPerSaleUnit: factor, minimum, maximum, step: { value: inSaleUnits(step, factor), unit } });
  if (!rules.success) return unknownRules('Sale rules use an unsupported unit or contradictory bounds');
  return success({ rules: rules.data, alternativeUnit, storefrontStep: String(step), updateDimension: options.secondaryunit || options.primaryunit });
}

/** Three storefront decimals; tolerate binary arithmetic noise, never round a requested amount. */
function milliquantity(value: number): Result<number, ToolError> {
  const scaled = value * 1000;
  const integer = Math.round(scaled);
  return Number.isSafeInteger(integer) && Math.abs(scaled - integer) <= 0.000001
    ? success(integer) : failure('invalid_input', 'Quantity exceeds supported three-decimal storefront precision');
}
export function validateSaleQuantity(value: number, metadata: SaleMetadata): Result<Quantity, ToolError> {
  const { saleUnit: unit, minimum, maximum, step } = metadata.rules;
  const display = (value: number) => Number(value.toPrecision(12));
  const constraints = [minimum && `minimum ${display(minimum.value)} ${unit}`, maximum && `maximum ${display(maximum.value)} ${unit}`, step && `step ${display(step.value)} ${unit}`].filter(Boolean).join(', ');
  const invalid = (message: string) => failure('invalid_input', `${message}. Use ${unit}${constraints ? ` (${constraints})` : ''}.`);
  if (!Number.isFinite(value) || value < 0) return invalid('Quantity must be finite and non-negative');
  if (value === 0) return success({ value, unit });
  const primary = value * metadata.rules.storefrontUnitsPerSaleUnit;
  if (!Number.isFinite(primary)) return unknownRules('The quantity cannot be converted to storefront units');
  const amount = milliquantity(primary);
  if (!amount.ok) return invalid(amount.error.message);
  if (minimum && value < minimum.value - 1e-9) {
    return failure('quantity_below_minimum', `The minimum is ${display(minimum.value)} ${unit}${constraints ? ` (${constraints})` : ''}.`);
  }
  if (maximum && value > maximum.value + 1e-9) return invalid('Quantity is above the maximum');
  if (step) {
    const increment = milliquantity(step.value * metadata.rules.storefrontUnitsPerSaleUnit);
    if (!increment.ok || increment.value <= 0) return unknownRules('The step cannot be represented in storefront units');
    if (amount.value % increment.value !== 0) return invalid('Quantity is not a multiple of the supported step');
  }
  return success({ value, unit });
}
export function toStorefrontQuantity(quantity: Quantity, metadata: SaleMetadata): string {
  if (quantity.unit !== metadata.rules.saleUnit) throw new Error('Quantity unit does not match sale metadata');
  const validated = validateSaleQuantity(quantity.value, metadata);
  if (!validated.ok) throw new Error(validated.error.message);
  return (Math.round(quantity.value * metadata.rules.storefrontUnitsPerSaleUnit * 1000) / 1000).toString();
}
export function selectCartItem(cart: Cart, productId: ProductId, cartItemId?: string): Result<CartItem | null, ToolError> {
  const matches = cart.items.filter(item => item.productId === productId && (cartItemId === undefined || item.cartItemId === cartItemId));
  if (matches.length > 1) return failure('invalid_input', 'Multiple cart lines match this product. Use get_cart and supply cartItemId.');
  return success(matches[0] ?? null);
}
export function observedCartQuantity(cart: Cart, productId: ProductId, cartItemId?: string): number | null {
  const selected = selectCartItem(cart, productId, cartItemId);
  if (!selected.ok) return null;
  const item = selected.value;
  return !item ? 0 : item.quantity.status === 'known' ? item.quantity.quantity.value : item.quantity.value;
}

const FormSchema = z.object({ pid: z.string().min(1), action: z.string().min(1), csrf: z.string() });
export function parseProductForm(input: unknown, expectedId: ProductId) {
  const $ = typeof input === 'string' ? load(input) : null;
  const raw = $ ? { pid: $('input[name="productID"]').val(), action: $('input.add-to-cart-url').val(),
    csrf: $('input[name="csrf_token"]').val() ?? '', measureOptions: $('.ct-tile-quantity-update[data-measure-options]').first().attr('data-measure-options') ?? '{}' } : record(input);
  const parsed = parseValue(FormSchema, raw, 'product form');
  if (!parsed.ok) return parsed;
  const ref = parseProductReference(parsed.value.pid);
  if (!ref.ok || ref.value.productId !== expectedId || !storefrontUrl(parsed.value.action)) return failure('invalid_data', 'The product page has an unexpected add-to-cart form');
  const sale = parseSaleRules(raw?.measureOptions ?? '{}');
  return sale.ok ? success({ ...parsed.value, sale: sale.value }) : sale;
}
export function parseCartControls(html: string, productId: ProductId, cartItemId?: string) {
  const $ = load(html);
  const item = $('[data-pid][data-product-name]').filter((_, element) => {
    const candidate = $(element);
    const reference = parseProductReference(candidate.attr('data-pid'));
    const matchesProduct = reference.ok && reference.value.productId === productId;
    const uuid = candidate.find('.ct-tile-quantity-update').first().attr('data-uuid') ?? candidate.attr('data-uuid');
    return matchesProduct && (cartItemId === undefined || uuid === cartItemId);
  });
  if (!item.length) return failure('not_found', 'The product is not in the cart.');
  if (item.length !== 1) return failure('invalid_input', 'Multiple cart controls match. Use get_cart and supply cartItemId.');
  const update = item.find('.ct-tile-quantity-update').first();
  const remove = item.find('button.remove-product').first();
  const uuid = update.attr('data-uuid') ?? item.attr('data-uuid') ?? null;
  const removeUuid = remove.attr('data-uuid') ?? item.attr('data-uuid') ?? null;
  if (uuid && removeUuid && uuid !== removeUuid) return failure('invalid_data', 'The cart line has conflicting identifiers');
  return success({
    action: update.attr('data-action') ?? null, uuid: update.attr('data-uuid') ?? item.attr('data-uuid') ?? null,
    removeAction: remove.attr('data-action') ?? null, removeUuid: remove.attr('data-uuid') ?? item.attr('data-uuid') ?? null,
    measureOptions: update.attr('data-measure-options') ?? '{}', gtmIndex: item.attr('data-idx') || '1',
  });
}
export function parseMutationReceipt(input: unknown): Result<void, ToolError> {
  if (!record(input) || field(input, 'error') || field(input, 'success') === false ||
    field(input, 'resources', 'customerAuthenticated') === false) return failure('cart_change_rejected');
  return success(undefined);
}
