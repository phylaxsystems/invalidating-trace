type LabelValue = string | number | boolean;
type LabelValues = Record<string, LabelValue>;

type MetricType = "counter" | "gauge" | "histogram";

type MetricEntry = {
	labels: Record<string, string>;
	value: number;
};

type HistogramEntry = {
	labels: Record<string, string>;
	buckets: number[];
	sum: number;
	count: number;
};

const DEFAULT_DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

const DEFAULT_SIZE_BUCKETS = [
	100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000,
	5_000_000, 10_000_000,
];

const DEFAULT_COUNT_BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100];

const DEFAULT_QUEUE_WAIT_BUCKETS = [
	0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
];

const normalizeLabelValue = (value: LabelValue | undefined): string => {
	if (value === undefined || value === null) {
		return "unknown";
	}
	return String(value);
};

const buildLabelValues = (
	labelNames: string[],
	labels: LabelValues | undefined,
): Record<string, string> => {
	const normalized: Record<string, string> = {};
	for (const name of labelNames) {
		normalized[name] = normalizeLabelValue(labels?.[name]);
	}
	return normalized;
};

const labelKey = (labelNames: string[], labels: LabelValues | undefined) =>
	labelNames.map((name) => `${name}:${normalizeLabelValue(labels?.[name])}`).join("|");

const escapeLabelValue = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const formatLabels = (
	labelNames: string[],
	labels: Record<string, string>,
): string => {
	if (labelNames.length === 0) {
		return "";
	}
	const parts = labelNames.map(
		(name) => `${name}="${escapeLabelValue(labels[name] ?? "unknown")}"`,
	);
	return `{${parts.join(",")}}`;
};

const formatLabelsWithLe = (
	labelNames: string[],
	labels: Record<string, string>,
	leValue: string,
): string => {
	const withLeNames = [...labelNames, "le"];
	const withLeLabels = { ...labels, le: leValue };
	return formatLabels(withLeNames, withLeLabels);
};

interface Metric {
	readonly name: string;
	readonly help: string;
	readonly type: MetricType;
	collect(lines: string[]): void;
}

class Counter implements Metric {
	readonly type: MetricType = "counter";
	private readonly values = new Map<string, MetricEntry>();
	constructor(
		public readonly name: string,
		public readonly help: string,
		private readonly labelNames: string[],
	) {}

	inc(labels: LabelValues = {}, value = 1): void {
		const key = labelKey(this.labelNames, labels);
		const entry = this.values.get(key);
		if (entry) {
			entry.value += value;
			return;
		}
		this.values.set(key, {
			labels: buildLabelValues(this.labelNames, labels),
			value,
		});
	}

	collect(lines: string[]): void {
		for (const entry of this.values.values()) {
			lines.push(
				`${this.name}${formatLabels(this.labelNames, entry.labels)} ${entry.value}`,
			);
		}
		if (this.values.size === 0 && this.labelNames.length === 0) {
			lines.push(`${this.name} 0`);
		}
	}
}

class Gauge implements Metric {
	readonly type: MetricType = "gauge";
	private readonly values = new Map<string, MetricEntry>();
	constructor(
		public readonly name: string,
		public readonly help: string,
		private readonly labelNames: string[],
	) {}

	set(labels: LabelValues = {}, value: number): void {
		const key = labelKey(this.labelNames, labels);
		const entry = this.values.get(key);
		if (entry) {
			entry.value = value;
			return;
		}
		this.values.set(key, {
			labels: buildLabelValues(this.labelNames, labels),
			value,
		});
	}

	inc(labels: LabelValues = {}, value = 1): void {
		const key = labelKey(this.labelNames, labels);
		const entry = this.values.get(key);
		if (entry) {
			entry.value += value;
			return;
		}
		this.values.set(key, {
			labels: buildLabelValues(this.labelNames, labels),
			value,
		});
	}

	dec(labels: LabelValues = {}, value = 1): void {
		this.inc(labels, -value);
	}

	collect(lines: string[]): void {
		for (const entry of this.values.values()) {
			lines.push(
				`${this.name}${formatLabels(this.labelNames, entry.labels)} ${entry.value}`,
			);
		}
		if (this.values.size === 0 && this.labelNames.length === 0) {
			lines.push(`${this.name} 0`);
		}
	}
}

class Histogram implements Metric {
	readonly type: MetricType = "histogram";
	private readonly values = new Map<string, HistogramEntry>();
	private readonly buckets: number[];
	constructor(
		public readonly name: string,
		public readonly help: string,
		labelNames: string[],
		buckets: number[],
	) {
		this.labelNames = labelNames;
		this.buckets = [...buckets].sort((a, b) => a - b);
	}

	private readonly labelNames: string[];

	observe(value: number, labels: LabelValues = {}): void {
		const key = labelKey(this.labelNames, labels);
		const entry = this.values.get(key);
		if (!entry) {
			const bucketCounts = new Array(this.buckets.length).fill(0);
			const newEntry: HistogramEntry = {
				labels: buildLabelValues(this.labelNames, labels),
				buckets: bucketCounts,
				sum: 0,
				count: 0,
			};
			this.values.set(key, newEntry);
			this.updateEntry(newEntry, value);
			return;
		}
		this.updateEntry(entry, value);
	}

	private updateEntry(entry: HistogramEntry, value: number): void {
		entry.count += 1;
		entry.sum += value;
		for (let i = 0; i < this.buckets.length; i += 1) {
			if (value <= this.buckets[i]) {
				entry.buckets[i] += 1;
			}
		}
	}

	collect(lines: string[]): void {
		for (const entry of this.values.values()) {
			let cumulative = 0;
			for (let i = 0; i < this.buckets.length; i += 1) {
				cumulative += entry.buckets[i];
				lines.push(
					`${this.name}_bucket${formatLabelsWithLe(
						this.labelNames,
						entry.labels,
						String(this.buckets[i]),
					)} ${cumulative}`,
				);
			}
			lines.push(
				`${this.name}_bucket${formatLabelsWithLe(
					this.labelNames,
					entry.labels,
					"+Inf",
				)} ${entry.count}`,
			);
			lines.push(
				`${this.name}_sum${formatLabels(this.labelNames, entry.labels)} ${entry.sum}`,
			);
			lines.push(
				`${this.name}_count${formatLabels(this.labelNames, entry.labels)} ${entry.count}`,
			);
		}
		if (this.values.size === 0 && this.labelNames.length === 0) {
			lines.push(`${this.name}_bucket{le="+Inf"} 0`);
			lines.push(`${this.name}_sum 0`);
			lines.push(`${this.name}_count 0`);
		}
	}
}

class MetricRegistry {
	private readonly metrics: Metric[] = [];

	counter(name: string, help: string, labelNames: string[] = []): Counter {
		const metric = new Counter(name, help, labelNames);
		this.metrics.push(metric);
		return metric;
	}

	gauge(name: string, help: string, labelNames: string[] = []): Gauge {
		const metric = new Gauge(name, help, labelNames);
		this.metrics.push(metric);
		return metric;
	}

	histogram(
		name: string,
		help: string,
		labelNames: string[] = [],
		buckets: number[] = DEFAULT_DURATION_BUCKETS,
	): Histogram {
		const metric = new Histogram(name, help, labelNames, buckets);
		this.metrics.push(metric);
		return metric;
	}

	render(): string {
		const lines: string[] = [];
		for (const metric of this.metrics) {
			lines.push(`# HELP ${metric.name} ${metric.help}`);
			lines.push(`# TYPE ${metric.name} ${metric.type}`);
			metric.collect(lines);
		}
		return `${lines.join("\n")}\n`;
	}
}

const registry = new MetricRegistry();
const appStartTimeSeconds = Math.floor(Date.now() / 1000);
const serviceName = process.env.SERVICE_NAME ?? "invalidating-trace";
const serviceVersion = process.env.SERVICE_VERSION ?? "unknown";
const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";

export const metrics = {
	appInfo: registry.gauge(
		"app_info",
		"Static info about the running service.",
		["service", "version", "bun_version"],
	),
	processStartTimeSeconds: registry.gauge(
		"process_start_time_seconds",
		"Process start time in unix seconds.",
	),
	processUptimeSeconds: registry.gauge(
		"process_uptime_seconds",
		"Process uptime in seconds.",
	),
	processResidentMemoryBytes: registry.gauge(
		"process_resident_memory_bytes",
		"Resident memory size in bytes.",
	),
	processHeapTotalBytes: registry.gauge(
		"process_heap_total_bytes",
		"Total heap size in bytes.",
	),
	processHeapUsedBytes: registry.gauge(
		"process_heap_used_bytes",
		"Used heap size in bytes.",
	),
	processExternalMemoryBytes: registry.gauge(
		"process_external_memory_bytes",
		"External memory size in bytes.",
	),
	processArrayBuffersBytes: registry.gauge(
		"process_array_buffers_bytes",
		"ArrayBuffers memory usage in bytes.",
	),
	processCpuUserSecondsTotal: registry.gauge(
		"process_cpu_user_seconds_total",
		"Cumulative user CPU time spent in seconds.",
	),
	processCpuSystemSecondsTotal: registry.gauge(
		"process_cpu_system_seconds_total",
		"Cumulative system CPU time spent in seconds.",
	),
	httpRequestsTotal: registry.counter(
		"http_requests_total",
		"Total HTTP requests by method, path, and status.",
		["method", "path", "status"],
	),
	httpRequestDurationSeconds: registry.histogram(
		"http_request_duration_seconds",
		"HTTP request duration in seconds.",
		["method", "path"],
	),
	httpRequestSizeBytes: registry.histogram(
		"http_request_size_bytes",
		"HTTP request size in bytes.",
		["method", "path"],
		DEFAULT_SIZE_BUCKETS,
	),
	httpResponseSizeBytes: registry.histogram(
		"http_response_size_bytes",
		"HTTP response size in bytes.",
		["method", "path"],
		DEFAULT_SIZE_BUCKETS,
	),
	httpRequestsInFlight: registry.gauge(
		"http_requests_in_flight",
		"Number of HTTP requests currently being processed.",
	),
	authRequestsTotal: registry.counter(
		"auth_requests_total",
		"Authentication requests by result.",
		["result"],
	),
	traceRequestsTotal: registry.counter(
		"trace_requests_total",
		"Trace requests queued or rejected.",
		["result"],
	),
	traceRequestMissingFieldsTotal: registry.counter(
		"trace_request_missing_fields_total",
		"Missing required fields in trace requests.",
		["field"],
	),
	traceRequestsInFlight: registry.gauge(
		"trace_requests_in_flight",
		"Trace jobs currently executing.",
	),
	traceDurationSeconds: registry.histogram(
		"trace_duration_seconds",
		"Trace processing duration in seconds.",
		["status"],
	),
	traceResultsTotal: registry.counter(
		"trace_results_total",
		"Trace results by status.",
		["status"],
	),
	tracePreviousTransactions: registry.histogram(
		"trace_previous_transactions",
		"Count of previous transactions included per trace request.",
		[],
		DEFAULT_COUNT_BUCKETS,
	),
	forgeRunsTotal: registry.counter(
		"forge_runs_total",
		"Forge test runs by status.",
		["status"],
	),
	forgeRunExitCodeTotal: registry.counter(
		"forge_run_exit_code_total",
		"Forge run exit codes.",
		["code"],
	),
	forgeRunDurationSeconds: registry.histogram(
		"forge_run_duration_seconds",
		"Forge test run duration in seconds.",
	),
	forgeRunStdoutBytes: registry.histogram(
		"forge_run_stdout_bytes",
		"Forge test stdout size in bytes.",
		[],
		DEFAULT_SIZE_BUCKETS,
	),
	forgeRunStderrBytes: registry.histogram(
		"forge_run_stderr_bytes",
		"Forge test stderr size in bytes.",
		[],
		DEFAULT_SIZE_BUCKETS,
	),
	forgeQueueDepth: registry.gauge(
		"forge_queue_depth",
		"Number of forge runs waiting in queue.",
	),
	forgeQueueWaitSeconds: registry.histogram(
		"forge_queue_wait_seconds",
		"Time spent waiting in the forge queue before execution.",
		[],
		DEFAULT_QUEUE_WAIT_BUCKETS,
	),
	forgeRunsInFlight: registry.gauge(
		"forge_runs_in_flight",
		"Number of forge runs currently executing.",
	),
	foundryChecksTotal: registry.counter(
		"foundry_checks_total",
		"Foundry checks by type and result.",
		["check", "result"],
	),
	callbackRequestsTotal: registry.counter(
		"callback_requests_total",
		"Callback delivery attempts by status and HTTP status code.",
		["status", "http_status"],
	),
	callbackDurationSeconds: registry.histogram(
		"callback_duration_seconds",
		"Callback request duration in seconds.",
		["status"],
	),
	callbackPayloadBytes: registry.histogram(
		"callback_payload_bytes",
		"Callback payload size in bytes.",
		[],
		DEFAULT_SIZE_BUCKETS,
	),
	runTestsRequestsTotal: registry.counter(
		"run_tests_requests_total",
		"/api/run-tests calls by result.",
		["result"],
	),
	runTestsDurationSeconds: registry.histogram(
		"run_tests_duration_seconds",
		"/api/run-tests duration in seconds.",
	),
	configWarningsTotal: registry.counter(
		"config_warnings_total",
		"Configuration warnings by name.",
		["name"],
	),
	shutdownSignalsTotal: registry.counter(
		"shutdown_signals_total",
		"Shutdown signals received.",
		["signal"],
	),
};

metrics.appInfo.set(
	{ service: serviceName, version: serviceVersion, bun_version: bunVersion },
	1,
);
metrics.processStartTimeSeconds.set({}, appStartTimeSeconds);

export const collectProcessMetrics = () => {
	const nowSeconds = Date.now() / 1000;
	metrics.processUptimeSeconds.set({}, nowSeconds - appStartTimeSeconds);

	const memory = process.memoryUsage();
	metrics.processResidentMemoryBytes.set({}, memory.rss);
	metrics.processHeapTotalBytes.set({}, memory.heapTotal);
	metrics.processHeapUsedBytes.set({}, memory.heapUsed);
	metrics.processExternalMemoryBytes.set({}, memory.external);
	if (typeof memory.arrayBuffers === "number") {
		metrics.processArrayBuffersBytes.set({}, memory.arrayBuffers);
	}

	const cpu = process.cpuUsage();
	metrics.processCpuUserSecondsTotal.set({}, cpu.user / 1e6);
	metrics.processCpuSystemSecondsTotal.set({}, cpu.system / 1e6);
};

export const renderMetrics = (): string => {
	collectProcessMetrics();
	return registry.render();
};
