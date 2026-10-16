import { load } from 'cheerio';
import { ProductDetailsSchema, drainedPricePerKg, unitPriceOf, parsePriceTag, parseProductReference, parseValue } from '../domain/index.js';
import type { ProductDetails, ProductId, Result, ToolError } from '../domain/index.js';
import { success, failure } from '../domain/index.js';
import { parseSaleRules } from './cart.js';
import { minimumLabel, pagePromotions, packageLabel, productImageUrl, productReferenceFromUrl, recommendedPriceLabel, storefrontUrl } from './catalog.js';
import { parsePackageLabel } from './package.js';
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
  const images = products.length === 1 ? [products[0]!.image].flat() : [];
  const imageUrl = productImageUrl(images.find((image): image is string => typeof image === 'string'));
  const listed = typeof offer?.availability === 'string' ? offer.availability.replace(/^http:\/\//, 'https://') : '';
  // The page's own add button says whether the product can be bought; its structured data can still
  // say InStock when the button is disabled, so the button wins and the structured data is a fallback.
  const stock = [...new Set($('button.js-add-to-cart-button[data-container="pdp"]').filter((_, node) => $(node).attr('data-pid') === expectedId)
    .map((_, node) => $(node).attr('data-outofstock')).get())];
  const buyable = stock.length === 1 && (stock[0] === 'true' || stock[0] === 'false') ? stock[0] === 'false' : null;
  const priceTag = (selector: string) => {
    const parsed = parsePriceTag($(`.ct-pdp--prices ${selector}`).first().text());
    return parsed.ok ? parsed.value : null;
  };
  // Only the product's own price block: recommendation tiles on the page carry their own PVPR.
  const recommended = parsePriceTag(recommendedPriceLabel($('.ct-pdp--prices .pvpr-info').first().parent().text()));
  // The product's own pack label; recommendation tiles use .pwc-tile--quantity instead.
  const units = $('.ct-pdp--unit').map((_, node) => $(node).text()).get();
  const unit = units.length === 1 ? units[0]! : '';
  const product = {
    ...reference.value, name, url,
    packageText: packageLabel(unit), package: parsePackageLabel(packageLabel(unit)), minimumText: minimumLabel(unit),
    drainedPrice: drainedPricePerKg(priceTag('.pwc-tile--price-primary'), parsePackageLabel(packageLabel(unit))),
    unitPrice: unitPriceOf(priceTag('.pwc-tile--price-primary'), priceTag('.pwc-tile--price-secondary'), parsePackageLabel(packageLabel(unit)),
      drainedPricePerKg(priceTag('.pwc-tile--price-primary'), parsePackageLabel(packageLabel(unit)))),
    price: priceTag('.pwc-tile--price-primary'),
    secondaryPrice: priceTag('.pwc-tile--price-secondary'),
    recommendedPrice: recommended.ok ? recommended.value : null,
    // The product's own badge sits beside its name; recommendation tiles carry their own.
    promotions: pagePromotions({ badge: $('.product-name-details--wrapper .ct-product-tile-badge--promotional img').filter((_, node) => $(node).closest('.product-tile').length === 0).first().attr('alt') ?? '',
      message: $(`.dual-badge-${expectedId}.dual-badge-message .dual-badge-message-text`).filter((_, node) => $(node).closest('.product-tile').length === 0).first().text(),
      struck: $('.ct-pdp--prices .list .strike-through').first().text(), recommended: recommended.ok ? recommended.value : null,
      price: priceTag('.pwc-tile--price-primary'), validity: $('.ct-pdp--promo-time-text').first().text() }),
    imageUrl,
    availability: buyable !== null ? (buyable ? 'available' : 'unavailable') : listed === 'https://schema.org/InStock' ? 'available'
      : ['https://schema.org/OutOfStock', 'https://schema.org/Discontinued'].includes(listed) ? 'unavailable' : 'unknown',
    saleRules: rules.ok ? { status: 'available', rules: rules.value.rules } : { status: 'unavailable', error: rules.error },
  };
  const parsed = parseValue(ProductDetailsSchema, product, 'product details');
  return parsed.ok ? success(parsed.value) : parsed;
}
