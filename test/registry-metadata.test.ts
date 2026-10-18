import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { present } from '../test-support/helpers.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const pkg = z.object({ name: z.string(), mcpName: z.string() }).parse(read('package.json'));
const server = z.object({
  name: z.string(), description: z.string(),
  packages: z.array(z.object({ registryType: z.string(), identifier: z.string(), environmentVariables: z.array(z.object({ name: z.string() })).optional() })),
}).parse(read('server.json'));
const configuration = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');

test('MCP Registry metadata matches the npm package', () => {
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.andredelgado\//);
  assert.ok(server.description.length <= 100, 'the registry limits descriptions to 100 characters');
  const npm = server.packages.find(entry => entry.registryType === 'npm');
  assert.equal(npm?.identifier, pkg.name);
  for (const variable of npm?.environmentVariables ?? []) assert.ok(configuration.includes(variable.name), `${variable.name} is not documented`);
});

test('the listed extension points at the release asset the workflow uploads', () => {
  const extension = server.packages.find(entry => entry.registryType === 'mcpb');
  assert.match(present(extension).identifier, /^https:\/\/github\.com\/andredelgado\/continente-mcp\/releases\/download\/v[^/]+\/continente-mcp\.mcpb$/);
});

test('server.json names one release throughout: its version, the npm package and the extension', () => {
  const listing = z.object({ version: z.string(), packages: z.array(z.object({ registryType: z.string(), identifier: z.string(), version: z.string().optional(), fileSha256: z.string().optional() })) })
    .parse(read('server.json'));
  const npm = present(listing.packages.find(entry => entry.registryType === 'npm'));
  const extension = present(listing.packages.find(entry => entry.registryType === 'mcpb'));
  assert.equal(npm.version, listing.version);
  assert.ok(extension.identifier.includes(`/download/v${listing.version}/`), 'the extension URL is for another release');
  assert.match(extension.fileSha256 ?? '', /^[0-9a-f]{64}$/);
});
