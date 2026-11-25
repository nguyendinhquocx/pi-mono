import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BRIDGE_HEARTBEAT_FRESH_MS,
	defaultTelegramFollowUpPolicy,
	evaluateEnableGate,
	formatDelayMinutes,
	globalPolicyPath,
	globalStatusPath,
	readGlobalPolicy,
	readGlobalStatus,
	resolveSupervisorRoot,
	TELEGRAM_FOLLOW_UP_POLICY_VERSION,
	writeGlobalPolicy,
} from "../src/modes/interactive/telegram-follow-up-policy.ts";

describe("telegram-follow-up-policy", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "tfu-policy-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("missing file resolves to defaults (Off, 10m/5m/5m)", () => {
		const result = readGlobalPolicy(root);
		expect(result.source).toBe("missing");
		expect(result.policy).toEqual(defaultTelegramFollowUpPolicy());
		expect(result.policy.enabled).toBe(false);
		expect(result.policy.finalAnswerDelayMinutes).toBe(10);
		expect(result.policy.askUserDelayMinutes).toBe(5);
		expect(result.policy.terminalNoticeDelayMinutes).toBe(5);
	});

	it("malformed JSON fails closed with a schema diagnostic", () => {
		writeFileSync(globalPolicyPath(root), "{ not json", "utf8");
		const result = readGlobalPolicy(root);
		expect(result.source).toBe("invalid");
		expect(result.diagnostic).toBe("ERR_POLICY_SCHEMA");
		expect(result.policy.enabled).toBe(false);
		expect(result.policy).toEqual(defaultTelegramFollowUpPolicy());
	});

	it("unknown version fails closed with a version diagnostic", () => {
		writeFileSync(
			globalPolicyPath(root),
			JSON.stringify({ ...defaultTelegramFollowUpPolicy(), enabled: true, version: 99 }),
			"utf8",
		);
		const result = readGlobalPolicy(root);
		expect(result.source).toBe("invalid");
		expect(result.diagnostic).toBe("ERR_POLICY_VERSION");
		expect(result.policy.enabled).toBe(false);
	});

	it("out-of-range delay fails closed", () => {
		writeFileSync(
			globalPolicyPath(root),
			JSON.stringify({ ...defaultTelegramFollowUpPolicy(), finalAnswerDelayMinutes: 7 }),
			"utf8",
		);
		const result = readGlobalPolicy(root);
		expect(result.source).toBe("invalid");
		expect(result.policy.finalAnswerDelayMinutes).toBe(10);
	});

	it("write persists atomically and bumps the revision monotonically", () => {
		const first = writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }));
		expect(first.ok).toBe(true);
		expect(first.policy.revision).toBe(1);
		const second = writeGlobalPolicy(root, (policy) => ({ ...policy, askUserDelayMinutes: null }));
		expect(second.ok).toBe(true);
		expect(second.policy.revision).toBe(2);
		const onDisk = JSON.parse(readFileSync(globalPolicyPath(root), "utf8"));
		expect(onDisk.revision).toBe(2);
		expect(onDisk.enabled).toBe(true);
		expect(onDisk.askUserDelayMinutes).toBeNull();
	});

	it("two independent readers observe a committed change immediately", () => {
		writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }));
		const readerA = readGlobalPolicy(root);
		const readerB = readGlobalPolicy(root);
		expect(readerA.source).toBe("file");
		expect(readerB.policy.enabled).toBe(true);
		expect(readerB.policy.revision).toBe(readerA.policy.revision);
	});

	it("mutations apply to the newest on-disk policy, not the caller's snapshot", () => {
		// `stale` is captured before another writer enables the policy; a later
		// mutation must still land on top of the newer committed state.
		const stale = readGlobalPolicy(root).policy;
		writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }));
		const result = writeGlobalPolicy(root, (policy) => ({ ...policy, terminalNoticeDelayMinutes: null }));
		expect(result.ok).toBe(true);
		expect(result.policy.enabled).toBe(true);
		expect(result.policy.terminalNoticeDelayMinutes).toBeNull();
		expect(result.policy.revision).toBe(2);
		expect(stale.enabled).toBe(false);
	});

	it("invalid mutation keeps the previous policy and reports a diagnostic", () => {
		writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }));
		const result = writeGlobalPolicy(root, (policy) => ({ ...policy, finalAnswerDelayMinutes: 999 as never }));
		expect(result.ok).toBe(false);
		expect(result.diagnostic).toBe("ERR_POLICY_SCHEMA");
		expect(readGlobalPolicy(root).policy.finalAnswerDelayMinutes).toBe(10);
	});

	it("enable gate blocks without a global-status file", () => {
		expect(evaluateEnableGate(root).ok).toBe(false);
		expect(evaluateEnableGate(root).reason).toBe("no_bridge");
	});

	it("enable gate blocks a stale heartbeat and a wrong protocol", () => {
		const writeStatus = (updatedAt: Date, protocolVersion: number) => {
			writeFileSync(
				globalStatusPath(root),
				JSON.stringify({ protocolVersion, updatedAt: updatedAt.toISOString() }),
				"utf8",
			);
		};
		const fresh = new Date(Date.now() - 1_000);
		writeStatus(fresh, 1);
		expect(evaluateEnableGate(root)).toEqual({ ok: false, reason: "wrong_protocol" });
		writeStatus(new Date(Date.now() - BRIDGE_HEARTBEAT_FRESH_MS - 1_000), 2);
		expect(evaluateEnableGate(root)).toEqual({ ok: false, reason: "stale_bridge" });
		writeStatus(fresh, 2);
		expect(evaluateEnableGate(root)).toEqual({ ok: true });
	});

	it("writeGlobalPolicy refuses Off→On without a bridge and commits it with one", () => {
		const blocked = writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }), {
			enableGate: () => ({ ok: false, reason: "no_bridge" }),
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.diagnostic).toBe("ENABLE_NO_BRIDGE");
		expect(readGlobalPolicy(root).source).toBe("missing");

		mkdirSync(root, { recursive: true });
		writeFileSync(
			globalStatusPath(root),
			JSON.stringify({ protocolVersion: 2, updatedAt: new Date().toISOString() }),
			"utf8",
		);
		const allowed = writeGlobalPolicy(root, (policy) => ({ ...policy, enabled: true }), {
			enableGate: () => ({ ok: true }),
		});
		expect(allowed.ok).toBe(true);
		expect(readGlobalPolicy(root).policy.enabled).toBe(true);
	});

	it("readGlobalStatus parses allowlisted delivery codes and drops unknown ones", () => {
		writeFileSync(
			globalStatusPath(root),
			JSON.stringify({
				protocolVersion: 2,
				updatedAt: new Date().toISOString(),
				lastDelivery: { status: "failed", code: "429" },
			}),
			"utf8",
		);
		const status = readGlobalStatus(root);
		expect(status.present).toBe(true);
		expect(status.freshBridge).toBe(true);
		expect(status.lastDeliveryStatus).toBe("failed");
		expect(status.lastDeliveryCode).toBe("429");

		writeFileSync(
			globalStatusPath(root),
			JSON.stringify({
				protocolVersion: 2,
				updatedAt: new Date().toISOString(),
				lastDelivery: { status: "failed", code: "<script>leak</script>" },
			}),
			"utf8",
		);
		const dropped = readGlobalStatus(root);
		expect(dropped.lastDeliveryStatus).toBe("failed");
		expect(dropped.lastDeliveryCode).toBeUndefined();
	});

	it("resolveSupervisorRoot honors the override and platform defaults", () => {
		const home = "/home/tester";
		expect(resolveSupervisorRoot({ TELEPI_SUPERVISOR_DIR: " /custom/root " }, "linux", home)).toBe("/custom/root");
		expect(resolveSupervisorRoot({ TELEPI_SUPERVISOR_DIR: "  " }, "linux", home)).toBe(
			join(home, ".config", "telepi", "supervisor"),
		);
		expect(resolveSupervisorRoot({ APPDATA: "C:\\Data" }, "win32", home)).toBe("C:\\Data\\telepi\\supervisor");
		expect(resolveSupervisorRoot({}, "win32", home)).toBe(join(home, "AppData", "Roaming", "telepi", "supervisor"));
		expect(resolveSupervisorRoot({}, "linux", home)).toBe(join(home, ".config", "telepi", "supervisor"));
	});

	it("formatDelayMinutes renders Off and Xm labels", () => {
		expect(formatDelayMinutes(null)).toBe("Off");
		expect(formatDelayMinutes(1)).toBe("1m");
		expect(formatDelayMinutes(60)).toBe("60m");
	});

	it("policy schema stays at the expected version", () => {
		expect(TELEGRAM_FOLLOW_UP_POLICY_VERSION).toBe(1);
	});
});
