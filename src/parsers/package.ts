import { PackageSchema } from '../domain/index.js';
import type { Package, Quantity } from '../domain/index.js';

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const MEASURES: Record<string, { unit: Quantity['unit']; factor: number }> = {
  g: { unit: 'g', factor: 1 }, gr: { unit: 'g', factor: 1 }, kg: { unit: 'kg', factor: 1 },
  l: { unit: 'l', factor: 1 }, lt: { unit: 'l', factor: 1 }, ml: { unit: 'ml', factor: 1 }, cl: { unit: 'ml', factor: 10 },
};
const COUNTED = '(?:un|rolos?|doses?|caps)';
const tidy = (value: number) => Number(value.toPrecision(12));
const number = (text: string) => Number(text.replace(',', '.'));
function measure(value: string, unit: string): Quantity | null {
  const known = MEASURES[unit];
  return known ? { value: tidy(number(value) * known.factor), unit: known.unit } : null;
}
const times = (quantity: Quantity, factor: number): Quantity => ({ value: tidy(quantity.value * factor), unit: quantity.unit });

/**
 * Structured pack details from a label such as `6 x 1 lt`, `400 gr (peso escorrido 260 gr)`,
 * `1,2 kg (aprox.)`, `12 rolos` or `120 gr + 30 gr GRÁTIS`. A label with any part that does not
 * match a known pattern gives null rather than a partial guess.
 */
export function parsePackageLabel(label: string | null): Package | null {
  if (!label) return null;
  const text = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = new RegExp(String.raw`^(.*?)(?: \((.*)\))?(?: ?\+ ?${NUMBER} ?(%|[a-z]+) grátis)?$`).exec(text);
  if (!parts) return null;
  const [, main = '', note, freeValue, freeUnit] = parts;
  let pack: Package;
  const multipack = new RegExp(String.raw`^${NUMBER} ?x ?${NUMBER} ?([a-z]+)$`).exec(main);
  const single = new RegExp(String.raw`^${NUMBER} ?([a-z]+)$`).exec(main);
  const counted = new RegExp(String.raw`^(\d+) ?${COUNTED}(?: ?= ?\d+ ?${COUNTED})?$`).exec(main);
  if (multipack && Number.isInteger(number(multipack[1]!))) {
    const each = measure(multipack[2]!, multipack[3]!);
    if (!each) return null;
    const count = number(multipack[1]!);
    pack = { count, each, net: times(each, count), drained: null, approximate: false };
  } else if (counted) {
    pack = { count: Number(counted[1]), each: null, net: null, drained: null, approximate: false };
  } else if (single) {
    const net = measure(single[1]!, single[2]!);
    if (!net) return null;
    pack = { count: 1, each: net, net, drained: null, approximate: false };
  } else return null;

  if (note !== undefined) {
    const drained = new RegExp(String.raw`^peso escorrido:? ${NUMBER} ?([a-z]+)$`).exec(note);
    const pieces = new RegExp(String.raw`^(\d+) un(?: ?\+ ?(\d+) un grátis)?$`).exec(note);
    if (note === 'aprox.') pack.approximate = true;
    else if (/^aprox\. \d+ (?:fatias|un)$/.test(note)) pack.approximate = true;
    else if (drained) { pack.drained = measure(drained[1]!, drained[2]!); if (!pack.drained) return null; }
    else if (pieces && pack.net && pack.count === 1) {
      // "1000 gr (8 un)": eight pieces weighing 1000 gr together.
      pack.count = Number(pieces[1]) + Number(pieces[2] ?? 0); pack.each = null;
    } else if (/^\d+ x \d+ un$/.test(note) && pack.each === null) { /* "432 un (9 x 48 un)": the count is already the total. */ }
    else if (!/^(?:grande|médio|pequeno)$/.test(note)) return null;
  }

  if (freeValue !== undefined) {
    if (freeUnit === '%') {
      if (!pack.net || pack.count !== 1) return null;
      pack.net = times(pack.net, 1 + number(freeValue) / 100); pack.each = pack.net;
    } else if (freeUnit === 'un' && pack.net === null && pack.count !== null) {
      pack.count += number(freeValue);
    } else {
      const free = measure(freeValue, freeUnit!);
      if (!free || !pack.net || free.unit !== pack.net.unit || pack.count !== 1) return null;
      pack.net = { value: tidy(pack.net.value + free.value), unit: pack.net.unit }; pack.each = pack.net;
    }
  }
  const valid = PackageSchema.safeParse(pack);
  return valid.success ? valid.data : null;
}
