import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	getCurrentTools,
	getModel,
	registerFauxProvider,
	type SystemMessage,
	type ToolSelectionSnapshot,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[],
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["grep", "find"]);
		expect(session.systemPrompt).toContain("- grep:");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		expect(session.getActiveToolNames()).toEqual(["read", "powershell", "edit", "write"]);
		expect(session.systemPrompt).toContain("- powershell: Execute PowerShell commands");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("activates an inactive extension tool with +name", async () => {
		const session = await createSession(["+inactive_tool", "-write"], {}, [
			(pi) => {
				pi.registerTool({
					name: "inactive_tool",
					label: "Inactive Tool",
					description: "Extension tool registered inactive",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					defaultActive: false,
				});
			},
		]);

		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read"]);
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(pi) => {
					pi.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "grep", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		expect(allowlistedSession.getActiveToolNames()).toEqual(["read"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		expect(excludedSession.getActiveToolNames()).toEqual(["grep"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies +name and -name tool options to the default selection", async () => {
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const session = await createSession(["+grep"], { tools: ["+inactive_tool", "-write"] }, [inactiveTool]);
		expect(session.getActiveToolNames().sort()).toEqual([
			"active_tool",
			"bash",
			"edit",
			"grep",
			"inactive_tool",
			"read",
		]);
		session.dispose();

		const toolLess = await createSession(["read"], { noTools: "all", tools: ["+inactive_tool"] }, [inactiveTool]);
		expect(toolLess.getActiveToolNames()).toEqual(["inactive_tool"]);
		toolLess.dispose();
	});

	it("rejects invalid tool modifier options", async () => {
		await expect(createSession([], { tools: ["read", "+grep"] })).rejects.toThrow(
			"Invalid tools option: tool names cannot be mixed with +name or -name entries",
		);
		await expect(createSession([], { tools: ["-gr*"] })).rejects.toThrow(
			"Invalid tools option: +name and -name entries take exact tool names, not patterns: -gr*",
		);
	});

	describe("reload", () => {
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
		};

		const writeSettings = (settings: object) =>
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		async function createFileSession(options: ToolOptions = {}) {
			const settingsManager = SettingsManager.create(tempDir, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [inactiveTool],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager: SessionManager.inMemory(tempDir),
					resourceLoader,
					...options,
				})
			).session;
		}

		// #10245
		it("activates only tools newly added to defaultTools", async () => {
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			session.setActiveToolsByName(["read", "edit", "write"]);

			writeSettings({ defaultTools: ["+inactive_tool", "+grep"] });
			await session.reload();
			// bash was disabled during the session and is not newly added, so it stays off.
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);

			// Removing tools from the setting does not disable them.
			writeSettings({ defaultTools: ["-read"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);
			session.dispose();
		});

		it("keeps tools removed by -name tool options removed on reload", async () => {
			writeSettings({ defaultTools: ["read"] });
			const session = await createFileSession({ tools: ["-bash", "+grep"] });
			expect(session.getActiveToolNames()).toEqual(["read", "grep"]);

			writeSettings({ defaultTools: ["read", "bash", "inactive_tool"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		it("keeps explicit tool options on reload", async () => {
			const allowlisted = await createFileSession({ tools: ["read"] });
			writeSettings({ defaultTools: ["+grep"] });
			await allowlisted.reload();
			expect(allowlisted.getActiveToolNames()).toEqual(["read"]);
			allowlisted.dispose();

			writeSettings({});
			const builtinless = await createFileSession({ noTools: "builtin" });
			writeSettings({ defaultTools: ["+grep"] });
			await builtinless.reload();
			expect(builtinless.getActiveToolNames()).toEqual([]);
			builtinless.dispose();

			writeSettings({});
			const excluded = await createFileSession({ excludeTools: ["grep"] });
			writeSettings({ defaultTools: ["+grep", "+inactive_tool"] });
			await excluded.reload();
			expect(excluded.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read", "write"]);
			excluded.dispose();
		});
	});

	// #10785
	describe("resume", () => {
		const extensionTools: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		/** A session whose transcript records the loadout `toolNames`, as a run records it. */
		function createRecordedSession(toolNames: string[]): SessionManager {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({
				role: "system",
				content: "",
				toolsAdded: toolNames.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
				timestamp: Date.now(),
			});
			return sessionManager;
		}

		async function resume(sessionManager: SessionManager, options: ToolOptions = {}) {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [extensionTools],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager,
					resourceLoader,
					...options,
				})
			).session;
		}

		it("restores the loadout the transcript records and adds new default tools", async () => {
			// active_tool was deactivated during the session, inactive_tool activated. Default
			// candidates the transcript never mentions (bash, edit, write, active_tool) migrate in.
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]));
			expect(session.getActiveToolNames().sort()).toEqual([
				"active_tool",
				"bash",
				"edit",
				"grep",
				"inactive_tool",
				"read",
				"write",
			]);
			session.dispose();
		});

		it("does not restore excluded tools", async () => {
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]), {
				excludeTools: ["inactive_tool"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "grep", "read", "write"]);
			session.dispose();
		});

		it("uses explicit tool options instead of the recorded loadout", async () => {
			const recorded = ["read", "grep", "inactive_tool"];

			const allowlisted = await resume(createRecordedSession(recorded), { tools: ["read", "write"] });
			expect(allowlisted.getActiveToolNames()).toEqual(["read", "write"]);
			allowlisted.dispose();

			const builtinless = await resume(createRecordedSession(recorded), { noTools: "builtin" });
			expect(builtinless.getActiveToolNames()).toEqual(["active_tool"]);
			builtinless.dispose();
		});

		it("applies +name and -name tool options to the migrated loadout", async () => {
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]), {
				tools: ["-grep", "+write"],
			});
			expect(session.getActiveToolNames().sort()).toEqual([
				"active_tool",
				"bash",
				"edit",
				"inactive_tool",
				"read",
				"write",
			]);
			session.dispose();
		});

		it("uses the default tools when the transcript records no loadout", async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
			session.dispose();
		});
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["ls"]);
		session.dispose();
	});
});

describe("tool selection snapshot resume", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function declaredTool(name: string) {
		return { name, description: `${name} tool`, parameters: Type.Object({}) };
	}

	/** System message recorded on the transcript, read back from the session branch. */
	function systemMessages(sessionManager: SessionManager): SystemMessage[] {
		const messages: SystemMessage[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "system") messages.push(message);
		}
		return messages;
	}

	function recordedSnapshots(sessionManager: SessionManager): ToolSelectionSnapshot[] {
		return systemMessages(sessionManager)
			.map((message) => message.toolSelectionSnapshot)
			.filter((snapshot): snapshot is ToolSelectionSnapshot => snapshot !== undefined);
	}

	function notices(sessionManager: SessionManager): Array<{ kind?: string; tools?: string[] }> {
		return sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "tool_selection_notice")
			.map((entry) => {
				const data = (entry as { data?: { kind?: string; tools?: string[] } }).data;
				return { kind: data?.kind, tools: data?.tools };
			});
	}

	const extensionToolExtension: InlineExtension = (pi) => {
		pi.registerTool({
			name: "active_tool",
			label: "Active Tool",
			description: "Extension tool registered active",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	};

	interface PromptableOptions extends ToolOptions {
		extensionFactories?: InlineExtension[];
	}

	/**
	 * Resume (or start) a session whose provider is the faux provider, capturing every provider
	 * context so tests can assert request-level tool declarations.
	 */
	async function createPromptableSession(sessionManager: SessionManager, options: PromptableOptions = {}) {
		const faux = registerFauxProvider();
		const capturedContexts: TranscriptContext[] = [];
		faux.setResponses(
			Array.from({ length: 8 }, () => (context: TranscriptContext) => {
				capturedContexts.push(context);
				return fauxAssistantMessage("ok");
			}),
		);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options.extensionFactories ?? [],
		});
		await resourceLoader.reload();
		const { extensionFactories: _factories, ...toolOptions } = options;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			...toolOptions,
		});
		return { session, faux, capturedContexts };
	}

	it("records an explicit empty snapshot on a real first request and keeps it empty on reopen", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, faux, capturedContexts } = await createPromptableSession(sessionManager, { noTools: "all" });
		await session.prompt("hi");
		expect(session.getActiveToolNames()).toEqual([]);
		// The empty selection is recorded before the provider request.
		expect(recordedSnapshots(sessionManager)).toEqual([{ version: 1, source: "explicit", selectedNames: [] }]);
		// Snapshot metadata never reaches the provider payload.
		expect(JSON.stringify(capturedContexts[0])).not.toContain("toolSelectionSnapshot");
		session.dispose();

		// Reopen without flags: the empty snapshot keeps the toolset empty.
		const reopened = await createPromptableSession(sessionManager);
		expect(reopened.session.getActiveToolNames()).toEqual([]);
		await reopened.session.prompt("again");
		// Idempotent: the reopen records no second snapshot event.
		expect(recordedSnapshots(sessionManager)).toEqual([{ version: 1, source: "explicit", selectedNames: [] }]);
		expect(getCurrentTools(reopened.capturedContexts[0].messages)).toEqual([]);
		expect(JSON.stringify(reopened.capturedContexts[0])).not.toContain("toolSelectionSnapshot");
		reopened.session.dispose();
		faux.unregister();
		reopened.faux.unregister();
	});

	it("restores unknown legacy state to current defaults without a notice", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		// A legacy `noTools: all` session wrote a prompt but no tool event.
		sessionManager.appendMessage({ role: "system", content: "legacy prompt", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
		expect(notices(sessionManager)).toEqual([]);
		await session.prompt("hi");
		expect(recordedSnapshots(sessionManager)).toEqual([
			{ version: 1, source: "default", selectedNames: ["read", "bash", "edit", "write", "active_tool"] },
		]);
		session.dispose();
		faux.unregister();
	});

	it("does not notify the owner about an unknown legacy loadout", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "system", content: "legacy prompt", timestamp: 1 });
		const { session, faux } = await createPromptableSession(sessionManager);
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const uiContext = {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		} as unknown as ExtensionUIContext;
		await session.bindExtensions({ uiContext });
		expect(notifications).toEqual([]);
		expect(notices(sessionManager)).toEqual([]);
		await session.prompt("hi");
		expect(notifications).toEqual([]);
		expect(faux.state.callCount).toBe(1);
		session.dispose();
		faux.unregister();
	});

	it("silently distinguishes migrated defaults from unknown legacy selection", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("read")],
			timestamp: 1,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const uiContext = {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		} as unknown as ExtensionUIContext;
		await session.bindExtensions({ uiContext });
		expect(notifications).toEqual([]);
		expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
		expect(notices(sessionManager)).toEqual([]);
		await session.prompt("hi");
		expect(notifications).toEqual([]);
		session.dispose();
		faux.unregister();
	});

	it("keeps a legacy add-then-remove replay empty and still applies +name modifiers", async () => {
		const buildTranscript = () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({
				role: "system",
				content: "",
				toolsAdded: [declaredTool("x_tool")],
				timestamp: 1,
			});
			sessionManager.appendMessage({
				role: "system",
				content: "",
				toolsRemoved: [{ name: "x_tool" }],
				timestamp: 2,
			});
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 3 });
			return sessionManager;
		};
		const newToolExtension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "new_tool",
				label: "New Tool",
				description: "Newly added default-active tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const emptyManager = buildTranscript();
		const empty = await createPromptableSession(emptyManager, {
			extensionFactories: [newToolExtension],
		});
		// The recorded empty state stays empty: the new default tool is not merged in.
		expect(empty.session.getActiveToolNames()).toEqual([]);
		expect(notices(emptyManager)).toEqual([]);
		empty.session.dispose();
		empty.faux.unregister();

		const modifiedManager = buildTranscript();
		const modified = await createPromptableSession(modifiedManager, {
			tools: ["+new_tool"],
			extensionFactories: [newToolExtension],
		});
		expect(modified.session.getActiveToolNames()).toEqual(["new_tool"]);
		modified.session.dispose();
		modified.faux.unregister();
	});

	it("keeps a snapshot-backed empty selection empty while a deltaless empty one receives defaults", async () => {
		const newToolExtension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "new_tool",
				label: "New Tool",
				description: "Newly added default-active tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		// Snapshot empty + tool history replaying empty: stays empty.
		const backed = SessionManager.inMemory(tempDir);
		backed.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("x_tool")],
			toolsRemoved: [{ name: "x_tool" }],
			toolSelectionSnapshot: { version: 1, source: "default", selectedNames: [] },
			timestamp: 1,
		});
		const empty = await createPromptableSession(backed, { extensionFactories: [newToolExtension] });
		expect(empty.session.getActiveToolNames()).toEqual([]);
		empty.session.dispose();
		empty.faux.unregister();

		// Snapshot empty without any delta: current default candidates apply.
		const deltaless = SessionManager.inMemory(tempDir);
		deltaless.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "default", selectedNames: [] },
			timestamp: 1,
		});
		const migrated = await createPromptableSession(deltaless, { extensionFactories: [newToolExtension] });
		expect(migrated.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "new_tool", "read", "write"]);
		migrated.session.dispose();
		migrated.faux.unregister();
	});

	it("keeps recorded removals off and merges default candidates the transcript never mentions", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("read"), declaredTool("bash"), declaredTool("edit"), declaredTool("write")],
			timestamp: 1,
		});
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "bash" }],
			toolSelectionSnapshot: { version: 1, source: "default", selectedNames: ["read", "edit", "write"] },
			timestamp: 2,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 3 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		// bash was recorded removed and stays off; active_tool is a never-mentioned candidate.
		expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "edit", "read", "write"]);
		session.dispose();
		faux.unregister();
	});

	it("keeps an explicit snapshot exactly and never merges defaults into it", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "explicit", selectedNames: ["grep"] },
			timestamp: 1,
		});
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		expect(session.getActiveToolNames()).toEqual(["grep"]);
		session.dispose();
		faux.unregister();
	});

	it("snapshots logical selection before excludeTools and allowlist vetoes", async () => {
		const defaultManager = SessionManager.inMemory(tempDir);
		const defaultSession = await createPromptableSession(defaultManager, { excludeTools: ["read"] });
		expect(defaultSession.session.getActiveToolNames()).not.toContain("read");
		await defaultSession.session.prompt("excluded default");
		expect(recordedSnapshots(defaultManager)).toEqual([
			{ version: 1, source: "default", selectedNames: ["read", "bash", "edit", "write"] },
		]);
		defaultSession.session.dispose();
		defaultSession.faux.unregister();

		const explicitManager = SessionManager.inMemory(tempDir);
		const explicitSession = await createPromptableSession(explicitManager, {
			tools: ["read"],
			excludeTools: ["read"],
		});
		expect(explicitSession.session.getActiveToolNames()).not.toContain("read");
		await explicitSession.session.prompt("excluded explicit tool");
		expect(recordedSnapshots(explicitManager)).toEqual([{ version: 1, source: "explicit", selectedNames: ["read"] }]);
		explicitSession.session.dispose();
		explicitSession.faux.unregister();
	});

	it("restores a selected unavailable tool when it registers again but not an explicit disable", async () => {
		const flakyExtension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "flaky",
				label: "Flaky Tool",
				description: "Tool that may be unavailable",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		// Session one selects flaky (default-active extension tool) and records the snapshot.
		const selected = SessionManager.inMemory(tempDir);
		const first = await createPromptableSession(selected, { extensionFactories: [flakyExtension] });
		await first.session.prompt("hi");
		expect(recordedSnapshots(selected).at(-1)?.selectedNames).toContain("flaky");
		first.session.dispose();
		first.faux.unregister();

		// Session two runs without flaky registered: unavailable, but the snapshot keeps the intent.
		const unavailable = await createPromptableSession(selected);
		await unavailable.session.prompt("next");
		expect(unavailable.session.getActiveToolNames()).not.toContain("flaky");
		expect(recordedSnapshots(selected).at(-1)?.selectedNames).toContain("flaky");
		// The provider-visible replay no longer declares flaky while it is unavailable.
		expect(getCurrentTools(unavailable.capturedContexts[0].messages).map((tool) => tool.name)).not.toContain("flaky");
		unavailable.session.dispose();
		unavailable.faux.unregister();

		// Session three registers flaky again: the snapshot restores it.
		const restored = await createPromptableSession(selected, { extensionFactories: [flakyExtension] });
		expect(restored.session.getActiveToolNames()).toContain("flaky");
		restored.session.dispose();
		restored.faux.unregister();

		// An explicit disable records a snapshot without flaky: re-registration does not restore it.
		const disabled = SessionManager.inMemory(tempDir);
		const disabler = await createPromptableSession(disabled, { extensionFactories: [flakyExtension] });
		await disabler.session.prompt("hi");
		disabler.session.setActiveToolsByName(["read", "bash", "edit", "write"]);
		await disabler.session.prompt("again");
		disabler.session.dispose();
		disabler.faux.unregister();
		expect(recordedSnapshots(disabled).at(-1)?.selectedNames).not.toContain("flaky");
		const staysOff = await createPromptableSession(disabled, { extensionFactories: [flakyExtension] });
		expect(staysOff.session.getActiveToolNames()).not.toContain("flaky");
		staysOff.session.dispose();
		staysOff.faux.unregister();
	});

	it("applies the restore decision to late registration", async () => {
		const lateToolExtension: InlineExtension = (pi) => {
			pi.on("session_start", () => {
				pi.registerTool({
					name: "late_tool",
					label: "Late Tool",
					description: "Registered after the restore decision",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			});
		};

		// A default selection with no history absorbs a late-registered default-active tool.
		const openSelection = SessionManager.inMemory(tempDir);
		openSelection.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: {
				version: 1,
				source: "default",
				selectedNames: ["read", "bash", "edit", "write"],
			},
			timestamp: 1,
		});
		const absorbs = await createPromptableSession(openSelection, { extensionFactories: [lateToolExtension] });
		await absorbs.session.bindExtensions({});
		expect(absorbs.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "late_tool", "read", "write"]);
		await absorbs.session.prompt("hi");
		expect(recordedSnapshots(openSelection).at(-1)?.selectedNames).toContain("late_tool");
		absorbs.session.dispose();
		absorbs.faux.unregister();

		// A selection that records late_tool as removed keeps it off when it registers late.
		const rejected = SessionManager.inMemory(tempDir);
		rejected.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("late_tool"), declaredTool("read")],
			timestamp: 1,
		});
		rejected.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "late_tool" }],
			toolSelectionSnapshot: { version: 1, source: "default", selectedNames: ["read"] },
			timestamp: 2,
		});
		const keepsOff = await createPromptableSession(rejected, { extensionFactories: [lateToolExtension] });
		await keepsOff.session.bindExtensions({});
		expect(keepsOff.session.getActiveToolNames().sort()).toEqual(["bash", "edit", "read", "write"]);
		keepsOff.session.dispose();
		keepsOff.faux.unregister();
	});

	it("keeps the first-provider-request cutoff for late default registration", async () => {
		const controllers: Array<() => void> = [];
		const controller: InlineExtension = (pi) => {
			controllers.push(() => {
				pi.registerTool({
					name: "cutoff_tool",
					label: "Cutoff Tool",
					description: "Registered after the cutoff",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			});
		};

		// Fresh instance: after the first provider request a late-registered default tool
		// is registered but stays inactive.
		const freshManager = SessionManager.inMemory(tempDir);
		const fresh = await createPromptableSession(freshManager, { extensionFactories: [controller] });
		await fresh.session.bindExtensions({});
		await fresh.session.prompt("hi");
		controllers[0]();
		expect(fresh.session.getAllTools().map((tool) => tool.name)).toContain("cutoff_tool");
		expect(fresh.session.getActiveToolNames()).not.toContain("cutoff_tool");
		fresh.session.dispose();
		fresh.faux.unregister();

		// Resumed instance gets its own cutoff: pre-prompt registration still merges
		// (r5 parity), and the cutoff applies from its own first provider request.
		const resumedManager = SessionManager.inMemory(tempDir);
		resumedManager.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "default", selectedNames: ["read", "bash", "edit", "write"] },
			timestamp: 1,
		});
		const resumed = await createPromptableSession(resumedManager, { extensionFactories: [controller] });
		await resumed.session.bindExtensions({});
		expect(resumed.session.getActiveToolNames()).not.toContain("cutoff_tool");
		controllers[1]();
		expect(resumed.session.getActiveToolNames()).toContain("cutoff_tool");
		await resumed.session.prompt("one");
		resumed.session.dispose();
		resumed.faux.unregister();
	});

	it("keeps hidden prepareLoadout declarations selected but out of provider payloads", async () => {
		const hiddenExtension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "echo_tool",
				label: "Echo Tool",
				description: "Hidden from requests by prepareLoadout",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.registerTool({
				name: "runner",
				label: "Runner",
				description: "Runs tools",
				parameters: Type.Object({}),
				exposure: "model-only",
				prepareLoadout: () => ({ hiddenDeclarations: ["echo_tool"] }),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, faux, capturedContexts } = await createPromptableSession(sessionManager, {
			extensionFactories: [hiddenExtension],
		});
		await session.prompt("hi");
		// Selected active set keeps echo_tool; the provider-visible replay does not declare it.
		expect(session.getActiveToolNames()).toContain("echo_tool");
		expect(getCurrentTools(capturedContexts[0].messages).map((tool) => tool.name)).not.toContain("echo_tool");
		// The snapshot selection keeps the intent despite the hidden projection.
		expect(recordedSnapshots(sessionManager).at(-1)?.selectedNames).toContain("echo_tool");
		session.dispose();
		faux.unregister();

		// Reopening restores the hidden-from-provider tool in the selected set.
		const reopened = await createPromptableSession(sessionManager, { extensionFactories: [hiddenExtension] });
		await reopened.session.bindExtensions({});
		expect(reopened.session.getActiveToolNames()).toContain("echo_tool");
		reopened.session.setActiveToolsByName(
			reopened.session.getActiveToolNames().filter((name) => name !== "echo_tool"),
		);
		await reopened.session.prompt("disable hidden declaration");
		reopened.session.dispose();
		reopened.faux.unregister();

		// The hidden declaration had no provider delta, but its old snapshot records that it was
		// selected before being explicitly disabled. The empty new snapshot must not re-add it as
		// a newly default-active candidate.
		const disabled = await createPromptableSession(sessionManager, { extensionFactories: [hiddenExtension] });
		expect(disabled.session.getActiveToolNames()).not.toContain("echo_tool");
		disabled.session.dispose();
		disabled.faux.unregister();
	});

	it("restores legacy defaults silently across repeated resumes", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "system", content: "legacy prompt", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		const first = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		expect(notices(sessionManager)).toEqual([]);
		first.session.dispose();
		first.faux.unregister();

		for (let index = 0; index < 2; index++) {
			const repeat = await createPromptableSession(sessionManager, {
				extensionFactories: [extensionToolExtension],
			});
			expect(repeat.session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
			expect(notices(sessionManager)).toEqual([]);
			repeat.session.dispose();
			repeat.faux.unregister();
		}
	});

	it("redeclares a changed custom tool definition on resume", async () => {
		const makeSessionManager = () => {
			const manager = SessionManager.inMemory(tempDir);
			manager.appendMessage({ role: "system", content: "", toolsAdded: [declaredTool("sdk_tool")], timestamp: 1 });
			manager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
			return manager;
		};
		const sdkTool = (description: string) => ({
			name: "sdk_tool",
			label: "SDK Tool",
			description,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		});
		const first = await createPromptableSession(makeSessionManager(), {
			customTools: [sdkTool("original description")],
		});
		await first.session.prompt("hi");
		first.session.dispose();
		first.faux.unregister();

		const resumed = await createPromptableSession(makeSessionManager(), {
			customTools: [sdkTool("changed description")],
		});
		await resumed.session.prompt("again");
		// The replay declares the new definition; the transcript records the redefinition.
		expect(getCurrentTools(resumed.capturedContexts[0].messages).map((tool) => tool.description)).toContain(
			"changed description",
		);
		expect(resumed.session.getActiveToolNames()).toContain("sdk_tool");
		resumed.session.dispose();
		resumed.faux.unregister();
	});

	it("carries the selection snapshot and removed tools through a compaction checkpoint", () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("x_tool")],
			timestamp: 1,
		});
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "explicit", selectedNames: ["read"] },
			timestamp: 2,
		});
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "x_tool" }],
			timestamp: 3,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 4 });
		sessionManager.appendCompaction("summary", null, 100);
		const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");
		expect(compactionEntry).toBeDefined();
		const checkpoint = (compactionEntry as { systemMessage?: SystemMessage }).systemMessage;
		expect(checkpoint?.toolSelectionSnapshot).toEqual({
			version: 1,
			source: "explicit",
			selectedNames: ["read"],
		});
		expect(checkpoint?.toolsRemoved?.map((tool) => tool.name)).toEqual(["x_tool"]);
	});

	it("restores an explicit empty selection from a compaction checkpoint without merging defaults", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "explicit", selectedNames: [] },
			timestamp: 1,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		sessionManager.appendCompaction("summary", null, 100);
		sessionManager.appendMessage({ role: "user", content: "after", timestamp: 3 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		// The checkpoint carries the explicit-empty snapshot: no legacy_unknown, no defaults merge.
		expect(session.getActiveToolNames()).toEqual([]);
		expect(notices(sessionManager)).toEqual([]);
		session.dispose();
		faux.unregister();
	});

	it("does not resurrect removed tools from a compaction checkpoint", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsAdded: [declaredTool("gone_tool")],
			timestamp: 1,
		});
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "gone_tool" }],
			timestamp: 2,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 3 });
		sessionManager.appendCompaction("summary", null, 100);
		sessionManager.appendMessage({ role: "user", content: "after", timestamp: 4 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		// Delta history survives the checkpoint, so the recorded empty state stays empty.
		expect(session.getActiveToolNames()).toEqual([]);
		expect(notices(sessionManager)).toEqual([]);
		await session.prompt("one");
		expect(recordedSnapshots(sessionManager).at(-1)?.selectedNames).not.toContain("gone_tool");
		session.dispose();
		faux.unregister();
	});

	it("treats a handler-edited selectedTools list as a replacement", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		let turn = 0;
		const dropWrite: InlineExtension = (pi) => {
			pi.on("before_agent_start", (event) => {
				if (++turn === 1) {
					event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
						(name) => name !== "write",
					);
				}
			});
		};
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [dropWrite],
		});
		await session.prompt("hi");
		// The dropped tool must not survive in the recorded selection intent.
		const snapshot = recordedSnapshots(sessionManager).at(-1);
		expect(snapshot?.selectedNames).not.toContain("write");
		expect(snapshot?.selectedNames).toContain("read");
		session.dispose();

		const reopened = await createPromptableSession(sessionManager);
		expect(reopened.session.getActiveToolNames()).not.toContain("write");
		expect(reopened.session.getActiveToolNames()).toContain("read");
		await reopened.session.prompt("again");
		reopened.session.dispose();
		reopened.faux.unregister();
		faux.unregister();
	});

	it("drops selected-unavailable intent on replacement with an empty active set", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({
			role: "system",
			content: "",
			toolSelectionSnapshot: { version: 1, source: "explicit", selectedNames: ["ghost_tool"] },
			timestamp: 1,
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		const { session, faux } = await createPromptableSession(sessionManager);
		// The ghost selection keeps nothing active; every() must not treat that as "preserved".
		expect(session.getActiveToolNames()).toEqual([]);
		await session.prompt("one");
		session.setActiveToolsByName(["read"]);
		await session.prompt("two");
		const snapshot = recordedSnapshots(sessionManager).at(-1);
		expect(snapshot?.selectedNames).toEqual(["read"]);
		session.dispose();
		faux.unregister();
	});

	it("keeps default tool modifiers across tree navigation", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "user", content: "root turn", timestamp: 1 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			tools: ["-edit", "-write"],
		});
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(session.getActiveToolNames()).not.toContain("write");
		const rootEntry = sessionManager.getBranch()[0];
		await session.navigateTree(rootEntry.id);
		// Navigation restores with the same modifiers; without them edit/write come back.
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(session.getActiveToolNames()).not.toContain("write");
		session.dispose();
		faux.unregister();
	});

	it("silently migrates defaults without notifying or appending a notice entry", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "system", content: "legacy prompt", timestamp: 1 });
		const { session, faux } = await createPromptableSession(sessionManager, {
			extensionFactories: [extensionToolExtension],
		});
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const uiContext = {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		} as unknown as ExtensionUIContext;
		await session.bindExtensions({ uiContext });
		await session.prompt("hi");
		expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
		expect(notifications).toEqual([]);
		expect(notices(sessionManager)).toEqual([]);
		session.dispose();
		faux.unregister();
	});
});
