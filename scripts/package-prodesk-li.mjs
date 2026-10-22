#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const distDir = join(codingAgentDir, "dist");
const outputRoot = join(distDir, "prodesk-li-release");
const linuxNodeSourceRoot = resolve(repoRoot, "..", "python", "app_presets", "home_server", "pi-agent");
const nodeArtifactLockPath = join(linuxNodeSourceRoot, "artifacts", "artifact-lock.json");
const nodeVersion = "22.19.0";
const requiredExternalPackages = ["jiti", "@silvia-odwyer/photon-node"];
const manifestSchemaVersion = 1;

function fail(message) {
	throw new Error(message);
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function hashFile(path) {
	return sha256(readFileSync(path));
}

function isInside(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function walkRegularFiles(rootDir) {
	const files = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		)) {
			const fullPath = join(directory, entry.name);
			const info = lstatSync(fullPath);
			if (info.isSymbolicLink()) fail(`Runtime tree may not contain symlinks: ${fullPath}`);
			if (info.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!info.isFile()) fail(`Runtime tree may contain regular files only: ${fullPath}`);
			files.push({
				path: relative(rootDir, fullPath).replaceAll("\\", "/"),
				digest: hashFile(fullPath),
			});
		}
	};
	walk(rootDir);
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function createTreeManifest(rootDir) {
	const files = walkRegularFiles(rootDir);
	const rows = files.map((file) => `${file.path}:${file.digest}`).join("\n");
	return {
		fileCount: files.length,
		treeSha256: sha256(rows),
		files,
	};
}

export function assertNoProfileData(files) {
	const protectedSegments = new Set([
		"auth.json",
		"models.json",
		"settings.json",
		"sessions",
		"peer-sessions",
		"profile-snapshots",
		"credentials",
	]);
	for (const file of files) {
		const segments = file.path.split("/").map((segment) => segment.toLowerCase());
		if (segments.some((segment) => protectedSegments.has(segment) || segment.startsWith(".env"))) {
			fail(`Runtime bundle contains protected profile/secret path: ${file.path}`);
		}
	}
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
	if (result.error) fail(`${command} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status ?? "unknown"}`);
}

function readNodePin() {
	if (!existsSync(nodeArtifactLockPath)) fail(`Pinned Node artifact lock is missing: ${nodeArtifactLockPath}`);
	const lock = JSON.parse(readFileSync(nodeArtifactLockPath, "utf8"));
	const node = lock?.artifacts?.node;
	if (lock.state !== "verified" || node?.pinned_version !== nodeVersion || node.distribution !== "linux-x64") {
		fail("Pinned Node artifact lock is not verified for Linux x64 Node 22.19.0");
	}
	if (
		node.filename !== `node-v${nodeVersion}-linux-x64.tar.xz` ||
		typeof node.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(node.sha256)
	) {
		fail("Pinned Node artifact filename/SHA-256 is invalid");
	}
	const artifactPath = join(linuxNodeSourceRoot, "artifacts", node.filename);
	if (!existsSync(artifactPath)) fail(`Pinned Node artifact is missing: ${artifactPath}`);
	const actual = hashFile(artifactPath);
	if (actual !== node.sha256) fail(`Pinned Node SHA-256 mismatch: expected ${node.sha256}, got ${actual}`);
	return { ...node, path: artifactPath };
}

function assertCleanSource(receipt) {
	const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	const statusResult = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	if (headResult.status !== 0 || statusResult.status !== 0) fail("Could not read Li Git provenance");
	const head = headResult.stdout.trim();
	if (statusResult.stdout.trim() !== "") fail("Refusing to package Li from a dirty source tree");
	if (receipt.gitDirty !== false || receipt.gitHead !== head) {
		fail("Li build receipt must match the clean current commit");
	}
	if (typeof receipt.profileSnapshotId !== "string" || receipt.profileSnapshotId.trim() === "") {
		fail("LI_PROFILE_SNAPSHOT_ID must identify the ProDesk profile snapshot before packaging");
	}
	return head;
}

function prepareOutput(path) {
	const outputDir = resolve(path);
	if (!isInside(outputDir, distDir)) {
		fail(`Output must be a new directory inside ${distDir}: ${outputDir}`);
	}
	if (existsSync(outputDir)) fail(`Refusing to overwrite existing output directory: ${outputDir}`);
	return outputDir;
}

export function buildArtifactLock({ sourceCommit, packageVersion, profileSnapshotId, node, runtimeArchive, treeManifest, externalDependencies, installer, verificationManifest }) {
	return {
		schema_version: manifestSchemaVersion,
		state: "verified",
		runtime: "li-prodesk-linux-x64",
		source_commit: sourceCommit,
		package_version: packageVersion,
		profile_snapshot_id: profileSnapshotId,
		node_version: node.pinned_version,
		node_filename: node.filename,
		node_sha256: node.sha256,
		runtime_filename: runtimeArchive.filename,
		runtime_sha256: runtimeArchive.sha256,
		runtime_file_count: String(treeManifest.fileCount),
		runtime_tree_sha256: treeManifest.treeSha256,
		installer_filename: installer.filename,
		installer_sha256: installer.sha256,
		verification_file_count: String(verificationManifest.fileCount),
		verification_tree_sha256: verificationManifest.treeSha256,
		external_dependencies: externalDependencies,
	};
}

export function packageProdeskLi({ outputDir = outputRoot } = {}) {
	const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	const receiptPath = join(distDir, "li-build-receipt.json");
	if (!existsSync(receiptPath) || !existsSync(join(distDir, "bundle", "cli.js"))) {
		fail("Li build output/receipt missing; run node scripts/build-li.mjs --offline first");
	}
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	const sourceCommit = assertCleanSource(receipt);
	if (packageJson.version !== receipt.baseVersion) fail("Li package version and build receipt do not match");
	if (receipt.gitShortSha !== sourceCommit.slice(0, 10)) fail("Li build receipt short SHA does not match HEAD");

	const node = readNodePin();
	const output = prepareOutput(outputDir);
	const temporaryRoot = mkdtempSync(join(tmpdir(), "prodesk-li-package-"));
	let outputCreated = false;
	try {
		const runtimeRoot = join(temporaryRoot, "li-runtime");
		const runtimePackageDir = join(runtimeRoot, "packages", "coding-agent");
		const runtimeNodeModules = join(runtimePackageDir, "node_modules");
		mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
		mkdirSync(runtimePackageDir, { recursive: true });
		mkdirSync(runtimeNodeModules, { recursive: true });
		copyFileSync(join(repoRoot, "bin", "li"), join(runtimeRoot, "bin", "li"));
		chmodSync(join(runtimeRoot, "bin", "li"), 0o755);
		copyFileSync(join(codingAgentDir, "package.json"), join(runtimePackageDir, "package.json"));
		cpSync(distDir, join(runtimePackageDir, "dist"), {
			recursive: true,
			dereference: false,
			errorOnExist: true,
			force: false,
			filter: (source) => {
				const relativePath = relative(distDir, source).replaceAll("\\", "/");
				const firstSegment = relativePath.split("/")[0];
				return relativePath === "" || !firstSegment.startsWith("prodesk-li-release");
			},
		});

		const externalDependencies = requiredExternalPackages.map((packageName) => {
			const source = join(repoRoot, "node_modules", packageName);
			const sourcePackageJsonPath = join(source, "package.json");
			if (!existsSync(sourcePackageJsonPath)) fail(`Required external runtime package is missing: ${packageName}`);
			const sourcePackageJson = JSON.parse(readFileSync(sourcePackageJsonPath, "utf8"));
			if (sourcePackageJson.name !== packageName || packageJson.dependencies?.[packageName] !== sourcePackageJson.version) {
				fail(`External runtime package version does not match Li package.json: ${packageName}`);
			}
			const destination = join(runtimeNodeModules, packageName);
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(source, destination, {
				recursive: true,
				dereference: false,
				errorOnExist: true,
				force: false,
			});
			return { name: packageName, version: sourcePackageJson.version };
		});

		const treeManifest = createTreeManifest(runtimeRoot);
		assertNoProfileData(treeManifest.files);
		const verificationRoot = join(temporaryRoot, "verification");
		mkdirSync(join(verificationRoot, "bin"), { recursive: true });
		mkdirSync(join(verificationRoot, "scripts"), { recursive: true });
		for (const relativePath of [
			"bin/li",
			"scripts/package-prodesk-li.mjs",
			"scripts/install-prodesk-li.sh",
			"scripts/install-prodesk-li.test.mjs",
		]) {
			copyFileSync(join(repoRoot, relativePath), join(verificationRoot, relativePath));
		}
		const verificationManifest = createTreeManifest(verificationRoot);
		const archiveFilename = `li-runtime-linux-x64-${sourceCommit.slice(0, 10)}.tar.gz`;
		const temporaryArchivePath = join(temporaryRoot, archiveFilename);
		run("tar", ["-czf", archiveFilename, "li-runtime"], temporaryRoot);
		// Round-trip guard: the archive must reproduce the exact tree the lock describes,
		// otherwise the installer's tree verification would fail on ProDesk after transfer.
		{
			const roundTripRoot = join(temporaryRoot, "roundtrip");
			mkdirSync(roundTripRoot);
			run("tar", ["-xzf", archiveFilename], { cwd: roundTripRoot });
			const roundTripManifest = createTreeManifest(join(roundTripRoot, "li-runtime"));
			if (
				roundTripManifest.fileCount !== treeManifest.fileCount ||
				roundTripManifest.treeSha256 !== treeManifest.treeSha256
			) {
				fail(`Runtime archive round-trip mismatch: expected ${treeManifest.treeSha256} (${treeManifest.fileCount} files), got ${roundTripManifest.treeSha256} (${roundTripManifest.fileCount} files)`);
			}
			rmSync(roundTripRoot, { recursive: true, force: true });
		}
		const archiveSha256 = hashFile(temporaryArchivePath);
		mkdirSync(output, { recursive: true });
		outputCreated = true;
		const archivePath = join(output, archiveFilename);
		copyFileSync(temporaryArchivePath, archivePath);
		cpSync(verificationRoot, join(output, "verification"), { recursive: true, dereference: false, errorOnExist: true, force: false });
		copyFileSync(node.path, join(output, node.filename));
		if (hashFile(join(output, node.filename)) !== node.sha256) fail("Copied Node artifact failed SHA-256 verification");
		const installerSource = join(repoRoot, "scripts", "install-prodesk-li.sh");
		const installerFilename = "install-prodesk-li.sh";
		const installerPath = join(output, installerFilename);
		copyFileSync(installerSource, installerPath);
		chmodSync(installerPath, 0o755);
		const installerSha256 = hashFile(installerPath);

		const lock = buildArtifactLock({
			sourceCommit,
			packageVersion: packageJson.version,
			profileSnapshotId: receipt.profileSnapshotId,
			node,
			runtimeArchive: { filename: archiveFilename, sha256: archiveSha256 },
			treeManifest,
			externalDependencies,
			installer: { filename: installerFilename, sha256: installerSha256 },
			verificationManifest,
		});
		writeFileSync(join(output, "artifact-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`, "utf8");
		return { outputDir: output, lock };
	} catch (error) {
		if (outputCreated) rmSync(output, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function parseArgs(args) {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
		fail("Usage: node scripts/package-prodesk-li.mjs --output packages/coding-agent/dist/prodesk-li-release");
	}
	return { outputDir: resolve(repoRoot, args[1]) };
}

function main() {
	const result = packageProdeskLi(parseArgs(process.argv.slice(2)));
	console.log(`Li ProDesk bundle created: ${result.outputDir}`);
	console.log(`source_commit: ${result.lock.source_commit}`);
	console.log(`runtime_sha256: ${result.lock.runtime_sha256}`);
	console.log(`node_sha256: ${result.lock.node_sha256}`);
	console.log(`profile_snapshot_id: ${result.lock.profile_snapshot_id}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`[package-prodesk-li] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
