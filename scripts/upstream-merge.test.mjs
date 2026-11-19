import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ensureUpstreamRemote,
	parseMergeArgs,
	resolveTargetSha,
	renderMergeReceipt,
	validateBackports,
} from "./upstream-merge.mjs";

const TAG_SHA = "b4afdddf44e059c67ccf5097e5317d913521b470";
const MAIN_SHA = "5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9";

function fakeGit({ revParse = {}, describe = "v1.5.2" } = {}) {
	const calls = [];
	return {
		calls,
		gitFn: (...args) => {
			calls.push({ args });
			const opts = typeof args.at(-1) === "object" ? args.pop() : {};
			if (args[0] === "rev-parse") {
				const ref = args[3];
				if (ref === "refs/tags/v1.5.2" || ref === TAG_SHA || ref === MAIN_SHA) return ref === MAIN_SHA ? MAIN_SHA : TAG_SHA;
				if (opts?.allowFail) return "";
				throw new Error("unknown revision");
			}
			if (args[0] === "describe") return describe;
			if (args[0] === "remote") return "";
			return "";
		},
	};
}

test("parseMergeArgs reads channel/target/backports and defaults", () => {
	const cfg = parseMergeArgs([
		"--dry-run",
		"--target", "v1.5.2",
		"--channel", "release-tag",
		"--backports", MAIN_SHA,
		"--guard-files", "a/**",
		"--guard-files", "b/**",
		"--out", ".agent-workbench/upstream",
	]);
	assert.equal(cfg.dry, true);
	assert.equal(cfg.target, "v1.5.2");
	assert.equal(cfg.channel, "release-tag");
	assert.deepEqual(cfg.backports, [MAIN_SHA]);
	assert.deepEqual(cfg.guardExtra, ["a/**", "b/**"]);
	assert.equal(cfg.upstreamUrl, "https://github.com/earendil-works/pi.git");
	assert.equal(cfg.upstreamBranch, "main");
});

test("release-tag channel resolves tag targets and maps sha back to its tag", () => {
	const { gitFn } = fakeGit();
	const byTag = resolveTargetSha({ gitFn, target: "v1.5.2", channel: "release-tag", upstreamSha: MAIN_SHA, dry: false });
	assert.equal(byTag.sha, TAG_SHA);
	assert.equal(byTag.tag, "v1.5.2");
	const bySha = resolveTargetSha({ gitFn, target: TAG_SHA, channel: "release-tag", upstreamSha: MAIN_SHA, dry: false });
	assert.equal(bySha.sha, TAG_SHA);
	assert.equal(bySha.tag, "v1.5.2");
});

test("release-tag channel blocks a sha that maps to no release tag (no main-tip substitution)", () => {
	const { gitFn } = fakeGit({ describe: "" });
	assert.throws(
		() => resolveTargetSha({ gitFn, target: MAIN_SHA, channel: "release-tag", upstreamSha: MAIN_SHA, dry: true }),
		/không map về tag/,
	);
});

test("missing tag objects block with fetch instruction instead of silently using main tip", () => {
	const { gitFn } = fakeGit({ describe: "v1.5.2" });
	assert.throws(
		() => resolveTargetSha({ gitFn, target: "v1.6.0", channel: "release-tag", upstreamSha: MAIN_SHA, dry: true }),
		/KHÔNG thay bằng main tip/,
	);
});

test("main-snapshot channel requires full sha and rejects tags", () => {
	const { gitFn } = fakeGit();
	const ok = resolveTargetSha({ gitFn, target: MAIN_SHA, channel: "main-snapshot", upstreamSha: MAIN_SHA, dry: false });
	assert.equal(ok.sha, MAIN_SHA);
	assert.equal(ok.tag, null);
	assert.throws(
		() => resolveTargetSha({ gitFn, target: "v1.5.2", channel: "main-snapshot", upstreamSha: MAIN_SHA, dry: false }),
		/full SHA 40/,
	);
	const shortSha = MAIN_SHA.slice(0, 8);
	assert.throws(
		() => resolveTargetSha({ gitFn, target: shortSha, channel: "main-snapshot", upstreamSha: MAIN_SHA, dry: false }),
		/full SHA 40/,
	);
});

test("unknown channel and selected-backports target misuse are rejected", () => {
	const { gitFn } = fakeGit();
	assert.throws(() => resolveTargetSha({ gitFn, target: TAG_SHA, channel: "hotfix", upstreamSha: MAIN_SHA, dry: false }), /--channel bắt buộc/);
	assert.throws(
		() => resolveTargetSha({ gitFn, target: TAG_SHA, channel: "selected-backports", upstreamSha: MAIN_SHA, dry: false }),
		/không dùng --target/,
	);
});

test("validateBackports enforces full shas and non-empty list", () => {
	assert.deepEqual(validateBackports([MAIN_SHA]), []);
	assert.ok(validateBackports([])[0].includes("cần --backports"));
	const errs = validateBackports([MAIN_SHA.slice(0, 10)]);
	assert.ok(errs[0].includes("full SHA"));
});

test("ensureUpstreamRemote never mutates config in dry-run", () => {
	const added = [];
	const gitFn = (...args) => {
		if (args[0] === "remote" && args[1] === "add") added.push(args);
		return "";
	};
	const dryState = ensureUpstreamRemote({ gitFn, dry: true, remoteName: "upstream-pipeline", url: "https://example/repo.git" });
	assert.equal(dryState.added, false);
	assert.equal(added.length, 0);
	const realState = ensureUpstreamRemote({ gitFn, dry: false, remoteName: "upstream-pipeline", url: "https://example/repo.git" });
	assert.equal(realState.added, true);
	assert.equal(added.length, 1);
});

test("receipt keeps provenance labels: tag only for release-tag, full sha for snapshot", () => {
	const base = {
		generatedAt: "2026-11-19T00:00:00Z",
		head: TAG_SHA,
		mergeBase: TAG_SHA,
		backports: [],
		behindCount: 0,
		customFiles: 0,
		surface: 0,
		cursors: {},
		matrixPath: ".agent-workbench/upstream/conflict-matrix.json",
		guardOverlap: 0,
		escalation: "",
	};
	const release = renderMergeReceipt({ ...base, channel: "release-tag", targetSha: TAG_SHA, tag: "v1.5.2" });
	assert.ok(release.includes("(tag v1.5.2)"));
	const snapshot = renderMergeReceipt({ ...base, channel: "main-snapshot", targetSha: MAIN_SHA, tag: null });
	assert.ok(snapshot.includes(MAIN_SHA));
	assert.ok(snapshot.includes("KHÔNG gắn nhãn vX.Y.Z"));
	assert.ok(!snapshot.includes("v1.5.2"));
	const backports = renderMergeReceipt({ ...base, channel: "selected-backports", targetSha: TAG_SHA, tag: null, backports: [MAIN_SHA] });
	assert.ok(backports.includes(MAIN_SHA));
});
