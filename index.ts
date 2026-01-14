import { Hono } from "hono";
import { cors } from "hono/cors";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { TraceRequest, TraceCallbackPayload } from "./types";
import { authMiddleware } from "./auth";
import { metrics, renderMetrics } from "./metrics";

const DEFAULT_FOUNDRY_HOME = process.env.HOME ?? "/tmp/foundry";
const FOUNDRY_HOME = process.env.FOUNDRY_HOME ?? DEFAULT_FOUNDRY_HOME;
const FOUNDRY_DIR = process.env.FOUNDRY_DIR ?? `${FOUNDRY_HOME}/.foundry`;
const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${FOUNDRY_DIR}/bin`;
const FORGE_CANDIDATES = [
	process.env.FORGE_BIN,
	`${FOUNDRY_BIN_DIR}/forge`,
	`${FOUNDRY_DIR}/forge`,
].filter((value): value is string => Boolean(value && value.trim() !== ""));
let forgeBinaryPath: string | null = process.env.FORGE_BIN ?? null;
const FORGE_PROJECT_DIR =
	process.env.FORGE_PROJECT_DIR ?? `${process.cwd()}/foundry`;
let forgeRunQueue: Promise<void> = Promise.resolve();
const REQUEST_ENV_KEYS = [
	"from",
	"to",
	"value",
	"rpc",
	"calldata",
	"previous_tx",
] as const;
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type StopSignal = (typeof STOP_SIGNALS)[number];

const log = (...args: unknown[]) => {
	console.log(`[${new Date().toISOString()}]`, ...args);
};

const app = new Hono();

app.use("/*", cors());
app.use("*", async (c, next) => {
	const method = c.req.method;
	const path = c.req.path;
	const start = performance.now();
	metrics.httpRequestsInFlight.inc();

	const requestSizeHeader = c.req.header("content-length");
	if (requestSizeHeader) {
		const requestSize = Number(requestSizeHeader);
		if (Number.isFinite(requestSize) && requestSize > 0) {
			metrics.httpRequestSizeBytes.observe(requestSize, { method, path });
		}
	}

	try {
		await next();
		const status = c.res?.status ?? 200;
		metrics.httpRequestsTotal.inc({
			method,
			path,
			status: String(status),
		});
	} catch (error) {
		metrics.httpRequestsTotal.inc({
			method,
			path,
			status: "500",
		});
		throw error;
	} finally {
		const durationSeconds = (performance.now() - start) / 1000;
		metrics.httpRequestDurationSeconds.observe(durationSeconds, {
			method,
			path,
		});

		const responseSizeHeader = c.res?.headers?.get("content-length");
		if (responseSizeHeader) {
			const responseSize = Number(responseSizeHeader);
			if (Number.isFinite(responseSize) && responseSize > 0) {
				metrics.httpResponseSizeBytes.observe(responseSize, { method, path });
			}
		}
		metrics.httpRequestsInFlight.dec();
	}
});
app.get("/", (c) => c.text("Hello world!"));
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/metrics", (c) =>
	c.text(renderMetrics(), 200, {
		"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
	}),
);

app.post("/api/run-tests", async (c) => {
	const start = performance.now();
	let outcome: "success" | "failure" | "error" = "error";

	try {
		const requestPayload = await readRequestPayload(c);
		const envOverrides = buildRunEnvOverrides(requestPayload);
		const result = await enqueueForgeTestRun(envOverrides);
		const success = result.exitCode === 0;
		outcome = success ? "success" : "failure";

		return c.json(
			{
				success,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			},
			success ? 200 : 500,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("forge test run failed", message);
		outcome = "error";
		return c.json({ success: false, error: message }, 500);
	} finally {
		metrics.runTestsRequestsTotal.inc({ result: outcome });
		metrics.runTestsDurationSeconds.observe(
			(performance.now() - start) / 1000,
		);
	}
});

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

		// Validate fork_block_number (required)
		if (
			request.fork_block_number === undefined ||
			request.fork_block_number === null
		) {
			missingFields.push("fork_block_number");
		}

		// Validate block_env (required with all fields)
		if (!request.block_env) {
			missingFields.push("block_env");
		} else {
			if (!request.block_env.number) missingFields.push("block_env.number");
			if (!request.block_env.timestamp)
				missingFields.push("block_env.timestamp");
			if (!request.block_env.beneficiary)
				missingFields.push("block_env.beneficiary");
			if (!request.block_env.basefee) missingFields.push("block_env.basefee");
			if (!request.block_env.gas_limit)
				missingFields.push("block_env.gas_limit");
			if (request.block_env.difficulty === undefined)
				missingFields.push("block_env.difficulty");
		}

		if (missingFields.length > 0) {
			log("Queue request validation failed", { missingFields });
			metrics.traceRequestsTotal.inc({ result: "invalid" });
			for (const field of missingFields) {
				metrics.traceRequestMissingFieldsTotal.inc({ field });
			}
			return c.json(
				{ error: `Missing required fields: ${missingFields.join(", ")}` },
				400,
			);
		}

		metrics.traceRequestsTotal.inc({ result: "queued" });
		metrics.tracePreviousTransactions.observe(
			request.previous_transactions?.length ?? 0,
		);

		// Fire-and-forget - don't await
		processTrace(request);

		log("Trace request queued", {
			chain_id: request.chain_id,
			transaction_hash: request.transaction_hash,
		});

		return c.json(
			{ status: "queued", message: "Trace job queued successfully" },
			202,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("Queue request failed", message);
		metrics.traceRequestsTotal.inc({ result: "invalid" });
		return c.json({ error: "Invalid request body" }, 400);
	}
});

log("Verifying Foundry installation before serving requests");
await ensureForge().catch((error) => {
	log("Foundry verification failed", error);
	throw error;
});
log("Foundry installation verified");
log("Forge project directory", FORGE_PROJECT_DIR);

log("Validating environment configuration");

function validateEnvironment(): void {
	const warnings: string[] = [];
	const errors: string[] = [];

	// Required for callback authentication
	if (!process.env.TRACER_CALLBACK_API_KEY) {
		warnings.push(
			"TRACER_CALLBACK_API_KEY not set - callbacks will be sent without authentication",
		);
		metrics.configWarningsTotal.inc({
			name: "missing_tracer_callback_api_key",
		});
	}

	// Required for incoming request authentication
	if (!process.env.DAPP_API_KEYS) {
		warnings.push(
			"DAPP_API_KEYS not set - /api/queue endpoint will reject all requests",
		);
		metrics.configWarningsTotal.inc({ name: "missing_dapp_api_keys" });
	}

	// Log warnings
	for (const warning of warnings) {
		log("Config warning:", warning);
	}

	// Throw on errors
	if (errors.length > 0) {
		throw new Error(`Environment validation failed: ${errors.join(", ")}`);
	}

	log("Environment configuration validated");
}

validateEnvironment();

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: app.fetch,
});
setupSignalHandlers();

async function runForgeTests(envOverrides: Record<string, string> = {}) {
	const runStart = performance.now();
	metrics.forgeRunsInFlight.inc();

	try {
		await ensureForge();
		await ensureForgeProjectDirectory();
		const env = buildFoundryEnv(envOverrides);
		const forgeBinary = forgeBinaryPath;
		if (!forgeBinary) {
			throw new Error(
				"forge binary path was not resolved. Ensure Foundry is installed before running tests.",
			);
		}
		const forgeArgs = [
			"test",
			"--color",
			"always",
			"-vvvv",
			"--no-storage-caching",
			"--no-cache",
		];
		log("Launching forge test run", {
			projectDir: FORGE_PROJECT_DIR,
			forgeBinary,
			args: forgeArgs,
		});
		const forgeProcess = Bun.spawn({
			cmd: [forgeBinary, ...forgeArgs],
			cwd: FORGE_PROJECT_DIR,
			stdout: "pipe",
			stderr: "pipe",
			env,
		});

		const stdout = new Response(forgeProcess.stdout).text();
		const stderr = new Response(forgeProcess.stderr).text();
		const exitCode = forgeProcess.exited;
		const [stdoutText, stderrText, code] = await Promise.all([
			stdout,
			stderr,
			exitCode,
		]);

		log("forge test exited", code);

		const durationSeconds = (performance.now() - runStart) / 1000;
		metrics.forgeRunDurationSeconds.observe(durationSeconds);
		metrics.forgeRunsTotal.inc({
			status: code === 0 ? "success" : "failure",
		});
		metrics.forgeRunExitCodeTotal.inc({ code: String(code) });
		metrics.forgeRunStdoutBytes.observe(Buffer.byteLength(stdoutText));
		metrics.forgeRunStderrBytes.observe(Buffer.byteLength(stderrText));

		return {
			exitCode: code,
			stdout: stdoutText.trim(),
			stderr: stderrText.trim(),
		};
	} catch (error) {
		const durationSeconds = (performance.now() - runStart) / 1000;
		metrics.forgeRunDurationSeconds.observe(durationSeconds);
		metrics.forgeRunsTotal.inc({ status: "error" });
		throw error;
	} finally {
		metrics.forgeRunsInFlight.dec();
	}
}

function enqueueForgeTestRun(envOverrides: Record<string, string>) {
	const overridesCopy = { ...envOverrides };
	const enqueuedAt = performance.now();
	metrics.forgeQueueDepth.inc();
	const run = forgeRunQueue.then(async () => {
		metrics.forgeQueueDepth.dec();
		metrics.forgeQueueWaitSeconds.observe(
			(performance.now() - enqueuedAt) / 1000,
		);
		return runForgeTests(overridesCopy);
	});
	forgeRunQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function ensureForge() {
	for (const candidate of FORGE_CANDIDATES) {
		try {
			await access(candidate, fsConstants.X_OK);
			forgeBinaryPath = candidate;
			log("Found forge binary", candidate);
			metrics.foundryChecksTotal.inc({
				check: "forge",
				result: "success",
			});
			return;
		} catch {
			continue;
		}
	}

	metrics.foundryChecksTotal.inc({ check: "forge", result: "failure" });
	throw new Error(
		`forge binary missing or not executable. Checked locations: ${FORGE_CANDIDATES.join(
			", ",
		)}. Install Foundry via foundryup before starting the server.`,
	);
}

async function ensureForgeProjectDirectory() {
	try {
		await access(FORGE_PROJECT_DIR, fsConstants.X_OK);
		log("Found forge project directory", FORGE_PROJECT_DIR);
		metrics.foundryChecksTotal.inc({
			check: "project_dir",
			result: "success",
		});
	} catch {
		metrics.foundryChecksTotal.inc({
			check: "project_dir",
			result: "failure",
		});
		throw new Error(
			`Forge project directory missing or not accessible at ${FORGE_PROJECT_DIR}. Mount or copy your Foundry project there or set FORGE_PROJECT_DIR.`,
		);
	}
}

function buildFoundryEnv(envOverrides: Record<string, string> = {}) {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}

	env.HOME = FOUNDRY_HOME;
	const extraPaths = [FOUNDRY_BIN_DIR, FOUNDRY_DIR].filter(Boolean);
	env.PATH = `${extraPaths.join(":")}:${env.PATH ?? ""}`;
	env.FOUNDRY_DIR = FOUNDRY_DIR;
	env.SHELL = env.SHELL || "/bin/bash";
	env.FORCE_COLOR = env.FORCE_COLOR || "1";
	env.CLICOLOR = env.CLICOLOR || "1";
	env.CLICOLOR_FORCE = env.CLICOLOR_FORCE || "1";
	for (const [key, value] of Object.entries(envOverrides)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}

	return env;
}

async function readRequestPayload(c: { req: { json: () => Promise<unknown> } }) {
	try {
		const body = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
	} catch {
		return {};
	}
	return {};
}

function buildRunEnvOverrides(payload: Record<string, unknown>) {
	const overrides: Record<string, string> = {};
	for (const key of REQUEST_ENV_KEYS) {
		const value = payload[key];
		if (value === undefined || value === null) {
			continue;
		}
		const textValue =
			typeof value === "string" ? value.trim() : String(value).trim();
		if (textValue === "") {
			continue;
		}
		overrides[key.toUpperCase()] = textValue;
	}
	return overrides;
}

function setupSignalHandlers() {
	const shutdown = (signal: StopSignal) => {
		log(`Received ${signal}. Stopping server.`);
		metrics.shutdownSignalsTotal.inc({ signal });
		server.stop();
		process.exit(0);
	};
	for (const signal of STOP_SIGNALS) {
		process.on(signal, () => shutdown(signal));
	}
}

/**
 * Sends trace results back to the dapp's callback URL.
 * Never throws - all errors are caught and logged.
 *
 * @param url - The callback URL (may include query params like debug_trace_id)
 * @param payload - The trace result payload to send
 */
async function sendCallback(
	url: string,
	payload: TraceCallbackPayload,
): Promise<void> {
	const startTime = Date.now();
	const payloadText = JSON.stringify(payload);
	metrics.callbackPayloadBytes.observe(Buffer.byteLength(payloadText));

	try {
		const apiKey = process.env.TRACER_CALLBACK_API_KEY;

		if (!apiKey) {
			log("Callback warning: TRACER_CALLBACK_API_KEY not configured");
		}

		log("Sending callback", {
			url: url.split("?")[0], // Log URL without query params for privacy
			success: payload.success,
			duration_ms: payload.duration_ms,
		});

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": apiKey || "",
			},
			body: payloadText,
		});

		const callbackDuration = Date.now() - startTime;
		const callbackDurationSeconds = callbackDuration / 1000;
		const statusLabel = response.ok ? "success" : "failure";
		metrics.callbackDurationSeconds.observe(callbackDurationSeconds, {
			status: statusLabel,
		});
		metrics.callbackRequestsTotal.inc({
			status: statusLabel,
			http_status: String(response.status),
		});

		if (!response.ok) {
			log("Callback failed", {
				status: response.status,
				statusText: response.statusText,
				duration_ms: callbackDuration,
			});
		} else {
			log("Callback successful", {
				status: response.status,
				duration_ms: callbackDuration,
			});
		}
	} catch (error) {
		const callbackDuration = Date.now() - startTime;
		const callbackDurationSeconds = callbackDuration / 1000;
		metrics.callbackDurationSeconds.observe(callbackDurationSeconds, {
			status: "error",
		});
		metrics.callbackRequestsTotal.inc({
			status: "error",
			http_status: "exception",
		});
		log("Callback error", {
			error: error instanceof Error ? error.message : String(error),
			duration_ms: callbackDuration,
		});
		// Don't throw - callback failures shouldn't crash the service
	}
}

/**
 * Processes a trace request asynchronously.
 * Runs forge test with the provided transaction data and sends results to callback URL.
 * This function never throws - all errors are caught and sent via callback.
 *
 * @param request - The trace request containing transaction data and callback URL
 */
async function processTrace(request: TraceRequest): Promise<void> {
	const startTime = Date.now();
	metrics.traceRequestsInFlight.inc();
	let outcome: "success" | "failure" = "failure";

	try {
		// Build forge environment from request data
		const forgeEnv: Record<string, string> = {
			FROM: request.transaction.from,
			TO: request.transaction.to || "",
			VALUE: request.transaction.value,
			CALLDATA: request.transaction.data || "",
			RPC: request.rpc_url,
			FORK_BLOCK_NUMBER: String(request.fork_block_number),
		};

		// Add optional transaction fields
		if (request.transaction.nonce) {
			forgeEnv.NONCE = request.transaction.nonce;
		}
		if (request.transaction.gas_limit) {
			forgeEnv.GAS_LIMIT = request.transaction.gas_limit;
		}

		// Add previous transactions if provided (for multi-block sim)
		if (request.previous_transactions?.length) {
			const prevTxsForSolidity = request.previous_transactions.map((tx) => ({
				txType: tx.type,
				txHash: tx.transaction_hash,
				txChainId: tx.chain_id,
				txNonce: tx.nonce,
				txGasLimit: tx.gas_limit,
				txFrom: tx.from_address,
				txTo: tx.to_address || "",
				txValue: tx.value,
				txData: tx.data || "0x",
				txGasPrice: tx.gas_price || "0",
				txMaxFeePerGas: tx.max_fee_per_gas || "0",
				txMaxPriorityFeePerGas: tx.max_priority_fee_per_gas || "0",
				txMaxFeePerBlobGas: tx.max_fee_per_blob_gas || "0",
				txBlobVersionedHashes: tx.blob_versioned_hashes || [],
				txAccessList: tx.access_list || [],
				txAuthorizationList: tx.authorization_list || [],
			}));
			forgeEnv.PREVIOUS_TXS = JSON.stringify(prevTxsForSolidity);
		}

		// Add block environment if provided
		if (request.block_env) {
			forgeEnv.BLOCK_NUMBER = request.block_env.number;
			forgeEnv.BLOCK_TIMESTAMP = request.block_env.timestamp;
			forgeEnv.BLOCK_COINBASE = request.block_env.beneficiary;
			forgeEnv.BLOCK_BASEFEE = request.block_env.basefee;
			forgeEnv.BLOCK_GAS_LIMIT = request.block_env.gas_limit;
			forgeEnv.BLOCK_DIFFICULTY = request.block_env.difficulty;

			if (request.block_env.prevrandao !== null) {
				forgeEnv.BLOCK_PREVRANDAO = request.block_env.prevrandao;
			}

			if (request.block_env.blob_excess_gas_and_price !== null) {
				forgeEnv.BLOB_EXCESS_GAS =
					request.block_env.blob_excess_gas_and_price.excess_blob_gas;
				forgeEnv.BLOB_GASPRICE =
					request.block_env.blob_excess_gas_and_price.blob_gasprice;
				// Pass blob_gasprice as BLOCK_BLOB_BASE_FEE for the vm.blobBaseFee cheat code
				forgeEnv.BLOCK_BLOB_BASE_FEE =
					request.block_env.blob_excess_gas_and_price.blob_gasprice;
			}
		}

		log("Processing trace", {
			transaction_hash: request.transaction_hash,
			chain_id: request.chain_id,
		});

		// Use existing queue - handles serialization
		const result = await enqueueForgeTestRun(forgeEnv);
		outcome = result.exitCode === 0 ? "success" : "failure";

		// Dumb pipe: send raw forge output, parsing is done client-side
		await sendCallback(request.callback_url, {
			success: outcome === "success",
			trace_content: result.stdout,
			trace_format: "ansi",
			duration_ms: Date.now() - startTime,
		});
	} catch (error) {
		log("Trace processing failed", {
			transaction_hash: request.transaction_hash,
			error: error instanceof Error ? error.message : String(error),
		});

		await sendCallback(request.callback_url, {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			error_code: "TRACE_FAILED",
			duration_ms: Date.now() - startTime,
		});
	} finally {
		metrics.traceRequestsInFlight.dec();
		metrics.traceDurationSeconds.observe(
			(Date.now() - startTime) / 1000,
			{ status: outcome },
		);
		metrics.traceResultsTotal.inc({ status: outcome });
	}
}
