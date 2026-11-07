import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TranscriptWriteGuard } from "../src/core/transcript-write-guard.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function createPersistedSession() {
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
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`);

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
	writeFileSync(
		join(registryDir, "registry.json"),
		`${JSON.stringify({
			format_version: 1,
			protocol_version: 1,
			real_write_enabled: true,
			approved_builds: [
				{ runtime: APP_NAME, launcher_path: "synthetic-test", artifact_sha256: buildHash, protocol_version: 1 },
			],
			t20_receipt_sha256: createHash("sha256").update("synthetic-test-receipt").digest("hex"),
		})}\n`,
	);

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
	});
	await session.bindExtensions({ mode: "tui" });
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

	it.skipIf(!TranscriptWriteGuard.isPlatformSupported())(
		"reloads a replaced transcript in-place and emits exactly one internal event",
		async () => {
			const fixture = await createPersistedSession();
			const { session, sessionFile, sessionManager, header, userEntry } = fixture;
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
				const candidate = `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(candidateEntry)}\n`;
				const candidatePath = join(dirname(sessionFile), "candidate.tmp");
				writeFileSync(candidatePath, candidate);
				const replaced = await session.replaceSessionDataTranscript({
					candidatePath,
					lockId: lock.lockId,
				});
				if (replaced.status !== "replaced") throw new Error(JSON.stringify(replaced));
				const fingerprint = createHash("sha256").update(candidate, "utf8").digest("hex");
				const result = await session.reloadSessionFromDisk({
					expectedFingerprint: fingerprint,
					lockId: lock.lockId,
				});

				expect(result).toMatchObject({ status: "reloaded", sessionId: header.id, fingerprint, entryCount: 2 });
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
});
