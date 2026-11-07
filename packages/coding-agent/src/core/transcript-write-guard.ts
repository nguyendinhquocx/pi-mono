import { type ChildProcess, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { canonicalizePath } from "../utils/paths.ts";

/**
 * OS-enforced transcript write guard (Windows-local, v1).
 *
 * The guard is held by a long-lived helper process that opens the canonical
 * transcript with `FILE_SHARE_READ` only and places an exclusive `LockFileEx`
 * byte-range lock over the whole file (plus one byte past EOF so appends fail
 * too). A separate permissive candidate handle exists only inside replacement.
 * Effects, per the session-trim spec:
 *
 * - The exclusive canonical-path handle shares reads only: new write and
 *   delete/rename opens fail with a sharing violation. The full-file
 *   `LockFileEx` range (plus one byte past EOF) also denies reads/writes through
 *   compatible handles. A pre-existing writer prevents exclusive acquisition.
 * - Publishing content is a guarded in-place `rewrite` op, deliberately NOT a
 *   rename. Architectural decision (parent review of Task 0): the earlier
 *   close-target -> `MoveFileEx(REPLACE_EXISTING)` -> reopen sequence was
 *   rejected because Windows cannot keep a handle and its byte-range lock
 *   alive across a rename of the same path, so the close-to-reopen window is a
 *   path-handle gap in which a new writer could open the transcript. That
 *   violates the spec requirement that the owner reads/replaces/restores
 *   atomically under one guard with "no unlock-gap". `rewrite` instead keeps
 *   the exact same Stream and lock for the whole op: the source bytes
 *   (candidate or backup) are read and hash-verified, the held lock range is
 *   extended first when the new length exceeds it (byte ranges may extend past
 *   EOF, so growth is covered without ever releasing the existing range), the
 *   bytes are written through the already-locked handle, truncated with
 *   `SetLength`, flushed to disk (`FlushFileBuffers`), and the stream is
 *   re-hashed in place to prove what was published. The target handle is never
 *   closed, renamed, or reopened inside the op, so there is no gap to
 *   interleave into; a background writer fails with sharing/lock violations for
 *   every attempt across the whole window (covered by test).
 * - Trade-off: rename atomicity is abandoned. A crash or failed verification
 *   mid-rewrite leaves the file matching neither the original nor the candidate
 *   fingerprint; the recovery journal then stays BLOCKED and recovery runs
 *   `rewrite` from the backup under the same guard. The backup source is read,
 *   never consumed.
 * - Because the range lock denies reads through all other handles, the owner
 *   reads guarded bytes only through the helper (`snapshotTo`).
 *
 * The helper is Windows PowerShell because Node cannot create handles with a
 * custom share mode or call `LockFileEx`. Non-Windows platforms fail closed
 * with `write_guard_unavailable`; callers must treat the session as unguarded
 * and refuse trim operations.
 *
 * All failures are typed; nothing here throws for expected refusals.
 */

export type TranscriptGuardMode = "exclusive" | "shared";

export type TranscriptGuardErrorCode =
	| "write_guard_unavailable"
	| "write_guard_uncertain"
	| "writer_conflict"
	| "io_error"
	| "fingerprint_mismatch"
	| "timeout";

export interface TranscriptGuardFailure {
	ok: false;
	code: TranscriptGuardErrorCode;
	message: string;
}

export interface TranscriptGuardSuccess {
	ok: true;
	/** Opaque identity of the held guard; also used as the registry guard record id. */
	guardId: string;
}

export type TranscriptGuardResult = TranscriptGuardSuccess | TranscriptGuardFailure;

/** Outcome of `rewrite`: the in-place rewrite plus in-stream verification both succeeded. */
export interface TranscriptRewriteSuccess {
	ok: true;
	/** Opaque identity of the held guard; also used as the registry guard record id. */
	guardId: string;
	/** Published byte length, when the helper reported it. */
	byteLength?: number;
}

export type TranscriptRewriteResult = TranscriptRewriteSuccess | TranscriptGuardFailure;

/** Outcome of `acquire`: either a held guard or a typed failure. */
export type TranscriptGuardAcquireResult = { ok: true; guard: TranscriptWriteGuard } | TranscriptGuardFailure;

interface WireResponse {
	ok: boolean;
	error?: string;
	hresult?: number;
	guardId?: string;
	held?: boolean;
	byteLength?: number;
	/** Helper handle generation: increments only when the guard handle is (re)opened. */
	gen?: number;
	/** Echo of the per-request correlation id; responses without it cannot be matched. */
	reqId?: string;
}

/** Parse a helper response only when its correlation id matches the pending request. */
export function parseCorrelatedGuardResponse(line: string, expectedRequestId: string): WireResponse | undefined {
	let response: WireResponse;
	try {
		response = JSON.parse(line) as WireResponse;
	} catch {
		return undefined;
	}
	return response.reqId === expectedRequestId ? response : undefined;
}

/** Helper ops whose outcome mutates the guarded file or the guard handle itself. */
const MUTATION_OPS = new Set(["rewrite", "upgrade", "downgrade"]);

const GUARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$state = @{ Stream = $null; GuardId = $null; Mode = $null; RangeEnd = 0; HandleGen = 0 }
$kernel32 = Add-Type -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateFileW")]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
'@ -Name GuardKernel32 -Namespace PiTranscriptGuard -PassThru

function Respond($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function LockRange($stream) {
  # Whole file plus one byte past EOF so appends overlap the locked range.
  $rangeEnd = [int64]$stream.Length + 1
  if ($rangeEnd -lt 1) { $rangeEnd = 1 }
  $stream.Lock([int64]0, [int64]$rangeEnd)
  return $rangeEnd
}

function OpenLocked($path, $mode) {
  if ($mode -eq 'shared') {
    # SessionAccessGuard permits the runtime's ordinary append handles while
    # excluding a trim exclusive handle (which requires DELETE access).
    return [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  }
  # Exclusive canonical-path guard: permit read opens but deny write and DELETE
  # opens; LockFileEx denies reads through any compatible handle. Publishing
  # content rewrites in place through this same handle, so it is never closed.
  $access = [uint32]3221225472 -bor [uint32]65536
  $shareMode = [uint32]1 # FILE_SHARE_READ only
  $handle = $kernel32::CreateFile($path, $access, $shareMode, [IntPtr]::Zero, [uint32]3, [uint32]128, [IntPtr]::Zero)
  if ($handle.IsInvalid) {
    throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  return [System.IO.FileStream]::new($handle, [System.IO.FileAccess]::ReadWrite)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.reqId
    $op = $req.op
    if ($op -eq 'ping') {
      Respond @{ ok = $true; held = ($null -ne $state.Stream); gen = $state.HandleGen; reqId = $reqId }
    } elseif ($op -eq 'acquire') {
      if ($null -ne $state.Stream) { throw 'guard already held by this helper' }
      $stream = OpenLocked $req.path $req.mode
      try {
        if ($req.mode -eq 'exclusive') { $state.RangeEnd = LockRange $stream }
      } catch {
        $stream.Dispose()
        throw
      }
      $state.Stream = $stream
      $state.Mode = $req.mode
      $state.GuardId = $req.guardId
      $state.HandleGen = 1
      Respond @{ ok = $true; guardId = $req.guardId; gen = $state.HandleGen; reqId = $reqId }
    } elseif ($op -eq 'upgrade' -or $op -eq 'downgrade') {
      if ($null -eq $state.Stream) { throw 'guard not held' }
      $oldMode = $state.Mode
      $nextMode = if ($op -eq 'upgrade') { 'exclusive' } else { 'shared' }
      $state.Stream.Dispose()
      $state.Stream = $null
      $stream = $null
      try {
        $stream = OpenLocked $req.path $nextMode
        if ($nextMode -eq 'exclusive') { $state.RangeEnd = LockRange $stream }
        else { $state.RangeEnd = 0 }
        $state.Stream = $stream
        $state.Mode = $nextMode
        $state.HandleGen = $state.HandleGen + 1
      } catch {
        if ($null -ne $stream) { $stream.Dispose() }
        # Restore the original guard before returning a refusal; no await occurs
        # between closing the old handle and reacquiring it.
        $restoreStream = $null
        try {
          $restoreStream = OpenLocked $req.path $oldMode
          if ($oldMode -eq 'exclusive') { $state.RangeEnd = LockRange $restoreStream }
          else { $state.RangeEnd = 0 }
          $state.Stream = $restoreStream
          $state.Mode = $oldMode
          $state.HandleGen = $state.HandleGen + 1
        } catch {
          if ($null -ne $restoreStream) { $restoreStream.Dispose() }
        }
        throw
      }
      Respond @{ ok = $true; guardId = $state.GuardId; gen = $state.HandleGen; reqId = $reqId }
    } elseif ($op -eq 'rewrite') {
      # No-gap in-place rewrite. The canonical guard Stream and its LockFileEx
      # range stay held for the whole op: the handle is never closed, the path
      # is never renamed, and nothing is reopened, so a would-be writer is
      # denied for every attempt across the whole window (spec: exclusion
      # continues throughout replace/restore). The source (candidate or
      # backup) is read fully and hash-verified first; then the held lock range
      # is extended when the new length exceeds it - byte ranges may extend
      # past EOF, so growth is covered without ever releasing the existing
      # range; the bytes are written through the already-locked handle at
      # position 0, truncated with SetLength (SetEndOfFile), flushed to disk
      # (FlushFileBuffers), and the stream is re-hashed in place to prove what
      # was published. A crash or verification failure mid-op leaves the file
      # matching neither original nor candidate fingerprint; the recovery
      # journal stays BLOCKED and guarded restore rewrites from the backup
      # under the same no-gap op.
      $source = $req.source
      if ($null -eq $state.Stream) { throw 'guard not held' }
      if ($state.Mode -ne 'exclusive') { throw 'in-place rewrite requires the exclusive guard' }
      $bytes = [System.IO.File]::ReadAllBytes($source)
      $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
      try {
        $sourceHash = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
      } finally {
        $hashAlgorithm.Dispose()
      }
      if ($sourceHash -ne $req.expectedFingerprint) { throw 'rewrite source fingerprint mismatch' }
      $newRangeEnd = [int64]$bytes.Length + 1
      if ($newRangeEnd -gt $state.RangeEnd) {
        # Extend the held lock before any mutation; failure here refuses with
        # the file untouched and the original range still held.
        $state.Stream.Lock([int64]$state.RangeEnd, [int64]($newRangeEnd - $state.RangeEnd))
        $state.RangeEnd = $newRangeEnd
      }
      $state.Stream.Position = 0
      $state.Stream.Write($bytes, 0, $bytes.Length)
      $state.Stream.Flush()
      $state.Stream.SetLength([int64]$bytes.Length)
      $state.Stream.Flush($true)
      $state.Stream.Position = 0
      $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
      try {
        $publishedHash = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($state.Stream)).Replace('-', '').ToLowerInvariant()
      } finally {
        $hashAlgorithm.Dispose()
      }
      if ($publishedHash -ne $req.expectedFingerprint) { throw 'rewrite verification failed: stream fingerprint mismatch' }
      $state.Stream.Position = 0
      Respond @{ ok = $true; guardId = $state.GuardId; byteLength = [int64]$bytes.Length; gen = $state.HandleGen; reqId = $reqId }
    } elseif ($op -eq 'snapshot') {
      # The owner's own Node handles hit the byte-range lock, so reads during a
      # held exclusive guard must flow through this locked handle: copy the
      # guarded bytes to a caller-owned snapshot file for hashing/parsing.
      if ($null -eq $state.Stream) { throw 'guard not held' }
      $state.Stream.Position = 0
      $bytes = New-Object byte[] $state.Stream.Length
      $read = 0
      while ($read -lt $bytes.Length) {
        $chunk = $state.Stream.Read($bytes, $read, $bytes.Length - $read)
        if ($chunk -le 0) { break }
        $read += $chunk
      }
      if ($read -eq 0) {
        [System.IO.File]::WriteAllBytes([string]$req.dest, [byte[]]@())
      } else {
        [System.IO.File]::WriteAllBytes([string]$req.dest, $bytes[0..($read - 1)])
      }
      $state.Stream.Position = 0
      Respond @{ ok = $true; byteLength = $read; reqId = $reqId }
    } elseif ($op -eq 'release') {
      if ($null -ne $state.Stream) { $state.Stream.Dispose(); $state.Stream = $null }
      Respond @{ ok = $true; reqId = $reqId }
      break
    } else {
      throw "unknown op: $op"
    }
  } catch {
    $hresult = 0
    try { $hresult = $_.Exception.HResult } catch {}
    $echoId = $null
    try { $echoId = $req.reqId } catch {}
    Respond @{ ok = $false; error = $_.Exception.Message; hresult = $hresult; held = ($null -ne $state.Stream); reqId = $echoId }
  }
}
`;

const SHARING_VIOLATION_CODE = 32; // ERROR_SHARING_VIOLATION
const LOCK_VIOLATION_CODE = 33; // ERROR_LOCK_VIOLATION

function encodeScript(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

let cachedEncodedScript: string | undefined;

function encodedGuardScript(): string {
	cachedEncodedScript ??= encodeScript(GUARD_SCRIPT);
	return cachedEncodedScript;
}

function classifyHresult(hresult: number | undefined, message: string): TranscriptGuardErrorCode {
	if (typeof hresult === "number" && hresult !== 0) {
		const code = hresult & 0xffff;
		if (code === SHARING_VIOLATION_CODE || code === LOCK_VIOLATION_CODE) return "writer_conflict";
	}
	const lowered = message.toLowerCase();
	if (lowered.includes("fingerprint mismatch")) return "fingerprint_mismatch";
	if (lowered.includes("used by another process")) return "writer_conflict";
	return "write_guard_unavailable";
}

function newGuardId(canonicalPath: string, mode: TranscriptGuardMode): string {
	return createHash("sha256")
		.update(`${mode}:${canonicalPath}:${process.pid}:${process.hrtime.bigint()}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * One held OS guard. Create via `TranscriptWriteGuard.acquire()`.
 * The guard keeps a helper process alive; `release()` terminates it. A guard
 * whose helper dies is reported as not held, so reload refuses instead of
 * committing without exclusion.
 */
export class TranscriptWriteGuard {
	#child: ChildProcess | undefined;
	#canonicalPath: string;
	#mode: TranscriptGuardMode;
	#guardId: string;
	#held = false;
	/**
	 * True after a mutation op (rewrite/upgrade/downgrade) timed out: the helper
	 * may have half-applied the mutation, so the guard state can no longer be
	 * trusted. Every further op on this guard refuses with
	 * `write_guard_uncertain` until the guard is released and re-acquired.
	 */
	#uncertain = false;
	/** Helper-side counter that increments only when the guard handle is (re)opened. */
	#handleGen = 0;
	#pending: Array<{
		id: string;
		resolve: (response: WireResponse) => void;
		reject: (error: Error) => void;
	}> = [];
	#buffer = "";
	#opTimeoutMs: number;
	#lossListener: (() => void) | undefined;

	private constructor(canonicalPath: string, mode: TranscriptGuardMode, guardId: string, opTimeoutMs: number) {
		this.#canonicalPath = canonicalPath;
		this.#mode = mode;
		this.#guardId = guardId;
		this.#opTimeoutMs = opTimeoutMs;
	}

	/** Canonical path this guard protects. */
	get path(): string {
		return this.#canonicalPath;
	}

	get mode(): TranscriptGuardMode {
		return this.#mode;
	}

	get guardId(): string {
		return this.#guardId;
	}

	/** Whether a previous mutation op timed out and the guard state is no longer trustworthy. */
	get isUncertain(): boolean {
		return this.#uncertain;
	}

	/**
	 * Helper-side handle generation. Acquire sets it to 1; upgrade/downgrade
	 * increment it because they dispose and reopen the path handle. The
	 * in-place rewrite op leaves it unchanged, which is the no-reopen proof
	 * used by tests: a rewrite never swaps the guard handle or its lock.
	 */
	get handleGeneration(): number {
		return this.#handleGen;
	}

	/** Whether the helper process is still alive and reported holding the lock. */
	get isHeld(): boolean {
		return this.#held && this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed;
	}

	static isPlatformSupported(): boolean {
		return process.platform === "win32";
	}

	/**
	 * Acquire an OS guard on `canonicalPath`. `mode: "shared"` is the
	 * SessionAccessGuard (other readers stay allowed, writers and exclusive
	 * trim guards are denied); `mode: "exclusive"` is the trim guard.
	 */
	static async acquire(
		canonicalPath: string,
		options?: {
			mode?: TranscriptGuardMode;
			opTimeoutMs?: number;
			/** Optional deadline for the initial helper acquire handshake; defaults to opTimeoutMs. */
			acquireTimeoutMs?: number;
		},
	): Promise<TranscriptGuardAcquireResult> {
		const mode = options?.mode ?? "exclusive";
		const opTimeoutMs = options?.opTimeoutMs ?? 20_000;
		if (!TranscriptWriteGuard.isPlatformSupported()) {
			return guardFailure(
				new TranscriptGuardUnavailableError(
					"write_guard_unavailable",
					"OS write guard is only implemented for Windows local filesystems",
				),
			);
		}
		const canonical = canonicalizePath(canonicalPath);
		const guardId = newGuardId(canonical, mode);
		const guard = new TranscriptWriteGuard(canonical, mode, guardId, opTimeoutMs);
		let response: WireResponse;
		try {
			response = await guard.#spawnAndRequest(
				{ op: "acquire", path: canonical, mode, guardId },
				options?.acquireTimeoutMs,
			);
		} catch (error) {
			guard.#teardown();
			return guardFailure(
				new TranscriptGuardUnavailableError(
					"write_guard_unavailable",
					error instanceof Error ? error.message : String(error),
				),
			);
		}
		if (!response.ok) {
			guard.#teardown();
			return guardFailure(
				new TranscriptGuardUnavailableError(
					classifyHresult(response.hresult, response.error ?? ""),
					response.error ?? "guard acquire failed",
				),
			);
		}
		guard.#handleGen = response.gen ?? 1;
		guard.#held = true;
		return { ok: true, guard };
	}

	#spawnChild(): Promise<void> {
		return new Promise((resolveSpawn, rejectSpawn) => {
			const child = spawn(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedGuardScript()],
				{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			);
			this.#child = child;
			child.on("error", (error) => {
				this.#held = false;
				rejectSpawn(error);
			});
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				this.#buffer += chunk;
				let newlineIndex = this.#buffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = this.#buffer.slice(0, newlineIndex).trim();
					this.#buffer = this.#buffer.slice(newlineIndex + 1);
					if (line) this.#dispatch(line);
					newlineIndex = this.#buffer.indexOf("\n");
				}
			});
			child.on("exit", () => {
				this.#held = false;
				const pending = this.#pending;
				this.#pending = [];
				for (const entry of pending) {
					entry.reject(new Error("guard helper exited"));
				}
				this.#lossListener?.();
			});
			// The helper emits nothing until the first op, so child "spawn" plus a
			// successful request round trip is the readiness signal.
			resolveSpawn();
		});
	}

	#dispatch(line: string): void {
		const next = this.#pending[0];
		if (!next) return;
		// A stale or uncorrelated response belongs to another request and is
		// discarded; it must never be assigned to the currently pending op.
		const response = parseCorrelatedGuardResponse(line, next.id);
		if (!response) return;
		this.#pending.shift();
		next.resolve(response);
	}

	#request(payload: Record<string, unknown>, timeoutMs = this.#opTimeoutMs): Promise<WireResponse> {
		const child = this.#child;
		if (!child || child.exitCode !== null || !child.stdin?.writable) {
			return Promise.reject(new Error("guard helper is not running"));
		}
		const reqId = randomUUID();
		return new Promise<WireResponse>((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				const index = this.#pending.findIndex((entry) => entry.reject === settleReject);
				if (index !== -1) this.#pending.splice(index, 1);
				const error = new Error(`guard op timed out after ${this.#opTimeoutMs}ms`);
				if (typeof payload.op === "string" && MUTATION_OPS.has(payload.op)) {
					// The helper may or may not have applied the mutation before the
					// timeout: kill it so the stale helper cannot act further and
					// mark the guard uncertain — later ops must refuse instead of
					// assuming the pre-op guard state.
					this.#teardown();
					this.#held = false;
					this.#uncertain = true;
				}
				settleReject(error);
			}, timeoutMs);
			const settleResolve = (response: WireResponse) => {
				clearTimeout(timer);
				resolveRequest(response);
			};
			const settleReject = (error: Error) => {
				clearTimeout(timer);
				rejectRequest(error);
			};
			this.#pending.push({ id: reqId, resolve: settleResolve, reject: settleReject });
			child.stdin?.write(`${JSON.stringify({ ...payload, reqId })}\n`, (error) => {
				if (error) {
					const index = this.#pending.findIndex((entry) => entry.id === reqId);
					if (index !== -1) this.#pending.splice(index, 1);
					settleReject(error);
				}
			});
		});
	}

	async #spawnAndRequest(payload: Record<string, unknown>, timeoutMs?: number): Promise<WireResponse> {
		await this.#spawnChild();
		return this.#request(payload, timeoutMs);
	}

	async #requestWithSpawnGuard(payload: Record<string, unknown>): Promise<WireResponse> {
		if (!this.#child) {
			throw new Error("guard helper is not running");
		}
		return this.#request(payload);
	}

	/**
	 * Rewrite the guarded file in place from `sourcePath` (a verified candidate
	 * or a backup) inside one synchronous helper op. The guard's Stream and its
	 * `LockFileEx` range stay held for the entire op: the handle is never
	 * closed, the path is never renamed, and nothing is reopened, so exclusion
	 * is continuous (spec: "no unlock-gap"). The source hash is verified twice
	 * (Node-side and in-helper) and the published stream is re-hashed before
	 * the op replies, so a mismatching publication fails as
	 * `fingerprint_mismatch` while the guard stays held (recovery then decides
	 * between candidate hash and guarded restore).
	 * The source may live anywhere readable on disk; it is read, not consumed.
	 */
	/** Typed refusal used by every op once the guard is in the uncertain state. */
	#uncertainRefusal(): TranscriptGuardFailure {
		return guardFailure(
			new TranscriptGuardUnavailableError(
				"write_guard_uncertain",
				"guard state is uncertain after a timed-out mutation op; release and re-acquire the guard",
			),
		);
	}

	async rewrite(
		sourcePath: string,
		options?: { expectedSourceFingerprint?: string },
	): Promise<TranscriptRewriteResult> {
		const sourceAbsolutePath = resolve(sourcePath);
		try {
			const sourceStats = lstatSync(sourceAbsolutePath);
			if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
				return {
					ok: false,
					code: "write_guard_unavailable",
					message: "rewrite source must be a regular file",
				};
			}
		} catch (error) {
			return {
				ok: false,
				code: "io_error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
		if (this.#uncertain) return this.#uncertainRefusal();
		if (!this.isHeld) {
			return guardFailure(
				new TranscriptGuardUnavailableError("writer_conflict", "guard is no longer held; refusing rewrite"),
			);
		}
		if (this.#mode !== "exclusive") {
			return {
				ok: false,
				code: "writer_conflict",
				message: "in-place rewrite requires the exclusive guard",
			};
		}
		try {
			const sourceFingerprint = createHash("sha256").update(readFileSync(sourceAbsolutePath)).digest("hex");
			// A caller-pinned fingerprint (e.g. the claim's recorded original
			// fingerprint for guarded restore) binds the source bytes to what the
			// caller inspected, not to whatever happens to sit at the path now.
			if (
				options?.expectedSourceFingerprint !== undefined &&
				sourceFingerprint !== options.expectedSourceFingerprint
			) {
				return {
					ok: false,
					code: "fingerprint_mismatch",
					message: `rewrite source fingerprint ${sourceFingerprint} does not match the pinned expectation ${options.expectedSourceFingerprint}`,
				};
			}
			const response = await this.#requestWithSpawnGuard({
				op: "rewrite",
				source: sourceAbsolutePath,
				expectedFingerprint: options?.expectedSourceFingerprint ?? sourceFingerprint,
			});
			if (!response.ok) {
				if (response.held !== true) this.#held = false;
				return guardFailure(
					new TranscriptGuardUnavailableError(
						response.held === true
							? classifyHresult(response.hresult, response.error ?? "")
							: "write_guard_unavailable",
						response.error ?? "guarded rewrite failed",
					),
				);
			}
			if (typeof response.gen === "number") this.#handleGen = response.gen;
			return { ok: true, guardId: this.#guardId, byteLength: response.byteLength };
		} catch (error) {
			this.#held = false;
			return guardFailure(
				new TranscriptGuardUnavailableError(
					this.#uncertain ? "write_guard_uncertain" : "writer_conflict",
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	}

	/**
	 * Upgrade the shared SessionAccessGuard to exclusive under one synchronous
	 * helper command. The helper closes/reopens the canonical path and applies
	 * the lock without yielding to the event loop. On refusal it restores the
	 * previous guard mode before replying where possible.
	 */
	async upgrade(): Promise<TranscriptGuardResult> {
		if (this.#uncertain) return this.#uncertainRefusal();
		if (!this.isHeld || this.#mode !== "shared") {
			return { ok: false, code: "writer_conflict", message: "shared access guard is not held" };
		}
		try {
			const response = await this.#requestWithSpawnGuard({ op: "upgrade", path: this.#canonicalPath });
			if (!response.ok) {
				if (response.held !== true) this.#held = false;
				return {
					ok: false,
					code:
						response.held === true
							? classifyHresult(response.hresult, response.error ?? "")
							: "write_guard_unavailable",
					message: response.error ?? "session access guard upgrade failed",
				};
			}
			if (typeof response.gen === "number") this.#handleGen = response.gen;
			this.#mode = "exclusive";
			return { ok: true, guardId: this.#guardId };
		} catch (error) {
			this.#held = false;
			return {
				ok: false,
				code: this.#uncertain ? "write_guard_uncertain" : "write_guard_unavailable",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Downgrade an exclusive trim guard back to the held shared session guard. */
	async downgrade(): Promise<TranscriptGuardResult> {
		if (this.#uncertain) return this.#uncertainRefusal();
		if (!this.isHeld || this.#mode !== "exclusive") {
			return { ok: false, code: "writer_conflict", message: "exclusive write guard is not held" };
		}
		try {
			const response = await this.#requestWithSpawnGuard({ op: "downgrade", path: this.#canonicalPath });
			if (!response.ok) {
				if (response.held !== true) this.#held = false;
				return {
					ok: false,
					code:
						response.held === true
							? classifyHresult(response.hresult, response.error ?? "")
							: "write_guard_unavailable",
					message: response.error ?? "session access guard downgrade failed",
				};
			}
			if (typeof response.gen === "number") this.#handleGen = response.gen;
			this.#mode = "shared";
			return { ok: true, guardId: this.#guardId };
		} catch (error) {
			this.#held = false;
			return {
				ok: false,
				code: this.#uncertain ? "write_guard_uncertain" : "write_guard_unavailable",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Liveness probe used before commit: the helper must still hold the lock. */
	async verifyHeld(): Promise<boolean> {
		if (this.#uncertain) return false;
		if (!this.#child || !this.#held) return false;
		try {
			const response = await this.#requestWithSpawnGuard({ op: "ping" });
			return response.ok === true && response.held === true;
		} catch {
			this.#held = false;
			return false;
		}
	}

	/**
	 * Copy the guarded transcript bytes to `destPath` through the helper's
	 * locked handle. Byte-range locks deny reads through every other handle, so
	 * this is the only way the owner can hash/parse the transcript while an
	 * exclusive guard is held. The snapshot is a plain unlocked file.
	 */
	async snapshotTo(destPath: string): Promise<TranscriptGuardResult & { byteLength?: number }> {
		if (this.#uncertain) return this.#uncertainRefusal();
		if (!this.isHeld) {
			return { ok: false, code: "writer_conflict", message: "guard is no longer held; refusing snapshot" };
		}
		try {
			const response = await this.#requestWithSpawnGuard({ op: "snapshot", dest: resolve(destPath) });
			if (!response.ok) {
				return {
					ok: false,
					code: classifyHresult(response.hresult, response.error ?? ""),
					message: response.error ?? "guarded snapshot failed",
				};
			}
			return { ok: true, guardId: this.#guardId, byteLength: response.byteLength };
		} catch (error) {
			return {
				ok: false,
				code: "io_error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Release the guard and stop the helper process. */
	async release(): Promise<void> {
		if (this.#child && this.#held) {
			try {
				await this.#requestWithSpawnGuard({ op: "release" });
			} catch {
				// Helper may already be gone; kill below covers it.
			}
		}
		this.#teardown();
	}

	/** Register a callback for helper loss (used to fail pending commits). */
	onLost(listener: () => void): void {
		this.#lossListener = listener;
	}

	#teardown(): void {
		this.#held = false;
		const child = this.#child;
		this.#child = undefined;
		const pending = this.#pending;
		this.#pending = [];
		for (const entry of pending) {
			entry.reject(new Error("guard released"));
		}
		if (child) {
			try {
				child.stdin?.destroy();
				child.kill();
			} catch {
				// Already gone.
			}
		}
	}
}

/**
 * Typed guard failure carrying the refusal code. Never thrown for expected
 * outcomes; surfaced as a value so callers can map it to API refusals.
 */
export class TranscriptGuardUnavailableError extends Error {
	readonly code: TranscriptGuardErrorCode;

	constructor(code: TranscriptGuardErrorCode, message?: string) {
		super(
			message ??
				(code === "writer_conflict"
					? "Transcript is locked by another writer"
					: "OS write guard is unavailable on this platform/filesystem"),
		);
		this.name = "TranscriptGuardUnavailableError";
		this.code = code;
	}
}

/** Build the failure payload for a typed guard error. */
function guardFailure(error: TranscriptGuardUnavailableError): TranscriptGuardFailure {
	return { ok: false, code: error.code, message: error.message };
}

/** SHA-256 hex of the exact raw bytes of a file, or null when unreadable. */
function fileFingerprint(filePath: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(filePath)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Scratch directory used by tests to observe helper behavior; not used in
 * production paths.
 */
export function createGuardScratchDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-transcript-guard-"));
}

/** Remove a scratch dir created by `createGuardScratchDir`. */
export function removeGuardScratchDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

const HELD_GUARD_LOCKED = "byte-range locks deny reads through every handle except the helper's own";

/** Failure codes `fingerprintThroughGuard` can actually produce. */
export type GuardedFingerprintFailureCode =
	| "writer_conflict"
	| "write_guard_uncertain"
	| "write_guard_unavailable"
	| "io_error";

export type GuardedFingerprintResult =
	| { ok: true; fingerprint: string }
	| { ok: false; code: GuardedFingerprintFailureCode; message: string };

/**
 * Snapshot the guarded transcript through the helper's locked handle and
 * return its fingerprint. Reads through plain Node handles fail with EBUSY
 * while a full-range exclusive lock is held, so guarded verification flows
 * must read via the guard itself (same process/handle as the lock owner).
 */
export async function fingerprintThroughGuard(
	guard: TranscriptWriteGuard,
	snapshotPath: string,
): Promise<GuardedFingerprintResult> {
	const snapshot = await guard.snapshotTo(snapshotPath);
	if (!snapshot.ok) {
		return {
			ok: false,
			code:
				snapshot.code === "writer_conflict" || snapshot.code === "write_guard_uncertain"
					? snapshot.code
					: "write_guard_unavailable",
			message: snapshot.message,
		};
	}
	const fingerprint = fileFingerprint(snapshotPath);
	if (!fingerprint) return { ok: false, code: "io_error", message: HELD_GUARD_LOCKED };
	return { ok: true, fingerprint };
}
