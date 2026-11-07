import { describe, expect, it } from "vitest";
import {
	parseSessionTranscriptStrict,
	SessionManager,
	SessionTranscriptParseError,
} from "../../src/core/session-manager.ts";

const header = {
	type: "session",
	version: 3,
	id: "synthetic-session",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/synthetic/project",
};

function entry(id: string, parentId: string | null, type = "message") {
	if (type === "message") {
		return {
			type,
			id,
			parentId,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: id, timestamp: 1 },
		};
	}
	return { type, id, parentId, timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", label: "checkpoint" };
}

function jsonl(...records: unknown[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("SessionManager strict staged reload", () => {
	it("parses a valid v3 transcript and stages rebuilt indices without mutating live state", () => {
		const original = jsonl(header, entry("u1", null));
		const manager = SessionManager.inMemory(header.cwd);
		manager.appendMessage({ role: "user", content: "existing state", timestamp: 1 });
		const candidate = jsonl(header, entry("u1", null), entry("label-1", "u1", "label"));
		const stage = manager.stageReload(candidate);

		expect(stage.sessionId).toBe(header.id);
		expect(stage.entryCount).toBe(2);
		expect(manager.getEntryCount()).toBe(1);
		expect(manager.getLabel("u1")).toBeUndefined();
		expect(original).not.toBe(candidate);

		manager.commitStagedReload(stage);
		expect(manager.getEntryCount()).toBe(2);
		expect(manager.getLeafId()).toBe("label-1");
		expect(manager.getLabel("u1")).toBe("checkpoint");
		expect(manager.getBranch().map((item) => item.id)).toEqual(["u1", "label-1"]);
	});

	it("refuses malformed JSON, invalid parent shapes, unsupported versions, and active-path gaps", () => {
		expect(() => parseSessionTranscriptStrict(`${JSON.stringify(header)}\n{broken}\n`)).toThrow(
			SessionTranscriptParseError,
		);
		expect(() => parseSessionTranscriptStrict(jsonl(header, { ...entry("u1", null), parentId: [] }))).toThrow(
			/parentId must be null or a string/,
		);
		expect(() => parseSessionTranscriptStrict(jsonl({ ...header, version: 99 }))).toThrow(
			/unsupported session version/,
		);
		expect(() => parseSessionTranscriptStrict(jsonl(header, entry("u2", "missing-parent")))).toThrow(
			/active path is broken/,
		);
	});

	it("strictly normalizes a valid v1 schema for inspection but refuses to commit legacy bytes", () => {
		const legacyHeader = {
			type: "session",
			id: "legacy-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/legacy",
		};
		const legacyMessage = {
			type: "message",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "legacy", timestamp: 1 },
		};
		const parsed = parseSessionTranscriptStrict(jsonl(legacyHeader, legacyMessage));
		expect(parsed.entries[0]?.id).toBe("legacy-1");
		expect(parsed.entries[0]?.parentId).toBeNull();
		const manager = SessionManager.inMemory(legacyHeader.cwd);
		expect(() => manager.stageReload(jsonl(legacyHeader, legacyMessage))).toThrow(/legacy versions must be migrated/);
	});

	it("rejects duplicate entry ids and forward parent edges", () => {
		expect(() => parseSessionTranscriptStrict(jsonl(header, entry("u1", null), entry("u1", "u1")))).toThrow(
			/duplicate entry id/,
		);
		const child = entry("child", "parent");
		const parent = entry("parent", null);
		expect(() => parseSessionTranscriptStrict(jsonl(header, child, parent))).toThrow(/forward edge/);
	});

	it("does not repair or rewrite candidate bytes when strict parsing refuses", () => {
		const malformed = `${JSON.stringify(header)}\n{"type":"message","id":"x","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z"}\n`;
		const manager = SessionManager.inMemory(header.cwd);
		manager.appendMessage({ role: "user", content: "existing state", timestamp: 1 });
		const before = manager.getEntries();
		const previousLeaf = manager.getLeafId();

		expect(() => manager.stageReload(malformed)).toThrow(/message entry needs an object message/);
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getLeafId()).toBe(previousLeaf);
	});
});
