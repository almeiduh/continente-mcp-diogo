import { z } from 'zod';
import { invalidData } from './errors.js';
import type { ToolError } from './errors.js';
import type { Result } from './result.js';

export const MoneySchema = z.strictObject({
  currency: z.literal('EUR'),
  minorUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type Money = z.infer<typeof MoneySchema>;

/** Convert decimal text through integer arithmetic; never round an unrecognized precision. */
export function parseMoneyAmount(input: unknown): Result<Money | null, ToolError> {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  if (typeof input !== 'number' && typeof input !== 'string') {
    return { ok: false, error: invalidData('money amount') };
  }
  const text = String(input).trim();
  if (text.length > 100) return { ok: false, error: invalidData('money amount') };
  const match = text.match(/^(\d+)(?:[.,](\d{1,2}))?\s*€?$/);
  if (!match?.[1]) return { ok: false, error: invalidData('money amount') };
  const minorUnits = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: invalidData('money amount') };
  }
  return { ok: true, value: { currency: 'EUR', minorUnits: Number(minorUnits) } };
}

/**
 * What a displayed price is for. The storefront shows packaged goods per `item` (one pack or
 * article), produce and meat per `kg`, drinks per `l`, and an approximate price per `piece`.
 */
export const PriceTagSchema = z.strictObject({
  amount: MoneySchema,
  per: z.enum(['item', 'piece', 'kg', 'l']),
});
export type PriceTag = z.infer<typeof PriceTagSchema>;

const PRICE_UNITS: Readonly<Record<string, PriceTag['per']>> = { kg: 'kg', l: 'l', lt: 'l', un: 'piece' };

/** Parse labels such as `1,29€`, `1,19€/kg` or `0,24€/un`. An empty label is an unknown price. */
export function parsePriceTag(input: unknown): Result<PriceTag | null, ToolError> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: invalidData('price') };
  const text = input.replace(/\s+/g, '');
  if (!text) return { ok: true, value: null };
  const match = /^(\d+(?:[.,]\d{1,2})?)€(?:\/([a-z]+))?$/i.exec(text);
  const per = match ? PRICE_UNITS[(match[2] ?? '').toLowerCase()] ?? (match[2] === undefined ? 'item' : undefined) : undefined;
  const amount = match && per ? parseMoneyAmount(match[1]) : null;
  if (!amount?.ok || !amount.value || !per) return { ok: false, error: { ...invalidData('price'), message: 'Unrecognised price format' } };
  return { ok: true, value: { amount: amount.value, per } };
}
