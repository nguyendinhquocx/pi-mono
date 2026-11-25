/**
 * Local global-policy for the Li-only "Telegram follow-up" feature (SPEC-2026-11-09).
 *
 * The policy file lives under the TelePi supervisor root so every open Li
 * session, the Li Settings submenu and the TelePi bridge all observe the same
 * canonical state without restarts. It is deliberately NOT stored in
 * `.pi/settings.json`: that file is process-local and would create a second
 * source of truth across Li processes.
 *
 * Failure policy is fail-closed: a missing file means Off with default delays,
 * a malformed or unknown-version file means Off with a safe diagnostic code.
 * Diagnostics never embed file content.
 */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const TELEGRAM_FOLLOW_UP_POLICY_VERSION = 1;
/** Protocol the TelePi bridge must report before the master toggle may turn On. */
export const GLOBAL_STATUS_PROTOCOL_VERSION = 2;
/** A global-status heartbeat older than this is treated as "No bridge". */
export const BRIDGE_HEARTBEAT_FRESH_MS = 45_000;
/** Delay presets offered per channel (minutes); `null` keeps that channel Off. */
export const DELAY_PRESET_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export type DelayMinutes = (typeof DELAY_PRESET_MINUTES)[number];

export const DEFAULT_FINAL_ANSWER_DELAY_MINUTES: DelayMinutes = 10;
export const DEFAULT_ASK_USER_DELAY_MINUTES: DelayMinutes = 5;
export const DEFAULT_TERMINAL_NOTICE_DELAY_MINUTES: DelayMinutes = 5;

export interface TelegramFollowUpPolicy {
	version: typeof TELEGRAM_FOLLOW_UP_POLICY_VERSION;
	/** Monotonic counter bumped on every committed change. */
	revision: number;
	enabled: boolean;
	/** null = channel off ("Off" preset). */
	finalAnswerDelayMinutes: DelayMinutes | null;
	askUserDelayMinutes: DelayMinutes | null;
	terminalNoticeDelayMinutes: DelayMinutes | null;
}

export function defaultTelegramFollowUpPolicy(): TelegramFollowUpPolicy {
	return {
		version: TELEGRAM_FOLLOW_UP_POLICY_VERSION,
		revision: 0,
		enabled: false,
		finalAnswerDelayMinutes: DEFAULT_FINAL_ANSWER_DELAY_MINUTES,
		askUserDelayMinutes: DEFAULT_ASK_USER_DELAY_MINUTES,
		terminalNoticeDelayMinutes: DEFAULT_TERMINAL_NOTICE_DELAY_MINUTES,
	};
}

/**
 * Same resolution contract as TelePi's `getDefaultTelePiSupervisorDir` plus the
 * shared `TELEPI_SUPERVISOR_DIR` override. A root mismatch between processes is
 * a hard failure: readers fail closed instead of guessing another root.
 */
export function resolveSupervisorRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDirectory: string = homedir(),
): string {
	const override = env.TELEPI_SUPERVISOR_DIR?.trim();
	if (override) return override;
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || join(homeDirectory, "AppData", "Roaming");
		return join(appData, "telepi", "supervisor");
	}
	return join(homeDirectory, ".config", "telepi", "supervisor");
}

export function globalPolicyPath(root: string): string {
	return join(root, "global-policy.json");
}

export function globalStatusPath(root: string): string {
	return join(root, "global-status.json");
}

export type PolicyReadSource = "file" | "missing" | "invalid";
/** Safe, content-free codes surfaced to the TUI/log. */
export type PolicyDiagnostic = "ERR_POLICY_READ" | "ERR_POLICY_SCHEMA" | "ERR_POLICY_VERSION";

export interface PolicyReadResult {
	policy: TelegramFollowUpPolicy;
	source: PolicyReadSource;
	diagnostic?: PolicyDiagnostic;
}

function isValidDelay(value: unknown): value is DelayMinutes | null {
	return value === null || (DELAY_PRESET_MINUTES as readonly unknown[]).includes(value);
}

function normalizePolicy(value: unknown): TelegramFollowUpPolicy | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.version !== TELEGRAM_FOLLOW_UP_POLICY_VERSION) return undefined;
	if (typeof raw.revision !== "number" || !Number.isFinite(raw.revision) || raw.revision < 0) return undefined;
	if (typeof raw.enabled !== "boolean") return undefined;
	if (!isValidDelay(raw.finalAnswerDelayMinutes)) return undefined;
	if (!isValidDelay(raw.askUserDelayMinutes)) return undefined;
	if (!isValidDelay(raw.terminalNoticeDelayMinutes)) return undefined;
	return {
		version: TELEGRAM_FOLLOW_UP_POLICY_VERSION,
		revision: raw.revision,
		enabled: raw.enabled,
		finalAnswerDelayMinutes: raw.finalAnswerDelayMinutes,
		askUserDelayMinutes: raw.askUserDelayMinutes,
		terminalNoticeDelayMinutes: raw.terminalNoticeDelayMinutes,
	};
}

export function readGlobalPolicy(root: string): PolicyReadResult {
	const path = globalPolicyPath(root);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Missing file is the normal pre-enable state, not an error.
		return { policy: defaultTelegramFollowUpPolicy(), source: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { policy: defaultTelegramFollowUpPolicy(), source: "invalid", diagnostic: "ERR_POLICY_SCHEMA" };
	}
	const normalized = normalizePolicy(parsed);
	if (!normalized) {
		const version = (parsed as Record<string, unknown> | null)?.version;
		return {
			policy: defaultTelegramFollowUpPolicy(),
			source: "invalid",
			diagnostic: version === TELEGRAM_FOLLOW_UP_POLICY_VERSION ? "ERR_POLICY_SCHEMA" : "ERR_POLICY_VERSION",
		};
	}
	return { policy: normalized, source: "file" };
}

export interface GlobalStatusSnapshot {
	/** False when the file is absent or unreadable. */
	present: boolean;
	protocolVersion?: number;
	updatedAtMs?: number;
	/** Compact delivery summary (no content); unknown unless allowlisted. */
	lastDeliveryStatus?: "sent" | "failed" | "unknown";
	lastDeliveryCode?: (typeof GLOBAL_STATUS_ERROR_CODES)[number];
	/** True only when present, protocol v2 and the heartbeat is fresh. */
	freshBridge: boolean;
}

/** Allowlisted compact codes TelePi may write; anything else is dropped. */
export const GLOBAL_STATUS_ERROR_CODES = ["AUTH", "403", "429", "PARSE", "NETWORK", "OTHER"] as const;

const GLOBAL_STATUS_DELIVERY_STATES = ["sent", "failed", "unknown"] as const;

export function readGlobalStatus(root: string, now: number = Date.now()): GlobalStatusSnapshot {
	const path = globalStatusPath(root);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { present: false, freshBridge: false };
	}
	if (!parsed || typeof parsed !== "object") return { present: false, freshBridge: false };
	const raw = parsed as Record<string, unknown>;
	const protocolVersion = typeof raw.protocolVersion === "number" ? raw.protocolVersion : undefined;
	const updatedAtMs =
		typeof raw.updatedAt === "string"
			? Number.isNaN(Date.parse(raw.updatedAt))
				? undefined
				: Date.parse(raw.updatedAt)
			: undefined;
	let lastDeliveryStatus: GlobalStatusSnapshot["lastDeliveryStatus"];
	let lastDeliveryCode: GlobalStatusSnapshot["lastDeliveryCode"];
	if (raw.lastDelivery && typeof raw.lastDelivery === "object") {
		const delivery = raw.lastDelivery as Record<string, unknown>;
		if ((GLOBAL_STATUS_DELIVERY_STATES as readonly unknown[]).includes(delivery.status)) {
			lastDeliveryStatus = delivery.status as GlobalStatusSnapshot["lastDeliveryStatus"];
		}
		if ((GLOBAL_STATUS_ERROR_CODES as readonly unknown[]).includes(delivery.code)) {
			lastDeliveryCode = delivery.code as GlobalStatusSnapshot["lastDeliveryCode"];
		}
	}
	const freshBridge =
		protocolVersion === GLOBAL_STATUS_PROTOCOL_VERSION &&
		updatedAtMs !== undefined &&
		now - updatedAtMs >= 0 &&
		now - updatedAtMs <= BRIDGE_HEARTBEAT_FRESH_MS;
	return { present: true, protocolVersion, updatedAtMs, lastDeliveryStatus, lastDeliveryCode, freshBridge };
}

export type EnableBlockReason = "no_bridge" | "stale_bridge" | "wrong_protocol";

export interface EnableGateResult {
	ok: boolean;
	reason?: EnableBlockReason;
}

/**
 * Turning the master switch On requires a live TelePi v2 bridge. This reads
 * `global-status.json` (durable, written by TelePi itself) so Li never enables
 * follow-up against an old or dead bridge.
 */
export function evaluateEnableGate(root: string, now: number = Date.now()): EnableGateResult {
	const status = readGlobalStatus(root, now);
	if (!status.present) return { ok: false, reason: "no_bridge" };
	if (status.protocolVersion !== GLOBAL_STATUS_PROTOCOL_VERSION) return { ok: false, reason: "wrong_protocol" };
	if (!status.freshBridge) return { ok: false, reason: "stale_bridge" };
	return { ok: true };
}

export type PolicyWriteCode =
	| "ERR_LOCK_TIMEOUT"
	| "ERR_WRITE"
	| "ERR_POLICY_SCHEMA"
	| "ENABLE_NO_BRIDGE"
	| "ENABLE_STALE_BRIDGE"
	| "ENABLE_WRONG_PROTOCOL";

export interface PolicyWriteResult {
	ok: boolean;
	/** Latest known policy on success, or the unchanged previous policy on failure. */
	policy: TelegramFollowUpPolicy;
	diagnostic?: PolicyWriteCode;
}

export type PolicyMutation = (policy: TelegramFollowUpPolicy) => TelegramFollowUpPolicy;

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 5_000;

/**
 * Naive but dependency-free cross-process lock: exclusive create of
 * `<file>.lock` with stale-lock takeover. Held only for the read-mutate-write
 * window, so contention is short and rare (Settings writes).
 */
function acquireLock(lockPath: string, deadline: number): boolean {
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") return false;
			try {
				const age = Date.now() - statSync(lockPath).mtimeMs;
				if (age > LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				// Lock vanished; retry immediately.
				continue;
			}
		}
		if (Date.now() >= deadline) return false;
		// Busy-wait with a tiny sleep keeps the window short without adding deps.
		const until = Date.now() + LOCK_RETRY_MS;
		while (Date.now() < until) {
			// spin
		}
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

/**
 * Locked read-mutate-write with compare/re-read: the mutation is applied to the
 * newest on-disk policy (not the caller's snapshot), and the revision counter
 * increments monotonically so watchers can detect any committed change.
 */
export function writeGlobalPolicy(
	root: string,
	mutate: PolicyMutation,
	options: {
		enableGate?: (policy: TelegramFollowUpPolicy, previous: TelegramFollowUpPolicy) => EnableGateResult;
	} = {},
): PolicyWriteResult {
	const path = globalPolicyPath(root);
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	if (!acquireLock(lockPath, deadline)) {
		return { ok: false, policy: readGlobalPolicy(root).policy, diagnostic: "ERR_LOCK_TIMEOUT" };
	}
	try {
		const current = readGlobalPolicy(root);
		// Apply on defaults even when the file was missing/invalid, but keep the
		// previous (fail-closed) state visible if anything below fails.
		const base = current.source === "file" ? current.policy : defaultTelegramFollowUpPolicy();
		const nextRaw = mutate(base);
		const previous = current.source === "file" ? current.policy : defaultTelegramFollowUpPolicy();
		if (options.enableGate && !previous.enabled && nextRaw.enabled) {
			const gate = options.enableGate(nextRaw, previous);
			if (!gate.ok) {
				const code =
					gate.reason === "no_bridge"
						? "ENABLE_NO_BRIDGE"
						: gate.reason === "stale_bridge"
							? "ENABLE_STALE_BRIDGE"
							: "ENABLE_WRONG_PROTOCOL";
				return {
					ok: false,
					policy: current.source === "file" ? current.policy : defaultTelegramFollowUpPolicy(),
					diagnostic: code,
				};
			}
		}
		const next = normalizePolicy({
			...nextRaw,
			version: TELEGRAM_FOLLOW_UP_POLICY_VERSION,
			revision: base.revision + 1,
		});
		if (!next) {
			return {
				ok: false,
				policy: current.source === "file" ? current.policy : defaultTelegramFollowUpPolicy(),
				diagnostic: "ERR_POLICY_SCHEMA",
			};
		}
		writeJsonAtomic(path, next);
		return { ok: true, policy: next };
	} catch {
		return { ok: false, policy: readGlobalPolicy(root).policy, diagnostic: "ERR_WRITE" };
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			// Best-effort release; stale locks are reclaimed by the timeout above.
		}
	}
}

/** Format a delay value for the TUI ("Off", "1m", "10m"). */
export function formatDelayMinutes(minutes: DelayMinutes | null): string {
	return minutes === null ? "Off" : `${minutes}m`;
}

/** Test/preview helper: a throwaway supervisor root under the OS temp dir. */
export function temporarySupervisorRoot(): string {
	return join(tmpdir(), `telepi-supervisor-test-${randomUUID()}`);
}
