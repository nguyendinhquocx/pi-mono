import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceLauncher = join(repoRoot, "bin", "li");
const tempDirs = [];

function toShellPath(value) {
	if (process.platform !== "win32") return value;
	const result = spawnSync("cygpath", ["-u", value], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`cygpath failed for ${value}: ${result.stderr || result.error || "unknown error"}`);
	}
	return result.stdout.trim();
}

function createRelease() {
	const installRoot = mkdtempSync(join(tmpdir(), "li-launcher-test-"));
	tempDirs.push(installRoot);
	const releaseRoot = join(installRoot, "release");
	const packageDir = join(releaseRoot, "packages", "coding-agent");
	const distDir = join(packageDir, "dist");
	const bundleDir = join(distDir, "bundle");
	const nodeBinDir = join(releaseRoot, "node", "bin");
	const launcherDir = join(releaseRoot, "bin");
	const launcherPath = join(launcherDir, "li");
	const fakeNodePath = join(nodeBinDir, "node");

	mkdirSync(bundleDir, { recursive: true });
	mkdirSync(nodeBinDir, { recursive: true });
	mkdirSync(launcherDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "1.3.0" }), "utf8");
	writeFileSync(join(bundleDir, "cli.js"), "// fixture CLI\n", "utf8");
	writeFileSync(
		join(distDir, "li-build-receipt.json"),
		JSON.stringify({ baseVersion: "1.3.0", gitShortSha: "abcdef1234" }),
		"utf8",
	);
	copyFileSync(sourceLauncher, launcherPath);
	writeFileSync(
		fakeNodePath,
		`#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'v22.19.0'
  exit 0
fi
if [ "\${1:-}" = "-e" ]; then
  shift 2
  case "\${1:-}" in
    */li-build-receipt.json) printf '%s\\n' 'li 1.3.0 (source abcdef1234)' ;;
    *) echo 'unexpected receipt path' >&2; exit 91 ;;
  esac
  exit 0
fi
printf 'LI_RUNTIME=%s\\n' "\${LI_RUNTIME:-}"
printf 'LI_ROOT=%s\\n' "\${LI_ROOT:-}"
printf 'LI_CODING_AGENT_DIR=%s\\n' "\${LI_CODING_AGENT_DIR:-}"
printf 'LI_CODING_AGENT_SESSION_DIR=%s\\n' "\${LI_CODING_AGENT_SESSION_DIR:-}"
printf 'PI_PACKAGE_DIR=%s\\n' "\${PI_PACKAGE_DIR:-}"
printf 'PI_CORE_CLI_PATH=%s\\n' "\${PI_CORE_CLI_PATH:-}"
printf 'PI_OSC_GUARD_DIST=%s\\n' "\${PI_OSC_GUARD_DIST:-}"
printf 'PI_SKIP_VERSION_CHECK=%s\\n' "\${PI_SKIP_VERSION_CHECK:-}"
printf 'ARGS=%s\\n' "$*"
`,
		"utf8",
	);
	chmodSync(fakeNodePath, 0o755);

	return { installRoot, releaseRoot, packageDir, distDir, launcherPath };
}

function runLauncher(launcherPath, args, extraEnv = {}) {
	return spawnSync("bash", [toShellPath(launcherPath), ...args], {
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("--version reads the Li build receipt without starting the CLI", () => {
	const release = createRelease();
	const result = runLauncher(release.launcherPath, ["--version"]);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "li 1.3.0 (source abcdef1234)");
});

test("maps the shared Pi profile env and pins every runtime path to this Li release", () => {
	const release = createRelease();
	const agentDir = toShellPath(join(release.installRoot, "profile", "agent"));
	const sessionDir = toShellPath(join(release.installRoot, "profile", "sessions"));
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const result = runLauncher(release.launcherPath, ["--help"], {
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^LI_RUNTIME=1$/m);
	const outputLines = result.stdout.split(/\r?\n/);
	assert.ok(outputLines.includes(`LI_ROOT=${toShellPath(release.releaseRoot)}`));
	assert.ok(outputLines.includes(`LI_CODING_AGENT_DIR=${agentDir}`));
	assert.ok(outputLines.includes(`LI_CODING_AGENT_SESSION_DIR=${sessionDir}`));
	assert.ok(outputLines.includes(`PI_PACKAGE_DIR=${toShellPath(release.packageDir)}`));
	assert.ok(outputLines.includes(`PI_CORE_CLI_PATH=${toShellPath(join(release.packageDir, "dist", "bundle", "cli.js"))}`));
	assert.ok(outputLines.includes(`PI_OSC_GUARD_DIST=${toShellPath(release.distDir)}`));
	assert.match(result.stdout, /^PI_SKIP_VERSION_CHECK=1$/m);
	assert.ok(outputLines.some((line) => line.startsWith("ARGS=") && line.endsWith(" --help")));
});

test("refuses conflicting PI/LI profile overrides before launching Node", () => {
	const release = createRelease();
	const piDir = toShellPath(join(release.installRoot, "profile", "pi"));
	const liDir = toShellPath(join(release.installRoot, "profile", "li"));
	mkdirSync(piDir, { recursive: true });
	mkdirSync(liDir, { recursive: true });
	const result = runLauncher(release.launcherPath, ["--help"], {
		PI_CODING_AGENT_DIR: piDir,
		LI_CODING_AGENT_DIR: liDir,
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /point to different profiles; refusing to start Li/);
	assert.doesNotMatch(result.stdout, /LI_RUNTIME=1/);
});

test("fails clearly when the Li bundle is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "li-launcher-missing-test-"));
	tempDirs.push(root);
	const launcherDir = join(root, "bin");
	mkdirSync(launcherDir, { recursive: true });
	const launcherPath = join(launcherDir, "li");
	copyFileSync(sourceLauncher, launcherPath);
	const result = runLauncher(launcherPath, ["--help"]);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Li CLI build not found/);
});
