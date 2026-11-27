import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

describe("extensions parallel import (two-phase)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-parallel-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extCodeWithCommand = (name: string) => `
		export default function(pi) {
			pi.registerCommand("${name}", { handler: async () => {} });
		}
	`;

	it("maps a failed import to its own path and still loads the other extension", async () => {
		const goodPath = path.join(tempDir, "good.ts");
		const badPath = path.join(tempDir, "bad.ts");
		fs.writeFileSync(goodPath, extCodeWithCommand("good"));
		// Top-level throw fails during module import (phase 1), not during the factory call.
		fs.writeFileSync(badPath, "throw new Error('boom-at-module-import');\nexport default function(pi) {};\n");

		const result = await loadExtensions([badPath, goodPath], tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(badPath);
		expect(result.errors[0].error).toContain("boom-at-module-import");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toBe(goodPath);
		expect(result.extensions[0].commands.has("good")).toBe(true);
	});

	it("maps a factory failure to its own path and still loads the other extension", async () => {
		const goodPath = path.join(tempDir, "good.ts");
		const factoryFailPath = path.join(tempDir, "factory-fail.ts");
		fs.writeFileSync(goodPath, extCodeWithCommand("good"));
		fs.writeFileSync(factoryFailPath, "export default function(pi) { throw new Error('boom-in-factory'); }\n");

		const result = await loadExtensions([factoryFailPath, goodPath], tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(factoryFailPath);
		expect(result.errors[0].error).toContain("boom-in-factory");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("good")).toBe(true);
	});

	it("keeps registration order (precedence) regardless of import completion order", async () => {
		const slowPath = path.join(tempDir, "slow.ts");
		const fastPath = path.join(tempDir, "fast.ts");
		// The slow module finishes importing after the fast one under parallel import.
		fs.writeFileSync(
			slowPath,
			`
			const start = Date.now();
			while (Date.now() - start < 80) {}
			export default function(pi) {
				pi.registerCommand("slow", { handler: async () => {} });
			}
		`,
		);
		fs.writeFileSync(fastPath, extCodeWithCommand("fast"));

		const result = await loadExtensions([slowPath, fastPath], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => extension.path)).toEqual([slowPath, fastPath]);
		expect(result.extensions[0].commands.has("slow")).toBe(true);
		expect(result.extensions[1].commands.has("fast")).toBe(true);
	});

	it("LI_EXT_IMPORT_SEQUENTIAL=1 produces the same sequential result", async () => {
		const firstPath = path.join(tempDir, "first.ts");
		const secondPath = path.join(tempDir, "second.ts");
		const badPath = path.join(tempDir, "bad.ts");
		fs.writeFileSync(firstPath, extCodeWithCommand("first"));
		fs.writeFileSync(secondPath, extCodeWithCommand("second"));
		fs.writeFileSync(badPath, "throw new Error('boom-at-module-import');\nexport default function(pi) {};\n");

		process.env.LI_EXT_IMPORT_SEQUENTIAL = "1";
		try {
			const result = await loadExtensions([firstPath, badPath, secondPath], tempDir);
			expect(result.extensions.map((extension) => extension.path)).toEqual([firstPath, secondPath]);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toBe(badPath);
		} finally {
			delete process.env.LI_EXT_IMPORT_SEQUENTIAL;
		}
	});
});
