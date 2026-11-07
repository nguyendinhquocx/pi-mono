import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCorrelatedGuardResponse, TranscriptWriteGuard } from "../src/core/transcript-write-guard.ts";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { root: string; transcript: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-transcript-guard-test-"));
	roots.push(root);
	const transcript = join(root, "session.jsonl");
	writeFileSync(transcript, "original bytes\n");
	return { root, transcript };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function snapshotThrough(guard: TranscriptWriteGuard, root: string): Promise<string> {
	const snapshotPath = join(root, "verify-snapshot.tmp");
	const snapshot = guard.mode === "exclusive" ? await guard.snapshotTo(snapshotPath) : undefined;
	if (!snapshot || !snapshot.ok) throw new Error("snapshot failed");
	return readFileSync(snapshotPath, "utf8");
}

describe("TranscriptWriteGuard", () => {
	it("fails closed on non-Windows platforms", async () => {
		if (TranscriptWriteGuard.isPlatformSupported()) return;
		const { transcript } = fixture();
		const result = await TranscriptWriteGuard.acquire(transcript);
		expect(result).toMatchObject({ ok: false, code: "write_guard_unavailable" });
	});

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"denies new writers and rewrites the path contents in place under the held lock",
		async () => {
			const { root, transcript } = fixture();
			const candidate = join(root, "candidate.tmp");
			writeFileSync(candidate, "candidate bytes\n");
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			const guard = acquired.guard;
			try {
				// New writers and pathname renames are denied while the canonical
				// exclusive guard is held.
				expect(() => writeFileSync(transcript, "evil append\n", { flag: "a" })).toThrow();
				expect(() => renameSync(transcript, join(root, "renamed-before.tmp"))).toThrow();
				expect(existsSync(transcript)).toBe(true);
				const generationBefore = guard.handleGeneration;
				const rewritten = await guard.rewrite(candidate);
				if (!rewritten.ok) throw new Error(JSON.stringify(rewritten));
				expect(rewritten.byteLength).toBe("candidate bytes\n".length);
				// The guard handle was never swapped: the rewrite reuses the exact
				// helper-side Stream/lock it acquired (no reopen, no rename).
				expect(guard.handleGeneration).toBe(generationBefore);
				expect(await guard.verifyHeld()).toBe(true);
				expect(() => renameSync(transcript, join(root, "renamed-after.tmp"))).toThrow();
				expect(existsSync(transcript)).toBe(true);
				expect(await snapshotThrough(guard, root)).toBe("candidate bytes\n");
			} finally {
				await guard.release();
			}
			expect(readFileSync(transcript, "utf8")).toBe("candidate bytes\n");
			// The rewrite reads the source; it is not consumed.
			expect(existsSync(candidate)).toBe(true);
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"background writer attempts all fail across a guarded rewrite window (no-gap proof)",
		async () => {
			const { root, transcript } = fixture();
			// Multi-megabyte fixtures make the rewrite op take long enough that
			// the background writer is guaranteed to attempt writes inside it.
			const initial = Buffer.concat([Buffer.from("original header\n"), Buffer.alloc(3 * 1024 * 1024, 97)]);
			writeFileSync(transcript, initial);
			const candidate = join(root, "candidate.tmp");
			const candidateBytes = Buffer.concat([Buffer.from("candidate header\n"), Buffer.alloc(3 * 1024 * 1024, 98)]);
			writeFileSync(candidate, candidateBytes);

			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			const guard = acquired.guard;
			const stopPath = join(root, "writer-stop");
			const logPath = join(root, "writer-log.jsonl");
			// Independent process that opens the canonical path for append as fast
			// as it can until the stop file appears. Every attempt is logged with
			// its timestamp and outcome; the guard's share mode plus byte-range
			// lock must deny all of them for the whole process lifetime, which by
			// construction brackets the entire rewrite call below.
			const writerScript = [
				`const fs = require("node:fs");`,
				`const [stopPath, logPath, target] = process.argv.slice(1);`,
				`fs.writeFileSync(logPath, JSON.stringify({ event: "started", t: Date.now() }) + "\\n");`,
				`let attempts = 0; let failed = 0; const codes = new Set();`,
				`const deadline = Date.now() + 60000;`,
				`try {`,
				`  while (!fs.existsSync(stopPath) && Date.now() < deadline) {`,
				`    attempts += 1;`,
				`    try {`,
				`      const fd = fs.openSync(target, "a");`,
				`      fs.writeSync(fd, "X");`,
				`      fs.closeSync(fd);`,
				`      fs.appendFileSync(logPath, JSON.stringify({ event: "attempt", ok: true, t: Date.now() }) + "\\n");`,
				`    } catch (error) {`,
				`      failed += 1; codes.add(error.code);`,
				`      fs.appendFileSync(logPath, JSON.stringify({ event: "attempt", ok: false, code: error.code, t: Date.now() }) + "\\n");`,
				`    }`,
				`    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);`,
				`  }`,
				`} finally {`,
				`  fs.appendFileSync(logPath, JSON.stringify({ event: "done", attempts, failed, t: Date.now() }) + "\\n");`,
				`}`,
			].join("\n");
			const child = spawn(process.execPath, ["-e", writerScript, stopPath, logPath, transcript], {
				stdio: "ignore",
			});
			try {
				// Wait until the writer process is confirmed looping before the
				// rewrite starts, so the rewrite window lies inside the attempt
				// window. The stop file is created only after the rewrite resolves,
				// so attempts were still firing while the op ran.
				const startedDeadline = Date.now() + 15_000;
				let started = false;
				while (Date.now() < startedDeadline) {
					try {
						if (readFileSync(logPath, "utf8").includes('"started"')) {
							started = true;
							break;
						}
					} catch {
						// Log not written yet.
					}
					await delay(20);
				}
				expect(started).toBe(true);

				const generationBefore = guard.handleGeneration;
				const rewriteStart = Date.now();
				const rewritten = await guard.rewrite(candidate);
				const rewriteEnd = Date.now();
				if (!rewritten.ok) throw new Error(JSON.stringify(rewritten));
				// Same helper handle and lock before and after: the rewrite never
				// closed, renamed, or reopened the canonical path (no gap exists).
				expect(guard.handleGeneration).toBe(generationBefore);

				writeFileSync(stopPath, "stop");
				await new Promise<void>((resolveExit, rejectExit) => {
					if (child.exitCode !== null) {
						resolveExit();
						return;
					}
					const timer = setTimeout(() => rejectExit(new Error("background writer did not exit")), 15_000);
					child.once("exit", () => {
						clearTimeout(timer);
						resolveExit();
					});
				});

				const lines = readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as { event: string; ok?: boolean; code?: string; t: number; attempts?: number },
					);
				const attempts = lines.filter((line) => line.event === "attempt");
				const done = lines.find((line) => line.event === "done");
				expect(done).toBeDefined();
				expect(attempts.length).toBeGreaterThan(0);
				// Zero successful writes: exclusion held for the entire window,
				// including every millisecond of the rewrite op.
				expect(attempts.filter((attempt) => attempt.ok === true)).toEqual([]);
				// Every failure is the sharing/lock denial of the held guard.
				for (const attempt of attempts) expect(attempt.code).toBe("EBUSY");
				// Overlap proof: attempts fired strictly inside the rewrite window.
				const inWindow = attempts.filter((attempt) => attempt.t >= rewriteStart && attempt.t <= rewriteEnd);
				expect(inWindow.length).toBeGreaterThan(0);
				expect(done?.attempts).toBe(attempts.length);

				expect(await guard.verifyHeld()).toBe(true);
				expect(await snapshotThrough(guard, root)).toBe(candidateBytes.toString("latin1"));
			} finally {
				await guard.release();
				if (child.exitCode === null) child.kill();
			}
			// The background writer never managed to append anything.
			expect(readFileSync(transcript)).toEqual(candidateBytes);
			expect(existsSync(candidate)).toBe(true);
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"upgrades and downgrades the session access guard with a new handle generation",
		async () => {
			const { transcript } = fixture();
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "shared" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			const guard = acquired.guard;
			try {
				writeFileSync(transcript, "shared append\n", { flag: "a" });
				const generationShared = guard.handleGeneration;
				expect((await guard.upgrade()).ok).toBe(true);
				// Upgrade disposes and reopens the path handle, so the generation moves.
				expect(guard.handleGeneration).toBe(generationShared + 1);
				expect(() => writeFileSync(transcript, "evil append\n", { flag: "a" })).toThrow();
				expect((await guard.downgrade()).ok).toBe(true);
				expect(guard.handleGeneration).toBe(generationShared + 2);
				writeFileSync(transcript, "after downgrade\n", { flag: "a" });
			} finally {
				await guard.release();
			}
			expect(readFileSync(transcript, "utf8")).toContain("after downgrade");
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"rewrites a backup in place without consuming it (guarded restore path)",
		async () => {
			const { root, transcript } = fixture();
			const backup = join(root, "session.jsonl.bak");
			writeFileSync(backup, "original backed up bytes\n");
			writeFileSync(transcript, "candidate bytes\n");
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			try {
				const generationBefore = acquired.guard.handleGeneration;
				const rewritten = await acquired.guard.rewrite(backup);
				if (!rewritten.ok) throw new Error(JSON.stringify(rewritten));
				expect(rewritten.byteLength).toBe("original backed up bytes\n".length);
				expect(await snapshotThrough(acquired.guard, root)).toBe("original backed up bytes\n");
				expect(acquired.guard.handleGeneration).toBe(generationBefore);
				expect(existsSync(backup)).toBe(true);
			} finally {
				await acquired.guard.release();
			}
			expect(readFileSync(transcript, "utf8")).toBe("original backed up bytes\n");
			expect(existsSync(backup)).toBe(true);
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"binds rewrite to a pinned source fingerprint and refuses mutated bytes with the guard held",
		async () => {
			const { root, transcript } = fixture();
			const backup = join(root, "session.jsonl.bak");
			writeFileSync(backup, "original backed up bytes\n");
			writeFileSync(transcript, "candidate bytes\n");
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			try {
				// Pin the expected source fingerprint to something other than the
				// bytes currently at the source path (e.g. the claim's recorded
				// original fingerprint after the backup was mutated in the window
				// between inspection and restore).
				const refused = await acquired.guard.rewrite(backup, {
					expectedSourceFingerprint: createHash("sha256").update("other bytes\n").digest("hex"),
				});
				expect(refused).toMatchObject({ ok: false, code: "fingerprint_mismatch" });
				// The refusal is a pre-op check: the guard stays held and the
				// guarded bytes are untouched.
				expect(acquired.guard.isHeld).toBe(true);
				expect(await snapshotThrough(acquired.guard, root)).toBe("candidate bytes\n");

				// The correct pin publishes the pinned bytes.
				const pinned = createHash("sha256").update("original backed up bytes\n").digest("hex");
				const rewritten = await acquired.guard.rewrite(backup, { expectedSourceFingerprint: pinned });
				expect(rewritten).toMatchObject({ ok: true, byteLength: "original backed up bytes\n".length });
				expect(await snapshotThrough(acquired.guard, root)).toBe("original backed up bytes\n");
			} finally {
				await acquired.guard.release();
			}
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"refuses rewrite in shared mode and when the guard is lost",
		async () => {
			const { root, transcript } = fixture();
			const candidate = join(root, "candidate.tmp");
			writeFileSync(candidate, "candidate bytes\n");
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "shared" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			const guard = acquired.guard;
			try {
				const sharedRefusal = await guard.rewrite(candidate);
				expect(sharedRefusal).toMatchObject({
					ok: false,
					code: "writer_conflict",
					message: "in-place rewrite requires the exclusive guard",
				});
			} finally {
				await guard.release();
			}
			const lostRefusal = await guard.rewrite(candidate);
			expect(lostRefusal).toMatchObject({ ok: false, code: "writer_conflict" });
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"refuses acquisition when a writer handle predates the guard",
		async () => {
			const { transcript } = fixture();
			const writer = openSync(transcript, "a");
			try {
				// The guard's exclusive share mode cannot coexist with a pre-existing
				// writer handle -> sharing violation -> typed refusal.
				const result = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
				if (result.ok || result.code !== "writer_conflict") throw new Error(JSON.stringify(result));
				// The pre-existing writer keeps working and the file is untouched.
				writeSync(writer, "writer bytes\n");
				expect(readFileSync(transcript, "utf8")).toBe("original bytes\nwriter bytes\n");
			} finally {
				closeSync(writer);
			}
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"reads guarded bytes only through the snapshot op",
		async () => {
			const { root, transcript } = fixture();
			const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			try {
				let directRead: string = "no-error";
				try {
					directRead = readFileSync(transcript, "utf8");
				} catch {
					directRead = "EBUSY";
				}
				expect(directRead).toBe("EBUSY");
				const snapshotPath = join(root, "snapshot.tmp");
				const snapshot = await acquired.guard.snapshotTo(snapshotPath);
				expect(snapshot).toMatchObject({ ok: true, byteLength: "original bytes\n".length });
				expect(readFileSync(snapshotPath, "utf8")).toBe("original bytes\n");
			} finally {
				await acquired.guard.release();
			}
		},
	);

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())("snapshots empty transcripts as empty files", async () => {
		const { root, transcript } = fixture();
		writeFileSync(transcript, "");
		const acquired = await TranscriptWriteGuard.acquire(transcript, { mode: "exclusive" });
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		try {
			const snapshotPath = join(root, "empty-snapshot.tmp");
			const snapshot = await acquired.guard.snapshotTo(snapshotPath);
			expect(snapshot).toMatchObject({ ok: true, byteLength: 0 });
			expect(readFileSync(snapshotPath, "utf8")).toBe("");
		} finally {
			await acquired.guard.release();
		}
	});

	// =======================================================================
	// Fix 6: per-request correlation + uncertain state after a mutation timeout
	// =======================================================================

	it("accepts only a helper response whose correlation id matches the pending request", () => {
		const stale = parseCorrelatedGuardResponse(
			JSON.stringify({ ok: true, held: true, reqId: "req-stale" }),
			"req-current",
		);
		expect(stale).toBeUndefined();

		const uncorrelated = parseCorrelatedGuardResponse(JSON.stringify({ ok: true, held: true }), "req-current");
		expect(uncorrelated).toBeUndefined();

		const current = parseCorrelatedGuardResponse(
			JSON.stringify({ ok: true, held: true, reqId: "req-current" }),
			"req-current",
		);
		expect(current).toMatchObject({ ok: true, reqId: "req-current" });
	});

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"marks the guard uncertain after a timed-out rewrite and refuses later ops",
		async () => {
			const { root, transcript } = fixture();
			const candidate = join(root, "candidate.tmp");
			writeFileSync(candidate, "candidate bytes\n");
			// A 1ms timeout simulates a stalled helper mutation op.
			const acquired = await TranscriptWriteGuard.acquire(transcript, {
				mode: "exclusive",
				opTimeoutMs: 1,
				acquireTimeoutMs: 20_000,
			});
			expect(acquired.ok).toBe(true);
			if (!acquired.ok) return;
			const guard = acquired.guard;
			try {
				const timedOut = await guard.rewrite(candidate);
				expect(timedOut).toMatchObject({ ok: false, code: "write_guard_uncertain" });
				// The helper was killed and the guard can no longer be trusted.
				expect(guard.isHeld).toBe(false);
				expect(guard.isUncertain).toBe(true);
				// Every later op on the uncertain guard refuses with the typed code.
				const laterRewrite = await guard.rewrite(candidate);
				expect(laterRewrite).toMatchObject({ ok: false, code: "write_guard_uncertain" });
				const laterSnapshot = await guard.snapshotTo(join(root, "later-snapshot.tmp"));
				expect(laterSnapshot).toMatchObject({ ok: false, code: "write_guard_uncertain" });
				const laterUpgrade = await guard.upgrade();
				expect(laterUpgrade).toMatchObject({ ok: false, code: "write_guard_uncertain" });
				expect(await guard.verifyHeld()).toBe(false);
			} finally {
				await guard.release();
				// The killed helper releases its OS handle asynchronously; wait for
				// the transcript to become unlockable before the shared afterEach
				// cleanup rmSync runs.
				const deadline = Date.now() + 10_000;
				let unlocked = false;
				while (Date.now() < deadline) {
					try {
						const handle = openSync(transcript, "r+");
						closeSync(handle);
						unlocked = true;
						break;
					} catch {
						await delay(50);
					}
				}
				expect(unlocked).toBe(true);
			}
		},
	);
});
