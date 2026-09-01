/** MCP server wiring. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "lemma-banking-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const { read, write } = registerTools(server, config);

  if (!config.apiKey) {
    console.error(
      `[${SERVER_NAME}] WARNING: LEMMA_API_KEY is not set. Tools are registered but every call will ` +
        "return a clear 'not set' error. Platform keys are issued manually by Lemma -- email contact@getlemma.com."
    );
  }
  console.error(
    `[${SERVER_NAME}] ${read} read tools + ${write} write tools registered -- ` +
      (config.enableWrites
        ? "WRITES ENABLED (money movement live; every write still requires confirm:true)"
        : "read-only mode (LEMMA_ENABLE_WRITES not set -- the safe default)")
  );
  return server;
}
