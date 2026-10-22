import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertNoProfileData, buildArtifactLock, createTreeManifest } from "./package-prodesk-li.mjs";

const tempDirs = [];

function createTempDir() {
	const root = mkdtempSync(join(tmpdir(), "prodesk-li-package-test-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("runtime tree manifest is stable and content-addressed", () => {
	const root = createTempDir();
	mkdirSync(join(root, "packages", "coding-agent"), { recursive: true });
	writeFileSync(join(root, "z.txt"), "z\n", "utf8");
	writeFileSync(join(root, "packages", "coding-agent", "a.txt"), "a\n", "utf8");

	const first = createTreeManifest(root);
	assert.deepEqual(first.files.map((file) => file.path), ["packages/coding-agent/a.txt", "z.txt"]);
	assert.deepEqual(createTreeManifest(root), first);

	writeFileSync(join(root, "z.txt"), "changed\n", "utf8");
	assert.notEqual(createTreeManifest(root).treeSha256, first.treeSha256);
});

test("runtime tree manifest refuses symlinks", (t) => {
	const root = createTempDir();
	const target = join(root, "target.txt");
	const link = join(root, "linked.txt");
	writeFileSync(target, "data\n", "utf8");
	try {
		symlinkSync(target, link);
	} catch (error) {
		if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
			t.skip("Windows symlink privilege is unavailable");
			return;
		}
		throw error;
	}

	assert.throws(() => createTreeManifest(root), /may not contain symlinks/);
});

test("profile and secret state paths are rejected while auth code remains packageable", () => {
	assert.doesNotThrow(() => assertNoProfileData([{ path: "packages/ai/dist/auth/oauth/login.js" }]));
	assert.throws(() => assertNoProfileData([{ path: "packages/coding-agent/dist/auth.json" }]), /protected profile\/secret path/);
	assert.throws(() => assertNoProfileData([{ path: "packages/coding-agent/sessions/session.jsonl" }]), /protected profile\/secret path/);
	assert.throws(() => assertNoProfileData([{ path: "packages/coding-agent/.env.local" }]), /protected profile\/secret path/);
});

test("artifact lock binds the source, profile snapshot, Node, and runtime archive hashes", () => {
	const lock = buildArtifactLock({
		sourceCommit: "a".repeat(40),
		packageVersion: "1.3.0",
		profileSnapshotId: "prodesk-pre-li-20261022",
		node: {
			pinned_version: "22.19.0",
			filename: "node-v22.19.0-linux-x64.tar.xz",
			sha256: "b".repeat(64),
		},
		runtimeArchive: {
			filename: "li-runtime-linux-x64-aaaaaaaaaa.tar.gz",
			sha256: "c".repeat(64),
		},
		treeManifest: { fileCount: 17, treeSha256: "d".repeat(64) },
		externalDependencies: [
			{ name: "jiti", version: "2.7.0" },
			{ name: "@silvia-odwyer/photon-node", version: "0.3.4" },
		],
		installer: { filename: "install-prodesk-li.sh", sha256: "e".repeat(64) },
		verificationManifest: { fileCount: 4, treeSha256: "f".repeat(64) },
	});

	assert.equal(lock.schema_version, 1);
	assert.equal(lock.source_commit, "a".repeat(40));
	assert.equal(lock.profile_snapshot_id, "prodesk-pre-li-20261022");
	assert.equal(lock.node_sha256, "b".repeat(64));
	assert.equal(lock.runtime_sha256, "c".repeat(64));
	assert.equal(lock.runtime_tree_sha256, "d".repeat(64));
	assert.equal(lock.installer_sha256, "e".repeat(64));
	assert.equal(lock.verification_file_count, "4");
	assert.equal(lock.verification_tree_sha256, "f".repeat(64));
	assert.deepEqual(lock.external_dependencies.map((dependency) => dependency.name), ["jiti", "@silvia-odwyer/photon-node"]);
});
