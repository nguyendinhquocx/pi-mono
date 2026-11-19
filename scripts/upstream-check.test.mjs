import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	buildReport,
	createFixtureTransport,
	countCommits,
	loadLedger,
	recordDecision,
	resolveMainChannel,
	resolveReleaseChannel,
	validateLedger,
} from "./upstream-check.mjs";

const RELEASE_OK = {
	tag_name: "v1.5.3",
	target_commitish: "b4afdddf44e059c67ccf5097e5317d913521b470",
	published_at: "2026-11-20T00:00:00Z",
};
const MAIN_OK = { commit: { sha: "5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9" } };

function fixture(overrides = {}) {
	return { repo: "fixture/pi", release: RELEASE_OK, tags: [], branches: { main: MAIN_OK }, ...overrides };
}

const tempDirs = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("release channel resolves a GitHub release with its own tag and sha", async () => {
	const transport = createFixtureTransport(fixture());
	const release = await resolveReleaseChannel(transport);
	assert.equal(release.status, "ok");
	assert.equal(release.tag, "v1.5.3");
	assert.equal(release.sha, RELEASE_OK.target_commitish);
	assert.equal(release.release_notes, true);
	assert.equal(release.channel, "release-tag");
});

test("main channel resolves an independent snapshot sha", async () => {
	const transport = createFixtureTransport(fixture());
	const main = await resolveMainChannel(transport);
	assert.equal(main.status, "ok");
	assert.equal(main.channel, "main-snapshot");
	assert.equal(main.sha, MAIN_OK.commit.sha);
});

test("api failure fails closed as blocked, never reported as latest", async () => {
	const transport = createFixtureTransport({ repo: "fixture/pi", branches: { main: MAIN_OK } });
	const release = await resolveReleaseChannel(transport);
	assert.equal(release.status, "blocked");
	assert.ok(release.error.length > 0);
	assert.equal(release.tag, null);
	const brokenMain = await resolveMainChannel(createFixtureTransport(fixture({ branches: {} })));
	assert.equal(brokenMain.status, "blocked");
	const report = buildReport({
		release,
		main: brokenMain,
		cursors: {},
		upstreamRepo: "fixture/pi",
	});
	assert.equal(report.status, "blocked");
	assert.equal(report.default_plan_target, null);
});

test("tag without a GitHub release is reported as tag-only, never auto-selected", async () => {
	const transport = createFixtureTransport(
		fixture({
			release: null,
			tags: [{ name: "v1.5.2", commit: { sha: "b4afdddf44e059c67ccf5097e5317d913521b470" } }],
		}),
	);
	const release = await resolveReleaseChannel(transport);
	assert.equal(release.status, "ok");
	assert.equal(release.source, "tag-only");
	assert.equal(release.release_notes, false);
	assert.ok(release.note.includes("không tự chọn"));
});

test("same-cursor run is a no-op: no default plan target when release equals integrated cursor", () => {
	const release = { channel: "release-tag", tag: "v1.5.2", sha: "b4afdddf44e059c67ccf5097e5317d913521b470", release_notes: true, source: "github-release", status: "ok" };
	const main = { channel: "main-snapshot", sha: MAIN_OK.commit.sha, branch: "main", status: "ok" };
	const cursors = {
		last_integrated_target: { sha: release.sha, channel: "release-tag", tag: "v1.5.2", integrated_at: "2026-11-18T00:00:00Z" },
	};
	const report = buildReport({ release, main, cursors, upstreamRepo: "fixture/pi" });
	assert.equal(report.status, "ok");
	assert.equal(report.default_plan_target, null);
	assert.equal(report.channels.release.sha, cursors.last_integrated_target.sha);
});

test("release tag already contained in integrated snapshot is never proposed as target (erratum guard)", () => {
	const release = { channel: "release-tag", tag: "v1.5.2", sha: "b4afdddf44e059c67ccf5097e5317d913521b470", release_notes: true, source: "github-release", status: "ok" };
	const main = { channel: "main-snapshot", sha: MAIN_OK.commit.sha, branch: "main", status: "ok" };
	const cursors = {
		last_integrated_target: { sha: "05fd3fbda0bbb9a1c7a76e4bf92ab58ed77c8d94", channel: "main-snapshot", integrated_at: "2026-11-18T00:00:00Z" },
	};
	// real repo: b4afdddf IS an ancestor of 05fd — but keep offline: inject truth
	const report = buildReport({ release, main, cursors, upstreamRepo: "fixture/pi", ancestryFn: () => true });
	assert.equal(report.default_plan_target, null);
	assert.equal(report.release_already_integrated, true);
});

test("new release behind integrated cursor produces a release-tag default plan target", () => {
	const release = { channel: "release-tag", tag: "v1.5.3", sha: RELEASE_OK.target_commitish, release_notes: true, source: "github-release", status: "ok" };
	const main = { channel: "main-snapshot", sha: MAIN_OK.commit.sha, branch: "main", status: "ok" };
	const cursors = { last_integrated_target: { sha: "0" + "5fd3fbda0bbb9a1c7a76e4bf92ab58ed77c8d94".slice(1), channel: "main-snapshot" } };
	const report = buildReport({ release, main, cursors, upstreamRepo: "fixture/pi" });
	assert.ok(report.default_plan_target);
	assert.equal(report.default_plan_target.channel, "release-tag");
	assert.equal(report.default_plan_target.sha, release.sha);
});

test("validateLedger enforces full SHAs and revisit conditions on skipped decisions", () => {
	const good = {
		schema_version: 1,
		cursors: { last_integrated_target: { sha: "b4afdddf44e059c67ccf5097e5317d913521b470", channel: "release-tag", integrated_at: "2026-11-18T00:00:00Z" } },
		decisions: [
			{ base_sha: "2f8aec7c593166a5654209e4335a30c0c097d8f8", channel: "main-snapshot", status: "reviewed_skipped", reason: "owner defer", revisit_condition: "next release check", reviewer: "owner" },
		],
	};
	assert.deepEqual(validateLedger(good), []);
	const badShortSha = structuredClone(good);
	badShortSha.decisions[0].base_sha = "2f8aec7c";
	assert.ok(validateLedger(badShortSha).some((e) => e.includes("full SHA")));
	const badNoRevisit = structuredClone(good);
	delete badNoRevisit.decisions[0].revisit_condition;
	assert.ok(validateLedger(badNoRevisit).some((e) => e.includes("revisit_condition")));
});

test("recordDecision advances the right cursor per channel and keeps skipped out of integrated", () => {
	const empty = { schema_version: 1, cursors: {}, decisions: [] };
	const skip = recordDecision(empty, {
		base_sha: "2f8aec7c593166a5654209e4335a30c0c097d8f8",
		channel: "main-snapshot",
		target_sha: MAIN_OK.commit.sha,
		status: "reviewed_skipped",
		reason: "owner defer +20 commits",
		revisit_condition: "next release check",
		reviewer: "owner",
		reviewed_at: "2026-11-19T00:00:00Z",
	});
	assert.equal(skip.cursors.last_reviewed_main.sha, MAIN_OK.commit.sha);
	assert.equal(skip.cursors.last_integrated_target, undefined);
	const integrate = recordDecision(skip, {
		base_sha: "2f8aec7c593166a5654209e4335a30c0c097d8f8",
		channel: "release-tag",
		tag: "v1.5.3",
		target_sha: RELEASE_OK.target_commitish,
		status: "integrated",
		reason: "owner chốt full release",
		reviewer: "owner",
		reviewed_at: "2026-11-20T00:00:00Z",
	});
	assert.equal(integrate.cursors.last_integrated_target.sha, RELEASE_OK.target_commitish);
	assert.equal(integrate.cursors.last_integrated_target.tag, "v1.5.3");
	assert.ok(validateLedger(integrate).length === 0);
});

test("ledger round-trips through disk with validation", () => {
	const dir = mkdtempSync(join(tmpdir(), "upstream-check-test-"));
	tempDirs.push(dir);
	const path = join(dir, "ledger.json");
	const empty = { schema_version: 1, cursors: {}, decisions: [] };
	writeFileSync(path, JSON.stringify(empty), "utf8");
	const loaded = loadLedger(path);
	assert.equal(loaded.schema_version, 1);
	const next = recordDecision(loaded, {
		base_sha: "2f8aec7c593166a5654209e4335a30c0c097d8f8",
		channel: "release-tag",
		tag: "v1.5.2",
		target_sha: "b4afdddf44e059c67ccf5097e5317d913521b470",
		status: "integrated",
		reason: "sync",
		reviewer: "owner",
		reviewed_at: "2026-11-18T00:00:00Z",
	});
	writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
	assert.equal(loadLedger(path).decisions.length, 1);
	writeFileSync(path, '{"schema_version":2,"cursors":{},"decisions":[]}', "utf8");
	assert.throws(() => loadLedger(path), /schema_version/);
});

test("release target_commitish as branch name resolves the commit via commitForRef", async () => {
	const transport = createFixtureTransport(
		fixture({
			release: { tag_name: "v1.5.2", target_commitish: "main", published_at: "2026-11-10T00:00:00Z" },
			commitRefs: { "v1.5.2": "b4afdddf44e059c67ccf5097e5317d913521b470" },
		}),
	);
	const release = await resolveReleaseChannel(transport);
	assert.equal(release.status, "ok");
	assert.equal(release.tag, "v1.5.2");
	assert.equal(release.sha, "b4afdddf44e059c67ccf5097e5317d913521b470");
	assert.equal(release.release_notes, true);
});

test("countCommits reports missing objects instead of guessing", () => {
	const result = countCommits("0".repeat(40), "1".repeat(40));
	assert.equal(result.objects_available, false);
	assert.equal(result.count, null);
});
