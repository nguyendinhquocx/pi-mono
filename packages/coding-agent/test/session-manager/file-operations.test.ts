import { constants as bufferConstants } from "buffer";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../../src/config.ts";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	parseSessionTranscriptStrict,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg, readSessionFileRoles, userMsg } from "../utilities.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionHeader(file: string, cwd: string, id: string, prefix = ""): void {
		writeFileSync(
			file,
			`${prefix}${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd,
			})}\n`,
		);
	}

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});

	it("adds a newline after an unterminated valid record", () => {
		const file = join(tempDir, "unterminated.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(readFileSync(file, "utf8")).toBe(`${content}\n`);
	});

	it("adds a newline after an unterminated malformed final fragment", () => {
		const file = join(tempDir, "malformed-tail.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' + '{"type":"message"';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(`${content}\n`);
	});

	it("does not modify an unterminated non-session file", () => {
		const file = join(tempDir, "invalid.jsonl");
		const content = '{"type":"message","id":"1"}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it.each([
		["leading blank lines", "\n  \n", "leading-blank"],
		["leading malformed lines", "not json\n{broken json\n", "leading-malformed"],
		["a multi-buffer header", "", "a".repeat(8192)],
	])("reads cwd from a session with %s", (_description, prefix, sessionId) => {
		const file = join(tempDir, "header.jsonl");
		const storedCwd = join(tempDir, "stored-project");
		writeSessionHeader(file, storedCwd, sessionId, prefix);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe(sessionId);
		expect(sessionManager.getCwd()).toBe(storedCwd);
	});

	it("opens compatible sessions beyond the discovery scan limit", () => {
		const storedCwd = join(tempDir, "stored-project");
		const overrideCwd = join(tempDir, "override-project");
		const cases = [
			{ name: "large-header", id: "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1), prefix: "" },
			{
				name: "large-prefix",
				id: "large-prefix",
				prefix: `${"x".repeat(HEADER_SCAN_LIMIT_BYTES + 1)}\n`,
			},
		];

		for (const { name, id, prefix } of cases) {
			const file = join(tempDir, `${name}.jsonl`);
			writeSessionHeader(file, storedCwd, id, prefix);
			for (const cwdOverride of [undefined, overrideCwd]) {
				const sessionManager = SessionManager.open(file, tempDir, cwdOverride);
				expect(sessionManager.getSessionId()).toBe(id);
				expect(sessionManager.getCwd()).toBe(cwdOverride ?? storedCwd);
			}
		}
	});

	// Fix A1: when the discovery scan limit is exceeded, the full-load fallback
	// must not repair the transcript during open — the newline repair stays
	// deferred like every other open path.
	it("defers the newline repair when the discovery scan limit is exceeded (open leaves bytes untouched)", () => {
		const file = join(tempDir, "scan-limit-repair.jsonl");
		// A single valid header line longer than the discovery scan limit forces
		// the full-load fallback path (all lines stay strictly parseable).
		const header = {
			type: "session",
			version: 3,
			id: "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1),
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const body = `${JSON.stringify(header)}\n${JSON.stringify({
			type: "message",
			id: "aa110001",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "hi", timestamp: 1 },
		})}`;
		writeFileSync(file, body);

		const sm = SessionManager.open(file, tempDir);
		// Open must not repair the missing trailing newline: bytes stay identical.
		expect(readFileSync(file, "utf8")).toBe(body);
		expect(sm.hasDeferredStartupRepairs()).toBe(true);
		sm.applyDeferredStartupRepairs();
		expect(readFileSync(file, "utf8")).toBe(`${body}\n`);
		expect(sm.hasDeferredStartupRepairs()).toBe(false);
		expect(() => parseSessionTranscriptStrict(readFileSync(file, "utf8"))).not.toThrow();
	});

	// Fix A2: a pending newline repair folded into the first append after a
	// migration rewrite must not produce a blank line the strict parser refuses.
	it("folds a pending newline repair into the append without creating a blank line", () => {
		const file = join(tempDir, "fold-blank-line.jsonl");
		const legacy = `${JSON.stringify({
			type: "session",
			id: "fold-legacy",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		})}\n${JSON.stringify({
			type: "message",
			id: "aa110002",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "legacy", timestamp: 1 },
		})}`;
		writeFileSync(file, legacy);

		const sm = SessionManager.open(file, tempDir);
		expect(sm.hasDeferredStartupRepairs()).toBe(true);
		// Append without applyDeferredStartupRepairs: the migration rewrite runs
		// first and already includes the appended entry, so nothing else may be
		// appended — no blank line, no duplicate id.
		sm.appendMessage(userMsg("next"));
		const raw = readFileSync(file, "utf8");
		expect(raw).not.toContain("\n\n");
		expect(() => parseSessionTranscriptStrict(raw)).not.toThrow();
		expect(raw.endsWith("\n")).toBe(true);
	});

	// Fix A2 (pure newline fold): without a migration, a pending newline repair
	// is folded into the first append chunk so the previously unterminated last
	// line gets closed instead of glued to the new entry.
	it("folds a pure newline repair into the append without a migration rewrite", () => {
		const file = join(tempDir, "fold-newline-only.jsonl");
		const body = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "fold-newline",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		})}\n${JSON.stringify({
			type: "message",
			id: "aa110003",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "first", timestamp: 1 },
		})}`;
		writeFileSync(file, body);

		const sm = SessionManager.open(file, tempDir);
		expect(sm.hasDeferredStartupRepairs()).toBe(true);
		sm.appendMessage(userMsg("second"));
		const raw = readFileSync(file, "utf8");
		expect(raw.startsWith(`${body}\n`)).toBe(true);
		expect(raw).not.toContain("\n\n");
		expect(() => parseSessionTranscriptStrict(raw)).not.toThrow();
	});

	// Fix A2: createBranchedSession rewrites the branched file, which subsumes
	// any pending newline repair — the flag must not stay stale for the next
	// append on the branched file.
	it("clears a pending newline repair when a branched session is rewritten", () => {
		const file = join(tempDir, "branch-flags.jsonl");
		const legacyHeader = JSON.stringify({
			type: "session",
			id: "branch-legacy",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		});
		const m1 = JSON.stringify({
			type: "message",
			id: "aa110004",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "one", timestamp: 1 },
		});
		const m2 = JSON.stringify({
			type: "message",
			id: "aa110005",
			parentId: "aa110004",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: "two", timestamp: 2 },
		});
		writeFileSync(file, `${legacyHeader}\n${m1}\n${m2}`); // no trailing newline

		const sm = SessionManager.open(file, tempDir);
		expect(sm.hasDeferredStartupRepairs()).toBe(true);
		// The legacy migration regenerates entry ids: branch from the ACTUAL leaf
		// id exposed by the opened manager, not the pre-migration fixture id.
		const loadedEntries = sm.getEntries();
		const leafId = loadedEntries[loadedEntries.length - 1]!.id;
		const branchedPath = sm.createBranchedSession(leafId);
		expect(branchedPath).toBeTruthy();
		sm.appendMessage(userMsg("three"));
		const raw = readFileSync(branchedPath!, "utf8");
		expect(raw).not.toContain("\n\n");
		expect(() => parseSessionTranscriptStrict(raw)).not.toThrow();
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("opens session files larger than Node's max string length", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips oversized corrupt files and returns a valid session", () => {
		const invalid = join(tempDir, "oversized.jsonl");
		const valid = join(tempDir, "valid.jsonl");
		writeFileSync(invalid, "x".repeat(HEADER_SCAN_LIMIT_BYTES + 1));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});

	it("rejects a cancelled session listing", async () => {
		createPersistedSession(projectA, "from A");
		createPersistedSession(projectB, "from B");
		const controller = new AbortController();
		const listing = SessionManager.listAll(
			tempDir,
			(_loaded, _total, partialSessions) => {
				if (partialSessions) controller.abort();
			},
			controller.signal,
		);

		await expect(listing).rejects.toMatchObject({ name: "AbortError" });
		await expect(SessionManager.listAll(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow(
			`Session file is not a valid ${APP_NAME} session: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionManager.open(nonSessionFile, tempDir)).toThrow(
			`Session file is not a valid ${APP_NAME} session: ${nonSessionFile}`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of initialized empty file work correctly", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = SessionManager.open(emptyFile, tempDir);
		const sessionId = sm1.getSessionId();

		const sm2 = SessionManager.open(emptyFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});

describe("SessionManager session file creation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-persist-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not create a file for a session with only setup entries", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendThinkingLevelChange("off");

		expect(existsSync(session.getSessionFile()!)).toBe(false);
	});

	// #10000: the first prompt must survive a first turn that never produces an assistant message
	it("creates the file when the first user message is appended", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendMessage(userMsg("first question"));

		const file = session.getSessionFile()!;
		expect(readSessionFileRoles(file)).toEqual(["session", "model_change", "user"]);
		expect(SessionManager.open(file, tempDir).buildSessionContext().messages).toHaveLength(1);
	});

	it("appends later entries to the file without rewriting earlier ones", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("first question"));
		session.appendCustomEntry("preset-state", { name: "plan" });
		session.appendMessage(assistantMsg("first answer"));

		expect(readSessionFileRoles(session.getSessionFile()!)).toEqual(["session", "user", "custom", "assistant"]);
	});
});
