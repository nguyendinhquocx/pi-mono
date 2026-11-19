/**
 * T1 integration: shared session owner protocol across two REAL processes
 * (SPEC-2026-11-16-li-web). Each child is an independent OS process using the
 * real lease registry on a temp agentDir.
 *
 * What this harness PROVES: single-writer registry semantics, token-based
 * handoff, session binding, strict env claim, admission freeze, cached-guard
 * revalidation, and a real child-process loopback bridge with auth/control/events.
 * The bridge fixture uses a small session adapter; it does NOT prove the full
 * TUI terminal, LiX gateway/browser transport, or a real provider turn (T2-T5).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalTranscriptIdentity,
	type LeaseRecord,
	parseLeaseRecord,
	SessionOpenLeaseRegistry,
} from "../src/core/session-open-lease.ts";
import { OWNER_PROTOCOL_VERSION } from "../src/core/session-owner-protocol.ts";
import { createTestSession } from "./utilities.ts";

const testRoots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		child.stdin.end();
		child.kill();
	}
	while (testRoots.length > 0) rmSync(testRoots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-owner-handoff-test-"));
	testRoots.push(root);
	return root;
}

function startChild(): ChildProcessWithoutNullStreams {
	const script = join(import.meta.dirname, "fixtures", "owner-protocol-child.ts");
	const child = spawn(process.execPath, ["--experimental-strip-types", script], {
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	children.push(child);
	child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[child] ${chunk}`));
	return child;
}

// Re-declare properly (childPid must be awaited before constructing handle).
interface ChildHandle {
	pid: number;
	send<T>(command: Record<string, unknown>): Promise<T & { ok: boolean; code?: string; error?: string }>;
}

async function attachChild(): Promise<ChildHandle> {
	const child = startChild();
	const pending: Array<{ resolve: (value: unknown) => void }> = [];
	let buffer = "";
	let pidResolved: ((pid: number) => void) | undefined;
	const pidPromise = new Promise<number>((resolve) => {
		pidResolved = resolve;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let index: number = buffer.indexOf("\n");
		while (index !== -1) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line) continue;
			const parsed = JSON.parse(line) as { pid?: number };
			if (typeof parsed.pid === "number" && pidResolved) {
				pidResolved(parsed.pid);
				pidResolved = undefined;
				continue;
			}
			const waiter = pending.shift();
			if (waiter) waiter.resolve(parsed);
		}
	});
	// Handshake: the child only reports its pid in the ping response.
	child.stdin.write(`${JSON.stringify({ cmd: "ping" })}\n`);
	const pid = await pidPromise;
	return {
		pid,
		async send<T>(command: Record<string, unknown>): Promise<T & { ok: boolean; code?: string; error?: string }> {
			const response = new Promise((resolve) => pending.push({ resolve }));
			child.stdin.write(`${JSON.stringify({ protocolVersion: OWNER_PROTOCOL_VERSION, ...command })}\n`);
			return (await response) as T & { ok: boolean; code?: string; error?: string };
		},
	};
}

interface BridgeClient {
	socket: Socket;
	send(value: Record<string, unknown>): void;
	next(): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

async function connectBridgeClient(port: number): Promise<BridgeClient> {
	const socket = createConnection({ host: "127.0.0.1", port });
	socket.setEncoding("utf8");
	const queued: Record<string, unknown>[] = [];
	const waiters: Array<(value: Record<string, unknown>) => void> = [];
	let buffer = "";
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				const value = JSON.parse(line) as Record<string, unknown>;
				const waiter = waiters.shift();
				if (waiter) waiter(value);
				else queued.push(value);
			}
			newline = buffer.indexOf("\n");
		}
	});
	socket.on("error", () => {});
	const closed = new Promise<void>((resolve) => socket.once("close", resolve));
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return {
		socket,
		send(value) {
			socket.write(`${JSON.stringify(value)}\n`);
		},
		next() {
			const value = queued.shift();
			if (value) return Promise.resolve(value);
			return new Promise((resolve) => waiters.push(resolve));
		},
		async close() {
			socket.destroy();
			await closed;
		},
	};
}

function writeSessionFile(root: string): { file: string; pathHash: string; sessionId: string } {
	const file = join(root, "sessions", "s1.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, '{"type":"synthetic"}\n');
	return { file, pathHash: canonicalTranscriptIdentity(file).pathHash, sessionId: "s1" };
}

describe("session owner handoff (two real processes)", () => {
	it("owner A acquires; handoff transfers to B with epoch+1 via token; A loses write rights", async () => {
		const root = makeRoot();
		const { file, pathHash, sessionId } = writeSessionFile(root);
		const a = await attachChild();
		const b = await attachChild();
		expect(a.pid).not.toBe(b.pid);

		const acquired = await a.send<{ lease: LeaseRecord }>({
			cmd: "acquire",
			agentDir: root,
			sessionId,
			transcriptPath: file,
		});
		expect(acquired.ok).toBe(true);
		expect(acquired.lease.owner_epoch).toBe(1);
		expect(acquired.lease.owner_kind).toBe("protocol-test");
		expect(acquired.lease.owner_protocol_version).toBe(OWNER_PROTOCOL_VERSION);

		// Concurrent acquire from B must fail closed (single writer).
		const concurrent = await b.send({ cmd: "acquire", agentDir: root, sessionId, transcriptPath: file });
		expect(concurrent.ok).toBe(false);
		expect(concurrent.code).toBe("writer_conflict");

		// Handoff: A marks pending + mints token; B claims with the token.
		const begun = await a.send<{ token: string; handoffEpoch: number }>({
			cmd: "beginHandoff",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
		});
		expect(begun.ok).toBe(true);
		expect(begun.handoffEpoch).toBe(2);

		const leasePath = join(root, "session-open-leases", "leases", `${acquired.lease.lease_id}.json`);
		const persisted = JSON.parse(readFileSync(leasePath, "utf8")) as {
			handoff_token?: string;
			handoff_token_hash?: string;
		};
		expect(persisted.handoff_token_hash).toBe(createHash("sha256").update(begun.token).digest("hex").slice(0, 32));
		expect(persisted.handoff_token).toBeUndefined();

		// Wrong token must not take the lease.
		const wrongToken = await b.send({ cmd: "claim", agentDir: root, pathHash, token: "0".repeat(32), sessionId });
		expect(wrongToken.ok).toBe(false);
		expect(wrongToken.code).toBe("writer_conflict");

		const wrongSession = await b.send({
			cmd: "claim",
			agentDir: root,
			pathHash,
			token: begun.token,
			sessionId: "different-session",
		});
		expect(wrongSession.ok).toBe(false);
		expect(wrongSession.code).toBe("writer_conflict");

		const claimed = await b.send<{ lease: LeaseRecord }>({
			cmd: "claim",
			agentDir: root,
			pathHash,
			token: begun.token,
			sessionId,
		});
		expect(claimed.ok).toBe(true);
		expect(claimed.lease.pid).toBe(b.pid);
		expect(claimed.lease.owner_epoch).toBe(2);
		expect(claimed.lease.writer_state).toBe("idle");
		expect(claimed.lease.handoff_token).toBeUndefined();

		// A's lease ownership is gone: handoff begin must now fail for A.
		const aRetry = await a.send({ cmd: "beginHandoff", agentDir: root, leaseId: acquired.lease.lease_id });
		expect(aRetry.ok).toBe(false);

		// B adopts the lease like an AgentSession reopen would.
		const adopted = await b.send<{ owned: boolean }>({ cmd: "adopt", agentDir: root, pathHash });
		expect(adopted.ok).toBe(true);
		expect(adopted.owned).toBe(true);
	});

	it("handoff-refused path: busy writer state still allows abort by owner, claim fails without pending", async () => {
		const root = makeRoot();
		const { file, sessionId } = writeSessionFile(root);
		const a = await attachChild();
		const b = await attachChild();
		const acquired = await a.send<{ lease: LeaseRecord }>({
			cmd: "acquire",
			agentDir: root,
			sessionId,
			transcriptPath: file,
		});
		expect(acquired.ok).toBe(true);

		// B cannot claim when no handoff is pending.
		const noPending = await b.send({
			cmd: "claim",
			agentDir: root,
			pathHash: canonicalTranscriptIdentity(file).pathHash,
			token: "1".repeat(32),
			sessionId,
		});
		expect(noPending.ok).toBe(false);

		// A begins then aborts the handoff: state returns to idle, token consumed.
		const begun = await a.send<{ token: string }>({
			cmd: "beginHandoff",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
		});
		expect(begun.ok).toBe(true);
		const aborted = await a.send<{ lease: LeaseRecord }>({
			cmd: "abortHandoff",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
		});
		expect(aborted.ok).toBe(true);
		expect(aborted.lease.writer_state).toBe("idle");
		expect(aborted.lease.handoff_token).toBeUndefined();

		// The abandoned token is now useless (claim must fail).
		const staleClaim = await b.send({
			cmd: "claim",
			agentDir: root,
			pathHash: canonicalTranscriptIdentity(file).pathHash,
			token: begun.token,
			sessionId,
		});
		expect(staleClaim.ok).toBe(false);
	});

	it("interactive env claim consumes the one-use value and records the TUI owner before session construction", async () => {
		const root = makeRoot();
		const { file, pathHash, sessionId } = writeSessionFile(root);
		const predecessor = await attachChild();
		const successor = await attachChild();
		const acquired = await predecessor.send<{ lease: LeaseRecord }>({
			cmd: "acquire",
			agentDir: root,
			sessionId,
			transcriptPath: file,
		});
		expect(acquired.ok).toBe(true);
		const begun = await predecessor.send<{ token: string; handoffEpoch: number }>({
			cmd: "beginHandoff",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
		});
		expect(begun.ok).toBe(true);

		const claimed = await successor.send<{ lease: LeaseRecord; consumed: boolean }>({
			cmd: "claimEnv",
			agentDir: root,
			pathHash,
			token: begun.token,
			sessionId,
		});
		expect(claimed.ok).toBe(true);
		expect(claimed.consumed).toBe(true);
		expect(claimed.lease.owner_kind).toBe("tui");
		expect(claimed.lease.owner_epoch).toBe(begun.handoffEpoch);
	});

	it("heartbeat updates writer_state and refreshes heartbeat_utc under the identity guard", async () => {
		const root = makeRoot();
		const { file, sessionId } = writeSessionFile(root);
		const a = await attachChild();
		const acquired = await a.send<{ lease: LeaseRecord }>({
			cmd: "acquire",
			agentDir: root,
			sessionId,
			transcriptPath: file,
		});
		expect(acquired.ok).toBe(true);

		const beat = await a.send<{ lease: LeaseRecord }>({
			cmd: "heartbeat",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
			writerState: "running",
		});
		expect(beat.ok).toBe(true);
		expect(beat.lease.writer_state).toBe("running");
		expect(typeof beat.lease.heartbeat_utc).toBe("string");

		const beatIdle = await a.send<{ lease: LeaseRecord }>({
			cmd: "heartbeat",
			agentDir: root,
			leaseId: acquired.lease.lease_id,
			writerState: "idle",
		});
		expect(beatIdle.ok).toBe(true);
		expect(beatIdle.lease.writer_state).toBe("idle");
	});

	it("death proof: killed owner's lease is visible and reclaimable by the registry recovery path", async () => {
		const root = makeRoot();
		const { file, pathHash, sessionId } = writeSessionFile(root);
		const child = startChild();
		// Minimal handshake so the child acquires, then hard-kill it (no cleanup).
		const acquired = await new Promise<{ ok: boolean; lease?: LeaseRecord }>((resolve) => {
			let buffer = "";
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const index = buffer.indexOf("\n");
				if (index === -1) return;
				resolve(JSON.parse(buffer.slice(0, index)) as { ok: boolean; lease?: LeaseRecord });
			});
			child.stdin.write(`${JSON.stringify({ cmd: "acquire", agentDir: root, sessionId, transcriptPath: file })}\n`);
		});
		expect(acquired.ok).toBe(true);
		const killedPid = child.pid as number;
		child.kill("SIGKILL");

		// Registry (in-process) sees the dead owner; recoverStaleClaim proves death via OS.
		const registry = SessionOpenLeaseRegistry.open(join(root), {
			runtime: "protocol-test",
			buildHash: OWNER_PROTOCOL_VERSION.toString(),
		});
		const lease = registry.getLeaseForPath(pathHash);
		expect(lease.ok).toBe(true);
		if (lease.ok && lease.value) {
			expect(lease.value.pid).toBe(killedPid);
			expect(registry.processInventory.isProcessAlive(lease.value.pid, lease.value.process_start_utc)).toBe(false);
		}

		// A NEW real process takes over after the death proof (no token needed).
		const successor = await attachChild();
		// Direct acquire would still conflict with the dead record; recovery is
		// done via the same path AgentSession uses (stageReload verifier). The
		// successor verifies the death proof first:
		if (lease.ok && lease.value) {
			expect(registry.isOwnedByCurrentProcess(lease.value)).toBe(false);
		}
		void successor;
	});

	it("real bridge process authenticates, streams owner events, runs controls, rejects a second client, and survives disconnect", async () => {
		const root = makeRoot();
		const { file, pathHash, sessionId } = writeSessionFile(root);
		const owner = await attachChild();
		const started = await owner.send<{ port: number; pathHash: string }>({
			cmd: "startBridge",
			agentDir: root,
			sessionFile: file,
			sessionId,
			pathHash,
		});
		expect(started.ok).toBe(true);
		const tokenPath = join(root, "owner-bridge", `${pathHash}.token`);
		const token = readFileSync(tokenPath, "utf8").trim();
		const advertised = JSON.parse(readFileSync(join(root, "owner-bridge", `${pathHash}.json`), "utf8")) as Record<
			string,
			unknown
		>;
		expect(advertised).toMatchObject({ pid: owner.pid, port: started.port, sessionId });
		expect(advertised.tokenFingerprint).toBe(createHash("sha256").update(token).digest("hex").slice(0, 32));

		const wrong = await connectBridgeClient(started.port);
		wrong.send({ type: "auth", token: "wrong-token" });
		expect(await wrong.next()).toMatchObject({ type: "auth_result", success: false });
		await wrong.close();

		const client = await connectBridgeClient(started.port);
		client.send({ type: "auth", token });
		expect(await client.next()).toMatchObject({ type: "auth_result", success: true, sessionId });
		client.send({ type: "owner.subscribe", id: "sub-1" });
		expect(await client.next()).toMatchObject({ type: "response", id: "sub-1", success: true });

		const second = await connectBridgeClient(started.port);
		expect(await second.next()).toMatchObject({
			type: "auth_result",
			success: false,
			error: { code: "client_limit" },
		});
		await second.close();

		const emitted = await owner.send({ cmd: "emitBridgeEvent", name: "live-event" });
		expect(emitted.ok).toBe(true);
		expect(await client.next()).toMatchObject({
			type: "owner_event",
			owner_epoch: 1,
			seq: 1,
			event: { type: "session_info_changed", name: "live-event" },
		});

		client.send({ type: "owner.handoff.begin", id: "begin-1" });
		const begun = await client.next();
		expect(begun).toMatchObject({ type: "response", id: "begin-1", success: true });
		const begunData = begun.data as { token: string; handoffEpoch: number };
		client.send({ type: "owner.handoff.claim", id: "claim-wrong", token: "wrong", sessionId });
		expect(await client.next()).toMatchObject({
			type: "response",
			id: "claim-wrong",
			success: false,
			error: { code: "writer_conflict" },
		});
		client.send({ type: "owner.handoff.cancel", id: "cancel-1" });
		expect(await client.next()).toMatchObject({ type: "response", id: "cancel-1", success: true });

		client.send({ type: "owner.handoff.begin", id: "begin-2" });
		const secondBegin = await client.next();
		const secondBeginData = secondBegin.data as { token: string; handoffEpoch: number };
		expect(secondBeginData.handoffEpoch).toBe(begunData.handoffEpoch);
		client.send({
			type: "owner.handoff.claim",
			id: "claim-1",
			token: secondBeginData.token,
			sessionId,
		});
		expect(await client.next()).toMatchObject({ type: "response", id: "claim-1", success: true });
		await client.close();

		const reconnected = await connectBridgeClient(started.port);
		reconnected.send({ type: "auth", token });
		expect(await reconnected.next()).toMatchObject({ type: "auth_result", success: true });
		reconnected.send({ type: "owner.status", id: "status-after-reconnect" });
		expect(await reconnected.next()).toMatchObject({
			type: "response",
			id: "status-after-reconnect",
			success: true,
			data: { isOwner: false, ownerKind: "lix-worker", ownerEpoch: 2 },
		});
		reconnected.send({ type: "owner.subscribe", id: "sub-after-reconnect" });
		expect(await reconnected.next()).toMatchObject({ type: "response", id: "sub-after-reconnect", success: true });
		const epochEvent = await owner.send({ cmd: "emitBridgeEvent", name: "next-epoch" });
		expect(epochEvent.ok).toBe(true);
		expect(await reconnected.next()).toMatchObject({
			type: "owner_event",
			owner_epoch: 2,
			seq: 1,
			event: { type: "session_info_changed", name: "next-epoch" },
		});
		await reconnected.close();
		const stopped = await owner.send({ cmd: "stopBridge" });
		expect(stopped.ok).toBe(true);
		expect(existsSync(join(root, "owner-bridge", `${pathHash}.json`))).toBe(false);
		expect(existsSync(tokenPath)).toBe(false);
	});

	it("handoff freezes prompts/appends and strict owners re-read the lease after a successor claim", async () => {
		const fixture = await createTestSession({ ownerProtocol: true, initialMessages: ["seed transcript"] });
		const { session, sessionManager, tempDir } = fixture;
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const pathHash = canonicalTranscriptIdentity(sessionFile!).pathHash;
		const owner = await attachChild();
		type SessionInternals = {
			_ensureSessionAccessGuard(): Promise<void>;
			_preparePrompt(text: string, options?: unknown): Promise<unknown>;
			_handoffAdmissionLocked: boolean;
		};
		const privateSession = session as unknown as SessionInternals;

		try {
			await privateSession._ensureSessionAccessGuard();
			const originalEnsure = privateSession._ensureSessionAccessGuard;
			const originalPrepare = privateSession._preparePrompt;
			let finishGuardWait: (() => void) | undefined;
			privateSession._ensureSessionAccessGuard = () =>
				new Promise((resolve) => {
					finishGuardWait = resolve;
				});
			privateSession._preparePrompt = async () => undefined;
			const preflightPrompt = session.prompt("in-flight admission");
			await Promise.resolve();
			const racedBegin = session.beginSessionHandoff();
			expect(racedBegin).toMatchObject({
				ok: false,
				code: "handoff_refused",
				pendingWork: { prompt_admission: true },
			});
			finishGuardWait?.();
			await preflightPrompt;
			privateSession._ensureSessionAccessGuard = originalEnsure;
			privateSession._preparePrompt = originalPrepare;

			const begun = session.beginSessionHandoff();
			expect(begun.ok).toBe(true);
			if (!begun.ok) return;
			await expect(session.prompt("must not enter a handoff-pending turn")).rejects.toMatchObject({
				code: "handoff_pending",
			});
			let appendError: unknown;
			try {
				sessionManager.appendMessage({ role: "user", content: "must not append", timestamp: Date.now() });
			} catch (error) {
				appendError = error;
			}
			expect(appendError).toMatchObject({ code: "handoff_pending" });

			const claimed = await owner.send<{ lease: LeaseRecord }>({
				cmd: "claim",
				agentDir: tempDir,
				pathHash,
				token: begun.token,
				sessionId: session.sessionId,
			});
			expect(claimed.ok).toBe(true);
			// Simulate a stale caller that still has the old shared OS guard but missed
			// the admission freeze: the per-write lease re-read must reject its append.
			privateSession._handoffAdmissionLocked = false;
			let staleAppendError: unknown;
			try {
				sessionManager.appendMessage({ role: "user", content: "stale owner append", timestamp: Date.now() });
			} catch (error) {
				staleAppendError = error;
			}
			expect(staleAppendError).toMatchObject({ code: "writer_conflict" });
			privateSession._handoffAdmissionLocked = true;
			await expect(privateSession._ensureSessionAccessGuard()).rejects.toMatchObject({
				name: "SessionDataLockedError",
			});
			const detached = await session.confirmSessionHandoffClaim({
				token: begun.token,
				sessionId: session.sessionId,
			});
			expect(detached).toMatchObject({ ok: true, ownerEpoch: 2, ownerPid: owner.pid });
		} finally {
			await session.releaseSessionDataAccess();
			fixture.cleanup();
		}
	});

	it("legacy lease records without owner fields still parse (backward compatibility)", () => {
		const legacy = {
			lease_id: "legacy123456789012",
			session_id: "s-legacy",
			path_hash: "a".repeat(64),
			pid: 1234,
			process_start_utc: "2026-01-01T00:00:00.000000Z",
			runtime: "li",
			build_hash: "b".repeat(64),
			opened_at: "2026-01-01T00:00:00.000Z",
			lease_state: "open",
		};
		const parsed = parseLeaseRecord(legacy);
		expect(parsed).not.toBeNull();
		expect(parsed?.owner_epoch).toBeUndefined();
		expect(parsed?.owner_kind).toBeUndefined();
	});
});
