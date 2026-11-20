/** Loopback JSONL owner bridge shared by the interactive TUI and local host clients. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { canonicalTranscriptIdentity } from "../../core/session-open-lease.ts";
import { OWNER_PROTOCOL_VERSION } from "../../core/session-owner-protocol.ts";
import { toJsonEvent } from "../json-event.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;

export interface OwnerBridgeStatus {
	protocolVersion: number;
	strict: boolean;
	ownerKind: string;
	leaseId: string | undefined;
	ownerEpoch: number | undefined;
	writerState: string | undefined;
	pid: number;
	sessionId: string;
	pathHash: string | undefined;
	isOwner: boolean;
	idleForHandoff: boolean;
	pendingWork: Record<string, number | boolean>;
	uiPendingCount: number;
}

export interface OwnerBridgeSession {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	isPersisted(): boolean;
	getOwnerStatus(): OwnerBridgeStatus;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	beginSessionHandoff():
		| { ok: true; token: string; handoffEpoch: number }
		| { ok: false; code: string; message: string; pendingWork?: Record<string, number | boolean> };
	cancelSessionHandoff(): { ok: true } | { ok: false; code: string; message: string };
	confirmSessionHandoffClaim(input: {
		token: string;
		sessionId: string;
	}): Promise<{ ok: true; ownerEpoch: number; ownerPid: number } | { ok: false; code: string; message: string }>;
	onOwnerStateChanged?(): void;
}

interface BridgeAdvertisement {
	pid: number;
	port: number;
	tokenFingerprint: string;
	sessionId: string;
	writerState: string;
}

const STATUS_CACHE_TTL_MS = 200;
const MAX_PENDING_AUTH_SOCKETS = 4;

/** Serve the interactive owner's events and handoff controls on loopback only. */
export class OwnerBridgeServer {
	private readonly bridgeDir: string;
	private token = randomBytes(32).toString("hex");
	private tokenFingerprint: string;
	private server: Server | undefined;
	private session: OwnerBridgeSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private activeClient: Socket | undefined;
	private activeClientAuthenticated = false;
	private activeClientSubscribed = false;
	private readonly pendingAuthSockets = new Set<Socket>();
	private cachedOwnerStatus: { status: OwnerBridgeStatus; at: number } | undefined;
	private eventEpoch: number | undefined;
	private eventSeq = 0;
	private advertisedPath: string | undefined;
	private tokenPath: string | undefined;
	private port: number | undefined;
	/** True when the discovery file on disk still belongs to THIS bridge process and the given token epoch. */
	#discoveryIsOurs(tokenFingerprint: string): boolean {
		const advertisedPath = this.advertisedPath;
		if (!advertisedPath) return false;
		let raw: string;
		try {
			raw = readFileSync(advertisedPath, "utf8");
		} catch {
			return false;
		}
		try {
			const advertisement = JSON.parse(raw) as { pid?: unknown; tokenFingerprint?: unknown };
			return advertisement.pid === process.pid && advertisement.tokenFingerprint === tokenFingerprint;
		} catch {
			// Unparseable discovery data may belong to another owner; never delete on a guess.
			return false;
		}
	}
	#tokenFileIsOurs(tokenPath: string, token: string): boolean {
		try {
			return readFileSync(tokenPath, "utf8").trim() === token;
		} catch {
			return false;
		}
	}
	/**
	 * Remove only discovery files this bridge still owns; a successor's files stay
	 * untouched. Verification and unlink happen synchronously in one JS turn so a
	 * successor publishing between the two cannot be raced (F3). Callers rotating
	 * the token pass the identity that WROTE the files on disk, otherwise the
	 * post-rotation fingerprint would never match and the old advertisement would
	 * be stranded (delta-review FINDING-1).
	 */
	#removeOwnedDiscoverySync(expectedToken = this.token, expectedFingerprint = this.tokenFingerprint): void {
		const advertisedPath = this.advertisedPath;
		const tokenPath = this.tokenPath;
		if (advertisedPath && this.#discoveryIsOurs(expectedFingerprint)) {
			try {
				unlinkSync(advertisedPath);
			} catch {}
		}
		if (tokenPath && this.#tokenFileIsOurs(tokenPath, expectedToken)) {
			try {
				unlinkSync(tokenPath);
			} catch {}
		}
		if (this.advertisedPath === advertisedPath) this.advertisedPath = undefined;
		if (this.tokenPath === tokenPath) this.tokenPath = undefined;
	}
	private readonly processExitHandler = (): void => {
		this.#removeOwnedDiscoverySync();
	};

	constructor(agentDir: string) {
		this.tokenFingerprint = createHash("sha256").update(this.token, "utf8").digest("hex").slice(0, 32);
		this.bridgeDir = join(agentDir, "owner-bridge");
		process.on("exit", this.processExitHandler);
	}

	getPort(): number | undefined {
		return this.port;
	}

	/** Bind an ephemeral loopback port and publish discovery for the current session, if persisted. */
	async start(session: OwnerBridgeSession): Promise<void> {
		if (this.server) throw new Error("owner bridge already started");
		await mkdir(this.bridgeDir, { recursive: true, mode: 0o700 });
		const server = createServer((socket) => this.acceptClient(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("owner bridge did not bind a TCP port");
		this.port = address.port;
		await this.updateSession(session);
	}

	/** Move the live event subscription and discovery record to a replaced session. */
	async updateSession(session: OwnerBridgeSession): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = session;
		this.eventEpoch = undefined;
		this.eventSeq = 0;
		this.activeClientSubscribed = false;
		this.activeClient?.end();
		this.activeClient = undefined;
		this.activeClientAuthenticated = false;
		this.cachedOwnerStatus = undefined;
		// Rotate BEFORE removing the old discovery record: a client holding the old
		// token cannot authenticate across a session change (F2). The removal still
		// verifies against the token that wrote the files on disk.
		const previousToken = this.token;
		const previousFingerprint = this.tokenFingerprint;
		this.token = randomBytes(32).toString("hex");
		this.tokenFingerprint = createHash("sha256").update(this.token, "utf8").digest("hex").slice(0, 32);
		this.#removeOwnedDiscoverySync(previousToken, previousFingerprint);
		const sessionFile = session.isPersisted() ? session.getSessionFile() : undefined;
		if (!sessionFile || this.port === undefined) return;
		const pathHash = canonicalTranscriptIdentity(sessionFile).pathHash;
		this.advertisedPath = join(this.bridgeDir, `${pathHash}.json`);
		this.tokenPath = join(this.bridgeDir, `${pathHash}.token`);
		const advertisement: BridgeAdvertisement = {
			pid: process.pid,
			port: this.port,
			tokenFingerprint: this.tokenFingerprint,
			sessionId: session.getSessionId(),
			writerState: session.getOwnerStatus().writerState ?? "idle",
		};
		const temporaryPath = `${this.advertisedPath}.${process.pid}.tmp`;
		await writeFile(this.tokenPath, `${this.token}\n`, { encoding: "utf8", mode: 0o600 });
		await writeFile(temporaryPath, `${JSON.stringify(advertisement)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, this.advertisedPath);
		this.unsubscribe = session.subscribe((event) => this.publishEvent(event));
	}

	/** Close clients, listeners, discovery metadata, and the ephemeral token file. */
	async close(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.activeClient?.destroy();
		this.activeClient = undefined;
		this.activeClientAuthenticated = false;
		this.activeClientSubscribed = false;
		for (const pending of this.pendingAuthSockets) pending.destroy();
		this.pendingAuthSockets.clear();
		this.#removeOwnedDiscoverySync();
		process.off("exit", this.processExitHandler);
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private acceptClient(socket: Socket): void {
		// Auth-first-then-slot: unauthenticated sockets occupy a small pending pool
		// instead of the single client slot (bridge-security finding).
		if (this.pendingAuthSockets.size >= MAX_PENDING_AUTH_SOCKETS) {
			this.writeLine(socket, {
				type: "auth_result",
				success: false,
				error: { code: "client_limit", message: "owner bridge has too many pending authentication attempts" },
			});
			socket.end();
			return;
		}
		this.pendingAuthSockets.add(socket);
		socket.setEncoding("utf8");
		let input = "";
		const authTimeout = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
		authTimeout.unref?.();
		socket.on("data", (chunk: string) => {
			input += chunk;
			if (Buffer.byteLength(input, "utf8") > MAX_LINE_BYTES) {
				socket.destroy();
				return;
			}
			let newline = input.indexOf("\n");
			while (newline !== -1) {
				const line = input.slice(0, newline).replace(/\r$/, "");
				input = input.slice(newline + 1);
				if (line.length > 0) void this.handleLine(socket, line, authTimeout).catch(() => socket.destroy());
				newline = input.indexOf("\n");
			}
		});
		socket.on("close", () => {
			clearTimeout(authTimeout);
			this.pendingAuthSockets.delete(socket);
			if (this.activeClient === socket) {
				this.activeClient = undefined;
				this.activeClientAuthenticated = false;
				this.activeClientSubscribed = false;
			}
		});
		socket.on("error", () => {
			clearTimeout(authTimeout);
		});
	}

	private async handleLine(socket: Socket, line: string, authTimeout: ReturnType<typeof setTimeout>): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.writeLine(socket, { type: "auth_result", success: false, error: { code: "invalid_json" } });
			socket.destroy();
			return;
		}
		if (!isRecord(parsed)) {
			socket.destroy();
			return;
		}
		if (this.activeClient !== socket) {
			// Authentication phase: this socket has not won the client slot yet. The
			// authenticated flags below describe the ACTIVE client, not this pending one.
			if (parsed.type !== "auth" || typeof parsed.token !== "string" || !sameToken(this.token, parsed.token)) {
				this.writeLine(socket, {
					type: "auth_result",
					success: false,
					error: { code: "auth_failed", message: "owner bridge authentication failed" },
				});
				socket.destroy();
				return;
			}
			if (this.activeClient) {
				// Slot is claimed only by an authenticated client; a second correct
				// token still cannot take it (client_limit).
				this.writeLine(socket, {
					type: "auth_result",
					success: false,
					error: { code: "client_limit", message: "owner bridge allows one client at a time" },
				});
				socket.destroy();
				return;
			}
			this.pendingAuthSockets.delete(socket);
			this.activeClient = socket;
			this.activeClientAuthenticated = true;
			clearTimeout(authTimeout);
			this.writeLine(socket, {
				type: "auth_result",
				success: true,
				sessionId: this.session?.getSessionId(),
				ownerEpoch: this.session?.getOwnerStatus().ownerEpoch,
			});
			return;
		}
		if (typeof parsed.type !== "string") {
			this.writeResponse(socket, parsed.id, "", false, undefined, {
				code: "invalid_request",
				message: "type is required",
			});
			return;
		}
		const session = this.session;
		if (!session) {
			this.writeResponse(socket, parsed.id, parsed.type, false, undefined, {
				code: "owner_unavailable",
				message: "owner session is unavailable",
			});
			return;
		}
		switch (parsed.type) {
			case "owner.subscribe": {
				if (parsed.protocolVersion !== OWNER_PROTOCOL_VERSION) {
					// Fail-closed handshake, symmetric with the RPC owner_capability check:
					// an unversioned subscriber cannot read owner events.
					this.writeResponse(socket, parsed.id, parsed.type, false, undefined, {
						code: "protocol_mismatch",
						message: `owner bridge requires protocol version ${OWNER_PROTOCOL_VERSION}`,
					});
					return;
				}
				this.activeClientSubscribed = true;
				this.eventEpoch = undefined;
				this.eventSeq = 0;
				// Every (re)subscription must re-snapshot before trusting the stream.
				this.writeResponse(socket, parsed.id, parsed.type, true, {
					...session.getOwnerStatus(),
					resync_required: true,
				});
				return;
			}
			case "owner.status":
				this.writeResponse(socket, parsed.id, parsed.type, true, session.getOwnerStatus());
				return;
			case "owner.handoff.begin": {
				const result = session.beginSessionHandoff();
				if (!result.ok) {
					this.writeResponse(socket, parsed.id, parsed.type, false, undefined, {
						code: result.code,
						message: result.message,
						pendingWork: result.pendingWork,
					});
					return;
				}
				session.onOwnerStateChanged?.();
				this.cachedOwnerStatus = undefined;
				this.writeResponse(socket, parsed.id, parsed.type, true, {
					token: result.token,
					handoffEpoch: result.handoffEpoch,
				});
				return;
			}
			case "owner.handoff.cancel": {
				const result = session.cancelSessionHandoff();
				if (result.ok) {
					session.onOwnerStateChanged?.();
					this.cachedOwnerStatus = undefined;
				}
				this.writeResponse(
					socket,
					parsed.id,
					parsed.type,
					result.ok,
					result.ok ? result : undefined,
					result.ok ? undefined : result,
				);
				return;
			}
			case "owner.handoff.claim": {
				if (typeof parsed.token !== "string" || typeof parsed.sessionId !== "string") {
					this.writeResponse(socket, parsed.id, parsed.type, false, undefined, {
						code: "invalid_request",
						message: "token and sessionId are required",
					});
					return;
				}
				const result = await session.confirmSessionHandoffClaim({
					token: parsed.token,
					sessionId: parsed.sessionId,
				});
				if (result.ok) {
					session.onOwnerStateChanged?.();
					this.cachedOwnerStatus = undefined;
				}
				this.writeResponse(
					socket,
					parsed.id,
					parsed.type,
					result.ok,
					result.ok ? result : undefined,
					result.ok ? undefined : result,
				);
				return;
			}
			default:
				this.writeResponse(socket, parsed.id, parsed.type, false, undefined, {
					code: "unknown_method",
					message: `unsupported owner bridge method: ${parsed.type}`,
				});
		}
	}

	private publishEvent(event: AgentSessionEvent): void {
		const socket = this.activeClient;
		if (!socket || !this.activeClientAuthenticated || !this.activeClientSubscribed) return;
		// Re-read the owner epoch at most once per TTL window so dense event bursts do
		// not parse the lease registry per event; state changes invalidate the cache.
		const now = Date.now();
		if (!this.cachedOwnerStatus || now - this.cachedOwnerStatus.at >= STATUS_CACHE_TTL_MS) {
			this.cachedOwnerStatus = { status: this.session!.getOwnerStatus(), at: now };
		}
		const epoch = this.cachedOwnerStatus.status.ownerEpoch ?? 1;
		if (this.eventEpoch !== epoch) {
			const previousEpoch = this.eventEpoch;
			this.eventEpoch = epoch;
			this.eventSeq = 0;
			if (previousEpoch !== undefined) {
				// Epoch changed mid-subscription: force the viewer to re-snapshot.
				this.writeLine(socket, {
					type: "owner_epoch_changed",
					previous_epoch: previousEpoch,
					owner_epoch: epoch,
					resync_required: true,
				});
			}
		}
		this.writeLine(socket, {
			type: "owner_event",
			owner_epoch: epoch,
			seq: ++this.eventSeq,
			event: toJsonEvent(event),
		});
	}

	private writeResponse(
		socket: Socket,
		id: unknown,
		method: string,
		success: boolean,
		data?: unknown,
		error?: { code: string; message: string; pendingWork?: Record<string, number | boolean> },
	): void {
		this.writeLine(socket, {
			type: "response",
			...(typeof id === "string" ? { id } : {}),
			method,
			success,
			...(data === undefined ? {} : { data }),
			...(error === undefined ? {} : { error }),
		});
	}

	private writeLine(socket: Socket, value: unknown): void {
		if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameToken(expected: string, supplied: string): boolean {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(supplied, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}
