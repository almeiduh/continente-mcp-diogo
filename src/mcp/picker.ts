/**
 * The product picker, an MCP Apps view (https://github.com/modelcontextprotocol/ext-apps): clients
 * that support MCP Apps show it under the choose_products call; others use the tool's text. The
 * page speaks the small part of the protocol it needs (initialize, tool result, message, size)
 * itself, so the server ships no browser library.
 */
export const PICKER_URI = 'ui://continentept-mcp/choose-products.html';
export const PICKER_MIME_TYPE = 'text/html;profile=mcp-app';
/** Product photos come from the website's own image service. */
export const PICKER_META = { ui: { csp: { resourceDomains: ['https://www.continente.pt'] }, prefersBorder: true } };

export const PICKER_HTML = String.raw`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>Escolher produtos</title>
<style>
  :root { color-scheme: light dark; --line: #d4d4d4; --accent: #d1171d; --muted: #6b6b6b; --chip: #f1f1f1; }
  @media (prefers-color-scheme: dark) { :root { --line: #444; --muted: #a8a8a8; --chip: #2b2b2b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.35 var(--font-sans, system-ui, -apple-system, sans-serif); color: inherit; background: transparent; }
  main { padding: 12px; }
  section { margin-bottom: 14px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  button.option { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; position: relative; }
  button.option:hover, button.option:focus-visible { border-color: var(--accent); }
  button.option[aria-pressed="true"] { border: 2px solid var(--accent); padding: 7px; }
  button.option[disabled] { cursor: default; opacity: .65; }
  .photo { width: 100%; aspect-ratio: 1; object-fit: contain; background: #fff; border-radius: 6px; }
  .placeholder { display: grid; place-items: center; color: #777; font-size: 12px; }
  .name { font-size: 13px; }
  .meta { font-size: 12px; color: var(--muted); }
  .price { font-weight: 600; }
  .tag { position: absolute; top: 6px; left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 99px; background: var(--accent); color: #fff; }
  .none { all: unset; cursor: pointer; font-size: 12px; color: var(--muted); padding: 4px 0; text-decoration: underline; }
  .none[aria-pressed="true"] { color: var(--accent); font-weight: 600; }
  footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #confirm { cursor: pointer; font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; }
  #confirm[disabled] { opacity: .5; cursor: default; }
  #status { font-size: 13px; color: var(--muted); }
  textarea { width: 100%; min-height: 90px; margin-top: 8px; font: 12px ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <div id="decisions"><p id="loading">…</p></div>
  <footer hidden id="footer"><button id="confirm" type="button"></button><span id="status" role="status"></span></footer>
</main>
<script>
const TEXT = {
  pt: { loading: 'A carregar…', confirm: 'Confirmar escolhas', none: 'Nenhum destes', suggested: 'Sugestão', unavailable: 'indisponível', noPhoto: 'sem foto',
    sending: 'A enviar…', sent: 'Escolhas enviadas.', rejected: 'O cliente não aceitou a mensagem. Copie as escolhas:', pending: n => n + ' por escolher',
    message: 'As minhas escolhas:', chose: 'nenhum destes', perUnit: { kg: '/kg', l: '/l' } },
  en: { loading: 'Loading…', confirm: 'Confirm choices', none: 'None of these', suggested: 'Suggested', unavailable: 'unavailable', noPhoto: 'no photo',
    sending: 'Sending…', sent: 'Choices sent.', rejected: 'The client did not accept the message. Copy your choices:', pending: n => n + ' left to choose',
    message: 'My choices:', chose: 'none of these', perUnit: { kg: '/kg', l: '/l' } },
};
let text = TEXT.pt;
let decisions = [];
const picks = new Map();
const root = document.getElementById('decisions');
const footer = document.getElementById('footer');
const confirmButton = document.getElementById('confirm');
const statusLine = document.getElementById('status');

// MCP Apps bridge: JSON-RPC 2.0 over postMessage with the client.
let nextId = 1;
const waiting = new Map();
const post = message => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); post({ id, method, params }); });
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
  if (message.id !== undefined && message.method === undefined) {
    const handler = waiting.get(message.id); waiting.delete(message.id);
    if (handler) message.error ? handler.reject(message.error) : handler.resolve(message.result);
  } else if (message.method === 'ui/notifications/tool-result') show(message.params);
  else if (message.method === 'ui/notifications/host-context-changed') applyContext(message.params);
  else if (message.id !== undefined) {
    if (message.method === 'ping' || message.method === 'ui/resource-teardown') post({ id: message.id, result: {} });
    else post({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function applyContext(context) {
  if (!context) return;
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) if (value) document.documentElement.style.setProperty(name, value);
  if (context.locale) { text = String(context.locale).toLowerCase().startsWith('pt') ? TEXT.pt : TEXT.en; document.documentElement.lang = text === TEXT.pt ? 'pt' : 'en'; }
}
const euros = minorUnits => (minorUnits / 100).toLocaleString(text === TEXT.pt ? 'pt-PT' : 'en-GB', { style: 'currency', currency: 'EUR' });
const priceText = option => option.price ? euros(option.price.amount.minorUnits) + (option.price.per === 'kg' ? '/kg' : option.price.per === 'l' ? '/l' : option.price.per === 'piece' ? '/un' : '') : '';
const unitText = option => option.unitPrice && option.price?.per === 'item' ? euros(option.unitPrice.amount.minorUnits) + text.perUnit[option.unitPrice.per] : '';

function element(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; }
function show(result) {
  decisions = result?.structuredContent?.result?.data?.decisions ?? [];
  picks.clear();
  root.replaceChildren(...decisions.map((decision, index) => {
    const section = element('section');
    section.append(element('h2', '', (index + 1) + '. ' + decision.question));
    const options = element('div', 'options');
    for (const option of decision.options) {
      const button = element('button', 'option'); button.type = 'button'; button.dataset.productId = option.productId;
      if (option.productId === decision.suggested) button.append(element('span', 'tag', text.suggested));
      if (option.imageUrl) {
        const photo = element('img', 'photo'); photo.src = option.imageUrl; photo.alt = option.name; photo.loading = 'lazy';
        photo.addEventListener('error', () => photo.replaceWith(element('div', 'photo placeholder', text.noPhoto)));
        button.append(photo);
      } else button.append(element('div', 'photo placeholder', text.noPhoto));
      button.append(element('span', 'name', option.name));
      const details = [option.packageText, unitText(option), option.availability === 'unavailable' ? text.unavailable : ''].filter(Boolean).join(' · ');
      if (details) button.append(element('span', 'meta', details));
      button.append(element('span', 'price', priceText(option)));
      button.addEventListener('click', () => choose(index, option.productId));
      options.append(button);
    }
    const none = element('button', 'none', text.none); none.type = 'button'; none.addEventListener('click', () => choose(index, null));
    section.append(options, none);
    return section;
  }));
  decisions.forEach((decision, index) => { if (decision.suggested) choose(index, decision.suggested); });
  confirmButton.textContent = text.confirm;
  footer.hidden = decisions.length === 0;
  refresh();
}
function choose(index, productId) {
  if (confirmButton.dataset.sent) return;
  picks.set(index, productId);
  const section = root.children[index];
  for (const button of section.querySelectorAll('button.option')) button.setAttribute('aria-pressed', String(button.dataset.productId === productId));
  section.querySelector('.none').setAttribute('aria-pressed', String(productId === null));
  refresh();
}
function refresh() {
  const left = decisions.length - picks.size;
  confirmButton.disabled = left > 0 || Boolean(confirmButton.dataset.sent);
  if (!confirmButton.dataset.sent) statusLine.textContent = left > 0 ? text.pending(left) : '';
}
function summary() {
  return [text.message, ...decisions.map((decision, index) => {
    const option = decision.options.find(item => item.productId === picks.get(index));
    return (index + 1) + '. ' + decision.question + ': ' + (option ? option.name + (option.packageText ? ' (' + option.packageText + ')' : '') + ' [' + option.productId + ']' : text.chose);
  })].join('\n');
}
confirmButton.addEventListener('click', async () => {
  confirmButton.dataset.sent = 'true'; confirmButton.disabled = true;
  for (const button of root.querySelectorAll('button')) button.disabled = true;
  statusLine.textContent = text.sending;
  const message = summary();
  try {
    const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text: message }] });
    if (result?.isError) throw new Error('rejected');
    statusLine.textContent = text.sent;
  } catch {
    statusLine.textContent = text.rejected;
    const copy = element('textarea'); copy.value = message; copy.readOnly = true; footer.after(copy);
  }
});

new ResizeObserver(() => post({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(document.documentElement.scrollHeight) } }))
  .observe(document.body);
document.getElementById('loading').textContent = text.loading;
request('ui/initialize', { appInfo: { name: 'continentept-mcp product picker', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
  .then(result => { applyContext(result?.hostContext); document.getElementById('loading').textContent = text.loading; post({ method: 'ui/notifications/initialized' }); })
  .catch(() => { document.getElementById('loading').textContent = text.loading; });
</script>
</body>
</html>
`;
