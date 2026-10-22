import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { applyLiLocale, currentLiLocale } from "../src/modes/interactive/locale.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("Li model selector status locale", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("renders localized refresh and success messages", async () => {
		harness = await createHarness();
		const previousLocale = currentLiLocale();
		applyLiLocale("vi");
		let selector: ModelSelectorComponent | undefined;

		try {
			vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
				aborted: false,
				errors: new Map(),
			});
			selector = new ModelSelectorComponent(
				createFakeTui(),
				harness.getModel(),
				harness.session.modelRuntime,
				[],
				() => {},
				() => {},
			);

			const render = () => stripAnsi(selector!.render(120).join("\n"));
			expect(render()).toContain("Đang làm mới catalog model…");
			await vi.waitFor(() => expect(render()).toContain("Đã làm mới catalog model."));
		} finally {
			selector?.dispose();
			applyLiLocale(previousLocale);
		}
	});
});
