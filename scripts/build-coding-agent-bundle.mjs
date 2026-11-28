#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { neutralizeLiTerminalColorQuery } from "./li-osc-patch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const receiptPath = join(codingAgentDistDir, "li-build-receipt.json");
const receiptTmpPath = `${receiptPath}.tmp`;
const lockDir = join(codingAgentDistDir, ".bundle-lock");
const journalPath = process.env.LI_BUILD_JOURNAL || join(homedir(), ".pi", "agent", "li-build-journal.jsonl");
// Injected failure points (LI_BUNDLE_FAULT), used only for verify runs; unset
// means a normal build. Exit codes are part of the build-li contract.
const faultExitCodes = { esbuild: 64, swap1: 65, swap2: 66, promote: 67, swap3: 68, pretmp: 69 };
const fault = process.env.LI_BUNDLE_FAULT ?? "";
const stagingPrefix = "bundle.staging.";
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source uses jiti/static so Bun embeds its Babel transform. The Node
		// package replaces it with a synchronous lazy require so jiti loads only
		// when importing an extension; Babel remains deferred until a cache miss
		// needs transformation.
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
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

// Journal schema is shared verbatim with scripts/build-li.mjs and the bin/li
// launchers; see SPEC-2026-11-28-li-build-resilience Task 2.
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

function failFaultedBuild(stage, detail) {
	const exitCode = faultExitCodes[stage];
	appendJournal({ kind: "fail", stage, exitCode, attemptId, detail });
	console.error(`[bundle] injected fault ${stage}: exiting ${exitCode} (${detail})`);
	process.exit(exitCode);
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

function acquireBundleLock() {
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
			throw new Error(
				`Another Li build appears to be running (bundle lock held by pid ${readLockOwner()?.pid ?? "?"}). ` +
					`If no build is active, remove ${lockDir} manually.`,
			);
		}
	}
	throw new Error(`Could not acquire the bundle lock after stale take-over attempts: ${lockDir}`);
}

function releaseBundleLock() {
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch {}
}

// Remove staging dirs left behind by dead processes. Staging of a live pid is
// left alone: it belongs to the bundler currently holding the lock.
function sweepStaleStaging() {
	if (!existsSync(codingAgentDistDir)) return;
	for (const name of readdirSync(codingAgentDistDir)) {
		if (!name.startsWith("bundle.staging.")) continue;
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
	}
}

function git(args) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
	}
	return result.stdout.trim();
}

// Duplicated from build-li by design (T1): the bundler writes the full
// receipt.tmp itself, before the swap, so a crash can never lose provenance.
function collectProvenance() {
	const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	const fullSha = git(["rev-parse", "HEAD"]);
	const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	if (gitStatus.status !== 0) {
		throw new Error(`git status failed: ${gitStatus.stderr.trim()}`);
	}
	const dirtyPaths = gitStatus.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return {
		baseVersion: packageJson.version,
		packageName: packageJson.name,
		gitHead: fullSha,
		gitShortSha: fullSha.slice(0, 10),
		gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
		gitDirty: dirtyPaths.length > 0,
		gitDirtyPathCount: dirtyPaths.length,
		sourceTreeHash: sha256(git(["ls-files", "-s"])),
		nodeVersion: process.version,
		liCliPath: join(bundleDir, "cli.js"),
		profileSnapshotId: process.env.LI_PROFILE_SNAPSHOT_ID || null,
	};
}

// --- fail-closed bundle lifecycle -----------------------------------------
// The live bundle is only ever replaced by an atomic rename from a fully
// validated staging dir; every failure keeps the previous bundle intact.

const parentLockPid = Number(process.env.LI_LOCK_PID ?? "");
const reentrant = Number.isSafeInteger(parentLockPid) && parentLockPid > 0;
let ownsBundleLock = false;
if (reentrant) {
	const owner = readLockOwner();
	if (!owner || owner.pid !== parentLockPid) {
		throw new Error(
			`Bundle lock owner mismatch: LI_LOCK_PID=${parentLockPid} but the lock is ${owner ? `held by pid ${owner.pid}` : "unreadable"}`,
		);
	}
} else {
	acquireBundleLock();
	ownsBundleLock = true;
}

// attemptId: epoch-ms zero-padded to 13 digits so string sort == time sort.
const attemptId = `${String(Date.now()).padStart(13, "0")}-${process.pid}`;
const stagingDir = join(codingAgentDistDir, `bundle.staging.${attemptId}`);

sweepStaleStaging();
mkdirSync(stagingDir, { recursive: true });
if (fault === "esbuild") {
	failFaultedBuild("esbuild", "injected esbuild failure");
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(codingAgentDistDir, "extensions", "codemode", "worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: stagingDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
const configOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/config.js");
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyEntryPoints = {
	anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
	"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
	"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
	"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
	meta: join(aiDistDir, "auth", "oauth", "meta.js"),
	"openai-chatgpt": join(aiDistDir, "auth", "oauth", "openai-chatgpt.js"),
	"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
	openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
	radius: join(aiDistDir, "auth", "oauth", "radius.js"),
	xai: join(aiDistDir, "auth", "oauth", "xai.js"),
};

// Every OAuth flow loaded through importOAuthModule() must have a lazy entry,
// otherwise the flow fails at runtime with a missing module error.
const oauthLoadSource = readFileSync(join(repoRoot, "packages", "ai", "src", "auth", "oauth", "load.ts"), "utf8");
for (const match of oauthLoadSource.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)) {
	if (!(match[1] in lazyEntryPoints)) {
		throw new Error(`OAuth flow "${match[1]}" is lazily imported but has no lazy bundle entry`);
	}
}

const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: lazyEntryPoints,
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

// getCodemodeWorkerSpecifier() in config.ts spawns the codemode worker from an in-memory data: URL
// so codemode survives an update that replaces or deletes the install (#10439). A data: URL module
// has no file location, so the worker must not use the createRequire(import.meta.url) banner,
// require(), or imports other than Node builtins.
const codemodeWorkerResult = await build({
	...commonBuildOptions(),
	banner: undefined,
	entryNames: "[name]",
	entryPoints: { "codemode-worker": join(codingAgentDistDir, "extensions", "codemode", "worker.js") },
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});
for (const [outputPath, output] of Object.entries(codemodeWorkerResult.metafile.outputs)) {
	const invalid = output.imports.filter((imported) => imported.kind !== "import-statement" || !isBuiltin(imported.path));
	if (invalid.length > 0) {
		throw new Error(
			`Codemode worker must only import Node builtins: ${invalid.map((imported) => imported.path).join(", ")}`,
		);
	}
	if (readFileSync(resolve(repoRoot, outputPath), "utf8").includes("import.meta")) {
		throw new Error("Codemode worker must not use import.meta");
	}
}

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}
// getCodemodeWorkerUrl() in config.ts resolves the worker next to its own chunk.
if (dirname(configOutput) !== dirname(bedrockLoaderOutput)) {
	throw new Error("config.ts and the codemode worker were emitted into different directories");
}

const metafiles = [mainResult.metafile, lazyResult.metafile, codemodeWorkerResult.metafile];
validateExternalImports(metafiles);
const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(stagingDir, "cli.js"), cliLauncher);
chmodSync(join(stagingDir, "cli.js"), 0o755);
chmodSync(join(stagingDir, "rpc-entry.js"), 0o755);

// Patch the OSC color query on the candidate, then hash what will actually go
// live, and park the full receipt as .tmp before touching the live bundle.
let terminalColorQueryPatch;
try {
	terminalColorQueryPatch = neutralizeLiTerminalColorQuery(stagingDir);
} catch (error) {
	throw new Error(`Li OSC build-time patch failed closed: ${error instanceof Error ? error.message : String(error)}`);
}

const provenance = collectProvenance();
if (provenance.gitDirty) {
	console.warn(
		`[bundle] warning: worktree has ${provenance.gitDirtyPathCount} uncommitted path(s); ` +
			"the build is a candidate only and must not be promoted until the source is clean.",
	);
}
const artifact = hashTree(stagingDir);
writeFileSync(
	receiptTmpPath,
	`${JSON.stringify(
		{
			...provenance,
			builtAt: new Date().toISOString(),
			artifactHash: artifact.aggregateHash,
			artifactAlgorithm: artifact.algorithm,
			artifactFileCount: artifact.fileCount,
			terminalColorQueryPatch,
			attemptId,
		},
		null,
		"\t",
	)}\n`,
	"utf8",
);
if (fault === "pretmp") {
	failFaultedBuild("pretmp", "exited after receipt.tmp, before the swap");
}

// Swap: bundle -> bundle.old-<attemptId>, then staging -> bundle. Rename 2 fail
// rolls back; a rollback failure leaves the old marker holding the live bundle
// (recovered by the launcher / next build-li run).
const oldDir = join(codingAgentDistDir, `bundle.old-${attemptId}`);
const hadLiveBundle = existsSync(bundleDir);
try {
	if (fault === "swap1") throw new Error("injected swap1 failure (first rename)");
	if (hadLiveBundle) renameSync(bundleDir, oldDir);
	if (fault === "swap2") {
		// Hard exit mid-swap: no catch runs, the old marker keeps the live bundle.
		failFaultedBuild("swap2", "hard-exit after the first rename");
	}
	if (fault === "swap3") throw new Error("injected swap3 failure (second rename)");
	renameSync(stagingDir, bundleDir);
} catch (error) {
	if (fault === "swap3") {
		// Injected rollback failure: the old marker keeps the live bundle.
		failFaultedBuild("swap3", "injected rollback failure");
	}
	let rollbackFailed = false;
	if (hadLiveBundle && existsSync(oldDir) && !existsSync(bundleDir)) {
		try {
			renameSync(oldDir, bundleDir);
		} catch {
			rollbackFailed = true;
		}
	}
	if (rollbackFailed) {
		failFaultedBuild("swap3", `rollback failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	failFaultedBuild("swap1", `swap failed, bundle kept: ${error instanceof Error ? error.message : String(error)}`);
}

if (fault === "promote") {
	failFaultedBuild("promote", "exited after the swap, before receipt promote");
}

// Two-phase receipt: the candidate provenance was parked as .tmp pre-swap;
// only now that the staging is live does it become the receipt of record.
renameSync(receiptTmpPath, receiptPath);
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
writeFileSync(join(codingAgentDistDir, "li-osc-patch-receipt.json"), `${JSON.stringify(oscPatchReceipt, null, "\t")}\n`, "utf8");
console.log(`[bundle] Li OSC query ${terminalColorQueryPatch.status} (${terminalColorQueryPatch.markerCount} marker(s))`);

if (hadLiveBundle) {
	try {
		rmSync(oldDir, { recursive: true, force: true });
	} catch {
		// EPERM on the old marker never fails the build: the new bundle is live.
		try {
			renameSync(oldDir, join(codingAgentDistDir, `bundle.old-consumed-${attemptId}`));
			console.warn(`[bundle] warning: could not delete ${oldDir}; renamed to bundle.old-consumed-${attemptId}`);
		} catch {
			console.warn(`[bundle] warning: could not delete or rename ${oldDir}; it will be cleaned by the next build`);
		}
	}
}

if (ownsBundleLock) releaseBundleLock();

const files = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.outputs))).size + 1;
const mib = (outputBytes(metafiles) + cliLauncher.length) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
