import { describe, expect, it } from "vitest";
import { SessionWriteGatedError } from "../src/core/session-manager.ts";
import { createTestSession } from "./utilities.ts";

describe("AgentSession in-place session-data admission gate", () => {
	it("rejects prompts, steering, follow-ups, custom messages, and persistence while locked", async () => {
		const fixture = await createTestSession({ inMemory: true });
		const { session, sessionManager } = fixture;
		const internals = session as unknown as { _sessionDataAdmissionLocked: boolean };
		const beforeCount = sessionManager.getEntryCount();
		internals._sessionDataAdmissionLocked = true;

		try {
			await expect(session.prompt("must not enter the queue")).rejects.toMatchObject({
				code: "session_data_locked",
			});
			await expect(session.steer("must not steer")).rejects.toMatchObject({ code: "session_data_locked" });
			await expect(session.followUp("must not follow up")).rejects.toMatchObject({ code: "session_data_locked" });
			await expect(session.agent.prompt("direct Agent.prompt bypass attempt")).rejects.toMatchObject({
				code: "session_data_locked",
			});
			expect(() =>
				session.agent.steer({ role: "user", content: "direct steer bypass", timestamp: Date.now() }),
			).toThrow(/Session data is locked/);
			expect(() =>
				session.agent.followUp({ role: "user", content: "direct follow-up bypass", timestamp: Date.now() }),
			).toThrow(/Session data is locked/);
			await expect(
				session.sendCustomMessage({ customType: "test", content: "must not persist", display: false }),
			).rejects.toMatchObject({ code: "session_data_locked" });
			expect(() =>
				sessionManager.appendMessage({ role: "user", content: "must not persist", timestamp: Date.now() }),
			).toThrow(SessionWriteGatedError);

			expect(session.pendingMessageCount).toBe(0);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(sessionManager.getEntryCount()).toBe(beforeCount);
		} finally {
			internals._sessionDataAdmissionLocked = false;
			fixture.cleanup();
		}
	});
});
