import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "fs";
import { join } from "path";
import { canonicalizePath } from "../utils/paths.ts";
import { TranscriptWriteGuard } from "./transcript-write-guard.ts";

/**
 * Session-open lease registry (v1) per the session-trim spec.
 *
 * Layout under `<effective-agentDir>/session-open-leases/`:
 * - `registry.json`   — {format_version, protocol_version, real_write_enabled, approved_builds[], t20_receipt_sha256}
 * - `leases/<id>.json` — one open lease per persisted session runtime; release deletes the file
 * - `claims/<path_hash>.json` — per-identity mutation claim with a phase journal
 * - `guards/<path_hash>.lock` — per-identity guard record doubling as the short
 *   update mutex for lease/claim updates
 *
 * Rules implemented here:
 * - Canonical transcript identity = realpath, separators normalized, Windows
 *   case-folded, hashed as lowercase SHA-256 (`path_hash`). No record stores a
 *   raw transcript path.
 * - Every JSON read fails closed on duplicate keys (JSON.parse alone silently
 *   accepts them), unknown/missing format or protocol versions, partial
 *   records, and wrong types. Unknown extra fields are ignored.
 * - Every write publishes a full payload: temp file in the same directory +
 *   fsync, then atomic publish. Record creation never overwrites (hard-link
 *   publish); updates run under the per-identity guard and rename over the
 *   previous record.
 * - Stale leases/claims/guards are only reclaimed with an OS death proof: the
 *   owner PID must be gone, or the PID's current process-start identity must
 *   mismatch the recorded one. Age/mtime never proves death.
 * - Registry unavailability degrades the session (trim refuses later) instead
 *   of killing the runtime.
 */

export const LEASE_REGISTRY_FORMAT_VERSION = 1;
export const LEASE_REGISTRY_PROTOCOL_VERSION = 1;
export const LEASE_STATE_OPEN = "open";

/** Sentinel for a process-start identity that could not be proven. */
export const PROCESS_START_UNKNOWN = "UNKNOWN";

export const LEASE_CLAIM_PHASES = [
	"acquired",
	"backup_created",
	"candidate_ready",
	"replaced",
	"verified",
	"rollback_pending",
	"blocked",
] as const;
export type LeaseClaimPhase = (typeof LEASE_CLAIM_PHASES)[number];

export type RegistryErrorCode =
	| "registry_invalid"
	| "lease_missing"
	| "lease_conflict"
	| "recovery_blocked"
	| "writer_conflict"
	| "write_guard_unavailable"
	| "io_error";

export interface RegistryFailure {
	ok: false;
	code: RegistryErrorCode;
	message: string;
}

export interface ApprovedBuild {
	runtime: string;
	launcher_path: string;
	artifact_sha256: string;
	protocol_version: number;
}

export interface LeaseRegistryFile {
	format_version: number;
	protocol_version: number;
	real_write_enabled: boolean;
	approved_builds: ApprovedBuild[];
	t20_receipt_sha256?: string;
}

export interface LeaseRecord {
	lease_id: string;
	session_id: string;
	path_hash: string;
	pid: number;
	process_start_utc: string;
	runtime: string;
	build_hash: string;
	opened_at: string;
	lease_state: typeof LEASE_STATE_OPEN;
}

export interface LeaseClaimRecord {
	lock_id: string;
	path_hash: string;
	session_id: string;
	purpose: string;
	owner_pid: number;
	owner_start_utc: string;
	owner_runtime: string;
	owner_build_hash: string;
	phase: LeaseClaimPhase;
	operation_id: string;
	original_fingerprint: string;
	candidate_fingerprint?: string;
	backup_name?: string;
}

export interface GuardRecord {
	guard_id: string;
	path_hash: string;
	owner_pid: number;
	owner_start_utc: string;
	started_at: string;
}

/** Process-start inventory used for death proofs. Injectable for tests. */
export interface ProcessInventory {
	/** Normalized `YYYY-MM-DDTHH:mm:ss.ffffffZ`, or null when unprovable. */
	getProcessStartUtc(pid: number): string | null;
	/** True only when OS proves the PID is alive with this start identity. */
	isProcessAlive(pid: number, startUtc: string): boolean;
}

/**
 * Normalize a Windows process creation timestamp.
 * Accepts WMIC DMTF/CIM (`20260105093000.123456+420`) and ISO-8601 inputs and
 * returns the fixed UTC form `YYYY-MM-DDTHH:mm:ss.ffffffZ`; anything missing or
 * invalid becomes UNKNOWN with no PID-only fallback.
 */
export function normalizeProcessStartUtc(raw: string | null | undefined): string {
	if (typeof raw !== "string") return PROCESS_START_UNKNOWN;
	const value = raw.trim();
	if (!value) return PROCESS_START_UNKNOWN;

	const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/);
	if (isoMatch) {
		const [year, month, day, hour, minute, second] = isoMatch.slice(1, 7).map(Number);
		if (!isValidProcessStartParts(year!, month!, day!, hour!, minute!, second!)) return PROCESS_START_UNKNOWN;
		return value;
	}

	const dmtf = value.match(
		/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})(?:([+-])(\d{3})|([+-])(\d{2})(\d{2})|Z)?$/,
	);
	if (dmtf) {
		const [, y, mo, d, h, mi, s, micros, signMinutes, offsetMinutesRaw, signHours, offH, offM] = dmtf;
		const year = Number(y);
		const month = Number(mo);
		const day = Number(d);
		const hour = Number(h);
		const minute = Number(mi);
		const second = Number(s);
		if (!isValidProcessStartParts(year, month, day, hour, minute, second)) return PROCESS_START_UNKNOWN;
		let offsetMinutes = 0;
		if (signMinutes && offsetMinutesRaw) {
			const offset = Number(offsetMinutesRaw);
			if (offset > 999) return PROCESS_START_UNKNOWN;
			offsetMinutes = (signMinutes === "+" ? 1 : -1) * offset;
		} else if (signHours && offH && offM) {
			const hours = Number(offH);
			const minutes = Number(offM);
			if (hours > 23 || minutes > 59) return PROCESS_START_UNKNOWN;
			offsetMinutes = (signHours === "+" ? 1 : -1) * (hours * 60 + minutes);
		}
		const localTime = new Date(0);
		localTime.setUTCFullYear(year, month - 1, day);
		localTime.setUTCHours(hour, minute, second, 0);
		const instant = new Date(localTime.getTime() - offsetMinutes * 60_000);
		if (Number.isNaN(instant.getTime()) || instant.getUTCFullYear() < 0 || instant.getUTCFullYear() > 9999) {
			return PROCESS_START_UNKNOWN;
		}
		return formatProcessStartUtc(instant, micros!);
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return PROCESS_START_UNKNOWN;
	return formatProcessStartUtc(new Date(parsed.getTime()), "000000");
}

function isValidProcessStartParts(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): boolean {
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
	return day >= 1 && day <= daysInMonth;
}

function formatProcessStartUtc(date: Date, micros: string): string {
	const pad = (input: number, width: number) => String(input).padStart(width, "0");
	return (
		`${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
		`T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
		`.${micros}Z`
	);
}

/** Default inventory backed by a Windows CIM query, cached per PID. */
export function createDefaultProcessInventory(): ProcessInventory {
	const status = new Map<number, "alive" | "dead" | "unknown">();
	return {
		getProcessStartUtc(pid: number): string | null {
			let result: string | null = null;
			status.set(pid, "unknown");
			if (process.platform === "win32") {
				try {
					const query =
						`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; ` +
						`if ($null -eq $p) { '__PI_PROCESS_NOT_FOUND__' } else { ` +
						`$p.CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'") }`;
					const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
						encoding: "utf8",
						windowsHide: true,
						timeout: 30_000,
					});
					if (run.status === 0 && !run.error) {
						const line = run.stdout
							.split(/\r?\n/)
							.find((candidate) => candidate.trim() !== "")
							?.trim();
						if (line === "__PI_PROCESS_NOT_FOUND__") {
							status.set(pid, "dead");
							result = null;
						} else if (line) {
							const normalized = normalizeProcessStartUtc(line);
							if (normalized !== PROCESS_START_UNKNOWN) {
								status.set(pid, "alive");
								result = normalized;
							}
						}
					}
				} catch {
					status.set(pid, "unknown");
				}
			}
			return result;
		},
		isProcessAlive(pid: number, startUtc: string): boolean {
			if (startUtc === PROCESS_START_UNKNOWN) return true; // cannot prove death
			const current = this.getProcessStartUtc(pid);
			const processStatus = status.get(pid) ?? "unknown";
			if (processStatus === "dead") return false;
			if (processStatus === "unknown" || current === null) return true; // query failure/missing identity is not death proof
			return current === startUtc; // mismatch proves PID reuse => dead
		},
	};
}

/** Canonical transcript identity: realpath, normalized separators, Windows case-fold. */
export function canonicalTranscriptIdentityPath(path: string): string {
	const real = canonicalizePath(path);
	return process.platform === "win32" ? real.replace(/\//g, "\\").toLowerCase() : real;
}

/** Lowercase SHA-256 hex of the UTF-8 canonical identity. */
export function hashCanonicalIdentity(identity: string): string {
	return createHash("sha256").update(identity, "utf8").digest("hex");
}

export interface CanonicalTranscriptIdentity {
	identity: string;
	pathHash: string;
}

export function canonicalTranscriptIdentity(path: string): CanonicalTranscriptIdentity {
	const identity = canonicalTranscriptIdentityPath(path);
	return { identity, pathHash: hashCanonicalIdentity(identity) };
}

// ============================================================================
// Strict JSON with duplicate-key detection
// ============================================================================

/**
 * Parse JSON failing closed on duplicate object keys and trailing content.
 * `JSON.parse` silently keeps the last duplicate, which is not acceptable for
 * registry records.
 */
export function parseJsonStrict(text: string): unknown {
	let index = 0;

	const error = (message: string): never => {
		throw new Error(`Invalid JSON at offset ${index}: ${message}`);
	};

	const skipWhitespace = (): void => {
		while (index < text.length && /[\s]/.test(text[index]!)) index++;
	};

	const parseValue: () => unknown = () => {
		skipWhitespace();
		if (index >= text.length) error("unexpected end of input");
		const char = text[index]!;
		if (char === "{") return parseObject();
		if (char === "[") return parseArray();
		if (char === '"') return parseString();
		if (char === "-" || /[0-9]/.test(char)) return parseNumber();
		if (valueMatches("true")) return true;
		if (valueMatches("false")) return false;
		if (valueMatches("null")) return null;
		return error(`unexpected token "${text.slice(index, index + 8)}"`);
	};

	const valueMatches = (literal: string): boolean => {
		if (text.startsWith(literal, index)) {
			index += literal.length;
			return true;
		}
		return false;
	};

	const parseObject = (): Record<string, unknown> => {
		index++; // '{'
		const result: Record<string, unknown> = Object.create(null);
		const seenKeys = new Set<string>();
		skipWhitespace();
		if (text[index] === "}") {
			index++;
			return result;
		}
		while (true) {
			skipWhitespace();
			if (text[index] !== '"') error("expected object key string");
			const key = parseString();
			if (seenKeys.has(key)) error(`duplicate key "${key}"`);
			seenKeys.add(key);
			skipWhitespace();
			if (text[index] !== ":") error("expected ':' after key");
			index++;
			result[key] = parseValue();
			skipWhitespace();
			if (text[index] === ",") {
				index++;
				continue;
			}
			if (text[index] === "}") {
				index++;
				return result;
			}
			error("expected ',' or '}' in object");
		}
	};

	const parseArray = (): unknown[] => {
		index++; // '['
		const result: unknown[] = [];
		skipWhitespace();
		if (text[index] === "]") {
			index++;
			return result;
		}
		while (true) {
			result.push(parseValue());
			skipWhitespace();
			if (text[index] === ",") {
				index++;
				continue;
			}
			if (text[index] === "]") {
				index++;
				return result;
			}
			error("expected ',' or ']' in array");
		}
	};

	const parseString = (): string => {
		index++; // '"'
		let out = "";
		while (index < text.length) {
			const char = text[index]!;
			if (char === '"') {
				index++;
				return out;
			}
			if (char === "\\") {
				index++;
				const escapedChar = text[index];
				if (escapedChar === undefined) error("unterminated escape");
				if (escapedChar === "u") {
					const hex = text.slice(index + 1, index + 5);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) error("invalid unicode escape");
					out += String.fromCharCode(Number.parseInt(hex, 16));
					index += 5;
					continue;
				}
				const simple: Record<string, string> = {
					'"': '"',
					"\\": "\\",
					"/": "/",
					b: "\b",
					f: "\f",
					n: "\n",
					r: "\r",
					t: "\t",
				};
				const mapped = simple[escapedChar];
				if (mapped === undefined) error(`invalid escape "\\${escapedChar}"`);
				out += mapped;
				index++;
				continue;
			}
			if (char.charCodeAt(0) < 0x20) error("unescaped control character in string");
			out += char;
			index++;
		}
		return error("unterminated string");
	};

	const parseNumber = (): number => {
		const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) return error("invalid number");
		const literal = match[0];
		index += literal.length;
		const value = Number(literal);
		if (!Number.isFinite(value)) error(`invalid number "${literal}"`);
		return value;
	};

	const result = parseValue();
	skipWhitespace();
	if (index !== text.length) error("trailing content after JSON value");
	return result;
}

// ============================================================================
// Record schema validation (fail closed; unknown extra fields ignored)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : undefined;
}

function requireString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSha256(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

function isProcessStartIdentity(value: string): boolean {
	return value === PROCESS_START_UNKNOWN || normalizeProcessStartUtc(value) === value;
}

export function parseRegistryFile(value: unknown): LeaseRegistryFile | null {
	if (!isRecord(value)) return null;
	if (value.format_version !== LEASE_REGISTRY_FORMAT_VERSION) return null;
	if (value.protocol_version !== LEASE_REGISTRY_PROTOCOL_VERSION) return null;
	if (typeof value.real_write_enabled !== "boolean") return null;
	if (!Array.isArray(value.approved_builds)) return null;
	const approvedBuilds: ApprovedBuild[] = [];
	for (const entry of value.approved_builds) {
		if (!isRecord(entry)) return null;
		const runtime = requireString(entry, "runtime");
		const launcherPath = requireString(entry, "launcher_path");
		const artifactSha = requireString(entry, "artifact_sha256");
		const protocolVersion = requireNumber(entry, "protocol_version");
		if (runtime === undefined || launcherPath === undefined || artifactSha === undefined) return null;
		if (!isSha256(artifactSha) || protocolVersion !== LEASE_REGISTRY_PROTOCOL_VERSION) return null;
		approvedBuilds.push({
			runtime,
			launcher_path: launcherPath,
			artifact_sha256: artifactSha,
			protocol_version: protocolVersion,
		});
	}
	if (value.t20_receipt_sha256 !== undefined && typeof value.t20_receipt_sha256 !== "string") return null;
	const receipt = optionalString(value, "t20_receipt_sha256");
	if (receipt !== undefined && !isSha256(receipt)) return null;
	const parsed: LeaseRegistryFile = {
		format_version: LEASE_REGISTRY_FORMAT_VERSION,
		protocol_version: LEASE_REGISTRY_PROTOCOL_VERSION,
		real_write_enabled: value.real_write_enabled,
		approved_builds: approvedBuilds,
	};
	if (receipt !== undefined) parsed.t20_receipt_sha256 = receipt;
	return parsed;
}

export function parseLeaseRecord(value: unknown): LeaseRecord | null {
	if (!isRecord(value)) return null;
	const leaseId = requireString(value, "lease_id");
	const sessionId = requireString(value, "session_id");
	const pathHash = requireString(value, "path_hash");
	const pid = requireNumber(value, "pid");
	const processStart = value.process_start_utc;
	const runtime = requireString(value, "runtime");
	const buildHash = requireString(value, "build_hash");
	const openedAt = requireString(value, "opened_at");
	if (
		leaseId === undefined ||
		sessionId === undefined ||
		pathHash === undefined ||
		pid === undefined ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof processStart !== "string" ||
		!isProcessStartIdentity(processStart) ||
		runtime === undefined ||
		buildHash === undefined ||
		openedAt === undefined ||
		!isSha256(pathHash)
	) {
		return null;
	}
	// lease_state enum carries only "open"; release deletes the file, so any
	// other value is a corrupt/unknown record and must fail closed.
	if (value.lease_state !== LEASE_STATE_OPEN) return null;
	return {
		lease_id: leaseId,
		session_id: sessionId,
		path_hash: pathHash,
		pid,
		process_start_utc: processStart,
		runtime,
		build_hash: buildHash,
		opened_at: openedAt,
		lease_state: LEASE_STATE_OPEN,
	};
}

export function parseClaimRecord(value: unknown): LeaseClaimRecord | null {
	if (!isRecord(value)) return null;
	const lockId = requireString(value, "lock_id");
	const pathHash = requireString(value, "path_hash");
	const sessionId = requireString(value, "session_id");
	const purpose = requireString(value, "purpose");
	const ownerPid = requireNumber(value, "owner_pid");
	const ownerStart = value.owner_start_utc;
	const ownerRuntime = requireString(value, "owner_runtime");
	const ownerBuildHash = requireString(value, "owner_build_hash");
	const phase = value.phase;
	const operationId = requireString(value, "operation_id");
	const originalFingerprint = requireString(value, "original_fingerprint");
	if (
		lockId === undefined ||
		pathHash === undefined ||
		sessionId === undefined ||
		purpose === undefined ||
		ownerPid === undefined ||
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0 ||
		typeof ownerStart !== "string" ||
		!isProcessStartIdentity(ownerStart) ||
		ownerRuntime === undefined ||
		ownerBuildHash === undefined ||
		typeof phase !== "string" ||
		!LEASE_CLAIM_PHASES.includes(phase as LeaseClaimPhase) ||
		operationId === undefined ||
		originalFingerprint === undefined ||
		!isSha256(pathHash) ||
		!isSha256(originalFingerprint)
	) {
		return null;
	}
	const record: LeaseClaimRecord = {
		lock_id: lockId,
		path_hash: pathHash,
		session_id: sessionId,
		purpose,
		owner_pid: ownerPid,
		owner_start_utc: ownerStart,
		owner_runtime: ownerRuntime,
		owner_build_hash: ownerBuildHash,
		phase: phase as LeaseClaimPhase,
		operation_id: operationId,
		original_fingerprint: originalFingerprint,
	};
	if (value.candidate_fingerprint !== undefined && typeof value.candidate_fingerprint !== "string") return null;
	const candidateFingerprint = optionalString(value, "candidate_fingerprint");
	if (candidateFingerprint !== undefined) {
		if (!isSha256(candidateFingerprint)) return null;
		record.candidate_fingerprint = candidateFingerprint;
	}
	if (value.backup_name !== undefined && typeof value.backup_name !== "string") return null;
	const backupName = optionalString(value, "backup_name");
	if (backupName !== undefined) {
		if (backupName === "." || backupName === ".." || /[\\/]/.test(backupName)) return null;
		record.backup_name = backupName;
	}
	return record;
}

export function parseGuardRecord(value: unknown): GuardRecord | null {
	if (!isRecord(value)) return null;
	const guardId = requireString(value, "guard_id");
	const pathHash = requireString(value, "path_hash");
	const ownerPid = requireNumber(value, "owner_pid");
	const ownerStart = value.owner_start_utc;
	const startedAt = requireString(value, "started_at");
	if (
		guardId === undefined ||
		pathHash === undefined ||
		ownerPid === undefined ||
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0 ||
		typeof ownerStart !== "string" ||
		!isProcessStartIdentity(ownerStart) ||
		startedAt === undefined ||
		!isSha256(pathHash)
	) {
		return null;
	}
	return {
		guard_id: guardId,
		path_hash: pathHash,
		owner_pid: ownerPid,
		owner_start_utc: ownerStart,
		started_at: startedAt,
	};
}

// ============================================================================
// Registry
// ============================================================================

export type RegistryOpResult<T> = { ok: true; value: T } | RegistryFailure;

function fail<T>(code: RegistryErrorCode, message: string): RegistryOpResult<T> {
	return { ok: false, code, message };
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 hex of the exact raw bytes of a file, or null when unreadable. */
export function fileFingerprint(filePath: string): string | null {
	try {
		return sha256Hex(readFileSync(filePath));
	} catch {
		return null;
	}
}

export interface SessionOpenLeaseRegistryOptions {
	runtime: string;
	buildHash: string;
	processInventory?: ProcessInventory;
}

interface RegistryPaths {
	root: string;
	registryFile: string;
	leasesDir: string;
	claimsDir: string;
	guardsDir: string;
}

function registryPaths(agentDir: string): RegistryPaths {
	const root = join(agentDir, "session-open-leases");
	return {
		root,
		registryFile: join(root, "registry.json"),
		leasesDir: join(root, "leases"),
		claimsDir: join(root, "claims"),
		guardsDir: join(root, "guards"),
	};
}

function writeJsonFileSync(filePath: string, payload: unknown, replaceExisting = false): void {
	const serialized = `${JSON.stringify(payload, null, 2)}\n`;
	const temp = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx");
		writeSync(fd, serialized, 0, "utf8");
		fsyncSync(fd);
		// Publish only after the full payload is durable.
		closeSync(fd);
		fd = undefined;
		if (replaceExisting) {
			renameSync(temp, filePath);
		} else {
			// Hard-link publication is atomic and fails with EEXIST instead of
			// replacing a live record. Both names are on the same volume.
			linkSync(temp, filePath);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			rmSync(temp, { force: true });
		} catch {
			// Best-effort temp cleanup.
		}
	}
}

function readJsonFileSync(
	filePath: string,
): { ok: true; value: unknown } | { ok: false; missing?: boolean; message: string } {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, missing: true, message: `record not found: ${filePath}` };
		return { ok: false, message: `unreadable record ${filePath}: ${String(error)}` };
	}
	try {
		return { ok: true, value: parseJsonStrict(raw) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Session-open lease registry bound to one effective agentDir.
 *
 * All methods return typed results; none throws for expected failures. When
 * the store cannot be created or read, `available` is false, the session keeps
 * running degraded, and every trim-facing operation refuses.
 */
export class SessionOpenLeaseRegistry {
	readonly agentDir: string;
	readonly runtime: string;
	readonly buildHash: string;
	readonly processInventory: ProcessInventory;
	#paths: RegistryPaths;
	#available = false;
	#degradationReason: string | undefined;
	#registryCache: LeaseRegistryFile | undefined;

	private constructor(agentDir: string, options: SessionOpenLeaseRegistryOptions, paths: RegistryPaths) {
		this.agentDir = agentDir;
		this.runtime = options.runtime;
		this.buildHash = options.buildHash;
		this.processInventory = options.processInventory ?? createDefaultProcessInventory();
		this.#paths = paths;
	}

	/**
	 * Open (and lazily create) the lease store. Never throws: an unusable store
	 * leaves the registry degraded so the runtime can proceed unguarded.
	 */
	static open(agentDir: string, options: SessionOpenLeaseRegistryOptions): SessionOpenLeaseRegistry {
		const paths = registryPaths(agentDir);
		const registry = new SessionOpenLeaseRegistry(agentDir, options, paths);
		try {
			for (const dir of [paths.root, paths.leasesDir, paths.claimsDir, paths.guardsDir]) {
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			}
			registry.#ensureRegistryFile();
			registry.#available = true;
		} catch (error) {
			registry.#available = false;
			registry.#degradationReason = error instanceof Error ? error.message : String(error);
		}
		return registry;
	}

	get available(): boolean {
		return this.#available;
	}

	get degradationReason(): string | undefined {
		return this.#degradationReason;
	}

	get paths(): RegistryPaths {
		return this.#paths;
	}

	#ensureRegistryFile(): void {
		const read = readJsonFileSync(this.#paths.registryFile);
		if (read.ok) {
			const parsed = parseRegistryFile(read.value);
			if (!parsed) {
				throw new Error(`registry.json is not a valid v${LEASE_REGISTRY_FORMAT_VERSION} registry`);
			}
			this.#registryCache = parsed;
			return;
		}
		if (!read.missing) {
			throw new Error(read.message);
		}
		const defaults: LeaseRegistryFile = {
			format_version: LEASE_REGISTRY_FORMAT_VERSION,
			protocol_version: LEASE_REGISTRY_PROTOCOL_VERSION,
			real_write_enabled: false,
			approved_builds: [],
		};
		writeJsonFileSync(this.#paths.registryFile, defaults);
		this.#registryCache = defaults;
	}

	/** Read the registry file from disk (bypassing cache) with fail-closed validation. */
	readRegistry(): RegistryOpResult<LeaseRegistryFile> {
		if (!this.#available) {
			return fail("registry_invalid", this.#degradationReason ?? "lease registry unavailable");
		}
		const read = readJsonFileSync(this.#paths.registryFile);
		if (!read.ok) {
			if (read.missing) {
				try {
					this.#ensureRegistryFile();
				} catch (error) {
					return fail("registry_invalid", error instanceof Error ? error.message : String(error));
				}
				return this.readRegistry();
			}
			return fail("registry_invalid", read.message);
		}
		const parsed = parseRegistryFile(read.value);
		if (!parsed) return fail("registry_invalid", "registry.json failed v1 schema validation");
		this.#registryCache = parsed;
		return { ok: true, value: parsed };
	}

	/** Cached registry file, or a fresh read when never loaded. */
	getRegistryFile(): RegistryOpResult<LeaseRegistryFile> {
		if (!this.#available) return fail("registry_invalid", this.#degradationReason ?? "lease registry unavailable");
		if (this.#registryCache) return { ok: true, value: this.#registryCache };
		return this.readRegistry();
	}

	/**
	 * Promotion gate: real-write requires the registry to enable the flag and to
	 * approve this exact runtime build hash. Otherwise trim refuses.
	 */
	checkPromotionGate(): RegistryOpResult<LeaseRegistryFile> {
		const registry = this.readRegistry();
		if (!registry.ok) return registry;
		if (!registry.value.real_write_enabled) {
			return fail("registry_invalid", "real_write_enabled is false; owner promotion gate is closed");
		}
		if (!/^[a-f0-9]{64}$/.test(registry.value.t20_receipt_sha256 ?? "")) {
			return fail("registry_invalid", "T20 promotion receipt is missing or malformed");
		}
		if (!/^[a-f0-9]{64}$/.test(this.buildHash)) {
			return fail(
				"registry_invalid",
				"current runtime artifact identity is unavailable or the build receipt is dirty",
			);
		}
		const approved = registry.value.approved_builds.some(
			(build) =>
				build.runtime === this.runtime &&
				build.artifact_sha256 === this.buildHash &&
				build.protocol_version === LEASE_REGISTRY_PROTOCOL_VERSION &&
				build.launcher_path.length > 0,
		);
		if (!approved) {
			return fail("registry_invalid", `runtime build ${this.runtime}/${this.buildHash} is not in approved_builds`);
		}
		return registry;
	}

	// =========================================================================
	// Leases
	// =========================================================================

	/** Create the lease under the short per-identity update guard. */
	acquireLease(input: { sessionId: string; transcriptPath: string }): RegistryOpResult<LeaseRecord> {
		if (!this.#available) {
			return fail("registry_invalid", this.#degradationReason ?? "lease registry unavailable");
		}
		const { pathHash } = canonicalTranscriptIdentity(input.transcriptPath);
		return this.withIdentityGuard(pathHash, () => {
			const processStart = this.processInventory.getProcessStartUtc(process.pid) ?? PROCESS_START_UNKNOWN;
			const lease: LeaseRecord = {
				lease_id: createHash("sha256")
					.update(`${input.sessionId}:${pathHash}:${process.hrtime.bigint()}`)
					.digest("hex")
					.slice(0, 32),
				session_id: input.sessionId,
				path_hash: pathHash,
				pid: process.pid,
				process_start_utc: processStart,
				runtime: this.runtime,
				build_hash: this.buildHash,
				opened_at: new Date().toISOString(),
				lease_state: LEASE_STATE_OPEN,
			};
			const filePath = join(this.#paths.leasesDir, `${lease.lease_id}.json`);
			try {
				writeJsonFileSync(filePath, lease);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") return fail("lease_conflict", "lease record already exists");
				return fail("io_error", `failed to write lease: ${String(error)}`);
			}
			return { ok: true, value: lease };
		});
	}

	/** Release = delete the lease file under the per-identity guard (never a `closed` state). */
	releaseLease(leaseId: string): RegistryOpResult<true> {
		const leasePath = join(this.#paths.leasesDir, `${leaseId}.json`);
		const raw = readJsonFileSync(leasePath);
		if (!raw.ok) return raw.missing ? { ok: true, value: true } : fail("registry_invalid", raw.message);
		const record = parseLeaseRecord(raw.value);
		if (!record) return fail("registry_invalid", "lease record failed schema validation during release");
		return this.withIdentityGuard(record.path_hash, () => {
			try {
				unlinkSync(leasePath);
				return { ok: true, value: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: true };
				return fail("io_error", `failed to delete lease: ${String(error)}`);
			}
		});
	}

	/** List every parseable lease record for a canonical path hash. */
	listLeasesForPath(pathHash: string): { records: LeaseRecord[]; invalidRecords: number } {
		const records: LeaseRecord[] = [];
		let invalidRecords = 0;
		let names: string[] = [];
		try {
			names = existsSync(this.#paths.leasesDir) ? readdirSync(this.#paths.leasesDir) : [];
		} catch {
			return { records, invalidRecords };
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const read = readJsonFileSync(join(this.#paths.leasesDir, name));
			if (!read.ok) {
				invalidRecords++;
				continue;
			}
			const parsed = parseLeaseRecord(read.value);
			if (!parsed) {
				invalidRecords++;
				continue;
			}
			if (parsed.path_hash !== pathHash) continue;
			records.push(parsed);
		}
		return { records, invalidRecords };
	}

	/**
	 * Inspection used by `inspectSessionDataLease()`: the current runtime must
	 * hold exactly one live lease for the identity; any other live lease
	 * (unknown owner, malformed, another process) means trim/refuse.
	 */
	inspectLeaseUniqueness(input: {
		sessionId: string;
		transcriptPath: string;
	}): RegistryOpResult<{ unique: true; leaseId: string }> {
		const { pathHash } = canonicalTranscriptIdentity(input.transcriptPath);
		const { records, invalidRecords } = this.listLeasesForPath(pathHash);
		if (invalidRecords > 0) {
			return fail(
				"lease_conflict",
				`cannot prove lease uniqueness: ${invalidRecords} malformed lease record(s) exist`,
			);
		}
		const mine = records.filter(
			(lease) =>
				lease.session_id === input.sessionId &&
				lease.pid === process.pid &&
				lease.runtime === this.runtime &&
				lease.build_hash === this.buildHash,
		);
		if (mine.length === 0) {
			return invalidRecords > 0
				? fail("lease_missing", `no own lease for identity and ${invalidRecords} malformed lease record(s)`)
				: fail("lease_missing", "no lease record for this session/identity held by this runtime");
		}
		if (mine.length > 1) {
			return fail("lease_conflict", `multiple own leases (${mine.length}) for the same identity`);
		}
		const lease = mine[0]!;
		const ownStart = this.processInventory.getProcessStartUtc(process.pid) ?? PROCESS_START_UNKNOWN;
		if (ownStart === PROCESS_START_UNKNOWN || lease.process_start_utc !== ownStart) {
			return fail("lease_conflict", "current process start identity is unknown or does not match its lease");
		}
		// Unknown/other live owners: legacy runtime may hold a duplicate live
		// lease; anything not provably dead makes the identity not unique.
		for (const other of records) {
			if (other.lease_id === lease.lease_id) continue;
			if (this.processInventory.isProcessAlive(other.pid, other.process_start_utc)) {
				return fail("lease_conflict", `another live lease owner exists (pid ${other.pid})`);
			}
		}
		return { ok: true, value: { unique: true, leaseId: lease.lease_id } };
	}

	/** Reclaim leases of provably dead owners for an identity. */
	reclaimDeadLeases(pathHash: string): RegistryOpResult<number> {
		const { records } = this.listLeasesForPath(pathHash);
		let reclaimed = 0;
		for (const lease of records) {
			if (lease.pid === process.pid) continue;
			if (this.processInventory.isProcessAlive(lease.pid, lease.process_start_utc)) continue;
			const released = this.releaseLease(lease.lease_id);
			if (released.ok) reclaimed++;
		}
		return { ok: true, value: reclaimed };
	}

	// =========================================================================
	// Per-identity guard (short mutex for lease/claim updates)
	// =========================================================================

	/**
	 * Run `fn` while holding the per-identity guard record. Contention fails
	 * closed; a provably dead owner is reclaimed and the guard retaken. The
	 * guard record doubles as the lock registry entry for trim coordination.
	 */
	withIdentityGuard<T>(pathHash: string, fn: () => RegistryOpResult<T>): RegistryOpResult<T> {
		const guardPath = join(this.#paths.guardsDir, `${pathHash}.lock`);
		const processStart = this.processInventory.getProcessStartUtc(process.pid) ?? PROCESS_START_UNKNOWN;
		const guard: GuardRecord = {
			guard_id: createHash("sha256").update(`${pathHash}:${process.hrtime.bigint()}`).digest("hex").slice(0, 32),
			path_hash: pathHash,
			owner_pid: process.pid,
			owner_start_utc: processStart,
			started_at: new Date().toISOString(),
		};
		try {
			writeJsonFileSync(guardPath, guard);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				return fail("io_error", `failed to acquire identity guard: ${String(error)}`);
			}
			// Contention: reclaim only with an OS death proof.
			const existing = readJsonFileSync(guardPath);
			if (!existing.ok) {
				return fail("writer_conflict", "identity guard record exists but is unreadable");
			}
			const parsed = parseGuardRecord(existing.value);
			if (!parsed) {
				return fail("registry_invalid", "existing identity guard record failed schema validation");
			}
			if (parsed.owner_pid === process.pid) {
				return fail("writer_conflict", "identity guard is already held by this process");
			}
			if (this.processInventory.isProcessAlive(parsed.owner_pid, parsed.owner_start_utc)) {
				return fail("writer_conflict", `identity guard held by live owner (pid ${parsed.owner_pid})`);
			}
			const stalePath = `${guardPath}.${parsed.guard_id}.stale`;
			try {
				// Atomic quarantine of the exact record we observed; then re-read its
				// guard_id/path_hash before deleting it. No age/mtime inference.
				renameSync(guardPath, stalePath);
			} catch (renameError) {
				return fail("writer_conflict", `failed to atomically reclaim stale identity guard: ${String(renameError)}`);
			}
			const quarantined = readJsonFileSync(stalePath);
			const quarantinedRecord = quarantined.ok ? parseGuardRecord(quarantined.value) : null;
			if (
				!quarantinedRecord ||
				quarantinedRecord.guard_id !== parsed.guard_id ||
				quarantinedRecord.path_hash !== pathHash
			) {
				return fail(
					"recovery_blocked",
					"identity guard changed during stale-owner reclaim; quarantined record retained",
				);
			}
			try {
				unlinkSync(stalePath);
			} catch (removeError) {
				return fail("io_error", `failed to remove quarantined dead identity guard: ${String(removeError)}`);
			}
			return this.withIdentityGuard(pathHash, fn);
		}
		let result: RegistryOpResult<T>;
		try {
			result = fn();
		} finally {
			try {
				rmSync(guardPath, { force: true });
			} catch {
				// Leave a provably reclaimable record; never crash the caller.
			}
		}
		return result;
	}

	/** Write the guard record without holding it (used while an OS guard is held). */
	publishGuardRecord(pathHash: string, guardId: string): RegistryOpResult<GuardRecord> {
		const processStart = this.processInventory.getProcessStartUtc(process.pid) ?? PROCESS_START_UNKNOWN;
		const record: GuardRecord = {
			guard_id: guardId,
			path_hash: pathHash,
			owner_pid: process.pid,
			owner_start_utc: processStart,
			started_at: new Date().toISOString(),
		};
		try {
			writeJsonFileSync(join(this.#paths.guardsDir, `${pathHash}.lock`), record);
			return { ok: true, value: record };
		} catch (error) {
			return fail("io_error", `failed to write guard record: ${String(error)}`);
		}
	}

	readGuardRecord(pathHash: string): RegistryOpResult<GuardRecord | null> {
		const read = readJsonFileSync(join(this.#paths.guardsDir, `${pathHash}.lock`));
		if (!read.ok) {
			if (read.missing) return { ok: true, value: null };
			return fail("registry_invalid", read.message);
		}
		const parsed = parseGuardRecord(read.value);
		if (!parsed) return fail("registry_invalid", "guard record failed schema validation");
		return { ok: true, value: parsed };
	}

	clearGuardRecord(pathHash: string, expectedGuardId?: string): RegistryOpResult<true> {
		const guardPath = join(this.#paths.guardsDir, `${pathHash}.lock`);
		const current = this.readGuardRecord(pathHash);
		if (!current.ok) return current;
		if (!current.value) return { ok: true, value: true };
		if (expectedGuardId && current.value.guard_id !== expectedGuardId) {
			return fail("writer_conflict", "guard id changed before release");
		}
		try {
			unlinkSync(guardPath);
			return { ok: true, value: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: true };
			return fail("io_error", `failed to clear guard record: ${String(error)}`);
		}
	}

	// =========================================================================
	// Claims (mutation journal)
	// =========================================================================

	readClaim(pathHash: string): RegistryOpResult<LeaseClaimRecord | null> {
		const read = readJsonFileSync(join(this.#paths.claimsDir, `${pathHash}.json`));
		if (!read.ok) {
			if (read.missing) return { ok: true, value: null };
			return fail("registry_invalid", read.message);
		}
		const parsed = parseClaimRecord(read.value);
		if (!parsed) return fail("registry_invalid", "claim record failed schema validation");
		return { ok: true, value: parsed };
	}

	/** Create the claim; refuses when a live claim already exists for the identity. */
	createClaim(record: LeaseClaimRecord): RegistryOpResult<true> {
		const claimPath = join(this.#paths.claimsDir, `${record.path_hash}.json`);
		if (existsSync(claimPath)) {
			return this.withIdentityGuard(record.path_hash, () => {
				const existing = this.readClaim(record.path_hash);
				if (!existing.ok) return fail("registry_invalid", existing.message);
				if (existing.value !== null) {
					const claim = existing.value;
					if (this.processInventory.isProcessAlive(claim.owner_pid, claim.owner_start_utc)) {
						return fail("writer_conflict", `live mutation claim exists (pid ${claim.owner_pid})`);
					}
				}
				try {
					writeJsonFileSync(claimPath, record, true);
					return { ok: true, value: true } as RegistryOpResult<true>;
				} catch (error) {
					return fail("io_error", `failed to write claim: ${String(error)}`);
				}
			});
		}
		try {
			writeJsonFileSync(claimPath, record);
			return { ok: true, value: true };
		} catch (error) {
			return fail("io_error", `failed to write claim: ${String(error)}`);
		}
	}

	/** Update the claim under the per-identity guard (phase journal advances). */
	updateClaim(
		pathHash: string,
		update: Partial<Pick<LeaseClaimRecord, "phase" | "candidate_fingerprint" | "backup_name">> & {
			expectedPhase?: LeaseClaimPhase;
		},
	): RegistryOpResult<LeaseClaimRecord> {
		return this.withIdentityGuard(pathHash, () => {
			const existing = this.readClaim(pathHash);
			if (!existing.ok) return fail("registry_invalid", existing.message);
			if (existing.value === null) return fail("lease_missing", "no claim record to update");
			const claim = existing.value;
			if (update.expectedPhase && claim.phase !== update.expectedPhase) {
				return fail(
					"recovery_blocked",
					`claim phase ${claim.phase} does not match expected ${update.expectedPhase}`,
				);
			}
			const updated: LeaseClaimRecord = {
				...claim,
				...(update.phase ? { phase: update.phase } : {}),
				...(update.candidate_fingerprint ? { candidate_fingerprint: update.candidate_fingerprint } : {}),
				...(update.backup_name ? { backup_name: update.backup_name } : {}),
			};
			try {
				writeJsonFileSync(join(this.#paths.claimsDir, `${pathHash}.json`), updated, true);
				return { ok: true, value: updated } as RegistryOpResult<LeaseClaimRecord>;
			} catch (error) {
				return fail("io_error", `failed to update claim: ${String(error)}`);
			}
		});
	}

	/**
	 * Advance a mutation claim while its owning OS transcript guard is held.
	 * This avoids trying to acquire the short identity mutex recursively: the
	 * durable guard record and lock_id jointly prove the same transaction owns
	 * the update, while the OS guard excludes cross-process writers.
	 */
	updateOwnedClaim(
		pathHash: string,
		lockId: string,
		guardId: string,
		update: Partial<Pick<LeaseClaimRecord, "phase" | "candidate_fingerprint" | "backup_name">>,
	): RegistryOpResult<LeaseClaimRecord> {
		const existing = this.readClaim(pathHash);
		if (!existing.ok) return fail("registry_invalid", existing.message);
		if (!existing.value || existing.value.lock_id !== lockId) {
			return fail("recovery_blocked", "claim lock id does not match the held session lock");
		}
		const guard = this.readGuardRecord(pathHash);
		if (!guard.ok) return fail("registry_invalid", guard.message);
		if (!guard.value || guard.value.guard_id !== guardId || guard.value.owner_pid !== process.pid) {
			return fail("writer_conflict", "OS guard record does not match the held session guard");
		}
		const updated: LeaseClaimRecord = {
			...existing.value,
			...(update.phase ? { phase: update.phase } : {}),
			...(update.candidate_fingerprint ? { candidate_fingerprint: update.candidate_fingerprint } : {}),
			...(update.backup_name ? { backup_name: update.backup_name } : {}),
		};
		try {
			writeJsonFileSync(join(this.#paths.claimsDir, `${pathHash}.json`), updated, true);
			return { ok: true, value: updated };
		} catch (error) {
			return fail("io_error", `failed to update owned claim: ${String(error)}`);
		}
	}

	/** Delete a claim under the short identity guard; optionally fence by lock_id. */
	clearClaim(pathHash: string, expectedLockId?: string): RegistryOpResult<true> {
		return this.withIdentityGuard(pathHash, () => {
			const current = this.readClaim(pathHash);
			if (!current.ok) return fail("registry_invalid", current.message);
			if (!current.value) return { ok: true, value: true };
			if (expectedLockId && current.value.lock_id !== expectedLockId) {
				return fail("recovery_blocked", "claim lock id changed before release");
			}
			if (
				!expectedLockId &&
				this.processInventory.isProcessAlive(current.value.owner_pid, current.value.owner_start_utc)
			) {
				return fail("writer_conflict", `cannot clear live claim owner (pid ${current.value.owner_pid})`);
			}
			try {
				unlinkSync(join(this.#paths.claimsDir, `${pathHash}.json`));
				return { ok: true, value: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: true };
				return fail("io_error", `failed to clear claim: ${String(error)}`);
			}
		});
	}

	/**
	 * Safe recovery of a stale claim per the crash-recovery contract:
	 * - owner alive -> refuse (writer_conflict)
	 * - owner dead, original fingerprint still on disk -> clear the stale claim
	 * - owner dead, current bytes match the recorded candidate and `verifier`
	 *   passes -> finalize (clear claim, report finalized)
	 * - owner dead, backup exists and hashes to the original -> caller may
	 *   restore under an OS guard; reported as `restore_candidate`
	 * - anything else -> `blocked` (recovery inspector shows phase + hashes)
	 */
	recoverStaleClaim(input: {
		pathHash: string;
		transcriptPath: string;
		verifier?: (raw: Buffer) => boolean;
	}): RegistryOpResult<
		| { action: "cleared" }
		| { action: "finalized" }
		| { action: "restore_candidate"; backupPath: string; expectedCurrentFingerprint: string }
		| { action: "blocked"; reason: string }
	> {
		const existing = this.readClaim(input.pathHash);
		if (!existing.ok) return fail("registry_invalid", existing.message);
		const claim = existing.value;
		if (claim === null) return { ok: true, value: { action: "cleared" } };
		if (this.processInventory.isProcessAlive(claim.owner_pid, claim.owner_start_utc)) {
			return fail("writer_conflict", `mutation claim owner is alive (pid ${claim.owner_pid})`);
		}
		const currentFingerprint = fileFingerprint(input.transcriptPath);
		if (currentFingerprint === null) {
			return { ok: true, value: { action: "blocked", reason: "transcript file is unreadable or missing" } };
		}
		if (currentFingerprint === claim.original_fingerprint) {
			const cleared = this.clearClaim(input.pathHash);
			if (!cleared.ok) return cleared;
			return { ok: true, value: { action: "cleared" } };
		}
		if (claim.candidate_fingerprint && currentFingerprint === claim.candidate_fingerprint) {
			let verifierPassed = true;
			try {
				verifierPassed = input.verifier ? input.verifier(readFileSync(input.transcriptPath)) : true;
			} catch {
				verifierPassed = false;
			}
			if (verifierPassed) {
				const cleared = this.clearClaim(input.pathHash);
				if (!cleared.ok) return cleared;
				return { ok: true, value: { action: "finalized" } };
			}
		}
		if (claim.backup_name) {
			const backupPath = join(this.#paths.root, "backups", claim.backup_name);
			if (existsSync(backupPath) && fileFingerprint(backupPath) === claim.original_fingerprint) {
				return {
					ok: true,
					value: {
						action: "restore_candidate",
						backupPath,
						expectedCurrentFingerprint: currentFingerprint,
					},
				};
			}
		}
		return {
			ok: true,
			value: {
				action: "blocked",
				reason: `claim phase ${claim.phase}: current hash matches neither original nor candidate`,
			},
		};
	}

	/** Guarded restore of a backup over the transcript under an exclusive OS guard. */
	async guardedRestore(input: {
		transcriptPath: string;
		backupPath: string;
		pathHash: string;
		expectedCurrentFingerprint: string;
		guardOpTimeoutMs?: number;
	}): Promise<RegistryOpResult<{ fingerprint: string }>> {
		const acquired = await TranscriptWriteGuard.acquire(input.transcriptPath, {
			mode: "exclusive",
			opTimeoutMs: input.guardOpTimeoutMs,
		});
		if (!acquired.ok) {
			return fail(
				acquired.code === "writer_conflict" ? "writer_conflict" : "write_guard_unavailable",
				acquired.message,
			);
		}
		const guard = acquired.guard;
		try {
			if (fileFingerprint(input.transcriptPath) !== input.expectedCurrentFingerprint) {
				return fail("recovery_blocked", "transcript changed after recovery inspection; guarded restore refused");
			}
			const rewritten = await guard.rewrite(input.backupPath);
			if (!rewritten.ok) {
				return fail(
					rewritten.code === "writer_conflict" ? "writer_conflict" : "write_guard_unavailable",
					rewritten.message,
				);
			}
		} finally {
			await guard.release();
		}
		const fingerprint = fileFingerprint(input.transcriptPath);
		if (fingerprint === null) return fail("io_error", "restored transcript is unreadable");
		return { ok: true, value: { fingerprint } };
	}
}
