import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { PICKER_HTML } from '../src/mcp/picker.js';

const decisions = [
  { question: 'Leite meio gordo', suggested: '8504295', failures: [], options: [
    { productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa', packageText: '6 x 1 lt', price: { amount: { currency: 'EUR', minorUnits: 534 }, per: 'item' },
      unitPrice: { amount: { currency: 'EUR', minorUnits: 89 }, per: 'l', basis: 'pack' }, availability: 'available', imageUrl: null },
    { productId: '8504295', name: 'Leite UHT Meio Gordo Continente', packageText: '6 x 1 lt', price: { amount: { currency: 'EUR', minorUnits: 510 }, per: 'item' },
      unitPrice: null, availability: 'available', imageUrl: null }] },
  { question: 'Manteiga de amendoim', suggested: null, failures: [], options: [
    { productId: '8167238', name: 'Manteiga de Amendoim Continente', packageText: '500 gr', price: { amount: { currency: 'EUR', minorUnits: 249 }, per: 'item' },
      unitPrice: null, availability: 'available', imageUrl: null },
    { productId: '6403609', name: 'Manteiga de Amendoim Prozis', packageText: '1 kg', price: { amount: { currency: 'EUR', minorUnits: 799 }, per: 'item' },
      unitPrice: null, availability: 'unavailable', imageUrl: null }] },
];

/** A host page that speaks the MCP Apps protocol to the picker in an iframe and records what it sends. */
const host = (locale: string, acceptMessage: boolean) => `<!DOCTYPE html><html><body><iframe id="view" style="width:700px;height:900px"></iframe><script>
  window.received = [];
  const view = document.getElementById('view');
  const result = { content: [{ type: 'text', text: 'choices' }], structuredContent: { result: { status: 'success', data: { decisions: ${JSON.stringify(decisions)} } } } };
  window.addEventListener('message', event => {
    const message = event.data; if (!message || message.jsonrpc !== '2.0') return;
    window.received.push(message);
    const reply = body => view.contentWindow.postMessage(Object.assign({ jsonrpc: '2.0', id: message.id }, body), '*');
    if (message.method === 'ui/initialize') reply({ result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test', version: '1' }, hostCapabilities: {}, hostContext: { theme: 'light', locale: '${locale}' } } });
    if (message.method === 'ui/notifications/initialized') view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
    if (message.method === 'ui/message') reply(${acceptMessage} ? { result: {} } : { result: { isError: true } });
  });
  view.srcdoc = ${JSON.stringify(PICKER_HTML).replace(/<\//g, '<\\/')};
</script></body></html>`;

test('the picker shows every choice, preselects suggestions and sends all choices in one message', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(host('en-GB', true));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    assert.deepEqual(await view.locator('h2').allTextContents(), ['1. Leite meio gordo', '2. Manteiga de amendoim']);
    // The suggestion starts selected; the second choice is still open, so confirming waits.
    assert.equal(await view.locator('section').nth(0).locator('button.option[aria-pressed="true"] .name').textContent(), 'Leite UHT Meio Gordo Continente');
    assert.equal(await view.locator('#confirm').isDisabled(), true);
    assert.equal(await view.locator('#status').textContent(), '1 left to choose');
    assert.match(await view.locator('section').nth(0).locator('button.option').nth(0).locator('.meta').textContent() ?? '', /6 x 1 lt · €0\.89\/l/);
    assert.match(await view.locator('section').nth(1).locator('button.option').nth(1).locator('.meta').textContent() ?? '', /unavailable/);
    await view.locator('section').nth(0).locator('button.option').nth(0).click();
    await view.locator('section').nth(1).locator('button.option').nth(1).click();
    await view.locator('#confirm').click();
    await view.locator('#status', { hasText: 'Choices sent.' }).waitFor();
    const messages = await page.evaluate(() => (window as unknown as { received: { method?: string; params?: { content?: { text: string }[] } }[] }).received);
    const sent = messages.filter(message => message.method === 'ui/message');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.params?.content?.[0]?.text, 'My choices:\n1. Leite meio gordo: Leite UHT Meio Gordo Mimosa (6 x 1 lt) [4421406]\n2. Manteiga de amendoim: Manteiga de Amendoim Prozis (1 kg) [6403609]');
    assert.ok(messages.some(message => message.method === 'ui/notifications/size-changed'));
    assert.equal(await view.locator('button.option').first().isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the picker speaks Portuguese for a Portuguese client, allows "none of these" and shows the choices when a message is refused', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(host('pt-PT', false));
    const view = page.frameLocator('#view');
    await view.locator('section').nth(1).waitFor();
    assert.equal(await view.locator('#confirm').textContent(), 'Confirmar escolhas');
    await view.locator('section').nth(1).locator('.none').click();
    await view.locator('#confirm').click();
    await view.locator('textarea').waitFor();
    assert.equal(await view.locator('textarea').inputValue(), 'As minhas escolhas:\n1. Leite meio gordo: Leite UHT Meio Gordo Continente (6 x 1 lt) [8504295]\n2. Manteiga de amendoim: nenhum destes');
  } finally { await browser.close(); }
});
