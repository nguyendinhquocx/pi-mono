---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-19-li-dual-channel-upstream-check"
status: "archived"
title: "Kiểm tra upstream Li theo hai kênh và ghi quyết định chọn lọc"
archived_at: "2026-11-19T18:41:51+07:00"
source_file: "SPEC-2026-11-19-li-dual-channel-upstream-check.md"
source_sha256: "2b06b99266ff42026d3f647a44e60f604bc680c71cbdd51888fd11f4cdaea042"
implementation_ref: "7fab55d174818d9f2c7f0597bec004416a592de3"
working_tree: "dirty"
related_paths: ["scripts/upstream-check.mjs", "scripts/upstream-merge.mjs", "docs/upstream-decisions/ledger.json", "scripts/upstream-decisions.schema.json"]
---

# Spec: Kiểm tra upstream Li theo hai kênh và ghi quyết định chọn lọc

## Context Snapshot
- Project/module: Li fork `nguyendinhquocx/pi-mono`, upstream `earendil-works/pi`; repository root is this checkout, branch `li/stable`.
- Stack/runtime: Node.js ESM script trong `scripts/`, Git, GitHub CLI/API; không cần sửa runtime CLI `li`.
- Hiện trạng: `li --version` chỉ báo version/source SHA của artifact đang chạy, không biết upstream có release mới. `scripts/upstream-merge.mjs` hiện mặc định so với `main`, target là SHA/tag tùy chọn, dry-run dùng objects đã có và sinh conflict report/receipt draft; script không query latest stable release và không có ledger riêng cho main snapshot hoặc change bị bỏ qua.
- Evidence lỗi nhãn: official release `v1.5.2` = SHA `b4afdddf44e059c67ccf5097e5317d913521b470` (2026-11-10); Li đã tích hợp SHA `05fd3fbda0bbb9a1c7a76e4bf92ab58ed77c8d94` ngày 2026-11-18, cách release tag 312 commits; upstream main tại lần kiểm tra 2026-11-19 là `5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9`, thêm 20 commits sau target. Li owner chọn giữ target đã test, hoãn 20 commits; erratum ở `docs/maintenance-receipts/2026-11-18-v152-a38d8cc93d.md`.
- Desired behavior: agent kiểm tra được stable release và main riêng; báo rõ chênh lệch, changelog và commit/path; mặc định chỉ lập plan theo release tag, không merge/push/build/T20; owner chọn full release, full main snapshot hoặc một số backport.
- Files liên quan: `scripts/upstream-merge.mjs`; `scripts/conflict-matrix.json`; `docs/li-maintenance.md`; `docs/maintenance-receipts/`; `docs/specs/INDEX.md`.
- Constraints: pin full SHA; không lấy branch mutable làm target artifact; catch-all conflict escalate; không force-push; không sửa T20/production runtime trong status-check; không tuyên bố version release nếu target là main snapshot.

## Objective
- Thêm read-only upstream check hai kênh để agent trả lời “có bản mới không, mới ở release hay main, thay đổi gì đáng xem” mà không nhập nhằng `v1.5.2` tag với commit trên `main`.
- Ghi được ranh giới đã xem/đã tích hợp và quyết định backport/skip để lần sau agent không lặp lại review từ đầu hoặc vô tình bỏ quên thay đổi.

## Scope
- In:
  - Resolver latest stable release/tag + full SHA; resolver upstream main HEAD + full SHA.
  - Báo `last_reviewed_release`, `last_reviewed_main`, `last_integrated_target`; số commit/path giữa cursor và từng kênh; release notes/changelog reference.
  - Target mode tường minh: `release-tag`, `main-snapshot`, `selected-backports`; target snapshot phải full SHA.
  - Decision ledger versioned (project-local) ghi base SHA, channel, target/tag/SHA, included commit/path, skipped commit/path, reason, revisit condition, reviewer, test/receipt reference.
  - `upstream-merge.mjs` validate target/channel và sinh receipt draft khớp mode; script chỉ tạo report/plan, không merge/promote/push/T20.
  - Unit/integration tests dùng fixtures/API stubs để không phụ thuộc mạng thật.
- Out:
  - Tự động merge/cherry-pick/push/build/release/T20 mutation.
  - Tự đặt lịch hoặc gửi notification; chỉ hỗ trợ agent được gọi checker theo lệnh owner.
  - Thay đổi Li runtime version/CLI hoặc tự động bump package version.
  - Áp dụng cho fleet forks khác trong spec này; skill/registry sẽ được cập nhật riêng sau khi spec được duyệt.

## Thuật ngữ
- Release tag = tag phát hành chính thức có release notes; ví dụ `v1.5.2` → một SHA cụ thể.
- Main snapshot = một SHA bất biến được đọc từ upstream branch `main`; không phải release ổn định và có thể chứa code chưa phát hành.
- Last reviewed cursor = SHA cuối cùng đã được xem xét; không đồng nghĩa đã tích hợp.
- Last integrated target = SHA đã có trong merge ancestry hoặc đã được ghi nhận qua backport ledger; không được suy ra version chỉ từ package.json.
- Selected backport = commit/hunk upstream được đưa riêng vào Li mà không merge toàn bộ ancestry tới upstream main.
- Skipped decision = thay đổi đã được xem nhưng owner quyết định chưa lấy; phải có reason + điều kiện xem lại.

## Assumptions
- Mặc định policy là dual-channel review: luôn báo latest stable release và latest main riêng; target mặc định để tạo full-update plan là release tag.
- Owner có thể chọn main snapshot hoặc selected commits sau khi xem report; lựa chọn đó không tự tạo quyền merge/push.
- Git merge full snapshot giữ upstream ancestry nên lần sau merge-base tự tiến qua target đã merge; cherry-pick/partial backport không tiến merge-base, do đó phải dùng ledger/cursor riêng.
- API/GitHub có thể không truy cập được; checker phải fail closed hoặc báo dữ liệu stale, không dùng cache cũ như latest.

## Open Questions
- Nếu upstream không có GitHub Release mới nhưng tag stable xuất hiện, có coi tag đó là candidate không? Mặc định: có báo riêng là tag chưa có GitHub Release; không tự chọn.
- `selected-backports` muốn hỗ trợ danh sách commit SHA ngay trong script hay chỉ ghi decision ledger và để parent cherry-pick thủ công? Đề xuất v1: ghi plan/list, thao tác backport vẫn thủ công có review.
- Cursor/ledger canonical đặt ở `docs/maintenance-receipts/` hay `docs/upstream-decisions/`? Đề xuất `docs/maintenance-receipts/<date>-<target>.md` là receipt cho mỗi lần review, thêm `docs/upstream-decisions/ledger.json` làm index machine-readable.

## Approach
- Chọn: tách `upstream-check` read-only khỏi pipeline candidate. Checker lấy release/tag và main SHA cùng lúc, so với cursor; pipeline `upstream-merge.mjs` nhận channel/target đã owner chọn và giữ nguyên contract không tự merge/promote.
- Lý do: `main` trôi nhanh; dùng nó làm “version mới nhất” đã kéo 312 commits sau v1.5.2 tag trong lần trước. Stable release là mặc định ít bất ngờ; main vẫn được soi để phát hiện fix quan trọng sớm.
- Nếu owner chọn full release/main: merge target full SHA và ghi ancestry cursor. Nếu owner chọn một số commit: không giả vờ đã tích hợp upstream đến SHA đó; ghi `last_reviewed_main` riêng, liệt kê selected/skipped và revisit rule.
- Không bật schedule/notification/auto-push. Mỗi status run không mutate Git refs hoặc profile/T20.

## Task List

### T1: Thiết kế schema + resolver read-only
- Acceptance:
  - Có schema versioned cho ledger với release/main/integrated cursors, included/skipped decision, reason/revisit, provenance refs.
  - Resolver trả stable tag/release SHA và main SHA riêng; API lỗi/throttled trả BLOCKED/stale, không tự đoán.
  - CLI output luôn phân biệt release version và main snapshot; không gắn `vX.Y.Z` cho main SHA.
- Reproduce: `node scripts/upstream-check.mjs --repo <fixture> --json` (fixture transport, no network).
- Verify: tests cho release tag, main tip, rate-limit/API failure, same-cursor no-op và tag không có GitHub Release.
- Files: `scripts/upstream-check.mjs` (reference `scripts/upstream-merge.mjs` git wrappers); `scripts/upstream-check.test.mjs` (test convention hiện có trong `scripts/*.test.mjs`); `scripts/upstream-decisions.schema.json`.

### T2: Bổ sung channel/cursor contract cho merge pipeline
- Acceptance:
  - `upstream-merge.mjs` bắt target full SHA/tag và channel rõ khi chạy real plan; report current main/release cursors separately.
  - `--dry-run` không fetch/merge/push và ghi report vào đúng output; nếu tag thiếu local objects thì nói cần fetch, không âm thầm thay bằng main tip.
  - Conflict matrix/catch-all/guard overlap hiện hữu giữ nguyên.
- Reproduce: `node scripts/upstream-merge.mjs --dry-run --target <full-sha> --channel main-snapshot --out <temp-dir>`.
- Verify: dry-run fixture không đổi HEAD/index/refs; wrong tag/channel bị block; full SHA trong receipt đúng input.
- Files: `scripts/upstream-merge.mjs` (reference code tại `--target`, `DRY`, `upstreamSha`); `scripts/upstream-merge.test.mjs`.

### T3: Decision ledger + runbook và agent routing
- Acceptance:
  - Mỗi lần review có receipt ghi base/target/channel/cursor, included/skipped item + reason/revisit, checks đã chạy và owner decision.
  - Full merge, selected backport và “reviewed but skipped” là ba state khác nhau; skipped không bị hiểu là integrated.
  - `docs/li-maintenance.md`, `REGISTRY.md` pointer và skill `upstream-maintenance` mô tả dual-channel; không tự sửa skill nếu chưa qua review spec.
- Reproduce: chạy fixture review → đọc lại receipt/ledger; spec-check sau archive.
- Verify: validate schema + test round-trip; `--spec-check` PASS; không secret/absolute machine paths trong ledger.
- Files: `docs/li-maintenance.md`; `docs/maintenance-receipts/`; `docs/upstream-decisions/ledger.json`; external pointer `knowledge/upstream-forks/REGISTRY.md`; skill `upstream-maintenance/SKILL.md` (chỉ sửa sau gate).

## Checkpoints
- T1 PASS: resolver/ledger tests.
- T2 PASS: dry-run no-mutation verified, release/main channel differ explicitly.
- T3 PASS: receipt + runbook + skill routing verified.
- Không có runtime build/T20/UAT gate vì spec không sửa runtime.

## External Review Brief
### Reviewer cần phán
- Có lẫn stable release SHA với main snapshot ở bất kỳ path/output nào không?
- Cursor semantics có ngăn lặp lại/nuốt mất skipped changes khi full merge và cherry-pick không?
- Read-only checker có side effect ẩn (fetch/update refs/write ngoài output dir) không?
- Acceptance tests có phát hiện version-label nhầm như 05fd vs v1.5.2 không?

### Reviewer nên đọc trước
- `scripts/upstream-merge.mjs`; `docs/li-maintenance.md`; erratum trong `docs/maintenance-receipts/2026-11-18-v152-a38d8cc93d.md`.

### Reviewer không cần phán
- Li runtime/UI behavior, ProDesk launcher, T20 implementation.

## User Test
- Không có user test tương tác. Owner review report fixture: release tag và main SHA hiện thành hai lựa chọn rõ; chọn backport chỉ tạo plan/ledger, không tự thay source branch.

## Completion Gates
- Review spec được owner duyệt trước implementation. ✓ owner duyệt 2026-11-19 ("duyệt")
- Sau implement: test resolver + ledger + dry-run non-mutation; verify release/main provenance labels; cập nhật working spec; chỉ archive khi verification pass.

## Implementation Record (2026-11-19)

- T1 PASS: `scripts/upstream-check.mjs` (GH transport + fixture transport, fail-closed exit 3, ancestor guard chặn đề xuất release đã nằm trong integrated — erratum guard), `scripts/upstream-check.test.mjs` 21/21 PASS, `scripts/upstream-decisions.schema.json` + validator thủ công.
- T2 PASS: `upstream-merge.mjs` `--channel` bắt buộc khi có `--target`; main-snapshot full SHA 40; dry-run KHÔNG thêm remote, KHÔNG thay tag thiếu objects bằng main tip (dry-run thật: HEAD/refs/config same YES); selected-backports không merge ancestry; `scripts/upstream-merge.test.mjs` 9/9 PASS. Real dry-run: main-snapshot 5a14e69c → behind=20 khớp ledger; release-tag v1.5.2 → behind=0 khớp erratum.
- T3 PASS: `docs/upstream-decisions/ledger.json` seed (05fd integrated main-snapshot, +20 reviewed_skipped có revisit_condition); `docs/li-maintenance.md` bước 0 dual-channel; skill `upstream-maintenance` cập nhật contract; REGISTRY pointer; receipt template qua `--record`.
- Fix phát hiện khi verify: target_commitish release là branch name → resolve qua commits API; gitFn contract gọi `git rev-parse` đúng cách; tags local bị mất sau gitdir inversion 2026-11-19 → fetch --tags khôi phục (không phải bug script; block dry-run đúng thiết kế).
- Commits: `bb5afb2f67` (feature), `7fab55d174` (gitFn fix).
