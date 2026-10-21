import { describe, expect, it } from "vitest";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";

describe("Li minimal horizontal dividers", () => {
	it("omits dynamic separators from settings, resume, and other selector surfaces", () => {
		expect(new DynamicBorder().render(40)).toEqual([]);
	});
});
