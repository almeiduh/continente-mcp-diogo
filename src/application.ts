import { ContinenteMcpServer } from './mcp/server.js';
import type { PromptHandler, ResourceHandler, ToolHandler } from './mcp/server.js';

export interface ApplicationOptions {
  readonly version: string;
  readonly tools?: readonly ToolHandler[];
  readonly prompts?: readonly PromptHandler[];
  readonly resources?: readonly ResourceHandler[];
  readonly instructions?: string;
  readonly closeResources?: () => Promise<void>;
  readonly requestTimeoutMs?: number;
}

/** Create an MCP server from tool handlers. Importing the library performs no configuration or I/O. */
export function createApplication(options: ApplicationOptions): ContinenteMcpServer {
  return new ContinenteMcpServer({ ...options, tools: options.tools ?? [] });
}
