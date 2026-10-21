import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { neutralizeLiTerminalColorQuery } from "./li-osc-patch.mjs";

const tempDirs = [];

function createBundle() {
	const root = mkdtempSync(join(tmpdir(), "li-osc-build-test-"));
	const bundleDir = join(root, "bundle");
	const chunksDir = join(bundleDir, "chunks");
	mkdirSync(chunksDir, { recursive: true });
	tempDirs.push(root);
	return { bundleDir, chunksDir };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("neutralizes the Li terminal-color query before runtime and is idempotent", () => {
	const { bundleDir, chunksDir } = createBundle();
	const chunkPath = join(chunksDir, "runtime.js");
	const unpatched = `const TERMINAL_COLOR_QUERY=${String.fromCharCode(96)}\\x1B]10;?\\x07\\x1B[c${String.fromCharCode(96)};`;
	writeFileSync(chunkPath, `${unpatched}\n`, "utf8");
	writeFileSync(join(chunksDir, "runtime.js.map"), unpatched, "utf8");

	const first = neutralizeLiTerminalColorQuery(bundleDir);
	const patchedSource = readFileSync(chunkPath, "utf8");
	assert.equal(first.status, "patched");
	assert.equal(first.markerCount, 1);
	assert.equal(first.files.length, 1);
	assert.ok(patchedSource.includes("TERMINAL_COLOR_QUERY=``"));
	assert.ok(!patchedSource.includes(unpatched));

	const second = neutralizeLiTerminalColorQuery(bundleDir);
	assert.equal(second.status, "already-patched");
	assert.equal(second.patchedMarkerCount, 1);
	assert.equal(second.files.length, 0);
	assert.equal(readFileSync(chunkPath, "utf8"), patchedSource);
});

test("fails closed when a bundle contains an unknown query assignment", () => {
	const { bundleDir, chunksDir } = createBundle();
	writeFileSync(join(chunksDir, "unknown.js"), "const TERMINAL_COLOR_QUERY=getQuery();", "utf8");
	assert.throws(() => neutralizeLiTerminalColorQuery(bundleDir), /Unexpected TERMINAL_COLOR_QUERY assignment/);
});

test("does nothing when upstream has removed the terminal-color query", () => {
	const { bundleDir, chunksDir } = createBundle();
	writeFileSync(join(chunksDir, "runtime.js"), "const colors = readTerminalColors();", "utf8");
	const result = neutralizeLiTerminalColorQuery(bundleDir);
	assert.equal(result.status, "not-present");
	assert.equal(result.markerCount, 0);
	assert.deepEqual(result.files, []);
});
