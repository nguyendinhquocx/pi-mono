# SPEC-2026-11-27-li-perf — Li performance: systematize measurement + fix

Status: DRAFT v2 — patched after 3-model review (GLM c0767201 / Luna cbd8ce35 / Gemini 0e741557, all NEEDS REVISION → findings integrated; blocker-verify by GLM before implement).

## Context Snapshot

- Đo được 2026-11-27 (3 lane độc lập khớp chéo: source GLM + PI_TIMING trực tiếp + isolation DeepSeek):
  - Warm startup full config: **6606ms** (`createAgentSessionRuntime` 6580ms); profile rỗng **221-298ms** → config weight ~6.4s.
  - `pi-antigravity`: **4898-5610ms** (66-85% config weight) — index.ts static-import cả graph 80 file TS + `@earendil-works/pi-ai/compat`, mọi file qua jiti 2.7.0/Babel, load TUẦN TỰ (`core/extensions/loader.ts:719-733`, instance jiti mới/ext, `moduleCache:false` `loader.ts:604-606`).
  - Cold boot **~13.1s** vs warm 5.7-8s — Defender scan từng file lần đầu.
  - Skills scan thực tế +30-50ms (118 SKILL.md trong 110 dir — 8 file nested `hyperframes/domain/*`); MCP declared +15-20ms — KHÔNG phải nghi phạm.
  - `import-repro.ts` trong `.pi/extensions` (repo) ăn 118ms/boot — file rác.
  - Per-spawn tax Windows: `li --version` 183ms vs ProDesk 30ms (Defender + cmd shim).
  - `~/.pi/agent/subagent-tab` = 8.5GB artifact (không ảnh hưởng startup, rủi ro disk).
- Review note (GLM): extension cache dùng chung giữa pre-trust pass và final pass → module import chỉ chạy 1 lần/lượt warm; T2 chỉ cần tối ưu pass đầu.
- Owner chốt 2026-11-27: làm HỆ THỐNG, spec trước → review 3 model 1 vòng → implement.
- Authority: owner duyệt trực tiếp cho lane này (pi-mono-li `packages/**`).

## Objective

Startup Li warm từ 6.6s → **≤ 2.5s** (cold ≤ 8s theo protocol T8), và mọi lần đo/tối ưu sau này agent tự làm được bằng protocol chuẩn + instrumentation native.

## Scope

IN:
1. Core instrumentation: timing resource-phase + per-import wall-clock (T1).
2. Song song hoá extension module import, 2-phase, giữ precedence (T2).
3. Cache skill catalog theo per-entry revision signature (T3).
4. Bỏ `import-repro.ts` (T4).
5. Perf runbook + skill `li-perf` (T5).
6. Dispatch pi-antigravity lazy-load sang session `antigravity` (T6 — chỉ SDK-heavy, registration giữ sync).
7. Ops: dry-run cleanup 8.5GB subagent-tab (T7).
8. Ops: Defender exclusion pack + protocol đo cold (T8).

OUT:
- Không sửa `D:\AGENTS.md`.
- Không đổi MCP config/exposure; không đụng llama.cpp builtin.
- Không bật `moduleCache: true` hay đổi fsCache mặc định của jiti ngoài trường hợp F3 (nếu thấy artifact cache do parallel — set `fsCache:false` cho parallel path).
- Không implement lazy-load antigravity tại session này.
- Không tắt Defender/exclusion tự động (owner chạy tay).

## Tasks & Acceptance

### T1 — Instrumentation (core) — LÀM TRƯỚC, mở khoá mọi phép đo
- Mở rộng `TimingLabel` union thêm `"resources"` (`timings.ts:12` hiện chỉ `"main" | "extensions"`), khởi tạo/reset `resetTimings("resources")` trong `reload()`.
- Bọc `time(..., "resources")` cho: skills scan, prompts scan, themes, AGENTS.md chain, packageManager resolve trong `resource-loader.ts`.
- Thêm **per-import wall-clock**: đo `t0` cục bộ quanh từng `await jiti.import(...)` (loader.ts:673 hiện dùng delta `lastTime` theo thứ tự resolve — SAI khi parallel). Ghi ms riêng từng promise, sắp theo path; dùng cho T2/T6 acceptance + budget extension mới.
- Timing của `/new`/`/resume`/`/reload` sau start: PI_TIMING in trước `interactiveMode.run()` (`main.ts:1126-1146`) nên không hiện — thêm capture riêng (log line hoặc test hook).
- Acceptance:
  - `PI_TIMING=1 li -p "ok"` in section resources + per-import wall-clock từng extension.
  - Snapshot cơ học: serialize `LoadExtensionsResult` (paths + errors + số tool/command mỗi ext) ra JSON; diff trước/sau refactor = không khác (trừ thời gian). Dùng test extensions-runner/discovery hiện có làm gate phụ.
- Verify: `PI_TIMING=1 li -p "ok"` ×3; `vitest` target resource-loader + timings.

### T2 — Parallel extension import (core), sau T1
- Tách 2 phase trong `loadExtensionsInternal` (`loader.ts:704-750`):
  - Phase 1: import song song, concurrency cap **8**, mỗi promise có wall-clock riêng (T1).
  - Phase 2: factory + commit TUẦN TỰ theo thứ tự path (precedence + `detectExtensionConflicts` giữ nguyên, `resource-loader.ts:761-772`).
- Error mapping (GLM F1): lỗi import ánh xạ đúng path; ext fail import bị skip khỏi phase 2; `LoadExtensionsResult` tương đương tuần tự (paths/errors/tool counts — diff bằng snapshot T1).
- Escape hatch (GLM F2 + Gemini): env `LI_EXT_IMPORT_SEQUENTIAL=1` tắt parallel để debug.
- Side-effect assumption (Luna #1): ghi rõ trong runbook — top-level side effect giữa extensions mất determinism khi parallel; registration chính nằm ở factory (vẫn tuần tự) nên an toàn; sweep concurrency **1/2/4/8** (warm+cold) đo thật để chọn mức, không giữ 8 mù quáng.
- jiti fsCache (GLM F3): implement kiểm chứng không sinh artifact cache race; nếu có → `fsCache:false` cho parallel path.
- `Promise.allSettled` ≠ timeout (Luna #5): test case import-fail → các path khác vẫn load, factory chạy sau import xong đúng thứ tự.
- Acceptance:
  - Warm **ext TOTAL excluding antigravity** giảm ≥25% so baseline đo lại tại thời điểm T2 (chưa lazy); HOẶC nếu không đạt: báo import-bound vs factory-bound breakdown từ T1 kèm nguyên nhân để owner re-chốt (GLM F4 — transform Babel là CPU sync, parallel chỉ overlap I/O).
  - Snapshot tools/commands bằng baseline; test precedence + import-fail PASS.
  - LI_EXT_IMPORT_SEQUENTIAL=1 chạy đúng như tuần tự.

### T3 — Skill catalog cache (core)
- Memoize **tầng top-level theo `(dirPath, source)`** (GLM F5 BLOCKER — key thiếu `source` sẽ trả sai `sourceInfo`/ignore khi cùng dir được load với ngữ nghĩa khác).
- Signature: danh sách **per-entry revision đã sort** (`getFileRevision`, `utils/paths.ts:83`) phủ mọi entry: file + dir + ignore files (`.gitignore`/`.ignore`/`.fdignore`), walk follow symlink như hiện tại (GLM F6 + Luna #2).
- Footprint: map có evict cap (LRU ~32 entries).
- Test bổ sung: rename skill dir, sửa `.gitignore`, xoá file, cùng dir với `source` khác (GLM F6/Luna #2/Gemini).
- Acceptance:
  - `/new`, `/resume`, `/reload` skills unchanged: resources-skills phase **≤20ms** warm (GLM F7 — signature check vẫn stat ~300 entries, 5ms là bất khả thi).
  - Thêm/sửa/rename/xoá → catalog cập nhật đúng (case matrix trên).
  - Số skill catalog = baseline snapshot chốt lúc bắt đầu implement (110 dir/118 SKILL.md — số pass lấy từ snapshot, không hardcode).

### T4 — Bỏ import-repro.ts
- Xoá `.pi/extensions/import-repro.ts` (−118ms/boot). Acceptance: file không còn; snapshot ext list còn nguyên.

### T5 — Runbook + skill `li-perf`
- `docs/perf-extensions.md`: protocol đo startup (PI_TIMING + per-import wall-clock, isolation `LI_CODING_AGENT_DIR` temp profile không copy junction — robocopy /XJ hoặc bỏ node_modules, forensics process tree, cold/warm protocol T8); budget extension mới: module import wall-clock ≤100ms tại start, vượt → lazy-load bắt buộc (template dynamic-import-trong-handler trỏ T6); sweep concurrency + side-effect assumption.
- Skill `D:\.claude\skills\li-perf\SKILL.md`: trigger "li chậm"/"đo extension"/"perf li"; trỏ runbook; checklist 5 bước đo→cô lập→quy lỗi→fix→verify.
- Acceptance: skill vào catalog; runbook đủ 4 protocol + budget + template.

### T6 — Dispatch antigravity lazy-load (delegated, brief v2 theo GLM F8/F9 BLOCKER)
- Ranh giới BẮT BUỘC trong brief: **provider/model registration giữ 100% sync lúc start** — `registerCompatApiProvider()` + `pi.registerProvider(PROVIDER_ID, …)` với catalog từ persisted last-known-good store: `getCurrentAntigravityCatalog()` trong `src/models/models.ts:372` (store accounts: `antigravity-accounts.json`, `src/auth/accounts.ts:10`). `compat.ts:128` là sync void, không async-register được. Lý do: Print/RPC resolve `--model` từ catalog TRƯỚC khi handler chạy (`index.ts:188-239`, issue #93) — stub thiếu catalog sẽ break `li -p --model antigravity/...` + model picker.
- Lazy CHỈ SDK-heavy: search/fetch/image SDK + auth graph, dynamic `await import()` **bên trong** stream/handler function (không quanh registration).
- Acceptance (nghiệm thu tại session này):
  - Per-import wall-clock (T1): `pi-antigravity/src/index.ts` ≤300ms (từ ~3771ms).
  - `li -p --model antigravity/<model>` resolve + chạy được (headless path).
  - Model picker liệt kê đủ model antigravity.
  - 3 tools (google_search, read_url_content, generate_image) first-call OK + ghi first-call latency (chi phí dời, không biến mất).
  - Không đổi tool signature.

### T7 — Dry-run cleanup 8.5GB subagent-tab
- Analyze cấu trúc/tuổi runs `~/.pi/agent/subagent-tab` (robocopy /L /XJ để tránh junction loop — du đã timeout); đề xuất retention (giữ live + 14 ngày).
- Acceptance: báo cáo dry-run (bytes, danh sách mẫu, rủi ro); KHÔNG xoá trước owner OK.

### T8 — Defender exclusion pack + cold protocol
- Cold protocol chuẩn: đo ngay sau restart OS HOẶC purge standby list (RAMMap `Empty Standby List`) trước mỗi run cold; 3 run median.
- Owner chạy admin: `Add-MpPreference -ExclusionPath 'D:\pcloud\workspace\code\pi-mono-li','C:\Users\quocn\.pi\agent','D:\.claude\skills'` (ExclusionProcess node.exe đánh giá rủi ro trong runbook, để owner quyết).
- Acceptance: sau exclusion, cold median ≤8s theo protocol trên.

## Ordering & Overall Acceptance

- Thứ tự: T1 → T2/T3 (song song được, cùng đo lại bằng T1) → T4 bất kỳ lúc nào → T6 dispatch NGAY sau khi spec chốt (session khác làm song song) → nghiệm thu end-to-end khi T2+T4+T6 đủ.
- Overall (không tính riêng lẻ từng task): median 3 run warm `PI_TIMING=1 li -p` **≤2500ms** + snapshot tool/command bằng baseline + vitest target PASS; cold ≤8s sau T8; first-call latency lazy tools báo kèm.
- Baseline/after lưu `.agent-workbench/li-perf/baseline.md` + `after.md`; commit scoped từng task, parent review diff trước commit.

## Review Log

- 2026-11-27: GLM NEEDS REVISION (F1-F12, blocker F5/F8/F10) · Luna NEEDS REVISION (5 findings, risk cao nhất = top-level side-effect order) · Gemini NEEDS REVISION (7 findings, thiếu cold protocol/rollback toggle/dependency ordering) → tất cả đã vá vào v2 này.
- Patches: T1 per-import wall-clock + TimingLabel "resources" + capture reload (F10/F11) · T2 two-phase + error mapping + escape hatch + sweep + fsCache check + acceptance softening (F1-F4, Luna#1/#5, Gemini#2/#3) · T3 key (dirPath,source) + revision-list signature + evict + ≤20ms (F5-F7, Luna#2) · T6 registration-sync boundary + first-call latency (F8/F9, Gemini#6) · T8 cold protocol (Gemini#1) · baseline skill count = snapshot (Gemini#4) · snapshot verify cơ học (Gemini#5, F12) · jiti moduleCache OUT (Gemini#7).
- Blocker-verify: GLM re-check bản v2 (chỉ 3 blocker F5/F8/F10) trước khi implement.

## External Review Brief

- Round 1 xong (3 model). Round 2 (nếu có): chỉ GLM verify blocker patches, 1 vòng duy nhất.
