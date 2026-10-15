import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductIdSchema } from '../src/domain/index.js';
import { parsePackageLabel } from '../src/parsers/package.js';
import { parseProductDetails } from '../src/parsers/product.js';
import { fixture, valueOf } from '../test-support/helpers.js';

const q = (value: number, unit: string) => ({ value, unit });
const pack = (count: number | null, each: object | null, net: object | null, drained: object | null = null, approximate = false) =>
  ({ count, each, net, drained, approximate });
const liveLabels = JSON.parse(readFileSync(new URL('../../test/fixtures/package-labels.json', import.meta.url), 'utf8')) as string[];

test('pack labels become counts and quantities', () => {
  const cases: [string, unknown][] = [
    ['940 gr', pack(1, q(940, 'g'), q(940, 'g'))], ['150gr', pack(1, q(150, 'g'), q(150, 'g'))], ['1 lt', pack(1, q(1, 'l'), q(1, 'l'))],
    ['6 x 1 lt', pack(6, q(1, 'l'), q(6, 'l'))], ['6 x 1,5 lt', pack(6, q(1.5, 'l'), q(9, 'l'))], ['2 x 52 gr', pack(2, q(52, 'g'), q(104, 'g'))],
    ['30 x 25 cl', pack(30, q(250, 'ml'), q(7500, 'ml'))], ['75 cl', pack(1, q(750, 'ml'), q(750, 'ml'))],
    ['400 gr (peso escorrido 260 gr)', pack(1, q(400, 'g'), q(400, 'g'), q(260, 'g'))],
    ['120 gr (peso escorrido: 85 gr)', pack(1, q(120, 'g'), q(120, 'g'), q(85, 'g'))],
    ['1,2 kg (aprox.)', pack(1, q(1.2, 'kg'), q(1.2, 'kg'), null, true)], ['1000 gr (8 un)', pack(8, null, q(1000, 'g'))],
    ['12 un', pack(12, null, null)], ['12 rolos', pack(12, null, null)], ['6 rolos = 12 rolos', pack(6, null, null)],
    ['432 un (9 x 48 un)', pack(432, null, null)], ['46 doses', pack(46, null, null)], ['1 un (grande)', pack(1, null, null)],
    ['120 gr + 30 gr GRÁTIS', pack(1, q(150, 'g'), q(150, 'g'))], ['500 gr + 10% GRÁTIS', pack(1, q(550, 'g'), q(550, 'g'))],
    ['93 un + 7 un GRÁTIS', pack(100, null, null)], ['220 gr (4 un + 1 un GRÁTIS)', pack(5, null, q(220, 'g'))],
  ];
  for (const [label, expected] of cases) assert.deepEqual(parsePackageLabel(label), expected, label);
});

test('every pack label seen on the live website is recognised', () => {
  assert.ok(liveLabels.length > 100);
  for (const label of liveLabels) assert.notEqual(parsePackageLabel(label), null, label);
});

test('a label with any unrecognised part gives no pack details', () => {
  for (const label of [null, '', '?', '6 x lt', '1,5 x 2 lt', '10 metros', '500 gr (oferta)', '120 gr + 30 ml GRÁTIS',
    '2 x 52 gr + 10% GRÁTIS', '0 un', '12 un + 5 gr GRÁTIS']) assert.equal(parsePackageLabel(label), null, String(label));
});

test('product pages report their own pack label, never a recommendation tile\'s', () => {
  const url = 'https://www.continente.pt/produto/leite-00123.html'; const id = ProductIdSchema.parse('00123');
  const product = valueOf(parseProductDetails(fixture('product'), url, id));
  assert.equal(product.packageText, '6 x 1 lt'); assert.equal(product.minimumText, null);
  assert.deepEqual(product.package, pack(6, q(1, 'l'), q(6, 'l')));
  const weighted = valueOf(parseProductDetails(fixture('product').replace('emb. 6 x 1 lt', 'Quant. Mínima = 600 gr (3 un)'), url, id));
  assert.deepEqual([weighted.packageText, weighted.package, weighted.minimumText], [null, null, '600 gr (3 un)']);
  const twice = valueOf(parseProductDetails(fixture('product') + '<span class="ct-pdp--unit">emb. 1 lt</span>', url, id));
  assert.deepEqual([twice.packageText, twice.package], [null, null]);
});
