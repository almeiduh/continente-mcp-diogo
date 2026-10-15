import type { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from './server.js';
import type { Clock, SessionService, MutationResult } from '../ports.js';
import type { PriceTag, UpdateStatus, CartMutationResult, Money, ObservedQuantity, Order, ProductDetails, ProductSaleRules, Quantity, Result, ToolError } from '../domain/index.js';
import { failure } from '../domain/index.js';
import * as contracts from './contracts.js';
import { withAuthenticationRecovery } from '../services/recovery.js';
import type { CatalogService, FavoritesService, FavoritesSnapshot, SearchOptions, SearchResult } from '../services/catalog.js';
import type { CartService } from '../services/cart.js';
import type { OrderService, PurchaseHistoryService, OrderListOptions } from '../services/orders.js';

export interface ShoppingServices {
  catalog: CatalogService; favorites: FavoritesService; cart: CartService; orders: OrderService;
  history: PurchaseHistoryService; session: SessionService; clock?: Clock;
}

type Status = 'success' | 'empty' | 'partial';
type MutationSummary = z.infer<typeof contracts.ErrorResultSchema>['mutation'];
type SignInRecovery = z.infer<typeof contracts.SignInRecoverySchema>;

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
/** The structured form of `signInHelp`. */
export function signInRecovery(credentialsConfigured: boolean | null): SignInRecovery {
  return { credentials: credentialsConfigured === null ? 'unknown' : credentialsConfigured ? 'configured' : 'missing',
    action: credentialsConfigured === false ? 'configure_credentials' : 'check_credentials_or_sign_in',
    settings: { environment: ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'], claudeDesktopExtension: ['email', 'password'] },
    command: 'continentept-mcp login --show-browser', guide: CONFIGURATION_GUIDE, publicTools: ['search_products', 'get_product'] };
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
function errorResult(error: ToolError, mutation?: MutationSummary, signIn?: SignInRecovery): CallToolResult {
  const unknown = mutation?.outcome === 'unknown';
  const publicError = { ...error, ...(unknown ? { retryable: false } : {}) };
  const note = unknown ? '\nThe cart may have changed. Call get_cart before making another change; do not repeat this request automatically.'
    : mutation ? '\nThe cart was not changed.' : '';
  return { isError: true, content: [{ type: 'text', text: `Error (${publicError.code}): ${publicError.message}${note}` }],
    structuredContent: { result: { status: 'error', error: publicError, ...(mutation ? { mutation } : {}), ...(signIn ? { signIn } : {}) } } };
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
/** "6 items, 6 l in total, drained 260 g" from the parsed pack details. */
function packSummary(pack: NonNullable<ProductDetails['package']>): string {
  return [pack.count !== null && pack.count > 1 ? `${pack.count} items` : '',
    pack.net ? `${amount(pack.net)}${pack.approximate ? ' (approximate)' : ''} in total` : '',
    pack.drained ? `drained ${amount(pack.drained)}` : ''].filter(Boolean).join(', ');
}
function formatProduct(product: ProductDetails): string {
  const summary = product.package ? packSummary(product.package) : '';
  return [`${product.name}`, `productId: ${product.productId}`,
    `Price: ${priced(product.price)}${product.secondaryPrice ? ` (${priced(product.secondaryPrice)})` : ''}` +
      `${product.recommendedPrice ? `, PVPR ${priced(product.recommendedPrice)}` : ''}`,
    ...(product.packageText ? [`Pack: ${product.packageText}${summary ? ` (${summary})` : ''}`] : []),
    ...(product.minimumText ? [`Minimum purchase: ${product.minimumText}`] : []),
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
  private observedAt() { return (this.services.clock?.now() ?? new Date()).toISOString(); }
  /** An error result; sign-in failures before any cart write get guidance for fixing them. */
  private async failed(error: ToolError, mutation?: MutationSummary): Promise<CallToolResult> {
    if (error.code !== 'not_authenticated' || mutation?.outcome === 'unknown') return errorResult(error, mutation);
    const status = await this.services.session.getStatus?.().catch(() => undefined);
    const configured = !status || status.credentials.hasEmail === null ? null : status.credentials.hasEmail === true && status.credentials.hasPassword === true;
    return errorResult({ ...error, message: signInHelp(configured) }, mutation, signInRecovery(configured));
  }
  private recover<T>(operation: () => Promise<Result<T, ToolError>>) {
    return withAuthenticationRecovery(operation, () => this.services.session.refreshAuthentication());
  }

  async searchProducts(query: string, limit: number, options: SearchOptions = {}): Promise<CallToolResult> {
    const result = await this.services.catalog.searchProducts(query, limit, options);
    if (!result.ok) return this.failed(result.error);
    const { page, scanned, favorites } = result.value;
    const partial = page.completeness === 'partial';
    const text = page.items.length
      ? `${page.items.length} of ${scanned} scanned products for "${query}":\n\n${formatProductSearchResults(page.items)}`
      : `No products found for "${query}".`;
    return response({ observedAt: this.observedAt(), products: page.items, scanned, returned: page.items.length, favoritesLoaded: favorites.length,
      completeness: page.completeness, failures: page.failures, nextCursor: page.nextCursor },
    text + (partial ? `\n\nPartial results: ${page.failures.length} problem(s) reading results; see failures.` : '') +
      (page.nextCursor ? `\n\nMore results are available. Pass cursor "${page.nextCursor}" with the same query to continue.` : ''),
    partial ? 'partial' : page.items.length ? 'success' : 'empty');
  }

  async getProduct(reference: string): Promise<CallToolResult> {
    const result = await this.services.catalog.getProduct(reference);
    if (!result.ok) return this.failed(result.error);
    const product = result.value;
    const partial = product.saleRules.status === 'unavailable' || product.price === null || product.availability === 'unknown';
    return response({ ...product, observedAt: this.observedAt() }, formatProduct(product), partial ? 'partial' : 'success');
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
    const cart = { ...result.value, observedAt: this.observedAt() };
    if (!cart.items.length) return response(cart, 'The cart is empty.', 'empty');
    const list = numbered(cart.items.map(item => `${item.name}${item.kind === 'bag' ? ' (bag)' : ''} — ${observed(item.quantity)} × ${priced(item.price)}` +
      `${item.lineTotal ? `, line ${item.estimated ? 'about ' : ''}${euros(item.lineTotal)}` : ''}` +
      `\n   productId: ${item.productId}${item.cartItemId ? `, cartItemId: ${item.cartItemId}` : ''}`));
    const { totals } = cart;
    const optional = ([['Deposit', totals.deposit], ['Delivery', totals.delivery], ['Discounts', totals.discounts]] as const)
      .filter(([, value]) => value !== null && value.minorUnits > 0).map(([label, value]) => `${label}: ${euros(value)}`);
    const summary = [`Products: ${totals.products === null ? 'unavailable' : euros(totals.products)}`,
      ...(totals.bags !== null && totals.bags.minorUnits > 0 ? [`Bags: ${euros(totals.bags)}`] : []), ...optional,
      `Total to pay: ${totals.grandTotal === null ? 'unavailable' : `${totals.estimated ? 'about ' : ''}${euros(totals.grandTotal)}`}`,
      ...(totals.estimated ? ['Products sold by weight are charged by the weight picked, so the final amount can differ.'] : [])].join('\n');
    return response(cart, `Cart (${cart.items.length} lines):\n\n${list}\n\n${summary}\nCheckout happens on the website: ${CHECKOUT_URL}`);
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
    annotations: ToolAnnotations, execute: (args: T) => Promise<CallToolResult>, cartMutation = false): ToolHandler {
    return { definition: { name, title, description, annotations }, inputSchema, outputSchema, cartMutation,
      execute: raw => services.session.run(() => execute(raw as T)) };
  }
  return [
    tool('search_products', 'Search products',
      'Search the Continente.pt catalogue. No login needed. Results keep the website\'s relevance order and mark saved favorites; pass favoritesFirst to move them to the top. ' +
      'Each shows its price with what it is for (per item, piece, kg or litre), the pack size and productId. Pass nextCursor back as cursor, with the same query, for the next products.',
      contracts.SearchInput, contracts.SearchOutput, READ, args => handlers.searchProducts(args.query, args.limit, { ...(args.cursor ? { cursor: args.cursor } : {}), favoritesFirst: args.favoritesFirst })),
    tool('get_product', 'Get product',
      'Get one product by productId: price, pack size, availability and sale rules (sale unit, minimum, maximum and step). ' +
      'Availability is what the product page shows this session, signed in or not; it is not a delivery-slot stock check. ' +
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
