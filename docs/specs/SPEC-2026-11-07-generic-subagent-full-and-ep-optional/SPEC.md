---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-07-generic-subagent-full-and-ep-optional"
status: "archived"
title: "Generic subagent đầy đủ; EP là lane tùy chọn"
archived_at: "2026-11-08T16:09:16+07:00"
source_file: "SPEC-2026-11-07-generic-subagent-full-and-ep-optional.md"
source_sha256: "c132f7007b41c7e957b88c27730157c4726d90e747bc5e715de52d52a766daae"
implementation_ref: "bd09fdd4c5fd89aebfaa9a2c4dbe9c03583ab01a"
working_tree: "clean"
related_paths: ["packages/coding-agent/src/core/agent-session.ts", "packages/coding-agent/test/default-tools-setting.test.ts"]
---

# Spec: Generic subagent đầy đủ; EP là lane tùy chọn

## Context Snapshot

- **Project / runtime:** Li core `D:/pcloud/workspace/code/pi-mono-li` (`li/stable`), canonical Pi extension source `D:/pcloud/workspace/code/python`.
- **Current candidate:** Li r6 commit `7a656cf19`, build artifact `f147fb604ba46ac66bcb014c034635326613b82885ef43d776048b421bcce13d`; current runtime r6 has the count-only migration toast.
- **Python ownership:** session-trim is actively working in `t1-ep-launch-safety-wip`. Coordinate Python edits with that session; do not overwrite or mass-revert its worktree.
- **Current pain:** generic `subagent_tab` can be refused because the parent is outside a Git root, because a task is classified as writing, because another EP task is active, because no `launch_profile=generic` task is bound, because `worktree=false`, or because writer locks/reservations serialize same-project writes. This turns the normal generic subagent into a read-only/isolated lane, even though the parent has full tools. Li also emits migration notifications when it adds/restores default tools.
- **Owner decision:** ordinary generic children must retain normal parent capabilities and may be used for parallel writing. The parent decides when to use generic subagents versus the dedicated EP tool. Do not silently convert generic into EP.

## Objective

- Make `subagent_tab` a full, optional generic child lane: the parent may spawn unbound children with the normal toolset, use the same working tree or an optional worktree, and run up to 10 children in parallel without generic/EP routing gates blocking the launch.
- Keep `subagent_tab_implement_start` available as a voluntary EP lane with its existing grant/run/task authority and finish contract.
- Remove all new user-facing and transcript-entry notifications for tool-loadout migration; keep snapshot-based restoration.

## Scope

### In

1. **Generic launch behavior (Python source):**
   - Generic launch does not require `coordinationRunId`, `taskId`, `launch_profile=generic`, a Git root, or a trusted project identity.
   - Generic writer launches are not blocked because a task is `ep_required`, an EP is active, or the writer-intent classifier detects `implement`/`fix`/`patch` text.
   - `worktree=false` is permitted for generic writers; `worktree=true` remains an optional isolation choice.
   - Generic launches neither acquire nor wait on EP/shared writer locks or per-project writer reservations. Generic remains `launchProfile=generic`, `manualCompletion=false`; it never claims EP task completion or finish authority.
   - If legacy callers pass run/task binding fields to generic `subagent_tab`, those fields must not grant EP authority, force a generic task binding, or change the generic profile. The dedicated EP tool is the only route that consumes EP authority.
   - When caller omits `tools`, child tool loading follows the normal child/parent default. An explicit caller `tools` allowlist remains respected. Do not auto-restrict a child to read-only merely because `taskType=review` or a prompt mentions review.

2. **Parallel batch capacity (Python source):**
   - Raise the hard batch size to 10 and allow `maxConcurrent` 1–10. Default settings must permit a parent-requested batch of 10, subject to actual process/provider availability and any explicit user-set budget; no silent lower hard cap.
   - Preserve per-task outcome reporting, cancellation, timeouts, model policy and explicit tool allowlists.

3. **Optional EP lane (Python source):**
   - Keep `subagent_tab_implement_start` and its grant, owner, run/task manifest, scope, risk, lease, writer baseline and finish gates unchanged. The parent may choose it, but a generic launch never falls back to or impersonates EP.
   - `/implement` retains its current direct user-authorized command behavior.

4. **Tool migration messaging (Li source):**
   - Do not emit a toast/notification or append a new `tool_selection_notice` custom entry for legacy-unknown or newly-added default tools.
   - Preserve `toolSelectionSnapshot`, compaction carry-through, removal history, tool selection semantics, and provider non-leak behavior from r6. Existing historical custom entries need not be rewritten.

### Out

- Do not weaken the dedicated EP authority/consent/manifest/finish gates or route generic work through EP.
- Do not change model allowlists, credentials, provider auth, quota/cost policy, timeouts, cancellation, `subagent_tab_done` ownership, or `/implement` confirmation.
- Do not force `worktree=true`; it remains available when the parent wants isolation.
- Do not change the r6 selection snapshot, compaction, handler replacement, empty-active, branch-modifier, or late-registration fixes except deleting notice emission/persistence.
- Do not deploy this new behavior until verification passes and the owner approves rollout.

## Behavior Contract

| Parent action | Expected behavior |
|---|---|
| `subagent_tab` read-only child | Starts as generic with normal requested/default tools; no EP/task binding needed. |
| Generic writer, `worktree=false`, no Git root (e.g. parent cwd `D:/`) | Starts as generic; no project-identity refusal or writer-lock gate. |
| Generic writer while EP is active in the same project | May start concurrently; remains generic and cannot complete/claim the EP task. |
| Generic writer with `worktree=true` | Starts in an isolated worktree if the parent explicitly asks for one. |
| Generic request includes stale/partial run/task binding parameters | Binding does not grant EP authority or block generic launch; generic metadata/profile remains generic. |
| Parent voluntarily calls EP model tool with valid authority | EP path runs with current manifest/grant/lease/finish checks. |
| Parent voluntarily calls EP model tool without valid authority | EP tool refuses; generic remains separately available, with no silent fallback. |
| Resume a session receiving new default-active tools | Tool selection migrates according to the r6 snapshot/evidence rules, but no notification or notice entry is emitted. |

## Assumptions and Risks

- Owner explicitly accepts shared-tree write races: simultaneous children can edit the same file, overwrite each other's changes, or make the EP baseline include unrelated generic edits. Parent owns task decomposition and integration; use optional worktrees when overlap is undesirable.
- “Full tools” means the same normal child defaults and caller-selected allowlist behavior, not bypassing model policy, auth, operating-system permissions, or the dedicated EP authority contract.
- A batch request of 10 may still fail for real process/provider/resource errors; it must not be refused by an old fixed batch/budget ceiling below 10.
- No migration notice means the owner will not be told when an old/default session gained tools; snapshot persistence remains the source of truth.

## Ordered Tasks

### T1 — Remove generic launch writer/EP gates (Python)
- **Acceptance:** unbound generic read/write launches pass without Git identity, generic task binding, worktree, or no-active-EP preconditions; active EP does not block generic; generic never carries EP finish fields. If caller omits `tools`, the child receives the normal full default toolset; `taskType`/prompt wording must not force a read-only allowlist. Dedicated EP tests still require grant/run/task authority and retain `manualCompletion`/lease/baseline semantics.
- **Verify:** focused `subagent-tab` route/launch tests, writer-lock tests updated for generic bypass, EP start/auth tests unchanged and passing; fake-spawn test verifies generic starts while same-project EP is active and no EP task state is mutated. Tool description, promptGuidelines, and README state that generic is full/default and EP is optional.
- **Files:** `app_presets/pi/extensions/subagent-tab/index.ts`, `implement-launch-plan.ts`, `README.md`, generic launch tests; coordinate changes with session-trim's active WIP before editing.

### T2 — Allow up to 10 parallel generic children (Python)
- **Acceptance:** batch schema/runtime accept 10 tasks and `maxConcurrent: 10`; default ceilings allow that request without requiring a manifest or worktree; fake-spawn test sees all 10 generic writer attempts independently classified/reported; explicit smaller budget and failFast still work.
- **Verify:** `batch-launch.test.ts`, schema validation tests and a bounded fake-runtime smoke; no real WezTerm pane is opened by tests.
- **Files:** batch tool schema/validation/runtime and `batch-launch.test.ts`; coordinate with session-trim.

### T3 — Remove tool migration notifications (Li)
- **Acceptance:** resuming legacy-unknown or default-migrated sessions emits no `ui.notify` and appends no new `tool_selection_notice`; selection snapshot/default migration and compaction behavior remain unchanged.
- **Verify:** targeted `default-tools-setting.test.ts`; preserve existing assertions for selected-active set, snapshot, provider declarations, and non-leak behavior.
- **Files:** `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/test/default-tools-setting.test.ts`.

### T4 — Cross-review and integration verification
- **Acceptance:** parent reviews Python and Li diffs independently; generic path tests prove no hidden writer/EP gate remains; EP negative/positive authority tests still pass; batch-10 and notice-absence tests pass; Li/Python type checks and smoke pass.
- **Verify:** focused unit suites + TSC; disposable fake-provider/WezTerm smoke proves generic child can write with same tree while a same-project EP task is active, 10-child batch accepted, optional EP still refused without grant and starts with valid grant; no real user session, real pane, or real write.
- **Owner gate:** before runtime deployment or changing an active `li` runtime, present exact diff/build receipt/test evidence and wait for owner approval.

## User Test

| Action | Expected result |
|---|---|
| Parent runs generic `subagent_tab` review/read task with default tools | Child starts normally; no mandatory EP/worktree/task binding. |
| Parent runs generic writer in current shared tree without a Git root | Child starts as generic; no `same_tree_writer_refused`/project-identity block. |
| Same-project EP task is active and parent starts generic writer | Generic child may start concurrently; its result cannot finish or mutate the EP task. |
| Parent asks for 10 generic children | Batch accepts up to 10 and reports each result; real launch failures remain visible per task. |
| Parent explicitly uses EP tool without grant | EP path refuses clearly; it does not silently start a generic substitute. |
| Resume a session that migrates defaults | Tools restore by snapshot rules; no toast and no new notice entry appears. |

## Completion Gates

- Generic gate tests prove absence of all three refusals (active EP project, generic-task binding requirement, write-intent classifier denial) and same-tree/worktree denial; tests also prove optional worktree behavior and no generic EP metadata.
- Batch tests prove task count 10 and concurrency 10 without ignoring explicit smaller user budgets, failFast, model policy or per-task outcomes.
- EP tests continue to prove invalid/missing authority is refused and valid authority starts as EP with its existing lifecycle.
- Li tests prove no migration notify/custom notice while preserving r6 snapshot, compaction, handler replacement, late-registration and provider non-leak behavior.
- TSC, focused tests, `git diff --check`, and disposable smoke pass; no runtime deployment/production mutation without owner approval.
