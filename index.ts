import { Hono } from "hono@4";
import { cors } from "hono/cors";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

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
app.get("/", (c) => c.text("Hello world!"));
app.get("/api/health", (c) => c.json({ status: "ok" }));

app.post("/api/run-tests", async (c) => {
	try {
		const requestPayload = await readRequestPayload(c);
		const envOverrides = buildRunEnvOverrides(requestPayload);
		const result = await enqueueForgeTestRun(envOverrides);
		const success = result.exitCode === 0;

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
		return c.json({ success: false, error: message }, 500);
	}
});

log("Verifying Foundry installation before serving requests");
await ensureForge().catch((error) => {
	log("Foundry verification failed", error);
	throw error;
});
log("Foundry installation verified");
log("Forge project directory", FORGE_PROJECT_DIR);

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: app.fetch,
});
setupSignalHandlers();

async function runForgeTests(envOverrides: Record<string, string> = {}) {
	await ensureForge();
	await ensureForgeProjectDirectory();
	const env = buildFoundryEnv(envOverrides);
	const forgeBinary = forgeBinaryPath;
	if (!forgeBinary) {
		throw new Error("forge binary path was not resolved. Ensure Foundry is installed before running tests.");
	}
	const forgeArgs = ["test", "--color", "always", "-vvvv"];
	log("Launching forge test run", { projectDir: FORGE_PROJECT_DIR, forgeBinary, args: forgeArgs });
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

	return {
		exitCode: code,
		stdout: stdoutText.trim(),
		stderr: stderrText.trim(),
	};
}

function enqueueForgeTestRun(envOverrides: Record<string, string>) {
	const overridesCopy = { ...envOverrides };
	const run = forgeRunQueue.then(() => runForgeTests(overridesCopy));
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
			return;
		} catch {
			continue;
		}
	}

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
	} catch {
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

async function readRequestPayload(c: { req: Request }) {
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
		server.stop();
		process.exit(0);
	};
	for (const signal of STOP_SIGNALS) {
		process.on(signal, () => shutdown(signal));
	}
}
