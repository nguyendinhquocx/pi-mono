#!/usr/bin/env node
// upstream-check.mjs — kiểm tra upstream Li theo hai kênh (release + main) và ghi quyết định chọn lọc.
// Sinh ra từ SPEC-2026-11-19-li-dual-channel-upstream-check.md (T1 + T3).
//
// Read-only mặc định: KHÔNG fetch, KHÔNG đổi refs, KHÔNG đụng profile/T20.
// Chỉ ghi file khi có --record (ledger.json + receipt draft); commit vẫn làm tay sau owner review.
//
// Dùng:
//   node scripts/upstream-check.mjs                    → report human hai kênh riêng biệt
//   node scripts/upstream-check.mjs --json             → JSON đầy đủ (agent đọc)
//   node scripts/upstream-check.mjs --fixture <file>   → transport offline, không gọi GitHub
//   node scripts/upstream-check.mjs --ledger <path>    → đường dẫn ledger (mặc định docs/upstream-decisions/ledger.json)
//   node scripts/upstream-check.mjs --record --decision-file <file>
//       → validate decision, hợp nhất vào ledger, sinh receipt draft
//
// Nguyên tắc nhãn: tag `vX.Y.Z` CHỈ gắn cho release channel; main snapshot là full SHA,
// tuyệt đối không in "v1.5.2" cạnh SHA của main tip (erratum 2026-11-18-v152).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_LEDGER_PATH = "docs/upstream-decisions/ledger.json";
export const CHANNELS = ["release-tag", "main-snapshot", "selected-backports"];

// ─── transports (inject được để test offline) ────────────────────────────────

// Transport thật: gh api (đã auth trên máy owner). Fail → throw, caller fail-closed.
export function createGhTransport({ repo = "earendil-works/pi" } = {}) {
	const gh = (call) =>
		execFileSync("gh", ["api", `repos/${repo}/${call}`, "--jq", "."], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	return {
		repo,
		latestRelease: () => JSON.parse(gh("releases/latest")),
		listTags: () => JSON.parse(gh("tags?per_page=30")),
		branchHead: (branch) => JSON.parse(gh(`branches/${branch}`)),
		// target_commitish của release có thể là branch name — resolve commit thật qua ref/tag
		commitForRef: (ref) => JSON.parse(gh(`commits/${ref}`)),
	};
}

// Transport fixture: đọc một file JSON có sẵn — dùng cho --fixture và unit tests.
// Shape: { release: {...}|null, tags: [{name, commit:{sha}}], branches: {main:{commit:{sha}}} }
export function createFixtureTransport(fixture) {
	return {
		repo: fixture.repo ?? "fixture/pi",
		latestRelease: async () => {
			if (!("release" in fixture)) throw new Error("fixture: release field missing (simulated API failure)");
			if (fixture.release === null) {
				const err = new Error("fixture: no GitHub release");
				err.status = 404;
				throw err;
			}
			return fixture.release;
		},
		listTags: async () => fixture.tags ?? [],
		branchHead: async (branch) => {
			const head = fixture.branches?.[branch];
			if (!head) throw new Error(`fixture: branch ${branch} missing`);
			return head;
		},
		commitForRef: async (ref) => {
			const sha = fixture.commitRefs?.[ref];
			if (!sha) throw new Error(`fixture: commitRefs[${ref}] missing`);
			return { sha };
		},
	};
}

// ─── resolvers: mỗi kênh resolve độc lập, không được nuốt lỗi của kênh kia ───

// Release channel: ưu tiên GitHub release; 404 → fallback tag semver mới nhất,
// nhưng đánh dấu release_notes=false để agent biết đây là tag chưa có release notes
// (spec: báo riêng, không tự chọn làm candidate mặc định).
export async function resolveReleaseChannel(transport) {
	const shaFrom = async (rel) => {
		if (rel.target_commitish?.length === 40) return rel.target_commitish;
		try {
			const c = await transport.commitForRef(rel.tag_name);
			return c.sha?.length === 40 ? c.sha : null;
		} catch {
			return null;
		}
	};
	try {
		const rel = await transport.latestRelease();
		return {
			channel: "release-tag",
			tag: rel.tag_name,
			sha: await shaFrom(rel),
			published_at: rel.published_at ?? null,
			release_notes: true,
			source: "github-release",
			status: "ok",
		};
	} catch (err) {
		if (err?.status === 404) {
			const tags = await transport.listTags();
			const semver = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.name));
			if (semver.length === 0) {
				return { channel: "release-tag", tag: null, sha: null, release_notes: false, source: "none", status: "blocked", error: "no release and no semver tag" };
			}
			return {
				channel: "release-tag",
				tag: semver[0].name,
				sha: semver[0].commit?.sha ?? null,
				release_notes: false,
				source: "tag-only",
				status: "ok",
				note: "tag chưa có GitHub Release — báo riêng, không tự chọn làm target mặc định",
			};
		}
		return { channel: "release-tag", tag: null, sha: null, release_notes: false, source: "error", status: "blocked", error: String(err?.message ?? err) };
	}
}

export async function resolveMainChannel(transport, { branch = "main" } = {}) {
	try {
		const head = await transport.branchHead(branch);
		return { channel: "main-snapshot", sha: head.commit?.sha ?? null, branch, status: "ok" };
	} catch (err) {
		return { channel: "main-snapshot", sha: null, branch, status: "blocked", error: String(err?.message ?? err) };
	}
}

// ─── ledger: load/validate/record (pure parts export để test) ────────────────

const FULL_SHA = /^[0-9a-f]{40}$/;

// Validator thủ công cho schema v1 — đủ strict cho agent dùng, không thêm dependency.
export function validateLedger(ledger) {
	const errors = [];
	if (typeof ledger !== "object" || ledger === null || Array.isArray(ledger)) return ["ledger phải là object"];
	if (ledger.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(`schema_version phải là ${LEDGER_SCHEMA_VERSION}`);
	for (const key of ["cursors", "decisions"]) {
		if (typeof ledger[key] !== "object" || ledger[key] === null) errors.push(`thiếu ${key}`);
	}
	if (errors.length > 0) return errors;
	const c = ledger.cursors;
	for (const cur of ["last_reviewed_release", "last_reviewed_main", "last_integrated_target"]) {
		if (c[cur] === undefined || c[cur] === null) continue;
		if (!FULL_SHA.test(c[cur].sha ?? "")) errors.push(`cursors.${cur}.sha phải là full SHA`);
		if (!c[cur].reviewed_at && !c[cur].integrated_at) errors.push(`cursors.${cur} thiếu reviewed_at/integrated_at`);
	}
	if (c.last_integrated_target && !CHANNELS.includes(c.last_integrated_target.channel)) {
		errors.push(`cursors.last_integrated_target.channel không hợp lệ (${CHANNELS.join("|")})`);
	}
	if (!Array.isArray(ledger.decisions)) errors.push("decisions phải là array");
	for (const [i, d] of (ledger.decisions ?? []).entries()) {
		if (!FULL_SHA.test(d.base_sha ?? "")) errors.push(`decisions[${i}].base_sha phải là full SHA`);
		if (!CHANNELS.includes(d.channel)) errors.push(`decisions[${i}].channel không hợp lệ`);
		if (!["integrated", "reviewed_skipped", "backport_planned", "backported"].includes(d.status)) {
			errors.push(`decisions[${i}].status không hợp lệ`);
		}
		if (!d.reason) errors.push(`decisions[${i}] thiếu reason`);
		if (!d.reviewer) errors.push(`decisions[${i}] thiếu reviewer`);
		if (d.status === "reviewed_skipped" && !d.revisit_condition) {
			errors.push(`decisions[${i}] skipped phải có revisit_condition`);
		}
		if (d.target_sha !== undefined && d.target_sha !== null && !FULL_SHA.test(d.target_sha)) {
			errors.push(`decisions[${i}].target_sha phải là full SHA`);
		}
	}
	return errors;
}

export function loadLedger(path) {
	if (!existsSync(path)) return { schema_version: LEDGER_SCHEMA_VERSION, cursors: {}, decisions: [] };
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	const errors = validateLedger(parsed);
	if (errors.length > 0) throw new Error(`ledger không hợp lệ (${path}): ${errors.join("; ")}`);
	return parsed;
}

// Hợp nhất một decision mới vào ledger (pure — caller quyết định ghi file).
export function recordDecision(ledger, decision) {
	const next = {
		schema_version: LEDGER_SCHEMA_VERSION,
		updated_at: new Date().toISOString(),
		cursors: { ...ledger.cursors },
		decisions: [...ledger.decisions, { id: `d-${Date.now()}`, ...decision }],
	};
	const d = next.decisions.at(-1);
	if (d.channel === "release-tag" && d.status !== "backport_planned") {
		next.cursors.last_reviewed_release = { tag: d.tag ?? null, sha: d.target_sha ?? d.base_sha, reviewed_at: d.reviewed_at };
	}
	if (d.channel === "main-snapshot") {
		next.cursors.last_reviewed_main = { sha: d.target_sha ?? d.base_sha, reviewed_at: d.reviewed_at };
	}
	if (d.status === "integrated" || d.status === "backported") {
		next.cursors.last_integrated_target = { sha: d.target_sha ?? d.base_sha, channel: d.channel, tag: d.tag ?? null, integrated_at: d.reviewed_at, receipt_ref: d.receipt_ref ?? null };
	}
	const errors = validateLedger(next);
	if (errors.length > 0) throw new Error(`decision sinh ledger không hợp lệ: ${errors.join("; ")}`);
	return next;
}

// ─── deltas: đếm trên objects local, không fetch (read-only tuyệt đối) ───────

function git(...call) {
	return execFileSync("git", call, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function countCommits(fromSha, toSha) {
	try {
		return { count: Number(git("rev-list", "--count", `${fromSha}..${toSha}`)), objects_available: true };
	} catch {
		return { count: null, objects_available: false, note: "thiếu objects local — fetch upstream để đếm chính xác" };
	}
}

// true khi fromSha là ancestor của toSha (release tag đã nằm trong integrated snapshot).
// Thiếu objects → false (không khẳng định ancestry), caller dựa vào default target note.
export function isAncestor(fromSha, toSha) {
	try {
		git("merge-base", "--is-ancestor", fromSha, toSha);
		return true;
	} catch {
		return false;
	}
}

// ─── report ──────────────────────────────────────────────────────────────────

export function buildReport({ release, main, cursors, upstreamRepo, ancestryFn = isAncestor }) {
	const integrated = cursors.last_integrated_target ?? null;
	const releaseDelta = release.sha && integrated ? countCommits(integrated.sha, release.sha) : { count: null, objects_available: false };
	const mainDelta = main.sha && integrated ? countCommits(integrated.sha, main.sha) : { count: null, objects_available: false };
	const mainVsRelease = release.sha && main.sha ? countCommits(release.sha, main.sha) : { count: null, objects_available: false };
	const stale = release.status !== "ok" || main.status !== "ok";
	// Release đã nằm trong integrated snapshot → không đề xuất target cũ hơn integrated (erratum v1.5.2 vs 05fd)
	const releaseAlreadyIntegrated = Boolean(release.sha && integrated && ancestryFn(release.sha, integrated.sha));
	const default_plan_target = release.status === "ok" && release.sha && !releaseAlreadyIntegrated && (!integrated || release.sha !== integrated.sha)
		? { channel: "release-tag", tag: release.tag, sha: release.sha, note: "mặc định policy — tạo plan bằng upstream-merge.mjs --channel release-tag" }
		: null;
	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		upstream: upstreamRepo,
		channels: { release, main },
		cursors: {
			last_reviewed_release: cursors.last_reviewed_release ?? null,
			last_reviewed_main: cursors.last_reviewed_main ?? null,
			last_integrated_target: integrated,
		},
		deltas: {
			release_vs_integrated: releaseDelta,
			main_vs_integrated: mainDelta,
			main_vs_release: mainVsRelease,
		},
		default_plan_target,
		release_already_integrated: releaseAlreadyIntegrated,
		status: stale ? "blocked" : "ok",
		note_status: stale ? "một kênh BLOCKED — báo stale, KHÔNG dùng dữ liệu kênh đó như latest" : "hai kênh ok",
	};
}

function renderHuman(report) {
	const lines = [];
	const r = report.channels.release;
	const m = report.channels.main;
	lines.push(`== Release channel ==`);
	if (r.status === "ok") {
		lines.push(`  tag = ${r.tag}  sha = ${r.sha ?? "?"}  release_notes = ${r.release_notes}${r.source === "tag-only" ? `  (${r.note})` : ""}`);
	} else {
		lines.push(`  BLOCKED: ${r.error}`);
	}
	lines.push(`== Main channel ==`);
	if (m.status === "ok") lines.push(`  main snapshot = ${m.sha}  (branch ${m.branch})`);
	else lines.push(`  BLOCKED: ${m.error}`);
	const c = report.cursors;
	lines.push(`== Cursors (ledger) ==`);
	lines.push(`  last_integrated_target = ${c.last_integrated_target ? `${c.last_integrated_target.sha} [${c.last_integrated_target.channel}${c.last_integrated_target.tag ? ` ${c.last_integrated_target.tag}` : ""}]` : "(chưa ghi)"}`);
	lines.push(`  last_reviewed_release  = ${c.last_reviewed_release ? `${c.last_reviewed_release.tag ?? "?"} @ ${c.last_reviewed_release.sha}` : "(chưa ghi)"}`);
	lines.push(`  last_reviewed_main     = ${c.last_reviewed_main ? c.last_reviewed_main.sha : "(chưa ghi)"}`);
	lines.push(`== Deltas (objects local, không fetch) ==`);
	const d = report.deltas;
	lines.push(`  integrated → release: ${d.release_vs_integrated.count ?? "?"} commits${d.release_vs_integrated.objects_available ? "" : "  [thiếu objects]"}`);
	lines.push(`  integrated → main:    ${d.main_vs_integrated.count ?? "?"} commits${d.main_vs_integrated.objects_available ? "" : "  [thiếu objects]"}`);
	lines.push(`  release → main:       ${d.main_vs_release.count ?? "?"} commits${d.main_vs_release.objects_available ? "" : "  [thiếu objects]"}`);
	if (report.default_plan_target) lines.push(`== Đề xuất target mặc định ==\n  ${report.default_plan_target.tag} @ ${report.default_plan_target.sha} — ${report.default_plan_target.note}`);
	lines.push(`status = ${report.status} (${report.note_status})`);
	return lines.join("\n");
}

// ─── receipt draft (chỉ sinh khi --record) ───────────────────────────────────

export function renderReceiptDraft({ report, decision }) {
	return `# Upstream check receipt (draft từ upstream-check.mjs)

- generated: ${new Date().toISOString()}
- base (li/stable HEAD tại lúc check): ${decision.base_sha}
- channel: ${decision.channel}${decision.tag ? ` (tag ${decision.tag})` : ""}
- target: ${decision.target_sha ?? decision.base_sha}
- release channel lúc check: ${report.channels.release.status === "ok" ? `${report.channels.release.tag} @ ${report.channels.release.sha ?? "?"}` : "BLOCKED"}
- main channel lúc check: ${report.channels.main.status === "ok" ? report.channels.main.sha : "BLOCKED"}
- cursors sau record: last_integrated_target=${report.cursors.last_integrated_target?.sha ?? "(chưa ghi)"} | last_reviewed_release=${report.cursors.last_reviewed_release?.sha ?? "(chưa ghi)"} | last_reviewed_main=${report.cursors.last_reviewed_main?.sha ?? "(chưa ghi)"}
- status quyết định: ${decision.status}
- reason: ${decision.reason}
- revisit_condition: ${decision.revisit_condition ?? "(n/a)"}
- included: ${(decision.included ?? []).join(", ") || "(n/a — full channel)"}
- skipped: ${(decision.skipped ?? []).join(", ") || "(none)"}
- reviewer: ${decision.reviewer}
- test_refs: ${(decision.test_refs ?? []).join(", ") || "(điền sau gates)"}
- receipt_ref: ${decision.receipt_ref ?? "(chính file này)"}
`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function isMain() {
	try {
		return import.meta.url === pathToFileURL(process.argv[1]).href;
	} catch {
		return true;
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const flag = (name) => argv.includes(`--${name}`);
	const value = (name) => {
		const i = argv.indexOf(`--${name}`);
		return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
	};
	const JSON_OUT = flag("json");
	const RECORD = flag("record");
	const FIXTURE = value("fixture");
	const LEDGER = resolve(value("ledger") ?? DEFAULT_LEDGER_PATH);
	const DECISION_FILE = value("decision-file");
	const UPSTREAM_REPO = value("repo") ?? "earendil-works/pi";

	if (RECORD && !DECISION_FILE) {
		console.error("BLOCKED: --record cần --decision-file <file.json>");
		process.exit(2);
	}

	const transport = FIXTURE
		? createFixtureTransport(JSON.parse(readFileSync(resolve(FIXTURE), "utf8")))
		: createGhTransport({ repo: UPSTREAM_REPO });

	const [release, main] = await Promise.all([resolveReleaseChannel(transport), resolveMainChannel(transport)]);
	let cursors = {};
	if (existsSync(LEDGER)) {
		cursors = loadLedger(LEDGER).cursors;
	}
	const report = buildReport({ release, main, cursors, upstreamRepo: transport.repo });

	if (!RECORD) {
		if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
		else console.log(renderHuman(report));
		process.exit(report.status === "ok" ? 0 : 3); // 3 = blocked/stale — fail closed, không nuốt
	}

	// --record: chỉ ghi khi hai kênh ok (không ghi quyết định trên dữ liệu stale)
	if (report.status !== "ok") {
		console.error("BLOCKED: kênh release hoặc main BLOCKED — không ghi quyết định trên dữ liệu stale");
		process.exit(3);
	}
	const decision = JSON.parse(readFileSync(resolve(DECISION_FILE), "utf8"));
	decision.base_sha ??= git("rev-parse", "HEAD");
	decision.reviewed_at ??= new Date().toISOString();
	const ledger = existsSync(LEDGER) ? loadLedger(LEDGER) : { schema_version: LEDGER_SCHEMA_VERSION, cursors: {}, decisions: [] };
	const next = recordDecision(ledger, decision);
	mkdirSync(dirname(LEDGER), { recursive: true });
	writeFileSync(LEDGER, JSON.stringify(next, null, 2) + "\n");
	const receiptDir = resolve("docs/maintenance-receipts");
	mkdirSync(receiptDir, { recursive: true });
	const receiptName = `${new Date().toISOString().slice(0, 10)}-upstream-check-${(decision.target_sha ?? decision.base_sha).slice(0, 8)}.md`;
	const receiptPath = join(receiptDir, receiptName);
	writeFileSync(receiptPath, renderReceiptDraft({ report, decision: { ...decision, receipt_ref: `docs/maintenance-receipts/${receiptName}` } }));
	console.log(`ledger → ${LEDGER}`);
	console.log(`receipt draft → ${receiptPath}`);
	console.log("Review + commit tay — script không tự commit.");
}

if (isMain()) await main();
