import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('../test/', import.meta.url);
const browser = process.argv.includes('--browser');
const files = readdirSync(directory).filter(name => name.endsWith('.test.js') &&
  (!browser || ['browser-local.test.js', 'local-extraction.test.js', 'picker-browser.test.js'].includes(name)))
  .sort().map(name => fileURLToPath(new URL(name, directory)));
if (files.length === 0) throw new Error('Compile the test suite before running it.');
const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...files], {
  stdio: 'inherit',
  env: { ...process.env, ...(browser ? { CONTINENTE_LOCAL_BROWSER_TEST: '1' } : {}) },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
