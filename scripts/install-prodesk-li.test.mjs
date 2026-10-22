import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifactLock, createTreeManifest } from "./package-prodesk-li.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const installerSource = join(repoRoot, "scripts", "install-prodesk-li.sh");
const launcherSource = join(repoRoot, "bin", "li");
const tempDirs = [];
const sourceCommits = ["a".repeat(40), "b".repeat(40)];
const snapshotId = "prodesk-pre-li-test";

function toShellPath(value) {
	if (process.platform !== "win32") return value;
	const result = spawnSync("cygpath", ["-u", value], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`cygpath failed: ${result.stderr || result.error || "unknown error"}`);
	return result.stdout.trim();
}

function quoteShell(value) {
	return `'${toShellPath(value).replace(/'/g, "'\\''")}'`;
}

function runBashCommand(command, options = {}) {
	return spawnSync("bash", ["-lc", command], { encoding: "utf8", ...options });
}

function runInstaller(installerPath, args, home) {
	const convertedArgs = args.map((arg, index) => (args[index - 1] === "--bundle-dir" ? toShellPath(arg) : arg));
	return spawnSync("bash", [toShellPath(installerPath), ...convertedArgs], {
		encoding: "utf8",
		env: { ...process.env, HOME: toShellPath(home), PI_TEST_SYSTEM_NODE: toShellPath(process.execPath) },
	});
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function runOrThrow(result, description) {
	if (result.error || result.status !== 0) {
		throw new Error(`${description} failed: ${result.stderr || result.error || `exit ${result.status}`}`);
	}
}

function setMode(path, mode) {
	runOrThrow(runBashCommand(`chmod ${mode} ${quoteShell(path)}`), `chmod ${mode}`);
}

function createTempRoot() {
	const root = mkdtempSync(join(tmpdir(), "prodesk-li-install-test-"));
	tempDirs.push(root);
	return root;
}

function createProfileSnapshot(home) {
	const piRoot = join(home, ".pi");
	mkdirSync(join(piRoot, "agent"), { recursive: true });
	writeFileSync(join(piRoot, "agent", "fixture-entry.jsonl"), '{"type":"fixture"}\n', "utf8");

	const snapshotRoot = join(home, ".local", "state", "prodesk-li", "profile-snapshots");
	const snapshotDir = join(snapshotRoot, snapshotId);
	mkdirSync(snapshotDir, { recursive: true });
	const archivePath = join(snapshotDir, "profile.tar.gz");
	runOrThrow(
		runBashCommand(`tar -czf ${quoteShell(archivePath)} -C ${quoteShell(home)} .pi`),
		"create isolated profile snapshot fixture",
	);
	const receipt = {
		snapshot_id: snapshotId,
		source_path: ".pi",
		file_count: "1",
		archive_sha256: sha256(readFileSync(archivePath)),
	};
	const receiptPath = join(snapshotDir, "snapshot.json");
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	setMode(snapshotRoot, "700");
	setMode(snapshotDir, "700");
	setMode(archivePath, "600");
	setMode(receiptPath, "600");
	return { snapshotRoot, snapshotDir, archivePath };
}

function createNodeArchive(bundleDir) {
	const nodeRoot = join(bundleDir, "node-source", "node-v22.19.0-linux-x64");
	const nodeBin = join(nodeRoot, "bin");
	mkdirSync(nodeBin, { recursive: true });
	const nodeScript = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'v22.19.0'
  exit 0
fi
if [ "\${1:-}" = "-e" ]; then
  exec "$PI_TEST_SYSTEM_NODE" "$@"
fi
printf '%s\\n' 'isolated Li help smoke passed'
`;
	const nodePath = join(nodeBin, "node");
	writeFileSync(nodePath, nodeScript, "utf8");
	setMode(nodePath, "755");
	const archivePath = join(bundleDir, "node-v22.19.0-linux-x64.tar.xz");
	runOrThrow(
		runBashCommand(`tar -cJf ${quoteShell(archivePath)} -C ${quoteShell(join(bundleDir, "node-source"))} node-v22.19.0-linux-x64`),
		"create fake pinned Node archive",
	);
	return { filename: "node-v22.19.0-linux-x64.tar.xz", pinned_version: "22.19.0", sha256: sha256(readFileSync(archivePath)) };
}

function createBundle(root, { sourceCommit, packageVersion }) {
	const bundleDir = join(root, `bundle-${packageVersion}`);
	mkdirSync(bundleDir, { recursive: true });
	const runtimeRoot = join(root, `runtime-${packageVersion}`, "li-runtime");
	const packageRoot = join(runtimeRoot, "packages", "coding-agent");
	const distRoot = join(packageRoot, "dist");
	mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
	mkdirSync(join(distRoot, "bundle"), { recursive: true });
	mkdirSync(join(packageRoot, "node_modules", "jiti", "lib"), { recursive: true });
	mkdirSync(join(packageRoot, "node_modules", "@silvia-odwyer", "photon-node"), { recursive: true });
	copyFileSync(launcherSource, join(runtimeRoot, "bin", "li"));
	setMode(join(runtimeRoot, "bin", "li"), "755");
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: packageVersion }), "utf8");
	writeFileSync(join(distRoot, "bundle", "cli.js"), "// isolated smoke fixture\n", "utf8");
	writeFileSync(
		join(distRoot, "li-build-receipt.json"),
		JSON.stringify({ gitHead: sourceCommit, gitShortSha: sourceCommit.slice(0, 10), baseVersion: packageVersion, profileSnapshotId: snapshotId }),
		"utf8",
	);
	writeFileSync(join(packageRoot, "node_modules", "jiti", "package.json"), '{"name":"jiti","version":"2.7.0"}\n', "utf8");
	writeFileSync(
		join(packageRoot, "node_modules", "@silvia-odwyer", "photon-node", "package.json"),
		'{"name":"@silvia-odwyer/photon-node","version":"0.3.4"}\n',
		"utf8",
	);

	const treeManifest = createTreeManifest(runtimeRoot);
	const runtimeFilename = `li-runtime-linux-x64-${sourceCommit.slice(0, 10)}.tar.gz`;
	const runtimeArchive = join(bundleDir, runtimeFilename);
	runOrThrow(
		runBashCommand(`tar -czf ${quoteShell(runtimeArchive)} -C ${quoteShell(dirname(runtimeRoot))} li-runtime`),
		"create isolated Li runtime archive",
	);
	const node = createNodeArchive(bundleDir);
	const installerPath = join(bundleDir, "install-prodesk-li.sh");
	copyFileSync(installerSource, installerPath);
	setMode(installerPath, "755");
	const installer = { filename: "install-prodesk-li.sh", sha256: sha256(readFileSync(installerPath)) };
	const lock = buildArtifactLock({
		sourceCommit,
		packageVersion,
		profileSnapshotId: snapshotId,
		node,
		runtimeArchive: { filename: runtimeFilename, sha256: sha256(readFileSync(runtimeArchive)) },
		treeManifest,
		externalDependencies: [
			{ name: "jiti", version: "2.7.0" },
			{ name: "@silvia-odwyer/photon-node", version: "0.3.4" },
		],
		installer,
		verificationManifest: { fileCount: 4, treeSha256: "f".repeat(64) },
	});
	writeFileSync(join(bundleDir, "artifact-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`, "utf8");
	return { bundleDir, installerPath, runtimeArchive, runtimeRoot, lock };
}

function runReadiness(bundle, home) {
	return runInstaller(bundle.installerPath, ["--bundle-dir", bundle.bundleDir, "--check-readiness", "--yes"], home);
}

function setupPiBaseline(home) {
	const piBinDir = join(home, ".local", "bin");
	const piRoot = join(home, ".local", "prodesk-pi");
	const piRelease = join(piRoot, "releases", "pi0.84.2");
	mkdirSync(piBinDir, { recursive: true });
	mkdirSync(piRelease, { recursive: true });
	const piWrapper = join(piBinDir, "pi");
	writeFileSync(piWrapper, "#!/bin/sh\nprintf '%s\\n' '0.84.2'\n", "utf8");
	setMode(piWrapper, "755");
	symlinkSync("releases/pi0.84.2", join(piRoot, "current"), "dir");
	return { piWrapper, piCurrent: join(piRoot, "current") };
}

function currentTarget(path) {
	const result = spawnSync("readlink", [toShellPath(path)], { encoding: "utf8" });
	if (result.status !== 0) return "";
	return result.stdout.trim();
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("readiness verifies artifact pins and the private profile snapshot without installing", (t) => {
	if (process.platform === "win32") {
		t.skip("owner-only mode verification requires Linux filesystem semantics");
		return;
	}
	const root = createTempRoot();
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	createProfileSnapshot(home);
	const bundle = createBundle(root, { sourceCommit: sourceCommits[0], packageVersion: "1.3.0" });
	const result = runReadiness(bundle, home);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /readiness PASS/);
	assert.equal(currentTarget(join(home, ".local", "prodesk-li", "current")), "");
});

test("readiness refuses a runtime archive changed after the lock was written", () => {
	const root = createTempRoot();
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	createProfileSnapshot(home);
	const bundle = createBundle(root, { sourceCommit: sourceCommits[0], packageVersion: "1.3.0" });
	writeFileSync(bundle.runtimeArchive, "tampered", { flag: "a" });
	const result = runReadiness(bundle, home);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Li runtime SHA-256 mismatch/);
	assert.equal(currentTarget(join(home, ".local", "prodesk-li", "current")), "");
});

test("installs Li side-by-side and rollback never changes Pi", (t) => {
	if (process.platform === "win32") {
		t.skip("atomic symlink promotion is a Linux-only ProDesk contract");
		return;
	}
	const root = createTempRoot();
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	createProfileSnapshot(home);
	const pi = setupPiBaseline(home);
	const first = createBundle(root, { sourceCommit: sourceCommits[0], packageVersion: "1.3.0" });
	const firstInstall = runInstaller(first.installerPath, ["--bundle-dir", first.bundleDir, "--yes"], home);
	assert.equal(firstInstall.status, 0, firstInstall.stderr);
	assert.match(firstInstall.stdout, /install PASS/);
	const firstCurrent = currentTarget(join(home, ".local", "prodesk-li", "current"));
	assert.match(firstCurrent, /^releases\//);
	const userLiCommand = join(home, ".local", "bin", "li");
	assert.equal(currentTarget(userLiCommand), join(home, ".local", "prodesk-li", "bin", "li"));
	const userLiVersion = runBashCommand(`${quoteShell(userLiCommand)} --version`, {
		env: { ...process.env, HOME: toShellPath(home), PI_TEST_SYSTEM_NODE: toShellPath(process.execPath) },
	});
	assert.equal(userLiVersion.status, 0, userLiVersion.stderr);
	assert.match(userLiVersion.stdout, /li 1\.3\.0 \(source a{10}\)/);
	assert.equal(currentTarget(pi.piCurrent), "releases/pi0.84.2");
	assert.equal(runBashCommand(`${quoteShell(pi.piWrapper)} --version`).stdout.trim(), "0.84.2");

	const second = createBundle(root, { sourceCommit: sourceCommits[1], packageVersion: "1.3.1" });
	const secondInstall = runInstaller(second.installerPath, ["--bundle-dir", second.bundleDir, "--yes"], home);
	assert.equal(secondInstall.status, 0, secondInstall.stderr);
	const secondCurrent = currentTarget(join(home, ".local", "prodesk-li", "current"));
	assert.notEqual(secondCurrent, firstCurrent);

	const rollback = runInstaller(first.installerPath, ["--rollback", "--yes"], home);
	assert.equal(rollback.status, 0, rollback.stderr);
	assert.equal(currentTarget(join(home, ".local", "prodesk-li", "current")), firstCurrent);
	assert.equal(currentTarget(pi.piCurrent), "releases/pi0.84.2");
	assert.equal(runBashCommand(`${quoteShell(pi.piWrapper)} --version`).stdout.trim(), "0.84.2");
});

test("install requires explicit --yes before any host write", () => {
	const root = createTempRoot();
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const bundle = createBundle(root, { sourceCommit: sourceCommits[0], packageVersion: "1.3.0" });
	const result = runInstaller(bundle.installerPath, ["--bundle-dir", bundle.bundleDir], home);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /refusing without --yes/);
	assert.equal(currentTarget(join(home, ".local", "prodesk-li", "current")), "");
});
