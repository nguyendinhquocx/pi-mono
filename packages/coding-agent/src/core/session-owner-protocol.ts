/**
 * Shared session owner protocol (SPEC-2026-11-16-li-web, T1).
 *
 * One canonical `AgentSession` writer per session file. The open-lease
 * registry already prevents two processes from holding the same session;
 * this layer adds the wire contract the LiX host (T2) and browser clients
 * (T3) depend on:
 *
 * - `OWNER_PROTOCOL_VERSION` — capability handshake. A runtime that cannot
 *   declare this version (e.g. an SDK without the module) must be refused
 *   by the host preflight instead of silently sharing a session.
 * - Strict writer enforcement (`PI_SESSION_OWNER_STRICT=1` or runtime
 *   binding `writerEnforcement: "strict"`): when the lease registry is
 *   unavailable the runtime REFUSES writes instead of continuing unguarded.
 *   Non-strict (plain local TUI) keeps the historical degrade behavior so
 *   existing local workflows are not broken; strict is required for any
 *   runtime that participates in cross-client ownership.
 * - Handoff: token-based two-step transfer in the registry
 *   (`beginHandoff` → `claimHandoff`). No timeout takeover; a hung owner is
 *   only removed via OS death proof (registry reclaim path).
 * - Idle definition for handoff: no pending session work (steering, follow
 *   up, compaction, retry, queued turns…) AND no pending UI request.
 *   A dialog waiting for user response is NOT idle.
 */

export const OWNER_PROTOCOL_VERSION = 1;
/** How often a strict owner refreshes its lease heartbeat while running (ms). */
export const OWNER_HEARTBEAT_INTERVAL_MS = 15_000;

/** A heartbeat older than this is stale; combined with file silence it means owner death is plausible. */
export const OWNER_HEARTBEAT_STALE_MS = 90_000;

export type OwnerKind = "tui" | "lix-worker" | "protocol-test";
export type { WriterState } from "./session-open-lease.ts";

import { resolve } from "node:path";
import { type LeaseRecord, type RegistryOpResult, SessionOpenLeaseRegistry } from "./session-open-lease.ts";

/** Thrown in strict mode when the writer cannot prove exclusive ownership. */
export class SessionOwnerUnavailableError extends Error {
	readonly code = "owner_unavailable";
	readonly pathHash: string | undefined;
	constructor(message: string, pathHash?: string) {
		super(message);
		this.name = "SessionOwnerUnavailableError";
		this.pathHash = pathHash;
	}
}

/** Thrown when a handoff cannot proceed (busy, conflict, unknown token). */
export class SessionHandoffError extends Error {
	readonly code: "handoff_refused" | "writer_conflict";
	readonly pendingWork?: Record<string, number | boolean>;
	constructor(
		code: "handoff_refused" | "writer_conflict",
		message: string,
		pendingWork?: Record<string, number | boolean>,
	) {
		super(message);
		this.name = "SessionHandoffError";
		this.code = code;
		this.pendingWork = pendingWork;
	}
}

/** Thrown when an attach declares an incompatible owner protocol version. */
export class OwnerProtocolMismatchError extends Error {
	readonly code = "protocol_mismatch";
	readonly declared: number | undefined;
	constructor(message: string, declared?: number) {
		super(message);
		this.name = "OwnerProtocolMismatchError";
		this.declared = declared;
	}
}

export function resolveOwnerStrictMode(binding?: string): boolean {
	if (binding === "strict") return true;
	const env = process.env.PI_SESSION_OWNER_STRICT;
	return env === "1" || env === "true";
}

/** Validate a declared protocol version from an attach/handshake request. */
export function checkOwnerProtocolVersion(declared: number | undefined): void {
	if (declared === undefined) {
		throw new OwnerProtocolMismatchError("attach did not declare an owner protocol version", undefined);
	}
	if (!Number.isInteger(declared) || declared < 1) {
		throw new OwnerProtocolMismatchError(`invalid owner protocol version: ${String(declared)}`, declared);
	}
	if (declared !== OWNER_PROTOCOL_VERSION) {
		throw new OwnerProtocolMismatchError(
			`owner protocol version mismatch: runtime supports ${OWNER_PROTOCOL_VERSION}, peer declared ${declared}`,
			declared,
		);
	}
}

/** Claim a pending lease inside this process without exiting on a failed request. */
export function claimSessionHandoffInProcess(input: {
	agentDir: string;
	pathHash: string;
	token: string;
	sessionId: string;
	ownerKind: OwnerKind;
}): RegistryOpResult<LeaseRecord> {
	const registry = SessionOpenLeaseRegistry.open(input.agentDir, {
		runtime: "owner-protocol",
		buildHash: OWNER_PROTOCOL_VERSION.toString(),
	});
	return registry.claimHandoff({
		pathHash: input.pathHash,
		token: input.token,
		sessionId: input.sessionId,
		ownerKind: input.ownerKind,
		ownerProtocolVersion: OWNER_PROTOCOL_VERSION,
	});
}

/**
 * Claim a successor lease before constructing AgentSession. The one-use env
 * value is consumed even on malformed/failed claims so it cannot leak to child
 * processes. The caller chooses the owner kind for the new process.
 */
export function claimSessionHandoffFromEnv(
	env: NodeJS.ProcessEnv,
	options: {
		ownerKind: OwnerKind;
		expectedAgentDir?: string;
		expectedPathHash?: string;
		expectedSessionId?: string;
		exit?: (code: number) => never;
	},
): LeaseRecord | undefined {
	const raw = env.PI_SESSION_OWNER_CLAIM;
	if (!raw) return undefined;
	delete env.PI_SESSION_OWNER_CLAIM;
	const parts = raw.split("|");
	if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
		process.stderr.write("PI_SESSION_OWNER_CLAIM malformed; expected agentDir|pathHash|token|sessionId\n");
		(options.exit ?? process.exit)(1);
	}
	const [agentDir, pathHash, token, sessionId] = parts as [string, string, string, string];
	const normalizeAgentDir = (value: string): string => {
		const absolute = resolve(value);
		return process.platform === "win32" ? absolute.toLowerCase() : absolute;
	};
	const targetMismatch =
		(options.expectedAgentDir !== undefined &&
			normalizeAgentDir(agentDir) !== normalizeAgentDir(options.expectedAgentDir)) ||
		(options.expectedPathHash !== undefined && pathHash !== options.expectedPathHash) ||
		(options.expectedSessionId !== undefined && sessionId !== options.expectedSessionId);
	if (targetMismatch) {
		process.stderr.write("PI_SESSION_OWNER_CLAIM target does not match the session selected by this runtime\n");
		(options.exit ?? process.exit)(1);
		return undefined;
	}
	const claimed = claimSessionHandoffInProcess({ agentDir, pathHash, token, sessionId, ownerKind: options.ownerKind });
	if (!claimed.ok) {
		process.stderr.write(`owner handoff claim failed: ${claimed.code}: ${claimed.message}\n`);
		(options.exit ?? process.exit)(1);
		return undefined;
	}
	process.stderr.write(
		`owner handoff claimed: epoch=${String(claimed.value.owner_epoch)} lease=${claimed.value.lease_id}\n`,
	);
	return claimed.value;
}
