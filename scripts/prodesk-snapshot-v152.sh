#!/usr/bin/env bash
# ProDesk profile snapshot per docs/li-maintenance.md (v1.5.2 upstream promote, 2026-11-18)
set -euo pipefail
snapshot_id='prodesk-li-pre-20261119T020701Z'
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
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'snapshot_id': snapshot_id, 'source_path': '.pi', 'file_count': file_count, 'symlink_count': link_count, 'socket_count_skipped': socket_count, 'directory_time_drift_count': directory_time_drift, 'archive_sha256': digest, 'archive_size_bytes': size, 'created_at': datetime.now(timezone.utc).isoformat()}, f, indent=2)
    f.write('\n')
PY
chmod 0600 "$staging_dir/profile.tar.gz" "$staging_dir/snapshot.json"
mv "$staging_dir" "$snapshot_dir"
echo "SNAPSHOT_DONE id=$snapshot_id files=$file_count links=$link_count sockets=$socket_count drift=$directory_time_drift size=$snapshot_size"
