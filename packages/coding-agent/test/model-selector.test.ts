import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { liCopy } from "../src/modes/interactive/locale.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		// The harness registry also carries built-in catalog models, so navigate
		// by identity instead of assuming a fixed number of arrow presses.
		const totalModels = harness.session.modelRuntime.getAvailableSnapshot().length;
		let reachedBrowsed = false;
		for (let step = 0; step <= totalModels && !reachedBrowsed; step++) {
			reachedBrowsed = getModelRow("browsed-model")?.includes("→ ") ?? false;
			if (!reachedBrowsed) selector.handleInput("\x1b[B");
		}
		expect(reachedBrowsed).toBe(true);
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("keeps the user's highlighted row when the background refresh finishes", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
				{ id: "another-model", name: "Another Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		// Defer the catalog refresh so the user can navigate while it is in flight.
		let resolveRefresh!: () => void;
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRefresh = () => resolve({ aborted: false, errors: new Map() });
				}),
		);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getCursorRow = (): string => {
			const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
			return lines.find((line) => line.includes("→ "))?.trimEnd() ?? "";
		};

		expect(getCursorRow()).toContain("current-model");
		// The harness registry also carries built-in catalog models, so navigate
		// by identity instead of assuming a fixed number of arrow presses.
		const totalModels = harness.session.modelRuntime.getAvailableSnapshot().length;
		let reachedAnother = false;
		for (let step = 0; step <= totalModels && !reachedAnother; step++) {
			reachedAnother = getCursorRow().includes("another-model");
			if (!reachedAnother) selector.handleInput("\x1b[B");
		}
		expect(reachedAnother).toBe(true);

		resolveRefresh();
		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain(liCopy().status.modelCatalogsRefreshed);
		});

		// The refreshed list must not snap the cursor back to the current model.
		expect(getCursorRow()).toContain("another-model");
		selector.dispose();
	});
});
