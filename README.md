# lemma-banking-mcp

_Part of [PracticeOS](https://privatepracticeos.app) — the operating layer for therapy practice owners, by Private Practice Collective._

Live MCP server for the **Lemma healthcare banking API** (`https://api.getlemma.com/v0`).
TypeScript, stdio transport, same pattern as `stedi-mcp-server` / `medallion-mcp-server`.
Built 2026-09-01 against Lemma's published OpenAPI spec (`getlemma.com/docs/openapi.json`).

## ⚠️ Blocker before any live call: no API key yet

Lemma **platform** API keys are issued manually by the Lemma team — this is not a
key you can generate in the dashboard. **Email contact@getlemma.com to request one.**
Until then the server runs fine (all 27 tools register) and every call returns a
clear `LEMMA_API_KEY not set` error instead of crashing. The offline smoke suite
(`npm run smoke`) proves the full behavior against a mocked API.

## Safety model — this API moves real money

- **Read-only by default.** The 22 read tools work with just an API key.
- The 5 write tools (`lemma_create_external_account`, `lemma_move_money_externally`,
  `lemma_move_money_internally`, `lemma_create_card`, `lemma_delete_card`) are
  registered but **blocked** unless `LEMMA_ENABLE_WRITES=true` is set in the env
  block, **and** each call passes `confirm: true` (stedi-mcp-server precedent).
- Even fully enabled, every write tool's description tells the calling agent it
  moves real money / creates a real financial instrument — the MCP being callable
  does **not** waive Claude's explicit-permission rule for financial actions.
- Every POST carries a mandatory `Idempotency-Key` (10–256 chars, `[A-Za-z0-9-_:]`),
  derived **deterministically** from the caller's `reference` param — same reference
  → same key, so retries replay instead of double-paying. The HTTP layer never
  auto-retries POSTs; only GETs back off on 429 (500 req/min limit).
- Amounts: wire format is integer **cents**; tools accept `amount_dollars` and
  convert internally (sub-cent precision rejected). Responses annotate cent fields
  with `*_dollars` siblings.
- Saved recipients are **immutable** — no update API; archiving is email-only
  (contact@getlemma.com), which the tool description states rather than attempts.

## Build / test

```bash
npm install
npm run build        # tsc → build/index.js
npm run smoke        # offline: mock API, 14 assertions, no key needed
```

## Claude Desktop registration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` under
`mcpServers` (placeholders — paste real values only into the config, never here;
use the absolute node path since GUI apps don't inherit shell PATH):

```json
"lemma-banking-mcp": {
  "command": "/Users/zackscriven/.nvm/versions/node/v25.9.0/bin/node",
  "args": ["/Volumes/Extreme SSD/MCP_Servers/lemma-banking-mcp/build/index.js"],
  "env": {
    "LEMMA_API_KEY": "<platform key from the Lemma team — not issued yet>",
    "LEMMA_ENABLE_WRITES": ""
  }
}
```

Leave `LEMMA_ENABLE_WRITES` empty/absent for read-only. Set it to `"true"` only
deliberately, when money movement is intended.

Env vars: `LEMMA_API_KEY` (or `HD_LEMMA_API_KEY`), `LEMMA_ENABLE_WRITES`,
`LEMMA_BASE_URL` (default `https://api.getlemma.com/v0`), `LEMMA_TIMEOUT_MS` (30000).

## Scope notes (v1)

- **Not included:** webhooks (Lemma calling us — needs a running HTTP receiver,
  separate project), the forthcoming TypeScript SDK (unreleased), and
  invoicing / lockbox EOB parsing / team management / approval rules (dashboard-only,
  no documented API endpoints yet).
- `lemma_list_entities`' `npi` filter is client-side (the API has no npi query param).
- `lemma_get_card_iframe` is flagged sensitive — it returns a short-lived URL that
  renders the full PAN/CVV.
- Docs lookups: use the separate read-only `lemma_docs_mcp` server; its corpus is
  the marketing/guides subset, while this server was built from the live OpenAPI spec.
