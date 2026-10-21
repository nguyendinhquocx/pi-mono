import type { TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { isLiToolOutputBlank, setLiToolOutputStyle } from "../src/modes/interactive/tool-output-style.ts";

afterEach(() => {
	setLiToolOutputStyle("blank");
});

describe("Li tool output style", () => {
	it("defaults to blank backgrounds", () => {
		expect(isLiToolOutputBlank()).toBe(true);
	});

	it("removes inverse background emphasis but keeps current mode reversible", () => {
		initTheme("dark");
		const originalColorLevel = chalk.level;
		chalk.level = 3;
		const diff = "-1 old value\n+1 new value";

		try {
			setLiToolOutputStyle("blank");
			const blankOutput = renderDiff(diff);
			expect(blankOutput).toContain("-1");
			expect(blankOutput).toContain("+1");
			expect(blankOutput).not.toContain("\u001b[7m");

			setLiToolOutputStyle("current");
			expect(renderDiff(diff)).toContain("\u001b[7m");
		} finally {
			chalk.level = originalColorLevel;
		}
	});

	it("removes fills from tool output, user messages, and peer/subagent custom messages", () => {
		initTheme("dark");
		const ui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;
		const message: CustomMessage = {
			role: "custom",
			customType: "peer_message",
			content: "peer body",
			display: true,
			timestamp: Date.now(),
		};
		const customMessage = new CustomMessageComponent(message);
		const userMessage = new UserMessageComponent("user sent content");
		const toolOutput = new ToolExecutionComponent(
			"peer_send",
			"tool-call-1",
			{ target: "peer", objective: "message body" },
			{},
			undefined,
			ui,
			"D:/project",
		);
		const newline = String.fromCharCode(10);
		const backgroundPrefix = `${String.fromCharCode(27)}[48`;

		setLiToolOutputStyle("blank");
		const blankCustom = customMessage.render(100).join(newline);
		const blankUser = userMessage.render(100).join(newline);
		const blankTool = toolOutput.render(100).join(newline);
		expect(blankCustom).not.toContain(backgroundPrefix);
		expect(blankUser).not.toContain(backgroundPrefix);
		expect(blankTool).not.toContain(backgroundPrefix);

		setLiToolOutputStyle("current");
		customMessage.invalidate();
		userMessage.invalidate();
		toolOutput.invalidate();
		const currentCustom = customMessage.render(100).join(newline);
		const currentUser = userMessage.render(100).join(newline);
		const currentTool = toolOutput.render(100).join(newline);
		expect(currentCustom).toContain(backgroundPrefix);
		expect(currentUser).toContain(backgroundPrefix);
		expect(currentTool).toContain(backgroundPrefix);
	});
});
