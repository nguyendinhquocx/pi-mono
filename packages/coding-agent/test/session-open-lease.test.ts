import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalTranscriptIdentity,
	fileFingerprint,
	LEASE_REGISTRY_FORMAT_VERSION,
	LEASE_REGISTRY_PROTOCOL_VERSION,
	normalizeProcessStartUtc,
	PROCESS_START_UNKNOWN,
	type ProcessInventory,
	parseClaimRecord,
	parseJsonStrict,
	SessionOpenLeaseRegistry,
} from "../src/core/session-open-lease.ts";
import { TranscriptWriteGuard } from "../src/core/transcript-write-guard.ts";

const testRoots: string[] = [];

afterEach(() => {
	while (testRoots.length > 0) rmSync(testRoots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-session-lease-test-"));
	testRoots.push(root);
	return root;
}

function inventory(starts: Map<number, string>): ProcessInventory {
	return {
		getProcessStartUtc: (pid) => starts.get(pid) ?? null,
		isProcessAlive: (pid, startUtc) => startUtc === PROCESS_START_UNKNOWN || starts.get(pid) === startUtc,
	};
}

function createRegistry(
	root: string,
	processInventory = inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]])),
	beforeStaleGuardReclaim?: () => void,
) {
	return SessionOpenLeaseRegistry.open(root, {
		runtime: "li",
		buildHash: createHash("sha256").update("test-build").digest("hex"),
		processInventory,
		...(beforeStaleGuardReclaim !== undefined ? { beforeStaleGuardReclaim } : {}),
	});
}

describe("SessionOpenLeaseRegistry", () => {
	it("creates v1 registry with real writes disabled and hashes canonical transcript identity", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic transcript\n");
		const registry = createRegistry(root);

		expect(registry.available).toBe(true);
		const current = registry.readRegistry();
		expect(current.ok).toBe(true);
		if (current.ok) {
			expect(current.value).toEqual({
				format_version: LEASE_REGISTRY_FORMAT_VERSION,
				protocol_version: LEASE_REGISTRY_PROTOCOL_VERSION,
				real_write_enabled: false,
				approved_builds: [],
			});
		}
		const identity = canonicalTranscriptIdentity(transcript);
		expect(identity.pathHash).toMatch(/^[a-f0-9]{64}$/);
		expect(identity.pathHash).toBe(createHash("sha256").update(identity.identity, "utf8").digest("hex"));
		expect(fileFingerprint(transcript)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("detects duplicate JSON keys and rejects malformed registry schemas", () => {
		expect(() => parseJsonStrict('{"format_version":1,"format_version":1}')).toThrow(/duplicate key/);
		expect(() => parseJsonStrict('{"nested":{"x":1,"x":2}}')).toThrow(/duplicate key/);
		const root = makeRoot();
		const registryPath = join(root, "session-open-leases", "registry.json");
		mkdirSync(join(root, "session-open-leases"), { recursive: true });
		writeFileSync(
			registryPath,
			'{"format_version":1,"protocol_version":99,"real_write_enabled":false,"approved_builds":[]}',
		);
		const registry = createRegistry(root);

		expect(registry.available).toBe(false);
		expect(registry.readRegistry()).toMatchObject({ ok: false, code: "registry_invalid" });
	});

	it("records open leases, refuses duplicate same-identity owners for trim, and releases by deleting the record", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const registry = createRegistry(root);
		const first = registry.acquireLease({ sessionId: "session-a", transcriptPath: transcript });
		const second = registry.acquireLease({ sessionId: "session-a", transcriptPath: transcript });
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;

		expect(registry.inspectLeaseUniqueness({ sessionId: "session-a", transcriptPath: transcript })).toMatchObject({
			ok: false,
			code: "lease_conflict",
		});
		const leasePath = join(root, "session-open-leases", "leases", `${first.value.lease_id}.json`);
		expect(existsSync(leasePath)).toBe(true);
		expect(JSON.parse(readFileSync(leasePath, "utf8")).lease_state).toBe("open");
		expect(registry.releaseLease(first.value.lease_id)).toEqual({ ok: true, value: true });
		expect(existsSync(leasePath)).toBe(false);
	});

	it("fails closed when any lease record is malformed and uniqueness is unknowable", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const registry = createRegistry(root);
		const lease = registry.acquireLease({ sessionId: "session-a", transcriptPath: transcript });
		expect(lease.ok).toBe(true);
		writeFileSync(join(root, "session-open-leases", "leases", "malformed.json"), '{"partial":');

		expect(registry.inspectLeaseUniqueness({ sessionId: "session-a", transcriptPath: transcript })).toMatchObject({
			ok: false,
			code: "lease_conflict",
		});
	});

	it("reclaims a PID-reused stale claim only after process-start identity mismatch", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "original synthetic bytes\n");
		const starts = new Map<number, string>([
			[process.pid, "2026-01-01T00:00:00.000000Z"],
			[4242, "2026-02-01T00:00:00.000000Z"],
		]);
		const registry = createRegistry(root, inventory(starts));
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		const originalFingerprint = fileFingerprint(transcript)!;
		const claim = registry.createClaim({
			lock_id: "stale-lock",
			path_hash: pathHash,
			session_id: "session-a",
			purpose: "test",
			owner_pid: 4242,
			owner_start_utc: "2026-01-01T00:00:00.000000Z",
			owner_runtime: "li",
			owner_build_hash: "test",
			phase: "acquired",
			operation_id: "operation-a",
			original_fingerprint: originalFingerprint,
		});
		expect(claim.ok).toBe(true);
		const recovery = registry.recoverStaleClaim({ pathHash, transcriptPath: transcript });
		expect(recovery).toEqual({ ok: true, value: { action: "cleared" } });
		expect(registry.readClaim(pathHash)).toEqual({ ok: true, value: null });
	});

	it("does not treat unknown process-start identity as proof of death", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const processInventory = inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]]));
		const registry = createRegistry(root, processInventory);
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		registry.createClaim({
			lock_id: "unknown-start",
			path_hash: pathHash,
			session_id: "session-a",
			purpose: "test",
			owner_pid: 5555,
			owner_start_utc: PROCESS_START_UNKNOWN,
			owner_runtime: "li",
			owner_build_hash: "test",
			phase: "acquired",
			operation_id: "operation-b",
			original_fingerprint: fileFingerprint(transcript)!,
		});

		expect(registry.recoverStaleClaim({ pathHash, transcriptPath: transcript })).toMatchObject({
			ok: false,
			code: "writer_conflict",
		});
	});

	// =======================================================================
	// Fix 2: promotion gate verifies the real T20 canary receipt file
	// =======================================================================

	function t20ReceiptPayload(buildHash: string, overrides: Record<string, unknown> = {}): string {
		return `${JSON.stringify({
			schema_version: 1,
			kind: "pi-core-t20-promotion-receipt",
			decision: "approved",
			runtime: "li",
			artifact_sha256: buildHash,
			protocol_version: LEASE_REGISTRY_PROTOCOL_VERSION,
			approved_at: "2026-01-01T00:00:00.000Z",
			...overrides,
		})}\n`;
	}

	function enableRealWrite(root: string, receiptSha256: string, receiptPath?: string): void {
		const buildHash = createHash("sha256").update("test-build").digest("hex");
		writeFileSync(
			join(root, "session-open-leases", "registry.json"),
			`${JSON.stringify({
				format_version: LEASE_REGISTRY_FORMAT_VERSION,
				protocol_version: LEASE_REGISTRY_PROTOCOL_VERSION,
				real_write_enabled: true,
				approved_builds: [
					{ runtime: "li", launcher_path: "synthetic-test", artifact_sha256: buildHash, protocol_version: 1 },
				],
				t20_receipt_sha256: receiptSha256,
				...(receiptPath !== undefined ? { t20_receipt_path: receiptPath } : {}),
			})}\n`,
		);
	}

	/** Writes a valid receipt payload and pins its exact hash into the registry. */
	function enableRealWriteWithReceipt(root: string, receiptOverrides: Record<string, unknown> = {}): string {
		const buildHash = createHash("sha256").update("test-build").digest("hex");
		const receiptPath = join(root, "receipts", "t20-canary.bin");
		const content = t20ReceiptPayload(buildHash, receiptOverrides);
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, content);
		enableRealWrite(root, createHash("sha256").update(content).digest("hex"), receiptPath);
		return receiptPath;
	}

	it("refuses promotion when real_write is enabled without a verifiable t20_receipt_path", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		const receiptSha = createHash("sha256").update("canary receipt bytes").digest("hex");

		// Shape-only registry: hash present, receipt path field absent entirely.
		enableRealWrite(root, receiptSha);
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("t20_receipt_path"),
		});

		// Path present but the receipt file does not exist on disk.
		enableRealWrite(root, receiptSha, join(root, "receipts", "missing-canary.bin"));
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("receipt file is missing"),
		});
	});

	it("refuses promotion on receipt hash mismatch and passes only on an exact byte match", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		const receiptPath = join(root, "receipts", "t20-canary.bin");
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, "tampered bytes");
		const buildHash = createHash("sha256").update("test-build").digest("hex");
		const receiptSha = createHash("sha256").update(t20ReceiptPayload(buildHash)).digest("hex");
		enableRealWrite(root, receiptSha, receiptPath);
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("hash mismatch"),
		});

		writeFileSync(receiptPath, t20ReceiptPayload(buildHash));
		expect(registry.checkPromotionGate()).toMatchObject({ ok: true });
	});

	// =======================================================================
	// Fix D: the receipt content itself must record this exact promotion
	// =======================================================================

	// Fix D coverage gaps: byte-size cap and approved_builds cross-check.
	it("refuses a receipt larger than the 64 KiB cap even with a matching hash", () => {
		const root = makeRoot();
		const buildHash = createHash("sha256").update("test-build").digest("hex");
		const oversized = t20ReceiptPayload(buildHash, { approved_at: "x".repeat(64 * 1024 + 1) });
		const receiptPath = join(root, "receipts", "t20-canary.bin");
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, oversized);
		mkdirSync(join(root, "session-open-leases"), { recursive: true });
		enableRealWrite(root, createHash("sha256").update(oversized).digest("hex"), receiptPath);
		const registry = createRegistry(root);
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("unreasonably large"),
		});
	});

	it("refuses when the receipt is valid but the running build is absent from approved_builds", () => {
		const root = makeRoot();
		const buildHash = createHash("sha256").update("test-build").digest("hex");
		const receiptPath = join(root, "receipts", "t20-canary.bin");
		const content = t20ReceiptPayload(buildHash);
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, content);
		// Hash pins the correct receipt bytes, but the registry's approved_builds
		// entry points at a different artifact: the running build is not approved.
		mkdirSync(join(root, "session-open-leases"), { recursive: true });
		enableRealWrite(root, createHash("sha256").update(content).digest("hex"), receiptPath);
		const registryPath = join(root, "session-open-leases", "registry.json");
		const reg = JSON.parse(readFileSync(registryPath, "utf8")) as {
			approved_builds: Array<{ artifact_sha256: string }>;
		};
		reg.approved_builds[0].artifact_sha256 = createHash("sha256").update("other-build").digest("hex");
		writeFileSync(registryPath, `${JSON.stringify(reg)}\n`);
		const registry = createRegistry(root);
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("not in approved_builds"),
		});
	});

	it("refuses a receipt whose recorded decision is not approved", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		enableRealWriteWithReceipt(root, { decision: "denied" });
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining('decision is "denied", not approved'),
		});
	});

	it("refuses a stale receipt that approves a build other than the running one", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		const staleBuild = createHash("sha256").update("previous-build").digest("hex");
		enableRealWriteWithReceipt(root, { artifact_sha256: staleBuild });
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("not the running build"),
		});
	});

	it("refuses a receipt that approves a different runtime", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		enableRealWriteWithReceipt(root, { runtime: "pi" });
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining('approves runtime "pi"'),
		});
	});

	it("refuses a malformed or duplicate-key receipt even when its bytes hash correctly", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		const receiptPath = join(root, "receipts", "t20-canary.bin");
		const malformed = '{"schema_version":1,"schema_version":1}';
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, malformed);
		enableRealWrite(root, createHash("sha256").update(malformed).digest("hex"), receiptPath);
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("T20 promotion receipt is invalid"),
		});
	});

	it("refuses a receipt whose protocol_version does not match the registry protocol", () => {
		const root = makeRoot();
		const registry = createRegistry(root);
		enableRealWriteWithReceipt(root, { protocol_version: 2 });
		expect(registry.checkPromotionGate()).toMatchObject({
			ok: false,
			code: "registry_invalid",
			message: expect.stringContaining("protocol_version"),
		});
	});

	// =======================================================================
	// Fix 4 + 10: backup_dir seam and the recovery inspector in messages
	// =======================================================================

	function writeStaleBlockedClaim(
		registry: SessionOpenLeaseRegistry,
		root: string,
		transcript: string,
		options: { backupDir?: string },
	): { pathHash: string; originalFingerprint: string; candidateFingerprint: string } {
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		const originalFingerprint = fileFingerprint(join(root, "session.jsonl.original"))!;
		// A candidate hash that matches neither the original nor the current
		// bytes, so recovery can only restore from the backup or block.
		const candidateFingerprint = createHash("sha256").update("abandoned candidate bytes").digest("hex");
		const claim = {
			lock_id: "stale-blocked-lock",
			path_hash: pathHash,
			session_id: "session-a",
			purpose: "test",
			owner_pid: 4242,
			owner_start_utc: "2026-01-01T00:00:00.000000Z",
			owner_runtime: "li",
			owner_build_hash: "test",
			phase: "blocked" as const,
			operation_id: "operation-c",
			original_fingerprint: originalFingerprint,
			candidate_fingerprint: candidateFingerprint,
			backup_name: "session.jsonl.bak",
			...(options.backupDir !== undefined ? { backup_dir: options.backupDir } : {}),
		};
		expect(parseClaimRecord(claim)).not.toBeNull();
		const created = registry.createClaim(claim);
		expect(created.ok).toBe(true);
		return { pathHash, originalFingerprint, candidateFingerprint };
	}

	it("looks up recovery backups in the claim's backup_dir and falls back to the default directory", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "mutated current bytes\n");
		writeFileSync(join(root, "session.jsonl.original"), "original synthetic bytes\n");

		// Claim with an explicit backup_dir: recovery must look there, not in
		// the registry's default backups directory.
		const customBackupDir = join(root, "custom-backups");
		mkdirSync(customBackupDir, { recursive: true });
		writeFileSync(join(customBackupDir, "session.jsonl.bak"), "original synthetic bytes\n");
		const registry = createRegistry(root, inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]])));
		const claim = writeStaleBlockedClaim(registry, root, transcript, { backupDir: customBackupDir });
		const recovery = registry.recoverStaleClaim({ pathHash: claim.pathHash, transcriptPath: transcript });
		expect(recovery).toMatchObject({
			ok: true,
			value: {
				action: "restore_candidate",
				backupPath: join(customBackupDir, "session.jsonl.bak"),
			},
		});

		// Claim without backup_dir: recovery falls back to <root>/backups.
		const root2 = makeRoot();
		const transcript2 = join(root2, "session.jsonl");
		writeFileSync(transcript2, "mutated current bytes\n");
		writeFileSync(join(root2, "session.jsonl.original"), "original synthetic bytes\n");
		const defaultBackupDir = join(root2, "session-open-leases", "backups");
		mkdirSync(defaultBackupDir, { recursive: true });
		writeFileSync(join(defaultBackupDir, "session.jsonl.bak"), "original synthetic bytes\n");
		const registry2 = createRegistry(root2, inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]])));
		const claim2 = writeStaleBlockedClaim(registry2, root2, transcript2, {});
		expect(registry2.recoverStaleClaim({ pathHash: claim2.pathHash, transcriptPath: transcript2 })).toMatchObject({
			ok: true,
			value: {
				action: "restore_candidate",
				backupPath: join(defaultBackupDir, "session.jsonl.bak"),
			},
		});
	});

	it("validates optional claim backup_dir as undefined or non-empty string", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		const claim = {
			lock_id: "backup-dir-claim",
			path_hash: pathHash,
			session_id: "session-a",
			purpose: "test",
			owner_pid: process.pid,
			owner_start_utc: "2026-01-01T00:00:00.000000Z",
			owner_runtime: "li",
			owner_build_hash: "test",
			phase: "acquired",
			operation_id: "operation-backup-dir",
			original_fingerprint: fileFingerprint(transcript),
		};
		expect(parseClaimRecord(claim)).not.toBeNull();
		expect(parseClaimRecord({ ...claim, backup_dir: join(root, "backups") })?.backup_dir).toBe(join(root, "backups"));
		expect(parseClaimRecord({ ...claim, backup_dir: "" })).toBeNull();
		expect(parseClaimRecord({ ...claim, backup_dir: 1 })).toBeNull();
	});

	it("reports the recovery inspector (phase, hashes, backup location) when a stale claim is blocked", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "irrecoverable bytes\n");
		writeFileSync(join(root, "session.jsonl.original"), "original synthetic bytes\n");
		const registry = createRegistry(root, inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]])));
		const claim = writeStaleBlockedClaim(registry, root, transcript, {});
		// No backup file anywhere: recovery is blocked and the reason must carry
		// the full inspector per spec Task 4.
		const recovery = registry.recoverStaleClaim({ pathHash: claim.pathHash, transcriptPath: transcript });
		expect(recovery.ok).toBe(true);
		if (!recovery.ok || recovery.value.action !== "blocked") throw new Error(JSON.stringify(recovery));
		const reason = recovery.value.reason;
		expect(reason).toContain("phase=blocked");
		expect(reason).toContain(`current=${fileFingerprint(transcript)}`);
		expect(reason).toContain(`original=${claim.originalFingerprint}`);
		expect(reason).toContain(`candidate=${claim.candidateFingerprint}`);
		expect(reason).toContain("backup=session.jsonl.bak");
		expect(reason).toContain(`backup_dir=${join(root, "session-open-leases", "backups")}`);
	});

	// =======================================================================
	// Fix 5: publishGuardRecord reclaims only provably dead guard owners
	// =======================================================================

	it("reclaims a dead owner's guard record after a death proof and refuses live or own-pid owners", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const starts = new Map<number, string>([
			[process.pid, "2026-01-01T00:00:00.000000Z"],
			[4242, "2026-02-01T00:00:00.000000Z"],
		]);
		const registry = createRegistry(root, inventory(starts));
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		const guardsDir = join(root, "session-open-leases", "guards");

		// Dead owner: recorded start identity mismatches the OS inventory.
		writeFileSync(
			join(guardsDir, `${pathHash}.lock`),
			JSON.stringify({
				guard_id: "dead-guard",
				path_hash: pathHash,
				owner_pid: 4242,
				owner_start_utc: "2026-03-01T00:00:00.000000Z",
				started_at: "2026-01-01T00:00:00.000Z",
			}),
		);
		const reclaimed = registry.publishGuardRecord(pathHash, "my-guard");
		expect(reclaimed).toMatchObject({ ok: true, value: { guard_id: "my-guard" } });
		// The stale record is quarantined (retained as evidence), not deleted.
		const guardFiles = readdirSync(guardsDir);
		expect(guardFiles.some((name) => name.startsWith(`${pathHash}.lock.`) && name.includes(".stale-"))).toBe(true);
		expect(JSON.parse(readFileSync(join(guardsDir, `${pathHash}.lock`), "utf8"))).toMatchObject({
			guard_id: "my-guard",
		});

		// Live owner refuses as before.
		writeFileSync(
			join(guardsDir, `${pathHash}.lock`),
			JSON.stringify({
				guard_id: "live-guard",
				path_hash: pathHash,
				owner_pid: 4242,
				owner_start_utc: "2026-02-01T00:00:00.000000Z",
				started_at: "2026-01-01T00:00:00.000Z",
			}),
		);
		expect(registry.publishGuardRecord(pathHash, "my-guard-2")).toMatchObject({
			ok: false,
			code: "writer_conflict",
		});

		// Own-process record refuses (never steal our own record).
		writeFileSync(
			join(guardsDir, `${pathHash}.lock`),
			JSON.stringify({
				guard_id: "own-guard",
				path_hash: pathHash,
				owner_pid: process.pid,
				owner_start_utc: "2026-01-01T00:00:00.000000Z",
				started_at: "2026-01-01T00:00:00.000Z",
			}),
		);
		expect(registry.publishGuardRecord(pathHash, "my-guard-3")).toMatchObject({
			ok: false,
			code: "writer_conflict",
		});
	});

	// =======================================================================
	// Fix C: stale-guard reclaim is race-safe (restore-on-mismatch fence)
	// =======================================================================

	function writeGuardRecord(
		guardsDir: string,
		pathHash: string,
		guardId: string,
		ownerPid: number,
		ownerStart: string,
	): void {
		writeFileSync(
			join(guardsDir, `${pathHash}.lock`),
			JSON.stringify({
				guard_id: guardId,
				path_hash: pathHash,
				owner_pid: ownerPid,
				owner_start_utc: ownerStart,
				started_at: "2026-01-01T00:00:00.000Z",
			}),
		);
	}

	it("publishGuardRecord restores a record replaced between the initial read and the reclaim", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const starts = new Map<number, string>([
			[process.pid, "2026-01-01T00:00:00.000000Z"],
			// Observed stale record: dead owner (recorded start mismatches inventory).
			// Concurrent publisher: live owner that wins the race in the hook.
			[4242, "2026-02-01T00:00:00.000000Z"],
			[4243, "2026-04-01T00:00:00.000000Z"],
		]);
		const guardsDir = join(root, "session-open-leases", "guards");
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		let replaced = false;
		const registry = createRegistry(root, inventory(starts), () => {
			if (replaced) return;
			replaced = true;
			// A concurrent publisher replaced the record between our initial read
			// (dead owner) and the reclaiming rename: the canonical file now holds
			// a LIVE owner's record, which must never be stranded in quarantine.
			writeGuardRecord(guardsDir, pathHash, "live-publisher", 4243, "2026-04-01T00:00:00.000000Z");
		});

		writeGuardRecord(guardsDir, pathHash, "dead-guard", 4242, "2026-03-01T00:00:00.000000Z");
		expect(registry.publishGuardRecord(pathHash, "my-guard")).toMatchObject({
			ok: false,
			code: "writer_conflict",
		});
		// The live publisher's record is restored at the canonical name.
		expect(JSON.parse(readFileSync(join(guardsDir, `${pathHash}.lock`), "utf8"))).toMatchObject({
			guard_id: "live-publisher",
		});
		// Nothing was stranded under a quarantine suffix.
		expect(readdirSync(guardsDir).filter((name) => name.includes(".stale-")).length).toBe(0);
	});

	it("withIdentityGuard restores a replaced record and never runs its callback on the raced reclaim", () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "synthetic\n");
		const starts = new Map<number, string>([
			[process.pid, "2026-01-01T00:00:00.000000Z"],
			[4242, "2026-02-01T00:00:00.000000Z"],
			[4243, "2026-04-01T00:00:00.000000Z"],
		]);
		const guardsDir = join(root, "session-open-leases", "guards");
		const { pathHash } = canonicalTranscriptIdentity(transcript);
		let replaced = false;
		const registry = createRegistry(root, inventory(starts), () => {
			if (replaced) return;
			replaced = true;
			writeGuardRecord(guardsDir, pathHash, "live-publisher", 4243, "2026-04-01T00:00:00.000000Z");
		});

		writeGuardRecord(guardsDir, pathHash, "dead-guard", 4242, "2026-03-01T00:00:00.000000Z");
		const callbackRan = false;
		const acquired = registry.acquireLease({ sessionId: "session-a", transcriptPath: transcript });
		expect(acquired).toMatchObject({ ok: false, code: "writer_conflict" });
		expect(callbackRan).toBe(false);
		// Canonical name keeps the live publisher's record.
		expect(JSON.parse(readFileSync(join(guardsDir, `${pathHash}.lock`), "utf8"))).toMatchObject({
			guard_id: "live-publisher",
		});
		expect(readdirSync(guardsDir).filter((name) => name.includes(".stale-")).length).toBe(0);
		// No lease was written because fn never executed.
		expect(readdirSync(join(root, "session-open-leases", "leases"))).toEqual([]);
		expect(callbackRan).toBe(false);
	});

	// =======================================================================
	// Fix 3 + B: guardedRestore fingerprints through its own exclusive guard
	// and binds the backup to the claim's recorded original fingerprint
	// =======================================================================

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"restores a backup under its own exclusive guard even though plain reads hit the range lock",
		async () => {
			const root = makeRoot();
			const transcript = join(root, "session.jsonl");
			writeFileSync(transcript, "mutated current bytes\n");
			const backupDir = join(root, "session-open-leases", "backups");
			mkdirSync(backupDir, { recursive: true });
			const backupPath = join(backupDir, "session.jsonl.bak");
			writeFileSync(backupPath, "original backed up bytes\n");
			const registry = createRegistry(root);
			const { pathHash } = canonicalTranscriptIdentity(transcript);

			const restored = await registry.guardedRestore({
				transcriptPath: transcript,
				backupPath,
				pathHash,
				expectedCurrentFingerprint: fileFingerprint(transcript)!,
				expectedBackupFingerprint: fileFingerprint(backupPath)!,
			});
			expect(restored).toMatchObject({
				ok: true,
				value: { fingerprint: createHash("sha256").update("original backed up bytes\n").digest("hex") },
			});
			expect(readFileSync(transcript, "utf8")).toBe("original backed up bytes\n");
			// The backup source is read, not consumed.
			expect(existsSync(backupPath)).toBe(true);
			// No restore snapshot temp files are left behind.
			expect(readdirSync(root).filter((name) => name.includes(".restore-")).length).toBe(0);
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"refuses guarded restore with writer_conflict while another live exclusive guard holds the file",
		async () => {
			const root = makeRoot();
			const transcript = join(root, "session.jsonl");
			writeFileSync(transcript, "mutated current bytes\n");
			const backupPath = join(root, "session.jsonl.bak");
			writeFileSync(backupPath, "original backed up bytes\n");
			const registry = createRegistry(root);
			const { pathHash } = canonicalTranscriptIdentity(transcript);
			const foreign = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(foreign.ok).toBe(true);
			if (!foreign.ok) return;
			try {
				const refused = await registry.guardedRestore({
					transcriptPath: transcript,
					backupPath,
					pathHash,
					expectedCurrentFingerprint: fileFingerprint(transcript) ?? "unavailable-while-locked",
					expectedBackupFingerprint: fileFingerprint(backupPath) ?? "unavailable-while-locked",
				});
				// The refusal must be the honest writer_conflict of the foreign
				// guard, not a misleading recovery_blocked from a failed read.
				expect(refused).toMatchObject({ ok: false, code: "writer_conflict" });
			} finally {
				await foreign.guard.release();
			}
		},
	);

	// Fix B: a backup mutated between recovery inspection and restore is
	// refused before any guard is taken, with the transcript untouched.
	it("refuses guarded restore when the backup no longer matches the claim's recorded original fingerprint", async () => {
		const root = makeRoot();
		const transcript = join(root, "session.jsonl");
		writeFileSync(transcript, "mutated current bytes\n");
		writeFileSync(join(root, "session.jsonl.original"), "original synthetic bytes\n");
		const backupDir = join(root, "session-open-leases", "backups");
		mkdirSync(backupDir, { recursive: true });
		const backupPath = join(backupDir, "session.jsonl.bak");
		// Backup bytes hash exactly to the claim's recorded original fingerprint.
		writeFileSync(backupPath, "original synthetic bytes\n");
		const registry = createRegistry(root, inventory(new Map([[process.pid, "2026-01-01T00:00:00.000000Z"]])));
		const claim = writeStaleBlockedClaim(registry, root, transcript, {});

		const recovery = registry.recoverStaleClaim({ pathHash: claim.pathHash, transcriptPath: transcript });
		expect(recovery).toMatchObject({
			ok: true,
			value: {
				action: "restore_candidate",
				backupPath,
				expectedBackupFingerprint: claim.originalFingerprint,
			},
		});
		if (!recovery.ok || recovery.value.action !== "restore_candidate") throw new Error(JSON.stringify(recovery));

		// The backup mutates between inspection and restore (TOCTOU).
		writeFileSync(backupPath, "tampered backup bytes\n");
		const refused = await registry.guardedRestore({
			transcriptPath: transcript,
			backupPath,
			pathHash: claim.pathHash,
			expectedCurrentFingerprint: recovery.value.expectedCurrentFingerprint,
			expectedBackupFingerprint: recovery.value.expectedBackupFingerprint,
		});
		// The refusal is recovery_blocked and fires before the exclusive guard:
		// this test runs on every platform because no guard is ever taken.
		expect(refused).toMatchObject({ ok: false, code: "recovery_blocked" });
		if (!refused.ok) expect(refused.message).toContain("no longer matches");
		// The transcript bytes are untouched and no guard record leaked.
		expect(readFileSync(transcript, "utf8")).toBe("mutated current bytes\n");
		expect(registry.readGuardRecord(claim.pathHash)).toEqual({ ok: true, value: null });
	});
});

it("normalizes DMTF process creation time and rejects invalid calendar fields", () => {
	expect(normalizeProcessStartUtc("20260105093000.123456+420")).toBe("2026-01-05T02:30:00.123456Z");
	expect(normalizeProcessStartUtc("2026-02-30T09:30:00.123456Z")).toBe(PROCESS_START_UNKNOWN);
	expect(normalizeProcessStartUtc("20260230093000.123456+420")).toBe(PROCESS_START_UNKNOWN);
	expect(normalizeProcessStartUtc(undefined)).toBe(PROCESS_START_UNKNOWN);
});
