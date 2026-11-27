/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */

const ENABLED = process.env.PI_TIMING === "1";
interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
}

type TimingLabel = "main" | "extensions" | "resources";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();
const wallClockTimings = new Map<TimingLabel, Array<{ path: string; ms: number }>>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
	// Leftover per-import entries belong to the previous (aborted) pass: without dropping them a
	// reload that threw mid-way would be double-counted in the next flush.
	wallClockTimings.delete(namespace);
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

/**
 * Wall-clock span measurement. Unlike `time()`, the recorded duration is the span between the
 * returned stop() call and its own start, so interleaved phases (extension imports running between
 * two resource scans) cannot leak into each other's delta chains.
 */
export function measureTiming(label: string, namespace: TimingLabel = "main"): () => void {
	if (!ENABLED) return () => {};
	const start = Date.now();
	return () => {
		if (!ENABLED) return;
		const now = Date.now();
		if (!timingNamespaces.has(namespace)) {
			resetTimings(namespace);
		}
		const timingNamespace = timingNamespaces.get(namespace)!;
		timingNamespace.timings.push({ label, ms: now - start });
		timingNamespace.lastTime = now;
	};
}

/**
 * Record one module import's own wall-clock duration. Delta chains (`time()`) are wrong once
 * imports run in parallel: resolution order no longer matches start order, so each promise must
 * carry its own start timestamp.
 */
export function recordImportWallTime(namespace: TimingLabel, path: string, ms: number): void {
	if (!ENABLED) return;
	let entries = wallClockTimings.get(namespace);
	if (!entries) {
		entries = [];
		wallClockTimings.set(namespace, entries);
	}
	entries.push({ path, ms });
}

function printTimingGroup(
	title: string,
	timings: TimingNamespace["timings"],
	wallEntries?: Array<{ path: string; ms: number }>,
): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0 && (!wallEntries || wallEntries.length === 0)) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	if (printableTimings.length > 0) {
		console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0)}ms`);
	}
	if (wallEntries && wallEntries.length > 0) {
		console.error(`  --- per-import wall-clock (sorted by path) ---`);
		for (const entry of [...wallEntries].sort((a, b) => a.path.localeCompare(b.path))) {
			console.error(`  ${entry.path}: ${entry.ms}ms`);
		}
		console.error(`  WALL TOTAL: ${wallEntries.reduce((a, b) => a + b.ms, 0)}ms`);
	}
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

function printNamespace(namespace: TimingLabel): void {
	const timingNamespace = timingNamespaces.get(namespace);
	if (timingNamespace) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings, wallClockTimings.get(namespace));
		resetTimings(namespace);
	}
	wallClockTimings.delete(namespace);
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace] of timingNamespaces) {
		printNamespace(namespace);
	}
}

/**
 * Print and clear only the given namespaces. Used by resource reload so post-start
 * `/new`, `/resume`, `/reload` timings are captured too: `printTimings()` only runs once,
 * before `interactiveMode.run()`, and would miss every reload after that.
 */
export function flushTimings(namespaces: TimingLabel[]): void {
	if (!ENABLED) return;
	for (const namespace of namespaces) {
		printNamespace(namespace);
	}
}
