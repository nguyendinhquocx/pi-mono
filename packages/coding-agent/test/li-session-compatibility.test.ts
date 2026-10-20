import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import {
	buildSessionProjection,
	CURRENT_SESSION_VERSION,
	KNOWN_SESSION_ENTRY_TYPES,
	loadEntriesFromFile,
	type SessionEntry,
	UnknownSessionEntryTypeError,
	UnsupportedSessionVersionError,
} from "../src/core/session-manager.ts";

function fixtureDir(): string {
	return mkdtempSync(join(tmpdir(), "li-session-compat-"));
}

function writeSession(name: string, lines: string[], trailingNewline = true): string {
	const filePath = join(fixtureDir(), name);
	writeFileSync(filePath, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`, "utf8");
	return filePath;
}

function snapshot(filePath: string): { bytes: string; mtimeMs: number } {
	return { bytes: readFileSync(filePath, "utf8"), mtimeMs: statSync(filePath).mtimeMs };
}

const HEADER = (version: number): string =>
	JSON.stringify({
		type: "session",
		version,
		id: "0a0a0a0a-0000-4000-8000-000000000000",
		timestamp: "2026-10-19T00:00:00.000Z",
		cwd: fixtureDir(),
	});

const USER_MESSAGE = (id: string, text: string): string =>
	JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-19T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	});

const CONTEXT_EDIT = (id: string, parentId: string, targetId: string, replacementText: string | null): string =>
	JSON.stringify({
		type: "context_edit",
		id,
		parentId,
		timestamp: "2026-10-19T00:00:02.000Z",
		targetId,
		replacement: replacementText === null ? null : { content: [{ type: "text", text: replacementText }] },
	});

describe("li session compatibility: context_edit projection", () => {
	it("applies the replacement in model context and never replays the raw content", () => {
		const filePath = writeSession("context-edit.jsonl", [
			HEADER(CURRENT_SESSION_VERSION),
			USER_MESSAGE("m1", "raw secret marker"),
			CONTEXT_EDIT("ce1", "m1", "m1", "safe replacement"),
		]);
		const entries = loadEntriesFromFile(filePath) as SessionEntry[];
		expect(entries).toHaveLength(3);

		const projection = buildSessionProjection(entries);
		expect(projection.messages).toHaveLength(1);
		const projectedText = JSON.stringify(projection.messages);
		expect(projectedText).toContain("safe replacement");
		expect(projectedText).not.toContain("raw secret marker");
	});

	it("omits the target entirely when the replacement is null", () => {
		const filePath = writeSession("context-edit-null.jsonl", [
			HEADER(CURRENT_SESSION_VERSION),
			USER_MESSAGE("m1", "raw secret marker"),
			CONTEXT_EDIT("ce1", "m1", "m1", null),
		]);
		const entries = loadEntriesFromFile(filePath) as SessionEntry[];
		const projection = buildSessionProjection(entries);
		expect(projection.messages).toHaveLength(0);
	});
});

describe("li session compatibility: fail closed before any write", () => {
	it("refuses a newer session format version and keeps bytes + mtime", () => {
		const filePath = writeSession("v4.jsonl", [HEADER(CURRENT_SESSION_VERSION + 1), USER_MESSAGE("m1", "hello")]);
		const before = snapshot(filePath);
		expect(() => loadEntriesFromFile(filePath)).toThrow(UnsupportedSessionVersionError);
		const after = snapshot(filePath);
		expect(after.bytes).toBe(before.bytes);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it("refuses an unknown entry type and keeps bytes + mtime", () => {
		const filePath = writeSession("unknown-entry.jsonl", [
			HEADER(CURRENT_SESSION_VERSION),
			USER_MESSAGE("m1", "hello"),
			JSON.stringify({
				type: "quantum_branch",
				id: "q1",
				parentId: "m1",
				timestamp: "2026-10-19T00:00:03.000Z",
				payload: { anything: true },
			}),
		]);
		const before = snapshot(filePath);
		expect(() => loadEntriesFromFile(filePath)).toThrow(UnknownSessionEntryTypeError);
		const after = snapshot(filePath);
		expect(after.bytes).toBe(before.bytes);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it("does not append the trailing-newline repair when the file is refused", () => {
		const filePath = writeSession(
			"unknown-entry-no-newline.jsonl",
			[
				HEADER(CURRENT_SESSION_VERSION),
				JSON.stringify({ type: "mystery", id: "x1", parentId: null, timestamp: "t" }),
			],
			false,
		);
		const before = snapshot(filePath);
		expect(before.bytes.endsWith("\n")).toBe(false);
		expect(() => loadEntriesFromFile(filePath)).toThrow(UnknownSessionEntryTypeError);
		const after = snapshot(filePath);
		expect(after.bytes).toBe(before.bytes);
	});

	it("error copy names the runtime and never suggests editing the file", () => {
		const filePath = writeSession("v99.jsonl", [HEADER(CURRENT_SESSION_VERSION + 95)]);
		try {
			loadEntriesFromFile(filePath);
			throw new Error("expected UnsupportedSessionVersionError");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedSessionVersionError);
			const message = (error as Error).message;
			expect(message).toContain(`supports up to v${CURRENT_SESSION_VERSION}`);
			expect(message).toContain("left untouched");
			expect(message).toContain(APP_NAME);
		}
	});
});

describe("li session compatibility: known entry types stay loadable", () => {
	it("accepts a v3 session containing every known entry type", () => {
		const lines = [
			HEADER(CURRENT_SESSION_VERSION),
			USER_MESSAGE("m1", "hello"),
			JSON.stringify({
				type: "thinking_level_change",
				id: "t1",
				parentId: "m1",
				timestamp: "t",
				thinkingLevel: "high",
			}),
			JSON.stringify({
				type: "model_change",
				id: "mc1",
				parentId: "t1",
				timestamp: "t",
				provider: "zai",
				modelId: "glm",
			}),
			JSON.stringify({
				type: "usage",
				id: "u1",
				parentId: "mc1",
				timestamp: "t",
				kind: "cache_warm",
				provider: "zai",
				model: "glm",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			}),
			JSON.stringify({
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "t",
				summary: "summary",
				firstKeptEntryId: "m1",
				tokensBefore: 100,
			}),
			JSON.stringify({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "t" }),
			JSON.stringify({ type: "custom", id: "cu1", parentId: "b1", timestamp: "t", customType: "note", data: {} }),
			JSON.stringify({ type: "label", id: "l1", parentId: "cu1", timestamp: "t", label: "pin" }),
			JSON.stringify({ type: "session_info", id: "si1", parentId: "l1", timestamp: "t" }),
			JSON.stringify({
				type: "custom_message",
				id: "cm1",
				parentId: "si1",
				timestamp: "t",
				customType: "widget",
				content: [{ type: "text", text: "hi" }],
				display: true,
			}),
			CONTEXT_EDIT("ce1", "cm1", "m1", "edited"),
		];
		const filePath = writeSession("all-known-types.jsonl", lines);
		const entries = loadEntriesFromFile(filePath);
		expect(entries).toHaveLength(12);
	});

	it("exposes the same allowlist the validator enforces", () => {
		expect(KNOWN_SESSION_ENTRY_TYPES.has("context_edit")).toBe(true);
		expect(KNOWN_SESSION_ENTRY_TYPES.has("session")).toBe(false); // header, not an entry
		expect(KNOWN_SESSION_ENTRY_TYPES.has("quantum_branch")).toBe(false);
	});

	it("still repairs the trailing newline for accepted sessions", () => {
		const filePath = writeSession(
			"v3-no-newline.jsonl",
			[HEADER(CURRENT_SESSION_VERSION), USER_MESSAGE("m1", "hello")],
			false,
		);
		const entries = loadEntriesFromFile(filePath);
		expect(entries).toHaveLength(2);
		expect(readFileSync(filePath, "utf8").endsWith("\n")).toBe(true);
	});
});

describe("li session compatibility: v1 files migrate like Pi", () => {
	it("migrates a versionless (v1) header instead of refusing", () => {
		const filePath = writeSession("v1.jsonl", [
			JSON.stringify({ type: "session", id: "legacy", timestamp: "t", cwd: fixtureDir() }),
			USER_MESSAGE("m1", "old session"),
		]);
		const entries = loadEntriesFromFile(filePath);
		expect(entries).toHaveLength(2);
		expect(existsSync(filePath)).toBe(true);
	});
});
