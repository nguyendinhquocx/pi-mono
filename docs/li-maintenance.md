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
| Build receipt | `packages/coding-agent/dist/li-build-receipt.json` (generated) |
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

`build-li.mjs` ghi receipt với: full HEAD SHA, base Pi version, source tree hash, Node version,
artifact hash. Trước khi hash, build neutralize `TERMINAL_COLOR_QUERY` ngay trong Li bundle và ghi
`li-osc-patch-receipt.json` với SHA trước/sau; runtime guard không cần vá bundle Li lúc mở session.
`li --version` đọc receipt này (`li <base-version> (source <short-sha>)`).
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

## Cài Li side-by-side trên ProDesk Linux

Pi ProDesk chạy release riêng tại `~/.local/prodesk-pi`; **không** dùng `pi_core_manager.py` hay `install-prodesk-pi.sh` để cài Li vì hai tool đó pin `pi` path/version. Li có root riêng `~/.local/prodesk-li`; `pi`, `~/.local/prodesk-pi/current`, services và `.pi` profile không bị thay thế.

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
  delta_summary=$(rsync -nrltpc --out-format='%i' "$HOME/.pi/" "$staging_dir/.pi/" 2>>"$staging_dir/rsync.stderr" | awk 'tolower($0) ~ /skipping non-regular file/ { skipped++; next } NF { changed++ } END { printf "%d %d\n", changed, skipped }')
  delta_rc=$?
  set -e
  [ "$delta_rc" -eq 0 ] || return "$delta_rc"
  set -- $delta_summary
  change_count=${1:-0}
  socket_skip_count=${2:-0}
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
python3 - "$staging_dir/snapshot.json" "$snapshot_id" "$file_count" "$link_count" "$socket_count" "$snapshot_sha" "$snapshot_size" <<'PY'
import json, sys
from datetime import datetime, timezone
path, snapshot_id, file_count, link_count, socket_count, digest, size = sys.argv[1:]
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'snapshot_id': snapshot_id, 'source_path': '.pi', 'file_count': file_count, 'symlink_count': link_count, 'socket_count_skipped': socket_count, 'archive_sha256': digest, 'archive_size_bytes': size, 'created_at': datetime.now(timezone.utc).isoformat()}, f, indent=2)
    f.write('\n')
PY
chmod 0600 "$staging_dir/profile.tar.gz" "$staging_dir/snapshot.json"
mv "$staging_dir" "$snapshot_dir"
```

Snapshot directory `0700`; receipt ghi `snapshot_id`, `source_path: .pi`, file count, archive size và SHA-256. Chỉ báo PASS/file count/size/hash-match status; không in file names, archive hash hay nội dung profile ra chat/log. Đặt đúng ID vào `LI_PROFILE_SNAPSHOT_ID` khi build để receipt Li trỏ tới backup thật.

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
5. **Merge vào candidate `li/next`** (tạo từ `li/stable`):
   ```
   git worktree add ..\pi-mono-next li/next   (nếu chưa có)
   git -C ..\pi-mono-next merge --no-ff <target-sha>
   ```
   Resolve conflict theo quyết định rõ ràng; không rebase mù.
6. **Chạy gates trên candidate:** `npm ci --ignore-scripts`, `node scripts/build-li.mjs --offline`,
   `npm run check`, `bash ./test.sh`, chạy lại test files Li (`test/li-*.test.ts`), smoke
   `li --version` + mở TUI.
7. **Promote:** `li/stable` fast-forward tới candidate sau khi mọi gate PASS, rồi rebuild ở
   worktree chính. Ghi receipt: default branch, base SHA, target SHA, changed paths, expected
   conflicts/resolutions, verify results, rollback SHA.

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
