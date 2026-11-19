/**
 * Session-owner and loopback-bridge fixture for T1 integration tests
 * (SPEC-2026-11-16-li-web). Runs as a REAL separate process:
 *
 *   node --experimental-strip-types test/fixtures/owner-protocol-child.ts
 *
 * Reads one JSON command per stdin line, writes one JSON result per stdout
 * line. This fixture proves cross-process registry ownership and bridge
 * framing against a minimal session adapter. It does NOT prove interactive TUI
 * rendering, LiX gateway/browser integration, or provider-backed turns.
 */
import { createInterface } from "node:readline";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { SessionOpenLeaseRegistry } from "../../src/core/session-open-lease.ts";
import {
	claimSessionHandoffFromEnv,
	claimSessionHandoffInProcess,
	OWNER_PROTOCOL_VERSION,
} from "../../src/core/session-owner-protocol.ts";
import {
	OwnerBridgeServer,
	type OwnerBridgeSession,
	type OwnerBridgeStatus,
} from "../../src/modes/interactive/owner-bridge-server.ts";

type Command =
	| { cmd: "acquire"; agentDir: string; sessionId: string; transcriptPath: string }
	| { cmd: "adopt"; agentDir: string; pathHash: string }
	| { cmd: "beginHandoff"; agentDir: string; leaseId: string }
	| { cmd: "claim"; agentDir: string; pathHash: string; token: string; sessionId: string }
	| { cmd: "claimEnv"; agentDir: string; pathHash: string; token: string; sessionId: string }
	| { cmd: "abortHandoff"; agentDir: string; leaseId: string }
	| { cmd: "heartbeat"; agentDir: string; leaseId: string; writerState?: "idle" | "running" }
	| { cmd: "getLease"; agentDir: string; pathHash: string }
	| { cmd: "startBridge"; agentDir: string; sessionFile: string; sessionId: string; pathHash: string }
	| { cmd: "emitBridgeEvent"; name: string }
	| { cmd: "stopBridge" }
	| { cmd: "ping" };

class FixtureBridgeSession implements OwnerBridgeSession {
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private pending = false;
	private claimed = false;
	private readonly handoffToken = "fixture-handoff-token-0123456789";
	private readonly sessionFile: string;
	private readonly sessionId: string;
	private readonly pathHash: string;

	constructor(sessionFile: string, sessionId: string, pathHash: string) {
		this.sessionFile = sessionFile;
		this.sessionId = sessionId;
		this.pathHash = pathHash;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}

	isPersisted(): boolean {
		return true;
	}

	getOwnerStatus(): OwnerBridgeStatus {
		return {
			protocolVersion: OWNER_PROTOCOL_VERSION,
			strict: true,
			ownerKind: this.claimed ? "lix-worker" : "tui",
			leaseId: "fixture-lease",
			ownerEpoch: this.claimed ? 2 : 1,
			writerState: this.pending ? "handoff-pending" : "idle",
			pid: process.pid,
			sessionId: this.sessionId,
			pathHash: this.pathHash,
			isOwner: !this.claimed,
			idleForHandoff: !this.pending,
			pendingWork: {},
			uiPendingCount: 0,
		};
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	beginSessionHandoff(): ReturnType<OwnerBridgeSession["beginSessionHandoff"]> {
		if (this.pending) return { ok: false, code: "writer_conflict", message: "handoff already pending" };
		this.pending = true;
		return { ok: true, token: this.handoffToken, handoffEpoch: 2 };
	}

	cancelSessionHandoff(): ReturnType<OwnerBridgeSession["cancelSessionHandoff"]> {
		if (!this.pending) return { ok: false, code: "writer_conflict", message: "no handoff pending" };
		this.pending = false;
		return { ok: true };
	}

	async confirmSessionHandoffClaim(input: {
		token: string;
		sessionId: string;
	}): ReturnType<OwnerBridgeSession["confirmSessionHandoffClaim"]> {
		if (!this.pending || input.token !== this.handoffToken || input.sessionId !== this.sessionId) {
			return { ok: false, code: "writer_conflict", message: "claim does not match pending handoff" };
		}
		this.pending = false;
		this.claimed = true;
		return { ok: true, ownerEpoch: 2, ownerPid: process.pid + 1 };
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function openRegistry(agentDir: string): SessionOpenLeaseRegistry {
	return SessionOpenLeaseRegistry.open(agentDir, {
		runtime: "protocol-test",
		buildHash: OWNER_PROTOCOL_VERSION.toString(),
	});
}

async function main(): Promise<void> {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	let bridgeServer: OwnerBridgeServer | undefined;
	let bridgeSession: FixtureBridgeSession | undefined;
	const respond = (payload: unknown): void => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};
	for await (const line of rl) {
		if (!line.trim()) continue;
		let command: Command;
		try {
			command = JSON.parse(line) as Command;
		} catch (error) {
			respond({ ok: false, error: `bad json: ${String(error)}` });
			continue;
		}
		try {
			switch (command.cmd) {
				case "ping": {
					respond({ ok: true, pid: process.pid, protocolVersion: OWNER_PROTOCOL_VERSION });
					break;
				}
				case "acquire": {
					const registry = openRegistry(command.agentDir);
					const result = registry.acquireLease({
						sessionId: command.sessionId,
						transcriptPath: command.transcriptPath,
						ownerKind: "protocol-test",
						ownerProtocolVersion: OWNER_PROTOCOL_VERSION,
					});
					respond(
						result.ok
							? { ok: true, lease: result.value }
							: { ok: false, code: result.code, error: result.message },
					);
					break;
				}
				case "adopt": {
					const registry = openRegistry(command.agentDir);
					const lease = registry.getLeaseForPath(command.pathHash);
					if (!lease.ok) respond({ ok: false, code: lease.code, error: lease.message });
					else if (!lease.value) respond({ ok: false, code: "no_lease", error: "no lease for path" });
					else {
						const owned = registry.isOwnedByCurrentProcess(lease.value);
						respond({ ok: true, owned, lease: owned ? lease.value : undefined });
					}
					break;
				}
				case "beginHandoff": {
					const registry = openRegistry(command.agentDir);
					const result = registry.beginHandoff({ leaseId: command.leaseId });
					respond(
						result.ok ? { ok: true, ...result.value } : { ok: false, code: result.code, error: result.message },
					);
					break;
				}
				case "claim": {
					const result = claimSessionHandoffInProcess({
						agentDir: command.agentDir,
						pathHash: command.pathHash,
						token: command.token,
						sessionId: command.sessionId,
						ownerKind: "protocol-test",
					});
					respond(
						result.ok
							? { ok: true, lease: result.value }
							: { ok: false, code: result.code, error: result.message },
					);
					break;
				}
				case "claimEnv": {
					const env = {
						PI_SESSION_OWNER_CLAIM: `${command.agentDir}|${command.pathHash}|${command.token}|${command.sessionId}`,
					};
					const lease = claimSessionHandoffFromEnv(env, { ownerKind: "tui" });
					respond({ ok: lease !== undefined, lease, consumed: env.PI_SESSION_OWNER_CLAIM === undefined });
					break;
				}
				case "abortHandoff": {
					const registry = openRegistry(command.agentDir);
					const result = registry.abortHandoff({ leaseId: command.leaseId });
					respond(
						result.ok
							? { ok: true, lease: result.value }
							: { ok: false, code: result.code, error: result.message },
					);
					break;
				}
				case "heartbeat": {
					const registry = openRegistry(command.agentDir);
					const result = registry.heartbeatLease({ leaseId: command.leaseId, writerState: command.writerState });
					respond(
						result.ok
							? { ok: true, lease: result.value }
							: { ok: false, code: result.code, error: result.message },
					);
					break;
				}
				case "getLease": {
					const registry = openRegistry(command.agentDir);
					const lease = registry.getLeaseForPath(command.pathHash);
					respond(
						lease.ok ? { ok: true, lease: lease.value } : { ok: false, code: lease.code, error: lease.message },
					);
					break;
				}
				case "startBridge": {
					bridgeSession = new FixtureBridgeSession(command.sessionFile, command.sessionId, command.pathHash);
					bridgeServer = new OwnerBridgeServer(command.agentDir);
					await bridgeServer.start(bridgeSession);
					respond({ ok: true, pid: process.pid, port: bridgeServer.getPort(), pathHash: command.pathHash });
					break;
				}
				case "emitBridgeEvent": {
					if (!bridgeSession) {
						respond({ ok: false, error: "bridge is not started" });
						break;
					}
					bridgeSession.emit({ type: "session_info_changed", name: command.name });
					respond({ ok: true });
					break;
				}
				case "stopBridge": {
					await bridgeServer?.close();
					bridgeServer = undefined;
					respond({ ok: true });
					break;
				}
				default:
					respond({ ok: false, error: "unknown command" });
			}
		} catch (error) {
			respond({ ok: false, error: String(error) });
		}
	}
	await bridgeServer?.close();
	process.exit(0);
}

void main();
