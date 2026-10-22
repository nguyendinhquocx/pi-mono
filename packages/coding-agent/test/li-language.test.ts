import { CombinedAutocompleteProvider, setKeybindings } from "@earendil-works/pi-tui";
import { tmpdir } from "os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import {
	applyLiLocale,
	currentLiLocale,
	getLiUiCopy,
	LI_LANGUAGE_DISPLAY_VALUES,
	LI_UI_COPY,
	type LiLocale,
	liCopy,
	liLocaleDisplayLabel,
	liLocaleFromDisplayLabel,
	normalizeLiLocale,
} from "../src/modes/interactive/locale.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function deepKeyShape(value: unknown): string {
	if (value === null || typeof value !== "object") return typeof value;
	if (Array.isArray(value)) return `array(${value.length})`;
	const entries = Object.entries(value as Record<string, unknown>).map(
		([key, child]) => `${key}:${deepKeyShape(child)}`,
	);
	return `object{${entries.sort().join(",")}}`;
}

function makeLiConfig(language: LiLocale): SettingsConfig {
	return {
		liLanguage: language,
		warnings: {},
		defaultModel: "not set",
		availableDefaultModels: [],
		availableThinkingLevels: [],
		modelThinkingLevels: {},
		availableThemes: [],
		currentTheme: "system",
		defaultProjectTrust: "ask",
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		sessionShareDestination: "auto",
		httpIdleTimeoutMs: 10000,
		cacheWarmingMode: "off",
		mermaidRenderingMode: "streaming",
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		tuiMode: "fullscreen",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
		fullscreenWheelScrollLines: "auto",
	} as unknown as SettingsConfig;
}

describe("Li UI locale contract", () => {
	it("normalizes unknown locales to en", () => {
		expect(normalizeLiLocale("vi")).toBe("vi");
		expect(normalizeLiLocale("en")).toBe("en");
		expect(normalizeLiLocale("fr")).toBe("en");
		expect(normalizeLiLocale(undefined)).toBe("en");
		expect(normalizeLiLocale(42)).toBe("en");
	});

	it("round-trips display labels back to locale codes", () => {
		for (const locale of ["en", "vi"] as const) {
			const label = liLocaleDisplayLabel(locale);
			expect(LI_LANGUAGE_DISPLAY_VALUES).toContain(label);
			expect(liLocaleFromDisplayLabel(label)).toBe(locale);
		}
		// The value keeps a short EN/VI prefix so narrow terminals stay unambiguous.
		expect(liLocaleDisplayLabel("en").startsWith("EN · ")).toBe(true);
		expect(liLocaleDisplayLabel("vi").startsWith("VI · ")).toBe(true);
	});

	it("keeps EN and VI catalogs structurally identical", () => {
		expect(deepKeyShape(LI_UI_COPY.en)).toBe(deepKeyShape(LI_UI_COPY.vi));
	});

	it("falls back to en for unknown locales", () => {
		const en = getLiUiCopy("en");
		expect(getLiUiCopy("vi")).toBe(LI_UI_COPY.vi);
		expect(getLiUiCopy("fr" as LiLocale)).toBe(en);
	});

	it("publishes the env bridge only under the Li runtime", () => {
		// The Li fork's package.json sets piConfig.name = "li", so APP_NAME is "li"
		// here and currentLiLocale() follows applyLiLocale() directly.
		const hadLanguage = process.env.LI_UI_LANGUAGE !== undefined;
		const previousLanguage = process.env.LI_UI_LANGUAGE;
		const hadRuntime = process.env.LI_RUNTIME !== undefined;
		const previousRuntime = process.env.LI_RUNTIME;
		try {
			delete process.env.LI_UI_LANGUAGE;
			delete process.env.LI_RUNTIME;
			applyLiLocale("vi");
			expect(process.env.LI_UI_LANGUAGE).toBeUndefined();
			expect(currentLiLocale()).toBe("vi");

			process.env.LI_RUNTIME = "1";
			applyLiLocale("en");
			expect(process.env.LI_UI_LANGUAGE).toBe("en");
			applyLiLocale("vi");
			expect(process.env.LI_UI_LANGUAGE).toBe("vi");
			applyLiLocale("de" as LiLocale);
			expect(process.env.LI_UI_LANGUAGE).toBe("en");
		} finally {
			if (hadLanguage && previousLanguage !== undefined) process.env.LI_UI_LANGUAGE = previousLanguage;
			else delete process.env.LI_UI_LANGUAGE;
			if (hadRuntime && previousRuntime !== undefined) process.env.LI_RUNTIME = previousRuntime;
			else delete process.env.LI_RUNTIME;
		}
	});
});

describe("SettingsSelectorComponent language row", () => {
	let savedUiLanguage: string | undefined;
	let savedRuntime: string | undefined;

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	beforeEach(() => {
		savedUiLanguage = process.env.LI_UI_LANGUAGE;
		savedRuntime = process.env.LI_RUNTIME;
	});

	afterEach(() => {
		if (savedUiLanguage !== undefined) process.env.LI_UI_LANGUAGE = savedUiLanguage;
		else delete process.env.LI_UI_LANGUAGE;
		if (savedRuntime !== undefined) process.env.LI_RUNTIME = savedRuntime;
		else delete process.env.LI_RUNTIME;
	});

	function makeCallbacks(onLiLanguageChange: (locale: LiLocale) => void): SettingsCallbacks {
		return { onLiLanguageChange } as unknown as SettingsCallbacks;
	}

	it("appears when the host registers onLiLanguageChange", () => {
		const callbacks = makeCallbacks(vi.fn());
		const list = new SettingsSelectorComponent(makeLiConfig("en"), callbacks).getSettingsList();
		for (const character of "Interface language") list.handleInput(character);
		const text = list
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(text).toContain("Interface language");
		expect(text).not.toContain("No matching settings");
	});

	it("omits the language row when the host does not register onLiLanguageChange", () => {
		// Non-Li hosts must never see (or write) settings.li.language. The APP_NAME
		// half of the gate is compile-time for this repo (the fork's package.json
		// pins name="li"); this covers the callback half.
		const callbacks = {} as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(makeLiConfig("en"), callbacks).getSettingsList();
		for (const character of "Interface language") list.handleInput(character);
		const text = list
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(text).toContain("No matching settings");
	});

	it("cycles EN → VI and maps the display label back to the locale code", () => {
		const onLiLanguageChange = vi.fn();
		const callbacks = makeCallbacks(onLiLanguageChange);
		const list = new SettingsSelectorComponent(makeLiConfig("en"), callbacks).getSettingsList();

		list.selectItem("li-language");
		list.handleInput("\r");
		expect(onLiLanguageChange).toHaveBeenCalledWith("vi");

		list.handleInput("\r");
		expect(onLiLanguageChange).toHaveBeenCalledWith("en");
	});

	it("shows localized VI copy when the locale copy is passed in", () => {
		const callbacks = makeCallbacks(vi.fn());
		const component = new SettingsSelectorComponent(makeLiConfig("vi"), callbacks, getLiUiCopy("vi"));
		const list = component.getSettingsList();
		list.selectItem("li-language");
		const lines = list.render(120).map((line) => stripAnsi(line));
		const joined = lines.join("\n");

		expect(joined).toContain("Ngôn ngữ giao diện");
		expect(joined).toContain("VI · Tiếng Việt");
		expect(joined).toContain("Gõ để tìm");
		expect(joined).not.toContain("Interface language");
	});

	it("renders VI labels when the selector is built from liCopy() after applyLiLocale", () => {
		// Mirrors the production path in interactive-mode.ts: apply the locale,
		// then construct the selector with liCopy() — this is the regression that
		// shipped when the third constructor argument was omitted.
		applyLiLocale("vi");
		try {
			const callbacks = makeCallbacks(vi.fn());
			const list = new SettingsSelectorComponent(makeLiConfig("vi"), callbacks, liCopy()).getSettingsList();
			list.selectItem("li-language");
			const joined = list
				.render(80)
				.map((line) => stripAnsi(line))
				.join("\n");
			expect(joined).toContain("Ngôn ngữ giao diện");
			expect(joined).toContain("Gõ để tìm");
			expect(joined).not.toContain("Interface language");
		} finally {
			applyLiLocale("en");
		}
	});

	it("keeps the full value at 80 columns and the EN/VI prefix at 40 columns", () => {
		const callbacks = makeCallbacks(vi.fn());
		const list = new SettingsSelectorComponent(makeLiConfig("vi"), callbacks).getSettingsList();
		list.selectItem("li-language");

		const wide = list.render(80).map((line) => stripAnsi(line));
		expect(wide.join("\n")).toContain("VI · Tiếng Việt");

		const narrow = list.render(40).map((line) => stripAnsi(line));
		const narrowValue = narrow.find((line) => line.includes("Interface language"));
		expect(narrowValue).toBeDefined();
		// The value column is cut to 2 cells at 40 columns; the EN/VI prefix must survive.
		expect(narrowValue).toMatch(/VI$/);

		// The description must spell out both names so the prefix stays unambiguous.
		const descriptionBlock = narrow.slice(narrow.indexOf(narrowValue!) + 1).join("\n");
		expect(descriptionBlock).toContain("English");
		expect(descriptionBlock).toContain("Tiếng Việt");
	});

	it("keeps the VI keyboard footer fully readable at 40 columns", () => {
		const callbacks = makeCallbacks(vi.fn());
		const list = new SettingsSelectorComponent(makeLiConfig("vi"), callbacks, getLiUiCopy("vi")).getSettingsList();
		list.selectItem("li-language");
		const narrow = list.render(40).map((line) => stripAnsi(line));
		const hintLine = narrow.find((line) => line.includes("Esc"));
		expect(hintLine).toBeDefined();
		expect(hintLine!.includes("Esc thoát")).toBe(true);
	});
});

describe("Li / menu command descriptions", () => {
	/** Mirrors the interactive-mode wire: catalog lookup by command name, source fallback, hint untouched. */
	function wiredCommands(): { name: string; description: string; argumentHint?: string }[] {
		return BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: liCopy().slashCommands[command.name]?.description ?? command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));
	}

	async function menuDescriptions(): Promise<Map<string, string>> {
		const provider = new CombinedAutocompleteProvider(wiredCommands(), tmpdir());
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		expect(suggestions).not.toBeNull();
		return new Map((suggestions?.items ?? []).map((item) => [item.label, item.description ?? ""]));
	}

	it("keeps the EN catalog verbatim against BUILTIN_SLASH_COMMANDS", () => {
		expect(BUILTIN_SLASH_COMMANDS).toHaveLength(24);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(LI_UI_COPY.en.slashCommands[command.name]?.description, command.name).toBe(command.description);
		}
	});

	it("covers every built-in command in the VI catalog", () => {
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(LI_UI_COPY.vi.slashCommands[command.name]?.description, command.name).toBeTruthy();
		}
	});

	it("renders VI descriptions in the / menu under locale vi", async () => {
		applyLiLocale("vi");
		try {
			const byName = await menuDescriptions();
			expect(byName.get("settings")).toBe("Mở menu settings");
			// Commands with argumentHint render as "<hint> — description".
			expect(byName.get("thinking")).toBe("<level> — Đặt mức suy nghĩ");
			expect(byName.get("quit")).toBe("Thoát li");
			expect(byName.get("fork")).toBe("Tạo fork mới từ một message user trước đó");
		} finally {
			applyLiLocale("en");
		}
	});

	it("keeps EN wording and argumentHint in the / menu under locale en", async () => {
		applyLiLocale("en");
		const byName = await menuDescriptions();
		expect(byName.get("settings")).toBe("Open settings menu");
		expect(byName.get("quit")).toBe("Quit li");
		// argumentHint is data, not copy: it prefixes the rendered description line.
		expect(byName.get("model")).toContain("<provider/model>");
		expect(byName.get("model")).toContain("Select model (opens selector UI)");
	});
});

describe("Li status copy", () => {
	it("keeps EN status wording verbatim, including plurals and dynamic values", () => {
		const en = LI_UI_COPY.en.status;
		expect(en.forked).toBe("Forked to new session");
		expect(en.navigated).toBe("Navigated to selected point");
		expect(en.sessionCompacted(1)).toBe("Session compacted 1 time");
		expect(en.sessionCompacted(3)).toBe("Session compacted 3 times");
		expect(en.restoredQueued(1)).toBe("Restored 1 queued message to editor");
		expect(en.restoredQueued(2)).toBe("Restored 2 queued messages to editor");
		expect(en.switchedTo("gpt-x", " (thinking: high)")).toBe("Switched to gpt-x (thinking: high)");
		expect(en.modelLabel("m1")).toBe("Model: m1");
		expect(en.defaultModel("anthropic", "claude")).toBe("Default model: anthropic/claude");
		expect(en.savedTrustDecision(true, "li")).toBe(
			"Saved trust decision: trusted. Restart li for this to take effect.",
		);
		expect(en.reloaded(true)).toBe(
			"Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust",
		);
		expect(en.reloaded(false)).toBe("Reloaded keybindings, extensions, skills, prompts, themes, and context files");
		expect(en.sessionExported("/tmp/s.html")).toBe("Session exported to: /tmp/s.html");
		expect(en.sessionImported("/tmp/s.jsonl")).toBe("Session imported from: /tmp/s.jsonl");
		expect(en.noStoredCredentials).toBe(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		);
		expect(en.refreshingModelCatalogs).toBe("Refreshing model catalogs…");
		expect(en.modelCatalogsRefreshed).toBe("Model catalogs refreshed.");
	});

	it("renders VI status and keeps dynamic values untouched", () => {
		applyLiLocale("vi");
		try {
			const status = liCopy().status;
			expect(status.forked).toBe("Đã fork sang session mới");
			expect(status.sessionCompacted(3)).toBe("Đã nén session 3 lần");
			expect(status.restoredQueued(2)).toBe("Đã đưa 2 message đang chờ về editor");
			expect(status.switchedTo("gpt-x", status.thinkingSuffix("high"))).toBe(
				"Đã chuyển sang gpt-x (đang nghĩ: high)",
			);
			expect(status.modelLabel("m1")).toBe("Model: m1");
			expect(status.defaultModel("anthropic", "claude")).toBe("Model mặc định: anthropic/claude");
			expect(status.savedTrustDecision(false, "li")).toBe(
				"Đã lưu quyết định tin project: không tin. Khởi động lại li để có hiệu lực.",
			);
			expect(status.authSelectedModel("Đã đăng nhập r", "m1", "p")).toBe(
				"Đã đăng nhập r. Đã chọn m1. Đã lưu credentials tại p",
			);
			expect(status.loggedOut("radius")).toBe("Đã đăng xuất khỏi radius");
			expect(status.reloaded(true)).toContain("đã lưu quyết định tin project");
			expect(status.sessionExported("C:\\s.html")).toBe("Đã export session ra: C:\\s.html");
			expect(status.sessionImported("/a/b.jsonl")).toBe("Đã import session từ: /a/b.jsonl");
			expect(status.importCancelled).toBe("Đã hủy import");
			expect(status.copiedLastMessage).toBe("Đã copy message agent cuối vào clipboard");
			expect(status.refreshingModelCatalogs).toBe("Đang làm mới catalog model…");
			expect(status.modelCatalogsRefreshed).toBe("Đã làm mới catalog model.");
		} finally {
			applyLiLocale("en");
		}
	});
});
