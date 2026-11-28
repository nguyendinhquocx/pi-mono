// Exercises the file operations used by package build scripts without touching build output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./package-files.mjs", import.meta.url));

function workspace(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-files-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

// Sandbox mirroring the real call sites: every package dir holds a
// package.json so the clean guard can resolve <package>/dist and .eval.
function packageSandbox(t) {
	const root = workspace(t);
	for (const pkg of ["x", "evals", "ai"]) {
		mkdirSync(join(root, "packages", pkg), { recursive: true });
		writeFileSync(join(root, "packages", pkg, "package.json"), "{}", "utf8");
	}
	mkdirSync(join(root, "packages", "x", "dist", "nested"), { recursive: true });
	writeFileSync(join(root, "packages", "x", "dist", "nested", "file.js"), "output");
	mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
	writeFileSync(join(root, "packages", "x", "src", "s.js"), "source");
	mkdirSync(join(root, "packages", "evals", ".eval"), { recursive: true });
	writeFileSync(join(root, "packages", "evals", ".eval", "g.txt"), "eval");
	mkdirSync(join(root, "packages", "ai", "dist", "providers", "data"), { recursive: true });
	writeFileSync(join(root, "packages", "ai", "dist", "providers", "data", "d.txt"), "data");
	writeFileSync(join(root, "output.txt"), "output");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, ".git", "HEAD"), "ref");
	return root;
}

function run(directory, ...args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
}

test("clean removes package dist and file targets and ignores missing paths", (t) => {
	const root = packageSandbox(t);
	const x = join(root, "packages", "x");
	assert.equal(run(x, "clean", "dist", "missing").status, 0);
	assert.equal(existsSync(join(x, "dist")), false);
	mkdirSync(join(x, "dist"), { recursive: true });
	writeFileSync(join(x, "dist", "f.txt"), "file");
	assert.equal(run(x, "clean", "dist", "dist/f.txt", "missing").status, 0);
	assert.equal(existsSync(join(x, "dist")), false);
});

test("clean refuses targets outside the package build-output boundary", (t) => {
	const root = packageSandbox(t);
	for (const args of [
		["clean", "."],
		["clean", ".git"],
		["clean", "packages/x"],
		["clean", "packages/x/src"],
		["clean", "output.txt"],
	]) {
		const result = run(root, ...args);
		assert.notEqual(result.status, 0, `expected refusal for ${args.join(" ")}`);
		assert.match(result.stderr, /Refusing to clean/);
	}
	const x = join(root, "packages", "x");
	assert.equal(run(x, "clean", "src").status !== 0, true);
	assert.equal(existsSync(join(x, "src", "s.js")), true);
});

test("clean allows nested dist and .eval targets across packages", (t) => {
	const root = packageSandbox(t);
	assert.equal(run(join(root, "packages", "ai"), "clean", "dist/providers/data").status, 0);
	assert.equal(existsSync(join(root, "packages", "ai", "dist", "providers")), true);
	assert.equal(run(join(root, "packages", "evals"), "clean", ".eval").status, 0);
	assert.equal(existsSync(join(root, "packages", "evals", ".eval")), false);
	assert.equal(run(join(root, "packages", "x"), "clean", "dist").status, 0);
});

test("clean is idempotent on missing targets", (t) => {
	const root = packageSandbox(t);
	const x = join(root, "packages", "x");
	assert.equal(run(x, "clean", "dist").status, 0);
	assert.equal(run(x, "clean", "dist").status, 0);
});

test("clean refuses junction escapes even with --force", (t) => {
	const root = packageSandbox(t);
	const outside = join(root, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "keep");
	const link = join(root, "packages", "x", "dist", "jlink");
	symlinkSync(outside, link, "junction");
	const x = join(root, "packages", "x");
	assert.equal(run(x, "clean", "dist/jlink").status !== 0, true);
	assert.notEqual(run(x, "clean", "--force", "dist/jlink").status, 0);
	assert.equal(existsSync(join(outside, "secret.txt")), true);
});

test("clean --force runs out-of-boundary targets and logs them", (t) => {
	const root = packageSandbox(t);
	const result = run(root, "clean", "--force", "output.txt");
	assert.equal(result.status, 0);
	assert.match(result.stdout, /--force clean of out-of-boundary target/);
	assert.equal(existsSync(join(root, "output.txt")), false);
});

test("copy expands patterns, creates directories, and overwrites existing assets", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "source assets"));
	writeFileSync(join(directory, "source assets", "dark.json"), "dark");
	writeFileSync(join(directory, "source assets", "light.json"), "light");
	writeFileSync(join(directory, "source assets", "ignored.txt"), "ignored");
	const args = ["copy", "source assets/*.json", "output/assets"];
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "dark");
	assert.equal(readFileSync(join(directory, "output/assets/light.json"), "utf8"), "light");
	assert.equal(existsSync(join(directory, "output/assets/ignored.txt")), false);
	writeFileSync(join(directory, "source assets", "dark.json"), "updated");
	assert.equal(run(directory, ...args).status, 0);
	assert.equal(readFileSync(join(directory, "output/assets/dark.json"), "utf8"), "updated");
});

test("copy accepts multiple files and preserves directory names and nested contents", (t) => {
	const directory = workspace(t);
	mkdirSync(join(directory, "docs", "nested"), { recursive: true });
	writeFileSync(join(directory, "docs", "nested", "guide.md"), "guide");
	writeFileSync(join(directory, "README.md"), "readme");
	assert.equal(run(directory, "copy", "docs", "README.md", "dist").status, 0);
	assert.equal(readFileSync(join(directory, "dist", "docs", "nested", "guide.md"), "utf8"), "guide");
	assert.equal(readFileSync(join(directory, "dist", "README.md"), "utf8"), "readme");
});

test("copy fails when an asset pattern matches nothing", (t) => {
	const result = run(workspace(t), "copy", "missing/*.json", "dist");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No files match missing/);
});

test("executable adds executable bits without removing existing permissions", (t) => {
	const directory = workspace(t);
	for (const name of ["cli.js", "rpc.js"]) writeFileSync(join(directory, name), "entry", { mode: 0o640 });
	const mode = statSync(join(directory, "cli.js")).mode;
	assert.equal(run(directory, "executable", "cli.js", "rpc.js").status, 0);
	if (process.platform !== "win32") {
		assert.equal(statSync(join(directory, "cli.js")).mode & 0o777, (mode | 0o111) & 0o777);
		assert.equal(statSync(join(directory, "rpc.js")).mode & 0o111, 0o111);
	}
});

test("invalid commands and missing arguments fail", (t) => {
	const directory = workspace(t);
	for (const args of [[], ["unknown", "dist"], ["clean"], ["copy", "dist"], ["executable"]]) {
		const result = run(directory, ...args);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage: package-files/);
	}
});
