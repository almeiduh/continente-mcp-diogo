import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpdateStatus } from '../domain/index.js';
import { writePrivateJson } from '../stores/files.js';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASES_URL = 'https://github.com/andredelgado/continente-mcp/releases/latest';
const CacheSchema = z.object({ checkedAt: z.iso.datetime({ offset: true }), latestVersion: z.string() });

export interface UpdateCheckOptions {
  readonly currentVersion: string;
  readonly packageName: string;
  readonly dataDir: string;
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly fetchLatest?: (packageName: string, signal: AbortSignal) => Promise<string>;
}

const stableParts = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number) ?? null;

/** True when `candidate` is a later stable release than `current`. Prereleases never count. */
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = stableParts(candidate); const now = stableParts(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== now[index]) return (next[index] ?? 0) > (now[index] ?? 0);
  }
  return false;
}

async function registryLatest(packageName: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  return z.object({ version: z.string() }).parse(await response.json()).version;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timed out')); }, timeoutMs); });
  try { return await Promise.race([operation(controller.signal), timeout]); } finally { clearTimeout(timer); }
}

/**
 * Look up the latest published version at most once a day. Never throws: when offline or
 * disabled it reports no update, reusing the last known answer when there is one.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateStatus> {
  const unknown: UpdateStatus = { currentVersion: options.currentVersion, latestVersion: null, available: false };
  if (options.enabled === false) return unknown;
  const file = join(options.dataDir, 'update-check.json');
  const now = (options.now ?? (() => new Date()))();
  let cached: z.infer<typeof CacheSchema> | null = null;
  try { cached = CacheSchema.parse(JSON.parse(await readFile(file, 'utf8'))); } catch { /* no usable cache */ }
  // An answer older than the running version predates an upgrade, so it is checked again.
  const outdated = cached !== null && isNewerRelease(options.currentVersion, cached.latestVersion);
  let latest = cached && !outdated ? cached.latestVersion : null;
  const age = cached ? now.getTime() - Date.parse(cached.checkedAt) : Infinity;
  if (outdated || !(age >= 0 && age < UPDATE_CHECK_INTERVAL_MS)) {
    try {
      latest = await withTimeout(signal => (options.fetchLatest ?? registryLatest)(options.packageName, signal), options.timeoutMs ?? 1500);
      await writePrivateJson(file, { checkedAt: now.toISOString(), latestVersion: latest }).catch(() => {});
    } catch { /* offline or slow: keep the last known answer */ }
  }
  if (latest !== null && isNewerRelease(options.currentVersion, latest)) latest = null;
  return { currentVersion: options.currentVersion, latestVersion: latest, available: latest !== null && isNewerRelease(latest, options.currentVersion) };
}

/** A line for the assistant's instructions, or null when there is nothing to say. */
export function updateNotice(status: UpdateStatus): string | null {
  if (!status.available || !status.latestVersion) return null;
  return `Update available: continentept-mcp ${status.latestVersion} is out (this is ${status.currentVersion}). Mention it to the user once. `
    + `Claude Desktop extension users download continente-mcp.mcpb from ${RELEASES_URL} and open it; npx users restart their client.`;
}
