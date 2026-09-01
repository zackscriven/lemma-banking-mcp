/**
 * Tool registration -- the whole Lemma v0 API surface as of 2026-09-01
 * (per https://getlemma.com/docs/openapi.json, fetched at build time).
 *
 * Read tools are always available. Write tools (anything that moves money
 * or creates/cancels a financial instrument) are registered but BLOCKED
 * unless BOTH:
 *   1. LEMMA_ENABLE_WRITES=true is set in the environment, AND
 *   2. the call passes confirm: true.
 * This mirrors stedi-mcp-server's gate. Even then, the calling agent must
 * treat these as explicit-user-confirmation actions -- being callable does
 * not waive that.
 */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import {
  annotateDollars,
  callLemma,
  dollarsToCents,
  explainError,
  makeIdempotencyKey,
  LemmaError,
} from "./http.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (payload: unknown, note?: string): ToolResult => ({
  content: [
    {
      type: "text",
      text: (note ? `NOTE: ${note}\n` : "") + JSON.stringify(annotateDollars(payload), null, 2),
    },
  ],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const page = {
  limit: z.number().int().min(1).max(100).optional().describe("Max items per page (1-100)"),
  cursor: z.string().optional().describe("Opaque cursor from the previous page's `cursor` field"),
};

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e instanceof LemmaError ? e.message : `Unexpected error: ${String(e)}`);
  }
}

export function registerTools(server: McpServer, config: Config): { read: number; write: number } {
  let read = 0;
  let write = 0;

  const readTool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>
  ) => {
    server.tool(name, description, shape, (args: Record<string, unknown>) => run(() => handler(args)));
    read++;
  };

  const gate = (toolName: string, confirm: unknown): ToolResult | null => {
    if (!config.enableWrites) {
      return fail(
        `${toolName} is a WRITE operation on a live banking system and LEMMA_ENABLE_WRITES is not set. ` +
          "This server is running read-only (the safe default). To enable money-movement tools, set " +
          "LEMMA_ENABLE_WRITES=true in the env block and restart the client. Nothing was sent to Lemma."
      );
    }
    if (confirm !== true) {
      return fail(
        `${toolName} moves real money / creates a real financial instrument. Pass confirm: true to execute. ` +
          "Nothing was sent to Lemma. Only confirm after the human user has explicitly approved this exact action."
      );
    }
    return null;
  };

  const writeTool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>
  ) => {
    const gatedShape = {
      ...shape,
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to execute. Requires prior explicit approval from the human user."),
    };
    server.tool(name, description, gatedShape, (args: Record<string, unknown>) =>
      run(async () => gate(name, args.confirm) ?? handler(args))
    );
    write++;
  };

  const get = async (path: string, query?: Record<string, string | number | boolean | undefined | null>) => {
    const res = await callLemma(config, "GET", path, { query });
    return res.ok ? ok(res.data) : fail(explainError(res));
  };

  const download = async (
    path: string,
    saveTo: string | undefined,
    what: string,
    query?: Record<string, string | number | boolean | undefined | null>
  ): Promise<ToolResult> => {
    const res = await callLemma(config, "GET", path, { query, binary: true });
    if (!res.ok) return fail(explainError(res));
    const bytes = res.bytes!;
    if (saveTo) {
      writeFileSync(saveTo, bytes);
      return ok({ saved_to: saveTo, bytes: bytes.length, what });
    }
    if (bytes.length > 1_500_000) {
      return fail(`${what} is ${bytes.length} bytes -- too large to inline. Re-call with save_to set to an absolute file path.`);
    }
    return ok({ what, bytes: bytes.length, base64: bytes.toString("base64") });
  };

  // ---------------------------------------------------------------- entities
  readTool(
    "lemma_list_entities",
    "List legal entities this platform API key has been granted access to. Entities are the top-level scope -- most other tools take an entity_id or account_id from here. Do not assume a single entity.",
    { ...page, npi: z.string().optional().describe("Client-side filter: only entities with this NPI") },
    async (a) => {
      const res = await callLemma(config, "GET", "/entities", {
        query: { limit: a.limit as number | undefined, cursor: a.cursor as string | undefined },
      });
      if (!res.ok) return fail(explainError(res));
      if (a.npi) {
        const d = res.data as { data?: { npi?: string }[] };
        return ok(
          { ...d, data: (d.data ?? []).filter((e) => e.npi === a.npi) },
          "npi filter applied client-side (the API has no npi query param); pagination cursors still refer to the unfiltered list"
        );
      }
      return ok(res.data);
    }
  );
  readTool("lemma_get_entity", "Get one entity by ID (name, legal structure, NPI, address).", {
    entity_id: z.string().describe("The entity ID"),
  }, (a) => get(`/entities/${encodeURIComponent(a.entity_id as string)}`));

  readTool("lemma_get_entity_lockbox", "Get an entity's lockbox mailing address (where payers send checks/EOBs).", {
    entity_id: z.string(),
  }, (a) => get(`/entities/${encodeURIComponent(a.entity_id as string)}/lockbox`));

  readTool(
    "lemma_list_entity_mail",
    "List lockbox mail received for an entity, including any checks found in each mail item (amounts in cents, *_dollars annotated).",
    {
      entity_id: z.string(),
      ...page,
      received_on_or_after: z.string().optional().describe("YYYY-MM-DD"),
      received_on_or_before: z.string().optional().describe("YYYY-MM-DD"),
    },
    (a) =>
      get(`/entities/${encodeURIComponent(a.entity_id as string)}/mail`, {
        limit: a.limit as number | undefined,
        cursor: a.cursor as string | undefined,
        "received.on_or_after": a.received_on_or_after as string | undefined,
        "received.on_or_before": a.received_on_or_before as string | undefined,
      })
  );

  // ---------------------------------------------------------------- accounts
  readTool("lemma_list_bank_accounts", "List Lemma bank accounts for an entity, with balances (cents; *_dollars annotated).", {
    entity_id: z.string().describe("Required -- accounts are listed per entity"),
    ...page,
  }, (a) => get("/accounts", { entity_id: a.entity_id as string, limit: a.limit as number | undefined, cursor: a.cursor as string | undefined }));

  readTool("lemma_get_bank_account", "Get one bank account (name, account/routing number, balances).", {
    account_id: z.string(),
  }, (a) => get(`/accounts/${encodeURIComponent(a.account_id as string)}`));

  readTool(
    "lemma_get_account_settlement_instructions",
    "Download a bank account's settlement instructions as a PDF. Pass save_to (absolute path) to write the file; otherwise small PDFs are returned base64-inline.",
    { account_id: z.string(), save_to: z.string().optional().describe("Absolute file path to save the PDF to") },
    (a) => download(`/accounts/${encodeURIComponent(a.account_id as string)}/settlement-instructions`, a.save_to as string | undefined, "settlement instructions PDF")
  );

  // ------------------------------------------------------------ transactions
  readTool("lemma_list_transactions", "List transactions for a bank account (paginated; amounts in cents, *_dollars annotated).", {
    account_id: z.string().describe("Required -- transactions are listed per account"),
    ...page,
  }, (a) => get("/transactions", { account_id: a.account_id as string, limit: a.limit as number | undefined, cursor: a.cursor as string | undefined }));

  readTool("lemma_get_transaction", "Get one transaction (amount, counterparty, source category, linked card if any).", {
    transaction_id: z.string(),
  }, (a) => get(`/transactions/${encodeURIComponent(a.transaction_id as string)}`));

  // ------------------------------------------------------- external accounts
  readTool("lemma_list_external_accounts", "List saved recipients (external bank accounts) for an entity. These are the only allowed destinations for external transfers.", {
    entity_id: z.string(),
    ...page,
  }, (a) => get("/external-accounts", { entity_id: a.entity_id as string, limit: a.limit as number | undefined, cursor: a.cursor as string | undefined }));

  readTool("lemma_get_external_account", "Get one saved recipient by ID (nickname, routing/account number, holder type, status).", {
    external_account_id: z.string(),
  }, (a) => get(`/external-accounts/${encodeURIComponent(a.external_account_id as string)}`));

  // ----------------------------------------------------------- check deposits
  readTool("lemma_list_check_deposits", "List check deposits, optionally filtered by account (status, holds, MICR payer details).", {
    account_id: z.string().optional(),
    ...page,
  }, (a) => get("/check-deposits", { account_id: a.account_id as string | undefined, limit: a.limit as number | undefined, cursor: a.cursor as string | undefined }));

  readTool("lemma_get_check_deposit", "Get one check deposit by ID.", {
    check_deposit_id: z.string(),
  }, (a) => get(`/check-deposits/${encodeURIComponent(a.check_deposit_id as string)}`));

  // -------------------------------------------------------------- remittances
  readTool(
    "lemma_list_remittances",
    "List an entity's insurance remittances (payer, payment amount, trace number, whether an 835 ERA is available).",
    {
      entity_id: z.string(),
      ...page,
      updated_since: z.string().optional().describe("ISO 8601 -- only remittances updated at/after this time"),
      received_on_or_after: z.string().optional().describe("YYYY-MM-DD"),
      received_on_or_before: z.string().optional().describe("YYYY-MM-DD"),
      payer: z.string().optional().describe("Substring match on payer name"),
    },
    (a) =>
      get("/remittances", {
        entity_id: a.entity_id as string,
        limit: a.limit as number | undefined,
        cursor: a.cursor as string | undefined,
        updated_since: a.updated_since as string | undefined,
        received_on_or_after: a.received_on_or_after as string | undefined,
        received_on_or_before: a.received_on_or_before as string | undefined,
        payer: a.payer as string | undefined,
      })
  );

  readTool(
    "lemma_get_remittance_era",
    "Fetch a remittance's 835 Electronic Remittance Advice as raw X12. Returns the X12 text inline (or save_to a file for large ERAs).",
    { remittance_id: z.string(), save_to: z.string().optional().describe("Absolute file path to save the raw X12 to") },
    async (a) => {
      const res = await callLemma(config, "GET", `/remittances/${encodeURIComponent(a.remittance_id as string)}/era`, { binary: true });
      if (!res.ok) return fail(explainError(res));
      const bytes = res.bytes!;
      if (a.save_to) {
        writeFileSync(a.save_to as string, bytes);
        return ok({ saved_to: a.save_to, bytes: bytes.length });
      }
      const text = bytes.toString("utf8");
      if (text.length > 200_000) return fail(`ERA is ${text.length} chars -- re-call with save_to set to a file path.`);
      return { content: [{ type: "text", text }] };
    }
  );

  // -------------------------------------------------------------------- cards
  readTool("lemma_get_card", "Get an issued virtual debit card by ID (nickname, last 4, status, every authorization control and spending limit).", {
    card_id: z.string(),
  }, (a) => get(`/cards/${encodeURIComponent(a.card_id as string)}`));

  readTool(
    "lemma_get_card_iframe",
    "SENSITIVE: get a short-lived iframe URL that renders the card's full PAN/CVV. The URL expires quickly and exposes real card credentials -- only fetch it when the user explicitly needs to view card details, never log or store it.",
    { card_id: z.string() },
    (a) => get(`/cards/${encodeURIComponent(a.card_id as string)}/iframe`)
  );

  // ---------------------------------------------------------------- transfers
  readTool("lemma_list_inbound_ach_transfers", "List inbound ACH transfers (money pushed/pulled by outside parties), optionally filtered by account.", {
    account_id: z.string().optional(),
    ...page,
  }, (a) => get("/inbound-ach-transfers", { account_id: a.account_id as string | undefined, limit: a.limit as number | undefined, cursor: a.cursor as string | undefined }));

  readTool("lemma_get_inbound_ach_transfer", "Get one inbound ACH transfer by ID.", {
    inbound_ach_transfer_id: z.string(),
  }, (a) => get(`/inbound-ach-transfers/${encodeURIComponent(a.inbound_ach_transfer_id as string)}`));

  readTool("lemma_get_ach_transfer", "Get one outbound ACH transfer by ID (status: pending/submitted/settled/returned/canceled/rejected).", {
    ach_transfer_id: z.string(),
  }, (a) => get(`/ach-transfer/${encodeURIComponent(a.ach_transfer_id as string)}`));

  readTool("lemma_get_book_transfer", "Get one internal book transfer by ID.", {
    book_transfer_id: z.string(),
  }, (a) => get(`/book-transfer/${encodeURIComponent(a.book_transfer_id as string)}`));

  // -------------------------------------------------------------------- files
  readTool(
    "lemma_get_pdf",
    "Download a file by file ID (e.g. a scanned lockbox mail item). Pass save_to (absolute path) to write it; small files return base64-inline.",
    { file_id: z.string(), save_to: z.string().optional() },
    (a) => download(`/files/${encodeURIComponent(a.file_id as string)}`, a.save_to as string | undefined, "file")
  );

  // ===================================================================
  // WRITE TOOLS -- gated behind LEMMA_ENABLE_WRITES + confirm:true
  // ===================================================================

  const reference = z
    .string()
    .min(1)
    .describe(
      "Stable caller-supplied identifier for THIS action (e.g. an invoice/payout ID). The Idempotency-Key is " +
        "derived deterministically from it, so retrying with the same reference is safe (Lemma replays instead of " +
        "re-executing). Use a NEW reference only for a genuinely new action."
    );

  writeTool(
    "lemma_create_external_account",
    "WRITE: save a new external bank account (saved recipient) for an entity -- the required first step before any external transfer. Creates a REAL payment destination. Saved recipients are IMMUTABLE once created: there is no update API, and archiving is done by emailing the Lemma team (contact@getlemma.com), not via API -- so double-check routing/account numbers before confirming.",
    {
      entity_id: z.string(),
      nickname: z.string().describe("Human-readable label"),
      holder_type: z.enum(["business", "individual"]),
      routing_number: z.string().describe("9-digit ABA routing number"),
      account_number: z.string(),
      holder_name: z.string().describe("Legal name of the account holder"),
      holder_address: z.object({
        line1: z.string(),
        line2: z.string().optional(),
        city: z.string(),
        state: z.string().describe("Two-letter USPS state code"),
        postal_code: z.string(),
        country: z.literal("US").default("US"),
      }),
      reference,
    },
    async (a) => {
      const res = await callLemma(config, "POST", "/external-accounts", {
        idempotencyKey: makeIdempotencyKey("mcp:ext-acct", a.reference as string),
        body: {
          entity_id: a.entity_id,
          nickname: a.nickname,
          holder_type: a.holder_type,
          routing_number: a.routing_number,
          account_number: a.account_number,
          holder_name: a.holder_name,
          holder_address: a.holder_address,
        },
      });
      if (!res.ok) return fail(explainError(res));
      return ok(res.data, res.idempotencyReplayed ? "Idempotency-Replayed: this recipient was already created by an earlier call with the same reference" : undefined);
    }
  );

  writeTool(
    "lemma_move_money_externally",
    "WRITE -- MOVES REAL MONEY: send an ACH transfer from a Lemma account to a SAVED RECIPIENT (destination must be an external_account_id from lemma_list_external_accounts; arbitrary bank accounts are rejected). Settles in 1-2 business days; transfers over $100,000 are held for manual review by Lemma. Requires explicit user approval before every call.",
    {
      source_account_id: z.string().describe("Lemma account ID to send from"),
      destination_account_id: z.string().describe("Saved recipient (external account) ID to send to"),
      amount_dollars: z.number().describe("Amount in DOLLARS (e.g. 1250.50); converted to cents internally"),
      description: z.string().max(200).optional().describe("Letters, numbers, and spaces only; max 200 chars; shows on the transaction"),
      reference,
    },
    async (a) => {
      const res = await callLemma(config, "POST", "/ach-transfer", {
        idempotencyKey: makeIdempotencyKey("mcp:ach", a.reference as string),
        body: {
          source_account_id: a.source_account_id,
          destination_account_id: a.destination_account_id,
          amount: dollarsToCents(a.amount_dollars as number),
          ...(a.description ? { description: a.description } : {}),
        },
      });
      if (!res.ok) return fail(explainError(res));
      return ok(res.data, res.idempotencyReplayed ? "Idempotency-Replayed: this transfer was already created by an earlier call with the same reference -- no new money moved" : undefined);
    }
  );

  writeTool(
    "lemma_move_money_internally",
    "WRITE -- MOVES REAL MONEY: instant, free book transfer between two Lemma accounts owned by this platform's granted entities. Requires explicit user approval before every call.",
    {
      source_account_id: z.string().describe("Lemma account ID to send from"),
      destination_account_id: z.string().describe("Lemma account ID to send to"),
      amount_dollars: z.number().describe("Amount in DOLLARS; converted to cents internally"),
      description: z.string().max(200).optional(),
      reference,
    },
    async (a) => {
      const res = await callLemma(config, "POST", "/book-transfer", {
        idempotencyKey: makeIdempotencyKey("mcp:book", a.reference as string),
        body: {
          source_account_id: a.source_account_id,
          destination_account_id: a.destination_account_id,
          amount: dollarsToCents(a.amount_dollars as number),
          ...(a.description ? { description: a.description } : {}),
        },
      });
      if (!res.ok) return fail(explainError(res));
      return ok(res.data, res.idempotencyReplayed ? "Idempotency-Replayed: this transfer was already created by an earlier call with the same reference -- no new money moved" : undefined);
    }
  );

  writeTool(
    "lemma_create_card",
    "WRITE -- CREATES A REAL FINANCIAL INSTRUMENT: issue a virtual debit card drawing on a Lemma bank account. At least one spending limit is REQUIRED (Lemma sets no ceiling of its own -- a card without limits could spend the entire account balance in one transaction). Requires explicit user approval before every call.",
    {
      bank_account_id: z.string(),
      nickname: z.string(),
      spending_limits: z
        .array(
          z.object({
            interval: z.string().describe("The window the limit is enforced over (e.g. per_authorization, daily, monthly, all_time -- see Lemma docs)"),
            amount_dollars: z.number().describe("Cap on settled spend in this window, in DOLLARS"),
          })
        )
        .min(1)
        .describe("At most one limit per interval; at least one required"),
      reference,
    },
    async (a) => {
      const limits = (a.spending_limits as { interval: string; amount_dollars: number }[]).map((l) => ({
        interval: l.interval,
        amount: dollarsToCents(l.amount_dollars, "spending_limits[].amount_dollars"),
      }));
      const res = await callLemma(config, "POST", "/cards", {
        idempotencyKey: makeIdempotencyKey("mcp:card", a.reference as string),
        body: {
          bank_account_id: a.bank_account_id,
          nickname: a.nickname,
          authorization_controls: {
            usage: { category: "multi_use", multi_use: { spending_limits: limits } },
          },
        },
      });
      if (!res.ok) return fail(explainError(res));
      return ok(res.data, res.idempotencyReplayed ? "Idempotency-Replayed: this card was already issued by an earlier call with the same reference" : undefined);
    }
  );

  writeTool(
    "lemma_delete_card",
    "WRITE -- PERMANENTLY cancels a real card so it can no longer be used. Idempotent by nature (DELETE; no idempotency key needed). Requires explicit user approval before every call.",
    { card_id: z.string() },
    async (a) => {
      const res = await callLemma(config, "DELETE", `/cards/${encodeURIComponent(a.card_id as string)}`);
      if (!res.ok) return fail(explainError(res));
      return ok(res.data);
    }
  );

  return { read, write };
}
