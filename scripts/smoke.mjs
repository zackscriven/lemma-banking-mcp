#!/usr/bin/env node
/**
 * Offline smoke test -- no Lemma key needed, no live calls.
 * Spins up a local mock of the Lemma API, launches the built server over
 * stdio pointed at the mock, and verifies:
 *   1. tools/list returns the full read + write surface
 *   2. a read tool round-trips (cents -> *_dollars annotation, Bearer auth header)
 *   3. write tools are BLOCKED without LEMMA_ENABLE_WRITES
 *   4. with writes enabled, confirm:true is still required
 *   5. a confirmed write sends a valid deterministic Idempotency-Key + dollars->cents
 *   6. with no API key at all, tools error clearly instead of crashing
 */
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const seen = { requests: [] };
const mock = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers["authorization"],
      idem: req.headers["idempotency-key"],
      ct: req.headers["content-type"],
      body: body ? JSON.parse(body) : null,
    });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v0/accounts") && req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "account_1", entity_id: "entity_1", name: "Operating", account_number: "123", routing_number: "021", total_balance: 1234567, available_balance: 1200000, opened_at: "2026-01-01" }], has_next: false, cursor: null }));
    } else if (req.url === "/v0/ach-transfer" && req.method === "POST") {
      if (!req.headers["idempotency-key"]) { res.statusCode = 400; res.end(JSON.stringify({ statusCode: 400, error: "Bad Request", message: "Idempotency-Key required" })); return; }
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "ach_1", account_id: "account_1", amount: -125050, status: "pending", statement_descriptor: "TEST" }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
});

function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok: ${label}`);
}

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}/v0`;

// --- read-only client (default gate) ---
let c = await connect({ LEMMA_API_KEY: "test_key_abc", LEMMA_BASE_URL: base, LEMMA_ENABLE_WRITES: "" });
const tools = (await c.listTools()).tools.map((t) => t.name);
assert(tools.length === 27, `27 tools registered (got ${tools.length})`);
assert(tools.includes("lemma_list_entities") && tools.includes("lemma_move_money_externally"), "read + write tools present");

let r = await c.callTool({ name: "lemma_list_bank_accounts", arguments: { entity_id: "entity_1" } });
const parsed = JSON.parse(r.content[0].text);
assert(!r.isError && parsed.data[0].total_balance_dollars === 12345.67, "read tool works; cents annotated as dollars");
assert(seen.requests.at(-1).auth === "Bearer test_key_abc", "Bearer auth header sent");

r = await c.callTool({ name: "lemma_move_money_externally", arguments: { source_account_id: "a", destination_account_id: "b", amount_dollars: 10, reference: "inv-1", confirm: true } });
assert(r.isError && /LEMMA_ENABLE_WRITES/.test(r.content[0].text), "write blocked without LEMMA_ENABLE_WRITES");
assert(!seen.requests.some((q) => q.method === "POST"), "no POST ever reached the API while gated");
await c.close();

// --- writes-enabled client ---
c = await connect({ LEMMA_API_KEY: "test_key_abc", LEMMA_BASE_URL: base, LEMMA_ENABLE_WRITES: "true" });
r = await c.callTool({ name: "lemma_move_money_externally", arguments: { source_account_id: "a", destination_account_id: "b", amount_dollars: 10, reference: "inv-1" } });
assert(r.isError && /confirm/.test(r.content[0].text), "write blocked without confirm:true even when enabled");

r = await c.callTool({ name: "lemma_move_money_externally", arguments: { source_account_id: "account_1", destination_account_id: "ext_1", amount_dollars: 1250.5, reference: "invoice 42/august", confirm: true } });
const post = seen.requests.find((q) => q.method === "POST");
assert(!r.isError && post, "confirmed write executed");
assert(post.body.amount === 125050, `dollars converted to cents (got ${post?.body?.amount})`);
assert(/^[A-Za-z0-9\-_:]{10,256}$/.test(post.idem), `Idempotency-Key valid charset/length (${post.idem})`);
assert(post.ct === "application/json", "Content-Type application/json on POST");

// determinism: same reference -> same key
r = await c.callTool({ name: "lemma_move_money_externally", arguments: { source_account_id: "account_1", destination_account_id: "ext_1", amount_dollars: 1250.5, reference: "invoice 42/august", confirm: true } });
const posts = seen.requests.filter((q) => q.method === "POST");
assert(posts.length === 2 && posts[0].idem === posts[1].idem, "idempotency key deterministic across retries");

r = await c.callTool({ name: "lemma_move_money_internally", arguments: { source_account_id: "a", destination_account_id: "b", amount_dollars: 0.005, reference: "tiny-amount-1", confirm: true } });
assert(r.isError && /sub-cent|greater than zero/.test(r.content[0].text), "sub-cent / zero amounts rejected client-side");
await c.close();

// --- no API key ---
c = await connect({ LEMMA_API_KEY: "", HD_LEMMA_API_KEY: "", LEMMA_BASE_URL: base });
r = await c.callTool({ name: "lemma_list_entities", arguments: {} });
assert(r.isError && /LEMMA_API_KEY not set/.test(r.content[0].text) && /contact@getlemma.com/.test(r.content[0].text), "clear error when LEMMA_API_KEY missing (no crash)");
await c.close();

mock.close();
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
