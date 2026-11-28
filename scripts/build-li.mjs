#!/usr/bin/env node
// Build orchestrator + journal + recovery for the Li runtime (li/stable).
//
// Usage:
//   node scripts/build-li.mjs [--offline] [--record-tests <results.json>]
//
// - [--offline] builds workspace packages without network (build:offline).
// - [--record-tests] merges a JSON test-summary file into the existing receipt
//   without rebuilding, so CI-like flows can append check/test evidence.
//
// Division of labour (SPEC-2026-11-28-li-build-resilience):
// - The bundler (build-coding-agent-bundle.mjs) owns the two-phase receipt: it
//   hashes its staging dir, parks dist/li-build-receipt.json.tmp with full
//   provenance before the fail-closed swap, and renames it into place after.
// - This script owns the build lock (dist/.bundle-lock, stale-aware via
//   pid + process start-time), the build journal, recovery from
//   bundle.old-<attemptId> markers, receipt healing, and journals
//   started/ok/fail. The receipt lands at
//   packages/coding-agent/dist/li-build-receipt.json (git ignored together
//   with dist/) and is the single source `li --version` reads.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const receiptPath = join(codingAgentDistDir, "li-build-receipt.json");
const receiptTmpPath = `${receiptPath}.tmp`;
const lockDir = join(codingAgentDistDir, ".bundle-lock");
const journalPath = process.env.LI_BUILD_JOURNAL || join(homedir(), ".pi", "agent", "li-build-journal.jsonl");
// bundle.old-<attemptId> with attemptId = <epochMs zero-pad 13>-<pid>.
// bundle.old-consumed-<attemptId> (renamed after a failed delete) never matches.
const oldMarkerPattern = /^bundle\.old-(\d{13}-\d+)$/;
const stagingPrefix = "bundle.staging.";
// Injected bundler fault exits (LI_BUNDLE_FAULT); any other non-zero child
// exit is journaled as stage=crash.
const faultStageByExitCode = { 64: "esbuild", 65: "swap1", 66: "swap2", 67: "promote", 68: "swap3", 69: "pretmp" };

function fail(message, exitCode = 1) {
	console.error(`[build-li] ${message}`);
	process.exit(exitCode);
}

function failAfterStart(message, exitCode = 1) {
	appendJournal({ kind: "fail", stage: "crash", exitCode, detail: message });
	releaseLock();
	fail(message, exitCode);
}

// Journal schema is shared verbatim with the bundler and the bin/li launchers;
// see SPEC-2026-11-28-li-build-resilience Task 2.
function appendJournal(fields) {
	const entry = {
		schemaVersion: 1,
		ts: new Date().toISOString(),
		kind: fields.kind,
		pid: process.pid,
		liRoot: repoRoot,
	};
	if (fields.attemptId) entry.attemptId = fields.attemptId;
	if (fields.stage) entry.stage = fields.stage;
	if (Number.isFinite(fields.exitCode)) entry.exitCode = fields.exitCode;
	if (fields.artifactHash) entry.artifactHash = fields.artifactHash;
	if (fields.gitShortSha !== undefined) entry.gitShortSha = fields.gitShortSha;
	if (fields.gitDirty !== undefined) entry.gitDirty = fields.gitDirty;
	entry.detail = String(fields.detail ?? "")
		.slice(0, 200)
		.replace(/[^\x20-\x7E]/g, "?");
	try {
		mkdirSync(dirname(journalPath), { recursive: true });
		appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Journal is best-effort forensics; never fail the build for it.
	}
}

function lastJournalEntry() {
	try {
		const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
		for (let index = lines.length - 1; index >= 0; index--) {
			if (!lines[index].trim()) continue;
			return JSON.parse(lines[index]);
		}
	} catch {
		return null;
	}
	return null;
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function hashTree(rootDir) {
	const entries = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else {
				entries.push({ path: relative(rootDir, full).replaceAll("\\", "/"), hash: sha256(readFileSync(full)) });
			}
		}
	};
	walk(rootDir);
	const manifest = entries.map((entry) => `${entry.path}:${entry.hash}`).join("\n");
	return {
		algorithm: "sha256",
		aggregateHash: sha256(manifest),
		fileCount: entries.length,
	};
}

function parseArgs(argv) {
	const options = { offline: false, recordTests: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--offline") {
			options.offline = true;
		} else if (arg === "--record-tests") {
			const value = argv[++index];
			if (!value) fail("--record-tests requires a JSON file path");
			options.recordTests = resolve(value);
		} else {
			fail(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function run(command, args, options = {}) {
	console.log(`[build-li] > ${command} ${args.join(" ")}`);
	// npm/pnpm are .cmd shims on Windows; spawnSync needs a shell to resolve them.
	const shell = process.platform === "win32";
	return spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell, ...options });
}

function processStartTime(pid) {
	try {
		if (process.platform === "win32") {
			return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTime()`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		}
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function readLockOwner() {
	try {
		return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
	} catch {
		return null;
	}
}

// "stale" = owner pid is dead, or a different process reused the pid
// (start-time mismatch). Unreadable start-time, empty recorded start, or a
// cross-format start (sh lstart vs Windows FileTime) fails safe to alive.
function lockState() {
	const owner = readLockOwner();
	if (!owner || typeof owner.pid !== "number" || owner.pid <= 0) return "unknown";
	let alive = false;
	try {
		process.kill(owner.pid, 0);
		alive = true;
	} catch {}
	if (!alive) return "stale";
	const start = processStartTime(owner.pid);
	if (start === null) return "alive";
	const stored = String(owner.start ?? "");
	if (!stored) return "alive";
	const isFileTime = (value) => /^\d{15,}$/.test(value);
	if (isFileTime(stored) !== isFileTime(start)) return "alive";
	return start === stored ? "alive" : "stale";
}

function acquireLock() {
	mkdirSync(codingAgentDistDir, { recursive: true });
	for (let attempt = 0; attempt < 25; attempt++) {
		try {
			// Non-recursive on purpose: EEXIST is the signal that someone holds it.
			mkdirSync(lockDir);
			writeFileSync(
				join(lockDir, "owner.json"),
				`${JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) ?? "" })}\n`,
			);
			return;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (lockState() === "stale") {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			fail(
				`Another Li build appears to be running (lock held by pid ${readLockOwner()?.pid ?? "?"}). ` +
					`If no build is active, remove ${lockDir} manually.`,
			);
		}
	}
	fail(`Could not acquire the build lock after stale take-over attempts: ${lockDir}`);
}

function releaseLock() {
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch {}
}

// Remove staging dirs left behind by dead processes; live-pid staging belongs
// to the bundler currently running under the lock.
function sweepStaleStaging() {
	const removed = [];
	if (!existsSync(codingAgentDistDir)) return removed;
	for (const name of readdirSync(codingAgentDistDir)) {
		if (!name.startsWith(stagingPrefix)) continue;
		const pid = Number(name.slice(stagingPrefix.length).split("-")[1]);
		if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
			let alive = false;
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {}
			if (alive) continue;
		}
		rmSync(join(codingAgentDistDir, name), { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}

function listRestorableOldMarkers() {
	if (!existsSync(codingAgentDistDir)) return [];
	const candidates = [];
	for (const name of readdirSync(codingAgentDistDir)) {
		const match = oldMarkerPattern.exec(name);
		if (!match) continue;
		const markerDir = join(codingAgentDistDir, name);
		if (!statSync(markerDir).isDirectory() || !existsSync(join(markerDir, "cli.js"))) continue;
		candidates.push({ name, attemptId: match[1] });
	}
	candidates.sort((a, b) => (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0));
	return candidates;
}

// Returns the restored marker name, or null when no restore happened.
function restoreBundleFromOldMarker(notes) {
	if (existsSync(join(bundleDir, "cli.js"))) return null;
	const candidates = listRestorableOldMarkers();
	if (candidates.length === 0) return null;
	const newest = candidates[candidates.length - 1];
	if (existsSync(bundleDir)) {
		const message = `${bundleDir} exists without cli.js; refusing to restore over it`;
		console.warn(`[build-li] warning: ${message}`);
		notes.push(message);
		return null;
	}
	renameSync(join(codingAgentDistDir, newest.name), bundleDir);
	return newest.name;
}

function readReceiptTmp() {
	try {
		const parsed = JSON.parse(readFileSync(receiptTmpPath, "utf8"));
		return typeof parsed?.attemptId === "string" ? parsed : null;
	} catch {
		return null;
	}
}

function writeReceipt(record) {
	writeFileSync(receiptPath, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
}

// Heal the receipt from the live bundle when no provenance can be proven:
// git fields stay null; `li --version` shows "source ?" until the next build.
function writeHealedReceipt(artifact) {
	const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	writeReceipt({
		healed: true,
		provenanceSource: "heal",
		baseVersion: packageJson.version,
		packageName: packageJson.name,
		gitHead: null,
		gitShortSha: null,
		gitBranch: null,
		gitDirty: null,
		gitDirtyPathCount: null,
		sourceTreeHash: null,
		nodeVersion: process.version,
		liCliPath: join(bundleDir, "cli.js"),
		profileSnapshotId: null,
		builtAt: new Date().toISOString(),
		artifactHash: artifact.aggregateHash,
		artifactAlgorithm: artifact.algorithm,
		artifactFileCount: artifact.fileCount,
		terminalColorQueryPatch: null,
	});
}

// Receipt hygiene after a tmp decision: a receipt already describing the live
// bytes stays untouched (byte-identical rebuilds must not "heal" it); a stale
// or missing receipt is healed from the live bundle with provenance unknown.
function reconcileReceiptWithLive(liveArtifact, contextDetail, notes) {
	if (existsSync(receiptPath)) {
		const kept = JSON.parse(readFileSync(receiptPath, "utf8"));
		if (kept.artifactHash === liveArtifact.aggregateHash) {
			appendJournal({
				kind: "receipt-heal",
				artifactHash: liveArtifact.aggregateHash,
				gitShortSha: kept.gitShortSha ?? null,
				gitDirty: kept.gitDirty ?? null,
				detail: `${contextDetail}; receipt kept`,
			});
			return;
		}
	}
	writeHealedReceipt(liveArtifact);
	appendJournal({
		kind: "receipt-heal",
		artifactHash: liveArtifact.aggregateHash,
		gitShortSha: null,
		gitDirty: null,
		detail: `${contextDetail}; ${existsSync(receiptPath) ? "stale receipt" : "receipt missing"} healed from live`,
	});
	notes.push("receipt healed from live");
}

// Recovery + receipt.tmp decision, run inside the lock at the start of a build.
function recoverAndHeal() {
	const notes = [];
	const restoredMarker = restoreBundleFromOldMarker(notes);
	if (restoredMarker) {
		appendJournal({ kind: "recovered", detail: `restored ${restoredMarker}` });
		notes.push(`restored ${restoredMarker}`);
	}

	const liveCli = existsSync(join(bundleDir, "cli.js"));
	const tmp = readReceiptTmp();

	if (tmp && !liveCli) {
		// Nothing live to reconcile against; the build below creates both.
		rmSync(receiptTmpPath, { force: true });
		notes.push("discarded receipt.tmp (no live bundle)");
	} else if (tmp && liveCli) {
		const liveArtifact = hashTree(bundleDir);
		const markerName = `bundle.old-${tmp.attemptId}`;
		const markerExists = oldMarkerPattern.test(markerName) && existsSync(join(codingAgentDistDir, markerName));
		if (restoredMarker) {
			// A restored old marker never proves the tmp candidate's provenance.
			rmSync(receiptTmpPath, { force: true });
			const detail = `restored ${restoredMarker}; receipt.tmp discarded (unproven after restore)`;
			notes.push(detail);
			reconcileReceiptWithLive(liveArtifact, detail, notes);
		} else if (markerExists && tmp.artifactHash === liveArtifact.aggregateHash) {
			// Swap completed but the receipt promote crashed: the marker name
			// proves the attempt, the hash proves the bytes are the candidate.
			renameSync(receiptTmpPath, receiptPath);
			appendJournal({
				kind: "receipt-heal",
				attemptId: tmp.attemptId,
				artifactHash: tmp.artifactHash,
				gitShortSha: tmp.gitShortSha,
				gitDirty: tmp.gitDirty,
				detail: "promoted receipt.tmp (marker + hash match)",
			});
			notes.push(`promoted receipt.tmp ${tmp.attemptId}`);
		} else {
			const reason = !markerExists
				? `no marker ${markerName} (pre-swap crash or stale attempt)`
				: "artifactHash mismatch with live bundle";
			rmSync(receiptTmpPath, { force: true });
			const detail = `discarded receipt.tmp (${reason})`;
			notes.push(detail);
			reconcileReceiptWithLive(liveArtifact, detail, notes);
		}
	}

	if (!existsSync(join(bundleDir, "cli.js"))) {
		notes.push("no live bundle before build");
	} else if (!existsSync(receiptPath)) {
		const artifact = hashTree(bundleDir);
		writeHealedReceipt(artifact);
		appendJournal({
			kind: "receipt-heal",
			artifactHash: artifact.aggregateHash,
			gitShortSha: null,
			gitDirty: null,
			detail: "receipt missing; healed from live bundle",
		});
		notes.push("receipt healed from live");
	}

	// Leftover old markers are never needed after the decision above.
	if (existsSync(codingAgentDistDir)) {
		for (const name of readdirSync(codingAgentDistDir)) {
			if (!name.startsWith("bundle.old-")) continue;
			const markerDir = join(codingAgentDistDir, name);
			if (!statSync(markerDir).isDirectory()) continue;
			try {
				rmSync(markerDir, { recursive: true, force: true });
				notes.push(`cleaned ${name}`);
			} catch {
				notes.push(`could not clean ${name}`);
			}
		}
	}
	return notes;
}

const options = parseArgs(process.argv.slice(2));

if (options.recordTests) {
	if (!existsSync(receiptPath)) fail(`Receipt not found: ${receiptPath}. Build first.`);
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	let testResults;
	try {
		testResults = JSON.parse(readFileSync(options.recordTests, "utf8"));
	} catch (error) {
		fail(`Could not read test results ${options.recordTests}: ${error.message}`);
	}
	receipt.testOutputs = testResults;
	receipt.testOutputsRecordedAt = new Date().toISOString();
	writeReceipt(receipt);
	process.exit(0);
}

if (!existsSync(join(repoRoot, "node_modules"))) {
	fail("node_modules is missing at the Li worktree root. Run: npm ci --ignore-scripts");
}

acquireLock();
try {
	appendJournal({ kind: "started", detail: options.offline ? "build started (--offline)" : "build started" });

	let notes;
	try {
		notes = recoverAndHeal();
	} catch (error) {
		failAfterStart(`recovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	notes.push(...sweepStaleStaging().map((name) => `swept staging ${name}`));

	console.log(`[build-li] building Li runtime (${options.offline ? "offline" : "online"})`);
	// The bundler child re-enters this lock via LI_LOCK_PID instead of
	// acquiring its own, so recovery -> swap -> receipt stay serialized.
	const childEnv = { ...process.env, LI_LOCK_PID: String(process.pid) };
	const result = run("npm", ["run", options.offline ? "build:offline" : "build"], { env: childEnv });
	if (result.status !== 0) {
		const exitCode = result.status ?? 1;
		const stage = faultStageByExitCode[exitCode] ?? "crash";
		// The bundler journals its own injected faults; only add a crash entry
		// when the child died without journaling (no double entry per attempt).
		const last = lastJournalEntry();
		if (!last || last.kind !== "fail") {
			appendJournal({ kind: "fail", stage, exitCode, detail: `build child exited with code ${exitCode}` });
		}
		releaseLock();
		fail(`build exited with code ${exitCode}`, exitCode);
	}

	if (!existsSync(join(bundleDir, "cli.js"))) {
		failAfterStart(`Bundle build did not produce ${join(bundleDir, "cli.js")}`);
	}

	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	appendJournal({
		kind: "ok",
		attemptId: receipt.attemptId,
		artifactHash: receipt.artifactHash,
		gitShortSha: receipt.gitShortSha,
		gitDirty: receipt.gitDirty,
		detail: [...notes, "build ok"].join("; "),
	});
	console.log(
		`[build-li] receipt: source ${receipt.gitShortSha ?? "?"} artifact ${String(receipt.artifactHash ?? "").slice(0, 12)}`,
	);
} finally {
	releaseLock();
}
