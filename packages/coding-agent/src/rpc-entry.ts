#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { claimSessionHandoffFromEnv } from "./core/session-owner-protocol.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Owner handoff successor path: claim the pending lease BEFORE the runtime
// builds its AgentSession, otherwise the still-alive previous owner's lease
// record blocks session open (SessionDataLockedError).
claimSessionHandoffFromEnv();

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
