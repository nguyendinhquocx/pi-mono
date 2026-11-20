#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// main consumes and validates any one-use handoff claim after resolving the
// selected session but before AgentSession construction.

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
