import { requestIO, RequestStopped } from '../session/request.js';
import { z } from 'zod';
import type { Clock, FavoritesGateway, FavoritesStore, CatalogGateway, Logger, SearchResume } from '../ports.js';
import type { FavoritesCache, FavoritesStatus, PageResult, Product, ProductId, ProductLabel, Result, ToolError } from '../domain/index.js';
import { parseProductReference } from '../domain/index.js';
import { parseProductDetails } from '../parsers/product.js';
import { isProductLabelUrl, parseProductLabel, productLabelUrl } from '../parsers/label.js';
import { success, failure } from '../domain/index.js';
import { parseFavoritesPages, parseProductSearchPage, rankProductsByFavorites, storefrontUrl } from '../parsers/catalog.js';
import type { RankedProduct } from '../parsers/catalog.js';

export const FAVORITES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export interface FavoritesSnapshot extends FavoritesCache {
  source: 'cache' | 'website'; freshness: 'fresh' | 'stale'; expiresAt: string; cacheState: 'empty' | 'populated';
}
export class FavoritesService {
  constructor(private readonly client: FavoritesGateway, private readonly store: FavoritesStore,
    private readonly clock: Clock, private readonly accountScope: string | (() => string), private readonly logger: Logger) {}
  private scope(): string { return typeof this.accountScope === 'function' ? this.accountScope() : this.accountScope; }
  private snapshot(cache: FavoritesCache, source: 'cache' | 'website'): FavoritesSnapshot {
    const fetched = Date.parse(cache.fetchedAt); const now = this.clock.now().getTime();
    return { ...cache, source, freshness: fetched <= now && now - fetched < FAVORITES_MAX_AGE_MS ? 'fresh' : 'stale',
      expiresAt: new Date(fetched + FAVORITES_MAX_AGE_MS).toISOString(), cacheState: cache.favorites.length ? 'populated' : 'empty' };
  }
  async loadCachedFavorites(): Promise<FavoritesCache | null> {
    const cached = await requestIO(() => this.store.load());
    if (!cached.ok) { this.logger('Could not read the favorites cache.'); return null; }
    return cached.value?.accountScope === this.scope() ? cached.value : null;
  }
  async getCacheStatus(): Promise<FavoritesStatus> {
    const unavailable: FavoritesStatus = { state: 'unavailable', fetchedAt: null, expiresAt: null, empty: null };
    try {
      const result = await requestIO(() => this.store.load());
      if (!result.ok) return unavailable;
      if (result.value === null) return { ...unavailable, state: 'missing' };
      if (result.value.accountScope !== this.scope()) return unavailable;
      const value = this.snapshot(result.value, 'cache');
      return { state: value.freshness, fetchedAt: value.fetchedAt, expiresAt: value.expiresAt, empty: value.cacheState === 'empty' };
    } catch (error) { if (error instanceof RequestStopped) throw error; return unavailable; }
  }
  async listFavorites(): Promise<Result<FavoritesSnapshot, ToolError>> {
    const cached = await this.loadCachedFavorites();
    return cached ? success(this.snapshot(cached, 'cache')) : this.refreshFavorites();
  }
  async refreshFavorites(): Promise<Result<FavoritesSnapshot, ToolError>> {
    const scope = this.scope();
    const response = await requestIO(() => this.client.fetchFavorites());
    if (!response.ok) return response;
    const [firstFailure] = response.value.failures;
    if (firstFailure) return { ok: false, error: firstFailure };
    const products = parseFavoritesPages(response.value.pages);
    if (!products.ok) return products;
    if (scope !== this.scope()) return failure('cache_unavailable', 'Favorites account/session changed during refresh');
    const cache: FavoritesCache = { schemaVersion: 2, accountScope: scope,
      fetchedAt: this.clock.now().toISOString(), favorites: products.value, completeness: 'complete' };
    const saved = await requestIO(() => this.store.save(cache));
    return saved.ok ? success(this.snapshot(cache, 'website')) : saved;
  }
}
export interface SearchResult {
  page: PageResult<RankedProduct>;
  scanned: number;
  favorites: FavoritesCache['favorites'];
}
export interface SearchOptions {
  /** `nextCursor` from an earlier search for the same query. */
  cursor?: string;
  /** Move products from the saved favorites to the top of the returned products. */
  favoritesFirst?: boolean;
  /** Keep only products whose category path contains this text, such as `Congelados/Frutas e Legumes`. */
  category?: string;
  /** Leave out products whose category path contains this text, such as `Animais`. */
  excludeCategory?: string;
  /** Keep only products whose brand contains this text. */
  brand?: string;
  /** `unit_price` orders the returned products by price per drained kg, kg or litre. */
  sort?: 'relevance' | 'unit_price';
}
/** Lower case without accents, so `Laticínios` matches `laticinios`. */
const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
/** Products a search keeps. An unknown category or brand never matches a filter that asks for one. */
export function searchFilter(options: SearchOptions): (product: Product) => boolean {
  const category = options.category ? fold(options.category) : null;
  const excluded = options.excludeCategory ? fold(options.excludeCategory) : null;
  const brand = options.brand ? fold(options.brand) : null;
  return product => (!category || (product.category !== null && fold(product.category).includes(category)))
    && (!excluded || product.category === null || !fold(product.category).includes(excluded))
    && (!brand || (product.brand !== null && fold(product.brand).includes(brand)));
}
/** The price used to compare products: per drained kg when the label gives a drained weight, else per kg or litre. */
export function comparablePrice(product: Product): { per: 'kg' | 'l'; minorUnits: number } | null {
  if (product.drainedPrice) return { per: 'kg', minorUnits: product.drainedPrice.amount.minorUnits };
  for (const price of [product.price, product.secondaryPrice]) if (price && (price.per === 'kg' || price.per === 'l')) return { per: price.per, minorUnits: price.amount.minorUnits };
  return null;
}
/** Cheapest first, per kg before per litre; products without a comparable price keep their order at the end. */
function byUnitPrice<T extends Product>(products: T[]): T[] {
  const priced = products.map((product, index) => ({ product, index, price: comparablePrice(product) }));
  return priced.sort((a, b) => !a.price || !b.price ? (a.price ? -1 : b.price ? 1 : a.index - b.index)
    : a.price.per !== b.price.per ? (a.price.per === 'kg' ? -1 : 1) : a.price.minorUnits - b.price.minorUnits || a.index - b.index).map(entry => entry.product);
}

const SearchCursorSchema = z.strictObject({ v: z.literal(1), q: z.string(), start: z.number().int().nonnegative().max(100000), grid: z.string().nullable() });
/** An opaque cursor for the result after the last one returned. */
export function encodeSearchCursor(query: string, resume: SearchResume): string {
  return Buffer.from(JSON.stringify({ v: 1, q: query, start: resume.start, grid: resume.grid })).toString('base64url');
}
/** A cursor from `encodeSearchCursor`, only for the same query and only pointing at the website's results grid. */
export function decodeSearchCursor(cursor: string, query: string): Result<SearchResume, ToolError> {
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return failure('invalid_input', 'Invalid search cursor'); }
  const parsed = SearchCursorSchema.safeParse(raw);
  if (!parsed.success) return failure('invalid_input', 'Invalid search cursor');
  if (parsed.data.q !== query) return failure('invalid_input', 'This cursor belongs to a search for different text');
  const grid = parsed.data.grid === null ? null : storefrontUrl(parsed.data.grid);
  if (parsed.data.grid !== null && (!grid || !new URL(grid).pathname.endsWith('/Search-UpdateGrid') || new URL(grid).searchParams.get('q') !== query)) {
    return failure('invalid_input', 'Invalid search cursor');
  }
  return success({ start: parsed.data.start, grid });
}
export class CatalogService {
  constructor(private readonly client: CatalogGateway, private readonly favorites: FavoritesService) {}
  /** Label URLs seen on product pages, so a label can be read without loading the page again. */
  private readonly labels = new Map<ProductId, { url: string | null; name: string }>();
  async getProduct(reference: string) {
    const parsed = parseProductReference(reference);
    if (!parsed.ok) return failure('invalid_input', 'Invalid product reference');
    if (!this.client.fetchProductDetails) return failure('upstream_unavailable', 'Product inspection is unavailable');
    const response = await requestIO(() => this.client.fetchProductDetails!(reference));
    if (!response.ok) return response;
    const details = parseProductDetails(response.value.html, response.value.url, parsed.value.productId);
    if (details.ok) this.rememberLabel(details.value.productId, productLabelUrl(response.value.html, details.value.productId), details.value.name);
    return details;
  }
  private rememberLabel(productId: ProductId, url: string | null, name: string) {
    this.labels.delete(productId); this.labels.set(productId, { url, name });
    if (this.labels.size > 500) this.labels.delete(this.labels.keys().next().value!);
  }
  /**
   * The website's copy of a product's label. Its URL carries the product's EAN, which only the
   * product page shows, so the page is read first unless an earlier call already did. `label` is
   * null when the website has no label information for the product.
   */
  async getProductLabel(reference: string): Promise<Result<{ productId: ProductId; name: string; label: ProductLabel | null }, ToolError>> {
    const parsed = parseProductReference(reference);
    if (!parsed.ok) return failure('invalid_input', 'Invalid product reference');
    const { productId } = parsed.value;
    if (!this.labels.has(productId)) { const product = await this.getProduct(productId); if (!product.ok) return product; }
    const known = this.labels.get(productId);
    if (!known) return failure('upstream_unavailable', 'The product page could not be read');
    if (!known.url) return success({ productId, name: known.name, label: null });
    if (!this.client.fetchProductLabel || !isProductLabelUrl(known.url, productId)) return failure('upstream_unavailable', 'Product labels are unavailable');
    const html = await requestIO(() => this.client.fetchProductLabel!(known.url!));
    if (!html.ok) return html;
    const label = parseProductLabel(html.value);
    return label.ok ? success({ productId, name: known.name, label: label.value }) : label;
  }
  /**
   * Products in the website's relevance order, `limit` at a time. `nextCursor` continues right
   * after the last product returned, so following it never skips or repeats a result.
   */
  async searchProducts(query: string, limit: number, options: SearchOptions = {}): Promise<Result<SearchResult, ToolError>> {
    const resume = options.cursor === undefined ? null : decodeSearchCursor(options.cursor, query);
    if (resume && !resume.ok) return resume;
    const from = resume?.value.start ?? 0;
    const cache = await this.favorites.loadCachedFavorites();
    // Not wrapped in requestIO: the gateway handles cancellation per page so read pages survive.
    const accept = searchFilter(options);
    const response = await this.client.searchProducts(query, limit, resume?.value, accept);
    if (!response.ok) return response;
    const entries: { product: Product; position: number }[] = [];
    const failures = [...response.value.failures];
    for (const [index, html] of response.value.pages.entries()) {
      const parsed = parseProductSearchPage(html, response.value.starts?.[index] ?? 0);
      if (!parsed.ok) {
        if (!entries.length) return parsed;
        failures.push(parsed.error); break;
      }
      parsed.value.products.forEach((product, position) => entries.push({ product, position: parsed.value.positions[position] ?? 0 }));
      failures.push(...parsed.value.problems);
    }
    const seen = new Set<string>();
    const fresh = entries.filter(({ product, position }) => position >= from && accept(product) && !seen.has(product.productId) && seen.add(product.productId));
    const taken = fresh.slice(0, limit);
    const last = taken.at(-1);
    const more = fresh.length > limit || Boolean(response.value.nextCursor);
    const nextCursor = more && last ? encodeSearchCursor(query, { start: last.position + 1, grid: response.value.grid ?? null }) : null;
    const favorites = cache?.favorites ?? [];
    return success({ scanned: fresh.length, favorites, page: {
      items: (() => {
        const ranked = rankProductsByFavorites(taken.map(entry => entry.product), favorites, options.favoritesFirst ?? false);
        return options.sort === 'unit_price' ? byUnitPrice(ranked) : ranked;
      })(), nextCursor,
      completeness: failures.length ? 'partial' : nextCursor ? 'unknown' : 'complete', failures,
    } });
  }
}
