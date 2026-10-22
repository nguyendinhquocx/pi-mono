import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { getLiUiCopy, LI_UI_COPY, type LiUiCopy } from "../src/modes/interactive/locale.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..", "..", "..");

function readSource(relativeOrAbsolute: string): string {
	const isAbsolute = /^[a-zA-Z]:[\\/]/.test(relativeOrAbsolute) || relativeOrAbsolute.startsWith("/");
	return readFileSync(isAbsolute ? relativeOrAbsolute : join(repoRoot, relativeOrAbsolute), "utf8");
}

/** Collect every plain string reachable in a catalog (functions are sampled with simple args). */
function collectCatalogTexts(copy: LiUiCopy): Set<string> {
	const texts = new Set<string>();
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			texts.add(value);
			return;
		}
		if (typeof value === "function") {
			const fn = value as (...args: unknown[]) => unknown;
			for (const sample of ["", "x", 0, 1, false, true]) {
				try {
					visit(fn(sample));
				} catch {
					// skip incompatible arity samples
				}
			}
			return;
		}
		if (value && typeof value === "object") {
			for (const child of Object.values(value as Record<string, unknown>)) visit(child);
		}
	};
	visit(copy);
	return texts;
}

const CATALOG_TEXTS = new Set([...collectCatalogTexts(LI_UI_COPY.en), ...collectCatalogTexts(LI_UI_COPY.vi)]);

/** Extract double-quoted string literal contents from TypeScript source. */
function extractStringLiterals(source: string): string[] {
	const literals: string[] = [];
	const pattern = /"((?:[^"\\\n]|\\.)*)"/g;
	let match = pattern.exec(source);
	while (match !== null) {
		literals.push(match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
		match = pattern.exec(source);
	}
	return literals;
}

/** Setting ids and cycle values are data, not UI copy: all-lowercase technical tokens. */
function isIdOrValueToken(literal: string): boolean {
	return /^[a-z0-9 ._\-/]*$/.test(literal) && literal.length > 0;
}

/** Extra literals in settings-selector.ts that are neither ids/values nor catalog copy. */
const SELECTOR_EXTRA_ALLOWLIST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /^@earendil-works\//, reason: "module specifier" },
	{ pattern: /^app\.[A-Za-z.]+$/, reason: "keybinding action id" },
];

const SELECTOR_EXTRA_ALLOWLIST = new Map<string, string>([
	["configure", "generic submenu placeholder value"],
	["__clear__", "internal clear-override sentinel"],
	["not set", "placeholder for a missing default model"],
	["✓ ", "selection checkmark symbol, locale-neutral"],
	["  ", "selection indent, locale-neutral"],
]);

const SETTINGS_LIST_SOURCE = "packages/tui/src/components/settings-list.ts";
const SETTINGS_SELECTOR_SOURCE = "packages/coding-agent/src/modes/interactive/components/settings-selector.ts";
const INTERACTIVE_MODE_SOURCE = "packages/coding-agent/src/modes/interactive/interactive-mode.ts";
const MODEL_SELECTOR_SOURCE = "packages/coding-agent/src/modes/interactive/components/model-selector.ts";
const PI_ASK_SOURCE = "D:/pcloud/workspace/code/python/app_presets/pi/extensions/pi-ask/component.ts";
const APPROVAL_SOURCE = "D:/pcloud/workspace/code/python/app_presets/pi/extensions/pi-terminal-relay/approval.ts";

/** Copy shown only under APP_NAME !== "li": Pi-only strings, never localized. */
const PI_ONLY_STATUS_ALLOWLIST = new Map<string, string>([
	["Resumed session", "Pi-only resume copy"],
	["Resumed session in current cwd", "Pi-only resume copy"],
]);

/**
 * Capture the full argument expression of every showStatus( call, honoring
 * parens and string/template contents so nested calls don't break the scan.
 */
function extractShowStatusArgs(source: string): string[] {
	const args: string[] = [];
	for (const match of source.matchAll(/\bshowStatus\(/g)) {
		let index = match.index + match[0].length;
		const start = index;
		let depth = 1;
		while (index < source.length && depth > 0) {
			const char = source[index];
			if (char === "(") {
				depth++;
			} else if (char === ")") {
				depth--;
			} else if (char === '"' || char === "`" || char === "'") {
				const quote = char;
				index++;
				while (index < source.length && source[index] !== quote) {
					if (source[index] === "\\") index++;
					index++;
				}
			}
			index++;
		}
		args.push(source.slice(start, index - 1).trim());
	}
	return args;
}

describe("Li UI copy coverage inventory", () => {
	it("keeps every fixed SettingsList string inside the Li catalog", () => {
		const source = readSource(SETTINGS_LIST_SOURCE);
		const en = getLiUiCopy("en").settingsList;
		const fixedStrings = [
			"No settings available",
			"No matching settings",
			"  Type to search · Enter/Space to change · Esc to cancel",
			"  Enter/Space to change · Esc to cancel",
		];
		for (const literal of fixedStrings) {
			expect(source.includes(literal), `settings-list.ts lost ${literal}`).toBe(true);
			const covered =
				Object.values(en).includes(literal) || Object.values(LI_UI_COPY.vi.settingsList).includes(literal);
			// EN catalog must mirror the shipped default wording; VI has its own strings.
			if (literal === fixedStrings[0] || literal === fixedStrings[1]) {
				expect(literal === en.empty || literal === en.noMatch).toBe(true);
			} else {
				expect(literal === en.searchHint || literal === en.hint).toBe(true);
			}
			expect(covered || literal === en.searchHint || literal === en.hint).toBe(true);
		}
	});

	it("classifies every string literal in settings-selector.ts as catalog copy, id/value, or explicit allowlist", () => {
		const source = readSource(SETTINGS_SELECTOR_SOURCE);
		const literals = extractStringLiterals(source);
		const orphans: string[] = [];
		for (const literal of literals) {
			if (CATALOG_TEXTS.has(literal)) continue;
			if (isIdOrValueToken(literal)) continue;
			if (SELECTOR_EXTRA_ALLOWLIST.has(literal)) continue;
			if (SELECTOR_EXTRA_ALLOWLIST_PATTERNS.some(({ pattern }) => pattern.test(literal))) continue;
			orphans.push(literal);
		}
		expect(orphans, `UI copy literals outside the Li catalog: ${orphans.join(" | ")}`).toEqual([]);
	});

	it("keeps legacy extension chrome out of the render path (copy flows through the catalog)", () => {
		// pi-ask: after the catalog block the render/input code must not hardcode
		// any of the old chrome strings; they live only inside ASK_COPY.
		const askSource = readSource(PI_ASK_SOURCE);
		// Comments may quote chrome text for context; only executable lines matter.
		const askCode = askSource.replace(/^\s*\/\/.*$/gm, "");
		const askRenderPart = askCode.slice(askCode.indexOf("function askCopy"));
		const legacyAskChrome = [
			"Clipboard không có ảnh, file hoặc văn bản.",
			"Clipboard trả về ảnh không hợp lệ.",
			"Đã dán văn bản từ clipboard.",
			"Clipboard trống.",
			"Dán clipboard thất bại: ",
			" Ghi chú (làm rõ lựa chọn):",
			" Câu trả lời:",
			"Enter lưu (rỗng = xóa) · Esc bỏ",
			"Enter lưu · Esc bỏ",
			" Thoát form? Enter thoát · Esc ở lại",
			"Space/Tab nhập tay",
			"Space đánh dấu · Enter xong",
			"Enter/Space chọn",
			" Sẵn sàng gửi",
			" Còn câu chưa trả lời",
			' Ghi chú chung: "',
			" Ghi chú chung (cho cả form):",
			" Enter để gửi",
			" Thiếu: ",
			" n ghi chú chung · Enter gửi · Esc thoát",
			" dán ảnh · tự đóng sau 30 phút không thao tác",
			"[Ảnh đính kèm #",
			"Type your own answer...",
			" ✎note",
		];
		const askLeaks = legacyAskChrome.filter((literal) => askRenderPart.includes(literal));
		expect(askLeaks, `pi-ask chrome hardcoded outside ASK_COPY: ${askLeaks.join(" | ")}`).toEqual([]);

		// pi-terminal-relay: same rule for the approval screen.
		const approvalSource = readSource(APPROVAL_SOURCE);
		const approvalCode = approvalSource.replace(/^\s*\/\/.*$/gm, "");
		const approvalRenderPart = approvalCode.slice(approvalCode.indexOf("function approvalCopy"));
		const legacyApprovalChrome = [
			"Terminal approval",
			"Target: ",
			"Run: ",
			"Reason: ",
			"Why: ",
			"Critical: Enter mở typed confirmation",
			"Enter approve · Esc reject",
			"↑↓ xem steps",
			"Type ",
			" to approve critical run",
			// Quoted so identifiers like copy.visibleStep / visibleCount do not match.
			'"visible"',
			'"direct"',
		];
		const approvalLeaks = legacyApprovalChrome.filter((literal) => approvalRenderPart.includes(literal));
		expect(
			approvalLeaks,
			`pi-terminal-relay chrome hardcoded outside APPROVAL_COPY: ${approvalLeaks.join(" | ")}`,
		).toEqual([]);
	});

	it("counts the audited callsite surfaces so the inventory stays intentional", () => {
		const surfaces = [SETTINGS_LIST_SOURCE, SETTINGS_SELECTOR_SOURCE, PI_ASK_SOURCE, APPROVAL_SOURCE];
		for (const surface of surfaces) {
			expect(readSource(surface).length, `${surface} inventory source missing`).toBeGreaterThan(0);
		}
		// The EN catalog must keep the exact shipped wording for the rows the
		// existing Pi tests cycle by label.
		const en = LI_UI_COPY.en;
		expect(en.settings.items.autocompact.label).toBe("Auto-compact");
		expect(en.settings.items.tuiMode.label).toBe("TUI mode");
		expect(en.settingsList.hint).toBe("  Enter/Space to change · Esc to cancel");
		expect(en.settingsList.noMatch).toBe("No matching settings");
	});

	it("routes model-selector refresh status through the locale catalog", () => {
		const source = readSource(MODEL_SELECTOR_SOURCE);
		expect(source).toContain("liCopy().status.refreshingModelCatalogs");
		expect(source).toContain("liCopy().status.modelCatalogsRefreshed");
		expect(source).not.toContain('"Refreshing model catalogs…"');
		expect(source).not.toContain('"Model catalogs refreshed."');
		const interactiveSource = readSource(INTERACTIVE_MODE_SOURCE);
		expect(interactiveSource).toContain("refreshStatus: liCopy().status.refreshingModelCatalogs");
		expect(interactiveSource).toContain(
			'selector.setRefreshStatus(liCopy().status.modelCatalogsRefreshed, "success")',
		);
		expect(interactiveSource).not.toContain('selector.setRefreshStatus("Model catalogs refreshed.", "success")');
	});

	it("keeps every built-in slash command inside both catalogs (descriptions only)", () => {
		expect(BUILTIN_SLASH_COMMANDS).toHaveLength(24);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(LI_UI_COPY.en.slashCommands[command.name]?.description, `en/${command.name}`).toBe(command.description);
			expect(LI_UI_COPY.vi.slashCommands[command.name]?.description, `vi/${command.name}`).toBeTruthy();
		}
		// argumentHint is data, not copy: the catalog entries carry only descriptions.
		expect(Object.keys(LI_UI_COPY.en.slashCommands)).toHaveLength(24);
		expect(Object.keys(LI_UI_COPY.vi.slashCommands)).toHaveLength(24);
	});

	it("keeps built-in /hotkeys copy in the locale catalog", () => {
		const source = readSource(INTERACTIVE_MODE_SOURCE);
		const start = source.indexOf("private handleHotkeysCommand(): void {");
		const end = source.indexOf("\n\tprivate async handleClearCommand()", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const method = source.slice(start, end);
		const orphanLiterals = extractStringLiterals(method).filter(
			(literal) =>
				!CATALOG_TEXTS.has(literal) && !isIdOrValueToken(literal) && !/^(?:tui|app)\.[A-Za-z0-9.]+$/.test(literal),
		);
		expect(orphanLiterals, `Hotkeys UI copy outside the locale catalog: ${orphanLiterals.join(" | ")}`).toEqual([]);
	});

	it("routes every showStatus literal in interactive-mode.ts through the catalog or the Pi-only allowlist", () => {
		const source = readSource(INTERACTIVE_MODE_SOURCE);
		const args = extractShowStatusArgs(source);
		// Definitions, wrappers and pass-throughs are included; the real callsites dominate.
		expect(args.length).toBeGreaterThanOrEqual(50);
		const orphans: string[] = [];
		let literalArgs = 0;
		for (const arg of args) {
			if (arg.startsWith('"')) {
				literalArgs++;
				const literal = arg.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
				if (CATALOG_TEXTS.has(literal) || PI_ONLY_STATUS_ALLOWLIST.has(literal)) continue;
				orphans.push(literal);
			} else if (arg.startsWith("`")) {
				// Template literals in showStatus bypass the catalog: they must become
				// catalog functions so VI can reorder around the dynamic value.
				orphans.push(arg);
			}
		}
		// The only remaining literals are the two Pi-only resume strings.
		expect(literalArgs).toBe(PI_ONLY_STATUS_ALLOWLIST.size);
		expect(orphans, `showStatus copy outside the catalog: ${orphans.join(" | ")}`).toEqual([]);
	});

	it("rebuilds slash autocomplete after a locale change", () => {
		const source = readSource(INTERACTIVE_MODE_SOURCE);
		const handlerStart = source.indexOf("onLiLanguageChange: (locale) => {");
		expect(handlerStart).toBeGreaterThanOrEqual(0);
		const handlerEnd = source.indexOf("\n\t\t\t\t\t},", handlerStart);
		expect(handlerEnd).toBeGreaterThan(handlerStart);
		const handler = source.slice(handlerStart, handlerEnd);
		const applyIndex = handler.indexOf("applyLiLocale(locale)");
		const rebuildIndex = handler.indexOf("this.setupAutocompleteProvider()");
		const settingsIndex = handler.indexOf('this.showSettingsSelector("li-language")');
		expect(applyIndex).toBeGreaterThanOrEqual(0);
		expect(rebuildIndex).toBeGreaterThan(applyIndex);
		expect(settingsIndex).toBeGreaterThan(rebuildIndex);
	});

	it('keeps the Pi-only resume copy verbatim inside APP_NAME !== "li" branches', () => {
		const lines = readSource(INTERACTIVE_MODE_SOURCE).split("\n");
		for (const [literal, reason] of PI_ONLY_STATUS_ALLOWLIST) {
			const line = lines.find((candidate) => candidate.includes(`showStatus("${literal}")`));
			expect(line, `${literal} (${reason}) must stay in the source`).toBeDefined();
			expect(line!.includes('APP_NAME !== "li"'), `${literal} must stay Pi-gated`).toBe(true);
		}
	});
});
