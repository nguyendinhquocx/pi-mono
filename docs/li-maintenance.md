# Li maintenance runbook

Li (`li` command, branch `li/stable` trong worktree `D:\pcloud\workspace\code\pi-mono-li`) là
runtime fork build từ source. Nó **không tự update**: `li update` bị chặn, và nhánh `li/stable`
chỉ thay đổi qua quy trình merge có review dưới đây. `main` của fork vẫn tự sync upstream hằng
ngày qua `.github/workflows/sync-upstream.yml` — việc đó KHÔNG ảnh hưởng `li/stable` hay binary
Li đã build.

## Bản đồ runtime

| Thành phần | Đường dẫn |
|---|---|
| Worktree Li (branch `li/stable`) | `D:\pcloud\workspace\code\pi-mono-li` |
| Nhánh source Li | `li/stable` (local; không push nếu user chưa duyệt) |
| Source launcher | `bin/li.cmd` (Windows) và `bin/li` (POSIX/Linux); `LI_ROOT` tính từ thư mục launcher |
| Windows PATH entry | `D:\pcloud\workspace\code\pi-mono-li\bin` — không copy `li.cmd` ra chỗ khác |
| ProDesk user-local install | `~/.local/prodesk-li/{releases,current,bin}`; stable `bin/li` trỏ theo Li `current` |
| ProDesk user command | `~/.local/prodesk-li/bin/li`; `~/.local/bin/li` là symlink tùy chọn, không tự sửa shell profile |
| Li CLI entry | `packages/coding-agent/dist/bundle/cli.js` (generated) |
| Build receipt | `packages/coding-agent/dist/li-build-receipt.json` (generated; bundler ghi 2 pha qua `.tmp`) |
| Build journal | `~/.pi/agent/li-build-journal.jsonl` (ngoài repo, override `LI_BUILD_JOURNAL`) |
| Build lock | `packages/coding-agent/dist/.bundle-lock` (mkdir lock; xoá tay chỉ khi chắc chắn không build) |
| Profile dùng chung | `~/.pi/agent` (`configDir` giữ `.pi`; Pi và Li chia sẻ, gồm cả `tuiMode`) |
| Li TUI mặc định | quiet, borderless; mọi trạng thái chạy (working/compaction/retry/bash/modal) pulse `.` `..` `...`; input theo sát transcript, tới đáy khi regular scrollback lấp viewport |
| Li selection + prompt | `/resume` và `/tree` chọn bằng `→` + chữ đậm, không nền; prompt user nhập hiển thị bold italic trong `blank` style |
| Li transcript style | `/settings` → `Li transcript style`; `li.toolOutputStyle`: `blank` mặc định (bỏ background user/tool/custom/diff, giữ foreground/bold), `current` khôi phục nền; Pi bỏ qua key này |
| Ngôn ngữ giao diện | `/settings` → `Interface language`; `li.language`: `en` mặc định, `vi` chuyển static UI copy của Li sang tiếng Việt; có hiệu lực ngay, không cần restart; Pi bỏ qua key này. Catalog EN/VI nằm ở `packages/coding-agent/src/modes/interactive/locale.ts`; fallback English khi key thiếu/sai. Locale được bắc cầu qua env `LI_UI_LANGUAGE` cho hai extension first-party `pi-ask` và `pi-terminal-relay` (chỉ đọc khi `LI_RUNTIME=1`); ngoài Li hai extension giữ nguyên copy cũ. Biến `LI_*` (gồm `LI_UI_LANGUAGE`) bị `shell.ts` loại khỏi môi trường lệnh ngoài |

## Rebuild Li sau khi đổi source

```
cd /d D:\pcloud\workspace\code\pi-mono-li
npm ci --ignore-scripts
node scripts/build-li.mjs --offline
npm run check
bash ./test.sh        (Git Bash)
```

Windows full-suite gate: `test.sh` trên máy thường (không symlink privilege) không green 100% —
các test upstream còn fail vì lý do môi trường, KHÔNG phải Li: symlink EPERM (paths,
package-manager, resource-loader, session-selector, durable/jsonl, env-node fs), shell/process
timeout (env-node, harness-tools-recovery), message spawn Windows (đã có assertion platform-aware
nội repo), PM thật trên máy làm fixture self-update fail (config.test), upstream catalog drift
(xai-responses `xhigh`), chord boundary. Full-suite green là gate của Linux CI; trên Windows
chấp nhận khi residual failures rơi đúng các nhóm trên và `npm run check` + focused suites PASS.
Sau khi sửa test count, merge summary vào receipt:
`node scripts/build-li.mjs --record-tests <test-summary.json>`.

`build-li.mjs` điều phối, nhưng bundler (`build-coding-agent-bundle.mjs`) mới là nơi ghi receipt 2 pha:
esbuild chạy vào `dist/bundle.staging.<attemptId>` (attemptId = epoch-ms zero-pad 13 + pid), OSC
patch + hash chạy trên staging, receipt đầy đủ (full HEAD SHA, base Pi version, source tree hash,
Node version, artifact hash, attemptId) được park vào `dist/li-build-receipt.json.tmp` TRƯỚC swap,
chỉ rename thành `li-build-receipt.json` sau khi staging đã lên live. Mọi failure giữ bundle cũ
nguyên (fail-closed); swap crash để lại `bundle.old-<attemptId>` cho launcher/build-li recovery.
Mỗi build/missing event append 1 dòng JSON vào build journal (xem section bên dưới).
OSC patch `TERMINAL_COLOR_QUERY` chạy trên staging trước khi hash, và `li-osc-patch-receipt.json`
ghi sau promote; runtime guard không cần vá bundle Li lúc mở session.
`li --version` đọc receipt này (`li <base-version> (source <short-sha>)`).
Resume tool-loadout + EP routing integration smoke nằm ở Python repo `tests/super-parent/resume-tool-loadout-smoke.ps1`; nó rebuild Li, nạp extension closure vào profile tạm và chỉ dùng provider/WezTerm giả. Chạy từ Python repo: `powershell -NoProfile -File tests/super-parent/resume-tool-loadout-smoke.ps1 -LiRepo ..\pi-mono-li -ExtensionSource app_presets\pi\extensions`; evidence vào `tests/artifacts/resume-tool-loadout-smoke`.
Trước lần boot đầu trên profile thật, snapshot `.pi` xong phải rebuild kèm snapshot ID để provenance
receipt truy được đúng bản backup:

```
$env:LI_PROFILE_SNAPSHOT_ID = "pi-snapshot-2026-10-20-pre-li"
node scripts/build-li.mjs --offline
```

Thay ID bằng tên snapshot thực tế. Source bẩn (uncommitted) → build vẫn chạy nhưng receipt đánh dấu
`gitDirty: true` — đó là candidate, KHÔNG dùng làm runtime ổn định. Li shell tool bỏ runtime routing
vars trước khi chạy lệnh ngoài; gọi `li` từ shell sẽ thiết lập lại chúng qua wrapper. Runtime guard
không nên vá Li lúc `session_start`; nếu nó vẫn báo `neutralized TERMINAL_COLOR_QUERY`, build
receipt/patch receipt không khớp bundle đang chạy. Pi global dist vẫn được runtime guard xử lý riêng.
Build xong PHẢI re-approve T20 promotion trước khi session mới dùng: receipt mới đổi `artifactHash`,
trong khi registry (`~/.pi/agent/session-open-leases/registry.json`) chỉ approve build cũ qua
`approved_builds` + `t20_receipt_sha256` — bỏ bước này mọi `/trim` refuse `promotion_required`
(vụ 12/11: rebuild `739770c39` dirty + không re-promote, gate đóng 2 ngày). Quy trình: commit/tạo
tree sạch → `build-li.mjs` → backup `registry.json` + `t20-canary-receipt.json` thành `*.bak` →
ghi receipt mới (decision approved, artifactHash mới, supersedes build cũ) → cập nhật
`t20_receipt_sha256` + `approved_builds` → verify `li --version` khớp receipt.

## Bundle resilience: journal, recovery, audit SACL (P3), source-wipe (M2)

Từ SPEC-2026-11-28, build Li là fail-closed: build fail/interrupt ở bước nào cũng giữ bundle cũ
nguyên; không còn cửa sổ "rmSync dist/bundle rồi esbuild chết giữa chừng" làm `li` chết tới khi
build lại thành công.

### Build journal — vị trí, schema, cách đọc khi xử sự cố

- Vị trí: `~/.pi/agent/li-build-journal.jsonl` (ngoài repo, sống qua mọi lần dist bị xoá);
  override bằng env `LI_BUILD_JOURNAL`. Append-only, mỗi event 1 dòng JSON.
- Ai ghi: `build-li.mjs` (`started`/`ok`/`fail` crash), bundler (`fail` fault-inject), `bin/li` +
  `bin/li.cmd` (`recovered`/`missing-detected` khi user chạy `li` mà bundle thiếu).
- Schema (cột "khi nào" cho biết field nào xuất hiện ở kind nào):

| Field | Khi nào | Ý nghĩa |
|---|---|---|
| `schemaVersion` | luôn | `1` |
| `ts` | luôn | ISO 8601 UTC, sortable |
| `kind` | luôn | `started`\|`fail`\|`ok`\|`recovered`\|`receipt-heal`\|`missing-detected` |
| `pid` | luôn | pid của process ghi entry |
| `liRoot` | luôn | checkout root — phân biệt nhiều variant pi-mono-li |
| `attemptId` | khi có | `<epochMs zero-pad 13>-<pid>` của build |
| `stage` + `exitCode` | fail/crash | `esbuild`\|`swap1`\|`swap2`\|`promote`\|`swap3`\|`pretmp`\|`crash` + mã exit |
| `artifactHash` + `gitShortSha` + `gitDirty` | ok/heal | provenance của artifact đang live |
| `detail` | luôn | ASCII ≤200 ký tự: tên old marker, lý do |

- Cách agent đọc khi xử sự cố "Li chết": đọc ngược journal, timeline điển hình là
  `started → fail/crash → missing-detected → recovered` — đủ biết lúc nào build chết, bundle mất
  lúc nào được phát hiện, và đã tự hồi phục chưa. Fault-inject test dùng env `LI_BUNDLE_FAULT`
  (`esbuild`\|`swap1`\|`swap2`\|`swap3`\|`pretmp`\|`promote` → exit 64/65/66/68/69/67; unset = no-op,
  NHỚ clear giữa các case).
- Journal là best-effort (kill đúng lúc ghi / path không ghi được → entry mất); không dùng làm audit
  bắt thủ phạm xoá file — phần đó là SACL (P3) bên dưới.

### Hai đường recovery + receipt 2 pha

- **Launcher (`li` thường)**: check `cli.js` TRƯỚC nhánh `--version`. Bundle còn → chạy bình thường,
  kể cả lúc build đang giữ lock. Bundle thiếu → thử lấy lock: lấy được → restore
  `bundle.old-<attemptId>` mới nhất (có `cli.js`), xoá `li-build-receipt.json.tmp`, journal
  `recovered`, nhả lock. Lock bị giữ → chờ bounded 3×1s; builder sống → journal
  `missing-detected` + lỗi "build đang chạy" (false-negative có chủ đích ở đúng cửa sổ swap
  ms-level, hiếm — chạy lại `li` là xong); lock stale (pid chết hoặc pid bị reuse, start-time
  khác) → take over rồi restore như trên.
- **build-li (đầu mỗi lượt, trong lock)**: bundle thiếu + marker có `cli.js` → restore + journal
  `recovered`; `li-build-receipt.json.tmp` chỉ được promote khi đủ 3 điều kiện: (1) KHÔNG vừa
  restore old, (2) tồn tại marker `bundle.old-<tmp.attemptId>` ĐÚNG tên, (3) hash tmp khớp
  `hashTree(bundle live)`. Thiếu bất kỳ → DISCARD tmp; receipt cũ mô tả đúng byte live thì GIỮ
  NGUYÊN, sai/missing thì heal theo live với `healed:true, provenanceSource:'heal', git fields null`.
- **Receipt 2 pha**: receipt.tmp chứa provenance đầy đủ của candidate, chỉ thành receipt chính thức
  sau promote. `li` thường chỉ chạy bundle, KHÔNG heal receipt. Launcher restore old → tmp bị xoá →
  receipt có thể stale mô tả artifact cũ tới khi build-li kế heal THEO LIVE — đừng mặc định receipt
  cũ đúng. `li --version` đọc receipt-only: trong cửa sổ receipt-stale có thể in version cũ; receipt
  healed thì in `source ?` — chấp nhận để giữ startup lean.
- Stale marker/marker consumed dư (`bundle.old-consumed-*`) được build-li kế dọn + ghi journal; đừng
  xoá tay trong lúc build đang chạy.

### P3 — audit SACL bắt thủ phạm xoá file (chỉ bật khi cần điều tra)

USN journal KHÔNG chứa PID/process — đừng kỳ vọng vào nó. Muốn biết AI/process nào xoá file trong
`packages/coding-agent` (kể cả `dist`), bật File System auditing tường minh theo ĐỦ vòng đời
ON → thu evidence → OFF:

1. Tăng Security log size TRƯỚC khi bật (Event 4663 rất ồn với `dist`):
   `wevtutil sl Security /ms:268435456`
2. Bật audit policy (admin):
   `auditpol /set /subcategory:"File System" /success:enable`
3. Set SACL Audit rule Delete cho source + dist (admin PowerShell, inheritance cho cả cây):
   ```
   $paths = 'packages/coding-agent/src','packages/coding-agent/test','packages/coding-agent/examples','packages/coding-agent/docs','packages/coding-agent/dist'
   $paths | ForEach-Object {
     $p = Resolve-Path $_
     $acl = Get-Acl $p
     $rule = New-Object System.Security.AccessControl.FileSystemAuditRule('Everyone','Delete','ContainerInherit,ObjectInherit','None','Success')
     $acl.AddAuditRule($rule)
     Set-Acl $p $acl
   }
   ```
4. Thu evidence: correlate Event 4663 (Delete, có `ProcessName` + `ObjectName`) với Event 4660
   qua `HandleId` — 4660 KHÔNG có ObjectName. Ví dụ lọc 1 dòng:
   `Get-WinEvent -FilterHashtable @{LogName='Security';Id=4663} | Where-Object { $_.Message -match 'coding-agent' } | Select-Object TimeCreated, Message | Format-List`
5. OFF khi xong (bắt buộc — log volume lớn): remove SACL rule tương tự với
   `$acl.RemoveAuditRule($rule)` cho từng path, rồi
   `auditpol /set /subcategory:"File System" /success:disable`.

### Publish flow — downtime chấp nhận có chủ đích

`prepublishOnly` và root `clean --workspaces` xoá cả `dist` (gồm live bundle + lock). Đây là
downtime CHẤP NHẬN — KHÔNG nằm trong cam kết fail-safe của cơ chế trên. Quy ước: đừng interrupt
giữa clean và build; đừng chạy clean concurrent với build. `clean` giờ chỉ xoá trong
`<package>/dist`/`.eval` (guard + `--force` để thoát có log); mutation ngoài boundary bị refuse.
Tương tự: CẤM chạy `build-li --record-tests` khi một build đang giữ lock — nó ghi receipt ngoài
protocol lock (race thấp nhưng thật; chờ build xong rồi chạy).

Take-over stale lock (launcher lẫn build-li) là rm-then-mkdir không atomic: hai process cùng thấy
stale có thể đua re-acquire trong ms — hậu quả bounded (rename nguyên tử, một bên thắng, bên kia
báo lỗi sạch); chấp nhận cho quy mô 1 máy 1 user, đừng chủ động đua lock.

### M2 — source-tree wipe (tracked files), KHÁC hoàn toàn P1

Nếu `git status --porcelain` thấy hàng loạt dòng ` D` (tracked file mất loạt — kiểu vụ 929 file
sáng 28/11):

```
git status --porcelain | head -30
git restore .
```

`git restore .` khôi phục tracked files; `dist/` gitignored nên không bị đụng — bundle live và
journal không ảnh hưởng. Đây là playbook cho source wipe; recovery bundle (`bundle.old-*`) chỉ lo
build artifacts, không lo source.

## Cài Li side-by-side trên ProDesk Linux

Pi ProDesk chạy release riêng tại `~/.local/prodesk-pi`; **không** dùng `pi_core_manager.py` hay `install-prodesk-pi.sh` để cài Li vì hai tool đó pin `pi` path/version. Li có root riêng `~/.local/prodesk-li`; `pi`, `~/.local/prodesk-pi/current`, services và `.pi` profile không bị thay thế.

**Tab spawn Li-first (từ SPEC-2026-11-18, 2026-11-19):** `~/.local/bin/prodesk-pi-launcher` mặc định exec Li wrapper (`~/.local/prodesk-li/bin/li`); set `PRODESK_TAB_RUNTIME=pi` để quay về Pi release. PTY/handle/session-title/argv contract giữ nguyên. Rollback launcher cũ nằm ở `~/.local/prodesk-pi-control/migration-backup-20261119T-li-first/`; source launcher tại laptop `app_presets/home_server/prodesk-pi-control/` (commit `d41e9805`).

Release là bundle Linux x64 có Node 22.19.0 hash-pin từ `python/app_presets/home_server/pi-agent/artifacts/artifact-lock.json`, Li dist/assets và external runtime modules cần thiết (`jiti`, `@silvia-odwyer/photon-node`). Packer refuse source dirty, output ghi đè, hash mismatch hoặc thiếu build receipt.

Trước build candidate, Pi ProDesk tạo snapshot private của toàn bộ `~/.pi` tại `~/.local/state/prodesk-li/profile-snapshots/<snapshot-id>/`:

```
set -euo pipefail
snapshot_id='prodesk-li-pre-<UTC timestamp>'
snapshot_root="$HOME/.local/state/prodesk-li/profile-snapshots"
snapshot_dir="$snapshot_root/$snapshot_id"
staging_dir="$snapshot_root/.staging-${snapshot_id}-$$"
test -d "$HOME/.pi"
test ! -L "$HOME/.pi"
test ! -e "$snapshot_dir"
test ! -e "$staging_dir"
for path in "$HOME/.local" "$HOME/.local/state" "$HOME/.local/state/prodesk-li" "$snapshot_root"; do
  test ! -L "$path"
done
umask 077
mkdir -p "$snapshot_root"
chmod 0700 "$HOME/.local/state/prodesk-li" "$snapshot_root"
mkdir -m 0700 "$staging_dir"
mkdir -m 0700 "$staging_dir/.pi"
file_count=$(find "$HOME/.pi" -type f -printf . | wc -c)
link_count=$(find "$HOME/.pi" -type l -printf . | wc -c)
socket_count=$(find "$HOME/.pi" -type s -printf . | wc -c)
rsync -rltp --checksum --quiet "$HOME/.pi/" "$staging_dir/.pi/" 2>"$staging_dir/rsync.stderr"
file_count_after=$(find "$HOME/.pi" -type f -printf . | wc -c)
staged_file_count=$(find "$staging_dir/.pi" -type f -printf . | wc -c)
staged_link_count=$(find "$staging_dir/.pi" -type l -printf . | wc -c)
test "$file_count" = "$file_count_after"
test "$file_count" = "$staged_file_count"
test "$link_count" = "$staged_link_count"
check_delta() {
  set +e
  delta_summary=$(rsync -nrltpc --out-format='%i' "$HOME/.pi/" "$staging_dir/.pi/" 2>>"$staging_dir/rsync.stderr" | awk 'tolower($0) ~ /skipping non-regular file/ { skipped++; next } $0 == ".d..t......" { directory_time++; next } NF { changed++ } END { printf "%d %d %d\n", changed, skipped, directory_time }')
  delta_rc=$?
  set -e
  [ "$delta_rc" -eq 0 ] || return "$delta_rc"
  set -- $delta_summary
  change_count=${1:-0}
  socket_skip_count=${2:-0}
  directory_time_drift=${3:-0}
}
check_delta || { echo 'BLOCKED: rsync checksum verification failed; staging retained.'; exit 1; }
if [ "$change_count" -gt 0 ]; then
  rsync -rltp --checksum --quiet "$HOME/.pi/" "$staging_dir/.pi/" 2>>"$staging_dir/rsync.stderr"
  file_count_after=$(find "$HOME/.pi" -type f -printf . | wc -c)
  staged_file_count=$(find "$staging_dir/.pi" -type f -printf . | wc -c)
  test "$file_count" = "$file_count_after" && test "$file_count" = "$staged_file_count"
  check_delta || { echo 'BLOCKED: second rsync checksum verification failed; staging retained.'; exit 1; }
fi
file_count_after=$(find "$HOME/.pi" -type f -printf . | wc -c)
link_count_after=$(find "$HOME/.pi" -type l -printf . | wc -c)
socket_count_after=$(find "$HOME/.pi" -type s -printf . | wc -c)
staged_file_count=$(find "$staging_dir/.pi" -type f -printf . | wc -c)
staged_link_count=$(find "$staging_dir/.pi" -type l -printf . | wc -c)
test "$file_count" = "$file_count_after" && test "$file_count" = "$staged_file_count"
test "$link_count" = "$link_count_after" && test "$link_count" = "$staged_link_count"
test "$socket_count" = "$socket_count_after"
test "$change_count" -eq 0
test "$socket_skip_count" = "$socket_count"
rm -f "$staging_dir/rsync.stderr"
tar -czf "$staging_dir/profile.tar.gz" -C "$staging_dir" .pi
tar -tzf "$staging_dir/profile.tar.gz" >/dev/null
snapshot_sha=$(sha256sum "$staging_dir/profile.tar.gz" | awk '{print $1}')
snapshot_size=$(stat -c '%s' "$staging_dir/profile.tar.gz")
rm -rf "$staging_dir/.pi"
python3 - "$staging_dir/snapshot.json" "$snapshot_id" "$file_count" "$link_count" "$socket_count" "$directory_time_drift" "$snapshot_sha" "$snapshot_size" <<'PY'
import json, sys
from datetime import datetime, timezone
path, snapshot_id, file_count, link_count, socket_count, directory_time_drift, digest, size = sys.argv[1:]
# Numeric receipt fields must be JSON numbers, not strings (argv is always
# str): verifiers compare counts/size with int arithmetic and a string receipt
# makes every equality check false (seen 2026-11-19 on the v1.5.2 snapshot).
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'snapshot_id': snapshot_id, 'source_path': '.pi', 'file_count': int(file_count), 'symlink_count': int(link_count), 'socket_count_skipped': int(socket_count), 'directory_time_drift_count': int(directory_time_drift), 'archive_sha256': digest, 'archive_size_bytes': int(size), 'created_at': datetime.now(timezone.utc).isoformat()}, f, indent=2)
    f.write('\n')
PY
chmod 0600 "$staging_dir/profile.tar.gz" "$staging_dir/snapshot.json"
mv "$staging_dir" "$snapshot_dir"
```

Snapshot directory `0700`; receipt ghi `snapshot_id`, `source_path: .pi`, regular-file/symlink/socket counts, directory-mtime-only drift, archive size và SHA-256. Chỉ báo PASS/count/size/hash-match status; không in file names, archive hash hay nội dung profile ra chat/log. Đặt đúng ID vào `LI_PROFILE_SNAPSHOT_ID` khi build để receipt Li trỏ tới backup thật.

Installer đọc count fields (`file_count`, `runtime_file_count`) qua `read_json_scalar` — chấp nhận cả JSON number lẫn numeric string; `snapshot_id`/`source_path`/hash vẫn phải string qua `read_json_string`.

Laptop, từ repo Li sạch:

```
$env:LI_PROFILE_SNAPSHOT_ID = "<snapshot-id>"
node scripts/build-li.mjs --offline
node scripts/package-prodesk-li.mjs --output packages/coding-agent/dist/prodesk-li-release
```

Transfer cả output directory `prodesk-li-release` qua fixed laptop→ProDesk lane; nó chứa artifact lock, hai archive, installer và isolated verification fixture. Chạy `node --test verification/scripts/install-prodesk-li.test.mjs` trên ProDesk để test install/rollback trong temp HOME (không chạm production Pi/profile), rồi readiness và install user-local:

```
node --test <staged-bundle>/verification/scripts/install-prodesk-li.test.mjs
bash <staged-bundle>/install-prodesk-li.sh --bundle-dir <staged-bundle> --check-readiness --yes
bash <staged-bundle>/install-prodesk-li.sh --bundle-dir <staged-bundle> --yes
~/.local/prodesk-li/bin/li --version
```

Installer verify snapshot receipt + SHA, Node/runtime archive, source commit, external imports và staged `--version`/`--help` với HOME tạm trước khi đổi Li `current` atomic. Nếu `~/.local/bin/li` chưa có, nó tạo symlink; PATH login không được chỉnh tự động, nên absolute path luôn là đường gọi chắc chắn. Rollback chỉ đổi Li pointer:

```
bash install-prodesk-li.sh --rollback --yes
```

Li vẫn dùng shared `~/.pi/agent`; chỉ mở interactive sau khi snapshot PASS. Không chạy Pi và Li đồng thời trên cùng session file.

## Quy trình xét update upstream (compare → candidate → promote)

### Bước 0 — Dual-channel upstream check (2026-11-19, SPEC-2026-11-19)

Trước khi vào các bước dưới, chạy checker hai kênh (read-only, không fetch, không đụng refs):

```
node scripts/upstream-check.mjs          # report human: release + main hai khối riêng
node scripts/upstream-check.mjs --json   # cho agent đọc
```

- Release channel = tag chính thức (tag chỉ gắn cho kênh release); main channel = full SHA snapshot
  — tuyệt đối không in `vX.Y.Z` cạnh SHA của main (erratum v1.5.2 = tag, tích hợp 05fd là main snapshot).
- Cursor/decisions đọc từ `docs/upstream-decisions/ledger.json` (schema: `scripts/upstream-decisions.schema.json`).
- Policy mặc định: target để lập plan là **release tag**. Main được soi để phát hiện fix sớm;
  owner chọn full release / full main snapshot / backport chọn lọc — lựa chọn không tự tạo quyền merge.
- Sau owner chốt: ghi quyết định vào ledger bằng
  `node scripts/upstream-check.mjs --record --decision-file <file.json>`
  (tự validate + cập nhật cursors + sinh receipt draft trong `docs/maintenance-receipts/`; commit tay).
- `reviewed_skipped` PHẢI có `revisit_condition` — skipped ≠ integrated (cherry-pick/backport không
  tiến merge-base, cursor ancestry không tự avance).

Mỗi lần xét update là thủ công, có review. Không auto-merge vào `li/stable`.

1. **Xác nhận default branch fork vẫn là `main`:**
   `py -3.13 D:\pcloud\workspace\code\python\quoc.py --github-repo-info nguyendinhquocx/pi-mono --json`
   → `default_branch` phải là `main`. Nếu khác → DỪNG (sync workflow bám default branch).
2. **Kiểm fork sync status:**
   `py -3.13 D:\pcloud\workspace\code\python\quoc.py --github-fork-sync-status --user nguyendinhquocx --json`
   Nếu fork còn behind upstream → DỪNG, chờ user chọn target SHA hoặc main sync xong.
3. **Fetch và diff:**
   `git fetch origin main`
   `git log --oneline li/stable..origin/main`
   Không có gì đáng lấy → ghi no-op, giữ Li nguyên.
4. **Pin full target SHA** (không dùng `latest`, không dùng branch mutable). Đọc release
   notes/changelog + diff từ base Li: `git diff li/stable..origin/main -- <changed paths>`.
   Sinh plan/matrix/receipt draft tự động: `node scripts/upstream-merge.mjs --target <sha|tag>
   --channel <release-tag|main-snapshot|selected-backports> [--backports <sha,...>]` — channel
   BẮT BUỘC khi có --target; `--dry-run` không fetch/không thêm remote; main-snapshot yêu cầu
   full SHA 40; selected-backports không merge ancestry (cherry-pick + ledger riêng).
5. **Merge vào candidate `li/next`** (tạo từ `li/stable`):
   ```
   git worktree add ..\pi-mono-next li/next   (nếu chưa có)
   git -C ..\pi-mono-next merge --no-ff <target-sha>
   ```
   Resolve conflict theo quyết định rõ ràng; không rebase mù.
6. **Chạy gates trên candidate:** `npm ci --ignore-scripts`, `node scripts/build-li.mjs --offline`,
   `npm run check`, `bash ./test.sh`, chạy lại test files Li (`test/li-*.test.ts`), smoke
   `li --version` + mở TUI.
   - Trước `npm run check`: nếu deps đổi → regen install-lock (`node scripts/generate-coding-agent-install-lock.mjs`)
     nếu không `check:install-lock` FAIL chắc chắn (upstream đổi deps, vd pi-schema mới).
   - `npm run check`/`tsc`: drift `packages/ai/test` catalog-upstream (model id trong test ≠ catalog) là residual
     đã biết — chỉ FAIL khi lỗi rơi ngoài nhóm đã biết.
   - Smoke TUI PHẢI chạy profile cô lập: `PI_CODING_AGENT_DIR=<temp-profile>` rồi mở TUI candidate — CẤM mở TUI
     candidate trên profile thật trước promote (upstream có thể mang migration session/config mutate
     `~/.pi/agent` dùng chung Pi+Li; snapshot profile chỉ là recovery, không phải phòng ngừa).
7. **Promote (thứ tự cứng, không đảo):** `li/stable` fast-forward tới candidate sau khi mọi gate PASS, rồi:
   1. Snapshot `~/.pi` (robocopy ACL user-only) + verify độc lập counts/SHA TRƯỚC bước sau.
   2. `LI_PROFILE_SNAPSHOT_ID=<snapshot-id>` rồi rebuild worktree chính — build-li đọc env LÚC BUILD;
      build trước snapshot → receipt `profileSnapshotId: null`, phải build lại.
   3. **T20 re-approve checklist (vụ 12/11: bỏ bước này gate đóng 2 ngày):** backup `registry.json` +
      `t20-canary-receipt.json` thành `*.bak` → đọc `artifactHash` từ `li-build-receipt.json` mới → cập nhật
      `t20-canary-receipt.json` (`artifact_sha256` mới) → `t20_receipt_sha256 = SHA256(toàn bộ nội dung canary file)`
      → cập nhật `registry.json` (`approved_builds[].artifact_sha256` + `t20_receipt_sha256`).
   4. Verify khớp chéo: `li --version` == receipt `artifactHash` == canary `artifact_sha256` == registry;
      `t20_receipt_sha256` == SHA256(canary). Lệch bất kỳ cặp nào → `/trim` refuse `promotion_required`.
   5. Diff catalog candidate vs backup — Li entries (Terra, các hide riêng) không mất.
   Ghi receipt vào `<repo>/docs/maintenance-receipts/<date>-<target-short-sha>.md` (template skill
   `upstream-maintenance`; sinh draft sẵn từ `scripts/upstream-merge.mjs`): default branch, base SHA, target SHA,
   changed paths, expected conflicts/resolutions, verify results, backup IDs, rollback SHA, artifact hash.

### Conflict surface đã biết (ưu tiên soi khi merge upstream)

- `packages/coding-agent/package.json` — `piConfig` (`name: li`), `bin` (`li`), version
- `packages/coding-agent/src/config.ts` — identity/env helpers nếu upstream đụng
- `packages/coding-agent/src/main.ts` — `applyLiRuntimeEnv()` bootstrap + session guard catch
- `packages/coding-agent/src/package-manager-cli.ts` — `rejectLiSelfUpdate()` / shared-cache warnings
- `packages/coding-agent/src/core/session-manager.ts` — `KNOWN_SESSION_ENTRY_TYPES`,
  `UnsupportedSessionVersionError`, `UnknownSessionEntryTypeError`, validator trong
  `loadEntriesFromFile`; nếu upstream thêm entry type mới thì thêm vào allowlist SAU KHI hiểu
  ngữ nghĩa và có projection test
- `packages/coding-agent/src/core/extensions/loader.ts`, `virtual-modules.ts` — bundled module map
- `packages/coding-agent/src/migrations.ts` — Windows `basename()` fix (có thể upstream đã fix riêng)
- `scripts/build-coding-agent-bundle.mjs`, `scripts/build-li.mjs`, `bin/li.cmd`
- Extension spawn/OSC (source ở `D:\pcloud\workspace\code\python\app_presets\pi\extensions\`):
  `shared/resolve-runtime-cli.ts`, `subagent-tab/index.ts`, `handoff/index.ts`,
  `peer-sessions/parent-launcher.ts`, `pi-osc-patch-guard/index.ts`

## UAT trước khi chấp nhận coexistence

- Từ cùng CWD, chạy `li` rồi `pi`; xác nhận cùng profile/session list nhưng identity/version riêng, và không mở cùng session file đồng thời.
- Từ Li chạy `subagent_tab`, handoff và peer parent launch; child phải chạy Li, không dùng Pi global CLI.
- Chạy `li update` và xác nhận bị từ chối trước mọi package-manager side effect; `pi --version` vẫn là Pi global.
- Chạy Pi-absent smoke trên fixture profile với `APPDATA`/`PATH` cô lập; mọi child command line vẫn trỏ Li. Chỉ sau các bước này mới cân nhắc gỡ Pi thật.

## Rollback

Hai gate riêng, đừng lộn:

1. **Rollback executable Li:** checkout lại worktree `li/stable` ở SHA cũ đã biết tốt
   (`git -C D:\pcloud\workspace\code\pi-mono-li checkout <rollback-sha>` — chỉ khi user yêu cầu;
   mặc định giữ branch), rebuild, receipt mới ghi đúng SHA. Wrapper `li.cmd` không cần đổi.
2. **Rollback shared state (profile):** profile `~/.pi/agent` là dùng chung — mọi mutation
   migration chạy lần đầu khi Li boot. Trước lần chạy Li đầu tiên trên profile thật, tạo
   recovery snapshot NGOÀI repo, ACL user-only:
   ```
   robocopy "%USERPROFILE%\.pi" "%USERPROFILE%\.pi-snapshot-<date>" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
   icacls "%USERPROFILE%\.pi-snapshot-<date>" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"
   ```
   Verify snapshot (đếm file + hash auth.json/settings.json) rồi mới chạy Li trên profile thật.
   Không log/upload nội dung auth. Restore = xoá/thay ngược thư mục sau khi Pi và Li đều đóng.

## Ranh giới cần nhớ

- Pi và Li chia sẻ auth, settings, extension packages, model catalogs, sessions. Update extension
  package từ bên nào cũng ảnh hưởng bên kia (`li update --extensions` đã cảnh báo).
- Không mở cùng một session file trong hai runtime cùng lúc (cùng append JSONL, không có
  cross-process writer lock). Cần song song → tạo session riêng.
- Session mới hơn format Li (header version cao hơn) → Li từ chối mở, giữ file nguyên; mở bằng
  Pi mới hơn. Không "sửa hộ" file đó bằng tay.
- `li update` (mọi biến thể) bị chặn trong code; `PI_SKIP_VERSION_CHECK=1` của wrapper chỉ tắt
  nag, không phải cơ chế guard.

## Telegram follow-up setting (SPEC-2026-11-09)

- Li-only hàng "Telegram follow-up" trong `/settings` (Pi không thấy): master On/Off + ba delay (final/ask/terminal, preset Off + 1/3/5/10/15/30/60m, mặc định 10m/5m/5m) + status row (`Ready`/`Err <code>`/`Unknown`/`No bridge`).
- Policy canonical nằm ở `global-policy.json` dưới supervisor root (`%APPDATA%\telepi\supervisor`, override `TELEPI_SUPERVISOR_DIR`) — KHÔNG nằm trong `.pi/settings.json`; mọi session Li đang mở thấy thay đổi trong ≤1 giây, không restart.
- Bật master được chỉ khi `global-status.json` báo TelePi protocol v2 + heartbeat ≤45 giây; thiếu → giữ Off, status `No bridge`. Mismatch/read failure fail-closed.
- Chỉ session Li (`LI_RUNTIME=1`) phát protocol v2 event; Pi thường giữ nguyên v1 `/tele`. Đổi policy không cần restart; đổi code extensions/TelePi theo deploy order trong README TelePi (TelePi v2 trước, extensions sau, global giữ Off tới smoke xong).
- Build/verify không đổi: `npm run check` + `node scripts/build-li.mjs --offline`; focused tests `test/settings-selector.test.ts`, `test/li-telegram-follow-up-policy.test.ts`.
