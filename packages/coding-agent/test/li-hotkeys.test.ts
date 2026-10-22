import { Container, Markdown } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../tui/src/utils.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { applyLiLocale, currentLiLocale, LI_UI_COPY, type LiLocale } from "../src/modes/interactive/locale.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type HotkeysHarness = {
	getEditorKeyDisplay: (action: string) => string;
	getAppKeyDisplay: (action: string) => string;
	session: { extensionRunner: { getShortcuts: () => Map<string, unknown> } };
	keybindings: { getEffectiveConfig: () => Record<string, never> };
	chatContainer: Container;
	getMarkdownThemeWithSettings: () => object;
	ui: { requestRender: () => void };
};

function renderHotkeys(locale: LiLocale): {
	text: string;
	markdown: { text: string; render: (width: number) => string[] };
} {
	applyLiLocale(locale);
	const extensionShortcuts = new Map([
		["ctrl+e", { description: "Extension-provided description", extensionPath: "/extension/path" }],
		["ctrl+p", { extensionPath: "/fallback/extension/path" }],
	]);
	const context: HotkeysHarness = {
		getEditorKeyDisplay: (action) => {
			const keys: Record<string, string> = {
				"tui.editor.cursorUp": "Ctrl+Up",
				"tui.input.submit": "Enter",
			};
			return keys[action] ?? "Ctrl+K";
		},
		getAppKeyDisplay: (action) => (action === "app.interrupt" ? "Ctrl+C" : "Alt+X"),
		session: { extensionRunner: { getShortcuts: () => extensionShortcuts } },
		keybindings: { getEffectiveConfig: () => ({}) },
		chatContainer: new Container(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		ui: { requestRender: vi.fn() },
	};

	(
		InteractiveMode.prototype as unknown as { handleHotkeysCommand: (this: HotkeysHarness) => void }
	).handleHotkeysCommand.call(context);

	const markdownComponent = context.chatContainer.children.find((child) => child instanceof Markdown);
	if (!markdownComponent) throw new Error("/hotkeys did not add its Markdown content");
	const markdown = markdownComponent as unknown as { text: string; render: (width: number) => string[] };
	const title = context.chatContainer.children.find((child) => child.constructor.name === "ThemedText");
	if (!title) throw new Error("/hotkeys did not add its title");
	return { text: `${stripAnsi(title.render(120).join("\n"))}\n${markdown.text}`, markdown };
}

describe("Li /hotkeys localization", () => {
	let previousLocale: LiLocale;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		previousLocale = currentLiLocale();
	});
	afterEach(() => applyLiLocale(previousLocale));

	it("renders Vietnamese headings/actions while preserving key and extension data", () => {
		const { text } = renderHotkeys("vi");

		expect(text).toContain("Phím tắt");
		expect(text).toContain("**Điều hướng**");
		expect(text).toContain("**Tiện ích mở rộng**");
		expect(text).toContain("| Phím | Tác vụ |");
		expect(text).toContain("Di chuyển con trỏ / duyệt lịch sử");
		expect(text).toContain("Xuống dòng");
		expect(text).toContain("Bật/tắt mở rộng kết quả tool");
		expect(text).toContain("Ctrl+Up");
		expect(text).toContain("Ctrl+C");
		expect(text).toContain("Extension-provided description");
		expect(text).toContain("/fallback/extension/path");
		expect(text).not.toContain("Keyboard Shortcuts");
		expect(text).not.toContain("Move cursor / browse history");
	});

	it("wraps VI Markdown at 40 and 80 columns without dropping shortcut text", () => {
		const { markdown } = renderHotkeys("vi");
		for (const width of [40, 80]) {
			const lines = markdown.render(width).map(stripAnsi);
			const normalized = lines.join(" ").replace(/\s+/g, " ");
			expect(normalized).toContain("Ctrl+Up");
			expect(normalized).toContain("Di chuyển");
			expect(normalized).toContain("trỏ");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("keeps the existing English copy verbatim", () => {
		const { text } = renderHotkeys("en");

		expect(text).toContain("Keyboard Shortcuts");
		expect(text).toContain("**Navigation**");
		expect(text).toContain("**Extensions**");
		expect(text).toContain("| Key | Action |");
		expect(text).toContain("Move cursor / browse history");
		expect(text).toContain("New line");
		expect(text).toContain("Run bash command (excluded from context)");
		expect(text).toContain("Extension-provided description");
	});

	it("keeps the Windows key notation in the localized note", () => {
		expect(LI_UI_COPY.en.hotkeys.actions.windowsNewLineNote).toBe("Ctrl+Enter on Windows Terminal");
		expect(LI_UI_COPY.vi.hotkeys.actions.windowsNewLineNote).toBe("Ctrl+Enter trên Windows Terminal");
	});
});
