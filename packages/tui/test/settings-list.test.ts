import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps default English strings when no copy override is passed", () => {
		const list = new SettingsList(
			[],
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);

		const emptyLines = list.render(80);
		assert.ok(emptyLines.some((line) => line.includes("No settings available")));
		assert.ok(emptyLines.some((line) => line.includes("Type to search · Enter/Space to change · Esc to cancel")));

		const nonSearch = new SettingsList(
			[],
			10,
			testTheme,
			() => {},
			() => {},
		);
		assert.ok(nonSearch.render(80).some((line) => line.includes("No settings available")));

		const filter = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		for (const character of "zzz") filter.handleInput(character);
		assert.ok(filter.render(80).some((line) => line.includes("No matching settings")));
	});

	it("renders copy overrides for empty, no-match, and footer hints", () => {
		const empty = new SettingsList(
			[],
			10,
			testTheme,
			() => {},
			() => {},
			{
				enableSearch: true,
				copy: {
					empty: "Không có mục cài đặt nào",
					noMatch: "Không có mục khớp",
					searchHint: "  Gõ để tìm · Enter đổi · Esc thoát",
					hint: "  Enter/Space đổi · Esc thoát",
				},
			},
		);
		const emptyLines = empty.render(80);
		assert.ok(emptyLines.some((line) => line.includes("Không có mục cài đặt nào")));
		assert.ok(emptyLines.some((line) => line.includes("Gõ để tìm · Enter đổi · Esc thoát")));

		const filter = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			() => {},
			() => {},
			{
				enableSearch: true,
				copy: { noMatch: "Không có mục khớp", searchHint: "  Gõ để tìm · Enter đổi · Esc thoát" },
			},
		);
		for (const character of "zzz") filter.handleInput(character);
		const filtered = filter.render(80);
		assert.ok(filtered.some((line) => line.includes("Không có mục khớp")));

		const plain = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			() => {},
			() => {},
			{ copy: { hint: "  Enter/Space đổi · Esc thoát" } },
		);
		assert.ok(plain.render(80).some((line) => line.includes("Enter/Space đổi · Esc thoát")));
	});
});
