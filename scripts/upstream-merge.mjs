#!/usr/bin/env node
// upstream-merge.mjs — pipeline chuẩn hóa quy trình upstream cho fork fleet.
// Sinh ra từ SPEC-2026-11-18-li-upstream-v152-pipeline.md (Task 9).
//
// Flow: preflight → fetch upstream thật → resolve target SHA → đo behind + conflict
// surface → auto-group theo matrix 8 nhóm (conflict-matrix.json) → guard overlap
// verdict → in checklist candidate/gates/promote/T20 → receipt template.
//
// --dry-run          : read-only, dùng objects có sẵn, KHÔNG fetch/merge/push.
// --target <sha|tag> : target release (pin full SHA; không dùng "latest").
// --upstream <url>   : URL upstream thật (mặc định earendil-works/pi).
// --guard-files <g>  : glob bổ sung cho nhóm guard (lặp được).
// --custom-files <g> : glob file custom per-fork (lặp được) — dùng để tính conflict surface.
// --out <dir>        : thư mục artifact output (mặc định .agent-workbench/upstream).
//
// Script KHÔNG tự merge/promote — nó chuẩn bị bản đồ + checklist; merge/promote
// vẫn là hành động có review theo runbook docs/li-maintenance.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => !argv.includes(`--${name}`) === false;
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

const DRY = flag("dry-run");
const TARGET = value("target"); // sha hoặc tag; undefined = chỉ đo, không resolve merge
const UPSTREAM_URL = value("upstream") ?? "https://github.com/earendil-works/pi.git";
const UPSTREAM_BRANCH = value("upstream-branch") ?? "main";
const OUT_DIR = resolve(value("out") ?? ".agent-workbench/upstream");
const GUARD_EXTRA = values("guard-files");
const CUSTOM_EXTRA = values("custom-files");

// ─── git helpers ─────────────────────────────────────────────────────────────
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

function die(msg) {
	console.error(`BLOCKED: ${msg}`);
	process.exit(2);
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

function groupOf(file) {
	const f = file.replaceAll("\\", "/");
	const guardAll = [...GUARD_BASE, ...GUARD_EXTRA];
	if (guardAll.some((g) => f === g || f.endsWith(g))) return "guard";
	if (f.startsWith("packages/ai/test/") || f.startsWith("packages/coding-agent/test/li-")) return "tests";
	if (f === "package.json" || f === "package-lock.json" || f.includes("install-lock/") || f.endsWith("/package.json")) return "package-json";
	if (CATALOG_HINTS.some((h) => f.includes(h))) return "provider-catalog";
	if (f.startsWith(".github/") || f === "README.md" || f === ".gitignore" || f.startsWith("docs/")) return "infra";
	if (NEW_PACKAGE_HINTS.some((h) => f.startsWith(h))) return "new-package-or-ai";
	if (TUI_HINTS.some((h) => f.includes(h))) return "tui";
	return "catch-all";
}

// Nhóm matrix → chiến lược resolve (text từ spec Approach — reviewer chỉ confirm)
const GROUP_POLICY = {
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
const ALLOW_UNTRACKED = ["scripts/upstream-merge.mjs", ".agent-workbench/", "docs/specs/"];
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

// 2) Fetch upstream thật (dry-run bỏ qua — dùng objects có sẵn)
step("2. Fetch upstream thật");
const remoteName = "upstream-pipeline";
const haveRemote = Boolean(git("remote", "get-url", remoteName, { allowFail: true }));
if (!haveRemote) git("remote", "add", remoteName, UPSTREAM_URL);
if (DRY) {
	console.log(`[dry-run] bỏ qua fetch — dùng objects sẵn có (FETCH_HEAD/giờ trước).`);
} else {
	git("fetch", remoteName, UPSTREAM_BRANCH, "--tags");
	console.log(`fetched ${UPSTREAM_URL} ${UPSTREAM_BRANCH} (+tags)`);
}
const upstreamRef = DRY ? "FETCH_HEAD" : `${remoteName}/${UPSTREAM_BRANCH}`;
if (!git("rev-parse", "--verify", "--quiet", upstreamRef, { allowFail: true })) {
	die(`không có objects cho ${upstreamRef} — chạy không --dry-run 1 lần để fetch, hoặc fetch tay.`);
}
const upstreamSha = git("rev-parse", upstreamRef);
console.log(`upstream tip = ${upstreamSha}`);

// 3) Resolve target
let targetSha = upstreamSha;
if (TARGET) {
	const ref = TARGET.startsWith("v") && !/^[0-9a-f]{40}$/.test(TARGET) ? `refs/tags/${TARGET}` : TARGET;
	let resolved = git("rev-parse", "--verify", "--quiet", ref, { allowFail: true })
		|| git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`, { allowFail: true });
	if (!resolved && DRY && upstreamSha) {
		resolved = upstreamSha;
		console.log(`[dry-run] tag '${TARGET}' chưa có trong objects — tạm dùng FETCH_HEAD tip làm target approximation; chạy FULL RUN để fetch tags + pin chính xác.`);
	}
	if (!resolved) die(`không resolve được target '${TARGET}' từ objects — fetch trước.`);
	targetSha = resolved;
	console.log(`target ${TARGET} → ${targetSha}`);
} else {
	console.log(`không có --target → dùng upstream tip (chỉ đo).`);
}

// 4) Behind + conflict surface
step("3. Behind + conflict surface");
const mergeBase = git("merge-base", "HEAD", targetSha);
const behindCount = git("rev-list", "--count", `HEAD..${targetSha}`);
const customFiles = git("diff", "--name-only", mergeBase, "HEAD").split("\n").filter(Boolean);
const upstreamFiles = git("diff", "--name-only", mergeBase, targetSha).split("\n").filter(Boolean);
const customSet = new Set(customFiles);
const surface = upstreamFiles.filter((f) => customSet.has(f));
console.log(`merge-base=${mergeBase}`);
console.log(`behind (li/stable → target) = ${behindCount} commits`);
console.log(`custom delta = ${customFiles.length} files | upstream delta = ${upstreamFiles.length} files | conflict surface = ${surface.length} files`);

// 5) Auto-group conflict-matrix.json + guard overlap verdict
step("4. Auto-group matrix (8 nhóm) + guard overlap verdict");
const guardAll = [...GUARD_BASE, ...GUARD_EXTRA];
const upstreamSet = new Set(upstreamFiles);
const matrix = { generated_at: new Date().toISOString(), merge_base: mergeBase, target: targetSha, groups: {}, guard_overlap: [] };
for (const f of surface) {
	const g = groupOf(f);
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

// 6) Checklists (in — không tự chạy; merge/promote có review theo runbook)
step("5. Candidate checklist (T4 — chạy trong worktree li/next, KHÔNG phải ở đây)");
console.log(`
  git worktree add ../<fork>-next <custom-branch>-next   (nếu chưa có)
  git -C ../<fork>-next merge --no-ff ${targetSha}
  Resolve ${surface.length} file theo matrix ở trên (catch-all → escalate owner)
  Verify guard presence: git grep rejectLiSelfUpdate / applyLiRuntimeEnv / LI_UI_LANGUAGE
  Verify entry types: diff session-manager vs backup — không mất allowlist key`);

step("6. Gates checklist (T5)");
console.log(`
  npm ci --ignore-scripts
  node scripts/build-li.mjs --offline
  npm run check        (drift packages/ai nhóm đã biết → PASS có điều kiện; khác → FAIL)
  bash ./test.sh       (residual đúng nhóm runbook)
  test/li-*.test.ts    PASS toàn bộ
  li --version         khớp receipt candidate`);

step("7. Promote + T20 checklist (T6 — thứ tự cứng)");
console.log(`
  1. fast-forward <custom-branch> tới candidate (chỉ khi T5 PASS)
  2. Snapshot profile + VERIFY counts/SHA độc lập
  3. LI_PROFILE_SNAPSHOT_ID=<id> → rebuild (build đọc env LÚC BUILD)
  4. T20: artifactHash mới → canary receipt → t20_receipt_sha256=SHA256(canary) → registry approved_builds
  5. Verify khớp chéo 3 cặp: li --version == receipt == canary == registry
  6. Diff catalog candidate vs backup — Li entries không mất`);

// 7) Receipt template
const receipt = `# Upstream maintenance receipt (draft từ pipeline)

- generated: ${new Date().toISOString()}
- default branch: li/stable @ ${head}
- merge-base: ${mergeBase}
- target: ${targetSha}${TARGET ? ` (${TARGET})` : " (upstream tip)"}
- behind: ${behindCount} commits | custom delta: ${customFiles.length} files | conflict surface: ${surface.length} files
- conflict-matrix.json: ${matrixPath}
- guard overlap: ${matrix.guard_overlap.length} file (xem json)
- rollback SHA (điền sau promote): <li/stable HEAD trước merge>
- backup refs: <li/stable-backup-*> | snapshot id: <pi-snapshot-*> | artifact hash: <post-build>
- verify results: <điền sau gates — từng gate 1 dòng kết quả>
- escalation (catch-all): ${(matrix.groups["catch-all"] ?? []).join(", ") || "(none)"}
`;
const receiptPath = join(OUT_DIR, `receipt-draft-${targetSha.slice(0, 8)}.md`);
writeFileSync(receiptPath, receipt);
console.log(`\nreceipt draft → ${receiptPath}`);
console.log(`\n${DRY ? "[dry-run] KHÔNG fetch/merge/push gì — plan ở trên chỉ để review." : "Fetch đã chạy (objects only — không đụng refs fork)."}`);
console.log("Merge + promote là hành động có review — làm tay theo checklist ở trên.");
