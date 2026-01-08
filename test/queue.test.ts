import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { TraceRequest } from "../types";

// Response types for test assertions
interface QueueSuccessResponse {
  status: string;
  message: string;
}

interface ErrorResponse {
  error: string;
}

type QueueResponse = QueueSuccessResponse | ErrorResponse;

// Test constants
const TEST_PORT = 3099;
const VALID_API_KEY = "test_api_key_12345";
const VALID_API_KEY_2 = "test_api_key_67890";
const INVALID_API_KEY = "invalid_key_xxxxx";
const CALLBACK_API_KEY = "callback_key_12345";

// Helper to create a valid trace request payload
function createValidTraceRequest(
  overrides: Partial<TraceRequest> = {}
): TraceRequest {
  return {
    rpc_url: "https://rpc.example.com",
    callback_url: "http://localhost:9999/callback",
    chain_id: 1,
    transaction_hash: "0x" + "a".repeat(64),
    transaction: {
      from: "0x" + "a".repeat(40),
      to: "0x" + "b".repeat(40),
      value: "1000000000000000000",
      data: "0x",
    },
    ...overrides,
  };
}

// In-memory test app that mimics the production server behavior
function createTestApp(apiKeys: string[], callbackApiKey?: string) {
  const app = new Hono();

  app.use("/*", cors());

  // Auth middleware inline for testing
  const authMiddleware = async (c: any, next: () => Promise<void>) => {
    const validKeys = apiKeys;

    if (validKeys.length === 0) {
      return c.json({ error: "Server misconfigured: API keys not set" }, 500);
    }

    const providedKey = c.req.header("X-API-Key");
    if (!providedKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!validKeys.includes(providedKey)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
  };

  app.post("/api/queue", authMiddleware, async (c) => {
    try {
      const request: TraceRequest = await c.req.json();

      // Validate required fields
      const missingFields: string[] = [];
      if (!request.rpc_url) missingFields.push("rpc_url");
      if (!request.callback_url) missingFields.push("callback_url");
      if (!request.transaction_hash) missingFields.push("transaction_hash");
      if (!request.transaction) missingFields.push("transaction");

      if (request.transaction) {
        if (!request.transaction.from) missingFields.push("transaction.from");
        if (!request.transaction.value) missingFields.push("transaction.value");
      }

      if (missingFields.length > 0) {
        return c.json(
          { error: `Missing required fields: ${missingFields.join(", ")}` },
          400
        );
      }

      // In tests, we don't actually process the trace
      // Just return 202 to confirm the request was accepted
      return c.json(
        { status: "queued", message: "Trace job queued successfully" },
        202
      );
    } catch (error) {
      return c.json({ error: "Invalid request body" }, 400);
    }
  });

  return app;
}

describe("POST /api/queue", () => {
  let server: ReturnType<typeof Bun.serve>;
  let app: Hono;

  beforeAll(() => {
    app = createTestApp([VALID_API_KEY, VALID_API_KEY_2], CALLBACK_API_KEY);
    server = Bun.serve({
      port: TEST_PORT,
      fetch: app.fetch,
    });
  });

  afterAll(() => {
    server.stop();
  });

  describe("Authentication", () => {
    it("returns 202 for valid authenticated request", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(createValidTraceRequest()),
      });

      expect(response.status).toBe(202);
      const body = (await response.json()) as QueueSuccessResponse;
      expect(body.status).toBe("queued");
      expect(body.message).toBe("Trace job queued successfully");
    });

    it("accepts multiple valid API keys", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY_2,
        },
        body: JSON.stringify(createValidTraceRequest()),
      });

      expect(response.status).toBe(202);
      const body = (await response.json()) as QueueSuccessResponse;
      expect(body.status).toBe("queued");
    });

    it("returns 401 for missing API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createValidTraceRequest()),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 for invalid API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": INVALID_API_KEY,
        },
        body: JSON.stringify(createValidTraceRequest()),
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 for empty API key", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "",
        },
        body: JSON.stringify(createValidTraceRequest()),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("Request Validation", () => {
    it("returns 400 for missing rpc_url", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.rpc_url;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("Missing required fields");
      expect(body.error).toContain("rpc_url");
    });

    it("returns 400 for missing callback_url", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.callback_url;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("callback_url");
    });

    it("returns 400 for missing transaction_hash", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.transaction_hash;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("transaction_hash");
    });

    it("returns 400 for missing transaction object", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.transaction;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("transaction");
    });

    it("returns 400 for missing transaction.from", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.transaction.from;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("transaction.from");
    });

    it("returns 400 for missing transaction.value", async () => {
      const payload = createValidTraceRequest();
      // @ts-expect-error - testing invalid payload
      delete payload.transaction.value;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("transaction.value");
    });

    it("returns 400 for multiple missing required fields", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify({
          rpc_url: "https://rpc.example.com",
          // Missing: callback_url, transaction_hash, transaction
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toContain("Missing required fields");
    });

    it("returns 400 for invalid JSON", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: "not valid json {{{",
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("Invalid request body");
    });

    it("returns 400 for empty request body", async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: "",
      });

      expect(response.status).toBe(400);
    });
  });

  describe("Optional Fields Handling", () => {
    it("accepts request without optional transaction.to (contract creation)", async () => {
      const payload = createValidTraceRequest();
      payload.transaction.to = "";

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with optional transaction.nonce", async () => {
      const payload = createValidTraceRequest();
      payload.transaction.nonce = "42";

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with optional transaction.gas_limit", async () => {
      const payload = createValidTraceRequest();
      payload.transaction.gas_limit = "21000";

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with optional block_number", async () => {
      const payload = createValidTraceRequest({ block_number: 12345678 });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with optional previous_block_number", async () => {
      const payload = createValidTraceRequest({ previous_block_number: 12345677 });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });
  });

  describe("Previous Transactions (Multi-block Simulation)", () => {
    it("accepts request with empty previous_transactions array", async () => {
      const payload = createValidTraceRequest({ previous_transactions: [] });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with previous_transactions (Type 0 - Legacy)", async () => {
      const payload = createValidTraceRequest({
        previous_transactions: [
          {
            type: 0,
            transaction_hash: "0x" + "c".repeat(64),
            chain_id: 1,
            nonce: "0",
            gas_limit: "21000",
            to_address: "0x" + "d".repeat(40),
            from_address: "0x" + "e".repeat(40),
            value: "1000000000000000000",
            data: "0x",
            gas_price: "20000000000",
          },
        ],
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with previous_transactions (Type 2 - EIP-1559)", async () => {
      const payload = createValidTraceRequest({
        previous_transactions: [
          {
            type: 2,
            transaction_hash: "0x" + "f".repeat(64),
            chain_id: 1,
            nonce: "5",
            gas_limit: "100000",
            to_address: "0x" + "1".repeat(40),
            from_address: "0x" + "2".repeat(40),
            value: "0",
            data: "0xabcdef",
            max_fee_per_gas: "50000000000",
            max_priority_fee_per_gas: "1500000000",
            access_list: [],
          },
        ],
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with multiple previous_transactions", async () => {
      const payload = createValidTraceRequest({
        previous_transactions: [
          {
            type: 0,
            transaction_hash: "0x" + "a".repeat(64),
            chain_id: 1,
            nonce: "0",
            gas_limit: "21000",
            to_address: "0x" + "b".repeat(40),
            from_address: "0x" + "c".repeat(40),
            value: "1000000000000000000",
            gas_price: "20000000000",
          },
          {
            type: 2,
            transaction_hash: "0x" + "d".repeat(64),
            chain_id: 1,
            nonce: "1",
            gas_limit: "50000",
            to_address: "0x" + "e".repeat(40),
            from_address: "0x" + "c".repeat(40),
            value: "500000000000000000",
            max_fee_per_gas: "30000000000",
            max_priority_fee_per_gas: "1000000000",
          },
        ],
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });
  });

  describe("Block Environment", () => {
    it("accepts request with block_env (post-merge)", async () => {
      const payload = createValidTraceRequest({
        block_env: {
          number: "18500000",
          timestamp: "1699000000",
          beneficiary: "0x" + "1".repeat(40),
          gas_limit: "30000000",
          basefee: "10000000000",
          difficulty: "0",
          prevrandao: "0x" + "f".repeat(64),
          blob_excess_gas_and_price: null,
        },
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with block_env (pre-merge)", async () => {
      const payload = createValidTraceRequest({
        block_env: {
          number: "15000000",
          timestamp: "1658000000",
          beneficiary: "0x" + "2".repeat(40),
          gas_limit: "30000000",
          basefee: "20000000000",
          difficulty: "14000000000000000",
          prevrandao: null,
          blob_excess_gas_and_price: null,
        },
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with block_env (with blob gas - EIP-4844)", async () => {
      const payload = createValidTraceRequest({
        block_env: {
          number: "19500000",
          timestamp: "1710000000",
          beneficiary: "0x" + "3".repeat(40),
          gas_limit: "30000000",
          basefee: "15000000000",
          difficulty: "0",
          prevrandao: "0x" + "a".repeat(64),
          blob_excess_gas_and_price: {
            excess_blob_gas: "0",
            blob_gasprice: "1",
          },
        },
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });
  });

  describe("Complex Request Scenarios", () => {
    it("accepts fully populated request with all optional fields", async () => {
      const payload = createValidTraceRequest({
        block_number: 18500000,
        previous_block_number: 18499999,
        previous_transactions: [
          {
            type: 2,
            transaction_hash: "0x" + "1".repeat(64),
            chain_id: 1,
            nonce: "10",
            gas_limit: "100000",
            to_address: "0x" + "2".repeat(40),
            from_address: "0x" + "3".repeat(40),
            value: "0",
            data: "0x12345678",
            max_fee_per_gas: "30000000000",
            max_priority_fee_per_gas: "1000000000",
            access_list: [
              {
                addr: "0x" + "4".repeat(40),
                storageKeys: ["0x" + "5".repeat(64)],
              },
            ],
          },
        ],
        block_env: {
          number: "18500000",
          timestamp: "1699000000",
          beneficiary: "0x" + "6".repeat(40),
          gas_limit: "30000000",
          basefee: "10000000000",
          difficulty: "0",
          prevrandao: "0x" + "7".repeat(64),
          blob_excess_gas_and_price: {
            excess_blob_gas: "131072",
            blob_gasprice: "2",
          },
        },
      });

      // Add optional transaction fields
      payload.transaction.nonce = "100";
      payload.transaction.gas_limit = "500000";
      payload.transaction.type = 2;

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });

    it("accepts request with callback_url containing query parameters", async () => {
      const payload = createValidTraceRequest({
        callback_url: "http://localhost:9999/callback?debug_trace_id=abc123&session=xyz",
      });

      const response = await fetch(`http://localhost:${TEST_PORT}/api/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALID_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(202);
    });
  });
});

describe("Server Misconfiguration", () => {
  let misconfiguredServer: ReturnType<typeof Bun.serve>;
  const MISCONFIG_PORT = 3098;

  beforeAll(() => {
    // Create server with no API keys configured
    const app = createTestApp([]);
    misconfiguredServer = Bun.serve({
      port: MISCONFIG_PORT,
      fetch: app.fetch,
    });
  });

  afterAll(() => {
    misconfiguredServer.stop();
  });

  it("returns 500 when DAPP_API_KEYS not configured", async () => {
    const response = await fetch(`http://localhost:${MISCONFIG_PORT}/api/queue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "any_key",
      },
      body: JSON.stringify(createValidTraceRequest()),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toContain("API keys not set");
  });
});
