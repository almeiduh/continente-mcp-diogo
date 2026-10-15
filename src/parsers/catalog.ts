import { load } from 'cheerio';
import { FavoriteProductSchema, ProductSchema, parsePriceTag, parseProductReference, parseValue } from '../domain/index.js';
import type { FavoriteProduct, PriceTag, Product, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { parsePackageLabel } from './package.js';

export const STOREFRONT_ORIGIN = 'https://www.continente.pt';
export function storefrontUrl(value: string): string | null {
  try { const url = new URL(value, STOREFRONT_ORIGIN); return url.origin === STOREFRONT_ORIGIN && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
const text = (value: string) => value.replace(/\s+/g, ' ').trim();
export function productReferenceFromUrl(href: string) {
  const url = storefrontUrl(href);
  const slug = url ? new URL(url).pathname.match(/^\/produto\/([^/]+)\.html$/)?.[1] : undefined;
  const parsed = parseProductReference(slug);
  // Slugs can contain encoded punctuation that tool inputs do not accept; fall back to the numeric ID.
  return parsed.ok ? parsed : parseProductReference(slug?.match(/-(\d+)(?:-master)?$/)?.[1]);
}

const PRICE_IN_LABEL = /\d+[,.]\d+\s*€(?:\s*\/\s*[a-z]+)?/gi;
const SEARCH_EMPTY = '.search-noresults-wrapper, .search-no-results, [data-search-empty]';
const PRODUCT_LINK = 'a[href*="/produto/"]';

/** Text after "=" in labels such as "Quant. Mínima = 600 gr (3 un)". */
export function minimumLabel(label: string): string | null {
  const [caption, ...rest] = label.split('=');
  return /m[ií]nim/i.test(caption ?? '') && rest.length ? text(rest.join('=')) || null : null;
}
/** Pack size from labels such as "emb. 940 gr" or "emb. 2 x 52 gr". */
export function packageLabel(label: string): string | null {
  return text(/^emb\.\s*(.+)$/i.exec(text(label))?.[1] ?? '') || null;
}
/** The amount in a "PVPR 6,00€" label, the recommended retail price shown beside a promotional price. */
export function recommendedPriceLabel(label: string): string {
  return text(label).replace(/^PVPR\s*/i, '');
}
/** An unrecognised price is reported, not fatal: the product stays usable with an unknown price. */
function priceOrNull(label: string): { price: PriceTag | null; recognised: boolean } {
  const parsed = parsePriceTag(label);
  return parsed.ok ? { price: parsed.value, recognised: true } : { price: null, recognised: false };
}

export interface SearchPage {
  products: Product[];
  /** One entry per result that was skipped or kept with missing data. */
  problems: ToolError[];
}

/** Parse one results page. A bad card is reported in `problems` instead of failing the page. */
export function parseProductSearchPage(html: string): Result<SearchPage, ToolError> {
  const $ = load(html);
  if ($(SEARCH_EMPTY).length) return success({ products: [], problems: [] });
  const tiles = $($('.search-results-grid').length ? '.search-results-grid .ct-inner-tile-wrap' : '.ct-inner-tile-wrap').toArray();
  if (!tiles.length) return failure('invalid_data', 'The search results page was not recognised');
  const products: Product[] = [];
  const problems: ToolError[] = [];
  const problem = (message: string) => problems.push(failure('invalid_data', message).error);
  tiles.forEach((tile, index) => {
    const card = $(tile);
    const position = `Search result ${index + 1}`;
    const links = card.find(PRODUCT_LINK).toArray().map(link => ({ href: $(link).attr('href'), label: text($(link).text()) }));
    const href = links[0]?.href;
    const name = links.map(link => link.label).find(Boolean);
    const reference = href ? productReferenceFromUrl(href) : null;
    if (!href || !name || !reference?.ok) { problem(`${position} was not recognised and was skipped.`); return; }
    const main = priceOrNull(text(card.find('.pwc-tile--price-primary').first().text()));
    const secondary = priceOrNull(text(card.find('.pwc-tile--price-secondary').first().text()));
    const recommended = priceOrNull(recommendedPriceLabel(card.find('.pvpr-info').first().parent().text()));
    if (!main.recognised) problem(`${position} (product ${reference.value.productId}) has a price in an unrecognised format; its price is unknown.`);
    if (!recommended.recognised) problem(`${position} (product ${reference.value.productId}) has a recommended price (PVPR) in an unrecognised format; it is unknown.`);
    const quantity = card.find('.pwc-tile--quantity').first().text();
    const product = parseValue(ProductSchema, { ...reference.value, name, url: storefrontUrl(href), price: main.price,
      secondaryPrice: secondary.price, packageText: packageLabel(quantity), package: parsePackageLabel(packageLabel(quantity)), minimumText: minimumLabel(quantity),
      recommendedPrice: recommended.price }, 'product');
    if (product.ok) products.push(product.value); else problem(`${position} (product ${reference.value.productId}) was not recognised and was skipped.`);
  });
  if (!products.length && problems.length) return failure('invalid_data', 'No search result on the page could be recognised');
  return success({ products: uniqueProducts(products), problems });
}

export function parseFavoritesPageData(html: string): Result<{ items: FavoriteProduct[]; expectedIds: string[]; nextCursor: string | null }, ToolError> {
  const $ = load(html);
  const grids = $('.favorites-list .favorite-grid[data-pids]');
  if (grids.length !== 1) return failure('invalid_data', 'The favorites page was not recognised');
  const grid = grids.first();
  let rawIds: unknown;
  try { rawIds = JSON.parse(grid.attr('data-pids') ?? ''); } catch { return failure('invalid_data', 'The favorites product list is malformed'); }
  if (!Array.isArray(rawIds)) return failure('invalid_data', 'The favorites product list is malformed');
  const ids = rawIds.map(value => parseProductReference(value));
  if (ids.some(id => !id.ok)) return failure('invalid_data', 'The favorites product list is malformed');
  const expected = new Set(ids.flatMap(id => id.ok ? [id.value.productId] : []));
  const products: FavoriteProduct[] = [];
  let error: ToolError | undefined;
  grid.find('.favoriteProductTile').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a[href*="/produto/"]').filter((_, element) => text($(element).text()).length > 0).first();
    const label = text(anchor.text());
    const href = anchor.attr('href') ?? '';
    const name = label.replace(PRICE_IN_LABEL, '').trim();
    if (!name) { error = failure('invalid_data', 'A favorite product was not recognised').error; return; }
    const ref = productReferenceFromUrl(href);
    const rawPrice = text(card.find('.pwc-tile--price-primary').first().text()) || label.match(PRICE_IN_LABEL)?.[0] || '';
    if (!ref.ok) { error = ref.error; return; }
    // Favorites must be complete, but an unrecognised price only makes that price unknown.
    const result = parseValue(FavoriteProductSchema, { ...ref.value, name, price: priceOrNull(rawPrice).price, url: storefrontUrl(href) }, 'favorite');
    if (result.ok) products.push(result.value); else error = result.error;
  });
  if (error) return { ok: false, error };
  const unique = uniqueProducts(products);
  if (unique.some(product => !expected.has(product.productId))) {
    return failure('invalid_data', 'The favorites page lists products it does not show');
  }
  const next = parseFavoritesContinuation(html);
  return next.ok ? success({ items: unique, expectedIds: [...expected], nextCursor: next.value }) : next;
}
export function parseFavoritesContinuation(html: string): Result<string | null, ToolError> {
  const $ = load(html);
  const links = $('.favorites-list a[rel~="next"]');
  if (!links.length) return success(null);
  const href = storefrontUrl(links.first().attr('href') ?? '');
  const url = href ? new URL(href) : null;
  if (links.length !== 1 || !url || !(url.pathname.endsWith('/Wishlist-RenderGrid') ||
    (url.pathname === '/conta/lista-produtos/' && url.searchParams.get('list') === 'favorites'))) {
    return failure('invalid_data', 'Invalid favorites continuation');
  }
  return success(href);
}
export function parseFavoritesPages(pages: string[]): Result<FavoriteProduct[], ToolError> {
  if (!pages.length) return failure('invalid_data', 'The favorites page was not recognised');
  const expected = new Set<string>(); const items: FavoriteProduct[] = [];
  let next: string | null = null;
  for (const html of pages) {
    const parsed = parseFavoritesPageData(html);
    if (!parsed.ok) return parsed;
    parsed.value.expectedIds.forEach(id => expected.add(id)); items.push(...parsed.value.items); next = parsed.value.nextCursor;
  }
  const unique = uniqueProducts(items);
  // The source identity list proves an empty grid is genuinely empty rather than still loading.
  if (next || unique.length !== expected.size) return failure('invalid_data', 'Not every favorite could be read');
  return success(unique);
}

export function uniqueProducts<T extends FavoriteProduct>(products: T[]): T[] {
  const seen = new Set<string>();
  return products.filter(product => { if (seen.has(product.productId)) return false; seen.add(product.productId); return true; });
}
export interface RankedProduct extends Product {
  /** This exact product is in the saved favorites. */
  favorite: boolean;
}
/**
 * The website orders results by relevance to the query; keep that order and only move exact
 * favorites to the front. Name similarity to favorites is not used: shared words such as a
 * brand name would pull unrelated products above real matches.
 */
export function rankProductsByFavorites(products: Product[], favorites: FavoriteProduct[]): RankedProduct[] {
  const favoriteIds = new Set(favorites.map(product => product.productId));
  const ranked = products.map(product => ({ ...product, favorite: favoriteIds.has(product.productId) }));
  return [...ranked.filter(product => product.favorite), ...ranked.filter(product => !product.favorite)];
}
export function parseSearchPagination(html: string): Result<{ url: string; start: number; size: number } | null, ToolError> {
  const actions = load(html)('[data-url*="Search-UpdateGrid"]');
  const action = actions.first().attr('data-url');
  if (!action) return success(null);
  const href = storefrontUrl(action);
  if (!href) return failure('invalid_data', 'Invalid search continuation');
  const url = new URL(href);
  const rawStart = url.searchParams.get('start') ?? ''; const rawSize = url.searchParams.get('sz') ?? '';
  const start = Number(rawStart); const size = Number(rawSize);
  return actions.length === 1 && url.pathname.endsWith('/Search-UpdateGrid') && /^\d+$/.test(rawStart) && /^\d+$/.test(rawSize) &&
    Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= 0 && size > 0 && size <= 200
    ? success({ url: href, start, size }) : failure('invalid_data', 'Invalid search continuation');
}
