import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

const pmCalls = vi.hoisted(() => ({ update: 0, install: 0, remove: 0, updateSources: [] as string[] }));
const modelRuntimeCalls = vi.hoisted(() => ({ refresh: 0 }));

vi.mock("../src/core/package-manager.ts", () => ({
	DefaultPackageManager: class {
		setProgressCallback() {}
		async update(source?: string) {
			pmCalls.update++;
			pmCalls.updateSources.push(source ?? "all");
			return [];
		}
		async installAndPersist() {
			pmCalls.install++;
		}
		async removeAndPersist() {
			pmCalls.remove++;
			return true;
		}
		listConfiguredPackages() {
			return [];
		}
		async resolve() {
			return [];
		}
	},
}));

vi.mock("../src/core/model-runtime.ts", () => ({
	ModelRuntime: {
		create: async () => ({
			refresh: async () => {
				modelRuntimeCalls.refresh++;
				return { aborted: false, errors: new Map() };
			},
		}),
	},
}));

// This branch carries piConfig.name = "li", so APP_NAME === "li" and the
// self-update guard is active by construction; the mapped env keeps the
// settings/trust stores inside a disposable temp profile.
function tempProfile(): string {
	return mkdtempSync(join(tmpdir(), "li-self-update-"));
}

let stderr: string[];
let stdout: string[];

async function runUpdate(args: string[]): Promise<boolean> {
	pmCalls.update = 0;
	pmCalls.install = 0;
	pmCalls.remove = 0;
	pmCalls.updateSources = [];
	modelRuntimeCalls.refresh = 0;
	process.exitCode = undefined;
	stderr = [];
	stdout = [];
	const errSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		stderr.push(parts.map(String).join(" "));
	});
	const outSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdout.push(parts.map(String).join(" "));
	});
	try {
		return await handlePackageCommand(args);
	} finally {
		errSpy.mockRestore();
		outSpy.mockRestore();
	}
}

beforeEach(() => {
	process.env.LI_CODING_AGENT_DIR = tempProfile();
	process.chdir(tempProfile());
});

afterEach(() => {
	vi.unstubAllEnvs();
	process.exitCode = undefined;
});

describe("li self-update guard", () => {
	const selfTargetingCases = [
		["update"],
		["update", "self"],
		["update", "pi"],
		["update", "--self"],
		["update", "--all"],
		["update", "--force"],
		["update", "--self", "--extensions"],
		["update", "--force", "--all"],
		["update", "--force", "pi"],
	];

	for (const args of selfTargetingCases) {
		it(`refuses: li ${args.join(" ")}`, async () => {
			const handled = await runUpdate(args);
			expect(handled).toBe(true);
			expect(process.exitCode).toBe(1);
			expect(stderr.join("\n")).toContain("does not self-update");
			expect(stderr.join("\n")).toContain("li/stable");
			// Refusal must happen before any package-manager or installer work.
			expect(pmCalls.update).toBe(0);
			expect(pmCalls.install).toBe(0);
			expect(pmCalls.remove).toBe(0);
			expect(modelRuntimeCalls.refresh).toBe(0);
		});
	}

	it("refusal mentions the manual maintenance runbook, never pi update as the way to upgrade Li", async () => {
		await runUpdate(["update"]);
		const output = stderr.join("\n");
		expect(output).toContain("docs/li-maintenance.md");
		expect(output).toMatch(/Never use .* update or pi update to upgrade Li/);
	});

	it("still allows explicit --extensions with a shared-cache warning", async () => {
		const handled = await runUpdate(["update", "--extensions"]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
		expect(stderr.join("\n")).toContain("shared");
		expect(pmCalls.update).toBe(1);
	});

	it("still allows a single explicit package update with a shared-cache warning", async () => {
		const handled = await runUpdate(["update", "npm:@some/extension-package"]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
		expect(stderr.join("\n")).toContain("shared");
		expect(pmCalls.update).toBe(1);
		expect(pmCalls.updateSources).toEqual(["npm:@some/extension-package"]);
	});

	it("still allows explicit --models with a shared-cache warning", async () => {
		const handled = await runUpdate(["update", "--models"]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
		expect(stderr.join("\n")).toContain("shared");
		expect(modelRuntimeCalls.refresh).toBe(1);
		expect(pmCalls.update).toBe(0);
	});

	it("update help explains the Li upgrade path", async () => {
		await runUpdate(["update", "--help"]);
		const output = stdout.join("\n");
		expect(output).toContain("Li notes:");
		expect(output).toContain("li/stable");
		expect(process.exitCode).toBeUndefined();
		expect(pmCalls.update).toBe(0);
	});
});
