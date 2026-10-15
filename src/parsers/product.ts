import { load } from 'cheerio';
import { ProductDetailsSchema, parsePriceTag, parseProductReference, parseValue } from '../domain/index.js';
import type { ProductDetails, ProductId, Result, ToolError } from '../domain/index.js';
import { success, failure } from '../domain/index.js';
import { parseSaleRules } from './cart.js';
import { productReferenceFromUrl, recommendedPriceLabel, storefrontUrl } from './catalog.js';
import { record } from './records.js';

/** Scope every source to the requested product; recommendations cannot supply missing facts. */
export function parseProductDetails(html: string, sourceUrl: string, expectedId: ProductId): Result<ProductDetails, ToolError> {
  const url = storefrontUrl(sourceUrl); const reference = productReferenceFromUrl(sourceUrl);
  if (!url || !reference.ok || reference.value.productId !== expectedId) return failure('invalid_data', 'Product page identity changed');
  const $ = load(html); const name = $('h1.product-name').first().text().replace(/\s+/g, ' ').trim();
  const identity = parseProductReference($('input[name="productID"]').first().val());
  if (!name || !identity.ok || identity.value.productId !== expectedId) return failure('invalid_data', 'Product identity or name is unavailable');
  const metadata = $('.ct-tile-quantity-update[data-measure-options]').filter((_, node) => $(node).attr('data-pid') === expectedId)
    .map((_, node) => $(node).attr('data-measure-options')).get();
  const distinct = [...new Set(metadata)];
  const rules = distinct.length === 1 ? parseSaleRules(distinct[0]) : failure('sale_rules_unknown', 'Sale rules are missing or conflicting');
  const products: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    try { const candidate = record(JSON.parse($(node).text())); if (candidate?.['@type'] === 'Product' && String(candidate.sku) === expectedId) products.push(candidate); } catch { /* Optional metadata stays unknown. */ }
  });
  const offer = products.length === 1 ? record(products[0]!.offers) : null;
  const availability = typeof offer?.availability === 'string' ? offer.availability.replace(/^http:\/\//, 'https://') : '';
  const priceTag = (selector: string) => {
    const parsed = parsePriceTag($(`.ct-pdp--prices ${selector}`).first().text());
    return parsed.ok ? parsed.value : null;
  };
  // Only the product's own price block: recommendation tiles on the page carry their own PVPR.
  const recommended = parsePriceTag(recommendedPriceLabel($('.ct-pdp--prices .pvpr-info').first().parent().text()));
  const product = {
    ...reference.value, name, url,
    price: priceTag('.pwc-tile--price-primary'),
    secondaryPrice: priceTag('.pwc-tile--price-secondary'),
    recommendedPrice: recommended.ok ? recommended.value : null,
    availability: availability === 'https://schema.org/InStock' ? 'available' : ['https://schema.org/OutOfStock', 'https://schema.org/Discontinued'].includes(availability) ? 'unavailable' : 'unknown',
    saleRules: rules.ok ? { status: 'available', rules: rules.value.rules } : { status: 'unavailable', error: rules.error },
  };
  const parsed = parseValue(ProductDetailsSchema, product, 'product details');
  return parsed.ok ? success(parsed.value) : parsed;
}
