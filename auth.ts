import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "crypto";
import { metrics } from "./metrics";

const log = (...args: unknown[]) => {
	console.log(`[${new Date().toISOString()}]`, ...args);
};

/**
 * Constant-time comparison to prevent timing attacks
 */
export function validateApiKey(
	providedKey: string,
	validKeys: string[],
): boolean {
	if (!providedKey || providedKey.trim() === "") {
		return false;
	}

	const providedBuffer = Buffer.from(providedKey);

	for (const validKey of validKeys) {
		if (!validKey || validKey.trim() === "") continue;

		const validBuffer = Buffer.from(validKey.trim());

		// Only compare if lengths match (timingSafeEqual requires same length)
		if (providedBuffer.length === validBuffer.length) {
			try {
				if (timingSafeEqual(providedBuffer, validBuffer)) {
					return true;
				}
			} catch {
				// timingSafeEqual can throw if buffers have different lengths
				continue;
			}
		}
	}

	return false;
}

/**
 * Parse comma-separated API keys from environment variable
 */
export function parseApiKeys(envValue: string | undefined): string[] {
	if (!envValue) return [];
	return envValue
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
}

/**
 * Hono middleware for authenticating /api/queue requests
 */
export const authMiddleware = createMiddleware(async (c, next) => {
	const apiKey = c.req.header("X-API-Key");
	const validKeys = parseApiKeys(process.env.DAPP_API_KEYS);

	if (validKeys.length === 0) {
		log("Auth warning: DAPP_API_KEYS not configured");
		metrics.authRequestsTotal.inc({ result: "misconfigured" });
		return c.json({ error: "Server misconfigured: API keys not set" }, 500);
	}

	if (!apiKey) {
		log("Auth failed: Missing X-API-Key header", {
			path: c.req.path,
			method: c.req.method,
		});
		metrics.authRequestsTotal.inc({ result: "missing_key" });
		return c.json({ error: "Unauthorized" }, 401);
	}

	if (!validateApiKey(apiKey, validKeys)) {
		log("Auth failed: Invalid API key", {
			path: c.req.path,
			method: c.req.method,
			// DO NOT log the actual key value
		});
		metrics.authRequestsTotal.inc({ result: "invalid_key" });
		return c.json({ error: "Unauthorized" }, 401);
	}

	metrics.authRequestsTotal.inc({ result: "success" });
	await next();
});
