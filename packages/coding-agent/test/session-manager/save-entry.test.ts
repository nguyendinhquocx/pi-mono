import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg } from "../utilities.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("rejects malformed custom messages and snapshots content before persistence", () => {
		const session = SessionManager.inMemory();
		const entryCountBefore = session.getEntries().length;

		expect(() => session.appendCustomMessageEntry(undefined as any, [], false)).toThrow(/customType/i);
		expect(() => session.appendCustomMessageEntry("bad-block", [null] as any, false)).toThrow(/text\/image blocks/i);
		expect(() => session.appendMessage({ role: "custom", content: [], display: false, timestamp: 1 } as any)).toThrow(
			/customType/i,
		);
		expect(() =>
			session.appendMessage({
				role: "custom",
				customType: "invalid-time",
				content: [],
				display: false,
				timestamp: Number.NaN,
			} as any),
		).toThrow(/timestamp.*finite/i);
		expect(session.getEntries()).toHaveLength(entryCountBefore);

		let roleReads = 0;
		const customMessage = {
			get role() {
				roleReads++;
				return roleReads === 1 ? "custom" : "user";
			},
			customType: "routed-custom",
			content: [],
			display: false,
			timestamp: 1,
			toJSON: () => ({ role: "user", content: "spoofed" }),
		};
		const routedId = session.appendMessage(customMessage as any);
		expect(roleReads).toBe(1);
		expect(session.getEntry(routedId)).toMatchObject({
			type: "message",
			message: { role: "custom", customType: "routed-custom", content: [], display: false, timestamp: 1 },
		});

		const content = [{ type: "text" as const, text: "before" }];
		const id = session.appendCustomMessageEntry("test", content, false);
		content[0]!.text = "after";
		expect(session.getEntry(id)).toMatchObject({ content: [{ type: "text", text: "before" }] });
	});

	it("validates and snapshots context edits against the target content contract", () => {
		const session = SessionManager.inMemory();
		const customTargetId = session.appendCustomMessageEntry("custom-context", "original", false);
		const entriesBefore = session.getEntries().length;
		const invalidContents = [[null], [{ type: "toolCall", id: "call", name: "read", arguments: {} }], new Array(1)];

		for (const content of invalidContents) {
			expect(() => session.appendContextEdit(customTargetId, { content } as any)).toThrow(/text\/image/i);
		}
		expect(session.getEntries()).toHaveLength(entriesBefore);

		const replacementContent = [{ type: "text" as const, text: "replacement" }];
		const contextEditId = session.appendContextEdit(customTargetId, { content: replacementContent });
		replacementContent[0]!.text = "mutated after append";
		expect(session.getEntry(contextEditId)).toMatchObject({
			type: "context_edit",
			targetId: customTargetId,
			replacement: { content: [{ type: "text", text: "replacement" }] },
		});

		const assistantTargetId = session.appendMessage({
			...assistantMsg("tool call"),
			content: [{ type: "toolCall" as const, id: "call", name: "read", arguments: {} }],
			stopReason: "toolUse",
		});
		const assistantEditId = session.appendContextEdit(assistantTargetId, {
			content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
		});
		expect(session.getEntry(assistantEditId)).toMatchObject({
			type: "context_edit",
			replacement: { content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }] },
		});
	});

	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
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
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});
