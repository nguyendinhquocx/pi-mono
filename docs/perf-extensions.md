# Li performance runbook — đo và tối ưu startup/extension

Runbook cho agent: đo hiệu năng Li startup, quy lỗi extension nặng, quyết định fix. Sinh từ SPEC-2026-11-27-li-perf (commits `4ac339c3cc`, `8165070178`, `9145ecd0b9`).

## Nguyên tắc

- Đo trước, vá sau — không tối ưu theo cảm tính.
- So sánh phải in-pair (cùng thời điểm, cùng điều kiện) — warm drift làm số tuyệt đối lệch ±15%.
- Per-import wall-clock là upper bound khi parallel (single-thread interleave phình số) — dùng ext TOTAL làm số thật.

## Protocol 1 — Đo startup (PI_TIMING)

```
PI_TIMING=1 li -p "reply ok" 3>&1 | grep -E "TOTAL|resources"
```

- Chạy ×3 lấy median. Đọc: `main TOTAL` (toàn bộ), `extensions` section (per-ext import ms), `resources` section (skills/prompts/AGENTS chain), `WALL TOTAL` (chỉ upper bound).
- Instrumentation gốc: `timings.ts` (`TimingLabel`, `recordImportWallTime`), bọc trong `resource-loader.ts` `reload()` — `/new` `/resume` `/reload` cũng in timings nhờ `flushTimings`.

## Protocol 2 — Cô lập biến nghi (isolation)

```
TP=$(cygpath -w "$TEMP/li-perf-profile")
mkdir -p "$TEMP/li-perf-profile/extensions"
LI_CODING_AGENT_DIR="$TP" PI_TIMING=1 li -p "reply ok"
```

- Profile rỗng = floor của runtime (~220-300ms). Cộng từng nhóm (1 extension, skills, mcp.json) để quy lỗi %.
- CẤM copy junction bằng robocopy thường (`/E` đuổi vòng symlink treo vô hạn) — dùng `/E /XJ` hoặc bỏ node_modules.
- Xoá profile temp sau khi xong; không đụng `~/.pi` thật.

## Protocol 3 — Snapshot hành vi (tránh regression)

```
LI_EXT_SNAPSHOT=%TEMP%/snap.json li -p "reply ok"
```

- Serialize `LoadExtensionsResult` (paths + tools/commands/flags + errors) ra JSON; diff before/after sau refactor = phải identical trừ thời gian.

## Protocol 4 — Forensics process (treo/lag lúc chạy)

- PowerShell `Get-CimInstance Win32_Process` parent-chain cho sh.exe/esbuild/workerd; census kiểu này chỉ đáng tin lúc đó (transient).
- Lưu ý: workerd/esbuild KHÔNG phải Li core (Li dùng jiti/Babel) — thấy thì truy parent, thường là dev server do agent bash session để treo.

## Budget extension mới

- Module import wall-clock lúc start **≤100ms**. Vượt → bắt buộc lazy-load.
- Kiểm: `PI_TIMING=1` xem dòng extension mình trong section extensions.

## Mẫu lazy-load (khi vượt budget)

- Registration/model catalog giữ **sync** lúc start (Print/RPC resolve `--model` từ catalog TRƯỚC khi handler chạy — see pi-antigravity `index.ts:188-239`, `compat.ts:128` sync void).
- SDK-heavy chuyển `await import()` **bên trong** stream/handler function; không async-register.
- Case study: pi-antigravity (SPEC T6) — 3771ms → mục tiêu ≤300ms.

## Số liệu tham chiếu (2026-11-27, laptop Windows, warm median ×3)

| Hạng mục | Trước | Sau T1-T4 |
| --- | --- | --- |
| main TOTAL | 6911ms | 2946ms |
| ext TOTAL | 6207ms | 1569ms |
| skills scan warm | ~175ms | 14-19ms (cache T3) |
| import-repro.ts | 81-118ms/boot | đã xoá |

- Sweep concurrency: cap1 2375 / cap2 1810 / cap4 2067 / cap8 1772ms → giữ cap 8.
- Escape hatch: `LI_EXT_IMPORT_SEQUENTIAL=1` (tuần tự, debug regression side-effect order).
- Lưu ý side-effect: top-level code giữa các extension chạy song song mất determinism thứ tự — registration chính nằm ở factory (tuần tự) nên an toàn; tránh thêm top-level cross-extension side effect.
- Cold vs warm: cold ~13s vs warm ~6s trước tối ưu — Defender scan từng file lần đầu; exclusion path (owner admin) thu hẹp gap.
