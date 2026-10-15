import type { BasketPreview, BasketPreviewLine, Cart, Money, ObservedQuantity, ProductDetails, Quantity, Result, ToolError } from '../domain/index.js';
import { CartItemIdSchema, failure, parseProductReference, success } from '../domain/index.js';
import { selectCartItem, validateSaleQuantity } from '../parsers/cart.js';
import type { CatalogService } from './catalog.js';
import type { CartService } from './cart.js';

export interface PreviewItem { productId: string; quantity: number; cartItemId?: string | undefined; }

const euro = (minorUnits: number): Money => ({ currency: 'EUR', minorUnits: Math.round(minorUnits) });
/** Cost of a quantity at the product's current price, and whether it depends on the weight picked. */
function cost(product: ProductDetails, quantity: Quantity): { amount: Money | null; estimated: boolean } {
  const rules = product.saleRules.status === 'available' ? product.saleRules.rules : null;
  const price = product.price;
  if (!rules || !price) return { amount: null, estimated: false };
  if (quantity.value === 0) return { amount: euro(0), estimated: false };
  if (rules.storefrontUnit === 'un' && price.per === 'item') return { amount: euro(price.amount.minorUnits * quantity.value), estimated: false };
  if (rules.saleUnit === 'un' && (rules.storefrontUnit === 'kg' || rules.storefrontUnit === 'l') && price.per === rules.storefrontUnit) {
    return { amount: euro(price.amount.minorUnits * quantity.value * rules.storefrontUnitsPerSaleUnit), estimated: true };
  }
  return { amount: null, estimated: false };
}
const change = (from: number, to: number): BasketPreviewLine['change'] =>
  Math.abs(from - to) <= 0.0005 ? 'none' : to === 0 ? 'remove' : from === 0 ? 'add' : to > from ? 'increase' : 'decrease';

/**
 * What `set_cart_item_quantity` would do for each item, without changing anything: the cart is
 * read once and each product page once. Prices and stock can change before the cart is changed.
 */
export class BasketPreviewService {
  constructor(private readonly catalog: CatalogService, private readonly cart: CartService) {}
  async preview(items: PreviewItem[]): Promise<Result<BasketPreview, ToolError>> {
    if (items.some(item => !parseProductReference(item.productId).ok)) return failure('invalid_input', 'Invalid product reference');
    const cart = await this.cart.getCart();
    if (!cart.ok) return cart;
    const lines: BasketPreviewLine[] = [];
    const seen = new Set<string>();
    for (const item of items) lines.push(await this.line(item, cart.value, seen));
    const costs = lines.filter(line => line.error === null).map(line => line.estimatedCost);
    const total = costs.every(amount => amount !== null) ? euro(costs.reduce((sum, amount) => sum + amount!.minorUnits, 0)) : null;
    return success({ lines, estimatedCost: total, estimated: lines.some(line => line.error === null && line.estimated),
      problems: lines.filter(line => line.error !== null || line.availability !== 'available').length });
  }

  private async line(item: PreviewItem, cart: Cart, seen: Set<string>): Promise<BasketPreviewLine> {
    const reference = parseProductReference(item.productId);
    const cartItemId = item.cartItemId === undefined ? null : CartItemIdSchema.parse(item.cartItemId);
    if (!reference.ok) throw new Error('Product references are checked before the preview');
    const { productId } = reference.value;
    const blank = (error: ToolError): BasketPreviewLine => ({ productId, cartItemId, name: null, requested: null,
      current: { status: 'unknown', value: null, rawText: null }, change: null, availability: null, price: null,
      packageText: null, package: null, saleRules: null, estimatedCost: null, estimated: false, error });
    const key = `${productId}|${item.cartItemId ?? ''}`;
    if (seen.has(key)) return blank({ code: 'invalid_input', message: 'This product is listed more than once', retryable: false });
    seen.add(key);
    const selected = selectCartItem(cart, productId, item.cartItemId);
    const line = selected.ok ? selected.value : null;
    const product = await this.catalog.getProduct(productId);
    if (!product.ok) return blank(product.error);
    const details = product.value;
    const rules = details.saleRules.status === 'available' ? details.saleRules.rules : null;
    const unit = rules?.saleUnit ?? null;
    const current: ObservedQuantity = !selected.ok ? { status: 'unknown', value: null, rawText: null }
      : line ? line.quantity : { status: 'known', quantity: { value: 0, unit: unit ?? 'un' } };
    const base: BasketPreviewLine = { productId, cartItemId: cartItemId ?? line?.cartItemId ?? null, name: details.name,
      requested: unit ? { value: item.quantity, unit } : null, current, change: null, availability: details.availability, price: details.price,
      packageText: details.packageText, package: details.package, saleRules: rules, estimatedCost: null, estimated: false, error: null };
    if (!selected.ok) return { ...base, error: selected.error };
    if (item.cartItemId !== undefined && !line) return { ...base, error: { code: 'not_found', message: 'No cart line has this cartItemId. Use get_cart to read current lines.', retryable: false } };
    if (details.saleRules.status === 'unavailable') return { ...base, error: details.saleRules.error };
    const requested = validateSaleQuantity(item.quantity, { rules: rules! });
    if (!requested.ok) return { ...base, error: requested.error };
    const now = current.status === 'known' ? current.quantity : null;
    if (!now) return { ...base, error: { code: 'invalid_data', message: 'The unit of the quantity in the cart is unknown', retryable: false } };
    if (now.unit !== requested.value.unit) return { ...base, error: { code: 'invalid_data', message: 'The cart line uses another unit than the product', retryable: false } };
    const priced = cost(details, requested.value);
    return { ...base, requested: requested.value, change: change(now.value, requested.value.value), estimatedCost: priced.amount, estimated: priced.estimated };
  }
}
