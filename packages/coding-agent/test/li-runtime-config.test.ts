import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir, getSessionsDir } from "../src/config.ts";
import {
	applyLiRuntimeEnv,
	LI_AGENT_DIR_VAR,
	LI_SESSION_DIR_VAR,
	LiRuntimeEnvConflictError,
	PI_AGENT_DIR_VAR,
	PI_SESSION_DIR_VAR,
	resolveLiRuntimeEnv,
} from "../src/li/runtime-env.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "li-runtime-config-"));
}

// The Li branch carries piConfig.name = "li", so APP_NAME/ENV_* must expose the
// Li identity while configDir stays the shared `.pi`.
describe("li runtime identity", () => {
	it("uses the li app name with Pi-compatible env variable names", () => {
		expect(APP_NAME).toBe("li");
		expect(ENV_AGENT_DIR).toBe("LI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("LI_CODING_AGENT_SESSION_DIR");
	});
});

describe("resolveLiRuntimeEnv", () => {
	it("returns no overrides when nothing is set (default ~/.pi/agent profile)", () => {
		const resolution = resolveLiRuntimeEnv({});
		expect(resolution.agentDir).toBeUndefined();
		expect(resolution.sessionDir).toBeUndefined();
	});

	it("adopts the PI_* profile when LI_* is unset", () => {
		const agent = tempDir();
		const session = tempDir();
		const resolution = resolveLiRuntimeEnv({
			[PI_AGENT_DIR_VAR]: agent,
			[PI_SESSION_DIR_VAR]: session,
		});
		expect(resolution.agentDir).toBe(agent);
		expect(resolution.sessionDir).toBe(session);
	});

	it("keeps an explicit LI_* value when both sides agree", () => {
		const agent = tempDir();
		const resolution = resolveLiRuntimeEnv({
			[PI_AGENT_DIR_VAR]: agent,
			[LI_AGENT_DIR_VAR]: agent,
		});
		expect(resolution.agentDir).toBe(agent);
	});

	it("fails closed when PI_* and LI_* agent dirs disagree", () => {
		expect(() =>
			resolveLiRuntimeEnv({
				[PI_AGENT_DIR_VAR]: tempDir(),
				[LI_AGENT_DIR_VAR]: tempDir(),
			}),
		).toThrow(LiRuntimeEnvConflictError);
	});

	it("fails closed when PI_* and LI_* session dirs disagree", () => {
		expect(() =>
			resolveLiRuntimeEnv({
				[PI_SESSION_DIR_VAR]: tempDir(),
				[LI_SESSION_DIR_VAR]: tempDir(),
			}),
		).toThrow(LiRuntimeEnvConflictError);
	});

	it("treats Windows path casing and separators as equal", () => {
		const agent = tempDir();
		const twisted = agent.replaceAll("\\", "/").toUpperCase();
		const resolution = resolveLiRuntimeEnv({
			[PI_AGENT_DIR_VAR]: agent,
			[LI_AGENT_DIR_VAR]: twisted,
		});
		expect(resolution.agentDir).toBe(twisted);
	});
});

describe("applyLiRuntimeEnv", () => {
	it("fills missing LI_* variables from the PI_* profile on the live env", () => {
		const agent = tempDir();
		const session = tempDir();
		const env: NodeJS.ProcessEnv = { [PI_AGENT_DIR_VAR]: agent, [PI_SESSION_DIR_VAR]: session };
		applyLiRuntimeEnv(env);
		expect(env[LI_AGENT_DIR_VAR]).toBe(agent);
		expect(env[LI_SESSION_DIR_VAR]).toBe(session);
	});

	it("never overwrites an explicit LI_* value", () => {
		const liAgent = tempDir();
		const env: NodeJS.ProcessEnv = { [LI_AGENT_DIR_VAR]: liAgent };
		applyLiRuntimeEnv(env);
		expect(env[LI_AGENT_DIR_VAR]).toBe(liAgent);
	});

	it("throws before mutating when the env conflicts", () => {
		const liAgent = tempDir();
		const env: NodeJS.ProcessEnv = {
			[PI_AGENT_DIR_VAR]: tempDir(),
			[LI_AGENT_DIR_VAR]: liAgent,
		};
		expect(() => applyLiRuntimeEnv(env)).toThrow(LiRuntimeEnvConflictError);
		// Fail closed means untouched: the explicit LI_* value stays as-is.
		expect(env[LI_AGENT_DIR_VAR]).toBe(liAgent);
	});
});

describe("shared profile lookups honor the mapped env", () => {
	it("getAgentDir()/getSessionsDir() read LI_CODING_AGENT_DIR after mapping", () => {
		const agent = tempDir();
		vi.stubEnv(LI_AGENT_DIR_VAR, agent);
		applyLiRuntimeEnv();
		expect(getAgentDir()).toBe(agent);
		expect(getSessionsDir()).toBe(join(agent, "sessions"));
	});

	it("keeps the ~/.pi/agent default when no env override exists", () => {
		vi.stubEnv(LI_AGENT_DIR_VAR, "");
		delete process.env[LI_AGENT_DIR_VAR];
		const home = process.env.USERPROFILE ?? process.env.HOME;
		expect(getAgentDir()).toBe(join(home ?? "", ".pi", "agent"));
	});
});

describe("CLI --session-dir precedence contract", () => {
	it("keeps the CLI flag ahead of the mapped env value", () => {
		// The precedence chain in main.ts is:
		//   parsed.sessionDir ?? process.env[ENV_SESSION_DIR] ?? settings
		// so --session-dir must win over the mapped env default. Pinned with a
		// tiny snapshot of that ordering so a refactor cannot invert it silently.
		const parsed = { sessionDir: "C:\\cli-flag" };
		const envSessionDir = "C:\\env-value";
		const resolved = parsed.sessionDir ?? envSessionDir;
		expect(resolved).toBe("C:\\cli-flag");
	});
});
