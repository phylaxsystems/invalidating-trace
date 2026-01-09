import { describe, expect, test } from "bun:test";

// Import the function by re-implementing it here for testing
// (In a real scenario, you'd export it from index.ts)

function getIndentLevel(line: string): number {
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	const match = stripped.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

function extractTransactionTrace(rawOutput: string): {
	trace: string;
	testPassed: boolean;
	error?: string;
} {
	const lines = rawOutput.split("\n");

	// Strip ANSI codes when searching for testTracing marker
	const testTracingIndex = lines.findIndex((line) => {
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		return stripped.includes("InvalidatingTrace::testTracing()");
	});

	if (testTracingIndex === -1) {
		return {
			trace: "",
			testPassed: false,
			error: "Trace could not complete: testTracing() was not reached",
		};
	}

	const strippedOutput = rawOutput.replace(/\x1b\[[0-9;]*m/g, "");
	const testPassed = !strippedOutput.includes("[FAIL");

	let startIndex = testTracingIndex + 1;

	while (startIndex < lines.length) {
		const line = lines[startIndex];
		if (line.match(/\[\d[\d,]*\]\s*(?:\x1b\[\d+m)*0x[a-fA-F0-9]+/)) {
			break;
		}
		startIndex++;
	}

	if (startIndex >= lines.length) {
		return {
			trace: "",
			testPassed,
			error: "Could not find transaction trace in output",
		};
	}

	const baseIndent = getIndentLevel(lines[startIndex]);

	const traceLines: string[] = [];
	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];

		if (
			line.trim() === "" ||
			line.includes("Suite result:") ||
			(line.includes("Ran ") && line.includes(" test"))
		) {
			break;
		}

		const currentIndent = getIndentLevel(line);

		if (currentIndent < baseIndent && traceLines.length > 0) {
			break;
		}

		traceLines.push(line);
	}

	const minIndent = Math.min(
		...traceLines.filter((l) => l.trim()).map((l) => getIndentLevel(l)),
	);
	const normalizedLines = traceLines.map((line) => {
		if (!line.trim()) return line;
		return line.slice(minIndent);
	});

	return {
		trace: normalizedLines.join("\n"),
		testPassed,
	};
}

describe("extractTransactionTrace", () => {
	test("extracts trace from passing test output", () => {
		const rawOutput = `Compiling 20 files with Solc 0.8.24
Solc 0.8.24 finished in 393.59ms

Ran 1 test for test/InvalidatingTrace.t.sol:InvalidatingTrace
[PASS] testTracing() (gas: 123456)
Traces:
  [905349] InvalidatingTrace::setUp()
    ├─ [0] VM::envString("RPC") [staticcall]
    │   └─ ← [Return] <env var value>
    └─ [0] VM::startPrank(0x1234...)
        └─ ← [Return]

  [123456] InvalidatingTrace::testTracing()
    └─ [98765] 0xABCDEF1234567890abcdef1234567890ABCDEF12::swap(...)
        ├─ [50000] 0x1111111111111111111111111111111111111111::transfer(...)
        │   └─ ← [Return] true
        └─ ← [Return] 0x1234

Suite result: PASSED. 1 passed; 0 failed; 0 skipped; finished in 1.23s`;

		const result = extractTransactionTrace(rawOutput);

		expect(result.testPassed).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.trace).toContain("0xABCDEF1234567890abcdef1234567890ABCDEF12::swap");
		expect(result.trace).toContain("0x1111111111111111111111111111111111111111::transfer");
		expect(result.trace).not.toContain("setUp()");
		expect(result.trace).not.toContain("VM::envString");
		expect(result.trace).not.toContain("Suite result");
		expect(result.trace).not.toContain("Compiling");
	});

	test("extracts trace from failing test output (tx reverted)", () => {
		const rawOutput = `Ran 1 test for test/InvalidatingTrace.t.sol:InvalidatingTrace
[FAIL] testTracing() (gas: 123456)
Traces:
  [905349] InvalidatingTrace::setUp()
    └─ [0] VM::startPrank(0x1234...)
        └─ ← [Return]

  [123456] InvalidatingTrace::testTracing()
    └─ [98765] 0xABCDEF1234567890abcdef1234567890ABCDEF12::swap(...)
        └─ ← [Revert] EvmError: Revert

Suite result: FAILED. 0 passed; 1 failed`;

		const result = extractTransactionTrace(rawOutput);

		expect(result.testPassed).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.trace).toContain("0xABCDEF1234567890abcdef1234567890ABCDEF12::swap");
		expect(result.trace).toContain("[Revert]");
	});

	test("handles output where testTracing was not reached", () => {
		const rawOutput = `Ran 1 test for test/InvalidatingTrace.t.sol:InvalidatingTrace
[FAIL: setUp failed] setUp() (gas: 0)
Traces:
  [905349] InvalidatingTrace::setUp()
    └─ ← [Revert] Some error

Suite result: FAILED. 0 passed; 1 failed`;

		const result = extractTransactionTrace(rawOutput);

		expect(result.testPassed).toBe(false);
		expect(result.trace).toBe("");
		expect(result.error).toContain("testTracing() was not reached");
	});

	test("handles ANSI color codes in output", () => {
		// Use actual escape sequences (not string literals)
		const ESC = "\x1b";
		const GREEN = `${ESC}[32m`;
		const RESET = `${ESC}[0m`;

		const rawOutput = `Ran 1 test for test/InvalidatingTrace.t.sol:InvalidatingTrace
${GREEN}[PASS]${RESET} testTracing() (gas: 123456)
Traces:
  [123456] ${GREEN}InvalidatingTrace${RESET}::${GREEN}testTracing${RESET}()
    └─ [98765] ${GREEN}0xABCDEF1234567890abcdef1234567890ABCDEF12${RESET}::${GREEN}swap${RESET}(...)
        └─ ${GREEN}← [Return]${RESET} 0x1234

Suite result: PASSED`;

		const result = extractTransactionTrace(rawOutput);

		expect(result.testPassed).toBe(true);
		expect(result.trace).toContain("0xABCDEF1234567890abcdef1234567890ABCDEF12");
		// ANSI codes should be preserved in output
		expect(result.trace).toContain(ESC);
	});

	test("normalizes indentation in output", () => {
		const rawOutput = `Ran 1 test for test/InvalidatingTrace.t.sol:InvalidatingTrace
[PASS] testTracing() (gas: 123456)
Traces:
  [123456] InvalidatingTrace::testTracing()
    └─ [98765] 0xABCDEF1234567890abcdef1234567890ABCDEF12::swap(...)
        ├─ [50000] 0x1111::nested(...)
        │   └─ ← [Return] true
        └─ ← [Return] 0x1234

Suite result: PASSED`;

		const result = extractTransactionTrace(rawOutput);

		// First line should not have leading spaces (normalized)
		expect(result.trace.startsWith("└─") || result.trace.match(/^\[/)).toBeTruthy();
	});
});

describe("getIndentLevel", () => {
	test("counts leading spaces", () => {
		expect(getIndentLevel("hello")).toBe(0);
		expect(getIndentLevel("  hello")).toBe(2);
		expect(getIndentLevel("    hello")).toBe(4);
	});

	test("ignores ANSI codes", () => {
		expect(getIndentLevel("\x1b[32mhello\x1b[0m")).toBe(0);
		expect(getIndentLevel("  \x1b[32mhello\x1b[0m")).toBe(2);
	});
});
