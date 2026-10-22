import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type WheelScrollLines,
} from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import {
	CACHE_WARMING_MODES,
	type CacheWarmingMode,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type LiLocale,
	type LiToolOutputStyle,
	type MermaidRenderingMode,
	type QuietStartup,
	type SessionShareDestination,
	type TuiMode,
	type WarningSettings,
} from "../../../core/settings-manager.ts";
import {
	LI_LANGUAGE_DISPLAY_VALUES,
	LI_UI_COPY,
	type LiUiCopy,
	liLocaleDisplayLabel,
	liLocaleFromDisplayLabel,
} from "../locale.ts";
import {
	getSettingsListTheme,
	parseAutoThemeSetting,
	SYSTEM_THEME_NAME,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

/**
 * The English catalog doubles as the component default so Pi and any other
 * caller that does not pass copy keep today's exact wording.
 */
const DEFAULT_SETTINGS_COPY: LiUiCopy = LI_UI_COPY.en;

function projectTrustLabels(copy: LiUiCopy): Record<DefaultProjectTrust, string> {
	return copy.settings.projectTrustLabels;
}

function projectTrustLabelMap(copy: LiUiCopy): Map<string, DefaultProjectTrust> {
	return new Map(
		Object.entries(projectTrustLabels(copy)).map(([value, label]) => [label, value as DefaultProjectTrust]),
	);
}

export interface SettingsConfig {
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	sessionShareDestination: SessionShareDestination;
	httpIdleTimeoutMs: number;
	cacheWarmingMode: CacheWarmingMode;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: QuietStartup;
	liToolOutputStyle?: LiToolOutputStyle;
	liLanguage?: LiLocale;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	fullscreenWheelScrollLines: WheelScrollLines;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onSessionShareDestinationChange: (destination: SessionShareDestination) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (quiet: QuietStartup) => void;
	onLiToolOutputStyleChange?: (style: LiToolOutputStyle) => void;
	onLiLanguageChange?: (locale: LiLocale) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onFullscreenWheelScrollLinesChange: (lines: WheelScrollLines) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(
		warnings: WarningSettings,
		onChange: (warnings: WarningSettings) => void,
		onCancel: () => void,
		copy: LiUiCopy,
	) {
		super();

		this.state = { ...warnings };

		const anthropic = copy.settings.warningsAnthropicExtraUsage;
		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: anthropic.label,
				description: anthropic.description,
				currentValue:
					(this.state.anthropicExtraUsage ?? SETTINGS_DEFAULTS.warnings.anthropicExtraUsage) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
			{ copy: copy.settingsList },
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

const CLEAR_OVERRIDE_VALUE = "__clear__";

function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>, copy: LiUiCopy): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return copy.settings.modelThinking.overridesNone;
	return copy.settings.modelThinking.overridesCount(count);
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

function themeItems(availableThemes: string[], currentTheme: string, copy: LiUiCopy): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		...(name === SYSTEM_THEME_NAME ? { description: copy.settings.themeSubmenu.systemThemeDescription } : {}),
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

/** The system theme comes first, then automatic mode, then the remaining themes. */
function singleModeThemeItems(availableThemes: string[], currentTheme: string, copy: LiUiCopy): SelectItem[] {
	const items = themeItems(availableThemes, currentTheme, copy);
	const systemIndex = items.findIndex((item) => item.value === SYSTEM_THEME_NAME);
	const system = systemIndex === -1 ? [] : items.splice(systemIndex, 1);
	return [
		...system,
		{
			value: AUTOMATIC_THEME_VALUE,
			label: `  ${copy.settings.themeSubmenu.automaticOption.label.trim()}`,
			description: copy.settings.themeSubmenu.automaticOption.description,
		},
		...items,
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, SYSTEM_THEME_NAME);
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private readonly copy: LiUiCopy;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
		copy: LiUiCopy,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.copy = copy;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			SYSTEM_THEME_NAME,
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			this.copy.settings.themeSubmenu.title,
			this.copy.settings.themeSubmenu.description,
			singleModeThemeItems(this.availableThemes, this.singleTheme, this.copy),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
			{ copy: this.copy.selectSubmenu },
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const themeCopy = this.copy.settings.themeSubmenu;
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", themeCopy.automaticTitle)), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", themeCopy.automaticLine1), 0, 0));
		content.addChild(new Text(theme.fg("muted", themeCopy.automaticLine2), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: themeCopy.lightTheme.label,
				description: themeCopy.lightTheme.description,
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						themeCopy.lightSelectTitle,
						themeCopy.lightSelectDescription,
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: themeCopy.darkTheme.label,
				description: themeCopy.darkTheme.description,
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						themeCopy.darkSelectTitle,
						themeCopy.darkSelectDescription,
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: themeCopy.apply.label,
				description: themeCopy.apply.description,
				currentValue: themeCopy.apply.currentValue,
				values: [themeCopy.apply.currentValue],
			},
			{
				id: "single-mode",
				label: themeCopy.changeMode.label,
				description: themeCopy.changeMode.description,
				currentValue: themeCopy.changeMode.currentValue,
				values: [themeCopy.changeMode.currentValue],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
			{ copy: this.copy.settingsList },
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue, this.copy),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
			{ copy: this.copy.selectSubmenu },
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;
	private readonly copy: LiUiCopy;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks, copy?: LiUiCopy) {
		super();
		this.copy = copy ?? DEFAULT_SETTINGS_COPY;
		const c = this.copy;

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: c.settings.items.autocompact.label,
				description: c.settings.items.autocompact.description,
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: c.settings.items.steeringMode.label,
				description: c.settings.items.steeringMode.description,
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: c.settings.items.followUpMode(followUpKey).label,
				description: c.settings.items.followUpMode(followUpKey).description,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: c.settings.items.transport.label,
				description: c.settings.items.transport.description,
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "share-destination",
				label: c.settings.items.shareDestination.label,
				description: c.settings.items.shareDestination.description,
				currentValue: config.sessionShareDestination,
				values: ["auto", "gist", "radius"],
			},
			{
				id: "http-idle-timeout",
				label: c.settings.items.httpIdleTimeout.label,
				description: c.settings.items.httpIdleTimeout.description,
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "cache-warming-mode",
				label: c.settings.items.cacheWarming.label,
				description: c.settings.items.cacheWarming.description,
				currentValue: config.cacheWarmingMode,
				values: [...CACHE_WARMING_MODES],
			},
			{
				id: "hide-thinking",
				label: c.settings.items.hideThinking.label,
				description: c.settings.items.hideThinking.description,
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: c.settings.items.mermaidRendering.label,
				description: c.settings.items.mermaidRendering.description,
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: c.settings.items.cacheMissNotices.label,
				description: c.settings.items.cacheMissNotices.description,
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: c.settings.items.collapseChangelog.label,
				description: c.settings.items.collapseChangelog.description,
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: c.settings.items.quietStartup.label,
				description: c.settings.items.quietStartup.description,
				currentValue: String(config.quietStartup),
				values: ["true", "header", "false"],
			},
			{
				id: "install-telemetry",
				label: c.settings.items.installTelemetry.label,
				description: c.settings.items.installTelemetry.description,
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "default-project-trust",
				label: c.settings.items.defaultProjectTrust.label,
				description: c.settings.items.defaultProjectTrust.description,
				currentValue: projectTrustLabels(c)[config.defaultProjectTrust],
				values: Object.values(projectTrustLabels(c)),
			},
			{
				id: "double-escape-action",
				label: c.settings.items.doubleEscapeAction.label,
				description: c.settings.items.doubleEscapeAction.description,
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: c.settings.items.treeFilterMode.label,
				description: c.settings.items.treeFilterMode.description,
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: c.settings.warningsEntry.label,
				description: c.settings.warningsEntry.description,
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
						c,
					),
			},
			{
				id: "model-thinking",
				label: c.settings.items.modelThinking(cycleThinkingKey).label,
				description: c.settings.items.modelThinking(cycleThinkingKey).description,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels, c),
				submenu: (_currentValue, done) => {
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: c.settings.modelThinking.modelStepTitle,
							description: c.settings.modelThinking.modelStepDescription,
							options: () => {
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: c.settings.modelThinking.noModels.label,
										description: c.settings.modelThinking.noModels.description,
									});
								}
								return items;
							},
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return c.settings.modelThinking.levelStepTitle(m ? modelDisplayLabel(m) : ctx.model);
							},
							description: c.settings.modelThinking.levelStepDescription,
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								if (!model) return [];
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const activeLevel = currentModelThinkingLevels[ctx.model];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: `${level === activeLevel ? "✓ " : "  "}${level}`,
									description: c.settings.modelThinking.thinkingDescriptions[level],
								}));
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: c.settings.modelThinking.clearOverride.label,
										description: c.settings.modelThinking.clearOverride.description(config.thinkingLevel),
									});
								}
								return items;
							},
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels, c);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						{ loop: true },
					);
				},
			},
			{
				id: "tui-mode",
				label: c.settings.items.tuiMode.label,
				description: c.settings.items.tuiMode.description,
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: c.settings.items.fullscreenExitOutput.label,
				description: c.settings.items.fullscreenExitOutput.description,
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: c.settings.items.fullscreenScrollbar.label,
				description: c.settings.items.fullscreenScrollbar.description,
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: c.settings.items.fullscreenCopyOnSelect.label,
				description: c.settings.items.fullscreenCopyOnSelect.description,
				currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "fullscreen-wheel-scroll-lines",
				label: c.settings.items.fullscreenWheelScrollLines.label,
				description: c.settings.items.fullscreenWheelScrollLines.description,
				currentValue: String(config.fullscreenWheelScrollLines),
				values: [
					"auto",
					...[...new Set([1, 2, 3, 5, 10, config.fullscreenWheelScrollLines])]
						.filter((lines) => lines !== "auto")
						.sort((a, b) => a - b)
						.map(String),
				],
			},
			{
				id: "theme",
				label: c.settings.items.theme.label,
				description: c.settings.items.theme.description,
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done, c),
			},
		];

		if (APP_NAME === "li" && callbacks.onLiToolOutputStyleChange) {
			const quietStartupIndex = items.findIndex((item) => item.id === "quiet-startup");
			items.splice(quietStartupIndex + 1, 0, {
				id: "li-tool-output-style",
				label: c.settings.items.liToolOutputStyle.label,
				description: c.settings.items.liToolOutputStyle.description,
				currentValue: config.liToolOutputStyle ?? "blank",
				values: ["blank", "current"],
			});
		}

		// Same double gate as the sibling Li row: the host only matters under Li,
		// so Pi never sees the language row (and can never write settings.li.language).
		if (APP_NAME === "li" && callbacks.onLiLanguageChange) {
			const anchorIndex = items.findIndex((item) => item.id === "li-tool-output-style");
			const insertIndex = anchorIndex === -1 ? items.length : anchorIndex + 1;
			items.splice(insertIndex, 0, {
				id: "li-language",
				label: c.settings.items.liLanguage.label,
				description: c.settings.items.liLanguage.description,
				currentValue: liLocaleDisplayLabel(config.liLanguage ?? "en"),
				values: [...LI_LANGUAGE_DISPLAY_VALUES],
			});
		}

		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: c.settings.items.showImages.label,
				description: c.settings.items.showImages.description,
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: c.settings.items.imageWidthCells.label,
				description: c.settings.items.imageWidthCells.description,
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: c.settings.items.autoResizeImages.label,
			description: c.settings.items.autoResizeImages.description,
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: c.settings.items.blockImages.label,
			description: c.settings.items.blockImages.description,
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: c.settings.items.skillCommands.label,
			description: c.settings.items.skillCommands.description,
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: c.settings.items.showHardwareCursor.label,
			description: c.settings.items.showHardwareCursor.description,
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: c.settings.items.editorPadding.label,
			description: c.settings.items.editorPadding.description,
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: c.settings.items.outputPadding.label,
			description: c.settings.items.outputPadding.description,
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: c.settings.items.autocompleteMaxVisible.label,
			description: c.settings.items.autocompleteMaxVisible.description,
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: c.settings.items.clearOnShrink.label,
			description: c.settings.items.clearOnShrink.description,
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: c.settings.items.terminalProgress.label,
			description: c.settings.items.terminalProgress.description,
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "share-destination":
						callbacks.onSessionShareDestinationChange(newValue as SessionShareDestination);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "cache-warming-mode":
						callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "header" ? "header" : newValue === "true");
						break;
					case "li-tool-output-style":
						callbacks.onLiToolOutputStyleChange?.(newValue as LiToolOutputStyle);
						break;
					case "li-language":
						callbacks.onLiLanguageChange?.(liLocaleFromDisplayLabel(newValue));
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = projectTrustLabelMap(c).get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(newValue as TuiMode);
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						break;
					case "fullscreen-copy-on-select":
						callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
						break;
					case "fullscreen-wheel-scroll-lines":
						callbacks.onFullscreenWheelScrollLinesChange(newValue === "auto" ? "auto" : parseInt(newValue, 10));
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true, copy: c.settingsList },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
