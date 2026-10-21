#!/usr/bin/env node
// Build orchestrator + provenance receipt for the Li runtime (li/stable).
//
// Usage:
//   node scripts/build-li.mjs [--offline] [--record-tests <results.json>]
//
// - [--offline] builds workspace packages without network (build:offline).
// - [--record-tests] merges a JSON test-summary file into the existing receipt
//   without rebuilding, so CI-like flows can append check/test evidence.
//
// The receipt lands at packages/coding-agent/dist/li-build-receipt.json (git
// ignored together with dist/) and is the single source `li --version` reads:
// base Pi version + pinned source SHA prove what binary is on disk.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neutralizeLiTerminalColorQuery } from "./li-osc-patch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const receiptPath = join(codingAgentDir, "dist", "li-build-receipt.json");
const bundleDir = join(codingAgentDir, "dist", "bundle");

function fail(message) {
	console.error(`[build-li] ${message}`);
	process.exit(1);
}

function git(args) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		fail(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
	}
	return result.stdout.trim();
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
		manifest,
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
	const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell, ...options });
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
	}
}

function collectProvenance() {
	const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	const fullSha = git(["rev-parse", "HEAD"]);
	const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	if (gitStatus.status !== 0) {
		fail(`git status failed: ${gitStatus.stderr.trim()}`);
	}
	const dirtyPaths = gitStatus.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	return {
		baseVersion: packageJson.version,
		packageName: packageJson.name,
		gitHead: fullSha,
		gitShortSha: fullSha.slice(0, 10),
		gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
		gitDirty: dirtyPaths.length > 0,
		gitDirtyPathCount: dirtyPaths.length,
		// Hash of the committed tree (paths + blob ids). Proves which source the
		// build started from; uncommitted edits are flagged via gitDirty.
		sourceTreeHash: sha256(git(["ls-files", "-s"])),
		nodeVersion: process.version,
		liCliPath: join(bundleDir, "cli.js"),
		profileSnapshotId: process.env.LI_PROFILE_SNAPSHOT_ID || null,
	};
}

function writeReceipt(record) {
	writeFileSync(receiptPath, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	console.log(`[build-li] receipt written: ${relative(repoRoot, receiptPath)}`);
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

const provenance = collectProvenance();
if (provenance.gitDirty) {
	console.warn(
		`[build-li] warning: worktree has ${provenance.gitDirtyPathCount} uncommitted path(s); ` +
			"the build is a candidate only and must not be promoted until the source is clean.",
	);
}

console.log(`[build-li] building Li from ${provenance.gitBranch}@${provenance.gitShortSha} (base v${provenance.baseVersion})`);
run("npm", ["run", options.offline ? "build:offline" : "build"]);

if (!existsSync(join(bundleDir, "cli.js"))) {
	fail(`Bundle build did not produce ${join(bundleDir, "cli.js")}`);
}

let terminalColorQueryPatch;
try {
	terminalColorQueryPatch = neutralizeLiTerminalColorQuery(bundleDir);
} catch (error) {
	fail(`Li OSC build-time patch failed closed: ${error instanceof Error ? error.message : String(error)}`);
}
const oscPatchReceipt = {
	schemaVersion: 1,
	runtime: "li",
	patchStrategy: "build-time",
	sourceSha: provenance.gitHead,
	profileSnapshotId: provenance.profileSnapshotId,
	packageVersion: provenance.baseVersion,
	bundleDir,
	patchedAt: new Date().toISOString(),
	...terminalColorQueryPatch,
};
writeFileSync(join(codingAgentDir, "dist", "li-osc-patch-receipt.json"), `${JSON.stringify(oscPatchReceipt, null, "\t")}\n`, "utf8");
console.log(`[build-li] Li OSC query ${terminalColorQueryPatch.status} (${terminalColorQueryPatch.markerCount} marker(s))`);

const artifact = hashTree(bundleDir);
writeReceipt({
	...provenance,
	builtAt: new Date().toISOString(),
	artifactHash: artifact.aggregateHash,
	artifactAlgorithm: artifact.algorithm,
	artifactFileCount: artifact.fileCount,
	terminalColorQueryPatch,
});
