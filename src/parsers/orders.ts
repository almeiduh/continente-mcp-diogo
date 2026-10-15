import { load } from 'cheerio';
import { OrderLineSchema, OrderNumberSchema, OrderIdSchema, QuantitySchema, parseProductReference, parseValue } from '../domain/index.js';
import type { Order, OrderLine, ObservedQuantity, PurchaseFrequency, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { storefrontUrl } from './catalog.js';

export function parseOrderQuantity(text: string): ObservedQuantity {
  const match = text.trim().match(/^(\d+(?:[.,]\d+)?)\s*(un|kg|g|l|ml)\s*$(?![\s\S])/i);
  const parsed = match ? QuantitySchema.safeParse({ value: Number(match[1]!.replace(',', '.')), unit: match[2]!.toLowerCase() }) : null;
  return parsed?.success ? { status: 'known', quantity: parsed.data } : { status: 'unknown', value: null, rawText: text,
    reason: !text.trim() ? 'missing' : match ? 'invalid_value' : /^\d+(?:[.,]\d+)?\s*[a-z]+$/i.test(text.trim()) ? 'unsupported_unit' : 'unrecognized_format' };
}
export function parseOrderLines(html: string): Result<OrderLine[], ToolError> {
  const $ = load(html);
  const items: OrderLine[] = [];
  let error: ToolError | undefined;
  $('.ct-order-history--product-item, .product-line').each((_, element) => {
    const line = $(element);
    const qty = line.find('.ct-order-history--product-quantity, .quantity, .qty').first();
    const named = line.find('.ct-order-history--product-title, .product-name, a[href*="/produto/"]').first();
    if (!named.length && !qty.length && !line.hasClass('ct-order-history--product-item')) return; // category heading
    const name = named.text().trim().split('\n')[0]?.trim() ?? '';
    const href = named.attr('href');
    const rawId = line.attr('data-pid') ?? href?.match(/-(\d+)(?:-master)?\.html(?:[?#]|$)/)?.[1];
    const ref = rawId === undefined ? null : parseProductReference(rawId);
    if (ref && !ref.ok) { error = ref.error; return; }
    const parsed = parseValue(OrderLineSchema, { productId: ref?.ok ? ref.value.productId : null, name, quantity: parseOrderQuantity(qty.text()) }, 'order line');
    if (parsed.ok) items.push(parsed.value); else error = parsed.error;
  });
  if (error) return { ok: false, error };
  if (items.length) return success(items);
  // An empty source item array plus the known detail container proves emptiness.
  if ($('.ct-order-history--products-list-container').length) {
    try { const source: unknown = JSON.parse($('input[name="orderLineItems"]').val() as string); if (Array.isArray(source) && source.length === 0) return success([]); } catch { /* unrecognized */ }
  }
  return failure('order_details_unavailable', 'Order detail markup was not recognized');
}
export interface OrderSummary { order: Order; detailUrl: string | null; error?: ToolError; }
export interface OrderHistory { entries: OrderSummary[]; nextCursor: string | null; completeness: 'complete' | 'unknown'; totalCount: number | null; }
export function orderHistoryUrl(value: string): string | null {
  const href = storefrontUrl(value);
  return href && new URL(href).pathname === '/conta/encomendas/' ? href : null;
}
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** "2 outubro 2026", "2 de outubro de 2026" or the abbreviated "01 Set 26"; anything else stays unparsed. */
export function normalizedDate(raw: string): string | null {
  const match = raw.trim().toLowerCase().match(/^(\d{1,2})\s+(?:de\s+)?([a-zç]+)\.?\s+(?:de\s+)?(\d{4}|\d{2})$/);
  if (!match) return null;
  const name = match[2]!;
  const month = MONTHS.findIndex(full => full === name || (name.length === 3 && full.startsWith(name)));
  const day = Number(match[1]); const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return month >= 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
export function parseOrderHistory(html: string): Result<OrderHistory, ToolError> {
  const $ = load(html);
  const cards = $('.ct-order-history--order-preview-item');
  const roots = $('.ct-order-history--landing-container');
  const totalText = roots.first().attr('data-order-count');
  const total = totalText !== undefined && /^\d+$/.test(totalText) ? Number(totalText) : null;
  if (totalText !== undefined && (total === null || !Number.isSafeInteger(total))) return failure('invalid_data', 'The order history count is malformed');
  if (!cards.length && !(roots.length === 1 && total === 0)) return failure('invalid_data', 'The order history page was not recognised');
  const next = roots.find('a[rel~="next"]');
  const nextCursor = next.length === 1 ? orderHistoryUrl(next.attr('href') ?? '') : null;
  if (next.length && !nextCursor) return failure('invalid_data', 'The order history next-page link is invalid');
  const entries: OrderSummary[] = [];
  for (const element of cards.toArray()) {
    const card = $(element);
    const numbers = [...new Set(card.find('.ct-order-history--order-preview-number').text().match(/\b\d{9}_\d{3}\b/g) ?? [])];
    if (numbers.length !== 1) return failure('invalid_data', 'An order summary has no single order number');
    const orderNumber = OrderNumberSchema.parse(numbers[0]);
    const urls = [...new Set(card.find('a[href*="detalhe-encomenda"]').toArray().map(a => storefrontUrl($(a).attr('href') ?? '')))];
    let detailUrl: string | null = urls.length === 1 ? urls[0] ?? null : null;
    const url = detailUrl ? new URL(detailUrl) : null;
    const id = url && ['/conta/detalhe-encomenda/', '/detalhe-encomenda'].includes(url.pathname)
      ? OrderIdSchema.safeParse(url.searchParams.get('orderID') ?? url.searchParams.get('id')) : null;
    if (!id?.success) detailUrl = null;
    const rawDate = card.find('.ct-order-history--order-preview-delivery-date').first().text().trim() || null;
    const order: Order = { orderId: id?.success ? id.data : null, orderNumber, date: rawDate ? normalizedDate(rawDate) : null, rawDate, lines: { status: 'not_requested' } };
    const existing = entries.find(entry => entry.order.orderNumber === orderNumber || (order.orderId !== null && entry.order.orderId === order.orderId));
    if (existing) {
      if (existing.order.orderNumber !== orderNumber || existing.detailUrl !== detailUrl) return failure('invalid_data', 'The same order appears with conflicting details');
      continue;
    }
    entries.push({ order, detailUrl, ...(!detailUrl ? { error: failure('order_details_unavailable', 'Order detail link is missing or ambiguous').error } : {}) });
  }
  if (total !== null && entries.length > total) return failure('invalid_data', 'The order history count is malformed');
  return success({ entries, nextCursor, totalCount: total, completeness: total !== null && total === entries.length && !nextCursor ? 'complete' : 'unknown' });
}
export function parseOrderDetail(html: string, expected: Order): Result<OrderLine[], ToolError> {
  const $ = load(html);
  const numbers = [...new Set($('.order-list-title').text().match(/\b\d{9}_\d{3}\b/g) ?? [])];
  const ids = [...new Set($('[data-order-id]').toArray().map(element => $(element).attr('data-order-id')))];
  if ((numbers.length && (numbers.length !== 1 || (expected.orderNumber !== null && numbers[0] !== expected.orderNumber))) ||
    (ids.length && (ids.length !== 1 || (expected.orderId !== null && ids[0] !== expected.orderId)))) {
    return failure('order_details_unavailable', 'Order detail identity does not match its summary');
  }
  return parseOrderLines(html);
}
export function parseSingleOrder(html: string, orderId: Order['orderId']): Result<Order, ToolError> {
  const $ = load(html);
  const numbers = [...new Set($('.order-list-title').text().match(/\b\d{9}_\d{3}\b/g) ?? [])];
  if (numbers.length > 1) return failure('order_details_unavailable', 'Ambiguous order detail identity');
  const rawDate = $('[data-order-date]').first().attr('data-order-date') ?? null;
  const order: Order = { orderId, orderNumber: numbers[0] ? OrderNumberSchema.parse(numbers[0]) : null,
    date: rawDate ? normalizedDate(rawDate) : null, rawDate, lines: { status: 'not_requested' } };
  const lines = parseOrderDetail(html, order);
  return lines.ok ? success({ ...order, lines: { status: 'available', items: lines.value } }) : lines;
}
export function aggregatePurchaseFrequency(orders: OrderLine[][]): Result<PurchaseFrequency[], ToolError> {
  const tally = new Map<string, PurchaseFrequency>();
  for (const items of orders) {
    const seen = new Set<string>();
    for (const item of items) {
      const key = item.productId !== null ? `id:${item.productId}` : `name:${item.name}`;
      const entry: PurchaseFrequency = tally.get(key) ?? { productId: item.productId, identityBasis: item.productId !== null ? 'product' : 'name', name: item.name, quantities: [], orders: 0 };
      if (item.quantity.status === 'unknown') entry.unknownQuantityLines = (entry.unknownQuantityLines ?? 0) + 1;
      else {
        const observed = item.quantity.quantity;
        const existing = entry.quantities.find(value => value.unit === observed.unit);
        const total = Number(((existing?.value ?? 0) + observed.value).toPrecision(15));
        if (!Number.isFinite(total)) return failure('invalid_data', 'Order quantity total is not finite');
        if (existing) existing.value = total; else entry.quantities.push({ ...observed, value: total });
      }
      if (!seen.has(key)) { entry.orders++; seen.add(key); }
      tally.set(key, entry);
    }
  }
  const units = (item: PurchaseFrequency) => item.quantities.find(value => value.unit === 'un')?.value ?? 0;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return success([...tally.values()].sort((a, b) => b.orders - a.orders || units(b) - units(a) ||
    compare(a.productId !== null ? `id:${a.productId}` : `name:${a.name}`, b.productId !== null ? `id:${b.productId}` : `name:${b.name}`)));
}
