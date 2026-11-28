---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-28-li-build-resilience"
status: "archived"
title: "Li build resilience — hết cửa sổ chết dist/bundle + journal forensic"
archived_at: "2026-11-28T22:09:37+07:00"
source_file: "SPEC-2026-11-28-li-build-resilience.md"
source_sha256: "eb6fcdaa269e0c4eae644d374b90ba735c3dd70ac217cbb77343bff41fc897a7"
implementation_ref: "2ffa325dffcee301d23d8848720974521db7239e"
working_tree: "dirty"
related_paths: ["scripts/build-coding-agent-bundle.mjs", "scripts/build-li.mjs", "scripts/package-files.mjs", "scripts/package-files.test.mjs", "bin/li", "bin/li.cmd", "docs/li-maintenance.md"]
---

# Spec: Li build resilience — hết cửa sổ chết dist/bundle + journal forensic

## Context Snapshot

- Project / module: `D:\pcloud\workspace\code\pi-mono-li` (fork Pi tự build, branch `li/stable`) — flow build runtime Li.
- Supersedes: None (spec đầu tiên cho vấn đề này).
- Stack / runtime: Node 22, npm workspaces (12 package), esbuild, scripts `.mjs` dùng tabs, launcher POSIX `bin/li` + Windows `bin/li.cmd`.
- Current behavior:
  - `scripts/build-coding-agent-bundle.mjs:154` `rmSync(dist/bundle, recursive)` chạy **trước** 3 lượt `esbuild build()`; `cli.js` chỉ được ghi lại ở dòng ~253. Mọi interrupt (Ctrl+C, sleep, npm fail, Defender lock) trong cửa sổ hàng chục giây đó = mất `dist/bundle/cli.js` — Li chết tới khi build lại thành công. Đây là cơ chế gốc của pattern "Li chết" lặp 4-5 lần (cli.js-only).
  - `npm run clean` của coding-agent = `package-files.mjs clean dist` = `rmSync(path, recursive, force)` nhận path bất kỳ, không guard — cùng LỚP lệnh với nghi phạm chính của vụ quét 929 file tracked trong `packages/coding-agent` sáng 2026-11-28. LƯU Ý framing: clean-dist giải thích được mất `dist/bundle/cli.js`, nhưng CHƯA có bằng chứng nó gây mất source tracked — đó là hypothesis/risk, không phải cùng nguyên nhân đã xác nhận (Luna).
  - Không có nhật ký build nào tồn tại qua lần dist bị wipe → sự cố sau không truy được "lúc xoá có build đang chạy không".
- Desired behavior:
  - Build fail/interrupt ở BẤT KỲ bước nào → bundle live trước đó còn nguyên, `li` vẫn khởi động (fail-closed).
  - Crash giữa swap → lần build tiếp theo tự recovery từ `bundle.old-*`.
  - Mọi build/missing event để lại journal ngoài repo → agent lần sau đọc 1 file là biết timeline sự cố.
  - `package-files.mjs clean` không thể xoá sai phạm vi (src/test/docs/repo-root) — `clean .` kiểu tai nạn bị refuse.
- Relevant files to read:
  - `scripts/build-coding-agent-bundle.mjs` — toàn bộ, đặc biệt 130-260 (input check → rmSync → esbuild → metafile checks → writeFileSync launcher).
  - `scripts/build-li.mjs` — `run()`, `collectProvenance()`, OSC patch block (153-180), `writeReceipt()`.
  - `scripts/li-osc-patch.mjs` — signature `neutralizeLiTerminalColorQuery(bundleDir)`.
  - `scripts/package-files.mjs` — 30 dòng toàn bộ (GLM fact-check).
  - `bin/li` + `bin/li.cmd` — block check `[ ! -f "$PI_CORE_CLI_PATH" ]` / tương đương cmd.
  - `packages/coding-agent/package.json` — `clean`, `prepublishOnly`, `bin.li = dist/bundle/cli.js`.
- Existing constraints:
  - Owner ràng buộc: KHÔNG Telegram alert, KHÔNG watchdog/scheduled task, KHÔNG gate thừa — chỉ journal cục bộ phục vụ forensic.
  - `dist/` gitignored; mọi artifact build sống ở `dist/`, có thể bị wipe bất kỳ lúc nào.
  - Build entry hợp lệ: `node scripts/build-li.mjs [--offline]` và trực tiếp `npm --prefix packages/coding-agent run build` — cả hai phải sống sót sau thay đổi.
  - INCIDent TIMELINE (bằng chứng đã chốt, tham chiếu cho journal design): li chạy OK tới 10:12:56 (`D:\tmp-li-timing.txt` mtime), 929 file + cli.js mất trước 10:18:38 (rclone `sync.log` dòng 29736-29745), peer restore 10:24. USN journal đã wrap — bằng chứng file-level mất; chỉ còn audit forward-looking (P3).

## Objective

- Chặn vĩnh viễn pattern mất `dist/bundle/cli.js` do build interrupted: build fail = bundle cũ còn sống (fail-closed), không bao giờ có trạng thái "không có bundle dùng được".
- Mọi sự cố build/missing để lại vết trong journal ngoài repo, đủ cho agent sau tái hiện timeline mà không cần hỏi lại ai.
- Loại bỏ lớp tai nạn `rmSync` sai phạm vi từ `package-files.mjs clean`.
- Success trông như thế nào: build ×N lần với fault inject ở từng mốc — `li --version` luôn trả về được hoặc lỗi rõ ràng có journal; không còn trạng thái im lặng mất bundle.

## Scope

- In:
  - `scripts/build-coding-agent-bundle.mjs`: staging + OSC-patch-trên-candidate + fail-closed swap + recovery hint.
  - `scripts/build-li.mjs`: build lock nhẹ (PID), recovery từ `bundle.old-*`, append journal (started/ok/fail/recovered).
  - `bin/li` + `bin/li.cmd`: append `missing-detected` vào journal khi báo build-not-found (đúng lúc sự cố được phát hiện tự nhiên).
  - `scripts/package-files.mjs`: guard allowlist cho lệnh `clean`.
  - `docs/li-maintenance.md`: runbook journal + recovery + audit SACL (P3) + caveat publish flow.
- Out:
  - Versioned immutable build dirs + pointer swap (Terra đề xuất) — xem `Bỏ qua`.
  - Watchdog/scheduled task/Telegram/fetch-based monitor — owner gỡ.
  - Truy nguyên 929 file hôm nay (mất bằng chứng; chỉ làm runbook audit SACL cho lần sau).
  - Sửa `prepublishOnly`/root `clean --workspaces` — CHỐT thiết kế: đây là downtime chấp nhận có chủ đích (không nằm trong cam kết fail-safe của P1), chỉ ghi runbook, không gate thêm (Luna điểm 3).

## Thuật ngữ

- bundle live = `packages/coding-agent/dist/bundle/` đang được launcher trỏ vào (`bin.li = dist/bundle/cli.js`) — thứ `li` chạy thực sự.
- staging = `packages/coding-agent/dist/bundle.staging.<attemptId>/` — nơi esbuild ghi output mới (per-attempt), KHÔNG bao giờ là artifact sống.
- attemptId = `<epochMs zero-pad 13>-<pid>` — epoch-ms zero-padded 13 chữ số để sort chuỗi = sort thời gian (tie-break newest deterministic); sinh MỖI LẦN bundler chạy; đặt tên staging, old marker (`bundle.old-<attemptId>`), field receipt.tmp và journal (Luna blocker rev8 + peer M1).
- swap = chuỗi 2 rename: `bundle → bundle.old-<ts>` rồi `staging → bundle`.
- fail-closed = mọi failure giữ nguyên bundle live, exit non-zero, không có trạng thái "nửa vời".
- journal = `~/.pi/agent/li-build-journal.jsonl` (mặc định, override bằng env `LI_BUILD_JOURNAL`) — append-only, ngoài repo, sống qua mọi lần dist bị xoá.
- missing-detected = entry launcher ghi khi phát hiện cli.js vắng tại thời điểm user chạy `li`.

## Assumptions

1. Metafile-derived paths trong bundle script (bedrock/oauth loaders, dirname equality checks) là so sánh tương đối trong 1 metafile — đổi outdir sang staging không cần sửa logic, chỉ cần mọi đường dẫn output tuyệt đối sinh từ biến `outdir` (GLM verify qua đọc code; implement phải double-check không còn hardcode `bundleDir` ở đoạn metafile).
2. Fault-injection env (`LI_BUNDLE_FAULT`) làm test seam vĩnh viễn trong bundle script là chấp nhận được — không set = no-op, có set chỉ dùng trong verify.
3. Journal ghi bằng `appendFileSync` đơn giản; không cần rotate (build Li tần suất vài lần/ngày, file lớn chậm).
4. Lock `dist/.bundle-lock` (mkdir-based) nằm TRONG dist nên `clean dist` sẽ xoá nó — chấp nhận có chủ đích: clean không chạy concurrent với build (runbook ghi rõ); lock mất giữa hold → process khác acquire → mitigation bằng staging per-PID (cô lập candidate), bundle live không bao giờ là mục tiêu ghi của 2 process.
5. User chạy `li` từ PowerShell → đi qua `bin/li.cmd`; POSIX `bin/li` dùng trong git-bash — cả hai cùng cần missing-detected.

## Open Questions

- Không có câu hỏi chặn approach. Note: nếu sau implement thấy rename `staging → bundle` fail thường xuyên do Defender quét staging (EPERM), cân nhắc thêm retry 1 lần sau 500ms — để verify thực tế quyết, không thiết kế trước.

## Approach

- Chọn: staging + fail-closed swap + recovery + journal, tất cả trong phạm vi scripts/ + launchers hiện có.
- Lý do: cả 3 verdict review (Terra/Luna/GLM) đều xác nhận cùng cơ chế chết; phương án này xoá cửa sổ chết từ hàng chục giây (rmSync → cuối script) xuống mức ms giữa 2 rename, đổi thuộc tính quan trọng nhất là **fail-closed** (rename fail = bundle cũ nguyên). Alternative "versioned dirs + pointer" (Terra) đạt zero-downtime tương đương nhưng phải đổi launcher + thêm GC + version receipt — nhiều moving parts cho cùng mức bảo đảm ở quy mô 1 máy 1 user; owner đã chốt tối ưu không rườm rà.
- Phụ thuộc chính: esbuild API (outdir, metafile), node `fs.renameSync` semantics (không replace dir non-empty → phải rename old đi trước), OSC patch chạy được trên bất kỳ dir nào (đã nhận `bundleDir` tham số).
- Risk chính + cách xử: MỌI mutation của `bundle` (swap trong bundler, restore launcher, recovery/heal build-li) đều qua MỘT mkdir-lock; build-li hold xuyên recovery→build→swap→receipt-commit (bundler re-entrant qua `LI_LOCK_PID`), launcher held → không restore — hết race swap↔recovery (Terra+Luna). Rename fail → rollback; hard-kill giữa 2 rename → old giữ bundle, recovery ở launcher (trước cả nhánh --version) và build-li sau; crash sau promote trước receipt → receipt.tmp orphan chỉ được promote ở lần build-li kế; launcher li không hash/promote receipt (protocol 2 pha); concurrent → lock + staging per-PID.
- Thứ tự: T1 (bundle script) → T2 (build-li journal/lock/recovery + launchers) → T3 (package-files guard) → T4 (runbook). T3 dùng sandbox temp cho test — không đụng dist thật khi T1/T2 build/fault-test đang chạy (Luna: serialize clean tests).

## Diagram

```mermaid
flowchart TD
    subgraph Launcher [user chạy li — check bundle TRƯỚC, lock chỉ khi thiếu]
        U[user chạy li] --> L1{cli.js tồn tại?}
        L1 -- yes --> L7{--version?}
        L1 -- no --> L0{acquire mkdir-lock?}
        L0 -- held --> LW[bounded wait 3×1s rồi re-check]
        LW -- cli.js xuất hiện --> L7
        LW -- vẫn thiếu + lock held --> L6[journal missing-detected + lỗi build đang chạy]
        L0 -- ok --> L3{bundle.old-* có cli.js? chọn newest ts}
        L3 -- yes --> L4[restore + XÓA receipt.tmp stale + journal recovered + release] --> L7
        L3 -- no --> L5[release + journal missing-detected + lỗi như cũ]
        L7 -- yes --> L8[đọc receipt in version]
        L7 -- no --> L9[exec node bundle/cli.js]
    end
    subgraph Build [build-li hold lock xuyên suốt]
        B1[journal started + recovery old (restore → LUÔN DISCARD tmp) + receipt.tmp: promote CHỈ khi tồn tại bundle.old-<tmp.attemptId> + hash khớp live; ngược lại DISCARD + receipt-heal]
        B1 --> B2[bundler child re-entrant qua LI_LOCK_PID]
        B2 --> B3[esbuild → bundle.staging.PID + sweep staging chết]
        B3 --> B4[OSC patch + validate trên staging]
        B4 --> B5[hashTree staging + provenance → ghi receipt ĐẦY ĐỦ vào dist/li-build-receipt.json.tmp]
        B6{fault? esbuild 64 / swap1 65 / swap2 66 = hard-exit sau rename 1 / promote 67 / swap3 68 = rollback fail / pretmp 69 = exit sau tmp trước rename 1}
        B6 -- yes --> B7[journal fail stage + exit code tương ứng]
        B6 -- no --> B8[swap: bundle→old-<attemptId>; staging→bundle; rename 2 fail → rollback old + exit 65; rollback fail → journal swap3, old giữ bundle]
        B10[rmSync old fail → rename → old-consumed-<attemptId> + warn + note; ok → journal ok SAU receipt] --> B11[release lock]
    end
```

## Bỏ qua

- **Versioned immutable dirs + pointer swap** (Terra khuyến nghị): đạt zero-downtime thật nhưng phải đổi launcher resolve, thêm GC, version receipts — quá nhiều moving parts cho 1 máy 1 user; fail-closed swap + recovery đạt mức bảo đảm tương đương về "không bao giờ mất CLI dùng được". Revisit chỉ khi sau này cần hot-swap giữa nhiều runtime.
- **Watchdog Telegram / poll 5 phút / fs.watch daemon**: owner gỡ tường minh; journal + missing-detected tại thời điểm user chạy `li` (luôn là lúc phát hiện tự nhiên) đủ cho forensic.
- **USN Journal như công cụ bắt thủ phạm**: sai kỳ vọng — USN_RECORD không chứa PID/process (Luna+GLM xác nhận). Thay bằng audit SACL → Event 4660/4663 có ProcessName (P3 runbook).

## Risks

- Rename `staging → bundle` fail EPERM do Defender quét file mới: fail-closed giữ bundle cũ — build fail, chạy lại được; nếu lặp nhiều thì thêm 1 retry 500ms (Open Questions).
- `bin/li.cmd` append journal có thể gãy encoding/quoting cmd: giữ format 1 dòng ASCII cố định, test riêng trên PS.
- Guard P4 chặn nhầm use case tương lai: `--force` là lối thoát tường minh + log.
- Fault-injection env quên set trong CI: mặc định no-op, risk thấp; nhớ clear giữa các fault case khi verify tay.
- Bounded wait launcher là false-negative có chủ đích ở đúng cửa sổ swap ms-level (hiếm): `li` báo build đang chạy dù build sắp xong — chạy lại là xong; không tranh chấp restore khi builder sống (Terra leak 1).
- Crash giữa swap và promote receipt: final receipt stale mô tả bundle cũ; receipt.tmp orphan promote CHỈ khi đủ 3 điều kiện marker (không restore-old + `bundle.old-<ts>` tồn tại + hash khớp live — byte-identical pre-swap crash KHÔNG promote); không đủ → DISCARD + heal live; window = tới lần build-li kế; launcher restore old → tmp xoá → receipt stale tới build-li kế heal theo live.
- Journal best-effort: kill đúng lúc ghi / path không ghi được → entry mất; stage chính vẫn có entry theo exit-code protocol.
- `li --version` đọc receipt-only: trong cửa sổ receipt-stale có thể in version cũ — chấp nhận giữ startup lean, runbook ghi rõ.
- receipt.tmp tên cố định: scenario lock bị clean xoá + 2 build đồng thời có thể đè tmp nhau (bundle live không bị đụng) — tự heal lần build kế, severity thấp, scenario bị runbook cấm (GLM minor).
- Residual marker attempt cũ: ĐÃ ĐÓNG bằng attemptId binding — `bundle.old-<attemptId>` chỉ match receipt.tmp cùng attemptId; stale marker của attempt khác không bao giờ chứng minh tmp mới; PID-reuse/start-time giữ theo rev6 (Luna blocker rev8 closed).
- `build-li --record-tests` ghi receipt ngoài protocol lock — race thấp, chạy tay hiếm; ghi runbook cấm chạy khi build đang hold lock (GLM minor).

## Task List

### Task 1: Bundle script — staging + OSC-trên-candidate + fail-closed swap
- Acceptance:
  - esbuild ghi 3 lượt output vào `dist/bundle.staging.<attemptId>`; không còn `rmSync(bundleDir)` trước build.
  - Launcher shim `writeFileSync(bundleDir/cli.js)` + chmod (block 253-255) phải ghi vào STAGING cùng các output khác — giữ path cũ = ghi vào bundle cũ bị rename+rmSync cuốn mất → bundle mới thiếu cli.js (GLM F1).
  - Mọi đường dẫn suy từ metafile (bedrock/oauth/loader chunks, dirname equality — logic thật dòng 170-242) hoạt động đúng trên staging — không hardcode `bundleDir`.
  - `neutralizeLiTerminalColorQuery(stagingDir)` chạy trước swap; `li-osc-patch-receipt.json` ghi vào `dist/` sau promote receipt.
  - Receipt 2 pha + attemptId (Luna rev8): bundler sinh `attemptId` (`<epochMs zero-pad 13>-<pid>`) mỗi lần chạy; trước swap — hashTree(staging) + provenance (git SHA/tree/dirty + OSC fields) + attemptId ghi ĐẦY ĐỦ vào `dist/li-build-receipt.json.tmp`; sau swap — promote receipt: rename `.tmp → li-build-receipt.json`; rmSync old CHỈ sau promote; rmSync old fail (EPERM) → rename `bundle.old-<ts>` thành `bundle.old-consumed-<attemptId>` + warn + journal note — consumed không match marker pattern `bundle.old-<attemptId>` (Luna blocker rev7/rev8).
  - `LI_BUNDLE_FAULT=esbuild|swap1|swap2|swap3|pretmp|promote` (no-op khi unset): esbuild=64; swap1=65; swap2=66 HARD-EXIT sau rename 1 (mô phỏng kill, không chạy catch — khác rename-2-fail thật = 65 có rollback, verify phải assert đúng nhánh); swap3=68 rollback fail; pretmp=69 exit sau khi ghi receipt.tmp TRƯỚC rename 1 (test byte-identical pre-swap crash: attemptId của tmp không match marker cũ → DISCARD — Luna blocker rev7/rev8); promote=67 exit NON-ZERO sau swap trước promote receipt (GLM F5). Bundler tự journal fail stage trước exit; parent build-li map code→stage, không ghi đè; child bị kill NGOÀI fault (không kịp journal) → parent journal `fail stage=crash` kèm exit code, bỏ qua nếu entry cuối attempt đã là fail — không double entry.
  - `LI_BUNDLE_FAULT` không set: build thường pass như cũ, output byte-equivalent (bundle cli.js mới vẫn chạy được qua launcher).
- Reproduce (baseline + fault; nhớ clear `LI_BUNDLE_FAULT=` giữa các case — GLM F7): cmd `cd /d D:\pcloud\workspace\code\pi-mono-li && node scripts/build-li.mjs --offline && li --version` — baseline pass; fault `esbuild` expect exit 64 + bundle nguyên.
- Verify T1-standalone: esbuild fault (exit 64, bundle nguyên, li boot OK) · EPERM thực: PowerShell `[System.IO.File]::Open` giữ handle 1 file bundle → rename 1 PHẢI throw (assert error code, không giả định handle đủ chặn — Terra) → bundle nguyên · build sạch: `bundle/cli.js` TỒN TẠI + `li` boot thật (KHÔNG chỉ receipt — GLM F1), staging PID mình sạch + sweep staging chết, receipt khớp candidate.
- Verify T1-integration (sau T2): swap2 (exit 66 → `li --help` tự restore + journal recovered) · swap3 (exit 68 → old giữ bundle → recovery sau) · promote (exit 67 → build-li lượt sau promote receipt.tmp theo hash-match; assert source SHA + OSC + artifactHash khớp candidate — Luna).
- Files:
  - `scripts/build-coding-agent-bundle.mjs` — pattern: block hiện tại dòng 154-165 (rmSync+mkdir) thay bằng staging lifecycle; logic metafile thật = dòng 170-242 (GLM fact-check) giữ nguyên, đổi nguồn path; block launcher shim 253-255 đổi ghi vào staging.
  - Provenance/hashTree/sha256: DUPLICATE helper vào bundler ở T1 (bundler tự thu thập git provenance khi viết receipt.tmp) — GLM C2 chốt phương án duplicate để Files list T1 giữ nguyên; build-li dọn bản duplicate của nó ở T2.
  - `scripts/li-osc-patch.mjs` — chỉ import + gọi, không sửa.

### Task 2: build-li lock + recovery + journal; launcher missing-detected
- Acceptance:
  - Lock MỘT owner: build-li mkdir `dist/.bundle-lock` (PID + process start-time bên trong) ở start, hold xuyên recovery→build→receipt-promote→journal ok, release cuối; bundler child re-entrant qua env `LI_LOCK_PID` (khớp → OK, khác → exit concurrent); direct `npm run build` không parent → bundler tự acquire (Luna: một lock owner duy nhất, serialize recovery→swap→receipt). Lock stale ĐÚNG NGHIÊM: so PID + process start-time (cmd: `wmic process where processid=<pid> get creationdate`; PS: `Get-Process -Id` StartTime; sh: `ps -o lstart= -p`) — PID reuse (process khác chiếm PID, start-time khác) vẫn tính stale (Terra leak 3); start-time không đọc được → fail-safe coi lock CÒN SỐNG + journal hướng dẫn owner xác nhận không build rồi xoá tay. Launcher lẫn build-li cùng rule (Luna blocker 3).
  - build-li đầu lượt (trong lock): recovery — bundle thiếu + `bundle.old-<13digits>-<pid>` (pattern attemptId, bỏ old-consumed) có cli.js → rename newest (attemptId lớn nhất) về bundle + journal `recovered`; receipt.tmp orphan quyết theo MARKER swap, đủ 3 điều kiện MỚI promote: (1) KHÔNG vừa restore old (restore → DISCARD tmp luôn — hash không chứng minh provenance); (2) tồn tại `bundle.old-<tmp.attemptId>` ĐÚNG TÊN — marker của attempt khác/stale không chứng minh attempt này đã swap (`bundle.old-consumed-*` KHÔNG tính — Luna blocker rev8); (3) `tmp.artifactHash === hashTree(live)`. Đủ → promote + journal `receipt-heal` metadata đầy đủ từ tmp. Thiếu bất kỳ (pre-swap crash dạng byte-identical build CŨNG KHÔNG promote; hash lệch; không tmp) → DISCARD tmp + heal live `healed:true, provenanceSource:'heal', git fields null`; old-ts tồn mà không có tmp → rmSync dọn + journal (Terra leak 2, Luna blocker rev7).
  - Launcher `bin/li` + `bin/li.cmd`: check `cli.js` TỒN TẠI TRƯỚC, KHÔNG cần lock — bundle live còn thì chạy như thường kể cả lúc build đang hold lock (Luna blocker 1: acquire trước check làm mọi `li` trong build fail oan). Chỉ khi THIẾU: acquire mkdir-lock — held → bounded wait 3×1s rồi re-check; sau wait nếu lock vừa free/release → quay lại nhánh acquire/recovery MỘT lần (Terra leak 1), lock vẫn held + cli.js vẫn thiếu → journal `missing-detected` + lỗi build đang chạy (false-negative có chủ đích ở đúng cửa sổ swap ms-level, hiếm — ghi runbook), KHÔNG restore khi builder còn sống (chống race); lock free hoặc stale PID chết → take over → old MỚI NHẤT = attemptId lớn nhất (chỉ match pattern `bundle.old-<13digits>-<pid>`, bỏ old-consumed) có cli.js (nhiều old: lấy max + xoá dư; cmd quote path khoảng trắng) → restore + XÓA receipt.tmp (shell không hash — tmp là candidate chưa chứng minh) + journal `recovered` + release; restore fail / không old → journal + lỗi như cũ. Restore đứng TRƯỚC nhánh `--version` (GLM F2).
  - `rmSync old` fail sau promote (EPERM): warn + journal note, KHÔNG fail build — bundle mới đã live (GLM F6); old tồn dư do launcher tie-break newest xử lý lần sau.
  - Sweep staging chết = parse attemptId từ tên dir (`<epochMs zero-pad 13>-<pid>`) → check PID alive; build-li start gặp lock held bởi PID sống → exit `already running` ngay (không wait — GLM minors).
  - Journal schema CHỐT CỨNG (2 nơi ghi khác ngôn ngữ — build-li.mjs + launcher shell — phải theo đúng bảng): mỗi entry 1 dòng JSON: `schemaVersion` (1), `ts` (ISO 8601 UTC — bắt buộc, sortable), `kind` (started|fail|ok|recovered|receipt-heal|missing-detected), `pid`, `liRoot` (checkout root — phân biệt nhiều variant pi-mono-li), `attemptId` (khi có), `stage` + `exitCode` (fail/crash), `artifactHash` + `gitShortSha` + `gitDirty` (ok/heal), `detail` (ASCII ≤200 ký tự: tên old marker, lý do). Timeline sự cố dạng sáng nay: started → fail/crash → missing-detected → recovered = đủ tái hiện Li-chết; source-wipe 929 không qua build → chỉ thấy missing-detected muộn hơn giờ xoá — SACL (P3) lo phần đó (peer F1). Best-effort: kill giữa lệnh ghi / path không ghi được → entry mất — không cam kết tuyệt đối (Terra finding 6). Path mặc định `~/.pi/agent/li-build-journal.jsonl`, override `LI_BUILD_JOURNAL`.
  - Path mặc định `~/.pi/agent/li-build-journal.jsonl`, override `LI_BUILD_JOURNAL`.
- Reproduce: baseline + `type`/`Get-Content` journal per-shell (GLM F7); swap2-recovery: `LI_BUNDLE_FAULT=swap2` build → `li --help` → restore + journal `recovered`; stale-lock: fake `dist/.bundle-lock` PID chết + bundle thiếu → `li --help` → take-over + restore; promote-hash: `LI_BUNDLE_FAULT=promote` build → chạy lại `node scripts/build-li.mjs --offline` → start-heal promote tmp (marker `bundle.old-<tmp.attemptId>` tồn tại + hash khớp candidate) → assert receipt = candidate; mismatch-discard: `LI_BUNDLE_FAULT=swap2` rồi build-li kế → tmp lệch hash với old → DISCARD + heal live; race: lock PID sống + bundle thiếu → `li --help` bounded wait → KHÔNG restore · wait-free: release lock giữa bounded wait → `li` kế chạy bình thường · byte-identical-swap2: build 2 lần không đổi source → fault swap2 → recovery → tmp DISCARD bất kể hash khớp · byte-identical-pretmp (Luna blocker rev7): build 2 lần không đổi source → fault `pretmp` (tmp ghi, CHƯA swap, live = bundle cũ) → build-li kế → tmp DISCARD + heal live, receipt cũ GIỮ NGUYÊN — không promote provenance candidate · PID-reuse: fake lock PID process đang sống khác start-time → vẫn stale take-over · stale-marker (Luna rev8): fake `bundle.old-<attemptId-KHÁC>` + fault `pretmp` byte-identical → build-li kế → tmp DISCARD (marker không cùng attemptId) + heal live, receipt cũ giữ nguyên.
- Verify: swap2 recovery + stale-lock take-over (kèm PID-reuse: PID sống, start-time khác → vẫn stale) + promote-hash-match (marker cùng attemptId + hash) + stale-marker attemptId-mismatch → discard + mismatch-discard + restore-old→tmp-always-discard + byte-identical-pretmp→không-promote + race-bounded-wait + wait-lock-free-retry PASS; exit code đúng nhánh (66 hard-exit ≠ 65 rollback ≠ 69 pre-swap); journal không double-fail cho cùng attempt; direct build bị chặn khi build-li hold; 2 build đồng thời staging per-PID; journal `JSON.parse` từng dòng; 2 shell append OK kể cả path khoảng trắng; `li --version` receipt-stale caveat ghi runbook.
- Files:
  - `scripts/build-li.mjs` — pattern: `collectProvenance()` + block OSC 152-188 (patch đã dời sang bundle script); build-li KHÔNG ghi receipt ở path thường — chỉ ĐỌC artifactHash/OSC từ receipt promoted cho journal `ok`; ghi receipt CHỈ xảy ra ở nhánh heal (GLM C1).
  - `bin/li` — pattern: block `[ ! -f "$PI_CORE_CLI_PATH" ]` cuối file.
  - `bin/li.cmd` — pattern: @20 set PI_CORE_CLI_PATH / check `if not exist` @30 / handler `:no_build` @44-47 (GLM fact-check).

### Task 3: package-files.mjs — guard allowlist cho clean
- Acceptance:
  - `clean`: target KHÔNG tồn tại → no-op PASS giữ semantic idempotent `rmSync force:true` (GLM F4/Terra). Tồn tại (FILE hoặc DIR — cùng rule; GLM B2) → canonicalize: `path.resolve` + case-fold + separator chuẩn hoá; `realpathSync` khác resolved → junction/symlink escape → REFUSE (`--force` cũng không qua — Luna điểm 5). Cho phép khi resolved BẰNG hoặc NẰM TRONG `<pkg>/dist` hoặc `<pkg>/.eval` — `<pkg>` = ancestor chứa `package.json` (GLM B1: cover nested call site thật `clean dist/providers/data` của packages/ai build:offline). REFUSE: resolved là repoRoot, ancestor của cwd, segment `.git`, `src/foo/dist` (ngoài boundary), mọi target ngoài boundary → `--force` chỉ mở cho KHÔNG phải junction escape + log đích danh target.
  - `copy`/`executable` không đổi hành vi.
  - 11 workspace `clean dist` + evals `clean .eval` + nested `clean dist/providers/data` (packages/ai — chạy trong MỌI `build-li --offline` qua chuỗi build:offline) chạy PASS như cũ; root `npm run clean --workspaces` PASS.
- Reproduce (sandbox temp: `<tmp>/packages/x/dist/f.txt`, `<tmp>/packages/evals/.eval/g.txt`, `<tmp>/packages/ai/dist/providers/data/d.txt` — đủ package.json ở mỗi `<pkg>`; Luna: serialize clean tests): `clean .` / `clean src` / `clean packages/coding-agent` / `clean .git` → REFUSE; `clean .eval` → PASS; `clean dist` 2 lần → lần 2 no-op PASS; `clean dist/providers/data` → PASS (GLM B1); file-target `clean dist/f.txt` → PASS, `clean output.txt` ngoài boundary → REFUSE (GLM B2); junction-escape → REFUSE; `--force` path lạ → chạy + log target; `npm test` PASS (test file cập nhật).
- Verify: ma trận (REFUSE: cwd/src/packages-coding-agent/.git/nested-src-dist/file-ngoài-boundary · PASS: dist, .eval, nested dist/providers/data, file-trong-boundary · no-op ×1 · force ×1 · junction ×1) exit code đúng; `npm test` PASS; không xoá gì ngoài expected.
- Files:
  - `scripts/package-files.mjs` — pattern: block `case "clean":` dòng 11-13.
  - `scripts/package-files.test.mjs` — pattern: sandbox `mkdtemp` hiện KHÔNG có package.json + case `clean output.txt` (target là FILE) → cập nhật sandbox (thêm package.json) + expectation theo guard mới; chạy trong `npm test` qua test:scripts (GLM B2).

### Task 4: Runbook — journal, recovery, audit SACL, caveat publish
- Acceptance:
  - `docs/li-maintenance.md` có section mới: (a) vị trí + schema journal + cách agent đọc khi xử sự cố; (b) 2 đường recovery (launcher + build-li) + receipt 2 pha (receipt.tmp chỉ promote ở lần build-li kế; `li` thường chỉ chạy bundle, không heal receipt; launcher restore old → tmp bị xoá → receipt có thể stale mô tả artifact cũ tới khi build-li kế heal THEO LIVE — không mặc định receipt cũ đúng) + caveat `li --version` đọc receipt-only + bounded wait có false-negative có chủ đích ở cửa sổ swap ms-level; (c) P3: auditpol + Set-Acl SACL cho `packages/coding-agent/{src,test,examples,docs}` VÀ `packages/coding-agent/dist` (Luna: bỏ dist = bỏ sót đúng artifact bị xoá; trade-off log volume → tăng Security log size) + quy trình ĐỦ VÒNG ĐỜI ON→OFF: (1) `auditpol /set /subcategory:"File System" /success:enable`, (2) Set-Acl Audit rule Delete + inheritance, (3) tăng Security log size TRƯỚC khi bật, (4) OFF: remove SACL rule + `auditpol /set /subcategory:"File System" /success:disable`, (5) lọc Event 4663 (ProcessName/ObjectName) correlate 4660 qua Handle ID (4660 KHÔNG có ObjectName — Luna) + ví dụ lệnh 1 dòng; (d) CHỐT: `prepublishOnly`/`clean --workspaces` xoá cả dist (gồm live bundle + lock) là downtime CHẤP NHẬN — không nằm trong cam kết fail-safe của P1; đừng interrupt giữa clean và build, đừng clean concurrent với build; (e) M2: section riêng "source-tree wipe (tracked files)" — `git status --porcelain` thấy hàng loạt ` D` → `git restore .` (dist gitignored không đụng) — playbook từ vụ 929, KHÁC hoàn toàn với P1 bundle recovery (peer M2).
- Reproduce: `git -C D:\pcloud\workspace\code\pi-mono-li diff -- docs/li-maintenance.md` có section mới.
- Verify: đọc lại runbook làm theo được từng bước không cần context chat.
- Files:
  - `docs/li-maintenance.md` — pattern: các section runbook hiện có (build → promote T20).

## Checkpoints

- Sau T1 (standalone — không đòi T2): esbuild fault + EPERM thực + build sạch với cli.js boot — PASS trước khi sang T2 (Terra: swap2/promote đòi recovery/heal thuộc T2).
- Sau T2 (integration): swap2 launcher-recovery + swap3 + promote-hash-match (marker cùng attemptId) + stale-marker-mismatch-discard + mismatch-discard + restore-old-discard + byte-identical-pretmp-không-promote + stale-lock take-over + race bounded-wait + 2 build đồng thời + direct-build lock — PASS toàn bộ.
- Sau T3 (sandbox): clean matrix đầy đủ.
- Trước khi xong: `npm run check` PASS + smoke build không fault + `li` boot thật (không dùng --version làm bằng chứng recovery).

## External Review Brief

### Reviewer cần phán
- Scope có trúng job chính không: "không bao giờ mất bundle dùng được" — có còn đường chết nào chưa cover (trừ path có chủ đích đã ghi caveat)?
- Thiết kế fail-closed swap + recovery có lỗ race nào chưa nghĩ (concurrent, Defender, crash giữa 2 rename)?
- 3 blocker rev4 Luna đã vá trong rev5: launcher check-cli.js TRƯỚC lock, promote receipt.tmp theo hash-match live (mismatch → discard + heal), stale-lock PID-dead take-over — còn lỗ nào?
- Guard P4 theo allowlist có break use case hợp lệ nào còn sót?
- Journal schema đủ để agent session khác tự tái hiện timeline sự cố không?
- Task breakdown + verify có bắt được lỗi thật (fault matrix đủ 残酷 chưa)?

### Reviewer nên đọc trước
- 5 file trong Context Snapshot (đặc biệt `build-coding-agent-bundle.mjs` toàn file).
- Verdict 3 reviewer trước đó đã gộp: Terra (atomicity Windows), Luna (recovery + receipt nhất quán + USN kỳ vọng), GLM (guard redesign + metafile paths + tsc không chạm bundle).

### Reviewer không cần phán
- Việc truy nguyên 929 file hôm nay (ngoài scope, mất bằng chứng).
- Đếm xung khắc versioned-dirs vs staging-swap (đã chốt ở `Bỏ qua` theo owner constraint).
- UI/UX lens (spec không có task UI).

## User Test

- Không có user test UI. Sau implement, owner chỉ cần: chạy `li` dùng thường — nếu có build/restore xảy ra trong phiên thì `li` phải luôn khởi động được hoặc báo lỗi kèm journal đã ghi. AI test đủ cover phần còn lại.

## Completion Gates

- [ ] Gate kỹ thuật: fault matrix T1 PASS + recovery T2 PASS + clean matrix T3 PASS + `npm run check` PASS.
- [ ] `/verify` tổng đối chiếu spec ↔ diff (DONE/PARTIAL/WRONG).
- [ ] Owner chạy 1 lượt `li` thật sau build mới (UAT tối thiểu — spec không UI).
- [ ] Runbook P3 đã trong `docs/li-maintenance.md` (owner tự chạy auditpol/SACL trong admin terminal — ngoài scope code).
- [ ] Commit scope-owned sau Final Gate PASS (không push nếu chưa được duyệt).
