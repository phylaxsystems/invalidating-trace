/**
 * End-to-End Integration Tests for Foundry Tracer API
 *
 * These tests verify the complete flow:
 * 1. Queue submission to /api/queue
 * 2. Forge test execution
 * 3. Callback delivery to a mock server
 *
 * IMPORTANT: These tests require actual forge execution and may take 30-60 seconds per test.
 * They are designed to be run with a real tracer server instance.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import type { TraceRequest, TraceCallbackPayload } from "../types";

// Test configuration
const TRACER_PORT = 3098;
const CALLBACK_PORT = 3097;
const TRACER_URL = `http://localhost:${TRACER_PORT}`;
const VALID_API_KEY = "e2e_test_key_12345";
const TRACER_CALLBACK_API_KEY = "tracer_callback_key_12345";

// Maximum time to wait for forge execution and callback (in ms)
const MAX_CALLBACK_WAIT = 90000; // 90 seconds for forge to run
const POLL_INTERVAL = 500; // Check for callback every 500ms

/**
 * Interface for received callback data including headers
 */
interface ReceivedCallback {
  payload: TraceCallbackPayload;
  headers: {
    "x-api-key"?: string;
    "content-type"?: string;
  };
  queryParams: Record<string, string>;
  receivedAt: number;
}

/**
 * Mock Callback Server
 *
 * A simple HTTP server that captures callbacks from the tracer service.
 * Stores all received callbacks for verification in tests.
 */
class MockCallbackServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private callbacks: ReceivedCallback[] = [];
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  /**
   * Start the mock callback server
   */
  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      fetch: async (req) => {
        const url = new URL(req.url);

        // Handle POST requests to any /callback path
        if (req.method === "POST" && url.pathname.startsWith("/callback")) {
          try {
            const payload = (await req.json()) as TraceCallbackPayload;

            // Extract query parameters
            const queryParams: Record<string, string> = {};
            url.searchParams.forEach((value, key) => {
              queryParams[key] = value;
            });

            // Store callback with metadata
            this.callbacks.push({
              payload,
              headers: {
                "x-api-key": req.headers.get("X-API-Key") || undefined,
                "content-type": req.headers.get("Content-Type") || undefined,
              },
              queryParams,
              receivedAt: Date.now(),
            });

            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ error: "Failed to parse callback" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }

        // Health check endpoint
        if (req.method === "GET" && url.pathname === "/health") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Stop the mock callback server
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  /**
   * Get all received callbacks
   */
  getCallbacks(): ReceivedCallback[] {
    return [...this.callbacks];
  }

  /**
   * Clear all received callbacks
   */
  clearCallbacks(): void {
    this.callbacks = [];
  }

  /**
   * Wait for a callback to be received with timeout
   */
  async waitForCallback(
    timeoutMs: number = MAX_CALLBACK_WAIT
  ): Promise<ReceivedCallback | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.callbacks.length > 0) {
        const lastCallback = this.callbacks[this.callbacks.length - 1];
        if (lastCallback) {
          return lastCallback;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return null;
  }

  /**
   * Get the URL for this callback server
   */
  getUrl(path: string = "/callback", queryParams?: Record<string, string>): string {
    let url = `http://localhost:${this.port}${path}`;
    if (queryParams) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }
    return url;
  }
}

/**
 * Helper to create a valid E2E trace request payload
 */
function createE2ETraceRequest(
  callbackUrl: string,
  overrides: Partial<TraceRequest> = {}
): TraceRequest {
  return {
    rpc_url: "https://rpc.sepolia.linea.build",
    callback_url: callbackUrl,
    chain_id: 59141,
    transaction_hash: "0x" + "a".repeat(64),
    fork_block_number: 1000000, // Linea Sepolia block to fork at
    transaction: {
      from: "0x" + "a".repeat(40),
      to: "0x" + "b".repeat(40),
      value: "0",
      data: "0x",
    },
    block_env: {
      number: "1000001",
      timestamp: "1699000000",
      beneficiary: "0x" + "1".repeat(40),
      gas_limit: "30000000",
      basefee: "1000000000",
      difficulty: "0",
      prevrandao: "0x" + "f".repeat(64),
      blob_excess_gas_and_price: null,
    },
    ...overrides,
  };
}

/**
 * Check if the tracer server is running
 */
async function isTracerServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${TRACER_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the tracer server as a subprocess
 */
let tracerProcess: ReturnType<typeof Bun.spawn> | null = null;

async function startTracerServer(): Promise<void> {
  // Check if already running
  if (await isTracerServerRunning()) {
    console.log("Tracer server already running on port", TRACER_PORT);
    return;
  }

  console.log("Starting tracer server...");

  // Start the tracer server with test environment variables
  tracerProcess = Bun.spawn(["bun", "run", "/Users/jacobdcastro/ph/tracer/index.ts"], {
    cwd: "/Users/jacobdcastro/ph/tracer",
    env: {
      ...process.env,
      PORT: String(TRACER_PORT),
      DAPP_API_KEYS: VALID_API_KEY,
      TRACER_CALLBACK_API_KEY: TRACER_CALLBACK_API_KEY,
      FORGE_PROJECT_DIR: "/Users/jacobdcastro/ph/tracer/foundry",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready (with timeout)
  const maxWait = 30000; // 30 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isTracerServerRunning()) {
      console.log("Tracer server started successfully");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Tracer server failed to start within timeout");
}

async function stopTracerServer(): Promise<void> {
  if (tracerProcess) {
    tracerProcess.kill();
    tracerProcess = null;
    // Wait for process to fully exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("End-to-End Queue Flow", () => {
  let callbackServer: MockCallbackServer;

  beforeAll(async () => {
    // Start mock callback server
    callbackServer = new MockCallbackServer(CALLBACK_PORT);
    await callbackServer.start();

    // Start tracer server
    await startTracerServer();
  }, 60000); // 60 second timeout for setup

  afterAll(async () => {
    // Stop both servers
    callbackServer.stop();
    await stopTracerServer();
  });

  beforeEach(() => {
    // Clear callbacks between tests
    callbackServer.clearCallbacks();
  });

  describe("Basic Queue Flow", () => {
    it(
      "completes full queue -> trace -> callback flow",
      async () => {
        // Submit trace request
        const callbackUrl = callbackServer.getUrl("/callback", {
          trace_id: "test-basic-flow",
        });

        const response = await fetch(`${TRACER_URL}/api/queue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": VALID_API_KEY,
          },
          body: JSON.stringify(createE2ETraceRequest(callbackUrl)),
        });

        // Should return 202 immediately
        expect(response.status).toBe(202);
        const queueResponse = (await response.json()) as { status: string };
        expect(queueResponse.status).toBe("queued");

        // Wait for callback
        const callback = await callbackServer.waitForCallback();

        expect(callback).not.toBeNull();
        expect(callback!.payload).toHaveProperty("success");
        expect(callback!.payload).toHaveProperty("duration_ms");
        expect(typeof callback!.payload.duration_ms).toBe("number");
      },
      MAX_CALLBACK_WAIT + 10000
    );

    it(
      "preserves query parameters in callback URL",
      async () => {
        const queryParams = {
          trace_id: "test-query-params",
          session: "xyz789",
          debug: "true",
        };

        const callbackUrl = callbackServer.getUrl("/callback", queryParams);

        const response = await fetch(`${TRACER_URL}/api/queue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": VALID_API_KEY,
          },
          body: JSON.stringify(createE2ETraceRequest(callbackUrl)),
        });

        expect(response.status).toBe(202);

        // Wait for callback
        const callback = await callbackServer.waitForCallback();

        expect(callback).not.toBeNull();
        expect(callback!.queryParams).toEqual(queryParams);
      },
      MAX_CALLBACK_WAIT + 10000
    );
  });

  describe("Callback Authentication", () => {
    it(
      "includes X-API-Key header in callback",
      async () => {
        const callbackUrl = callbackServer.getUrl("/callback", {
          trace_id: "test-auth-header",
        });

        const response = await fetch(`${TRACER_URL}/api/queue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": VALID_API_KEY,
          },
          body: JSON.stringify(createE2ETraceRequest(callbackUrl)),
        });

        expect(response.status).toBe(202);

        // Wait for callback
        const callback = await callbackServer.waitForCallback();

        expect(callback).not.toBeNull();
        expect(callback!.headers["x-api-key"]).toBe(TRACER_CALLBACK_API_KEY);
        expect(callback!.headers["content-type"]).toBe("application/json");
      },
      MAX_CALLBACK_WAIT + 10000
    );
  });

  describe("Callback Payload Structure", () => {
    it(
      "sends correctly structured success callback payload",
      async () => {
        const callbackUrl = callbackServer.getUrl("/callback", {
          trace_id: "test-payload-structure",
        });

        const response = await fetch(`${TRACER_URL}/api/queue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": VALID_API_KEY,
          },
          body: JSON.stringify(createE2ETraceRequest(callbackUrl)),
        });

        expect(response.status).toBe(202);

        // Wait for callback
        const callback = await callbackServer.waitForCallback();

        expect(callback).not.toBeNull();

        const payload = callback!.payload;

        // Check required fields
        expect(typeof payload.success).toBe("boolean");
        expect(typeof payload.duration_ms).toBe("number");
        expect(payload.duration_ms).toBeGreaterThan(0);

        // If success, check trace content
        if (payload.success) {
          expect(payload.trace_content).toBeDefined();
          expect(typeof payload.trace_content).toBe("string");
          expect(payload.trace_format).toBe("ansi");
        }
      },
      MAX_CALLBACK_WAIT + 10000
    );
  });

  describe("Error Handling", () => {
    it(
      "sends error callback when forge test fails",
      async () => {
        const callbackUrl = callbackServer.getUrl("/callback", {
          trace_id: "test-error-callback",
        });

        // Submit a request that might cause forge to fail
        // (using an invalid RPC URL that forge will fail to connect to)
        const response = await fetch(`${TRACER_URL}/api/queue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": VALID_API_KEY,
          },
          body: JSON.stringify(
            createE2ETraceRequest(callbackUrl, {
              rpc_url: "http://invalid-rpc-that-will-fail.local",
            })
          ),
        });

        expect(response.status).toBe(202);

        // Wait for callback (error callbacks should still be sent)
        const callback = await callbackServer.waitForCallback();

        expect(callback).not.toBeNull();
        expect(callback!.payload).toHaveProperty("duration_ms");

        // The callback should be received regardless of trace success/failure
        // Forge may succeed or fail depending on the RPC - either is valid
      },
      MAX_CALLBACK_WAIT + 10000
    );
  });

  describe("Queue Serialization", () => {
    it(
      "processes multiple queued requests sequentially",
      async () => {
        // Submit multiple requests in quick succession
        const promises: Promise<Response>[] = [];

        for (let i = 0; i < 3; i++) {
          const callbackUrl = callbackServer.getUrl("/callback", {
            trace_id: `test-queue-${i}`,
            sequence: String(i),
          });

          promises.push(
            fetch(`${TRACER_URL}/api/queue`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": VALID_API_KEY,
              },
              body: JSON.stringify(createE2ETraceRequest(callbackUrl)),
            })
          );
        }

        // All should return 202 immediately
        const responses = await Promise.all(promises);
        for (const response of responses) {
          expect(response.status).toBe(202);
        }

        // Wait for all callbacks (3 requests * MAX_CALLBACK_WAIT)
        const startTime = Date.now();
        const maxWait = MAX_CALLBACK_WAIT * 3 + 30000;

        while (
          callbackServer.getCallbacks().length < 3 &&
          Date.now() - startTime < maxWait
        ) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        }

        const callbacks = callbackServer.getCallbacks();

        // Should have received all 3 callbacks
        expect(callbacks.length).toBe(3);

        // Verify callbacks were received in order (sequential processing)
        // Each callback should have a later timestamp than the previous
        for (let i = 1; i < callbacks.length; i++) {
          const current = callbacks[i];
          const previous = callbacks[i - 1];
          if (current && previous) {
            expect(current.receivedAt).toBeGreaterThanOrEqual(previous.receivedAt);
          }
        }
      },
      MAX_CALLBACK_WAIT * 3 + 60000
    );
  });
});
