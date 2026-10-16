import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductIdSchema } from '../src/domain/index.js';
import { parseProductSearchPage } from '../src/parsers/catalog.js';
import { parseProductDetails } from '../src/parsers/product.js';
import { ChooseProductsData } from '../src/mcp/contracts.js';
import { PICKER_URI } from '../src/mcp/picker.js';
import { fixture, valueOf } from '../test-support/helpers.js';
import { dataOf, statusOf, textOf } from '../test-support/assertions.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

const PHOTO = 'https://www.continente.pt/dw/image/v2/BDVS_PRD/on/demandware.static/-/Sites-col-master-catalog/default/dw1/images/col/001/00123-cima.jpg?sw=280&sh=280';
const BADGE = 'https://www.continente.pt/dw/image/v2/BDVS_PRD/on/demandware.static/-/Sites-continente-Library/default/dw2/images/badges/pvpr.png';

test('search tiles and product pages give the product photo, never a badge or another site\'s image', () => {
  const tile = (images: string) => valueOf(parseProductSearchPage(`<main><div class="ct-inner-tile-wrap"><a href="/produto/leite-00123.html">Leite</a>${images}</div></main>`)).products[0]?.imageUrl;
  assert.equal(tile(`<img data-src="${BADGE}"><img data-src="${PHOTO}">`), PHOTO);
  assert.equal(tile(`<img src="${PHOTO}">`), PHOTO);
  assert.equal(tile(`<img data-src="https://other.invalid/Sites-col-master-catalog/images/x.jpg">`), null);
  assert.equal(tile(''), null);
  const page = fixture('product').replace('"sku":"00123"', `"sku":"00123","image":["${PHOTO}"]`);
  const url = 'https://www.continente.pt/produto/leite-00123.html';
  assert.equal(valueOf(parseProductDetails(page, url, ProductIdSchema.parse('00123'))).imageUrl, PHOTO);
  assert.equal(valueOf(parseProductDetails(fixture('product'), url, ProductIdSchema.parse('00123'))).imageUrl, null);
});

test('choose_products shows products already seen without reading them again, and reports the rest', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  await client.callTool({ name: 'search_products', arguments: { query: 'milk' } });
  const reads = state.reads;
  const result = await client.callTool({ name: 'choose_products', arguments: { decisions: [
    { question: 'Leite', productIds: ['00123', '456'], suggested: '456' },
    { question: 'Fruta', productIds: ['789', '456'], suggested: '999' }] } });
  assert.equal(state.reads, reads);
  const data = dataOf(result, ChooseProductsData);
  assert.deepEqual(data.decisions.map(decision => [decision.question, decision.suggested, decision.options.map(option => option.productId)]),
    [['Leite', '456', ['00123', '456']], ['Fruta', null, ['789', '456']]]);
  assert.equal(statusOf(result), 'success');
  const text = textOf(result);
  assert.match(text, /^Choices for the user/);
  assert.match(text, /1\. Leite — suggested: Banana Madeira \[456\]\n   a\) Leite Meio Gordo — €1\.29, pack 1 lt \(€1\.29\/l\), available \[00123\]\n   b\) Banana Madeira — €1\.19\/kg, unavailable \[456\]/);
  assert.match(text, /set_cart_item_quantity\.$/);
  // An unseen product is read from its page; one the website does not show is reported, not guessed.
  const missing = await client.callTool({ name: 'choose_products', arguments: { decisions: [{ question: 'Leite', productIds: ['00123', '999'] }] } });
  assert.equal(statusOf(missing), 'partial');
  assert.deepEqual(dataOf(missing, ChooseProductsData).decisions[0]?.failures.map(failure => failure.productId), ['999']);
  assert.equal(state.reads, reads + 1);
});

test('choose_products is limited to 10 choices of 2 to 4 candidates', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  const decision = { question: 'Leite', productIds: ['00123', '456'] };
  for (const decisions of [[], Array.from({ length: 11 }, () => decision), [{ ...decision, productIds: ['00123'] }], [{ ...decision, productIds: ['1', '2', '3', '4', '5'] }], [{ ...decision, question: '' }]]) {
    await assert.rejects(client.callTool({ name: 'choose_products', arguments: { decisions } }), { code: -32602 });
  }
});

test('the picker is linked from choose_products and served as an MCP Apps view allowed to load the website\'s photos', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  const tool = (await client.listTools()).tools.find(item => item.name === 'choose_products');
  assert.deepEqual(tool?._meta, { ui: { resourceUri: PICKER_URI }, 'ui/resourceUri': PICKER_URI });
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const listed = (await client.listResources()).resources;
  assert.deepEqual(listed.map(resource => [resource.uri, resource.mimeType]), [[PICKER_URI, 'text/html;profile=mcp-app']]);
  const content = (await client.readResource({ uri: PICKER_URI })).contents[0] as { mimeType: string; text: string; _meta: unknown };
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(content._meta, { ui: { csp: { resourceDomains: ['https://www.continente.pt'] }, prefersBorder: true } });
  assert.match(content.text, /ui\/initialize/); assert.match(content.text, /ui\/message/);
  assert.doesNotMatch(content.text, /<script[^>]+src=/);
});
