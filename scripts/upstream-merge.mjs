#!/usr/bin/env node
// upstream-merge.mjs — pipeline chuẩn hóa quy trình upstream cho fork fleet.
// Sinh ra từ SPEC-2026-11-18-li-upstream-v152-pipeline.md (Task 9); mở rộng
// channel/cursor contract theo SPEC-2026-11-19-li-dual-channel-upstream-check.md (T2).
//
// Flow: preflight → fetch upstream thật → resolve target theo channel → đo behind +
// conflict surface → auto-group theo matrix 8 nhóm (conflict-matrix.json) → guard
// overlap verdict → in checklist candidate/gates/promote/T20 → receipt template.
//
// --dry-run            : read-only, dùng objects có sẵn, KHÔNG fetch/merge/push/add remote.
// --target <sha|tag>   : target release (pin full SHA; không dùng "latest").
// --channel <c>        : BẮT BUỘC khi có --target. Một trong:
//                        release-tag       — target phải là tag phát hành (hoặc SHA map về tag)
//                        main-snapshot     — target phải là full SHA 40 (không nhận tag)
//                        selected-backports— không merge ancestry; cherry-pick list --backports
// --backports <sha,..> : dùng với --channel selected-backports; mỗi item phải full SHA.
// --upstream <url>     : URL upstream thật (mặc định earendil-works/pi).
// --guard-files <g>    : glob bổ sung cho nhóm guard (lặp được).
// --custom-files <g>   : glob file custom per-fork (lặp được) — dùng để tính conflict surface.
// --out <dir>          : thư mục artifact output (mặc định .agent-workbench/upstream).
//
// Script KHÔNG tự merge/promote — nó chuẩn bị bản đồ + checklist; merge/promote
// vẫn là hành động có review theo runbook docs/li-maintenance.md.
// Nhãn provenance: tag vX.Y.Z CHỈ cho release-tag channel; main snapshot luôn in full SHA.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LEDGER_PATH, CHANNELS, loadLedger } from "./upstream-check.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

// ─── pure helpers (export cho tests) ─────────────────────────────────────────

export function parseMergeArgs(argv) {
	const flag = (name) => argv.includes(`--${name}`);
	const value = (name) => {
		const i = argv.indexOf(`--${name}`);
		return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
	};
	const values = (name) => {
		const out = [];
		let i = 0;
		while ((i = argv.indexOf(`--${name}`, i)) !== -1) {
			const v = argv[i + 1];
			if (v && !v.startsWith("--")) out.push(v);
			i += 1;
		}
		return out;
	};
	return {
		dry: flag("dry-run"),
		target: value("target"),
		channel: value("channel"),
		backports: values("backports"),
		upstreamUrl: value("upstream") ?? "https://github.com/earendil-works/pi.git",
		upstreamBranch: value("upstream-branch") ?? "main",
		out: value("out"),
		guardExtra: values("guard-files"),
		customExtra: values("custom-files"),
	};
}

export function validateBackports(backports) {
	if (backports.length === 0) return ["--channel selected-backports cần --backports <full-sha,full-sha,...>"];
	const bad = backports.filter((b) => !FULL_SHA.test(b));
	if (bad.length > 0) return [`--backports phải là full SHA 40 ký tự, sai: ${bad.join(", ")}`];
	return [];
}

// Resolve target theo channel. gitFn(root, ...args) → string, throw khi git fail.
// Quy tắc (spec T2): tag thiếu local objects → BLOCKED "cần fetch", KHÔNG fallback tip.
export function resolveTargetSha({ gitFn, target, channel, upstreamSha, dry }) {
	if (!CHANNELS.includes(channel)) {
		throw new Error(`--channel bắt buộc khi có --target, một trong: ${CHANNELS.join(" | ")}`);
	}
	if (channel === "selected-backports") {
		throw new Error("channel selected-backports không dùng --target làm merge target — dùng --backports");
	}
	if (channel === "main-snapshot" && !FULL_SHA.test(target)) {
		throw new Error(`channel main-snapshot yêu cầu full SHA 40 ký tự cho --target, nhận '${target}' (tag/short SHA không chấp nhận cho snapshot).`);
	}
	const looksLikeTag = target.startsWith("v") && !FULL_SHA.test(target);
	const ref = looksLikeTag ? `refs/tags/${target}` : target;
	let resolved = gitFn("rev-parse", "--verify", "--quiet", ref, { allowFail: true })
		|| gitFn("rev-parse", "--verify", "--quiet", `${ref}^{commit}`, { allowFail: true });
	if (!resolved) {
		throw new Error(
			dry
				? `target '${target}' chưa có trong local objects — chạy FULL RUN (không --dry-run) để fetch tags, hoặc fetch tay trước. KHÔNG thay bằng main tip.`
				: `không resolve được target '${target}' sau khi fetch — kiểm tra tag/SHA.`,
		);
	}
	const sha = resolved;
	if (channel === "release-tag") {
		const describe = gitFn("describe", "--tags", "--exact-match", sha, { allowFail: true });
		if (!describe || !describe.startsWith("v")) {
			throw new Error(`channel release-tag nhưng '${target}' không map về tag phát hành (describe: ${describe || "none"}) — dùng --channel main-snapshot nếu đúng là snapshot.`);
		}
		return { sha, tag: describe };
	}
	// main-snapshot: đã validate full SHA ở trên
	return { sha, tag: null };
}

// Dry-run KHÔNG được mutate .git/config — chỉ báo có sẵn remote hay không.
export function ensureUpstreamRemote({ gitFn, dry, remoteName, url }) {
	const have = Boolean(gitFn("remote", "get-url", remoteName, { allowFail: true }));
	if (have) return { added: false, existed: true };
	if (dry) return { added: false, existed: false, note: "[dry-run] bỏ qua remote add — FULL RUN sẽ thêm" };
	gitFn("remote", "add", remoteName, url);
	return { added: true, existed: false };
}

export function renderMergeReceipt(fields) {
	return `# Upstream maintenance receipt (draft từ pipeline)

- generated: ${fields.generatedAt}
- default branch: li/stable @ ${fields.head}
- channel: ${fields.channel}
- merge-base: ${fields.mergeBase}
- target: ${fields.targetSha}${fields.tag ? ` (tag ${fields.tag})` : " (main snapshot — KHÔNG gắn nhãn vX.Y.Z)"}
- backports: ${fields.backports.length > 0 ? fields.backports.join(", ") : "(n/a)"}
- behind: ${fields.behindCount} commits | custom delta: ${fields.customFiles} files | conflict surface: ${fields.surface} files
- cursors lúc plan: last_integrated_target=${fields.cursors.last_integrated_target?.sha ?? "(chưa ghi)"} | last_reviewed_release=${fields.cursors.last_reviewed_release?.sha ?? "(chưa ghi)"} | last_reviewed_main=${fields.cursors.last_reviewed_main?.sha ?? "(chưa ghi)"}
- conflict-matrix.json: ${fields.matrixPath}
- guard overlap: ${fields.guardOverlap} file (xem json)
- rollback SHA (điền sau promote): <li/stable HEAD trước merge>
- backup refs: <li/stable-backup-*> | snapshot id: <pi-snapshot-*> | artifact hash: <post-build>
- verify results: <điền sau gates — từng gate 1 dòng kết quả>
- escalation (catch-all): ${fields.escalation || "(none)"}
`;
}

// ─── matrix 8 nhóm (spec v4 Approach) — thứ tự match: cụ thể trước, catch-all cuối ──
const GUARD_BASE = [
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/package-manager-cli.ts",
	"packages/coding-agent/src/utils/shell.ts",
	"packages/coding-agent/src/core/shell.ts",
	"packages/coding-agent/src/core/session-manager.ts",
	"packages/coding-agent/src/config.ts",
	"packages/coding-agent/src/core/extensions/loader.ts",
	"packages/coding-agent/src/core/extensions/virtual-modules.ts",
	"packages/coding-agent/src/migrations.ts",
];
const TUI_HINTS = [
	"/markdown", "tool-execution", "user-message", "session-selector", "tree-selector",
	"editor", "tui/", "components/", "interactive/",
];
const CATALOG_HINTS = ["packages/ai/catalog", "generate-models", "models.json", "providers/data/"];
const NEW_PACKAGE_HINTS = ["packages/schema/", "packages/mcp/", "packages/agent/", "packages/ai/"];

export function groupOf(file, guardExtra = []) {
	const f = file.replaceAll("\\", "/");
	const guardAll = [...GUARD_BASE, ...guardExtra];
	if (guardAll.some((g) => f === g || f.endsWith(g))) return "guard";
	if (f.startsWith("packages/ai/test/") || f.startsWith("packages/coding-agent/test/li-")) return "tests";
	if (f === "package.json" || f === "package-lock.json" || f.includes("install-lock/") || f.endsWith("/package.json")) return "package-json";
	if (CATALOG_HINTS.some((h) => f.includes(h))) return "provider-catalog";
	if (f.startsWith(".github/") || f === "README.md" || f === ".gitignore" || f.startsWith("docs/")) return "infra";
	if (NEW_PACKAGE_HINTS.some((h) => f.startsWith(h))) return "new-package-or-ai";
	if (TUI_HINTS.some((h) => f.includes(h))) return "tui";
	return "catch-all";
}

export const GROUP_POLICY = {
	guard: "Giữ guard Li + lấy fix/feature upstream quanh guard; migrations.ts: upstream fix cùng bug → DROP Li patch",
	tui: "Giữ Li style + lấy fix logic upstream; hunk đè nhau → tách hunk, verify Li tests + test.sh TUI",
	infra: "Theo upstream; workflow sync-upstream.yml giữ nguyên bản Li",
	tests: "Theo upstream + giữ Li assertions platform-aware; test/li-*.test.ts bất khả xâm phạm",
	"package-json": "Hòa — giữ piConfig/bin Li + workspaces glob, nhận deps mới upstream; T5 phải regen install-lock",
	"provider-catalog": "Giữ hide/add riêng Li (4ac7c9f58) + nhận structure models.dev v2; verify diff catalog vs backup",
	"new-package-or-ai": "Upstream wins toàn bộ nội dung; verify wiring: npm ci resolve pi-schema, install-lock có entry, bundle có chunk, li --version chạy",
	"catch-all": "KHÔNG resolve đoán — list vào receipt + escalate owner",
};

// ─── main ────────────────────────────────────────────────────────────────────
function isMain() {
	try {
		return import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;
	} catch {
		return true;
	}
}

function die(msg) {
	console.error(`BLOCKED: ${msg}`);
	process.exit(2);
}

async function main() {
	const cfg = parseMergeArgs(process.argv.slice(2));
	const DRY = cfg.dry;
	const OUT_DIR = resolve(cfg.out ?? ".agent-workbench/upstream");

	// git wrapper dùng chung — cho phép opts cuối (allowFail)
	const REPO = process.cwd();
	function git(...call) {
		let opts = {};
		if (call.length > 0 && typeof call[call.length - 1] === "object" && !Array.isArray(call[call.length - 1])) {
			opts = call.pop();
		}
		try {
			return execFileSync("git", call, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
		} catch (err) {
			if (opts.allowFail) return "";
			throw err;
		}
	}
	const gitFn = (...call) => git(...call);

	const plan = [];
	const step = (name, detail) => {
		plan.push({ step: name, detail });
		console.log(`\n== ${name} ==`);
		if (detail) console.log(detail);
	};

	// 1) Preflight
	step("1. Preflight");
	const branch = git("branch", "--show-current");
	if (branch !== "li/stable") die(`branch hiện tại '${branch}' ≠ li/stable — chạy ở worktree chính.`);
	// Dirty policy: block mọi tracked-modified; untracked chỉ chấp nhận nếu thuộc allowlist
	// (artifact/tài liệu pipeline — không ảnh hưởng merge). Untracked khác → block.
	const ALLOW_UNTRACKED = ["scripts/upstream-merge.mjs", "scripts/upstream-check.mjs", ".agent-workbench/", "docs/specs/", "docs/upstream-decisions/"];
	const dirtyLines = git("status", "--porcelain").split("\n").filter(Boolean);
	const blocking = dirtyLines.filter((l) => {
		if (!l.startsWith("??")) return true; // modified/staged tracked file → block
		const f = l.slice(3);
		return !ALLOW_UNTRACKED.some((a) => f === a || f.startsWith(a));
	});
	if (blocking.length > 0) {
		die(`working tree dirty (${blocking.length} file, vd ${blocking[0]}) — đóng WIP theo Task 0 trước (quy tắc: cấm merge trên dirty tree).`);
	}
	const head = git("rev-parse", "HEAD");
	console.log(`branch=li/stable HEAD=${head} tree=clean`);

	// 2) Resolve target/backports theo channel — TRƯỚC fetch để fail nhanh khi thiếu input
	step("2. Channel + target contract");
	if (cfg.target && !cfg.channel) die("--target cần --channel <release-tag|main-snapshot|selected-backports> — không đoán channel.");
	if (!cfg.target && !cfg.channel && cfg.backports.length === 0) {
		console.log("không có --target/--channel → đo upstream tip (chỉ đo, không resolve merge).");
	}
	let backportList = [];
	if (cfg.channel === "selected-backports" || cfg.backports.length > 0) {
		const errs = validateBackports(cfg.backports);
		if (errs.length > 0) die(errs.join("; "));
		backportList = cfg.backports;
		if (cfg.target) die("channel selected-backports không nhận --target — chỉ --backports.");
		console.log(`backports = ${backportList.length} commit (cherry-pick riêng — KHÔNG tiến merge-base, ghi ledger riêng)`);
	}

	// 3) Fetch upstream thật (dry-run bỏ qua — KHÔNG thêm remote trong dry-run)
	step("3. Fetch upstream thật");
	const remoteName = "upstream-pipeline";
	const remoteState = ensureUpstreamRemote({ gitFn, dry: DRY, remoteName, url: cfg.upstreamUrl });
	if (remoteState.note) console.log(remoteState.note);
	if (DRY) {
		console.log(`[dry-run] bỏ qua fetch — dùng objects sẵn có (FETCH_HEAD/giờ trước).`);
	} else {
		git("fetch", remoteName, cfg.upstreamBranch, "--tags");
		console.log(`fetched ${cfg.upstreamUrl} ${cfg.upstreamBranch} (+tags)`);
	}
	const upstreamRef = DRY ? "FETCH_HEAD" : `${remoteName}/${cfg.upstreamBranch}`;
	if (!git("rev-parse", "--verify", "--quiet", upstreamRef, { allowFail: true })) {
		die(`không có objects cho ${upstreamRef} — chạy không --dry-run 1 lần để fetch, hoặc fetch tay.`);
	}
	const upstreamSha = git("rev-parse", upstreamRef);
	console.log(`upstream tip = ${upstreamSha}`);

	// 4) Resolve target theo channel (bắt buộc rõ ràng, không fallback âm thầm)
	let targetSha = upstreamSha;
	let targetTag = null;
	if (cfg.target) {
		try {
			const r = resolveTargetSha({ gitFn, target: cfg.target, channel: cfg.channel, upstreamSha, dry: DRY });
			targetSha = r.sha;
			targetTag = r.tag;
			console.log(`channel=${cfg.channel} target ${cfg.target} → ${targetSha}${targetTag ? ` (tag ${targetTag})` : " (main snapshot)"}`);
		} catch (err) {
			die(err.message);
		}
	}

	// 5) Behind + conflict surface
	step("4. Behind + conflict surface");
	const mergeBase = git("merge-base", "HEAD", targetSha);
	const behindCount = git("rev-list", "--count", `HEAD..${targetSha}`);
	const customFiles = git("diff", "--name-only", mergeBase, "HEAD").split("\n").filter(Boolean);
	const upstreamFiles = git("diff", "--name-only", mergeBase, targetSha).split("\n").filter(Boolean);
	const customSet = new Set(customFiles);
	const surface = upstreamFiles.filter((f) => customSet.has(f));
	console.log(`merge-base=${mergeBase}`);
	console.log(`behind (li/stable → target) = ${behindCount} commits`);
	console.log(`custom delta = ${customFiles.length} files | upstream delta = ${upstreamFiles.length} files | conflict surface = ${surface.length} files`);

	// 6) Auto-group conflict-matrix.json + guard overlap verdict
	step("5. Auto-group matrix (8 nhóm) + guard overlap verdict");
	const guardAll = [...GUARD_BASE, ...cfg.guardExtra];
	const upstreamSet = new Set(upstreamFiles);
	const matrix = { generated_at: new Date().toISOString(), merge_base: mergeBase, channel: cfg.channel ?? "(none — đo tip)", target: targetSha, groups: {}, guard_overlap: [] };
	for (const f of surface) {
		const g = groupOf(f, cfg.guardExtra);
		(matrix.groups[g] ??= []).push(f);
	}
	for (const g of guardAll) {
		if (!upstreamSet.has(g)) continue;
		const status = customSet.has(g) ? "CONFLICT (cả 2 bên sửa — resolve theo matrix)" : "upstream-only (upstream sửa vùng guard Li nhưng Li chưa sửa file này — soi guard có bị vòng qua)";
		matrix.guard_overlap.push({ file: g, status });
	}
	for (const [g, files] of Object.entries(matrix.groups)) {
		console.log(`  ${g.padEnd(20)} ${String(files.length).padStart(3)} file  → ${GROUP_POLICY[g]}`);
		if (g === "catch-all") for (const f of files) console.log(`      !! escalate: ${f}`);
	}
	for (const ov of matrix.guard_overlap) console.log(`  guard-overlap: ${ov.file} — ${ov.status}`);

	mkdirSync(OUT_DIR, { recursive: true });
	const matrixPath = join(OUT_DIR, "conflict-matrix.json");
	writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + "\n");
	console.log(`\nconflict-matrix.json → ${matrixPath}`);

	// 7) Cursors từ ledger (read-only — plan tham chiếu, không tự ghi)
	const ledgerPath = resolve(DEFAULT_LEDGER_PATH);
	let cursors = {};
	if (existsSync(ledgerPath)) {
		try {
			cursors = loadLedger(ledgerPath).cursors;
		} catch (err) {
			die(`ledger tại ${ledgerPath} hỏng: ${err.message}`);
		}
	}
	console.log(`\ncursors: last_integrated_target=${cursors.last_integrated_target?.sha ?? "(chưa ghi)"} | last_reviewed_release=${cursors.last_reviewed_release?.sha ?? "(chưa ghi)"} | last_reviewed_main=${cursors.last_reviewed_main?.sha ?? "(chưa ghi)"}`);
	if (cfg.channel === "main-snapshot") console.log(`LƯU Ý: target là main snapshot — receipt/plan KHÔNG được tuyên bố version vX.Y.Z; nếu owner chọn selected-backports thì ghi decision vào ledger thay vì merge full.`);
	if (cfg.channel === "selected-backports") console.log(`LƯU Ý: cherry-pick không tiến merge-base — sau backport phải ghi ledger (status backported) + revisit_condition cho phần còn lại.`);

	// 8) Checklists (in — không tự chạy; merge/promote có review theo runbook)
	step("6. Candidate checklist (T4 — chạy trong worktree li/next, KHÔNG phải ở đây)");
	console.log(`
  git worktree add ../<fork>-next <custom-branch>-next   (nếu chưa có)
  git -C ../<fork>-next merge --no-ff ${targetSha}${cfg.channel === "selected-backports" ? `\n  (backports: cherry-pick từng commit ${backportList.join(" ") || "<sha>"} — KHÔNG merge ancestry)` : ""}
  Resolve ${surface.length} file theo matrix ở trên (catch-all → escalate owner)
  Verify guard presence: git grep rejectLiSelfUpdate / applyLiRuntimeEnv / LI_UI_LANGUAGE
  Verify entry types: diff session-manager vs backup — không mất allowlist key`);

	step("7. Gates checklist (T5)");
	console.log(`
  npm ci --ignore-scripts
  node scripts/build-li.mjs --offline
  npm run check        (drift packages/ai nhóm đã biết → PASS có điều kiện; khác → FAIL)
  bash ./test.sh       (residual đúng nhóm runbook)
  test/li-*.test.ts    PASS toàn bộ
  li --version         khớp receipt candidate`);

	step("8. Promote + T20 checklist (T6 — thứ tự cứng)");
	console.log(`
  1. fast-forward <custom-branch> tới candidate (chỉ khi T5 PASS)
  2. Snapshot profile + VERIFY counts/SHA độc lập
  3. LI_PROFILE_SNAPSHOT_ID=<id> → rebuild (build đọc env LÚC BUILD)
  4. T20: artifactHash mới → canary receipt → t20_receipt_sha256=SHA256(canary) → registry approved_builds
  5. Verify khớp chéo 3 cặp: li --version == receipt == canary == registry
  6. Diff catalog candidate vs backup — Li entries không mất`);

	// 9) Receipt template
	const receipt = renderMergeReceipt({
		generatedAt: new Date().toISOString(),
		head,
		channel: cfg.channel ?? "(none — đo tip)",
		mergeBase,
		targetSha,
		tag: targetTag,
		backports: backportList,
		behindCount,
		customFiles: customFiles.length,
		surface: surface.length,
		cursors,
		matrixPath,
		guardOverlap: matrix.guard_overlap.length,
		escalation: (matrix.groups["catch-all"] ?? []).join(", "),
	});
	const receiptPath = join(OUT_DIR, `receipt-draft-${targetSha.slice(0, 8)}.md`);
	writeFileSync(receiptPath, receipt);
	console.log(`\nreceipt draft → ${receiptPath}`);
	console.log(`\n${DRY ? "[dry-run] KHÔNG fetch/merge/push gì — plan ở trên chỉ để review." : "Fetch đã chạy (objects only — không đụng refs fork)."}`);
	console.log("Merge + promote là hành động có review — làm tay theo checklist ở trên.");
}

if (isMain()) await main();
