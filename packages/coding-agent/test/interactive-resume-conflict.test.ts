import { describe, expect, it } from "vitest";
import { getLiUiCopy, LI_UI_COPY, type LiLocale } from "../src/modes/interactive/locale.ts";

const locales: LiLocale[] = ["en", "vi"];

describe("liCopy().status.resumeConflict", () => {
	it("is present in every locale catalog", () => {
		for (const locale of locales) {
			expect(typeof LI_UI_COPY[locale].status.resumeConflict).toBe("function");
		}
	});

	it("names the holder PID and open time when both are known", () => {
		for (const locale of locales) {
			const message = getLiUiCopy(locale).status.resumeConflict(28476, "2026-11-23T15:02:52.028Z");
			expect(message).toContain("28476");
			expect(message).toContain("2026-11-23T15:02:52.028Z");
			expect(message.length).toBeGreaterThan(0);
		}
	});

	it("renders without holder details when the lease omits them", () => {
		for (const locale of locales) {
			const message = getLiUiCopy(locale).status.resumeConflict(undefined, undefined);
			expect(message).not.toContain("PID");
			expect(message).not.toContain("undefined");
			expect(message.length).toBeGreaterThan(0);
		}
	});

	it("renders with PID but no open time when openedAt is missing", () => {
		for (const locale of locales) {
			const message = getLiUiCopy(locale).status.resumeConflict(123, undefined);
			expect(message).toContain("123");
			expect(message).not.toContain("undefined");
		}
	});
});
