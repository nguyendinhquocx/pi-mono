/**
 * Minimal protocol-test client for session-owner handoff integration tests
 * (SPEC-2026-11-16-li-web, T1). Runs as a REAL separate process:
 *
 *   node --experimental-strip-types test/fixtures/owner-protocol-child.ts
 *
 * Reads one JSON command per stdin line, writes one JSON result per stdout
 * line. This harness proves cross-process registry ownership, handoff token
 * transfer, conflict, and heartbeat semantics. It does NOT prove gateway or
 * browser integration (that is T2/T4); the LiX host consumes the same
 * registry + RPC contract.
 */
import { createInterface } from "node:readline";
import { SessionOpenLeaseRegistry } from "../../src/core/session-open-lease.ts";
import { OWNER_PROTOCOL_VERSION } from "../../src/core/session-owner-protocol.ts";

type Command =
	| { cmd: "acquire"; agentDir: string; sessionId: string; transcriptPath: string }
	| { cmd: "adopt"; agentDir: string; pathHash: string }
	| { cmd: "beginHandoff"; agentDir: string; leaseId: string }
	| { cmd: "claim"; agentDir: string; pathHash: string; token: string; sessionId: string }
	| { cmd: "abortHandoff"; agentDir: string; leaseId: string }
	| { cmd: "heartbeat"; agentDir: string; leaseId: string; writerState?: "idle" | "running" }
	| { cmd: "getLease"; agentDir: string; pathHash: string }
	| { cmd: "ping" };

function openRegistry(agentDir: string): SessionOpenLeaseRegistry {
	return SessionOpenLeaseRegistry.open(agentDir, {
		runtime: "protocol-test",
		buildHash: OWNER_PROTOCOL_VERSION.toString(),
	});
}

async function main(): Promise<void> {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
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
					const registry = openRegistry(command.agentDir);
					const result = registry.claimHandoff({
						pathHash: command.pathHash,
						token: command.token,
						sessionId: command.sessionId,
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
				default:
					respond({ ok: false, error: "unknown command" });
			}
		} catch (error) {
			respond({ ok: false, error: String(error) });
		}
	}
	process.exit(0);
}

void main();
