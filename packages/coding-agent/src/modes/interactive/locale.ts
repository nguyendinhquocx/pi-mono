import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { APP_NAME } from "../../config.ts";
import type { DefaultProjectTrust } from "../../core/settings-schema.ts";

/**
 * Li UI locale. Only two locales exist in this revision; anything else falls
 * back to "en". Pi never reads this module's locale state (currentLiLocale()
 * pins "en" when APP_NAME !== "li"), so shared TUI surfaces keep their copy.
 */
export type LiLocale = "en" | "vi";

/** Internal env bridge so the two first-party extensions can see the locale. */
export const LI_UI_LANGUAGE_ENV = "LI_UI_LANGUAGE";

export function normalizeLiLocale(value: unknown): LiLocale {
	return value === "vi" ? "vi" : "en";
}

/** Label shown as the setting value for a locale (narrow terminals keep the prefix). */
export function liLocaleDisplayLabel(locale: LiLocale): string {
	return locale === "vi" ? "VI · Tiếng Việt" : "EN · English";
}

/** Cycle values for the language row; callers map these back via liLocaleFromDisplayLabel. */
export const LI_LANGUAGE_DISPLAY_VALUES: readonly string[] = ["EN · English", "VI · Tiếng Việt"];

export function liLocaleFromDisplayLabel(label: string): LiLocale {
	return label === "VI · Tiếng Việt" ? "vi" : "en";
}

/** Copy for one settings row. */
export interface LiSettingsItemCopy {
	label: string;
	description: string;
}

export interface LiUiCopy {
	/** Shared SettingsList chrome (empty state, no-match, keyboard footer). */
	settingsList: {
		empty: string;
		noMatch: string;
		searchHint: string;
		hint: string;
	};
	/** SelectSubmenu keyboard footer. */
	selectSubmenu: {
		searchHint: string;
		hint: string;
	};
	/** SteppedSubmenu step prefix, e.g. "Step 1/2 · ". */
	steppedStepPrefix: (index: number, total: number) => string;
	settings: {
		warningsEntry: LiSettingsItemCopy;
		warningsAnthropicExtraUsage: LiSettingsItemCopy;
		items: {
			autocompact: LiSettingsItemCopy;
			steeringMode: LiSettingsItemCopy;
			followUpMode: (followUpKey: string) => LiSettingsItemCopy;
			transport: LiSettingsItemCopy;
			shareDestination: LiSettingsItemCopy;
			httpIdleTimeout: LiSettingsItemCopy;
			cacheWarming: LiSettingsItemCopy;
			hideThinking: LiSettingsItemCopy;
			mermaidRendering: LiSettingsItemCopy;
			cacheMissNotices: LiSettingsItemCopy;
			collapseChangelog: LiSettingsItemCopy;
			quietStartup: LiSettingsItemCopy;
			installTelemetry: LiSettingsItemCopy;
			defaultProjectTrust: LiSettingsItemCopy;
			doubleEscapeAction: LiSettingsItemCopy;
			treeFilterMode: LiSettingsItemCopy;
			modelThinking: (cycleThinkingKey: string) => LiSettingsItemCopy;
			tuiMode: LiSettingsItemCopy;
			fullscreenExitOutput: LiSettingsItemCopy;
			fullscreenScrollbar: LiSettingsItemCopy;
			fullscreenCopyOnSelect: LiSettingsItemCopy;
			fullscreenWheelScrollLines: LiSettingsItemCopy;
			theme: LiSettingsItemCopy;
			showImages: LiSettingsItemCopy;
			imageWidthCells: LiSettingsItemCopy;
			autoResizeImages: LiSettingsItemCopy;
			blockImages: LiSettingsItemCopy;
			skillCommands: LiSettingsItemCopy;
			showHardwareCursor: LiSettingsItemCopy;
			editorPadding: LiSettingsItemCopy;
			outputPadding: LiSettingsItemCopy;
			autocompleteMaxVisible: LiSettingsItemCopy;
			clearOnShrink: LiSettingsItemCopy;
			terminalProgress: LiSettingsItemCopy;
			liToolOutputStyle: LiSettingsItemCopy;
			liLanguage: LiSettingsItemCopy;
		};
		themeSubmenu: {
			title: string;
			description: string;
			automaticTitle: string;
			automaticLine1: string;
			automaticLine2: string;
			lightTheme: LiSettingsItemCopy;
			darkTheme: LiSettingsItemCopy;
			apply: LiSettingsItemCopy & { currentValue: string };
			changeMode: LiSettingsItemCopy & { currentValue: string };
			lightSelectTitle: string;
			lightSelectDescription: string;
			darkSelectTitle: string;
			darkSelectDescription: string;
			automaticOption: { label: string; description: string };
			systemThemeDescription: string;
		};
		modelThinking: {
			modelStepTitle: string;
			modelStepDescription: string;
			noModels: { label: string; description: string };
			levelStepTitle: (model: string) => string;
			levelStepDescription: string;
			thinkingDescriptions: Record<ThinkingLevel, string>;
			clearOverride: { label: string; description: (globalDefault: ThinkingLevel) => string };
			overridesNone: string;
			overridesCount: (count: number) => string;
		};
		projectTrustLabels: Record<DefaultProjectTrust, string>;
	};
	/** Built-in `/` menu command descriptions, keyed by command name (argumentHint stays untranslated). */
	slashCommands: Record<string, { description: string }>;
	/** Static headings and built-in action descriptions in `/hotkeys`; key labels/extensions stay dynamic. */
	hotkeys: {
		title: string;
		sections: { navigation: string; editing: string; other: string; extensions: string };
		table: { key: string; action: string };
		actions: {
			moveCursor: string;
			moveByWord: string;
			startOfLine: string;
			endOfLine: string;
			jumpForward: string;
			jumpBackward: string;
			scrollByPage: string;
			sendMessage: string;
			newLine: string;
			windowsNewLineNote: string;
			deleteWordBackward: string;
			deleteWordForward: string;
			deleteToLineStart: string;
			deleteToLineEnd: string;
			pasteRecentDeleted: string;
			cycleDeletedText: string;
			undo: string;
			pathCompletion: string;
			cancelAutocomplete: string;
			clearEditor: string;
			exitWhenEmpty: string;
			suspend: string;
			cycleThinking: string;
			cycleModels: string;
			openModelSelector: string;
			expandToolOutput: string;
			toggleThinking: string;
			externalEditor: string;
			copyMessage: string;
			queueFollowUp: string;
			restoreQueued: string;
			pasteClipboard: string;
			slashCommands: string;
			runBash: string;
			runBashWithoutContext: string;
		};
	};
	/** Status messages raised by interactive mode (settings callbacks + command feedback). */
	status: {
		httpIdleTimeout: (value: string) => string;
		cacheWarming: (mode: string) => string;
		tuiMode: (mode: string) => string;
		closeOverlaysFirst: string;
		defaultThinkingLevel: (level: string) => string;
		thinkingLevel: (level: string) => string;
		thinkingBlocks: (hidden: boolean) => string;
		toolOutput: (expanded: boolean) => string;
		forked: string;
		navigated: string;
		startupInProgress: string;
		autoCompactionCancelled: string;
		suspendNotSupported: string;
		noQueuedMessages: string;
		restoredQueued: (count: number) => string;
		modelNoThinking: string;
		onlyOneModelInScope: string;
		onlyOneModelAvailable: string;
		switchedTo: (model: string, thinkingSuffix: string) => string;
		thinkingSuffix: (level: string) => string;
		queuedAfterCompaction: string;
		sessionCompacted: (count: number) => string;
		modelLabel: (modelId: string) => string;
		defaultModel: (provider: string, modelId: string) => string;
		refreshingModelCatalogs: string;
		modelCatalogsRefreshed: string;
		savedTrustDecision: (trusted: boolean, appName: string) => string;
		modelSelectionSaved: string;
		noMessagesToFork: string;
		nothingToClone: string;
		cloned: string;
		noEntriesInSession: string;
		alreadyAtPoint: string;
		branchSummaryCancelled: string;
		navigationCancelled: string;
		copiedSelectedMessage: string;
		resumeCancelled: string;
		noLoginMethods: string;
		noAccountProviders: string;
		noApiKeyProviders: string;
		noLoginProviders: string;
		noStoredCredentials: string;
		loggedInTo: (provider: string) => string;
		savedApiKeyFor: (provider: string) => string;
		authSelectedModel: (actionLabel: string, modelId: string, authPath: string) => string;
		authCredentialsSaved: (actionLabel: string, authPath: string) => string;
		authCredentialsSavedRefreshing: (actionLabel: string, authPath: string) => string;
		loggedOut: (providerName: string) => string;
		removedApiKey: (providerName: string) => string;
		reloaded: (savedTrust: boolean) => string;
		sessionExported: (filePath: string) => string;
		sessionImported: (inputPath: string) => string;
		importCancelled: string;
		copiedLastMessage: string;
	};
}

/**
 * English catalog. IMPORTANT: wording here must stay identical to the original
 * hardcoded strings so Pi (which always uses this catalog) keeps its current UI.
 */
const EN_COPY: LiUiCopy = {
	settingsList: {
		empty: "No settings available",
		noMatch: "No matching settings",
		searchHint: "  Type to search · Enter/Space to change · Esc to cancel",
		hint: "  Enter/Space to change · Esc to cancel",
	},
	selectSubmenu: {
		searchHint: "  Type to filter · Enter to select · Esc to go back",
		hint: "  Enter to select · Esc to go back",
	},
	steppedStepPrefix: (index, total) => `Step ${index + 1}/${total} · `,
	settings: {
		warningsEntry: {
			label: "Warnings",
			description: "Enable or disable individual warnings",
		},
		warningsAnthropicExtraUsage: {
			label: "Anthropic extra usage",
			description: "Warn when Anthropic subscription auth may use paid extra usage",
		},
		items: {
			autocompact: {
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
			},
			steeringMode: {
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
			},
			followUpMode: (followUpKey) => ({
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
			}),
			transport: {
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
			},
			shareDestination: {
				label: "Session share destination",
				description:
					"Where to upload sessions with /share (auto prefers Radius when authenticated, otherwise GitHub Gist)",
			},
			httpIdleTimeout: {
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
			},
			cacheWarming: {
				label: "Cache warming",
				description:
					"off; streaming while the agent runs; idle also between runs while continuation stays profitable",
			},
			hideThinking: {
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
			},
			mermaidRendering: {
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
			},
			cacheMissNotices: {
				label: "Cache miss notices",
				description: "Show transcript notices for cache costs and provider recovery diagnostics",
			},
			collapseChangelog: {
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
			},
			quietStartup: {
				label: "Quiet startup",
				description: "Disable verbose printing at startup (header: keep only the startup header)",
			},
			installTelemetry: {
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
			},
			defaultProjectTrust: {
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
			},
			doubleEscapeAction: {
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
			},
			treeFilterMode: {
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
			},
			modelThinking: (cycleThinkingKey) => ({
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
			}),
			tuiMode: {
				label: "TUI mode",
				description: "Interface layout; regular mode uses the terminal's normal scrollback",
			},
			fullscreenExitOutput: {
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
			},
			fullscreenScrollbar: {
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
			},
			fullscreenCopyOnSelect: {
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
			},
			fullscreenWheelScrollLines: {
				label: "Fullscreen wheel scrolling",
				description:
					"Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
			},
			theme: {
				label: "Theme",
				description: "Color theme for the interface",
			},
			showImages: {
				label: "Show images",
				description: "Render images inline in terminal",
			},
			imageWidthCells: {
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
			},
			autoResizeImages: {
				label: "Auto-resize images",
				description: "Resize large images to 2000x2000 max for better model compatibility",
			},
			blockImages: {
				label: "Block images",
				description: "Prevent images from being sent to LLM providers",
			},
			skillCommands: {
				label: "Skill commands",
				description: "Register skills as /skill:name commands",
			},
			showHardwareCursor: {
				label: "Show hardware cursor",
				description: "Use the terminal cursor instead of Pi's drawn cursor",
			},
			editorPadding: {
				label: "Editor padding",
				description: "Horizontal padding for input editor (0-3)",
			},
			outputPadding: {
				label: "Output padding",
				description: "Horizontal padding for messages, tool output, and command output",
			},
			autocompleteMaxVisible: {
				label: "Autocomplete max items",
				description: "Max visible items in autocomplete dropdown (3-20)",
			},
			clearOnShrink: {
				label: "Clear on shrink",
				description: "Clear empty rows when content shrinks (may cause flicker)",
			},
			terminalProgress: {
				label: "Terminal progress",
				description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			},
			liToolOutputStyle: {
				label: "Li transcript style",
				description: "blank removes user/tool/custom-message/diff backgrounds; current restores them",
			},
			liLanguage: {
				label: "Interface language",
				description: "EN = English · VI = Tiếng Việt. Changes apply immediately in Li.",
			},
		},
		themeSubmenu: {
			title: "Theme",
			description: "Select a theme, or choose automatic to follow terminal appearance.",
			automaticTitle: "Automatic Theme",
			automaticLine1: "Choose themes for terminal light and dark appearance.",
			automaticLine2: "Light/dark detection requires terminal support.",
			lightTheme: {
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
			},
			darkTheme: {
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
			},
			apply: {
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
			},
			changeMode: {
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
			},
			lightSelectTitle: "Light Theme",
			lightSelectDescription: "Select the theme to use for light terminal appearance",
			darkSelectTitle: "Dark Theme",
			darkSelectDescription: "Select the theme to use for dark terminal appearance",
			automaticOption: {
				label: "  automatic",
				description: "Use separate themes for light and dark terminal appearance",
			},
			systemThemeDescription: "Theme created from your terminal's colors",
		},
		modelThinking: {
			modelStepTitle: "Per-Model Thinking Level",
			modelStepDescription: "Select a model to configure",
			noModels: {
				label: "No models available",
				description: "Log in to a provider or configure an API key first",
			},
			levelStepTitle: (model) => `Thinking Level for ${model}`,
			levelStepDescription: "Select default thinking level for this model",
			thinkingDescriptions: {
				off: "No reasoning",
				minimal: "Very brief reasoning (~1k tokens)",
				low: "Light reasoning (~2k tokens)",
				medium: "Moderate reasoning (~8k tokens)",
				high: "Deep reasoning (~16k tokens)",
				xhigh: "Extra-high reasoning (~32k tokens)",
				max: "Maximum reasoning",
			},
			clearOverride: {
				label: "  (clear override)",
				description: (globalDefault) => `Revert to global default (${globalDefault})`,
			},
			overridesNone: "none",
			overridesCount: (count) => `${count} configured`,
		},
		projectTrustLabels: {
			ask: "Ask",
			always: "Always trust",
			never: "Never trust",
		},
	},
	slashCommands: {
		settings: { description: "Open settings menu" },
		model: { description: "Select model (opens selector UI)" },
		tree: { description: "Navigate session tree (switch branches)" },
		thinking: { description: "Set thinking level" },
		"scoped-models": { description: "Enable/disable models for Ctrl+P cycling" },
		export: { description: "Export session (HTML default, or specify path: .html/.jsonl)" },
		import: { description: "Import and resume a session from a JSONL file" },
		share: { description: "Share session via a Radius artifact or a GitHub gist" },
		bug: { description: "Report a bug to the Pi developers" },
		copy: { description: "Copy last agent message to clipboard" },
		name: { description: "Set session display name" },
		session: { description: "Show session info and stats" },
		changelog: { description: "Show changelog entries" },
		hotkeys: { description: "Show all keyboard shortcuts" },
		fork: { description: "Create a new fork from a previous user message" },
		clone: { description: "Duplicate the current session at the current position" },
		trust: { description: "Save project trust decision for future sessions" },
		login: { description: "Configure provider authentication" },
		logout: { description: "Remove provider authentication" },
		new: { description: "Start a new session" },
		compact: { description: "Manually compact the session context" },
		resume: { description: "Resume a different session" },
		reload: { description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
		quit: { description: `Quit ${APP_NAME}` },
	},
	hotkeys: {
		title: "Keyboard Shortcuts",
		sections: { navigation: "Navigation", editing: "Editing", other: "Other", extensions: "Extensions" },
		table: { key: "Key", action: "Action" },
		actions: {
			moveCursor: "Move cursor / browse history",
			moveByWord: "Move by word",
			startOfLine: "Start of line",
			endOfLine: "End of line",
			jumpForward: "Jump forward to character",
			jumpBackward: "Jump backward to character",
			scrollByPage: "Scroll by page",
			sendMessage: "Send message",
			newLine: "New line",
			windowsNewLineNote: "Ctrl+Enter on Windows Terminal",
			deleteWordBackward: "Delete word backwards",
			deleteWordForward: "Delete word forwards",
			deleteToLineStart: "Delete to start of line",
			deleteToLineEnd: "Delete to end of line",
			pasteRecentDeleted: "Paste the most-recently-deleted text",
			cycleDeletedText: "Cycle through the deleted text after pasting",
			undo: "Undo",
			pathCompletion: "Path completion / accept autocomplete",
			cancelAutocomplete: "Cancel autocomplete / abort streaming",
			clearEditor: "Clear editor (first) / exit (second)",
			exitWhenEmpty: "Exit (when editor is empty)",
			suspend: "Suspend to background",
			cycleThinking: "Cycle thinking level",
			cycleModels: "Cycle models",
			openModelSelector: "Open model selector",
			expandToolOutput: "Toggle tool output expansion",
			toggleThinking: "Toggle thinking block visibility",
			externalEditor: "Edit message in external editor",
			copyMessage: "Copy selection or last assistant message",
			queueFollowUp: "Queue follow-up message",
			restoreQueued: "Restore queued messages",
			pasteClipboard: "Paste files on macOS, images, or text from clipboard",
			slashCommands: "Slash commands",
			runBash: "Run bash command",
			runBashWithoutContext: "Run bash command (excluded from context)",
		},
	},
	status: {
		httpIdleTimeout: (value) => `HTTP idle timeout: ${value}`,
		cacheWarming: (mode) => `Cache warming: ${mode}`,
		tuiMode: (mode) => `TUI mode: ${mode}`,
		closeOverlaysFirst: "Close active overlays before changing TUI mode",
		defaultThinkingLevel: (level) => `Default thinking level: ${level}`,
		thinkingLevel: (level) => `Thinking level: ${level}`,
		thinkingBlocks: (hidden) => `Thinking blocks: ${hidden ? "hidden" : "visible"}`,
		toolOutput: (expanded) => `Tool output: ${expanded ? "expanded" : "collapsed"}`,
		forked: "Forked to new session",
		navigated: "Navigated to selected point",
		startupInProgress: "Startup is still in progress",
		autoCompactionCancelled: "Auto-compaction cancelled",
		suspendNotSupported: "Suspend to background is not supported on Windows",
		noQueuedMessages: "No queued messages to restore",
		restoredQueued: (count) => `Restored ${count} queued message${count > 1 ? "s" : ""} to editor`,
		modelNoThinking: "Current model does not support thinking",
		onlyOneModelInScope: "Only one model in scope",
		onlyOneModelAvailable: "Only one model available",
		switchedTo: (model, thinkingSuffix) => `Switched to ${model}${thinkingSuffix}`,
		thinkingSuffix: (level) => ` (thinking: ${level})`,
		queuedAfterCompaction: "Queued message for after compaction",
		sessionCompacted: (count) => `Session compacted ${count === 1 ? "1 time" : `${count} times`}`,
		modelLabel: (modelId) => `Model: ${modelId}`,
		defaultModel: (provider, modelId) => `Default model: ${provider}/${modelId}`,
		refreshingModelCatalogs: "Refreshing model catalogs…",
		modelCatalogsRefreshed: "Model catalogs refreshed.",
		savedTrustDecision: (trusted, appName) =>
			`Saved trust decision: ${trusted ? "trusted" : "untrusted"}. Restart ${appName} for this to take effect.`,
		modelSelectionSaved: "Model selection saved to settings",
		noMessagesToFork: "No messages to fork from",
		nothingToClone: "Nothing to clone yet",
		cloned: "Cloned to new session",
		noEntriesInSession: "No entries in session",
		alreadyAtPoint: "Already at this point",
		branchSummaryCancelled: "Branch summarization cancelled",
		navigationCancelled: "Navigation cancelled",
		copiedSelectedMessage: "Copied selected message to clipboard",
		resumeCancelled: "Resume cancelled",
		noLoginMethods: "No login methods available.",
		noAccountProviders: "No account providers available.",
		noApiKeyProviders: "No API key providers available.",
		noLoginProviders: "No login providers available.",
		noStoredCredentials:
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		loggedInTo: (provider) => `Logged in to ${provider}`,
		savedApiKeyFor: (provider) => `Saved API key for ${provider}`,
		authSelectedModel: (actionLabel, modelId, authPath) =>
			`${actionLabel}. Selected ${modelId}. Credentials saved to ${authPath}`,
		authCredentialsSaved: (actionLabel, authPath) => `${actionLabel}. Credentials saved to ${authPath}`,
		authCredentialsSavedRefreshing: (actionLabel, authPath) =>
			`${actionLabel}. Credentials saved to ${authPath}. Refreshing model catalog…`,
		loggedOut: (providerName) => `Logged out of ${providerName}`,
		removedApiKey: (providerName) =>
			`Removed stored API key for ${providerName}. Environment variables and models.json config are unchanged.`,
		reloaded: (savedTrust) =>
			savedTrust
				? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
				: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
		sessionExported: (filePath) => `Session exported to: ${filePath}`,
		sessionImported: (inputPath) => `Session imported from: ${inputPath}`,
		importCancelled: "Import cancelled",
		copiedLastMessage: "Copied last agent message to clipboard",
	},
};

/** Vietnamese catalog. Keys are compile-checked against EN via LiUiCopy. */
const VI_COPY: LiUiCopy = {
	settingsList: {
		empty: "Không có mục cài đặt nào",
		noMatch: "Không có mục khớp",
		// Kept short enough to read fully in a 40-column terminal.
		searchHint: "  Gõ để tìm · Enter đổi · Esc thoát",
		hint: "  Enter/Space đổi · Esc thoát",
	},
	selectSubmenu: {
		searchHint: "  Gõ để lọc · Enter chọn · Esc quay lại",
		hint: "  Enter chọn · Esc quay lại",
	},
	steppedStepPrefix: (index, total) => `Bước ${index + 1}/${total} · `,
	settings: {
		warningsEntry: {
			label: "Cảnh báo",
			description: "Bật hoặc tắt từng loại cảnh báo",
		},
		warningsAnthropicExtraUsage: {
			label: "Anthropic dùng thêm",
			description: "Cảnh báo khi auth subscription Anthropic có thể tính phí dùng thêm",
		},
		items: {
			autocompact: {
				label: "Tự nén ngữ cảnh",
				description: "Tự động nén ngữ cảnh khi quá lớn",
			},
			steeringMode: {
				label: "Chế độ steering",
				description:
					"Nhấn Enter khi đang stream thì đưa message steering vào hàng chờ. 'one-at-a-time': gửi một, chờ phản hồi. 'all': gửi tất cả cùng lúc.",
			},
			followUpMode: (followUpKey) => ({
				label: "Chế độ follow-up",
				description: `${followUpKey} đưa message follow-up vào hàng chờ đến khi agent dừng. 'one-at-a-time': gửi một, chờ phản hồi. 'all': gửi tất cả cùng lúc.`,
			}),
			transport: {
				label: "Transport",
				description: "Transport ưu tiên cho provider hỗ trợ nhiều transport",
			},
			shareDestination: {
				label: "Nơi chia sẻ session",
				description:
					"Nơi upload session khi dùng /share (auto ưu tiên Radius khi đã đăng nhập, không thì GitHub Gist)",
			},
			httpIdleTimeout: {
				label: "HTTP idle timeout",
				description:
					"Khoảng nghỉ tối đa khi chờ HTTP header hoặc body. Tắt đi cho model local nghỉ lâu hơn năm phút.",
			},
			cacheWarming: {
				label: "Làm nóng cache",
				description: "off; streaming khi agent chạy; idle cả giữa các lượt khi tiếp tục còn có lợi",
			},
			hideThinking: {
				label: "Ẩn phần suy nghĩ",
				description: "Ẩn khối suy nghĩ trong câu trả lời của assistant",
			},
			mermaidRendering: {
				label: "Sơ đồ Mermaid",
				description: "Vẽ code block Mermaid thành sơ đồ Unicode",
			},
			cacheMissNotices: {
				label: "Thông báo cache miss",
				description: "Hiện thông báo chi phí cache và chẩn đoán phục hồi provider trong transcript",
			},
			collapseChangelog: {
				label: "Thu gọn changelog",
				description: "Hiện changelog rút gọn sau khi cập nhật",
			},
			quietStartup: {
				label: "Khởi động im lặng",
				description: "Tắt log dài dòng khi khởi động (header: chỉ giữ phần header)",
			},
			installTelemetry: {
				label: "Telemetry cài đặt",
				description: "Gửi ping phiên bản/cập nhật ẩn danh sau khi phát hiện cập nhật qua changelog",
			},
			defaultProjectTrust: {
				label: "Mặc định tin project",
				description: "Hành vi khi không có extension hoặc quyết định tinProject nào quyết định giúp",
			},
			doubleEscapeAction: {
				label: "Hành động nhấn Esc đôi",
				description: "Hành động khi nhấn Escape hai lần với editor trống",
			},
			treeFilterMode: {
				label: "Bộ lọc /tree",
				description: "Bộ lọc mặc định khi mở /tree",
			},
			modelThinking: (cycleThinkingKey) => ({
				label: "Mức suy nghĩ mặc định theo model",
				description: `Ghi đè mức suy nghĩ mặc định cho model cụ thể. ${cycleThinkingKey} xoay vòng trong phiên.`,
			}),
			tuiMode: {
				label: "Chế độ TUI",
				description: "Bố cục giao diện; chế độ regular dùng scrollback thường của terminal",
			},
			fullscreenExitOutput: {
				label: "Kết quả khi thoát fullscreen",
				description: "In transcript hoặc chỉ hint resume session khi thoát chế độ fullscreen",
			},
			fullscreenScrollbar: {
				label: "Thanh cuộn fullscreen",
				description: "Hành vi thanh cuộn ở chế độ fullscreen; không có tác dụng ở chế độ regular",
			},
			fullscreenCopyOnSelect: {
				label: "Copy khi chọn trong fullscreen",
				description: "Tự copy vùng chọn trong chế độ fullscreen; tắt đi để copy bằng Ctrl+X",
			},
			fullscreenWheelScrollLines: {
				label: "Số dòng lăn chuột fullscreen",
				description:
					"Số dòng mỗi lần lăn chuột ở chế độ fullscreen; 'auto' tăng tốc khi lăn nhanh nếu terminal không tự làm",
			},
			theme: {
				label: "Theme",
				description: "Theme màu cho giao diện",
			},
			showImages: {
				label: "Hiện ảnh",
				description: "Hiển thị ảnh trực tiếp trong terminal",
			},
			imageWidthCells: {
				label: "Chiều rộng ảnh",
				description: "Chiều rộng ảnh inline mong muốn, tính theo ô terminal",
			},
			autoResizeImages: {
				label: "Tự thu nhỏ ảnh",
				description: "Thu ảnh lớn về tối đa 2000x2000 để model dễ xử lý hơn",
			},
			blockImages: {
				label: "Chặn ảnh",
				description: "Không gửi ảnh cho LLM provider",
			},
			skillCommands: {
				label: "Lệnh skill",
				description: "Đăng ký skill thành lệnh /skill:name",
			},
			showHardwareCursor: {
				label: "Hiện con trỏ phần cứng",
				description: "Dùng con trỏ terminal thay cho con trỏ do Pi tự vẽ",
			},
			editorPadding: {
				label: "Đệm editor",
				description: "Đệm ngang cho editor nhập liệu (0-3)",
			},
			outputPadding: {
				label: "Đệm nội dung",
				description: "Đệm ngang cho message, kết quả tool và output lệnh",
			},
			autocompleteMaxVisible: {
				label: "Số mục autocomplete",
				description: "Số mục tối đa hiển thị trong dropdown autocomplete (3-20)",
			},
			clearOnShrink: {
				label: "Xóa khi thu nhỏ",
				description: "Xóa dòng trống khi nội dung thu lại (có thể gây nhấp nháy)",
			},
			terminalProgress: {
				label: "Tiến trình terminal",
				description: "Hiện chỉ báo tiến trình OSC 9;4 trên tab terminal",
			},
			liToolOutputStyle: {
				label: "Kiểu transcript của Li",
				description: "blank bỏ nền user/tool/custom-message/diff; current khôi phục nền",
			},
			liLanguage: {
				label: "Ngôn ngữ giao diện",
				description: "EN = English · VI = Tiếng Việt. Đổi là áp dụng ngay trong Li.",
			},
		},
		themeSubmenu: {
			title: "Theme",
			description: "Chọn theme, hoặc chọn automatic để theo giao sáng/tối của terminal.",
			automaticTitle: "Theme tự động",
			automaticLine1: "Chọn theme riêng cho terminal sáng và tối.",
			automaticLine2: "Phát hiện sáng/tối cần terminal hỗ trợ.",
			lightTheme: {
				label: "Theme sáng",
				description: "Theme dùng ở chế độ tự động khi terminal nền sáng",
			},
			darkTheme: {
				label: "Theme tối",
				description: "Theme dùng ở chế độ tự động khi terminal nền tối",
			},
			apply: {
				label: "Áp dụng",
				description: "Lưu và quay lại",
				currentValue: "lưu và quay lại",
			},
			changeMode: {
				label: "Đổi chế độ",
				description: "Chuyển sang một theme chung cho sáng và tối",
				currentValue: "chuyển về một theme",
			},
			lightSelectTitle: "Theme sáng",
			lightSelectDescription: "Chọn theme cho giao diện terminal nền sáng",
			darkSelectTitle: "Theme tối",
			darkSelectDescription: "Chọn theme cho giao diện terminal nền tối",
			automaticOption: {
				label: "  tự động",
				description: "Dùng theme riêng cho terminal sáng và tối",
			},
			systemThemeDescription: "Theme tạo từ màu hiện tại của terminal",
		},
		modelThinking: {
			modelStepTitle: "Mức suy nghĩ theo từng model",
			modelStepDescription: "Chọn model cần cấu hình",
			noModels: {
				label: "Chưa có model nào",
				description: "Đăng nhập provider hoặc cấu hình API key trước",
			},
			levelStepTitle: (model) => `Mức suy nghĩ cho ${model}`,
			levelStepDescription: "Chọn mức suy nghĩ mặc định cho model này",
			thinkingDescriptions: {
				off: "Không suy nghĩ",
				minimal: "Suy nghĩ rất ngắn (~1k tokens)",
				low: "Suy nghĩ nhẹ (~2k tokens)",
				medium: "Suy nghĩ vừa (~8k tokens)",
				high: "Suy nghĩ sâu (~16k tokens)",
				xhigh: "Suy nghĩ rất sâu (~32k tokens)",
				max: "Suy nghĩ tối đa",
			},
			clearOverride: {
				label: "  (xóa ghi đè)",
				description: (globalDefault) => `Về mặc định chung (${globalDefault})`,
			},
			overridesNone: "không có",
			overridesCount: (count) => `đã cấu hình ${count}`,
		},
		projectTrustLabels: {
			ask: "Hỏi",
			always: "Luôn tin",
			never: "Không bao giờ tin",
		},
	},
	slashCommands: {
		settings: { description: "Mở menu settings" },
		model: { description: "Chọn model (mở giao diện chọn)" },
		tree: { description: "Điều hướng cây session (chuyển branch)" },
		thinking: { description: "Đặt mức suy nghĩ" },
		"scoped-models": { description: "Bật/tắt model cho việc xoay vòng Ctrl+P" },
		export: { description: "Export session (mặc định HTML, hoặc chỉ định path: .html/.jsonl)" },
		import: { description: "Import và resume session từ file JSONL" },
		share: { description: "Chia sẻ session qua Radius artifact hoặc GitHub gist" },
		bug: { description: "Báo bug cho đội phát triển Pi" },
		copy: { description: "Copy message agent cuối vào clipboard" },
		name: { description: "Đặt tên hiển thị session" },
		session: { description: "Xem thông tin và thống kê session" },
		changelog: { description: "Xem các mục changelog" },
		hotkeys: { description: "Xem tất cả phím tắt" },
		fork: { description: "Tạo fork mới từ một message user trước đó" },
		clone: { description: "Nhân bản session hiện tại tại vị trí hiện tại" },
		trust: { description: "Lưu quyết định tin project cho các session sau" },
		login: { description: "Cấu hình xác thực provider" },
		logout: { description: "Xóa xác thực provider" },
		new: { description: "Bắt đầu session mới" },
		compact: { description: "Nén ngữ cảnh session thủ công" },
		resume: { description: "Resume một session khác" },
		reload: { description: "Nạp lại keybindings, extensions, skills, prompts, themes và context files" },
		quit: { description: `Thoát ${APP_NAME}` },
	},
	hotkeys: {
		title: "Phím tắt",
		sections: { navigation: "Điều hướng", editing: "Chỉnh sửa", other: "Khác", extensions: "Tiện ích mở rộng" },
		table: { key: "Phím", action: "Tác vụ" },
		actions: {
			moveCursor: "Di chuyển con trỏ / duyệt lịch sử",
			moveByWord: "Di chuyển theo từ",
			startOfLine: "Đầu dòng",
			endOfLine: "Cuối dòng",
			jumpForward: "Nhảy tới ký tự",
			jumpBackward: "Nhảy lùi tới ký tự",
			scrollByPage: "Cuộn theo trang",
			sendMessage: "Gửi message",
			newLine: "Xuống dòng",
			windowsNewLineNote: "Ctrl+Enter trên Windows Terminal",
			deleteWordBackward: "Xóa từ phía trước",
			deleteWordForward: "Xóa từ phía sau",
			deleteToLineStart: "Xóa đến đầu dòng",
			deleteToLineEnd: "Xóa đến cuối dòng",
			pasteRecentDeleted: "Dán đoạn vừa xóa gần nhất",
			cycleDeletedText: "Chuyển giữa các đoạn đã xóa sau khi dán",
			undo: "Hoàn tác",
			pathCompletion: "Hoàn tất đường dẫn / nhận autocomplete",
			cancelAutocomplete: "Hủy autocomplete / dừng stream",
			clearEditor: "Xóa editor (lần đầu) / thoát (lần hai)",
			exitWhenEmpty: "Thoát khi editor trống",
			suspend: "Tạm dừng và chuyển xuống nền",
			cycleThinking: "Đổi mức suy nghĩ",
			cycleModels: "Đổi model",
			openModelSelector: "Mở bộ chọn model",
			expandToolOutput: "Bật/tắt mở rộng kết quả tool",
			toggleThinking: "Bật/tắt hiển thị khối suy nghĩ",
			externalEditor: "Sửa message bằng trình soạn thảo ngoài",
			copyMessage: "Copy phần chọn hoặc message cuối của assistant",
			queueFollowUp: "Đưa message tiếp theo vào hàng đợi",
			restoreQueued: "Khôi phục message đang chờ",
			pasteClipboard: "Dán file trên macOS, ảnh hoặc văn bản từ clipboard",
			slashCommands: "Lệnh slash",
			runBash: "Chạy lệnh bash",
			runBashWithoutContext: "Chạy lệnh bash (không đưa vào context)",
		},
	},
	status: {
		httpIdleTimeout: (value) => `Thời gian chờ HTTP: ${value}`,
		cacheWarming: (mode) => `Làm nóng cache: ${mode}`,
		tuiMode: (mode) => `Chế độ TUI: ${mode}`,
		closeOverlaysFirst: "Đóng các overlay đang mở trước khi đổi chế độ TUI",
		defaultThinkingLevel: (level) => `Mức suy nghĩ mặc định: ${level}`,
		thinkingLevel: (level) => `Mức suy nghĩ: ${level}`,
		thinkingBlocks: (hidden) => `Khối suy nghĩ: ${hidden ? "đang ẩn" : "đang hiện"}`,
		toolOutput: (expanded) => `Kết quả tool: ${expanded ? "đang mở rộng" : "đang thu gọn"}`,
		forked: "Đã fork sang session mới",
		navigated: "Đã chuyển đến điểm đã chọn",
		startupInProgress: "Khởi động chưa xong",
		autoCompactionCancelled: "Đã hủy tự nén ngữ cảnh",
		suspendNotSupported: "Không hỗ trợ đưa xuống nền trên Windows",
		noQueuedMessages: "Không có message đang chờ để khôi phục",
		restoredQueued: (count) => `Đã đưa ${count} message đang chờ về editor`,
		modelNoThinking: "Model hiện tại không hỗ trợ suy nghĩ",
		onlyOneModelInScope: "Chỉ có một model trong scope",
		onlyOneModelAvailable: "Chỉ có một model khả dụng",
		switchedTo: (model, thinkingSuffix) => `Đã chuyển sang ${model}${thinkingSuffix}`,
		thinkingSuffix: (level) => ` (đang nghĩ: ${level})`,
		queuedAfterCompaction: "Đã xếp hàng message cho sau khi nén",
		sessionCompacted: (count) => `Đã nén session ${count} lần`,
		modelLabel: (modelId) => `Model: ${modelId}`,
		defaultModel: (provider, modelId) => `Model mặc định: ${provider}/${modelId}`,
		refreshingModelCatalogs: "Đang làm mới catalog model…",
		modelCatalogsRefreshed: "Đã làm mới catalog model.",
		savedTrustDecision: (trusted, appName) =>
			`Đã lưu quyết định tin project: ${trusted ? "tin" : "không tin"}. Khởi động lại ${appName} để có hiệu lực.`,
		modelSelectionSaved: "Đã lưu lựa chọn model vào settings",
		noMessagesToFork: "Không có message nào để fork",
		nothingToClone: "Chưa có gì để clone",
		cloned: "Đã clone sang session mới",
		noEntriesInSession: "Session chưa có entry nào",
		alreadyAtPoint: "Đang ở điểm này rồi",
		branchSummaryCancelled: "Đã hủy tóm tắt branch",
		navigationCancelled: "Đã hủy điều hướng",
		copiedSelectedMessage: "Đã copy message đã chọn vào clipboard",
		resumeCancelled: "Đã hủy resume",
		noLoginMethods: "Không có phương thức đăng nhập nào.",
		noAccountProviders: "Không có provider tài khoản nào.",
		noApiKeyProviders: "Không có provider API key nào.",
		noLoginProviders: "Không có provider đăng nhập nào.",
		noStoredCredentials:
			"Không có credentials nào đã lưu để xóa. /logout chỉ xóa credentials do /login lưu; biến môi trường và config models.json giữ nguyên.",
		loggedInTo: (provider) => `Đã đăng nhập ${provider}`,
		savedApiKeyFor: (provider) => `Đã lưu API key cho ${provider}`,
		authSelectedModel: (actionLabel, modelId, authPath) =>
			`${actionLabel}. Đã chọn ${modelId}. Đã lưu credentials tại ${authPath}`,
		authCredentialsSaved: (actionLabel, authPath) => `${actionLabel}. Đã lưu credentials tại ${authPath}`,
		authCredentialsSavedRefreshing: (actionLabel, authPath) =>
			`${actionLabel}. Đã lưu credentials tại ${authPath}. Đang làm mới catalog model…`,
		loggedOut: (providerName) => `Đã đăng xuất khỏi ${providerName}`,
		removedApiKey: (providerName) =>
			`Đã xóa API key đã lưu cho ${providerName}. Biến môi trường và config models.json giữ nguyên.`,
		reloaded: (savedTrust) =>
			savedTrust
				? "Đã nạp lại keybindings, extensions, skills, prompts, themes và context files; đã lưu quyết định tin project"
				: "Đã nạp lại keybindings, extensions, skills, prompts, themes và context files",
		sessionExported: (filePath) => `Đã export session ra: ${filePath}`,
		sessionImported: (inputPath) => `Đã import session từ: ${inputPath}`,
		importCancelled: "Đã hủy import",
		copiedLastMessage: "Đã copy message agent cuối vào clipboard",
	},
};

export const LI_UI_COPY: Record<LiLocale, LiUiCopy> = {
	en: EN_COPY,
	vi: VI_COPY,
};

export function getLiUiCopy(locale: LiLocale): LiUiCopy {
	return LI_UI_COPY[normalizeLiLocale(locale)];
}

let currentLocale: LiLocale = "en";

/**
 * Effective locale. Pi is pinned to "en" so shared surfaces keep their copy
 * regardless of any leftover settings.li.language in the shared profile.
 */
export function currentLiLocale(): LiLocale {
	return APP_NAME === "li" ? currentLocale : "en";
}

/** Locale-aware copy for the running process. */
export function liCopy(): LiUiCopy {
	return LI_UI_COPY[currentLiLocale()];
}

/**
 * Apply a locale change: update in-process state and (under the Li runtime)
 * publish LI_UI_LANGUAGE for the two first-party extensions. Child shells never
 * see the variable because shell.ts strips every LI_* key from getShellEnv().
 */
export function applyLiLocale(locale: LiLocale): void {
	currentLocale = normalizeLiLocale(locale);
	// LI_RUNTIME is only set by the Li launcher (bin/li.cmd); Pi processes never
	// have it, so the bridge variable is never published outside Li.
	if (process.env.LI_RUNTIME === "1") {
		process.env[LI_UI_LANGUAGE_ENV] = currentLocale;
	}
}
