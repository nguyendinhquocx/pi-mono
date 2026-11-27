import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";

describe("skills directory cache (revision signature)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-cache-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const writeSkill = (dir: string, name?: string) => {
		fs.mkdirSync(dir, { recursive: true });
		const nameLine = name ? `name: ${name}\n` : "";
		fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${nameLine}description: Test skill\n---\n\nBody.\n`);
	};

	// Without frontmatter name, the skill name falls back to the parent directory name —
	// so a renamed directory must change the cataloged skill name.
	it("picks up a renamed skill directory", () => {
		writeSkill(path.join(tempDir, "a"));
		const before = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(before.skills.map((skill) => skill.name)).toEqual(["a"]);

		fs.renameSync(path.join(tempDir, "a"), path.join(tempDir, "b"));
		const after = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(after.skills.map((skill) => skill.name)).toEqual(["b"]);
	});

	it("picks up a .gitignore edit", () => {
		writeSkill(path.join(tempDir, "keep"), "keep");
		writeSkill(path.join(tempDir, "hidden"), "hidden");
		fs.writeFileSync(path.join(tempDir, ".gitignore"), "hidden/\n");
		const before = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(before.skills.map((skill) => skill.name)).toEqual(["keep"]);

		// Removing the ignore rule makes the hidden skill visible on the next load.
		fs.writeFileSync(path.join(tempDir, ".gitignore"), "");
		const after = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(after.skills.map((skill) => skill.name).sort()).toEqual(["hidden", "keep"]);
	});

	it("picks up a deleted skill file", () => {
		writeSkill(path.join(tempDir, "a"), "a");
		writeSkill(path.join(tempDir, "b"), "b");
		const before = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(before.skills.map((skill) => skill.name).sort()).toEqual(["a", "b"]);

		fs.rmSync(path.join(tempDir, "b", "SKILL.md"));
		const after = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(after.skills.map((skill) => skill.name)).toEqual(["a"]);
	});

	it("does not share cache entries between different sources for the same dir", () => {
		writeSkill(path.join(tempDir, "solo"), "solo");
		const asUser = loadSkillsFromDir({ dir: tempDir, source: "user" });
		const asProject = loadSkillsFromDir({ dir: tempDir, source: "project" });

		expect(asUser.skills.map((skill) => skill.name)).toEqual(["solo"]);
		expect(asProject.skills.map((skill) => skill.name)).toEqual(["solo"]);
		// Same content, different provenance: the (dirPath, source) key must keep them apart.
		expect(asUser.skills[0].sourceInfo.scope).toBe("user");
		expect(asProject.skills[0].sourceInfo.scope).toBe("project");
	});

	// Regression: the signature walk used to treat any SKILL.md as a skill root and return early,
	// even when the scan's ignore rules excluded it — edits to the subtree below the ignored
	// SKILL.md then failed to invalidate the cache.
	it("still watches the subtree below an ignored SKILL.md", () => {
		fs.writeFileSync(path.join(tempDir, ".gitignore"), "child/SKILL.md\n");
		fs.mkdirSync(path.join(tempDir, "child", "enfant"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, "child", "SKILL.md"),
			"---\nname: ignored\ndescription: must never load\n---\n",
		);
		fs.writeFileSync(
			path.join(tempDir, "child", "enfant", "SKILL.md"),
			"---\nname: enfant\ndescription: before edit\n---\n",
		);

		const before = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(before.skills.map((skill) => skill.name)).toEqual(["enfant"]);

		fs.writeFileSync(
			path.join(tempDir, "child", "enfant", "SKILL.md"),
			"---\nname: enfant\ndescription: after edit\n---\n",
		);
		const after = loadSkillsFromDir({ dir: tempDir, source: "path" });
		expect(after.skills.map((skill) => skill.name)).toEqual(["enfant"]);
		expect(after.skills[0].description).toBe("after edit");
	});
});
