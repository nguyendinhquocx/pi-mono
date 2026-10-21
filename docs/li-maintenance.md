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
| Wrapper command | `bin/li.cmd` trong worktree |
| User PATH entry | `D:\pcloud\workspace\code\pi-mono-li\bin` — không copy `li.cmd` ra chỗ khác vì `LI_ROOT` được tính từ thư mục wrapper |
| Li CLI entry | `packages/coding-agent/dist/bundle/cli.js` (generated) |
| Build receipt | `packages/coding-agent/dist/li-build-receipt.json` (generated) |
| Profile dùng chung | `~/.pi/agent` (`configDir` giữ `.pi`; Pi và Li chia sẻ) |

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
artifact hash. `li --version` đọc receipt này (`li <base-version> (source <short-sha>)`).
Trước lần boot đầu trên profile thật, snapshot `.pi` xong phải rebuild kèm snapshot ID để provenance
receipt truy được đúng bản backup:

```
$env:LI_PROFILE_SNAPSHOT_ID = "pi-snapshot-2026-10-20-pre-li"
node scripts/build-li.mjs --offline
```

Thay ID bằng tên snapshot thực tế. Source bẩn (uncommitted) → build vẫn chạy nhưng receipt đánh dấu
`gitDirty: true` — đó là candidate, KHÔNG dùng làm runtime ổn định. Li shell tool bỏ runtime routing
vars trước khi chạy lệnh ngoài; gọi `li` từ shell sẽ thiết lập lại chúng qua wrapper. Nếu OSC guard
patch bundle Li lần đầu, nó ghi file + SHA trước/sau vào
`packages/coding-agent/dist/li-osc-patch-receipt.json`; Pi global dist không được chạm.

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
