import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { AgentSession, SessionDataLockedError } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	canonicalTranscriptIdentity,
	PROCESS_START_UNKNOWN,
	SessionOpenLeaseRegistry,
} from "../src/core/session-open-lease.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TranscriptWriteGuard } from "../src/core/transcript-write-guard.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function createPersistedSession(options?: {
	legacyTranscript?: boolean;
	foreignLiveClaim?: boolean;
	skipExtensionBinding?: boolean;
	usesDefaultTools?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "pi-session-refresh-test-"));
	roots.push(root);
	const transcriptDir = join(root, "sessions");
	mkdirSync(transcriptDir, { recursive: true });
	const sessionFile = join(transcriptDir, "synthetic.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "refresh-test-session",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: root,
	};
	const userEntry = {
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: "original transcript", timestamp: 1 },
	};
	// Legacy v1 body WITHOUT the trailing newline: opening it must detect both
	// a pending newline repair and a pending migration rewrite, deferred until
	// the session access guard outcome is final (Fix A).
	const transcriptBytes = options?.legacyTranscript
		? `${JSON.stringify({
				type: "session",
				id: "legacy-test-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: root,
			})}\n${JSON.stringify({
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "legacy transcript", timestamp: 1 },
			})}`
		: `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`;
	writeFileSync(sessionFile, transcriptBytes);
	const buildHash = createHash("sha256").update("synthetic-runtime-artifact").digest("hex");
	const runtimePackageDir = join(root, "runtime-package");
	mkdirSync(join(runtimePackageDir, "dist"), { recursive: true });
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = runtimePackageDir;
	writeFileSync(
		join(runtimePackageDir, "dist", "li-build-receipt.json"),
		`${JSON.stringify({
			packageName: "@earendil-works/pi-coding-agent",
			baseVersion: "1.3.0",
			gitDirty: false,
			gitDirtyPathCount: 0,
			artifactAlgorithm: "sha256",
			artifactHash: buildHash,
		})}\n`,
	);
	const registryDir = join(root, "session-open-leases");
	mkdirSync(join(registryDir, "leases"), { recursive: true });
	mkdirSync(join(registryDir, "claims"), { recursive: true });
	mkdirSync(join(registryDir, "guards"), { recursive: true });
	// The promotion gate verifies the real T20 canary receipt: the file must
	// exist, hash exactly to t20_receipt_sha256, AND its content must record an
	// approved promotion of this exact runtime build.
	const receiptPayload = `${JSON.stringify({
		schema_version: 1,
		kind: "pi-core-t20-promotion-receipt",
		decision: "approved",
		runtime: APP_NAME,
		artifact_sha256: buildHash,
		protocol_version: 1,
		approved_at: "2026-01-01T00:00:00.000Z",
	})}\n`;
	const receiptSha256 = createHash("sha256").update(receiptPayload).digest("hex");
	const receiptPath = join(registryDir, "t20-canary.bin");
	writeFileSync(receiptPath, receiptPayload);
	writeFileSync(
		join(registryDir, "registry.json"),
		`${JSON.stringify({
			format_version: 1,
			protocol_version: 1,
			real_write_enabled: true,
			approved_builds: [
				{ runtime: APP_NAME, launcher_path: "synthetic-test", artifact_sha256: buildHash, protocol_version: 1 },
			],
			t20_receipt_sha256: receiptSha256,
			t20_receipt_path: receiptPath,
		})}\n`,
	);

	// A foreign live claim planted BEFORE the session starts blocks the open
	// (Fix A: the blocked open must not have repaired/migrated the transcript).
	if (options?.foreignLiveClaim) {
		const blockerRegistry = SessionOpenLeaseRegistry.open(root, { runtime: "li", buildHash: "test" });
		const { pathHash: claimHash } = canonicalTranscriptIdentity(sessionFile);
		const planted = blockerRegistry.createClaim({
			lock_id: "foreign-live-lock",
			path_hash: claimHash,
			session_id: "other-session",
			purpose: "trim",
			owner_pid: 5555,
			owner_start_utc: PROCESS_START_UNKNOWN,
			owner_runtime: "li",
			owner_build_hash: "test",
			phase: "acquired",
			operation_id: "operation-foreign",
			original_fingerprint: "0".repeat(64),
		});
		if (!planted.ok) throw new Error(`failed to plant foreign live claim: ${JSON.stringify(planted)}`);
	}

	const sessionManager = SessionManager.open(sessionFile, transcriptDir);
	const authStorage = AuthStorage.inMemory();
	const agent = new Agent({
		getApiKey: () => undefined,
		streamFn: streamSimple,
		initialState: {
			systemPrompt: "test",
			tools: [],
			thinkingLevel: "off",
			messages: sessionManager.buildSessionContext().messages,
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.create(root, root),
		cwd: root,
		agentDir: root,
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
		initialActiveToolNames: [],
		usesDefaultTools: options?.usesDefaultTools === true,
	});
	if (!options?.skipExtensionBinding) await session.bindExtensions({ mode: "tui" });
	return {
		root,
		sessionFile,
		session,
		sessionManager,
		header,
		userEntry,
		restorePackageDir: () => {
			if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previousPackageDir;
		},
	};
}

describe("AgentSession in-place refresh", () => {
	it("degrades on unsupported OS guards and refuses trim without killing runtime", async () => {
		if (TranscriptWriteGuard.isPlatformSupported()) return;
		const fixture = await createPersistedSession();
		try {
			expect(fixture.session.sessionFile).toBe(fixture.sessionFile);
			expect(await fixture.session.inspectSessionDataLease()).toMatchObject({
				status: "refused",
				code: "write_guard_unavailable",
			});
			expect(fixture.session.sessionManager.getSessionId()).toBe(fixture.header.id);
		} finally {
			await fixture.session.releaseSessionDataAccess();
			fixture.session.dispose();
			fixture.restorePackageDir();
		}
	});

	// Fix A: opening a transcript must not repair/migrate it before the session
	// access guard resolves; a blocked open leaves the bytes unchanged.
	it("defers startup repairs: a blocked open leaves transcript bytes unchanged and refuses typed", async () => {
		const fixture = await createPersistedSession({
			legacyTranscript: true,
			foreignLiveClaim: true,
			skipExtensionBinding: true,
		});
		const { session, sessionFile } = fixture;
		const originalBytes = readFileSync(sessionFile, "utf8");
		const internals = session as unknown as { _ensureSessionAccessGuard(): Promise<void> };
		try {
			// The open itself must not have written anything yet.
			expect(readFileSync(sessionFile, "utf8")).toBe(originalBytes);
			expect(session.sessionManager.hasDeferredStartupRepairs()).toBe(true);

			// A foreign live claim blocks the guard resolution with a typed error.
			await expect(internals._ensureSessionAccessGuard()).rejects.toThrow(SessionDataLockedError);

			// Byte-identical: no trailing-newline repair, no migration rewrite.
			expect(readFileSync(sessionFile, "utf8")).toBe(originalBytes);
			// The repairs are still pending (deferred, not dropped).
			expect(session.sessionManager.hasDeferredStartupRepairs()).toBe(true);
		} finally {
			await session.releaseSessionDataAccess();
			session.dispose();
			fixture.restorePackageDir();
		}
	}, 30_000);

	it("applies deferred startup repairs once the session access guard outcome resolves", async () => {
		const fixture = await createPersistedSession({ legacyTranscript: true });
		const { session, sessionFile } = fixture;
		const internals = session as unknown as { _ensureSessionAccessGuard(): Promise<void> };
		try {
			// bindExtensions resolves the session access guard, which converges the
			// deferred startup repairs.
			expect(session.sessionManager.hasDeferredStartupRepairs()).toBe(false);
			const bytes = readFileSync(sessionFile, "utf8");
			// The migration was persisted (v3 header) and the newline repair applied.
			const header = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { version?: number };
			expect(header.version).toBe(3);
			expect(bytes.endsWith("\n")).toBe(true);
			// The persisted tree still parses as a valid session.
			expect(session.sessionManager.buildSessionContext().messages.length).toBeGreaterThan(0);
			// A later guard resolution is a no-op.
			await internals._ensureSessionAccessGuard();
			expect(session.sessionManager.hasDeferredStartupRepairs()).toBe(false);
		} finally {
			await session.releaseSessionDataAccess();
			session.dispose();
			fixture.restorePackageDir();
			expect(readFileSync(sessionFile, "utf8").endsWith("\n")).toBe(true);
		}
	}, 30_000);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"refuses acquire on preview fingerprint mismatch under the exclusive guard and reports the locked fingerprint",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile, header } = fixture;
			try {
				expect((await session.inspectSessionDataLease()).status).toBe("ready");
				const currentHash = createHash("sha256").update(readFileSync(sessionFile)).digest("hex");

				// Stale preview fingerprint: a writer touched the file between preview and acquire.
				const stale = await session.acquireSessionDataLock({
					expectedFingerprint: "0".repeat(64),
				});
				expect(stale).toMatchObject({ status: "refused", code: "fingerprint_mismatch" });
				if (stale.status === "refused") expect(stale.observedFingerprint).toBe(currentHash);
				// Admission gate must be fully released after the refused acquire.
				expect((session as unknown as { _sessionDataAdmissionLocked: boolean })._sessionDataAdmissionLocked).toBe(
					false,
				);

				// Matching preview fingerprint: acquired, and the result carries the locked fingerprint.
				const lock = await session.acquireSessionDataLock({ expectedFingerprint: currentHash });
				expect(lock).toMatchObject({ status: "acquired" });
				if (lock.status === "acquired") {
					expect(lock.fingerprint).toBe(currentHash);
					await session.releaseSessionDataLock(lock.lockId);
				}
				expect(header.id).toBe(session.sessionManager.getSessionId());
			} finally {
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"reloads a replaced transcript in-place and emits exactly one internal event",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile, sessionManager, header, userEntry } = fixture;
			const leaseRegistry = (session as unknown as { _leaseRegistry: SessionOpenLeaseRegistry })._leaseRegistry;
			const oldContext = session.extensionRunner.createCommandContext();
			const agentIdentity = session.agent;
			const managerIdentity = session.sessionManager;
			const recorded: string[] = [];
			const unsubscribe = session.subscribe((event) => recorded.push(event.type));
			let lockId: string | undefined;
			try {
				const inspection = await session.inspectSessionDataLease();
				expect(inspection.status).toBe("ready");
				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				lockId = lock.lockId;

				const candidateEntry = {
					type: "session_info",
					id: "name-1",
					parentId: userEntry.id,
					timestamp: "2026-01-01T00:00:02.000Z",
					name: "trimmed candidate",
				};
				const selectionSnapshotEntry = {
					type: "message",
					id: "selection-snapshot-1",
					parentId: candidateEntry.id,
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "system",
						content: "",
						timestamp: 3,
						toolSelectionSnapshot: lock.toolSelectionSnapshot,
					},
				};
				const candidate = `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(candidateEntry)}\n${JSON.stringify(selectionSnapshotEntry)}\n`;
				const candidatePath = join(dirname(sessionFile), "candidate.tmp");
				writeFileSync(candidatePath, candidate);
				const backupDir = join(fixture.root, "synthetic-backups");
				const replaced = await session.replaceSessionDataTranscript({
					candidatePath,
					lockId: lock.lockId,
					backupName: "synthetic.jsonl.bak",
					backupDir,
				});
				if (replaced.status !== "replaced") throw new Error(JSON.stringify(replaced));
				const pathHash = canonicalTranscriptIdentity(sessionFile).pathHash;
				expect(leaseRegistry.readClaim(pathHash)).toMatchObject({
					ok: true,
					value: { backup_name: "synthetic.jsonl.bak", backup_dir: backupDir },
				});
				const fingerprint = createHash("sha256").update(candidate, "utf8").digest("hex");
				const result = await session.reloadSessionFromDisk({
					expectedFingerprint: fingerprint,
					lockId: lock.lockId,
				});

				expect(result).toMatchObject({ status: "reloaded", sessionId: header.id, fingerprint, entryCount: 3 });
				expect(session.agent).toBe(agentIdentity);
				expect(session.sessionManager).toBe(managerIdentity);
				expect(sessionManager.getSessionName()).toBe("trimmed candidate");
				expect(oldContext.getSystemPromptOptions()).toBeDefined();
				expect(recorded).toEqual(["session_data_reloaded"]);
			} finally {
				unsubscribe();
				if (lockId) await session.releaseSessionDataLock(lockId);
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
				expect(sessionManager.getSessionId()).toBe(header.id);
				expect(sessionFile).toBe(fixture.sessionFile);
			}
		},
		30_000,
	);

	// Fix 1: keepClaim keeps the mutation journal as recovery evidence.
	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"reports which pending-work queues block session-data inspection without exposing contents",
		async () => {
			const fixture = await createPersistedSession();
			const internals = fixture.session as unknown as { _pendingCustomMessages: unknown[] };
			internals._pendingCustomMessages.push({ customType: "private-test", content: "must-not-leak" });
			try {
				const result = await fixture.session.inspectSessionDataLease();
				expect(result).toMatchObject({ status: "refused", code: "pending_work" });
				if (result.status === "refused") {
					expect(result.message).toContain("custom=1");
					expect(result.message).not.toContain("must-not-leak");
				}
			} finally {
				await fixture.session.releaseSessionDataAccess();
				fixture.session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"trims a legacy default-migrated loadout by preserving the active selection snapshot",
		async () => {
			const fixture = await createPersistedSession({ usesDefaultTools: true });
			const { session, sessionFile, header, userEntry } = fixture;
			const activeToolsBefore = session.getActiveToolNames().slice().sort();
			try {
				expect(activeToolsBefore.length).toBeGreaterThan(0);
				const inspection = await session.inspectSessionDataLease();
				expect(inspection.status).toBe("ready");
				if (inspection.status !== "ready") return;
				expect(inspection.toolSelectionSnapshot.source).toBe("default");
				expect(inspection.toolSelectionSnapshot.selectedNames.length).toBeGreaterThan(0);

				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				expect(lock.toolSelectionSnapshot).toEqual(inspection.toolSelectionSnapshot);
				const candidatePath = join(dirname(sessionFile), "default-migrated-candidate.tmp");
				const snapshotEntry = {
					type: "message",
					id: "selection-snapshot-1",
					parentId: userEntry.id,
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "system",
						content: "",
						timestamp: 3,
						toolSelectionSnapshot: lock.toolSelectionSnapshot,
					},
				};
				writeFileSync(
					candidatePath,
					`${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(snapshotEntry)}\n`,
				);
				const replaced = await session.replaceSessionDataTranscript({ candidatePath, lockId: lock.lockId });
				expect(replaced.status).toBe("replaced");
				if (replaced.status !== "replaced") return;
				const reloaded = await session.reloadSessionFromDisk({
					expectedFingerprint: replaced.fingerprint,
					lockId: lock.lockId,
				});
				expect(reloaded.status).toBe("reloaded");
				expect(session.getActiveToolNames().slice().sort()).toEqual(activeToolsBefore);
				const latestSystem = [...session.sessionManager.buildSessionProjection().messages]
					.reverse()
					.find((message) => message.role === "system");
				expect(latestSystem?.toolSelectionSnapshot).toEqual(lock.toolSelectionSnapshot);
			} finally {
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"refuses provider-visible projection drift before replacing transcript bytes",
		async () => {
			const fixture = await createPersistedSession({ usesDefaultTools: true });
			const { session, sessionFile, header, userEntry } = fixture;
			const originalBytes = readFileSync(sessionFile);
			let lockId: string | undefined;
			try {
				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				lockId = lock.lockId;
				const candidatePath = join(dirname(sessionFile), "projection-drift-candidate.tmp");
				const tamperedUser = {
					...userEntry,
					message: { ...userEntry.message, content: [{ type: "text", text: "changed content" }] },
				};
				const marker = {
					type: "message",
					id: "projection-snapshot-1",
					parentId: tamperedUser.id,
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "system",
						content: "",
						timestamp: 3,
						toolSelectionSnapshot: lock.toolSelectionSnapshot,
					},
				};
				writeFileSync(
					candidatePath,
					`${JSON.stringify(header)}\n${JSON.stringify(tamperedUser)}\n${JSON.stringify(marker)}\n`,
				);
				const refused = await session.replaceSessionDataTranscript({ candidatePath, lockId: lock.lockId });
				expect(refused).toMatchObject({ status: "refused", code: "projection_mismatch" });
				if (refused.status === "refused")
					expect(refused.message).toContain("provider-visible session projection differs");
				await session.releaseSessionDataLock(lock.lockId);
				lockId = undefined;
				expect(readFileSync(sessionFile)).toEqual(originalBytes);
			} finally {
				if (lockId) await session.releaseSessionDataLock(lockId);
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"rejects a stale selection snapshot before replacing transcript bytes",
		async () => {
			const fixture = await createPersistedSession({ usesDefaultTools: true });
			const { session, sessionFile, header, userEntry } = fixture;
			const originalBytes = readFileSync(sessionFile);
			let lockId: string | undefined;
			try {
				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				lockId = lock.lockId;
				const candidatePath = join(dirname(sessionFile), "stale-selection-candidate.tmp");
				const staleSelection = { version: 1 as const, source: "explicit" as const, selectedNames: ["nonexistent"] };
				const marker = {
					type: "message",
					id: "stale-selection-1",
					parentId: userEntry.id,
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "system", content: "", timestamp: 3, toolSelectionSnapshot: staleSelection },
				};
				writeFileSync(
					candidatePath,
					`${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(marker)}\n`,
				);
				const refused = await session.replaceSessionDataTranscript({ candidatePath, lockId: lock.lockId });
				expect(refused).toMatchObject({ status: "refused", code: "projection_mismatch" });
				if (refused.status === "refused") expect(refused.message).toContain("selection snapshot differs");
				const released = await session.releaseSessionDataLock(lock.lockId);
				expect(released.status).toBe("released");
				lockId = undefined;
				expect(readFileSync(sessionFile)).toEqual(originalBytes);
			} finally {
				if (lockId) await session.releaseSessionDataLock(lockId);
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"reloads original rollback bytes without a selection snapshot after candidate refresh",
		async () => {
			const fixture = await createPersistedSession({ usesDefaultTools: true });
			const { session, sessionFile, header, userEntry } = fixture;
			const originalBytes = readFileSync(sessionFile);
			const originalFingerprint = createHash("sha256").update(originalBytes).digest("hex");
			const activeToolsBefore = session.getActiveToolNames().slice().sort();
			let lockId: string | undefined;
			try {
				const inspection = await session.inspectSessionDataLease();
				expect(inspection.status).toBe("ready");
				if (inspection.status !== "ready") return;
				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				lockId = lock.lockId;

				const candidatePath = join(dirname(sessionFile), "candidate-with-selection.tmp");
				const selectionEntry = {
					type: "message",
					id: "selection-1",
					parentId: userEntry.id,
					timestamp: "2026-01-01T00:00:03.000Z",
					message: {
						role: "system",
						content: "",
						timestamp: 3,
						toolSelectionSnapshot: lock.toolSelectionSnapshot,
					},
				};
				const candidate = `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(selectionEntry)}\n`;
				writeFileSync(candidatePath, candidate);
				const replaced = await session.replaceSessionDataTranscript({ candidatePath, lockId: lock.lockId });
				expect(replaced.status).toBe("replaced");
				if (replaced.status !== "replaced") return;
				const candidateReload = await session.reloadSessionFromDisk({
					expectedFingerprint: replaced.fingerprint,
					lockId: lock.lockId,
				});
				expect(candidateReload.status).toBe("reloaded");

				const originalPath = join(dirname(sessionFile), "original-rollback.tmp");
				writeFileSync(originalPath, originalBytes);
				const rollbackReplace = await session.replaceSessionDataTranscript({
					candidatePath: originalPath,
					lockId: lock.lockId,
				});
				expect(rollbackReplace).toMatchObject({ status: "replaced", fingerprint: originalFingerprint });
				const originalReload = await session.reloadSessionFromDisk({
					expectedFingerprint: originalFingerprint,
					lockId: lock.lockId,
				});
				expect(originalReload).toMatchObject({ status: "reloaded", fingerprint: originalFingerprint });
				expect(session.getActiveToolNames().slice().sort()).toEqual(activeToolsBefore);
			} finally {
				if (lockId) await session.releaseSessionDataLock(lockId);
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"keeps the claim journal on keepClaim release and refuses the next acquire as recovery_blocked",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile, root } = fixture;
			const internals = session as unknown as {
				_heldSessionDataLock?: { lockId: string; pathHash: string; guard: TranscriptWriteGuard };
				_leaseRegistry: SessionOpenLeaseRegistry;
				_sessionDataAdmissionLocked: boolean;
			};
			try {
				const originalHash = createHash("sha256").update(readFileSync(sessionFile)).digest("hex");
				const lock = await session.acquireSessionDataLock();
				expect(lock.status).toBe("acquired");
				if (lock.status !== "acquired") return;
				const held = internals._heldSessionDataLock!;
				const registry = internals._leaseRegistry;

				// Simulate the operation ending BLOCKED: journal phase -> blocked.
				const blocked = registry.updateOwnedClaim(held.pathHash, held.lockId, held.guard.guardId, {
					phase: "blocked",
				});
				expect(blocked).toMatchObject({ ok: true, value: { phase: "blocked" } });
				const claimPath = join(root, "session-open-leases", "claims", `${held.pathHash}.json`);
				expect(existsSync(claimPath)).toBe(true);

				const released = await session.releaseSessionDataLock(held.lockId, { keepClaim: true });
				expect(released).toEqual({ status: "released", lockId: held.lockId, claimKept: true });
				// Claim file kept as recovery evidence, still in the blocked phase.
				expect(registry.readClaim(held.pathHash)).toMatchObject({
					ok: true,
					value: { phase: "blocked", lock_id: held.lockId },
				});
				// Guard record cleared and admission unlocked.
				expect(registry.readGuardRecord(held.pathHash)).toEqual({ ok: true, value: null });
				expect(internals._sessionDataAdmissionLocked).toBe(false);

				// The next acquire refuses recovery_blocked with the recovery
				// inspector (phase + hashes + backup location).
				const refused = await session.acquireSessionDataLock();
				expect(refused).toMatchObject({ status: "refused", code: "recovery_blocked" });
				if (refused.status === "refused") {
					expect(refused.message).toContain("phase=blocked");
					expect(refused.message).toContain(`original=${originalHash}`);
					expect(refused.message).toContain("candidate=none");
					expect(refused.message).toContain("backup=none");
					expect(refused.message).toContain(`backup_dir=${join(root, "session-open-leases", "backups")}`);
				}

				// Resolve the kept claim so the session can be released cleanly.
				expect(registry.clearClaim(held.pathHash, held.lockId)).toEqual({ ok: true, value: true });
			} finally {
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	// Fix 9: a non-typed throw mid-acquire must roll back claim, guard record,
	// guard upgrade, and the admission gate before propagating.
	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"rolls back claim, guard record, and admission gate when acquire throws mid-flight",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile } = fixture;
			const internals = session as unknown as {
				_leaseRegistry: SessionOpenLeaseRegistry;
				_sessionAccessGuard?: TranscriptWriteGuard;
				_sessionDataAdmissionLocked: boolean;
			};
			try {
				const registry = internals._leaseRegistry;
				const identityHash = canonicalTranscriptIdentity(sessionFile).pathHash;
				const publishSpy = vi.spyOn(registry, "publishGuardRecord").mockImplementation(() => {
					throw new Error("boom");
				});
				await expect(session.acquireSessionDataLock()).rejects.toThrow("boom");
				publishSpy.mockRestore();

				expect(internals._sessionDataAdmissionLocked).toBe(false);
				expect(registry.readClaim(identityHash)).toEqual({ ok: true, value: null });
				expect(registry.readGuardRecord(identityHash)).toEqual({ ok: true, value: null });
				// The guard was rolled back to the shared session access guard.
				expect(internals._sessionAccessGuard?.mode).toBe("shared");
				expect(internals._sessionAccessGuard?.isHeld).toBe(true);
			} finally {
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);

	// Fix 8: a failed rollback downgrade must release the guard instead of
	// leaking the helper's shared lock.
	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"releases the guard when the rollback downgrade fails instead of leaking the helper lock",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile } = fixture;
			const internals = session as unknown as {
				_leaseRegistry: SessionOpenLeaseRegistry;
				_sessionAccessGuard?: TranscriptWriteGuard;
				_sessionDataAdmissionLocked: boolean;
			};
			let accessGuard: TranscriptWriteGuard | undefined;
			try {
				const registry = internals._leaseRegistry;
				accessGuard = internals._sessionAccessGuard!;
				const identityHash = canonicalTranscriptIdentity(sessionFile).pathHash;
				const publishSpy = vi
					.spyOn(registry, "publishGuardRecord")
					.mockReturnValue({ ok: false, code: "io_error", message: "mock publish failure" });
				const downgradeSpy = vi
					.spyOn(accessGuard, "downgrade")
					.mockResolvedValue({ ok: false, code: "write_guard_unavailable", message: "mock downgrade failure" });
				const releaseSpy = vi.spyOn(accessGuard, "release").mockResolvedValue(undefined);

				const refused = await session.acquireSessionDataLock();
				expect(refused).toMatchObject({ status: "refused", code: "registry_invalid" });
				// Rollback downgrade was attempted, failed, and the guard was fully
				// released so no helper process keeps holding the shared lock.
				expect(downgradeSpy).toHaveBeenCalledOnce();
				expect(releaseSpy).toHaveBeenCalledOnce();
				expect(internals._sessionDataAdmissionLocked).toBe(false);
				expect(registry.readClaim(identityHash)).toEqual({ ok: true, value: null });
				// The released guard is no longer installed as the session guard.
				expect(internals._sessionAccessGuard).toBeUndefined();

				publishSpy.mockRestore();
				downgradeSpy.mockRestore();
				releaseSpy.mockRestore();
			} finally {
				// The rollback released the guard object, so the test owns releasing
				// the real helper (the session no longer tracks it).
				if (accessGuard) await accessGuard.release();
				await session.releaseSessionDataAccess();
				session.dispose();
				fixture.restorePackageDir();
			}
		},
		30_000,
	);
});
