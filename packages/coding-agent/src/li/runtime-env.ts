/**
 * Li runtime environment resolution.
 *
 * Li keeps the shared Pi profile (configDir stays `.pi`) even though its
 * APP_NAME is `li`, so `getAgentDir()` looks at `LI_CODING_AGENT_DIR` instead
 * of `PI_CODING_AGENT_DIR`. The `li` wrapper maps existing `PI_*` profile vars
 * to their `LI_*` equivalents before starting the CLI; this module is the
 * testable source of truth for that mapping plus the fail-closed conflict rule:
 * when both a `PI_*_DIR` and its `LI_*_DIR` counterpart are set to different
 * paths, Li must refuse to start rather than silently pick one profile.
 */

import { resolve } from "node:path";

export const PI_AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";
export const LI_AGENT_DIR_VAR = "LI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_VAR = "PI_CODING_AGENT_SESSION_DIR";
export const LI_SESSION_DIR_VAR = "LI_CODING_AGENT_SESSION_DIR";

export class LiRuntimeEnvConflictError extends Error {
	constructor(variable: string, liValue: string, piValue: string) {
		super(
			`${variable} and ${piVarName(variable)} point to different profiles; refusing to start Li.\n` +
				`  ${variable}=${liValue}\n` +
				`  ${piVarName(variable)}=${piValue}\n` +
				`Unset one of them (or make them match) so Li and the shared Pi profile agree.`,
		);
		this.name = "LiRuntimeEnvConflictError";
	}
}

function piVarName(liVar: string): string {
	return liVar.startsWith("LI_") ? `PI_${liVar.slice(3)}` : liVar;
}

function samePath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = resolve(value);
		return process.platform === "win32" ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

export interface LiRuntimeEnvResolution {
	/** Effective agent dir override, or undefined to use the `~/.pi/agent` default. */
	agentDir?: string;
	/** Effective session dir override, or undefined to fall back to agentDir/CWD defaults. */
	sessionDir?: string;
}

/**
 * Resolve the effective Li profile overrides from a process environment.
 *
 * Precedence for each pair: an existing `LI_*` value wins; otherwise the
 * `PI_*` value is adopted. Setting both to different paths throws instead of
 * choosing, because Li cannot know which profile the user meant.
 */
export function resolveLiRuntimeEnv(env: NodeJS.ProcessEnv = process.env): LiRuntimeEnvResolution {
	const liAgent = env[LI_AGENT_DIR_VAR]?.trim();
	const piAgent = env[PI_AGENT_DIR_VAR]?.trim();
	if (liAgent && piAgent && !samePath(liAgent, piAgent)) {
		throw new LiRuntimeEnvConflictError(LI_AGENT_DIR_VAR, liAgent, piAgent);
	}
	const liSession = env[LI_SESSION_DIR_VAR]?.trim();
	const piSession = env[PI_SESSION_DIR_VAR]?.trim();
	if (liSession && piSession && !samePath(liSession, piSession)) {
		throw new LiRuntimeEnvConflictError(LI_SESSION_DIR_VAR, liSession, piSession);
	}
	return {
		agentDir: liAgent || piAgent || undefined,
		sessionDir: liSession || piSession || undefined,
	};
}

/**
 * Apply the resolved mapping onto the live environment so every later
 * `getAgentDir()` / session-dir lookup sees the shared Pi profile.
 *
 * Only fills in missing `LI_*` values; never overrides an explicit `LI_*`
 * setting. Throws on conflicts (fail closed) before any state is touched.
 */
export function applyLiRuntimeEnv(env: NodeJS.ProcessEnv = process.env): LiRuntimeEnvResolution {
	const resolution = resolveLiRuntimeEnv(env);
	if (resolution.agentDir && !env[LI_AGENT_DIR_VAR]?.trim()) {
		env[LI_AGENT_DIR_VAR] = resolution.agentDir;
	}
	if (resolution.sessionDir && !env[LI_SESSION_DIR_VAR]?.trim()) {
		env[LI_SESSION_DIR_VAR] = resolution.sessionDir;
	}
	return resolution;
}
