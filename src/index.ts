#!/usr/bin/env node
/**
 * Entry point -- stdio transport (local server).
 *
 * Env:
 *   LEMMA_API_KEY        Lemma *platform* API key (issued by the Lemma team,
 *                        contact@getlemma.com). Required for live calls;
 *                        server starts without it and errors clearly per call.
 *   LEMMA_ENABLE_WRITES  "true" to allow money-movement/write tools
 *                        (default: read-only).
 *   LEMMA_BASE_URL       Override for testing (default https://api.getlemma.com/v0).
 *   LEMMA_TIMEOUT_MS     Request timeout (default 30000).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME } from "./server.js";

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] running on stdio`);
}

main().catch((e) => {
  console.error(`[lemma-banking-mcp] fatal:`, e);
  process.exit(1);
});
