# Receipt: Gitdir inversion + dọn checkout dư (2026-11-19)

## Bối cảnh

Sau Li v1.5.2 (T10 DONE, tip `2f8aec7c59` pushed trên `li/stable` + `li/next`), còn 2 checkout dư:
- `pi-mono-next` — candidate worktree, branch `li/next` @ `2f8aec7c59` = đúng remote, tracked clean, artifact build `86dae…` KHÔNG T20-approved.
- `pi-mono` — checkout upstream cũ, `main` @ `a5879e34` behind `origin/main` 649 commit, tracked clean.

Owner duyệt xoá cả hai, giữ `pi-mono-li` canonical.

## Phát hiện quan trọng trước khi xoá

`git worktree list` từ `pi-mono-li` liệt kê `pi-mono` ĐẦU TIÊN (main worktree luôn đứng đầu).
Kiểm tra: `pi-mono/.git` là **thư mục**, `pi-mono-li/.git` là **file 67 byte** trỏ sang
`pi-mono/.git/worktrees/pi-mono-li`.

→ Quan hệ NGƯỢC với tên gọi: `pi-mono` mới là main worktree chứa toàn bộ object database
(284 MB objects/refs) và refs của cả repo Li. Xoá `pi-mono` nguyên trạng sẽ làm vỡ `pi-mono-li`.

`extensions.worktreeConfig` không bật; per-worktree refs rỗng; chỉ có per-worktree `index`,
`logs/HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `COMMIT_EDITMSG`.

## Hành động

1. Xoá `pi-mono-next`: `git worktree remove` (guard) — metadata gỡ OK, xoá thư mục lỗi vì
   ignored content (`node_modules`/`dist`) → xoá thư mục mồ côi bằng `Remove-Item -Recurse`
   sau khi xác nhận không process nào dùng (`Get-CimInstance Win32_Process` = NO_PROCESS_MATCH).
2. Invert gitdir cho `pi-mono-li`:
   - Staging `.git` mới ở `D:\pcloud\workspace\code\.li-git-invert-tmp\.git`:
     copy full `pi-mono/.git` trừ `worktrees/`, rồi ghép `index` + `logs/HEAD` + `ORIG_HEAD` +
     `FETCH_HEAD` + `COMMIT_EDITMSG` từ admin entry, ghi `HEAD = ref: refs/heads/li/stable`.
   - Verify staging: `fsck` exit 0 (chỉ dangling từ rebase/amend); 18/19 key SHAs tồn tại
     (`999e20d7` thuộc repo extension/toolkit khác, không phải repo này); `branch -a` đủ 6 local
     + 7 remote refs; `rev-parse HEAD` = `2f8aec7c59`.
   - Cutover: rename `.git` (file) → `.git-old-pointer` (rollback anchor), rename staging vào chỗ.
3. Deregister: xoá admin entry `pi-mono/.git/worktrees/pi-mono-li` + `git worktree prune`.
   `pi-mono` trở thành standalone clone (main @ `a5879e34`, clean).
4. Xoá `pi-mono` (`Remove-Item -Recurse`, owner-approved). Xoá rollback anchor `.git-old-pointer`
   + staging dir rỗng.

## Verify sau cùng

- `pi-mono-li`: standalone, worktree list chỉ chính nó, `status` clean, HEAD `2f8aec7c59`,
  `ls-remote origin` khớp `li/stable` = `li/next` = `2f8aec7c59`.
- Runtime: `li --version` = `li 1.5.2 (source 4ce99add2f)` — bundle T20-approved không bị đụng.
- Thư mục `D:\pcloud\workspace\code\` chỉ còn `pi-mono-li`.
- Disk thu hồi ~1.02 GB (next ~677 MB + mono ~339 MB).

## Bài học

- `git worktree list` in main worktree đầu tiên — dùng tín hiệu này + kiểm tra `.git` là file hay
  thư mục TRƯỚC khi xoá bất kỳ checkout nào trong cụm cùng nguồn gốc.
- Nhánh local "not merged into origin/HEAD" (vd `li/next` vs `origin/main`) là SKIP đúng của
  lane-clean, nhưng vẫn xoá được worktree khi HEAD trùng remote đã push — cần verify remote SHA
  trước, không dùng verdict merge làm gate duy nhất.
