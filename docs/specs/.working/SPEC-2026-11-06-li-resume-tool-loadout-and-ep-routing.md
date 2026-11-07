---
artifact_type: "working-spec"
spec_id: "SPEC-2026-11-06-li-resume-tool-loadout-and-ep-routing"
status: "working"
revision: "r6"
review_status: "Terra/Luna/GLM r5 review xong; owner duyệt full repair + race reservation; r6 ghi repair Li T1 (trim core r5 đã merge 8dcd2020f)"
title: "Li resume toolset và định tuyến EP đúng profile"
created: "2026-11-06"
project: "pi-mono-li + code-python Pi extension source"
---

# Spec: Li resume toolset và định tuyến EP đúng profile

## Context Snapshot

- **Project / module:** Li core repo `pi-mono-li` (`li/stable`) và Python repo `code-python` (`main`), nơi giữ canonical source của Pi extensions.
- **Stack / runtime:** Li/Pi TypeScript, `@earendil-works/pi-coding-agent` 1.3.0, npm workspaces, Node 22, Windows/WezTerm; Li và Pi dùng chung `~/.pi/agent` nhưng là hai runtime.
- **Related:** `SPEC-2026-10-09-ep-resume-tool-restoration-and-spawn-launch-feedback` xử lý EP worker resume; `SPEC-2026-11-03-agent-team-phoi-hop-lien-project-va-chon-skill-dong` và `SPEC-2026-11-04-parent-ep-control-va-compactx-tiep-tuc-theo-checkpoint` định nghĩa run-bound EP start/auth. Spec này không thay các grant, writer-lock hay EP-resume contract đó.
- **Current behavior:** Li tạo registry hiện tại rồi `_restoreToolsFromTranscript()` restore active set từ transcript. Registry có thể chứa built-in ngoài `defaultTools`, extension `defaultActive:false` hoặc tool bị filter. Test xác nhận transcript cũ được khôi phục, nhưng chưa có migration thêm default-active tool mới; resume vì thế có thể thiếu tool mới. `getCurrentSystemMessage()` còn làm mờ khác biệt giữa không có tool history và effective loadout rỗng nếu chỉ nhìn `toolsAdded`.
- **Current EP behavior:** `subagent_tab` mở generic child. `subagent_tab_implement_start` chỉ start task trong coordination run đã có grant và manifest (`coordinationRunId` + `taskId`). `/implement` là command riêng, có lane authorization của user. Guidance generic hiện vừa bảo dùng `subagent_tab` cho mọi delegation kể cả implement, vừa bảo parent ưu tiên `/implement` cho code cùng working tree. Trace incident cho thấy parent gọi `subagent_tab`, nên child `subagent-tab: implement · trim-spec` không phải EP.
- **Desired behavior:** Resume session cũ nhận tool default-active mới mà không tự bật tool bị explicit selection/filter chặn. Transcript cũ không luôn chứng minh lý do tool bị remove; r5 ghi rõ legacy ambiguity và dùng policy bảo thủ. Session mới lưu selection intent để không nhầm tool unavailable với explicit disable. Khi parent định mở EP, flow dùng run/task và authority hợp lệ; không gọi generic child rồi báo là EP.
- **Relevant files:**
  - Li repo: `packages/coding-agent/src/core/agent-session.ts`, `packages/agent/src/agent-loop.ts`, `packages/ai/src/utils/transcript.ts`, `packages/ai/src/types.ts`.
  - Li tests: `packages/coding-agent/test/default-tools-setting.test.ts`, `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`, `packages/ai/test/transcript-tool-changes.test.ts`, `packages/agent/test/agent-loop.test.ts`.
  - Python repo: `app_presets/pi/extensions/subagent-tab/index.ts`, `subagent-tab/implement-start.ts`, `implement-launch-plan.ts`, `implement-command.test.ts`, `implement-start.test.ts`, `peer-sessions/implement-start-auth.ts` và tests.
  - Runtime/docs: Li `packages/coding-agent/docs/extensions.md`, `docs/li-maintenance.md`; Python `app_presets/pi/extensions/subagent-tab/README.md`.
- **Existing constraints:** Giữ `tools`/`excludeTools`, `defaultActive:false`, hidden/codemode/deferred semantics, EP grant/run/task gates, writer lock, direct `/implement`, user-only `/implement-finish`. Không dùng textual prompt list làm bằng chứng active toolset; dùng `getActiveToolNames()` hoặc tool-call thực tế. Không dùng generic child để giả EP.

## Objective

- Session Li cũ sau resume có cùng **default-active toolset** như session mới, không bắt owner tạo session mới chỉ để nhận tool mới.
- Parent phân biệt generic child, user-started `/implement` EP và model-started run-bound EP; không âm thầm đổi sang generic khi EP thiếu authority.

## Scope

### In
- Li transcript/loadout migration khi resume: thêm tool từ **effective fresh-session default loadout** hiện hành; giữ lựa chọn active/inactive có bằng chứng; áp dụng `tools`/`noTools`, modifiers, `excludeTools` và exposure policy trước khi activate.
- Migration idempotent qua resume; transcript lưu selection snapshot và provider tool deltas tách biệt, có marker empty cho session mới.
- Legacy transcript chưa có selection snapshot: replay delta `toolsAdded`/`toolsRemoved` theo thứ tự; unknown state dùng effective defaults kèm notice. Session mới ghi `toolSelectionSnapshot` (names-only, có thể rỗng hoặc tạm unavailable) để phân biệt selection intent với provider delta.
- Thêm `ExecutionTask.launch_profile` (`ep_required|generic`) cho task run mới; profile EP chỉ được start bằng EP tool. Generic launcher kiểm tra task binding, active EP task cùng trusted project scope và chặn root-parent same-tree writer trước side effect.
- Sửa guidance `subagent_tab`: coordination EP chỉ qua run/task + grant; `/implement` giữ command lane; generic child không được mô tả hay báo kết quả như EP.
- Tests và disposable Li runtime smoke cho old-session resume, tool parity và ba đường spawn.

### Out
- Không nới `subagent_tab_implement_start` để nhận objective/path/grant tự khai; không bỏ user-approved grant, delegated consent, project boundary, risk, task readiness hay budget.
- Không auto-tạo grant hoặc coi “spec được duyệt” là grant. Nếu manifest/policy không cho phép thì refuse hoặc hướng owner tới `/implement`; không fallback im lặng sang generic.
- Không biến generic `subagent_tab` thành EP, không thêm `manualCompletion` vào generic child, không đổi writer-lock/finish ownership.
- Không thêm freeform authority override, workspace policy hay grant. `launch_profile` chỉ là routing metadata, không cấp quyền. Guard chặn task-bound EP khỏi generic route, unbound root-parent same-tree code writes, và generic writer trong cùng project với active EP task; ngoại lệ duy nhất là binding task `generic` riêng + worktree cô lập. Read-only generic vẫn được phép.
- Không bật `defaultActive:false`, hidden, codemode/deferred hay tool bị settings/CLI chặn chỉ để đạt “đủ tool”.
- Không sửa Pi runtime/config toàn cục hay deploy runtime; thay đổi shared types/agent packages chỉ nằm trong Li fork `pi-mono-li`. Không sửa Python product/toolkit ngoài extension source cần thiết.

## Thuật ngữ
- **Registered tool:** có trong runtime registry, chưa chắc model được gọi.
- **Active tool / loadout:** tool được khai báo cho model trong phiên; đây là cái cần so khi resume.
- **Transcript-known tool:** tên có trong lịch sử `toolsAdded`/`toolsRemoved`; đây chỉ là trạng thái đã khai báo với provider, không tự chứng minh user cố ý tắt.
- **Tool-selection snapshot:** metadata transcript-only `{version: 1, source: default|explicit, selectedNames: string[]}` ghi logical selection sau current `tools`/`noTools`/modifier resolution nhưng trước registry availability, `excludeTools`/allowlist, exposure và provider projection; names-only, gồm empty/unavailable names, được ghi cả khi rỗng và không gửi cho provider. `source=default` khi base đến từ `defaultTools` (kể cả modifier-only `+/-`); `source=explicit` khi plain `tools` replacement hoặc `noTools` quyết định base. Extension `setActiveTools` cập nhật names nhưng không đổi source.
- **Selected active set:** `AgentSession` loadout từ `getActiveToolNames()`; hook `prepareLoadout` có thể ẩn tool khỏi provider mà không làm tool inactive.
- **Provider-visible tools:** declarations còn lại sau `prepareLoadout`/request projection; không đồng nhất với registry hay selected active set.
- **Generic child:** session mở bằng `subagent_tab`, không có EP lock/baseline/manual-completion contract.
- **EP model tool:** `subagent_tab_implement_start`, chỉ chạy task manifest `launch_profile=ep_required` (hoặc task legacy theo compatibility rule) trong coordination run đã được user ủy quyền.
- **Launch profile:** `ExecutionTask.launch_profile` (`ep_required|generic`) chọn launcher, không cấp quyền; task cũ thiếu field được xử lý theo legacy semantics.
- **User EP command:** `/implement`, command riêng xem chính lệnh gọi là authorization cho đúng target, vẫn giữ confirmation/lock gate.

## Assumptions
- Candidate là effective fresh-session default set sau `defaultTools` và registration policy; không quét toàn registry. `defaultActive:false` không tự thành candidate, nhưng `+name` hoặc explicit replacement có thể yêu cầu activate nếu tool đăng ký và các gate cho phép.
- Replay `toolsAdded`/`toolsRemoved` theo active branch; remove→add là redeclaration. Delta nói provider loadout đã đổi, không nói vì user disable hay tool unavailable.
- Session mới persist `toolSelectionSnapshot` cùng tool-state update: `selectedNames` là ý định chọn trước availability/filter/exposure; vì vậy snapshot thắng provider delta nếu tool chỉ bị remove vì unavailable, còn explicit disable vắng khỏi snapshot. Snapshot rỗng có nghĩa; empty arrays trong legacy delta không phải evidence vì writer cũ có thể bỏ chúng.
- Legacy không có snapshot: delta add/remove replay ra empty thì giữ empty, không merge unknown candidates; không có delta (kể cả session cũ `noTools: all` không ghi tool event) là unknown, dùng current defaults với notice. Với legacy `toolsRemoved`, giữ trạng thái inactive vì không biết lý do; không gọi đó chắc chắn là user choice. Không thể khôi phục intent đã không được ghi.
- Current plain `tools` replacement/`noTools` override transcript theo SDK hiện tại; modifier-only `+/-` áp theo thứ tự sau base selection/migration; `excludeTools`, allowlist và exposure là veto cuối. Notice bounded trước provider request, không mở quyền/grant.
- Parent chỉ model-start EP khi có run/task và grant hợp lệ; direct `/implement` giữ semantics riêng.
- `ExecutionTask` hiện chưa có `launch_profile`; field mới là routing metadata, không phải authority. Không dùng `working_mode` làm proxy. Task mới phải ghi `ep_required|generic`; task lịch sử thiếu field giữ EP-start behavior cũ và được phân loại `legacy` cho generic guard.
- Dynamic extension registration phải được reconcile trước provider request đầu; unit test không thay cho disposable process-reopen smoke.

## Approach

- **Li loadout:** current plain `tools` replacement hoặc `noTools` đi đúng resolver hiện tại và thay transcript loadout; không chạy migration merge. Nếu không có replacement: dùng snapshot gần nhất nếu có, nếu không replay legacy deltas trên active branch. Snapshot là selection intent có thẩm quyền trước availability: selected A vẫn được khôi phục dù provider delta ghi remove vì A chưa register; explicit-disable A không có trong snapshot. `source=explicit` giữ đúng names, không merge defaults. Với `source=default`, merge current default candidates chưa từng xuất hiện trong history; riêng snapshot rỗng + tool-state delta history replay rỗng thì giữ empty, không merge unknown candidates. Snapshot `source=default` rỗng nhưng chưa có delta thì có thể nhận current defaults mới. Nếu không có snapshot/delta thì legacy state là unknown và dùng current defaults kèm notice; legacy delta replay empty vẫn giữ empty. Modifier-only `+/-` áp sau base selection theo đúng thứ tự; `excludeTools`, allowlist và exposure chặn cuối. `defaultActive:false` chỉ được bật khi explicit `+name`/replacement yêu cầu và gate còn lại cho phép.
- **Provider projection:** `prepareLoadout.hiddenDeclarations` chỉ ẩn declaration khỏi request; không đổi selection snapshot/active set và không tạo user-disable. Snapshot lưu intent names-only, còn transcript tool delta ghi provider declarations thực tế; tests kiểm riêng selection snapshot, selected-active set, provider delta và provider-visible payload.
- **Dynamic registration:** finalize sau khi extension registration/`bindExtensions` xong và trước provider request đầu. Late refresh áp cùng quyết định. Snapshot names-only có thể nhớ selected tool chưa đăng ký, nhưng không persist declaration/provider-callable entry; khi tool register lại thì apply snapshot selection. Legacy `toolsRemoved` không có snapshot vẫn giữ inactive do cause không biết. Tool `prepareLoadout` ẩn vẫn thuộc selected snapshot/active set; test provider-visible projection riêng.
- **Persistence:** thêm `toolSelectionSnapshot` names-only vào `SystemMessage`. `AgentSession` inject một metadata-only system event vào pending prompt ở request đầu và mỗi lần selection đổi, trước `agent.prompt`; provider transform loại field này trước khi gửi. `agent-loop` đang giữ `...rest` khi thay tool deltas nên phải preserve marker qua delta update (thêm regression test, không sửa shared loop nếu chưa cần). Snapshot ghi intent trước registry availability/filter/exposure; `toolsAdded`/`toolsRemoved` vẫn mô tả provider declarations thực tế. Transcript replay đọc snapshot riêng. Legacy không có snapshot thì dùng policy unknown phía trên. Snapshot và delta phải được append trước provider request.
- **EP routing:** thêm `ExecutionTask.launch_profile: ep_required|generic` cho task mới; field là routing intent, không phải permission. `peer_coordination_task_create` ghi profile tường minh. `subagent_tab_implement_start` chỉ nhận `ep_required`, giữ toàn bộ grant/run/task/owner/scope/risk/budget gate hiện tại; `generic` bị refuse. Run cũ thiếu field được đọc là `legacy` và giữ EP-start behavior hiện hành để không phá compatibility. Không sửa `working_mode`, consent hay capability.
- **Generic writer guard:** `subagent_tab` nhận optional `coordinationRunId`/`taskId`; binding tới task `ep_required` bị refuse trước side effect. Với code writer, resolve trusted project identity từ `ctx.cwd` rồi tìm active runs của caller: nếu cùng project có task `ep_required` ở `ready|dispatching|running`, generic writer bị refuse dù `worktree` bật, trừ binding tới task `generic` riêng + worktree cô lập. Project/run mơ hồ thì fail closed. Root-parent same-tree writer (`worktree=false`) luôn bị refuse kể cả không có binding. Read-only generic giữ nguyên; generic isolated child không được báo hoặc hoàn tất như EP.
- **Refusal:** EP task thiếu run/grant/task/authority giữ `ready`, không tạo pane/lock/artifact; parent báo lý do và hướng owner dùng coordination request theo policy hoặc gọi `/implement`. Generic binding tới task EP bị refuse; unbound same-tree writer bị hard-block. Active EP task cùng project chặn generic code writer nếu không bind task `generic` riêng + worktree. Generic read-only vẫn độc lập; generic isolated child không được báo hoặc hoàn tất như EP.
- **Guidance:** định nghĩa routing matrix tường minh, gỡ mâu thuẫn trong `subagent_tab` promptGuidelines. Không gọi result là EP khi `manualCompletion`/binding không bật.
- **Integration:** Li core xử lý restore/migration; Python repo sửa routing guidance và smoke. Không đổi consent policy. Verify Li trước, extension suite sau, cuối cùng disposable process-reopen smoke.

## Diagram

```mermaid
flowchart TD
    A[Resume old session] --> B[Read selection snapshot + active-branch deltas]
    B --> C{Snapshot present?}
    C -->|Yes| D[Restore selected intent]
    C -->|No| E{Legacy deltas?}
    E -->|No| F[Unknown legacy: current defaults + notice]
    E -->|Yes, replay empty| G[Preserve empty; do not merge]
    E -->|Yes, non-empty| H[Keep recorded state + merge unknown defaults]
    D --> I[Apply current overrides and final filters]
    F --> I
    G --> I
    H --> I
    I --> J[Persist snapshot and provider delta]
    J --> K{Launch profile}
    K -->|ep_required + grant| L[subagent_tab_implement_start]
    K -->|generic read-only| M[subagent_tab generic]
    K -->|generic code + worktree, guard passes| N[Isolated generic child]
    K -->|same-tree writer or EP mismatch| O[Refuse before side effects]
    K -->|User command| P[/implement]
    L --> Q[EP lock, baseline, binding]
    P --> Q
```

## Bỏ qua
- Không union toàn bộ tool registry vào transcript: registered không đồng nghĩa default-active hay model-callable.
- Không xóa/rewrite snapshot và delta lịch sử: snapshot giữ selection intent, delta giữ timeline provider declarations; đừng suy user intent chỉ từ delta legacy.
- Không dùng `/reload` như workaround duy nhất; restart/resume vẫn phải tự reconcile đúng.
- Không tự đổi policy/consent để “cho EP chạy cho tiện”.

## Risks
- Legacy transcript có thể không ghi `noTools: all` rỗng, hoặc không phân biệt removal do user với tool unavailable; chỉ snapshot mới gỡ được mơ hồ này. Legacy unknown dùng current defaults + notice; legacy recorded removal giữ off bảo thủ, dù có thể giữ off một tool từng unavailable.
- Merge tool sai có thể bật code execution mà owner đã tắt; test bắt buộc có `toolsRemoved`, `defaultActive:false`, `tools` allowlist, `excludeTools` và hidden exposure.
- Tool có thể registered, selected-active nhưng bị `prepareLoadout` ẩn khỏi provider; không nhầm ba trạng thái đó. Verify đọc registry, `getActiveToolNames()`, transcript delta và provider-visible payload riêng, không grep system-prompt prose.
- EP tool không phải general `/implement`: thiếu run/task/grant phải refuse trước mọi route/lock/artifact/pane. Generic fallback có thể làm worker không có lock/manual finish.
- Li và Python là hai Git repo; source update một bên không chứng minh runtime/extension parity bên kia.

## Task List

### Task 1: Resume Li session với tool migration an toàn
- **id:** T1
- **depends_on:** []
- **risk:** T3
- **Acceptance:**
  - Candidate là effective current default set sau `defaultTools`/settings modifiers; không bật toàn registry. `defaultActive:false` không tự thành candidate, nhưng explicit `+name`/plain replacement có thể chọn tool đã register nếu allowlist/exposure cho phép.
  - New transcript ghi `toolSelectionSnapshot` (versioned, source default|explicit theo thuật ngữ; `setActiveTools` chỉ đổi names) ở first request và mỗi tool-state update, kể cả selected set rỗng; names snapshot giữ intent khi tool tạm unavailable, nhưng không chứa declaration/provider payload. Hidden `prepareLoadout` không làm mất snapshot selection.
  - Legacy không snapshot: replay toàn bộ deltas theo thứ tự; add/remove replay ra empty thì giữ empty, không merge unknown candidates; không có delta (kể cả legacy `noTools: all` rỗng) là unknown, dùng current defaults với notice. Legacy `toolsRemoved` giữ inactive nhưng cause vẫn unknown; không tuyên bố đó là user-disable.
  - Current plain `tools` replacement/`noTools` override transcript theo SDK behavior. Modifier-only `+/-` áp tuần tự sau base replay/migration; `excludeTools`, allowlist và exposure là veto cuối. `+name` có thể chọn `defaultActive:false`; `defaultActive:false` không tự bật. Redeclaration theo thứ tự delta.
  - Tool được chọn nhưng chưa register không xuất hiện trong provider active set; selection snapshot names-only vẫn giữ ý định để tool được restore khi đăng ký lại. `prepareLoadout.hiddenDeclarations` chỉ tác động provider-visible set, không đổi selected/snapshot set.
  - Snapshot + provider delta được append trước provider request, kể cả khi selected set empty; resume lặp idempotent. Nếu crash trước persist, lần sau được retry cùng candidate set. Notice bounded trước request đầu, phân biệt “unknown legacy” với tool chắc chắn newly added.
  - Fresh session không đổi; explicit empty loadout và session không có tool-state history có behavior khác nhau.
- **Reproduce:** từ `packages/agent`, `node ..\..\node_modules\vitest\dist\cli.js --run test/agent-loop.test.ts`; từ `packages/coding-agent`, `node ..\..\node_modules\vitest\dist\cli.js --run test/default-tools-setting.test.ts test/agent-session-dynamic-tools.test.ts test/suite/agent-session-mcp.test.ts`.
- **Verify:** test real first request `noTools: all` tạo snapshot rỗng rồi reopen không truyền flag vẫn rỗng; test legacy no-delta không thể phân biệt `noTools: all`, nên dùng current defaults + notice. Test add→remove replay rỗng (cả legacy và snapshot-backed) + current `new_tool` giữ empty; `+new_tool` vẫn áp sau base. Test default-source snapshot rỗng không có delta nhận current default candidate mới. Test selected tool A unavailable ở một request rồi đăng ký lại: snapshot giữ intent và A active lại; explicit disable A không restore. Cover replacement `tools`, `noTools: builtin|all`, modifier order, `excludeTools`, allowlist, `defaultActive:false` + explicit `+name`, declaration redefine, late registration, hidden `prepareLoadout`, idempotent reopen. Assert riêng selected snapshot, registry/active set, transcript delta và provider-visible payload; snapshot metadata không leak tới provider.
- **Files:**
  - `packages/coding-agent/src/core/agent-session.ts` — restore policy, maintain selected intent before availability filters, inject snapshot event, strip metadata from provider projection.
  - `packages/ai/src/types.ts` + `packages/ai/src/utils/transcript.ts` — type/replay transcript-only snapshot; current replay helpers are the reference.
  - `packages/agent/src/agent-loop.ts` + `packages/agent/test/agent-loop.test.ts` — reference for `declareToolChanges()`/`...rest`; regression test that metadata survives tool delta without making shared loop Li-specific.
  - `packages/coding-agent/test/default-tools-setting.test.ts`, `agent-session-dynamic-tools.test.ts`; `packages/ai/test/transcript-tool-changes.test.ts` — precedence, unavailable-vs-disabled, empty marker and provider non-leak tests.

### Task 2: Tách rõ generic delegation khỏi EP routing
- **id:** T2
- **depends_on:** []
- **risk:** T3
- **Acceptance:**
  - Routing matrix rõ: read-only/review/summary hoặc intent generic → `subagent_tab` và báo generic; user gọi `/implement` → command lane; model EP → task manifest `launch_profile=ep_required` + active grant/run/task dùng `subagent_tab_implement_start`; thiếu authority thì xin grant theo policy hoặc báo owner gọi `/implement`.
  - `ExecutionTask.launch_profile` là `ep_required|generic`, bắt buộc khi tạo task mới và là dữ liệu persisted do task-create ghi; run/task cũ thiếu field được normalize thành `legacy`. Profile chỉ chọn route, không thay grant/consent/scope và không do generic launch tự khai.
  - `subagent_tab_implement_start` từ chối task profile `generic`; `ep_required` và legacy task đi tiếp qua authority gates hiện có. `subagent_tab` generic nhận optional `coordinationRunId` + `taskId`; binding tới `ep_required` bị refuse trước side effect, binding tới `generic` không tự cấp `manualCompletion`.
  - Root-parent generic write/refactor same-tree (`worktree=false`) bị refuse trước route/lock/artifact/pane bằng existing writer-intent classifier. Nếu cùng project có active task `ep_required`, mọi generic writer không binding bị refuse dù `worktree=false/true`; chỉ task `generic` riêng, có binding và worktree cô lập mới chạy. Project identity mơ hồ thì fail closed; read-only generic vẫn chạy.
  - Gỡ chỉ dẫn mâu thuẫn “dùng generic cho mọi delegation kể cả implement” / “ưu tiên /implement”. Direct `/implement`/no-args giữ nguyên command lane, confirmation, lock và finish ownership.
  - EP refusal giữ task `ready`, không có side effect; response nêu lý do + recovery. Generic writer guard resolve project từ trusted `ctx.cwd`, tìm active EP tasks của caller; project/run mơ hồ thì fail closed. Read-only generic không bị chặn; code generic cùng project với task EP chỉ chạy nếu bind task profile `generic` riêng và worktree cô lập.
- **Reproduce:** tại Python repo root chạy hai lệnh: (1) trong `app_presets/pi/extensions/peer-sessions`, `node --experimental-strip-types --test execution-run.test.ts execution-store.test.ts implement-start-auth.test.ts implement-start-claim.test.ts execution-launch-profile.test.ts`; (2) trong `app_presets/pi/extensions/subagent-tab`, `node --experimental-strip-types --test generic-launch-profile.test.ts implement-start.test.ts implement-command.test.ts writer-lock.test.ts`.
- **Verify:** test task profile mới/legacy, EP tool refuse task generic, generic binding tới EP task, same-tree writer bị chặn, read-only generic và generic profile + worktree. Khi parent có active `ep_required` task cùng project, generic writer không binding phải bị chặn dù `worktree=false/true`; binding task `generic` + worktree được phép nhưng không có EP `manualCompletion`/task completion. Project identity mơ hồ fail closed. Deterministic fake-provider trace kiểm routing flow; runtime tests kiểm marker/profile gate. No-args/direct `/implement` không regression.
- **Files:**
  - Python repo `app_presets/pi/extensions/peer-sessions/{types.ts,execution.ts,execution-store.ts,index.ts,project-identity.ts}` — `launch_profile`, legacy normalization, task-create validation, active-run lookup và trusted cwd→project identity.
  - Python repo `app_presets/pi/extensions/subagent-tab/index.ts` — generic writer gate/binding, `subagent_tab_implement_start` profile validation và prompt routing.
  - Python repo `app_presets/pi/extensions/subagent-tab/{implement-start.ts,implement-launch-plan.ts,README.md}` và `peer-sessions/implement-start-auth.ts` — reuse launcher/auth; không nới policy.
  - Python tests `peer-sessions/{execution-run.test.ts,execution-store.test.ts,implement-start-auth.test.ts,implement-start-claim.test.ts,execution-launch-profile.test.ts (new)}`, `subagent-tab/{generic-launch-profile.test.ts (new),implement-start.test.ts,implement-command.test.ts,writer-lock.test.ts}` — compatibility, project-scope guard, refusal trước side effect và regressions.

### Task 3: Li + extension integration và old-session runtime smoke
- **id:** T3
- **depends_on:** [T1, T2]
- **risk:** T3
- **Acceptance:**
  - Disposable Li child process đặt `USERPROFILE`/`HOME`, `TEMP`/`TMP`, `LI_CODING_AGENT_DIR`, `LI_CODING_AGENT_SESSION_DIR`, `PI_PEER_SESSIONS_ROOT`, `PI_GLM_CAPACITY_STATE_ROOT` và `SUPER_PARENT_DIR` dưới cùng `$tempRoot`; clear inherited `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`, không dựa vào alias. Assert `os.homedir()`, `os.tmpdir()` và Li config/session dirs đều nằm dưới temp. `PI_MODEL_ROUTER_TOOLKIT` dùng local fake responder; không gọi ProDesk/authority thật. `ctx.cwd` là disposable Git repo dưới `$tempRoot`, không phải Li/Python workspace.
  - Pin Li source `HEAD` + candidate build receipt; pin Python extension source `HEAD` và manifest mọi dirty/untracked file được dùng. Stage chính xác transitive relative-import closure của `subagent-tab`, `peer-sessions` và dependencies, giữ nguyên layout; explicit-load đúng entrypoints, không autoload extension ngoài candidate. SHA-256 từng source/staged relative file khớp. Fake provider/coordinator và WezTerm shim không gọi mạng, không dùng credentials, không tạo pane thật. Trước launch, assert mọi session/agent/state/lock/artifact/cwd path nằm dưới `$tempRoot`; `finally` chỉ dọn `$tempRoot` đã capture, không dựng lại đường dọn từ env.
  - So sánh toàn bộ `getActiveToolNames()` của fresh và resumed session với cùng candidate/runtime config; explicit-disable fixture vẫn giữ tắt. Smoke tạo session thật `noTools: all` → first prompt → reopen không có flag, snapshot rỗng vẫn giữ rỗng; legacy no-delta case được report là unknown/default migration. Seed tool selected nhưng unavailable một request rồi register lại; selection snapshot phải khôi phục nó mà transcript/provider không gửi declaration khi unavailable. EP-profile thiếu grant refuse không side effect; task `launch_profile=ep_required` có grant mở đúng `manualCompletion`/writer-lock/baseline. Khi EP task active cùng project, generic writer không được mở; task generic riêng + worktree vẫn là generic, không bind/complete EP.
  - Test dynamic registration muộn, explicit disable và repeated resume; không dùng transcript/user session thật hoặc mở cùng JSONL ở Pi và Li.
- **Reproduce:** từ Python repo root, `powershell -NoProfile -File tests/super-parent/resume-tool-loadout-smoke.ps1 -LiRepo ..\pi-mono-li -ExtensionSource app_presets\pi\extensions`.
- **Verify:** child process chứng minh `os.homedir()`, `os.tmpdir()`, Li agent/session dirs, peer/GLM/Super roots, extension registry, lock/artifact, tool temp files và `ctx.cwd` đều dưới `$tempRoot`; `PI_MODEL_ROUTER_TOOLKIT` gọi fake responder; WezTerm shim được gọi, không mở pane thật. So sánh registered catalog, selection snapshot, selected active set, transcript declarations và provider-visible projection; xác nhận snapshot metadata không leak vào request. Seed EP-required task cùng project: generic writer unbound bị từ chối cả worktree=true; task generic bound + worktree được phép nhưng không có EP binding. Ghi Li build receipt/source SHA, Python HEAD + dirty/untracked file manifest và staged SHA. Dọn đúng captured `$tempRoot` trong `finally`.
- **Files:**
  - Li `packages/coding-agent/test/default-tools-setting.test.ts` — fixture loadout cũ/mới; không dùng auth hoặc session user thật.
  - Python `tests/super-parent/resume-tool-loadout-smoke.ps1` (mới) — build/launch Li candidate với temp home/agent/session/peer/GLM state roots, disposable Git cwd, stage đúng extension dependency closure, fake provider/coordinator/WezTerm, explicit Li extension entrypoints, per-file source/stage SHA-256 manifest và cleanup đúng captured `$tempRoot`.
  - Li `docs/li-maintenance.md` — chỉ cập nhật migration/verification note sau khi behavior chốt.

## Checkpoints
- **C1:** Transcript history helper + resume migration tests PASS; old explicit removal còn tắt, new default tool được thêm.
- **C2:** EP routing guidance và model-tool gates không mâu thuẫn; no-grant refusal không tạo side effect.
- **C3:** Fresh vs resumed disposable Li process có toolset đúng; run-bound EP profile khác generic child như acceptance.
- **C4:** Li package check + targeted tests, extension tests/TSC và runtime parity/smoke PASS.

## External Review Brief

### Reviewer cần phán
- `toolSelectionSnapshot` có đúng semantics `source` + names-only selected intent, được persist cả khi rỗng, không leak provider payload, và có phân biệt unavailable-vs-disabled cho session mới không?
- Legacy no-delta (kể cả `noTools: all` ban đầu) có được gọi đúng là unknown; empty sau add/remove có giữ rỗng; `toolsRemoved` legacy có được giữ bảo thủ mà không bịa user intent không?
- Thuật toán precedence có khớp SDK: current plain `tools`/`noTools` replacement, default-mode merge, modifier order, `excludeTools`/allowlist/exposure final veto, explicit `+name` cho `defaultActive:false` không? Li core có preserve Pi/Li profile và dynamic registration order không?
- `launch_profile` có nằm đúng trong run/task record, legacy missing có compatibility rõ, và field không bị coi là authorization không?
- Generic writer guard có tìm đúng active EP task theo caller + trusted project identity, từ chối khi binding thiếu/mismatch, fail closed khi project identity ambiguous, và không block read-only/isolated generic hợp lệ không?
- Có race giữa generic writer preflight và EP reservation/task create không? Cần lock/CAS nào để guard không chỉ check-then-spawn?
- Guidance có định tuyến đúng giữa generic `subagent_tab`, direct `/implement`, và run-bound model EP tool không? Có đường nào đổi profile hoặc fallback lách guard không?
- Test có kiểm registry, selection snapshot, selected active set, provider delta và provider-visible set riêng không? Có cover real `noTools:all` empty snapshot, legacy no-delta notice, add/remove empty, unavailable→register, explicit disable, precedence, hidden projection, legacy/generic/EP profiles và thiếu/valid manifest không?
- Có conflict với EP resume spec/parent coordination default/run grant contract không?

### Reviewer nên đọc trước
- Spec này.
- Li: `agent-session.ts`, `transcript.ts`, `default-tools-setting.test.ts`, `agent-session-dynamic-tools.test.ts`, `extensions.md` phần Tool exposure/Dynamic loading.
- Python: `subagent-tab/index.ts` quanh `subagent_tab`/`subagent_tab_implement_start`/`/implement`, `implement-start.ts`, `implement-start-auth.ts`, tests tương ứng.
- `SPEC-2026-10-09-ep-resume-tool-restoration-and-spawn-launch-feedback` và `SPEC-2026-11-04-parent-ep-control-va-compactx-tiep-tuc-theo-checkpoint` — chỉ đọc contract; không sửa archive.

### Reviewer không cần phán
- Thiết kế lại EP auth/grant, direct `/implement` UX hoặc writer lock.
- Các provider/model catalog ngoài khả năng dispatch của Terra/Luna.
- Thay đổi Li release pipeline ngoài việc xác nhận verify gate.

## r6 repair — findings sau review r5 (owner-approved, chỉ Li T1)

Ba reviewer độc lập (Terra/Luna/GLM) verdict NEEDS REVISION. Python T2/T3 và trim core r5 được xử lý theo workstream riêng; phần này chỉ Li T1 trên HEAD `8dcd2020f`:

1. **C1 (P1) Compaction carry-through:** `appendCompaction` replay `getCurrentSystemMessage` mất `toolSelectionSnapshot` và toàn bộ `toolsRemoved` history, còn `buildContextEntries` drop mọi system entry cũ trong kept range → compact→close→resume có thể `legacy_unknown`, merge lại defaults, resurrect tool đã remove và mất selected-unavailable intent. Fix: checkpoint systemMessage của CompactionEntry phải gắn `toolSelectionSnapshot` mới nhất (nếu có) và `toolsRemoved` gộp từ vùng bị summarize (lọc bỏ tool đang active), giữ đúng precedence r5 (empty snapshot không delta vẫn là default mode).
2. **C2 (P2) Handler-edited selectedTools là replacement:** `_prepareRun` khi `handlerEditedTools=true` chỉ union qua `_applyToolLoadout` → tool bị handler drop vẫn còn trong `_selectedToolNames` và sống lại qua resume. Fix: replacement intent — reset selection trước apply.
3. **C3 (P2) Empty-active heuristic:** `setActiveToolsByName` dùng `previousActive.every` — mảng rỗng là vacuous true → selected-unavailable bị union dù caller replacement. Fix: preserve chỉ khi previousActive non-empty và là superset; replacement drop selected-unavailable.
4. **C4 (P2) Branch navigation modifiers:** nhánh tree navigation gọi `_restoreToolsFromTranscript()` không modifiers → mất `+x/-x`. Fix: truyền `this._defaultToolModifiers` như constructor.
5. **C5 (P2) Late-registration cutoff parity:** fresh set cutoff tại prompt đầu; resumed phải cùng semantics qua instance mới. Kiểm chứng và sửa lệch nếu có; regression test register muộn ở cả hai đường.
6. **C6 (L6) Migration notice count-only:** UI notify hiện liệt kê từng tên (30+ trên session thật). Fix: UI text chỉ đếm (`N tools`, hướng xem session entry); custom entry `tool_selection_notice` giữ nguyên tên đầy đủ + `truncated` để audit.

Acceptance r6: mỗi fix có regression test trên cùng test file hiện có; compact→close→resume không legacy_unknown, không resurrect, giữ unavailable intent; handler drop tool không sống lại sau resume; branch switch giữ modifiers; UI notify không liệt kê wall-of-names. Verify: targeted `vitest` default-tools + dynamic-tools + transcript-tool-changes + agent-loop tests, `npx tsc --noEmit` các package đụng, `git diff --check`.

## User Test

| Hành động | Kết quả kỳ vọng | Chuẩn đối chiếu |
|---|---|---|
| Mở lại một Li session cũ sau khi extension/tool mới đã deploy | Tool default-active mới có thể được gọi trong chính session cũ | Migration notice liệt kê tool mới; legacy `toolsRemoved` vẫn inactive nhưng cause được báo là unknown |
| Mở session mới với `noTools: all`, gửi prompt rồi resume không truyền flag | Toolset tiếp tục rỗng | Snapshot explicit-empty được lưu trên transcript |
| Resume legacy session không có tool delta, kể cả từng chạy `noTools: all` rỗng | Dùng current defaults và báo trạng thái legacy unknown | Không giả vờ transcript chứng minh lựa chọn cũ |
| Resume lại session đó thêm lần nữa | Không thêm/trùng tool hoặc báo migration lần hai | Active toolset giữ nguyên sau lần migration đầu |
| Extension tool đang được chọn tạm không register rồi có lại ở lần mở sau | Tool được chọn xuất hiện lại; tool explicit-disable vẫn off | Selection snapshot nhớ intent, không nhầm unavailable thành disable |
| Gọi EP model tool khi không có grant/run/task/profile hợp lệ | Bị từ chối, không mở pane/lock/artifact; task không chuyển khỏi `ready` | Kết quả nêu đúng thiếu authority/run/task/profile |
| Run có task `ep_required` đang active; thử generic writer cùng project dù thiếu binding hoặc bật worktree | Bị chặn trước side effect; read-only generic vẫn được dùng | Có refusal rõ; không có pane/lock/artifact; task EP còn nguyên trạng |
| Tạo task `generic` riêng rồi gọi generic code child với worktree | Mở isolated generic child, không phải EP và không hoàn tất task EP | Run/task profile là `generic`; không có `manualCompletion` hoặc EP binding |
| Tạo run/task/grant hợp lệ rồi parent gọi EP | Child là EP đúng profile, không phải generic child | Có `manualCompletion`, writer lock và Git baseline; title/notify gọi đúng EP |
| Gọi generic scout/read-only qua `subagent_tab` | Vẫn mở generic child | Không có EP finish gate/lock profile; result gọi đúng generic child |
| Gọi trực tiếp `/implement` như hiện tại | Hành vi command và confirmation hiện tại không đổi | User authorization vẫn giới hạn đúng candidate/objective |

## Completion Gates
- Li targeted tests/TSC chứng minh fresh-default parity; snapshot metadata rỗng/default/explicit; legacy unknown/no-delta notice; add-remove empty; unavailable-vs-explicit-disable; replacement/modifier/filter precedence; `defaultActive:false`; late registration; hidden provider projection non-leak và repeated resume.
- Extension tests/TSC chứng minh `launch_profile` persistence/legacy behavior, EP-vs-generic gates, same-tree refusal, active-EP-project writer refusal dù worktree bật, generic bound-worktree separation, ambiguous identity fail-closed, authority refusal, routing trace và direct `/implement` non-regression.
- Disposable Li process-reopen smoke nạp extension stage từ Python source trong temp profile, đối chiếu per-file source/stage SHA-256, và xác nhận riêng selection snapshot, selected active, provider delta, provider-visible tools cùng EP manualCompletion profile; empty snapshot thật, unavailable re-registration và metadata non-leak được kiểm; prompt-text grep đơn thuần không tính evidence.
- `npm run check` + targeted test commands theo `docs/li-maintenance.md`; không chạy full `npm test` nếu user chưa yêu cầu.
- `git diff --check`, candidate source/stage parity và `/verify` PASS trước khi archive/ship. Smoke không ghi runtime thật; deploy Li/Python source là gate riêng sau implementation approval. Chưa có implementation/deploy trong scope của spec draft này.
