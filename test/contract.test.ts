import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

/**
 * The public contract: every tool's name, title, hints, inputs and outputs, and the prompts and
 * resources. Descriptions are left out, since wording is not part of the contract. A change here
 * must be deliberate: run `npm run contract:update` and note it in the changelog.
 */
const SNAPSHOT = new URL('../../test/contract/tools.json', import.meta.url);
const UPDATE = process.argv.includes('--update');

/** Drop description text from a JSON Schema, keeping properties that happen to be called "description". */
function withoutDescriptions(node: unknown, propertyNames = false): unknown {
  if (Array.isArray(node)) return node.map(item => withoutDescriptions(item));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node)
    .filter(([key, value]) => propertyNames || key !== 'description' || typeof value !== 'string')
    .map(([key, value]) => [key, withoutDescriptions(value, !propertyNames && (key === 'properties' || key === 'patternProperties'))]));
}

test('the tool contract matches test/contract/tools.json', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  const tools = (await client.listTools()).tools.map(tool => ({
    name: tool.name, title: tool.title ?? null, annotations: tool.annotations ?? null, _meta: tool._meta ?? null,
    inputSchema: withoutDescriptions(tool.inputSchema), outputSchema: withoutDescriptions(tool.outputSchema ?? null),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const prompts = (await client.listPrompts()).prompts.map(prompt => ({ name: prompt.name, title: prompt.title ?? null,
    arguments: (prompt.arguments ?? []).map(argument => ({ name: argument.name, required: argument.required ?? false })) }));
  const resources = (await client.listResources()).resources.map(resource => ({ uri: resource.uri, name: resource.name, mimeType: resource.mimeType ?? null }));
  const contract = { tools, prompts, resources };
  if (UPDATE) { writeFileSync(SNAPSHOT, JSON.stringify(contract, null, 2) + '\n'); return; }
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8')); } catch { assert.fail('test/contract/tools.json is missing; run `npm run contract:update`.'); }
  // Compare tool by tool so a failure names the tool that changed.
  const before = saved as typeof contract;
  assert.deepEqual(contract.tools.map(tool => tool.name), before.tools.map(tool => tool.name), 'Tools were added, removed or renamed.');
  for (const [index, tool] of contract.tools.entries()) {
    assert.deepEqual(tool, before.tools[index], `The contract of ${tool.name} changed. If this is deliberate, run \`npm run contract:update\` and note it in the changelog.`);
  }
  assert.deepEqual(contract.prompts, before.prompts, 'The prompts changed.');
  assert.deepEqual(contract.resources, before.resources, 'The resources changed.');
});
