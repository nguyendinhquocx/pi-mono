#!/bin/sh
# install-prodesk-li.sh — user-local, side-by-side Li runtime for ProDesk.
# It never replaces the existing Pi core or touches the shared profile.
set -eu

PROG_NAME="install-prodesk-li.sh"
PINNED_NODE_VERSION="22.19.0"
ARG_BUNDLE_DIR=""
ARG_YES=0
ARG_CHECK_READINESS=0
ARG_ROLLBACK=0

print_usage() {
	cat <<USAGE
$PROG_NAME — install a verified Li release beside Pi in the current user's home.

Required for install/readiness:
  --bundle-dir PATH   Directory containing artifact-lock.json and both archives.
  --yes               Confirm the user-local install or readiness check.

Other:
  --check-readiness   Verify pins/snapshot only; do not extract or write.
  --rollback --yes    Switch Li current to the previous Li release.

No sudo, package manager, network, shell-profile edit, Pi-core replacement,
service, login, or shared-profile write is performed by this installer.
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--bundle-dir) ARG_BUNDLE_DIR=${2:-}; shift 2 || { echo "$PROG_NAME: --bundle-dir needs a value" >&2; exit 2; } ;;
		--yes) ARG_YES=1; shift ;;
		--check-readiness) ARG_CHECK_READINESS=1; shift ;;
		--rollback) ARG_ROLLBACK=1; shift ;;
		-h|--help) print_usage; exit 0 ;;
		*) echo "$PROG_NAME: unknown argument: $1" >&2; print_usage >&2; exit 2 ;;
	esac
done

CURRENT_UID=$(id -u 2>/dev/null || echo -1)
if [ "$CURRENT_UID" = "0" ]; then
	echo "$PROG_NAME: refusing to run as root; run as user quoc." >&2
	exit 2
fi
if [ "$ARG_YES" -ne 1 ]; then
	echo "$PROG_NAME: refusing without --yes." >&2
	exit 2
fi
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
	echo "$PROG_NAME: HOME is missing or not a directory." >&2
	exit 2
fi

RESOLVED_HOME=$(CDPATH= cd -- "$HOME" && pwd -P)
LOCAL_ROOT="$RESOLVED_HOME/.local"
INSTALL_ROOT="$LOCAL_ROOT/prodesk-li"
RELEASES_ROOT="$INSTALL_ROOT/releases"
CURRENT_LINK="$INSTALL_ROOT/current"
STABLE_SHIM="$INSTALL_ROOT/bin/li"
USER_BIN_DIR="$LOCAL_ROOT/bin"
USER_COMMAND_LINK="$USER_BIN_DIR/li"
SNAPSHOT_ROOT="$LOCAL_ROOT/state/prodesk-li/profile-snapshots"
PI_WRAPPER="$LOCAL_ROOT/bin/pi"

read_json_string() {
	field=$1
	json_file=$2
	sed -n "s/^[[:space:]]*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$json_file" | head -n 1
}

is_hex_64() {
	case "$1" in *[!a-f0-9]*|'') return 1 ;; esac
	[ "${#1}" -eq 64 ]
}

is_hex_40() {
	case "$1" in *[!a-f0-9]*|'') return 1 ;; esac
	[ "${#1}" -eq 40 ]
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		echo "$PROG_NAME: sha256sum or shasum is required." >&2
		return 2
	fi
}

check_owner_mode() {
	path=$1
	expected_mode=$2
	if [ -L "$path" ] || [ ! -e "$path" ]; then
		echo "$PROG_NAME: expected a real file/directory at $path." >&2
		return 1
	fi
	actual_mode=$(stat -c '%a' "$path" 2>/dev/null || true)
	actual_owner=$(stat -c '%u' "$path" 2>/dev/null || true)
	if [ "$actual_mode" != "$expected_mode" ] || [ "$actual_owner" != "$CURRENT_UID" ]; then
		echo "$PROG_NAME: unsafe owner/mode at $path (owner=$actual_owner mode=$actual_mode)." >&2
		return 1
	fi
}

verify_profile_snapshot() {
	SNAPSHOT_DIR="$SNAPSHOT_ROOT/$PROFILE_SNAPSHOT_ID"
	SNAPSHOT_ARCHIVE="$SNAPSHOT_DIR/profile.tar.gz"
	SNAPSHOT_RECEIPT="$SNAPSHOT_DIR/snapshot.json"
	[ -d "$SNAPSHOT_ROOT" ] || { echo "$PROG_NAME: required ProDesk profile snapshot is missing." >&2; return 1; }
	[ -d "$SNAPSHOT_DIR" ] || { echo "$PROG_NAME: snapshot ID in Li build receipt is missing on ProDesk." >&2; return 1; }
	check_owner_mode "$SNAPSHOT_ROOT" 700 || return 1
	check_owner_mode "$SNAPSHOT_DIR" 700 || return 1
	check_owner_mode "$SNAPSHOT_ARCHIVE" 600 || return 1
	check_owner_mode "$SNAPSHOT_RECEIPT" 600 || return 1

	SNAPSHOT_RECEIPT_ID=$(read_json_string snapshot_id "$SNAPSHOT_RECEIPT")
	SNAPSHOT_RECEIPT_SOURCE=$(read_json_string source_path "$SNAPSHOT_RECEIPT")
	SNAPSHOT_FILE_COUNT=$(read_json_string file_count "$SNAPSHOT_RECEIPT")
	SNAPSHOT_EXPECTED_SHA=$(read_json_string archive_sha256 "$SNAPSHOT_RECEIPT")
	is_hex_64 "$SNAPSHOT_EXPECTED_SHA" || { echo "$PROG_NAME: profile snapshot receipt SHA-256 is invalid." >&2; return 1; }
	[ "$SNAPSHOT_RECEIPT_ID" = "$PROFILE_SNAPSHOT_ID" ] || { echo "$PROG_NAME: profile snapshot ID does not match Li build receipt." >&2; return 1; }
	[ "$SNAPSHOT_RECEIPT_SOURCE" = ".pi" ] || { echo "$PROG_NAME: profile snapshot source must be .pi." >&2; return 1; }
	case "$SNAPSHOT_FILE_COUNT" in *[!0-9]*|'') echo "$PROG_NAME: profile snapshot file count is invalid." >&2; return 1 ;; esac
	[ "$SNAPSHOT_FILE_COUNT" -gt 0 ] || { echo "$PROG_NAME: profile snapshot is empty." >&2; return 1; }
	SNAPSHOT_ACTUAL_SHA=$(sha256_file "$SNAPSHOT_ARCHIVE") || return 1
	[ "$SNAPSHOT_ACTUAL_SHA" = "$SNAPSHOT_EXPECTED_SHA" ] || { echo "$PROG_NAME: profile snapshot archive hash mismatch." >&2; return 1; }
	tar -tzf "$SNAPSHOT_ARCHIVE" >/dev/null 2>&1 || { echo "$PROG_NAME: profile snapshot archive is unreadable." >&2; return 1; }
	if ! tar -tzf "$SNAPSHOT_ARCHIVE" 2>/dev/null | grep -q '^\.pi/'; then
		echo "$PROG_NAME: profile snapshot does not contain the .pi tree." >&2
		return 1
	fi
}

validate_bundle() {
	if [ -z "$ARG_BUNDLE_DIR" ] || [ ! -d "$ARG_BUNDLE_DIR" ]; then
		echo "$PROG_NAME: --bundle-dir must point to the staged Li artifact directory." >&2
		return 1
	fi
	BUNDLE_DIR=$(CDPATH= cd -- "$ARG_BUNDLE_DIR" && pwd -P)
	LOCK_FILE="$BUNDLE_DIR/artifact-lock.json"
	[ -f "$LOCK_FILE" ] || { echo "$PROG_NAME: artifact-lock.json is missing." >&2; return 1; }
	grep -Eq '^[[:space:]]*"schema_version"[[:space:]]*:[[:space:]]*1([,[:space:]]|$)' "$LOCK_FILE" || {
		echo "$PROG_NAME: unsupported artifact-lock schema." >&2
		return 1
	}

	LOCK_STATE=$(read_json_string state "$LOCK_FILE")
	RUNTIME_KIND=$(read_json_string runtime "$LOCK_FILE")
	SOURCE_COMMIT=$(read_json_string source_commit "$LOCK_FILE")
	PACKAGE_VERSION=$(read_json_string package_version "$LOCK_FILE")
	PROFILE_SNAPSHOT_ID=$(read_json_string profile_snapshot_id "$LOCK_FILE")
	NODE_VERSION=$(read_json_string node_version "$LOCK_FILE")
	NODE_FILENAME=$(read_json_string node_filename "$LOCK_FILE")
	NODE_EXPECTED_SHA=$(read_json_string node_sha256 "$LOCK_FILE")
	RUNTIME_FILENAME=$(read_json_string runtime_filename "$LOCK_FILE")
	RUNTIME_EXPECTED_SHA=$(read_json_string runtime_sha256 "$LOCK_FILE")
	RUNTIME_TREE_SHA=$(read_json_string runtime_tree_sha256 "$LOCK_FILE")
	RUNTIME_FILE_COUNT=$(read_json_string runtime_file_count "$LOCK_FILE")
	INSTALLER_FILENAME=$(read_json_string installer_filename "$LOCK_FILE")
	INSTALLER_EXPECTED_SHA=$(read_json_string installer_sha256 "$LOCK_FILE")

	[ "$LOCK_STATE" = "verified" ] || { echo "$PROG_NAME: artifact state is not verified." >&2; return 1; }
	[ "$RUNTIME_KIND" = "li-prodesk-linux-x64" ] || { echo "$PROG_NAME: artifact is not a ProDesk Linux x64 Li release." >&2; return 1; }
	is_hex_40 "$SOURCE_COMMIT" || { echo "$PROG_NAME: source commit is invalid." >&2; return 1; }
	printf '%s' "$PACKAGE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$' || { echo "$PROG_NAME: package version is invalid." >&2; return 1; }
	case "$PROFILE_SNAPSHOT_ID" in *[!A-Za-z0-9._-]*|'') echo "$PROG_NAME: profile snapshot ID is invalid." >&2; return 1 ;; esac
	[ "$NODE_VERSION" = "$PINNED_NODE_VERSION" ] || { echo "$PROG_NAME: unsupported Node version pin." >&2; return 1; }
	[ "$NODE_FILENAME" = "node-v22.19.0-linux-x64.tar.xz" ] || { echo "$PROG_NAME: Node artifact filename is not the approved Linux x64 pin." >&2; return 1; }
	[ "$RUNTIME_FILENAME" = "li-runtime-linux-x64-$(printf '%s' "$SOURCE_COMMIT" | cut -c1-10).tar.gz" ] || {
		echo "$PROG_NAME: Li runtime archive filename does not match source commit." >&2
		return 1
	}
	is_hex_64 "$NODE_EXPECTED_SHA" || { echo "$PROG_NAME: Node SHA-256 is invalid." >&2; return 1; }
	is_hex_64 "$RUNTIME_EXPECTED_SHA" || { echo "$PROG_NAME: Li runtime SHA-256 is invalid." >&2; return 1; }
	is_hex_64 "$RUNTIME_TREE_SHA" || { echo "$PROG_NAME: Li runtime tree SHA-256 is invalid." >&2; return 1; }
	case "$RUNTIME_FILE_COUNT" in *[!0-9]*|'') echo "$PROG_NAME: Li runtime file count is invalid." >&2; return 1 ;; esac
	[ "$RUNTIME_FILE_COUNT" -gt 0 ] || { echo "$PROG_NAME: Li runtime bundle is empty." >&2; return 1; }
	[ "$INSTALLER_FILENAME" = "install-prodesk-li.sh" ] || { echo "$PROG_NAME: installer filename is invalid." >&2; return 1; }
	is_hex_64 "$INSTALLER_EXPECTED_SHA" || { echo "$PROG_NAME: installer SHA-256 is invalid." >&2; return 1; }

	NODE_ARCHIVE="$BUNDLE_DIR/$NODE_FILENAME"
	RUNTIME_ARCHIVE="$BUNDLE_DIR/$RUNTIME_FILENAME"
	INSTALLER_FILE="$BUNDLE_DIR/$INSTALLER_FILENAME"
	[ -f "$NODE_ARCHIVE" ] || { echo "$PROG_NAME: pinned Node archive is missing." >&2; return 1; }
	[ -f "$RUNTIME_ARCHIVE" ] || { echo "$PROG_NAME: Li runtime archive is missing." >&2; return 1; }
	[ -f "$INSTALLER_FILE" ] || { echo "$PROG_NAME: verified installer file is missing." >&2; return 1; }
	INSTALLER_ACTUAL_SHA=$(sha256_file "$INSTALLER_FILE") || return 1
	[ "$INSTALLER_ACTUAL_SHA" = "$INSTALLER_EXPECTED_SHA" ] || { echo "$PROG_NAME: installer SHA-256 mismatch." >&2; return 1; }
	SCRIPT_SELF=$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")
	SCRIPT_SELF_SHA=$(sha256_file "$SCRIPT_SELF") || return 1
	[ "$SCRIPT_SELF_SHA" = "$INSTALLER_EXPECTED_SHA" ] || { echo "$PROG_NAME: running installer does not match the verified bundle copy." >&2; return 1; }
	NODE_ACTUAL_SHA=$(sha256_file "$NODE_ARCHIVE") || return 1
	RUNTIME_ACTUAL_SHA=$(sha256_file "$RUNTIME_ARCHIVE") || return 1
	[ "$NODE_ACTUAL_SHA" = "$NODE_EXPECTED_SHA" ] || { echo "$PROG_NAME: Node artifact SHA-256 mismatch." >&2; return 1; }
	[ "$RUNTIME_ACTUAL_SHA" = "$RUNTIME_EXPECTED_SHA" ] || { echo "$PROG_NAME: Li runtime SHA-256 mismatch." >&2; return 1; }
	verify_profile_snapshot || return 1
}

validate_runtime_archive_paths() {
	LIST_FILE=$(mktemp "${TMPDIR:-/tmp}/li-runtime-list.XXXXXX")
	chmod 0600 "$LIST_FILE"
	if ! tar -tzf "$RUNTIME_ARCHIVE" >"$LIST_FILE" 2>/dev/null; then
		rm -f "$LIST_FILE"
		echo "$PROG_NAME: Li runtime archive cannot be listed." >&2
		return 1
	fi
	while IFS= read -r member; do
		case "$member" in
			/*|..|../*|*/../*|*"/.."*|*\\*)
				rm -f "$LIST_FILE"
				echo "$PROG_NAME: Li runtime archive contains an unsafe path." >&2
				return 1
				;;
		esac
		case "$member" in
			li-runtime|li-runtime/*) ;;
			*)
				rm -f "$LIST_FILE"
				echo "$PROG_NAME: Li runtime archive has an unexpected top-level entry." >&2
				return 1
				;;
		esac
	done < "$LIST_FILE"
	rm -f "$LIST_FILE"
}

verify_runtime_tree() {
	"$STAGED_NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[1];
const expectedHash = process.argv[2];
const expectedCount = Number(process.argv[3]);
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory).sort()) {
    const fullPath = path.join(directory, entry);
    const info = fs.lstatSync(fullPath);
    if (info.isSymbolicLink()) throw new Error("runtime symlink refused");
    if (info.isDirectory()) { walk(fullPath); continue; }
    if (!info.isFile()) throw new Error("non-regular runtime entry refused");
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
    files.push(`${relativePath}:${digest}`);
  }
}
walk(root);
files.sort();
const actualHash = crypto.createHash("sha256").update(files.join("\n")).digest("hex");
if (files.length !== expectedCount || actualHash !== expectedHash) process.exit(1);
' "$STAGED_LI_ROOT" "$RUNTIME_TREE_SHA" "$RUNTIME_FILE_COUNT"
}

atomic_set_current() {
	target=$1
	temporary="$INSTALL_ROOT/.current.new-$$"
	rm -f "$temporary"
	if ! ln -s "$target" "$temporary" 2>/dev/null || ! mv -T "$temporary" "$CURRENT_LINK" 2>/dev/null; then
		rm -f "$temporary"
		echo "$PROG_NAME: atomic current switch failed; previous Li current remains unchanged." >&2
		return 1
	fi
	CURRENT_AFTER=$(readlink "$CURRENT_LINK" 2>/dev/null || true)
	[ "$CURRENT_AFTER" = "$target" ] || { echo "$PROG_NAME: current pointer verification failed." >&2; return 1; }
}

check_install_root() {
	if [ -L "$LOCAL_ROOT" ]; then
		echo "$PROG_NAME: refusing symlinked ~/.local root." >&2
		return 1
	fi
	if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; then
		[ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] || { echo "$PROG_NAME: install root is not a real directory." >&2; return 1; }
		check_owner_mode "$INSTALL_ROOT" 700 || return 1
	fi
	if [ -e "$RELEASES_ROOT" ] || [ -L "$RELEASES_ROOT" ]; then
		[ -d "$RELEASES_ROOT" ] && [ ! -L "$RELEASES_ROOT" ] || { echo "$PROG_NAME: releases root is not a real directory." >&2; return 1; }
		check_owner_mode "$RELEASES_ROOT" 700 || return 1
	fi
	if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
		echo "$PROG_NAME: current exists but is not a symlink." >&2
		return 1
	fi
	if [ -L "$CURRENT_LINK" ]; then
		CURRENT_BEFORE=$(readlink "$CURRENT_LINK")
		case "$CURRENT_BEFORE" in releases/*) ;; *) echo "$PROG_NAME: current points outside Li releases." >&2; return 1 ;; esac
		CURRENT_RELEASE="$INSTALL_ROOT/$CURRENT_BEFORE"
		[ -d "$CURRENT_RELEASE" ] && [ ! -L "$CURRENT_RELEASE" ] || { echo "$PROG_NAME: current release is missing or symlinked." >&2; return 1; }
	fi
}

check_user_command_link() {
	if [ -L "$USER_BIN_DIR" ]; then
		echo "$PROG_NAME: refusing symlinked ~/.local/bin directory." >&2
		return 1
	fi
	if [ -e "$USER_BIN_DIR" ] && [ ! -d "$USER_BIN_DIR" ]; then
		echo "$PROG_NAME: ~/.local/bin exists but is not a directory." >&2
		return 1
	fi
	if [ -e "$USER_COMMAND_LINK" ] || [ -L "$USER_COMMAND_LINK" ]; then
		if [ ! -L "$USER_COMMAND_LINK" ] || [ "$(readlink "$USER_COMMAND_LINK" 2>/dev/null || true)" != "$STABLE_SHIM" ]; then
			echo "$PROG_NAME: refusing to overwrite existing ~/.local/bin/li." >&2
			return 1
		fi
	fi
}

check_stable_shim() {
	if [ -L "$INSTALL_ROOT/bin" ]; then
		echo "$PROG_NAME: refusing symlinked Li bin directory." >&2
		return 1
	fi
	if [ -e "$INSTALL_ROOT/bin" ] && [ ! -d "$INSTALL_ROOT/bin" ]; then
		echo "$PROG_NAME: Li bin path is not a directory." >&2
		return 1
	fi
	if [ -e "$INSTALL_ROOT/bin" ] || [ -L "$INSTALL_ROOT/bin" ]; then
		[ -d "$INSTALL_ROOT/bin" ] && [ ! -L "$INSTALL_ROOT/bin" ] || { echo "$PROG_NAME: Li bin path is not a real directory." >&2; return 1; }
		check_owner_mode "$INSTALL_ROOT/bin" 700 || return 1
	fi
	if [ -e "$STABLE_SHIM" ] || [ -L "$STABLE_SHIM" ]; then
		if [ ! -L "$STABLE_SHIM" ] || [ "$(readlink "$STABLE_SHIM" 2>/dev/null || true)" != "../current/bin/li" ]; then
			echo "$PROG_NAME: refusing to overwrite an unknown Li shim." >&2
			return 1
		fi
	fi
}

ensure_stable_shim() {
	if [ ! -d "$INSTALL_ROOT/bin" ]; then
		mkdir -p "$INSTALL_ROOT/bin"
		chmod 0700 "$INSTALL_ROOT/bin"
	else
		check_owner_mode "$INSTALL_ROOT/bin" 700 || return 1
	fi
	if [ ! -e "$STABLE_SHIM" ] && [ ! -L "$STABLE_SHIM" ]; then
		ln -s "../current/bin/li" "$STABLE_SHIM" 2>/dev/null || {
			echo "$PROG_NAME: could not create stable Li launcher; use the release's bin/li directly." >&2
			return 1
		}
	fi
}

ensure_user_command_link() {
	if [ ! -d "$USER_BIN_DIR" ]; then
		mkdir -p "$USER_BIN_DIR"
		chmod 0700 "$USER_BIN_DIR"
	fi
	if [ ! -e "$USER_COMMAND_LINK" ] && [ ! -L "$USER_COMMAND_LINK" ]; then
		ln -s "$STABLE_SHIM" "$USER_COMMAND_LINK" 2>/dev/null || {
			echo "$PROG_NAME: could not create ~/.local/bin/li; use $STABLE_SHIM directly." >&2
			return 0
		}
	fi
}

rollback() {
	check_install_root || exit 1
	[ -L "$CURRENT_LINK" ] || { echo "$PROG_NAME: no Li current release to roll back." >&2; exit 1; }
	CURRENT_BEFORE=$(readlink "$CURRENT_LINK")
	CURRENT_NAME=${CURRENT_BEFORE##*/}
	PREVIOUS=""
	for release_path in $(ls -1d "$RELEASES_ROOT"/*/ 2>/dev/null | sort -r || true); do
		release_name=${release_path%/}
		release_name=${release_name##*/}
		[ "$release_name" = "$CURRENT_NAME" ] && continue
		[ -L "$RELEASES_ROOT/$release_name" ] && continue
		[ -x "$RELEASES_ROOT/$release_name/bin/li" ] || continue
		PREVIOUS="releases/$release_name"
		break
	done
	[ -n "$PREVIOUS" ] || { echo "$PROG_NAME: no previous Li release exists." >&2; exit 1; }
	if ! "$INSTALL_ROOT/$PREVIOUS/bin/li" --version >/dev/null 2>&1; then
		echo "$PROG_NAME: previous Li release failed its version smoke; current is unchanged." >&2
		exit 1
	fi
	atomic_set_current "$PREVIOUS"
	printf '%s\n' "$PROG_NAME: rollback PASS; current -> $PREVIOUS"
}

if [ "$ARG_ROLLBACK" -eq 1 ]; then
	[ "$ARG_CHECK_READINESS" -eq 0 ] || { echo "$PROG_NAME: --rollback and --check-readiness cannot be combined." >&2; exit 2; }
	[ -z "$ARG_BUNDLE_DIR" ] || { echo "$PROG_NAME: --bundle-dir is not used with --rollback." >&2; exit 2; }
	rollback
	exit 0
fi

validate_bundle || exit 1
if [ "$ARG_CHECK_READINESS" -eq 1 ]; then
	printf '%s\n' "$PROG_NAME: readiness PASS (bundle hashes + local profile snapshot verified)."
	printf '  Li source: %s\n  Li version: %s\n  Node: %s\n' "$SOURCE_COMMIT" "$PACKAGE_VERSION" "$NODE_VERSION"
	exit 0
fi

check_install_root || exit 1
check_stable_shim || exit 1
check_user_command_link || exit 1
[ -x "$PI_WRAPPER" ] || { echo "$PROG_NAME: expected user-local Pi wrapper is missing; refusing this ProDesk Li lane." >&2; exit 1; }
PI_VERSION_BEFORE=$("$PI_WRAPPER" --version 2>/dev/null || echo "unavailable")
PI_CURRENT_PATH="$RESOLVED_HOME/.local/prodesk-pi/current"
PI_CURRENT_BEFORE=$(readlink "$PI_CURRENT_PATH" 2>/dev/null || echo "unavailable")
[ "$PI_VERSION_BEFORE" = "0.84.2" ] && [ "$PI_CURRENT_BEFORE" != "unavailable" ] || {
	echo "$PROG_NAME: ProDesk Pi baseline differs from the reviewed 0.84.2 install; refusing to proceed." >&2
	exit 1
}

umask 077
mkdir -p "$INSTALL_ROOT/releases"
chmod 0700 "$INSTALL_ROOT" "$RELEASES_ROOT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null)-$$
SOURCE_SHORT=$(printf '%s' "$SOURCE_COMMIT" | cut -c1-10)
RELEASE_NAME="${STAMP}_li${PACKAGE_VERSION}_${SOURCE_SHORT}"
RELEASES_ROOT="$INSTALL_ROOT/releases"
RELEASE_DIR="$RELEASES_ROOT/$RELEASE_NAME"
[ ! -e "$RELEASE_DIR" ] || { echo "$PROG_NAME: release path already exists; refusing overwrite." >&2; exit 1; }
STAGING=$(mktemp -d "$RELEASES_ROOT/.staging-XXXXXX")
chmod 0700 "$STAGING"
cleanup_staging() {
	if [ -n "${STAGING:-}" ] && [ -d "$STAGING" ]; then rm -rf -- "$STAGING"; fi
}
trap cleanup_staging EXIT INT TERM HUP

validate_runtime_archive_paths || exit 1
mkdir -p "$STAGING/node"
if ! tar -xJf "$NODE_ARCHIVE" -C "$STAGING/node" --strip-components=1 2>/dev/null; then
	echo "$PROG_NAME: pinned Node archive extraction failed; Li current is unchanged." >&2
	exit 1
fi
STAGED_NODE_BIN="$STAGING/node/bin/node"
[ -x "$STAGED_NODE_BIN" ] || { echo "$PROG_NAME: staged Node executable is missing." >&2; exit 1; }
STAGED_NODE_VERSION=$("$STAGED_NODE_BIN" --version 2>/dev/null || true)
[ "$STAGED_NODE_VERSION" = "v$NODE_VERSION" ] || { echo "$PROG_NAME: staged Node version mismatch; Li current is unchanged." >&2; exit 1; }

if ! tar -xzf "$RUNTIME_ARCHIVE" -C "$STAGING" 2>/dev/null; then
	echo "$PROG_NAME: Li runtime archive extraction failed; Li current is unchanged." >&2
	exit 1
fi
STAGED_LI_ROOT="$STAGING/li-runtime"
[ -x "$STAGED_LI_ROOT/bin/li" ] && [ -f "$STAGED_LI_ROOT/packages/coding-agent/package.json" ] &&
	[ -f "$STAGED_LI_ROOT/packages/coding-agent/dist/bundle/cli.js" ] &&
	[ -f "$STAGED_LI_ROOT/packages/coding-agent/dist/li-build-receipt.json" ] &&
	[ -d "$STAGED_LI_ROOT/packages/coding-agent/node_modules/jiti" ] &&
	[ -d "$STAGED_LI_ROOT/packages/coding-agent/node_modules/@silvia-odwyer/photon-node" ] || {
	echo "$PROG_NAME: Li runtime archive layout is invalid." >&2
	exit 1
}
STAGED_RECEIPT="$STAGED_LI_ROOT/packages/coding-agent/dist/li-build-receipt.json"
[ "$(read_json_string gitHead "$STAGED_RECEIPT")" = "$SOURCE_COMMIT" ] || { echo "$PROG_NAME: Li build receipt source commit mismatch." >&2; exit 1; }
[ "$(read_json_string baseVersion "$STAGED_RECEIPT")" = "$PACKAGE_VERSION" ] || { echo "$PROG_NAME: Li build receipt version mismatch." >&2; exit 1; }
[ "$(read_json_string profileSnapshotId "$STAGED_RECEIPT")" = "$PROFILE_SNAPSHOT_ID" ] || { echo "$PROG_NAME: Li build receipt snapshot ID mismatch." >&2; exit 1; }

verify_runtime_tree
mv "$STAGING/node" "$STAGED_LI_ROOT/node"
STAGED_NODE_BIN="$STAGED_LI_ROOT/node/bin/node"
[ -x "$STAGED_NODE_BIN" ] || { echo "$PROG_NAME: Li release Node executable is missing." >&2; exit 1; }

STAGED_VERSION=$("$STAGED_LI_ROOT/bin/li" --version 2>/dev/null || true)
EXPECTED_VERSION="li $PACKAGE_VERSION (source $SOURCE_SHORT)"
[ "$STAGED_VERSION" = "$EXPECTED_VERSION" ] || {
	echo "$PROG_NAME: staged Li version mismatch; expected '$EXPECTED_VERSION'." >&2
	exit 1
}
SMOKE_HOME="$STAGING/smoke-home"
mkdir -m 0700 "$SMOKE_HOME"
if ! (
	HOME="$SMOKE_HOME"
	LI_CODING_AGENT_DIR="$SMOKE_HOME/.pi/agent"
	LI_CODING_AGENT_SESSION_DIR="$SMOKE_HOME/.pi/agent/sessions"
	export HOME LI_CODING_AGENT_DIR LI_CODING_AGENT_SESSION_DIR
	unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR
	"$STAGED_LI_ROOT/bin/li" --help
) >/dev/null 2>&1; then
	echo "$PROG_NAME: staged Li --help smoke failed with isolated HOME; current is unchanged." >&2
	exit 1
fi
rm -rf -- "$SMOKE_HOME"
PI_VERSION_DURING=$("$PI_WRAPPER" --version 2>/dev/null || echo "unavailable")
PI_CURRENT_DURING=$(readlink "$PI_CURRENT_PATH" 2>/dev/null || echo "unavailable")
[ "$PI_VERSION_DURING" = "$PI_VERSION_BEFORE" ] && [ "$PI_CURRENT_DURING" = "$PI_CURRENT_BEFORE" ] || {
	echo "$PROG_NAME: ProDesk Pi changed during staged Li install; Li current remains untouched." >&2
	exit 1
}

find "$STAGED_LI_ROOT" -type d -exec chmod 0700 {} +
find "$STAGED_LI_ROOT" -type f -exec chmod go-rwx {} +
RELEASE_NAME="${STAMP}_li${PACKAGE_VERSION}_${SOURCE_SHORT}"
RELEASE_DIR="$RELEASES_ROOT/$RELEASE_NAME"
mv "$STAGED_LI_ROOT" "$RELEASE_DIR"
rmdir "$STAGING"
STAGING=""

atomic_set_current "releases/$RELEASE_NAME"
ensure_stable_shim || exit 1
ensure_user_command_link || exit 1
[ "$($STABLE_SHIM --version 2>/dev/null || true)" = "$EXPECTED_VERSION" ] || {
	echo "$PROG_NAME: installed stable Li launcher failed version verification." >&2
	exit 1
}

PI_VERSION_AFTER=$("$PI_WRAPPER" --version 2>/dev/null || echo "unavailable")
PI_CURRENT_AFTER=$(readlink "$PI_CURRENT_PATH" 2>/dev/null || echo "unavailable")
if [ "$PI_VERSION_AFTER" != "$PI_VERSION_BEFORE" ] || [ "$PI_CURRENT_AFTER" != "$PI_CURRENT_BEFORE" ]; then
	printf '%s\n' "$PROG_NAME: Li installed, but the Pi baseline changed concurrently; Li did not modify Pi."
	exit 1
fi

printf '%s\n' "$PROG_NAME: install PASS (user-local, side-by-side; no service/package manager)."
printf '  Li source: %s\n  Li version: %s\n  Li current: releases/%s\n' "$SOURCE_COMMIT" "$STAGED_VERSION" "$RELEASE_NAME"
printf '  Li launcher: %s\n' "$STABLE_SHIM"
printf '  command link: %s\n' "$USER_COMMAND_LINK"
printf '  ProDesk Pi version after: %s\n  ProDesk Pi current after: %s\n' "$PI_VERSION_AFTER" "$PI_CURRENT_AFTER"
printf '  profile snapshot: verified locally; contents/hash not printed\n'
