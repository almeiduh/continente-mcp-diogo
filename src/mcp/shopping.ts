import type { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from './server.js';
import type { CouponGateway, CouponSelectionGateway, PickupSlotGateway, PickupSlotWindow, PickupStoreGateway, PickupStoreSelectionGateway, SessionService, MutationResult } from '../ports.js';
import type { PriceTag, UpdateStatus, CartMutationResult, Money, ObservedQuantity, Order, ProductDetails, ProductSaleRules, Quantity, Result, ToolError } from '../domain/index.js';
import { failure } from '../domain/index.js';
import * as contracts from './contracts.js';
import { withAuthenticationRecovery } from '../services/recovery.js';
import type { CatalogService, FavoritesService, FavoritesSnapshot, SearchResult } from '../services/catalog.js';
import type { CartService } from '../services/cart.js';
import type { OrderService, PurchaseHistoryService, OrderListOptions } from '../services/orders.js';

export interface ShoppingServices {
  catalog: CatalogService; favorites: FavoritesService; cart: CartService; orders: OrderService;
  history: PurchaseHistoryService; session: SessionService; coupons: CouponGateway; couponSelection: CouponSelectionGateway; pickupStores: PickupStoreGateway; pickupSlots: PickupSlotGateway; pickupStoreSelection: PickupStoreSelectionGateway;
}

type Status = 'success' | 'empty' | 'partial';
type MutationSummary = z.infer<typeof contracts.ErrorResultSchema>['mutation'];

const CONFIGURATION_GUIDE = 'https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md';
const PUBLIC_TOOLS = 'Searching and product details work without signing in.';
/** What to do about a sign-in failure, depending on whether credentials are configured at all. */
export function signInHelp(credentialsConfigured: boolean | null): string {
  if (credentialsConfigured === false) {
    return 'Sign-in required: no Continente email and password are configured. In the Claude Desktop extension, enter them in the '
      + `extension's settings; in other setups, set CONTINENTE_EMAIL and CONTINENTE_PASSWORD (see ${CONFIGURATION_GUIDE}). ${PUBLIC_TOOLS}`;
  }
  const cause = credentialsConfigured ? 'Continente did not accept the configured email and password, or asked for extra verification'
    : 'Continente did not accept the sign-in, or no credentials are configured';
  return `Sign-in failed: ${cause}. Check the credentials, or run \`continentept-mcp login --show-browser\` in a terminal `
    + `to sign in and complete any verification (see ${CONFIGURATION_GUIDE}). ${PUBLIC_TOOLS}`;
}
const CHECKOUT_URL = 'https://www.continente.pt/checkout/carrinho/';

// Text content mirrors the structured result for clients that only show text to the model,
// so it always includes the identifiers needed for follow-up calls.
const euros = (money: Money | null) => money === null ? 'price unavailable' : `€${(money.minorUnits / 100).toFixed(2)}`;
const amount = (quantity: Quantity) => `${Number(quantity.value.toPrecision(12))} ${quantity.unit}`;
const observed = (quantity: ObservedQuantity) => quantity.status === 'known' ? amount(quantity.quantity)
  : quantity.value === null ? 'quantity unknown' : `${quantity.value} (unit unknown)`;
const PER: Record<PriceTag['per'], string> = { item: '', piece: ' per piece', kg: '/kg', l: '/l' };
const priced = (price: PriceTag | null) => price === null ? 'price unknown' : `${euros(price.amount)}${PER[price.per]}`;
const numbered = (lines: string[]) => lines.map((line, index) => `${index + 1}. ${line}`).join('\n');

function response(data: unknown, text: string, status: Status = 'success'): CallToolResult {
  return { structuredContent: { result: { status, data } }, content: [{ type: 'text', text }] };
}
function errorResult(error: ToolError, mutation?: MutationSummary): CallToolResult {
  const unknown = mutation?.outcome === 'unknown';
  const publicError = { ...error, ...(unknown ? { retryable: false } : {}) };
  const note = unknown ? '\nThe cart may have changed. Call get_cart before making another change; do not repeat this request automatically.'
    : mutation ? '\nThe cart was not changed.' : '';
  return { isError: true, content: [{ type: 'text', text: `Error (${publicError.code}): ${publicError.message}${note}` }],
    structuredContent: { result: { status: 'error', error: publicError, ...(mutation ? { mutation } : {}) } } };
}

export function formatProductSearchResults(products: SearchResult['page']['items']): string {
  return numbered(products.map(product => `${product.name}${product.favorite ? ' ⭐ favorite' : ''} — ${priced(product.price)}` +
    `${product.secondaryPrice ? ` (${priced(product.secondaryPrice)})` : ''}${product.recommendedPrice ? `, PVPR ${priced(product.recommendedPrice)}` : ''}` +
    `${product.packageText ? `, pack ${product.packageText}` : ''}` +
    `${product.minimumText ? `, minimum ${product.minimumText}` : ''}\n   productId: ${product.productId}`));
}
function formatSaleRules(rules: ProductSaleRules): string {
  const bounds = [rules.minimum && `minimum ${amount(rules.minimum)}`, rules.maximum && `maximum ${amount(rules.maximum)}`,
    rules.step && `step ${amount(rules.step)}`].filter(Boolean).join(', ');
  return `sold in ${rules.saleUnit}${bounds ? ` (${bounds})` : ''}`;
}
function formatProduct(product: ProductDetails): string {
  return [`${product.name}`, `productId: ${product.productId}`,
    `Price: ${priced(product.price)}${product.secondaryPrice ? ` (${priced(product.secondaryPrice)})` : ''}` +
      `${product.recommendedPrice ? `, PVPR ${priced(product.recommendedPrice)}` : ''}`,
    `Availability: ${product.availability}`,
    product.saleRules.status === 'available' ? `Sale rules: ${formatSaleRules(product.saleRules.rules)}`
      : `Sale rules unavailable: ${product.saleRules.error.message}`, `URL: ${product.url}`].join('\n');
}
function formatOrderLines(order: Order): string {
  if (order.lines.status === 'not_requested') return '   (lines not requested)';
  if (order.lines.status === 'unavailable') return `   (lines could not be read: ${order.lines.error.message})`;
  if (!order.lines.items.length) return '   (no product lines)';
  return order.lines.items.map(line => `   - ${observed(line.quantity)} × ${line.name}${line.productId ? ` [${line.productId}]` : ''}`).join('\n');
}
function orderHeading(order: Order): string {
  return [order.date ?? order.rawDate ?? 'date unknown', order.orderNumber && `order ${order.orderNumber}`,
    order.orderId && `orderId: ${order.orderId}`].filter(Boolean).join(' · ');
}
function favoritesData(snapshot: FavoritesSnapshot) {
  const { favorites, fetchedAt, source, freshness, expiresAt, cacheState } = snapshot;
  return { favorites, fetchedAt, source, freshness, expiresAt, cacheState, completeness: snapshot.completeness ?? 'unknown' };
}
function mutationText(value: Extract<CartMutationResult, { outcome: 'confirmed' }>, operation: 'add' | 'set' | 'remove'): string {
  const line = value.cartItemId ? ` (cartItemId ${value.cartItemId})` : '';
  if (value.disposition === 'already_absent') return `Product ${value.productId} was not in the cart; nothing changed.`;
  if (value.disposition === 'removed') return `Removed product ${value.productId}${line} from the cart.`;
  const action = operation === 'add' ? `Added ${amount(value.requested)} of` : `Set the quantity to ${amount(value.requested)} for`;
  return `${action} product ${value.productId}${line}. The cart now holds ${amount(value.confirmedQuantity)}.`;
}

export class ShoppingHandlers {
  constructor(private readonly services: ShoppingServices, private readonly update: UpdateStatus) {}
  /** An error result; sign-in failures before any cart write get guidance for fixing them. */
  private async failed(error: ToolError, mutation?: MutationSummary): Promise<CallToolResult> {
    if (error.code !== 'not_authenticated' || mutation?.outcome === 'unknown') return errorResult(error, mutation);
    const status = await this.services.session.getStatus?.().catch(() => undefined);
    const configured = status ? status.credentials.hasEmail === true && status.credentials.hasPassword === true : null;
    return errorResult({ ...error, message: signInHelp(status?.credentials.hasEmail === null ? null : configured) }, mutation);
  }
  private recover<T>(operation: () => Promise<Result<T, ToolError>>) {
    return withAuthenticationRecovery(operation, () => this.services.session.refreshAuthentication());
  }

  async searchProducts(query: string, limit: number): Promise<CallToolResult> {
    const result = await this.services.catalog.searchProducts(query, limit);
    if (!result.ok) return this.failed(result.error);
    const { page, scanned, favorites } = result.value;
    const partial = page.completeness === 'partial';
    const text = page.items.length
      ? `${page.items.length} of ${scanned} scanned products for "${query}":\n\n${formatProductSearchResults(page.items)}`
      : `No products found for "${query}".`;
    return response({ products: page.items, scanned, returned: page.items.length, favoritesLoaded: favorites.length, completeness: page.completeness,
      failures: page.failures, nextCursor: page.nextCursor },
    text + (partial ? `\n\nPartial results: ${page.failures.length} problem(s) reading results; see failures.` : ''), partial ? 'partial' : page.items.length ? 'success' : 'empty');
  }

  async getProduct(reference: string): Promise<CallToolResult> {
    const result = await this.services.catalog.getProduct(reference);
    if (!result.ok) return this.failed(result.error);
    const product = result.value;
    const partial = product.saleRules.status === 'unavailable' || product.price === null || product.availability === 'unknown';
    return response(product, formatProduct(product), partial ? 'partial' : 'success');
  }

  async listFavorites(refresh: boolean): Promise<CallToolResult> {
    const result = await this.recover(() => refresh ? this.services.favorites.refreshFavorites() : this.services.favorites.listFavorites());
    if (!result.ok) return this.failed(result.error);
    const { favorites, source, freshness } = result.value;
    const header = `${favorites.length} favorites (${source === 'website' ? 'fetched from the website' : `cached ${result.value.fetchedAt}`}):`;
    const list = numbered(favorites.map(item => `${item.name} — ${priced(item.price)}\n   productId: ${item.productId}`));
    return response(favoritesData(result.value), (favorites.length ? `${header}\n\n${list}` : 'No favorites saved.') +
      (freshness === 'stale' ? '\n\nThis snapshot is more than 24 hours old. Call list_favorites with refresh: true to update it.' : ''),
    favorites.length ? 'success' : 'empty');
  }

  async getCart(): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.cart.getCart());
    if (!result.ok) return this.failed(result.error);
    const cart = result.value;
    if (!cart.items.length) return response(cart, 'The cart is empty.', 'empty');
    const list = numbered(cart.items.map(item => `${item.name}${item.kind === 'bag' ? ' (bag)' : ''} — ${observed(item.quantity)} × ${priced(item.price)}` +
      `${item.lineTotal ? `, line ${euros(item.lineTotal)}` : ''}` +
      `\n   productId: ${item.productId}${item.cartItemId ? `, cartItemId: ${item.cartItemId}` : ''}`));
    const { totals } = cart;
    const optional = ([['Deposit', totals.deposit], ['Delivery', totals.delivery], ['Discounts', totals.discounts]] as const)
      .filter(([, value]) => value !== null && value.minorUnits > 0).map(([label, value]) => `${label}: ${euros(value)}`);
    const summary = [`Products: ${totals.products === null ? 'unavailable' : euros(totals.products)}`,
      ...(totals.bags !== null && totals.bags.minorUnits > 0 ? [`Bags: ${euros(totals.bags)}`] : []), ...optional,
      `Total to pay: ${totals.grandTotal === null ? 'unavailable' : euros(totals.grandTotal)}`].join('\n');
    return response(cart, `Cart (${cart.items.length} lines):\n\n${list}\n\n${summary}\nCheckout happens on the website: ${CHECKOUT_URL}`);
  }

  async getCheckoutSummary(): Promise<CallToolResult> {
    const context = await this.recover(() => this.services.couponSelection.fetchCheckoutContext());
    if (!context.ok) return this.failed(context.error);
    const cart = await this.recover(() => this.services.cart.getCart());
    if (!cart.ok) return this.failed(cart.error);
    const data = { stage: 'basket' as const, provisional: true as const, totals: cart.value.totals,
      immediateDiscounts: cart.value.totals.discounts, loyaltyCredit: context.value.loyaltyCredit,
      selectedCouponIds: context.value.selectedCouponIds };
    const loyalty = data.loyaltyCredit ? `€${(data.loyaltyCredit.minorUnits / 100).toFixed(2)}` : 'unknown';
    return response(data, `Basket summary (provisional): amount to pay ${euros(data.totals.grandTotal)}; reported order and shipping discounts ${euros(data.immediateDiscounts)}; loyalty credit earned ${loyalty}. Discounts embedded in line prices are not included in that discount field. This is not a final checkout quote.`,
      data.loyaltyCredit === null || data.totals.grandTotal === null || data.selectedCouponIds === null ? 'partial' : 'success');
  }

  async listCoupons(): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.coupons.fetchCoupons());
    if (!result.ok) return this.failed(result.error);
    const coupons = result.value.coupons;
    const list = numbered(coupons.map(item => `${item.description}` +
      `${item.benefitValue ? ` — ${item.benefitValue}${item.benefitQualifier ? ` ${item.benefitQualifier}` : ''}` : ''}` +
      `${item.availability ? `; ${item.availability}` : ''}` +
      `${item.couponId ? `\n   couponId: ${item.couponId}` : '\n   couponId: unavailable'}`));
    const completeness = result.value.completeness;
    return response(result.value, (coupons.length ? `Coupons shown on the account page:\n\n${list}` : 'No account coupons are available.') +
      '\nCart eligibility, expiry and stacking are unknown unless stated in the returned fields; selecting a coupon is not supported by this tool.',
    completeness === 'partial' || completeness === 'unknown' ? 'partial' : coupons.length ? 'success' : 'empty');
  }

  async setCartCoupons(couponIds: string[]): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.couponSelection.setSelectedCoupons(couponIds));
    if (!result.ok) return this.failed(result.error);
    const confirmed = result.value.outcome === 'confirmed';
    return response(result.value, confirmed
      ? `The basket confirms ${result.value.selectedCouponIds.length} selected coupon(s).`
      : `Coupon selection is uncertain. The last observed selected IDs are ${result.value.selectedCouponIds.length ? result.value.selectedCouponIds.join(', ') : 'none'}. Read the basket before making another coupon change; this request was not replayed.`,
    confirmed ? 'success' : 'partial');
  }

  async listPickupStores(query: { postalCode: string; latitude: number; longitude: number; city?: string }): Promise<CallToolResult> {
    const result = await this.services.pickupStores.fetchPickupStores(query);
    if (!result.ok) return this.failed(result.error);
    const data = result.value;
    const list = numbered(data.stores.map(store => `${store.name}${store.city ? ` — ${store.city}` : ''}` +
      `${store.address1 ? `\n   ${store.address1}` : ''}${store.address2 ? `, ${store.address2}` : ''}` +
      `\n   storeId: ${store.storeId}`));
    return response(data, (list ? `Pickup stores near ${query.postalCode}:\n\n${list}` : `No pickup stores were listed near ${query.postalCode}.`) +
      '\nThis lookup did not change the selected store. Pickup-slot availability is not included.',
    data.completeness === 'complete' ? data.stores.length ? 'success' : 'empty' : 'partial');
  }

  async listPickupSlots(window: PickupSlotWindow): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.pickupSlots.fetchPickupSlots(window));
    if (!result.ok) return this.failed(result.error);
    const data = result.value;
    const slots = data.slots.map(slot => `${slot.date}${slot.weekday ? ` (${slot.weekday})` : ''}: ${slot.startTime ?? 'time unknown'}–${slot.endTime ?? 'time unknown'}${slot.shippingCost ? `; ${slot.shippingCost}` : ''}`).join('\n');
    const mode = data.pickupMode === 'pickup' ? `pickup at ${data.storePostalCode ?? 'the selected store'}` : 'pickup mode could not be verified';
    const text = data.completeness === 'complete'
      ? (slots ? `Available pickup slots for ${mode}, ${window.from} to ${window.to}:\n${slots}` : `No pickup slots were listed for ${mode}, ${window.from} to ${window.to}.`)
      : `Pickup slot availability is incomplete or unknown for ${window.from} to ${window.to}; ${mode}.`;
    return response(data, `${text}\nThis read did not change the selected store or reserve a slot.`, data.completeness === 'complete' ? 'success' : 'partial');
  }

  async setPickupStore(storeId: string, recoveryWindow: PickupSlotWindow): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.pickupStoreSelection.setPickupStore(storeId, recoveryWindow));
    if (!result.ok) return this.failed(result.error);
    const data = result.value;
    const text = data.outcome === 'confirmed'
      ? (data.selectedStoreChanged
        ? `Pickup store changed to ${data.storeName ?? data.selectedStoreId} (${data.storePostalCode ?? 'postcode unavailable'}). Re-read the cart and selected coupons because delivery context can affect them.`
        : `Pickup store ${data.storeName ?? data.selectedStoreId} was already selected; nothing changed.`)
      : data.outcome === 'not_applied'
        ? `The pickup store was not changed; ${data.storeName ?? data.selectedStoreId} remains selected.`
        : `The pickup store change outcome is unknown. Do not repeat it. Use list_pickup_slots for ${recoveryWindow.from} to ${recoveryWindow.to}, then re-read the cart and coupons.`;
    return response(data, `${text} This operation did not reserve a slot or open payment.`, data.outcome === 'unknown' ? 'partial' : 'success');
  }

  private async mutation(result: MutationResult, operation: 'add' | 'set' | 'remove'): Promise<CallToolResult> {
    if (!result.ok) return this.failed(result.error, { outcome: 'not_applied' });
    const value = result.value;
    if (value.outcome === 'confirmed') return response(value, mutationText(value, operation));
    return this.failed(value.error, value.outcome === 'unknown' ? { outcome: 'unknown', recovery: value.recovery } : { outcome: 'not_applied' });
  }
  async addCartItem(reference: string, quantity: number, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.addCartItem(reference, quantity, cartItemId)), 'add');
  }
  async setCartItemQuantity(reference: string, quantity: number, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.setCartItemQuantity(reference, quantity, cartItemId)), quantity === 0 ? 'remove' : 'set');
  }
  async removeCartItem(reference: string, cartItemId?: string): Promise<CallToolResult> {
    return this.mutation(await this.recover(() => this.services.cart.removeCartItem(reference, cartItemId)), 'remove');
  }

  async listOrders(limit: number, options: OrderListOptions): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.orders.listOrders(limit, options));
    if (!result.ok) return this.failed(result.error);
    const page = result.value;
    const partial = page.completeness === 'partial';
    const list = numbered(page.items.map(order => `${orderHeading(order)}\n${formatOrderLines(order)}`));
    return response({ orders: page.items, completeness: page.completeness, failures: page.failures, nextCursor: page.nextCursor,
      hasMore: page.hasMore, detailBudget: page.detailBudget, detailsRead: page.detailsRead, scanFailures: page.scanFailures },
    (list ? `Orders:\n\n${list}` : 'No orders found.') +
      (partial ? '\n\nPartial results: some order pages or details could not be read.' : '') +
      (page.nextCursor ? `\n\nMore orders are available. Pass cursor "${page.nextCursor}" to continue.` : ''),
    partial ? 'partial' : page.items.length ? 'success' : 'empty');
  }

  async getOrder(orderId: string): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.orders.getOrder(orderId));
    if (!result.ok) return this.failed(result.error);
    const order = result.value;
    const lines = order.lines.status === 'available' ? order.lines.items : [];
    const unknownQuantityLines = lines.filter(line => line.quantity.status === 'unknown').length;
    return response({ order, unknownQuantityLines }, `${orderHeading(order)} — ${lines.length} product lines:\n${formatOrderLines(order)}` +
      (unknownQuantityLines ? `\n\n${unknownQuantityLines} quantities could not be read.` : ''),
    unknownQuantityLines ? 'partial' : lines.length ? 'success' : 'empty');
  }

  async listFrequentlyBoughtProducts(orderLimit: number, limit: number): Promise<CallToolResult> {
    const result = await this.recover(() => this.services.history.listFrequentlyBoughtProducts(orderLimit));
    if (!result.ok) return this.failed(result.error);
    const scan = result.value;
    if (!scan.succeeded && (scan.failed || scan.unscanned)) {
      const unavailable = errorResult(failure('order_details_unavailable', 'No order details could be read. See scan.failures.').error);
      return { ...unavailable, structuredContent: { ...unavailable.structuredContent, scan } };
    }
    const products = scan.products.slice(0, limit);
    const list = numbered(products.map(item => `${item.name}${item.productId ? ` [${item.productId}]` : ''} — ` +
      `${item.quantities.map(amount).join(' + ') || 'quantity unknown'} across ${item.orders} order${item.orders === 1 ? '' : 's'}`));
    return response({ ...scan, products },
      (list ? `Most frequently bought products across ${scan.succeeded} orders:\n\n${list}` : scan.listed === 0 ? 'No orders found.' : 'The orders read contain no product lines.') +
      (scan.failed ? `\n\nPartial results: ${scan.failed} of ${scan.scanned} orders could not be read and are not counted.` : '') +
      (scan.unscanned ? `\n${scan.unscanned} orders were not read before the request stopped.` : '') +
      (scan.failures.some(item => item.stage === 'listing') ? '\nSome order history pages could not be listed.' : ''),
    scan.completeness === 'partial' || scan.unknownQuantityLines ? 'partial' : products.length ? 'success' : 'empty');
  }

  async getSessionStatus(): Promise<CallToolResult> {
    const status = await this.services.session.getStatus?.() ?? { browser: 'unknown', credentials: { hasEmail: null, hasPassword: null },
      savedCookies: 'unknown', authentication: { state: 'unknown', checkedAt: null } };
    const favorites = await this.services.favorites.getCacheStatus();
    const credentials = status.credentials.hasEmail && status.credentials.hasPassword ? 'configured'
      : status.credentials.hasEmail === null ? 'unknown' : 'missing';
    const update = this.update.available ? ` Update available: ${this.update.latestVersion} (running ${this.update.currentVersion}).` : '';
    return response({ ...status, favorites, update: this.update }, `Browser: ${status.browser}. Credentials: ${credentials}. Saved cookies: ${status.savedCookies}. ` +
      `Last observed login state: ${status.authentication.state}. Favorites snapshot: ${favorites.state}.${update}`);
  }
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const UNCERTAIN_WRITE = 'If the result has mutation.outcome "unknown", the cart may have changed: call get_cart before any further change and never repeat the request automatically.';

const NO_UPDATE_INFO: UpdateStatus = { currentVersion: null, latestVersion: null, available: false };

export function registerShoppingTools(services: ShoppingServices, update: UpdateStatus = NO_UPDATE_INFO): ToolHandler[] {
  const handlers = new ShoppingHandlers(services, update);
  function tool<T>(name: string, title: string, description: string, inputSchema: z.ZodType<T>, outputSchema: z.ZodType,
    annotations: ToolAnnotations, execute: (args: T) => Promise<CallToolResult>, cartMutation = false,
    recoveryAction: 'get_cart' | 'get_checkout_summary' | 'list_pickup_slots' = 'get_cart', recoveryInput?: (args: T) => unknown): ToolHandler {
    return { definition: { name, title, description, annotations }, inputSchema, outputSchema, cartMutation, recoveryAction,
      ...(recoveryInput ? { recoveryInput: raw => recoveryInput(raw as T) } : {}),
      execute: raw => services.session.run(() => execute(raw as T)) };
  }
  return [
    tool('search_products', 'Search products',
      'Search the Continente.pt catalogue. No login needed. Results keep the website\'s relevance order, with products from your saved favorites first, and show ' +
      'each price with what it is for (per item, piece, kg or litre), the pack size and productId. Reads at most five result pages, so completeness may be "unknown" for broad queries.',
      contracts.SearchInput, contracts.SearchOutput, READ, args => handlers.searchProducts(args.query, args.limit)),
    tool('get_product', 'Get product',
      'Get one product by productId: price, availability and sale rules (sale unit, minimum, maximum and step). ' +
      'Check this before choosing a quantity for weighted or bulk products. No login needed.',
      contracts.GetProductInput, contracts.ProductDetailsOutput, READ, args => handlers.getProduct(args.productId)),
    tool('list_favorites', 'List favorites',
      'List the products saved as favorites on the account. Uses a local snapshot that is refreshed automatically when missing; ' +
      'snapshots older than 24 hours are marked stale. Pass refresh: true to fetch the current list from the website.',
      contracts.FavoritesInput, contracts.FavoritesOutput, READ, args => handlers.listFavorites(args.refresh)),
    tool('get_cart', 'Get cart',
      'Read the shopping cart: each line with productId, cartItemId, kind (product or bag), quantity, unit price (per item or per kg) ' +
      'and lineTotal, plus the totals ' +
      '(products, bags, deposit, delivery, discounts and grandTotal, the amount to pay). ' +
      'Use it to check current quantities before changing them and to verify any uncertain change.',
      contracts.EmptyInput, contracts.CartOutput, READ, () => handlers.getCart()),
    tool('get_checkout_summary', 'Get basket summary',
      'Read the basket-stage summary with current cart totals, reported order and shipping discounts, earned loyalty credit as a separate amount, and selected coupon IDs when rendered. The discount field excludes discounts embedded in line prices; the result is provisional and does not open delivery or payment.',
      contracts.EmptyInput, contracts.CheckoutSummaryOutput, READ, () => handlers.getCheckoutSummary()),
    tool('list_coupons', 'List coupons',
      'Read coupon cards from the signed-in account page. Returns only fields displayed by the page; expiry and eligibility remain unknown when the site does not render them. This tool does not select or apply coupons.',
      contracts.EmptyInput, contracts.CouponsOutput, READ, () => handlers.listCoupons()),
    tool('set_cart_coupons', 'Select cart coupons',
      'Set the selected coupon set using IDs from list_coupons. Selection is a cart change; only IDs are accepted, while all submission fields come from the current basket form. The tool reads back the basket to verify the result and never retries an uncertain write. If uncertain, use get_checkout_summary to inspect selected coupon state before another coupon change. It does not proceed to delivery or payment.',
      contracts.SetCartCouponsInput, contracts.CouponSelectionOutput, UPDATE,
      args => handlers.setCartCoupons(args.couponIds), true, 'get_checkout_summary'),
    tool('list_pickup_stores', 'Find pickup stores',
      'Search pickup-capable stores near an explicit postal code and public coordinates. This reads store rows only; it does not change selected-store context or inspect pickup slots.',
      contracts.PickupStoresInput, contracts.PickupStoresOutput, READ,
      args => handlers.listPickupStores({ postalCode: args.postalCode, latitude: args.latitude, longitude: args.longitude, ...(args.city ? { city: args.city } : {}) })),
    tool('list_pickup_slots', 'List pickup slots',
      'Read currently rendered pickup availability for an explicit date window of up to 31 days. The selected delivery mode must already be pickup. This reads server-rendered HTML only; it does not change the selected store, run the page JavaScript auto-selection, reserve a slot, or proceed to payment.',
      contracts.PickupSlotsInput, contracts.PickupSlotsOutput, READ,
      args => handlers.listPickupSlots({ from: args.fromDate, to: args.toDate })),
    tool('set_pickup_store', 'Set pickup store',
      'Change the selected primary pickup store to a fresh selectable storeId from list_pickup_stores. The operation verifies the store coverage response, changes store context once, and reads the delivery page back. If the result is uncertain, do not repeat it; the supplied date window is used for recovery with list_pickup_slots. Re-read the cart and coupons after a confirmed context change. This does not reserve a slot or open payment.',
      contracts.SetPickupStoreInput, contracts.PickupStoreChangeOutput, UPDATE,
      args => handlers.setPickupStore(args.storeId, { from: args.fromDate, to: args.toDate }), true, 'list_pickup_slots',
      args => ({ action: 'list_pickup_slots', fromDate: args.fromDate, toDate: args.toDate, automaticReplay: false })),
    tool('add_cart_item', 'Add to cart',
      'Add an amount of a product to the cart, on top of any quantity already there. quantity is in the product sale unit (default 1). ' +
      `Use set_cart_item_quantity instead when the user wants a specific total. ${UNCERTAIN_WRITE}`,
      contracts.AddCartItemInput, contracts.MutationOutput, ADD,
      args => handlers.addCartItem(args.productId, args.quantity, args.cartItemId), true),
    tool('set_cart_item_quantity', 'Set cart quantity',
      'Make the cart hold exactly this quantity of a product, adding it if it is not there yet. Zero removes it. ' +
      `Pass cartItemId from get_cart when the product has more than one line. ${UNCERTAIN_WRITE}`,
      contracts.SetCartItemQuantityInput, contracts.MutationOutput, UPDATE,
      args => handlers.setCartItemQuantity(args.productId, args.quantity, args.cartItemId), true),
    tool('remove_cart_item', 'Remove from cart',
      'Remove a product line from the cart. Succeeds without changes if it is already absent. ' +
      `Pass cartItemId from get_cart when the product has more than one line. ${UNCERTAIN_WRITE}`,
      contracts.RemoveCartItemInput, contracts.MutationOutput, UPDATE,
      args => handlers.removeCartItem(args.productId, args.cartItemId), true),
    tool('list_orders', 'List orders',
      'List recent orders, newest first, with their product lines. Each order has an orderId for get_order. ' +
      'Use detailLimit or includeLines: false to read fewer details, and pass the returned nextCursor as cursor to continue.',
      contracts.ListOrdersInput, contracts.OrdersOutput, READ,
      args => handlers.listOrders(args.limit, { includeLines: args.includeLines,
        ...(args.detailLimit !== undefined ? { detailLimit: args.detailLimit } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) })),
    tool('get_order', 'Get order',
      'Get the product lines of one order by its orderId from list_orders (not the displayed order number).',
      contracts.GetOrderInput, contracts.SingleOrderOutput, READ, args => handlers.getOrder(args.orderId)),
    tool('list_frequently_bought_products', 'List frequently bought products',
      'Rank products by how many recent orders contained them, with total quantities per unit. ' +
      'orderLimit sets how many recent orders to read (default 10); limit caps the products returned (default 25). Useful for building a usual shopping list.',
      contracts.FrequentlyBoughtInput, contracts.FrequencyOutput, READ,
      args => handlers.listFrequentlyBoughtProducts(args.orderLimit, args.limit)),
    tool('get_session_status', 'Get session status',
      'Report local state without contacting the website: browser status, whether credentials and saved cookies exist, ' +
      'the last observed login state and favorites snapshot freshness. Never returns secrets.',
      contracts.EmptyInput, contracts.SessionStatusOutput, { ...READ, openWorldHint: false }, () => handlers.getSessionStatus()),
  ];
}
