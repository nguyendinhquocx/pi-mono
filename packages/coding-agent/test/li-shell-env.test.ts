import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getShellEnv } from "../src/utils/shell.ts";

const ENV_KEYS = [
	"LI_RUNTIME",
	"LI_ROOT",
	"LI_CODING_AGENT_DIR",
	"LI_CODING_AGENT_SESSION_DIR",
	"LI_UI_LANGUAGE",
	"PI_PACKAGE_DIR",
	"PI_CORE_CLI_PATH",
	"PI_OSC_GUARD_DIST",
	"PI_SKIP_VERSION_CHECK",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof savedEnv;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Li shell environment isolation", () => {
	it("does not leak Li package/launcher overrides into external commands", () => {
		process.env.LI_RUNTIME = "1";
		process.env.LI_ROOT = "D:\\work\\pi-mono-li";
		process.env.LI_CODING_AGENT_DIR = "D:\\shared\\agent";
		process.env.LI_CODING_AGENT_SESSION_DIR = "D:\\shared\\sessions";
		process.env.LI_UI_LANGUAGE = "vi";
		process.env.PI_PACKAGE_DIR = "D:\\work\\pi-mono-li\\packages\\coding-agent";
		process.env.PI_CORE_CLI_PATH = "D:\\work\\pi-mono-li\\packages\\coding-agent\\dist\\bundle\\cli.js";
		process.env.PI_OSC_GUARD_DIST = "D:\\work\\pi-mono-li\\packages\\coding-agent\\dist";
		process.env.PI_SKIP_VERSION_CHECK = "1";
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_SESSION_DIR;

		const shellEnv = getShellEnv();

		expect(shellEnv.LI_RUNTIME).toBeUndefined();
		expect(shellEnv.LI_ROOT).toBeUndefined();
		expect(shellEnv.LI_CODING_AGENT_DIR).toBeUndefined();
		expect(shellEnv.LI_CODING_AGENT_SESSION_DIR).toBeUndefined();
		expect(shellEnv.LI_UI_LANGUAGE).toBeUndefined();
		expect(shellEnv.PI_PACKAGE_DIR).toBeUndefined();
		expect(shellEnv.PI_CORE_CLI_PATH).toBeUndefined();
		expect(shellEnv.PI_OSC_GUARD_DIST).toBeUndefined();
		expect(shellEnv.PI_SKIP_VERSION_CHECK).toBeUndefined();
		expect(shellEnv.PI_CODING_AGENT_DIR).toBe("D:\\shared\\agent");
		expect(shellEnv.PI_CODING_AGENT_SESSION_DIR).toBe("D:\\shared\\sessions");

		// Sanitation is for spawned shells only; the active Li process keeps its own identity.
		expect(process.env.LI_RUNTIME).toBe("1");
		expect(process.env.PI_PACKAGE_DIR).toBe("D:\\work\\pi-mono-li\\packages\\coding-agent");
	});
});
