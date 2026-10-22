import { setKeybindings } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSelector(sessions: SessionInfo[]): SessionSelectorComponent {
	return new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
}

describe("session selector selection style (Li)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	it("marks the selected row with an arrow and bold instead of a background", async () => {
		const originalColorLevel = chalk.level;
		chalk.level = 3;
		try {
			const selector = createSelector([makeSession({ id: "a" }), makeSession({ id: "b" })]);
			await flushPromises();

			const raw = selector.render(120).join("\n");
			expect(raw).toContain("→");
			expect(raw).toContain("\u001b[1m");
			expect(raw).not.toContain("\u001b[44m");
		} finally {
			chalk.level = originalColorLevel;
		}
	});
});
