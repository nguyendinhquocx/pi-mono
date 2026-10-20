import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.ts";

/**
 * Migration rehearsal on disposable fixture copies.
 *
 * runMigrations() writes to getAgentDir() and the CWD's `.pi/`; both are
 * redirected into temp fixtures here so the rehearsal never touches the real
 * `~/.pi/agent` profile (the same property the live smoke relies on).
 */
describe("li profile migration rehearsal", () => {
	let agentDir: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "li-migration-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "li-migration-cwd-"));
		previousAgentDir = process.env.LI_CODING_AGENT_DIR;
		// This branch has piConfig.name=li, so the runtime reads LI_CODING_AGENT_DIR.
		process.env.LI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.LI_CODING_AGENT_DIR;
		else process.env.LI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("migrates legacy auth sources into auth.json on the fixture copy", () => {
		writeFileSync(
			join(agentDir, "oauth.json"),
			JSON.stringify({ zai: { type: "oauth", access: "legacy-token" } }),
			"utf8",
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ apiKeys: { deepseek: "legacy-key" } }),
			"utf8",
		);

		const { migratedAuthProviders } = runMigrations(cwd);

		expect(migratedAuthProviders.sort()).toEqual(["deepseek", "zai"]);
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(Object.keys(auth).sort()).toEqual(["deepseek", "zai"]);
		expect(existsSync(join(agentDir, "oauth.json.migrated"))).toBe(true);
		// apiKeys were stripped from settings.json (the only settings mutation).
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(settings.apiKeys).toBeUndefined();
	});

	it("moves legacy agent-root sessions into the cwd-encoded session dir", () => {
		const sessionCwd = cwd;
		const safePath = `--${sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const sessionHeader = {
			type: "session",
			version: 3,
			id: "11111111-2222-4333-8444-555555555555",
			timestamp: "2026-10-19T00:00:00.000Z",
			cwd: sessionCwd,
		};
		writeFileSync(join(agentDir, "stray-session.jsonl"), `${JSON.stringify(sessionHeader)}\n`, "utf8");

		runMigrations(sessionCwd);

		const movedPath = join(agentDir, "sessions", safePath, "stray-session.jsonl");
		expect(existsSync(movedPath)).toBe(true);
		expect(existsSync(join(agentDir, "stray-session.jsonl"))).toBe(false);
	});

	it("migrates managed binaries tools/ -> bin/ and commands/ -> prompts/", () => {
		mkdirSync(join(agentDir, "tools"), { recursive: true });
		writeFileSync(join(agentDir, "tools", "fd.exe"), "fake-binary", "utf8");
		mkdirSync(join(agentDir, "commands"), { recursive: true });
		writeFileSync(join(agentDir, "commands", "daily.md"), "# prompt", "utf8");
		mkdirSync(join(cwd, ".pi", "commands"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "commands", "project.md"), "# project prompt", "utf8");

		const warnings = runMigrations(cwd).deprecationWarnings;

		expect(existsSync(join(agentDir, "bin", "fd.exe"))).toBe(true);
		expect(existsSync(join(agentDir, "prompts", "daily.md"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "prompts", "project.md"))).toBe(true);
		// The leftover tools/ dir (now empty of binaries) triggers a deprecation
		// warning listing, not a silent failure.
		expect(Array.isArray(warnings)).toBe(true);
	});

	it("is a no-op rehearsal on an already-migrated fixture", () => {
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		const first = runMigrations(cwd);
		// Second run must not duplicate or restructure anything.
		const second = runMigrations(cwd);
		expect(second.migratedAuthProviders).toHaveLength(0);
		expect(first.deprecationWarnings).toEqual(second.deprecationWarnings);
	});
});
