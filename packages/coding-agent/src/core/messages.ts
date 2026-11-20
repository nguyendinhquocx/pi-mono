/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export type CustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details"
>;

/** Runtime validator + snapshot for extension payloads; TypeScript types do not protect JS extensions. */
export function snapshotCustomMessage<T = unknown>(value: unknown): CustomMessagePayload<T> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Custom message must be an object");
	}
	const record = value as Record<string, unknown>;
	const customType = record.customType;
	const rawContent = record.content;
	const display = record.display;
	const details = record.details;
	if (typeof customType !== "string" || typeof display !== "boolean") {
		throw new TypeError("Custom message requires a string customType and boolean display");
	}
	return {
		customType,
		content: snapshotCustomMessageContent(rawContent),
		display,
		details: snapshotJsonValue(details) as T | undefined,
	};
}

/** Match the JSONL persistence semantics while severing mutable extension references. */
function snapshotJsonValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? undefined : JSON.parse(serialized);
	} catch {
		throw new TypeError("Custom message metadata must be JSON-serializable");
	}
}

export function isCustomMessageContent(value: unknown): value is string | (TextContent | ImageContent)[] {
	if (typeof value === "string") return true;
	if (!Array.isArray(value)) return false;
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index)) return false;
		const block = value[index];
		if (!block || typeof block !== "object" || Array.isArray(block)) return false;
		const record = block as Record<string, unknown>;
		if (
			record.type === "text" &&
			typeof record.text === "string" &&
			(record.textSignature === undefined || typeof record.textSignature === "string")
		) {
			continue;
		}
		if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") continue;
		return false;
	}
	return true;
}

/** Copy mutable extension content so it cannot change after validation/queue admission. */
export function snapshotCustomMessageContent(value: unknown): string | (TextContent | ImageContent)[] {
	if (value == null) return [];
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) {
		throw new TypeError("Custom message content must be a string or an array of text/image blocks");
	}

	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index)) {
			throw new TypeError("Custom message content cannot contain sparse array holes");
		}
	}
	const snapshot = snapshotJsonValue(value);
	if (!isCustomMessageContent(snapshot)) {
		throw new TypeError("Custom message content must contain text/image blocks");
	}
	return snapshot;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
