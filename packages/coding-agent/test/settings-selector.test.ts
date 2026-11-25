import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import {
	defaultTelegramFollowUpPolicy,
	type PolicyWriteResult,
	type TelegramFollowUpPolicy,
} from "../src/modes/interactive/telegram-follow-up-policy.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const onWheelScrollLinesChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			fullscreenWheelScrollLines: 7,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
			onFullscreenWheelScrollLinesChange: onWheelScrollLinesChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
		// #9758: custom values from settings.json stay in the cycle.
		cycle("Fullscreen wheel scrolling", 3);
		expect(onWheelScrollLinesChange.mock.calls.flat()).toEqual([10, "auto", 1]);
	});

	it("offers Li tool output backgrounds with blank as the default", () => {
		const onLiToolOutputStyleChange = vi.fn();
		const config = {
			liToolOutputStyle: "blank",
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onLiToolOutputStyleChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("li-tool-output-style");
		list.handleInput("\r");
		expect(onLiToolOutputStyleChange).toHaveBeenCalledWith("current");
	});

	it("cycles through share destinations", () => {
		const onSessionShareDestinationChange = vi.fn();
		const config = {
			sessionShareDestination: "auto",
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onSessionShareDestinationChange,
		} as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("share-destination");

		for (let i = 0; i < 3; i++) list.handleInput("\r");

		expect(onSessionShareDestinationChange.mock.calls.flat()).toEqual(["gist", "radius", "auto"]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["system", "dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(
			/ {4}system +Theme created from your terminal's colors\n {4}automatic +Use separate themes/,
		);
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});

	it("pages a searchable submenu with selection page keys (#7629)", () => {
		const onSelect = vi.fn();
		const submenu = new SelectSubmenu(
			"Theme",
			"",
			Array.from({ length: 20 }, (_, index) => ({ value: `theme-${index}`, label: `theme-${index}` })),
			"theme-0",
			onSelect,
			() => {},
			undefined,
			{ searchable: true },
		);

		submenu.handleInput("\x1b[6~"); // PageDown
		submenu.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("theme-10");
	});

	const telegramBaseConfig = {
		autoCompact: false,
		steeringMode: "all",
		followUpMode: "all",
		transport: "auto",
		sessionShareDestination: "auto",
		httpIdleTimeoutMs: 300000,
		cacheWarmingMode: "off",
		thinkingLevel: "medium",
		hideThinkingBlock: false,
		mermaidRenderingMode: "final",
		showCacheMissNotices: false,
		collapseChangelog: true,
		enableInstallTelemetry: false,
		defaultProjectTrust: "ask",
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: true,
		editorPaddingX: 1,
		outputPad: 0,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		clearOnShrink: true,
		showTerminalProgress: false,
		tuiMode: "regular",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: true,
		fullscreenWheelScrollLines: 3,
		warnings: {},
		defaultModel: "not set",
		availableDefaultModels: [],
		availableThinkingLevels: [],
		modelThinkingLevels: {},
		availableThemes: [],
		currentTheme: "dark",
		terminalTheme: "dark",
	} as unknown as SettingsConfig;

	const policy = defaultTelegramFollowUpPolicy();

	function makeTelegramCallbacks(): {
		callbacks: SettingsCallbacks;
		mutations: Array<PolicyWriteResult>;
		onPolicyChange: ReturnType<typeof vi.fn>;
	} {
		const onPolicyChange = vi.fn((mutate: (p: typeof policy) => typeof policy): PolicyWriteResult => {
			const next = { ...mutate(policy) };
			Object.assign(policy, next);
			return { ok: true, policy: next };
		});
		const callbacks = {
			onCancel: () => {},
			onTelegramFollowUpPolicyChange: onPolicyChange,
			onTelegramFollowUpPolicyRefresh: () => ({ policy, source: "file" as const }),
			onTelegramFollowUpStatus: () => ({ kind: "ready" as const }),
		} as unknown as SettingsCallbacks;
		return { callbacks, mutations: [], onPolicyChange };
	}

	function openTelegramSubmenu(config: SettingsConfig, callbacks: SettingsCallbacks) {
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("telegram-follow-up");
		list.handleInput("\r");
		return list;
	}

	it("hides the Telegram follow-up row without the Li callback", () => {
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(telegramBaseConfig, callbacks).getSettingsList();
		list.selectItem("li-language");
		expect(list.render(80).join("\n")).not.toContain("Telegram follow-up");
	});

	it("shows the parent token and opens the titled submenu", () => {
		const { callbacks } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("telegram-follow-up");
		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("Telegram follow-up");
		// Disabled by default: one-cell ASCII token, not a localized word.
		expect(rendered).toContain("- ");

		list.handleInput("\r");
		const submenuRendered = stripAnsi(list.render(80).join("\n"));
		expect(submenuRendered).toContain("Master");
		expect(submenuRendered).toContain("Off");
		expect(submenuRendered).toContain("Ready");
		expect(submenuRendered).toContain("Status");
	});

	it("toggles the master switch inside the submenu", () => {
		const { callbacks, onPolicyChange } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = openTelegramSubmenu(config, callbacks);
		list.handleInput("\r"); // tf-master cycle Off -> On
		expect(onPolicyChange).toHaveBeenCalledTimes(1);
		const mutated = onPolicyChange.mock.calls[0][0](policy);
		expect(mutated.enabled).toBe(true);
		expect(stripAnsi(list.render(80).join("\n"))).toContain("On");
	});

	it("refreshes the parent + token on every submenu exit path", () => {
		const { callbacks } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = openTelegramSubmenu(config, callbacks);
		list.handleInput("\r"); // enable master
		list.handleInput("\x1b"); // Esc: exit to parent row
		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("Telegram follow-up");
		expect(rendered).toContain("+ ");
	});

	it("re-entry to submenu immediately after toggle sees fresh enabled policy without waiting for timer (regression [P2-T1])", () => {
		let currentPolicy = { ...policy };
		const onPolicyChange = vi.fn((mutate: (prev: TelegramFollowUpPolicy) => TelegramFollowUpPolicy) => {
			currentPolicy = mutate(currentPolicy);
			return { ok: true, policy: currentPolicy };
		});
		const callbacks = {
			onCancel: () => {},
			onTelegramFollowUpPolicyChange: onPolicyChange,
			onTelegramFollowUpPolicyRefresh: () => ({ policy: currentPolicy, source: "file" as const }),
			onTelegramFollowUpStatus: () => ({ kind: "ready" as const }),
		} as unknown as SettingsCallbacks;

		// Initial config snapshot has policy with enabled: false
		const config = {
			...telegramBaseConfig,
			telegramFollowUp: { policy: currentPolicy },
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("telegram-follow-up");
		list.handleInput("\r"); // open submenu

		// Toggle Off -> On
		list.handleInput("\r");
		expect(currentPolicy.enabled).toBe(true);

		// Esc back to parent settings row
		list.handleInput("\x1b");
		expect(stripAnsi(list.render(80).join("\n"))).toContain("+ ");

		// Re-enter submenu immediately without waiting for timer
		list.handleInput("\r");
		const reentered = stripAnsi(list.render(80).join("\n"));
		expect(reentered).toContain("Master");
		expect(reentered).toContain("On");
		expect(reentered).not.toContain("Off");
	});

	it("selects delays through a titled submenu instead of a one-way cycle", () => {
		const { callbacks, onPolicyChange } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = openTelegramSubmenu(config, callbacks);
		list.handleInput("\x1b[B"); // down to tf-final-delay
		list.handleInput("\r"); // open SelectSubmenu (current 10m)
		const delayRendered = stripAnsi(list.render(80).join("\n"));
		expect(delayRendered).toContain("Final delay");
		list.handleInput("\x1b[A"); // up: 10m -> 5m
		list.handleInput("\x1b[A"); // up: 5m -> 3m
		list.handleInput("\r"); // choose 3m
		expect(onPolicyChange).toHaveBeenCalledTimes(1);
		const mutated = onPolicyChange.mock.calls[0][0](policy);
		expect(mutated.finalAnswerDelayMinutes).toBe(3);
	});

	it("keeps the status row read-only", () => {
		const { callbacks } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = openTelegramSubmenu(config, callbacks);
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B"); // tf-status (master, final, ask, terminal, status)
		list.handleInput("\r");
		list.handleInput(" ");
		// Still inside the same submenu list; no values/submenu were activated.
		const rendered = stripAnsi(list.render(80).join("\n"));
		expect(rendered).toContain("Ready");
	});

	it("keeps the security description readable at width 40", () => {
		const { callbacks } = makeTelegramCallbacks();
		const config = { ...telegramBaseConfig, telegramFollowUp: { policy } } as unknown as SettingsConfig;
		const list = openTelegramSubmenu(config, callbacks);
		// Master row is focused on open; its description is the security note.
		const rendered = stripAnsi(list.render(40).join("\n"));
		expect(rendered).toContain("Telegram follow-up");
		expect(rendered).toContain("sanitized");
		expect(rendered).toContain("credentials");
		// Rows and hints stay on single lines (no clipping mid-token).
		for (const line of list.render(40)) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
		}
	});
});
