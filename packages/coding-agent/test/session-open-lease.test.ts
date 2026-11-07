import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalTranscriptIdentity,
	fileFingerprint,
	LEASE_REGISTRY_FORMAT_VERSION,
	LEASE_REGISTRY_PROTOCOL_VERSION,
	normalizeProcessStartUtc,
	PROCESS_START_UNKNOWN,
	type ProcessInventory,
	parseJsonStrict,
	SessionOpenLeaseRegistry,
} from "../src/core/session-open-lease.ts";

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
) {
	return SessionOpenLeaseRegistry.open(root, {
		runtime: "li",
		buildHash: createHash("sha256").update("test-build").digest("hex"),
		processInventory,
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
});

it("normalizes DMTF process creation time and rejects invalid calendar fields", () => {
	expect(normalizeProcessStartUtc("20260105093000.123456+420")).toBe("2026-01-05T02:30:00.123456Z");
	expect(normalizeProcessStartUtc("2026-02-30T09:30:00.123456Z")).toBe(PROCESS_START_UNKNOWN);
	expect(normalizeProcessStartUtc("20260230093000.123456+420")).toBe(PROCESS_START_UNKNOWN);
	expect(normalizeProcessStartUtc(undefined)).toBe(PROCESS_START_UNKNOWN);
});
