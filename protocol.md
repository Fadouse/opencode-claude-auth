# Claude Code 2.1.87 Protocol Notes

This document is the canonical repo-local summary of what is currently known about Claude Code 2.1.87 request shaping, prompt packaging, metadata shaping, telemetry transport, and unresolved boundaries.

It is intentionally evidence-scoped:

- **Highest-priority evidence**: real official packet captures
- **Second priority**: recovered local Bun/ELF code paths from the official client
- **Third priority**: current repo implementation and passing tests
- **Fourth priority**: official/public SDK or docs references
- **Not accepted as proof**: guesses, imitations, or public reverse-engineering claims not verified locally

This file supersedes ad-hoc conclusions scattered across earlier notes. `protocl.md` remains the detailed reverse-engineering notebook; this file is the cleaned protocol reference.

---

## 1. Evidence hierarchy

### 1.1 Strongest local evidence

1. Real official request packet captures supplied during this session
2. Real official telemetry packet capture supplied during this session
3. Local official client binary at:
   - `/home/fadouse/.local/share/claude/versions/2.1.87`
4. Preserved Bun payload snapshot in this repo:
   - `claude-2.1.87.bun`
5. Local reverse-engineering notebook:
   - `protocl.md`

### 1.2 Current implementation anchors

- Request path: `src/index.ts`, `src/transforms.ts`
- Telemetry path: `src/telemetry.ts`
- Local identity/account sources: `src/keychain.ts`, `src/credentials.ts`
- Verification: `src/index.test.ts`, `src/transforms.test.ts`, `src/telemetry.test.ts`

### 1.3 Evidence boundary

This document records:

- recovered algorithms that are directly supported by local evidence
- packet-proven request and telemetry structure
- known mismatches between the repo and official captures
- unresolved areas that must **not** be guessed

### 1.4 How to read claims in this file

- **Packet-proven** means directly shown by a real official Claude Code request or telemetry capture.
- **Recovered** means supported by local Bun/ELF reverse engineering or other local official-client artifacts.
- **Implemented** means current repo code and tests match the stated behavior.
- **Official-public support** means Anthropic SDK/docs publicly support the mechanism or header family, even if they do not document Claude Code’s exact packet shape.
- **Unresolved** means current evidence is insufficient and the repo should stay conservative.

---

## 2. Request transport behavior

## 2.1 Official request headers currently proven by packet capture

The strongest current official request capture shows these request-layer facts for `POST /v1/messages?beta=true`:

- `User-Agent: claude-cli/2.1.87 (external, cli)`
- `X-Claude-Code-Session-Id: <uuid>`
- `x-app: cli`
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`
- `X-Stainless-Arch: x64`
- `X-Stainless-Lang: js`
- `X-Stainless-OS: Linux`
- `X-Stainless-Package-Version: 0.74.0`
- `X-Stainless-Retry-Count: 0`
- `X-Stainless-Runtime: node`
- `X-Stainless-Runtime-Version: v24.3.0`
- `X-Stainless-Timeout: 600`
- `x-client-request-id: <uuid>`
- `Authorization: Bearer ...`
- no visible real HTTP `x-anthropic-billing-header`

### 2.2 Current repo implementation

Current request header behavior lives in `src/index.ts`:

- `getUserAgent()` returns `claude-cli/2.1.87 (external, cli)`
- `buildRequestHeaders(...)` sets:
  - `authorization`
  - merged `anthropic-beta`
  - `x-app: cli`
  - `user-agent`
  - `X-Claude-Code-Session-Id`
  - packet-proven `anthropic-version`
  - packet-proven `anthropic-dangerous-direct-browser-access`
  - packet-proven `X-Stainless-*`
  - packet-proven `x-client-request-id`
- `buildRequestHeaders(...)` intentionally does **not** set a live HTTP `x-anthropic-billing-header`

### 2.3 Local Bun evidence for transport split

Recovered `py(...)` path from the official client supports this separation:

- body/system shaping occurs in Claude-side builders like `W6H`, `TG$`, `ZG$`, `OM9`, `YM9`
- transport/default headers/auth/proxy happen in `py`, `M34`, `w34`, `j34`, `a1H`, and lower Anthropic SDK layers

Recovered `py(...)` specifically supports:

- `x-app: cli`
- `User-Agent: cS()`
- `X-Claude-Code-Session-Id: V$()`

Recovered visible Bun paths do **not** show explicit HTTP-header insertion for `x-anthropic-billing-header`.

### 2.4 Official-public support for request headers

Official/public Anthropic SDK references strongly support the following request-header mechanisms, even when Claude Code’s exact packet fingerprint still comes primarily from capture:

- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true` when browser/direct-browser mode is enabled
- `User-Agent`
- `X-Stainless-Retry-Count`
- `X-Stainless-Timeout`
- broader `X-Stainless-*` platform/runtime header family

Important boundary:

- The **existence** of the Stainless header family is officially/publicly supported.
- The **exact Claude Code values** in the packet (for example package version, runtime version, OS tokenization, and the presence of `x-client-request-id`) are still primarily packet-proven rather than fully documented by Anthropic as Claude Code requirements.

---

## 3. Prompt marker and billing-like system block

## 3.1 Recovered marker algorithm

Recovered from the local Bun/ELF path and already implemented in `src/transforms.ts`.

Algorithm:

```text
text = first_user_message_text
chars = [text[4] || "0", text[7] || "0", text[20] || "0"].join("")
seed = "59cf53e54c78" + chars + cliVersion
marker = sha256(seed).digest("hex").slice(0, 3)
```

Important properties:

- depends on the **first user message text**
- depends on constant seed prefix `59cf53e54c78`
- depends on client version string
- yields a 3-hex-character marker suffix

Repo implementation anchor:

- `src/transforms.ts:getPromptMarker(...)`

## 3.2 Recovered billing-like text builder

Recovered visible builder family:

```text
x-anthropic-billing-header: cc_version=<cliVersion>.<marker>; cc_entrypoint=<entrypoint>; cch=<value>; [cc_workload]
```

Current repo implementation anchor:

- `src/transforms.ts:buildBillingHeaderValue(...)`
- `src/transforms.ts:buildBillingSystemText(...)`

Current repo behavior:

- `cc_entrypoint=cli`
- `cch=00000`

## 3.3 Placement of billing-like text

Strongest local evidence still says:

- the billing-like text is inserted via the **top-level request body `system` path**
- visible recovered Bun code does **not** prove a real outgoing HTTP `x-anthropic-billing-header` request header in the same path
- the latest real official request capture also showed **no visible HTTP billing header**, while billing-like text remained in `system`

This is the current best-supported placement model:

- **system insertion**: high confidence
- **real HTTP header emission**: not proven in the visible path

---

## 4. Request body metadata: `W6H()` / `metadata.user_id`

## 4.1 Recovered official builder

Recovered official builder family, recorded in `protocl.md`:

```js
function W6H() {
  let extra = {},
    raw = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (raw) {
    let parsed = E_(raw, false)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      extra = parsed
  }
  return {
    user_id: gH({
      ...extra,
      device_id: $S(),
      account_uuid: h9()?.accountUuid ?? "",
      session_id: V$(),
    }),
  }
}
```

## 4.2 High-confidence meaning

`metadata.user_id` is **not** a plain scalar user id.

It is a JSON-stringified core bundle:

```json
{
  "device_id": "...",
  "account_uuid": "...",
  "session_id": "..."
}
```

with parseable `CLAUDE_CODE_EXTRA_METADATA` merged into the same object before stringification.

## 4.3 Field sources

### `device_id`

Strongest current evidence:

- official `$S()` returns persisted local `userID` when present
- else generates a new 32-byte random hex string and persists it

Therefore the current best-supported mapping is:

- local persisted Claude `userID` is the strongest current candidate source for request/telemetry `device_id`

### `account_uuid`

Current best evidence:

- comes from current authenticated Claude account state (`h9()?.accountUuid`)
- repo supplies this via `ClaudeCredentials.accountUuid`

### `session_id`

Current best evidence:

- comes from runtime session getter `V$()`
- same session value also surfaces in `X-Claude-Code-Session-Id`
- same session family also appears in telemetry `event_data.session_id`

## 4.4 Current repo implementation

Current repo implementation anchor:

- `src/transforms.ts:transformBody(...)`

Current behavior:

- builds `metadata.user_id = JSON.stringify({ ...extraMetadata, device_id, account_uuid, session_id })`
- uses active account identity from `src/keychain.ts` / `src/credentials.ts`
- uses session identity from `src/telemetry.ts:resolveSessionId(...)`

---

## 5. System prompt packaging

## 5.1 What is strongly supported

Recovered Bun evidence and packet evidence together support this **structural** ordering model:

1. billing/attribution text block from `TG$(...)`
2. base identity/system prompt block(s) from `ZG$(...)`
3. other system blocks after those

`protocl.md` records this as:

```js
let billingText = TG$(marker)
let system = [
  billingText ? { type: "text", text: billingText } : null,
  ...basePromptBlocksFromZG$(...),
  ...otherSystemBlocks,
].filter(Boolean)
```

## 5.2 What the latest official request capture proved

At least one small official request variant had **three** visible system blocks:

1. billing block
2. identity block: `You are Claude Code, Anthropic's official CLI for Claude.`
3. task-specific title-generation block

This is stronger than earlier repo assumptions and proves that the official client can use **split identity + task-specific blocks**, not a single large combined prompt block.

## 5.3 Current repo behavior

Current repo implementation anchors:

- `src/transforms.ts:ensureOfficialPromptStrings(...)`
- `src/transforms.ts:ensureOfficialPromptSystemEntry(...)`
- `src/index.ts:experimental.chat.system.transform`

Current repo behavior is only a **structural approximation**:

- injects billing block first
- then injects prompt identity/body derived from `src/anthropic-prompt.txt`
- then keeps existing system content after those

Current repo does **not** yet match the official packet’s prompt content exactly.

## 5.4 Known mismatch

Current `src/anthropic-prompt.txt` is **not safely claimable** as the official 2.1.87 prompt body.

Strong reasons:

- the first line is currently `You are an interactive agent that helps users with software engineering tasks...`
- the real captured small request used identity block `You are Claude Code, Anthropic's official CLI for Claude.` as the second system block
- the third captured block was request-specific title-generation text, not the repo’s static prompt-body text
- Bun evidence supports some prompt-family strings, but not byte-for-byte equivalence of the repo asset

Therefore:

- **prompt ordering**: closer than before
- **prompt body equivalence**: not proven, currently divergent

---

## 6. `cch` boundary

## 6.1 What is recovered

Recovered visible builder family still shows:

```js
cch = " cch=00000;"
```

and no visible mutation path was found in recovered visible layers:

- `py(...)`
- `M34()`
- `w34()`
- `j34()`
- `a1H()`
- lower Anthropic SDK layers

## 6.2 What is unresolved

Real captures in the wild may show nonzero `cch`, but the local visible Bun/JS path and local debug evidence bottom out at `00000`.

Current safe boundary:

- **proven visible template**: `cch=00000`
- **not proven**: that all final runtime/on-wire paths always keep `00000`
- **unresolved**: how observed nonzero `cch` values are produced

Current repo posture is intentionally conservative:

- keep `cch=00000`
- do not guess nonzero algorithm

---

## 7. Telemetry transport

## 7.1 Official telemetry packet facts proven by capture

Official telemetry capture proved:

- endpoint: `POST /api/event_logging/v2/batch`
- host: `api.anthropic.com`
- body shape: `{ "events": [ ... ] }`
- headers include:
  - `Accept: application/json, text/plain, */*`
  - `Content-Type: application/json`
  - `User-Agent: claude-code/2.1.87`
  - `anthropic-beta: oauth-2025-04-20`
  - `x-service-name: claude-code`
- `Authorization: Bearer ...`

### 7.1.1 Official-public support boundary

Anthropic public/official material gives adjacent support that Claude Code has telemetry / productivity logging and that Anthropic SDKs support standard request observability primitives, but it does **not** publicly document the exact Claude Code internal telemetry packet schema.

Strong official/public support exists for:

- Claude Code metrics / productivity logging existing as a real product feature
- Anthropic SDK default request-header behavior (`User-Agent`, `anthropic-version`, Stainless headers, browser-mode header)
- request tracing concepts like `request-id`

Not strongly publicly documented:

- `/api/event_logging/v2/batch`
- exact Claude Code telemetry request headers/body schema
- exact `ClaudeCodeInternalEvent` field contract
- exact event-name catalog / timing semantics

So for telemetry transport, the current hierarchy is:

- endpoint/body/header details in this section are **packet-proven first**
- public docs/SDKs only provide adjacent support, not full protocol specification

## 7.2 Current repo implementation

Current repo telemetry anchors:

- `src/telemetry.ts:getTelemetryConfig()`
- `src/telemetry.ts:resolveTelemetryHeaders(...)`
- `src/telemetry.ts:sendTelemetryBatch(...)`
- `src/telemetry.ts:sendEventsInBatches(...)`

Current behavior matches the packet on directly proven points:

- `/api/event_logging/v2/batch`
- top-level `{ events }` JSON batch body
- `User-Agent: claude-code/2.1.87`
- `anthropic-beta: oauth-2025-04-20`
- `x-service-name: claude-code`
- optional auth bearer

## 7.3 Current retry / batching behavior

Current repo implements first-party-style approximations for:

- newline-delimited failed-event spool files
- batch slicing by `maxBatchSize`
- retrying prior failed batches
- retrying a batch without auth on HTTP 401
- delayed flush scheduling and spool fallback

Implementation anchors:

- `src/telemetry.ts:appendFailedTelemetryEvents(...)`
- `src/telemetry.ts:retryPreviousBatches(...)`
- `src/telemetry.ts:emitTelemetryEvents(...)`
- `src/telemetry.ts:flushTelemetryEvents(...)`

Evidence boundary:

- behavior is evidence-informed and directionally aligned
- exact byte-for-byte runtime parity is **not** proven

---

## 8. Telemetry event shape

## 8.1 Proven telemetry event envelope

Official telemetry capture proved the top-level batch contains events like:

```json
{
  "event_type": "ClaudeCodeInternalEvent",
  "event_data": { ... }
}
```

and also local Bun evidence supports `GrowthbookExperimentEvent` as another event type.

## 8.2 Proven common `ClaudeCodeInternalEvent.event_data` fields

Strongly supported fields:

- `event_name`
- `client_timestamp`
- `model`
- `session_id`
- `user_type`
- `betas` (comma-joined string)
- `env`
- `entrypoint`
- `is_interactive`
- `client_type`
- `process`
- optional `additional_metadata`
- optional `auth`
- `event_id`
- `device_id`
- `email`
- optional `skill_name`
- optional `plugin_name`
- optional `marketplace_name`

## 8.3 Process and additional metadata encoding

Official telemetry capture proved:

- `process` is a **base64-encoded JSON string**
- `additional_metadata` when present is also a **base64-encoded JSON string**

Current repo implementation matches this:

- `src/telemetry.ts:encodeTelemetryPayload(...)`
- `src/telemetry.ts:buildClaudeCodeInternalEvent(...)`

## 8.4 Official event name family currently observed

Observed or recovered `tengu_*` family includes many names such as:

- `tengu_shell_set_cwd`
- `tengu_started`
- `tengu_dir_search`
- `tengu_version_lock_acquired`
- `tengu_exit`
- `tengu_timer`
- `tengu_claudemd__initial_load`
- `tengu_prompt_suggestion_init`
- `tengu_init`
- `tengu_startup_manual_model_config`
- `tengu_skill_loaded`
- `tengu_startup_telemetry`
- `tengu_mcp_tools_commands_loaded`
- `tengu_ripgrep_availability`
- `tengu_file_suggestions_ripgrep`
- `tengu_context_size`
- `tengu_native_auto_updater_start`
- `tengu_claudeai_mcp_eligibility`
- `tengu_mcp_servers`
- `tengu_version_check_success`
- `tengu_binary_download_attempt`
- `tengu_claudeai_limits_status_changed`
- `tengu_mcp_claudeai_proxy_401`
- `tengu_mcp_server_needs_auth`
- `tengu_binary_download_success`
- `tengu_native_install_binary_success`
- `tengu_native_update_complete`
- `tengu_native_auto_updater_success`
- `tengu_native_version_cleanup`

Current repo only emits a **small subset approximation** around request fetch lifecycle:

- `tengu_api_success`
- `tengu_api_error`

That is directionally aligned with first-party telemetry shape, but far from full official event coverage.

### 8.5 Current repo vs official event coverage

- **Official capture** shows a broad `tengu_*` event family across startup, filesystem, MCP, updater, auth, and lifecycle events.
- **Current repo implementation** only emits a narrow subset around Anthropic request success/error (`tengu_api_success`, `tengu_api_error`).
- Therefore the repo is currently aligned on **transport shape and core envelope family**, but **not** on full event catalog or event sequencing parity.

---

## 9. Telemetry environment object

## 9.1 Official capture-proven env facts

The official telemetry capture proved examples like:

- `platform: "linux"`
- `node_version: "v24.3.0"`
- `terminal: "ghostty"`
- `package_managers: "npm"`
- `runtimes: "node"`
- `is_running_with_bun: true`
- `is_ci: false`
- `is_claubbit: false`
- `is_github_action: false`
- `is_claude_code_action: false`
- `is_claude_ai_auth: true`
- `version: "2.1.87"`
- `arch: "x64"`
- `is_claude_code_remote: false`
- `deployment_environment: "unknown-linux"`
- `is_conductor: false`
- `version_base: "2.1.87"`
- `build_time: "2026-03-29T01:39:46Z"`
- `is_local_agent_mode: false`
- `linux_distro_id: "arch"`
- `linux_kernel: "6.19.9-arch1-1"`
- `platform_raw: "linux"`

## 9.2 Current repo implementation

Current repo implementation anchor:

- `src/telemetry.ts:getTelemetryEnv()`

Current repo aligns on key proven shape points:

- `package_managers` is a **string**, not array
- `runtimes` is a **string**, not array
- `is_running_with_bun: true`
- `version` and `version_base` use `2.1.87`
- Linux distro/kernel fields are populated when available

But this is still only a **best-effort approximation** for many values. It must not be described as exact parity for every env field.

---

## 10. Shared identity model across request and telemetry

Strongest current working model:

- request `metadata.user_id.device_id` appears to use the same device/install identity family as telemetry `device_id`
- request `metadata.user_id.account_uuid` appears to use the same account identity family as telemetry `auth.account_uuid`
- request `metadata.user_id.session_id`, telemetry `session_id`, and header `X-Claude-Code-Session-Id` are best understood as sibling projections of the same runtime session identity

Current repo implementation follows this model through:

- `src/telemetry.ts:buildTelemetryIdentity(...)`
- `src/transforms.ts:transformBody(...)`
- `src/index.ts:buildRequestHeaders(...)`

---

## 11. Current repo behavior summary

## 11.1 Implemented and evidence-backed on key points

- request `User-Agent: claude-cli/2.1.87 (external, cli)`
- `X-Claude-Code-Session-Id`
- `x-app: cli`
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`
- packet-proven `X-Stainless-*`
- `x-client-request-id`
- billing-like text carried in request `system`
- `metadata.user_id` as JSON-stringified W6H-style bundle
- telemetry endpoint `/api/event_logging/v2/batch`
- telemetry headers `User-Agent: claude-code/2.1.87`, `anthropic-beta: oauth-2025-04-20`, `x-service-name: claude-code`
- telemetry base64 `process` / `additional_metadata`
- failed-event spool files under `~/.claude/telemetry/1p_failed_events.<session>.<uuid>.json` (evidence-informed first-party approximation)

## 11.2 Intentionally conservative

- `cch=00000`
- no guessed nonzero `cch` logic
- no claim of exact prompt-body equivalence
- no claim that every telemetry env field is packet-exact

## 11.3 Known mismatches still remaining

### System prompt content mismatch

Current repo still does **not** match the latest official captured system blocks exactly.

Current issue:

- repo injects prompt text from `src/anthropic-prompt.txt`
- captured official request used a different identity/task-specific split
- therefore current prompt content is still an approximation

### Telemetry event catalog mismatch

Current repo emits only limited fetch lifecycle events, not the full observed `tengu_*` event family.

### Exact parity boundary

Current implementation is closer than before, but still must be described as:

- **packet-aligned on proven transport/body details**
- **approximate on full prompt body and full telemetry event coverage**

### Official-public documentation boundary

- Request header mechanisms are partly supported by official SDK source/docs.
- Telemetry packet details are mostly supported by **real capture** plus local reverse engineering, not by full official public documentation.
- This means `protocol.md` should be used as a **source-ranked protocol reference**, not as proof that Anthropic has publicly documented every field here.

---

## 12. File map for future work

### Core request shaping

- `src/index.ts`
- `src/transforms.ts`

### Core telemetry sender

- `src/telemetry.ts`

### Identity/account/session inputs

- `src/keychain.ts`
- `src/credentials.ts`

### Verification

- `src/index.test.ts`
- `src/transforms.test.ts`
- `src/telemetry.test.ts`

### Reverse-engineering notebook

- `protocl.md`

### Preserved local evidence snapshot

- `claude-2.1.87.bun`

---

## 13. Safe conclusions

The following statements are safe today:

1. `metadata.user_id` is a JSON-stringified core bundle, not a scalar id.
2. The core recovered fields are `device_id`, `account_uuid`, and `session_id`.
3. Billing-like text is strongly supported in the request `system` path.
4. Visible recovered Bun/JS paths do not prove a real HTTP billing header insertion.
5. Visible recovered `cch` template is `00000`; nonzero derivation remains unresolved.
6. Official telemetry uses `/api/event_logging/v2/batch` with `{ events }` JSON batches.
7. Official telemetry request headers include `claude-code/<version>` UA and `anthropic-beta: oauth-2025-04-20`.
8. Official telemetry encodes `process` and `additional_metadata` as base64 JSON strings.
9. Current repo is packet-aligned on many proven transport/body details, but not yet exact on full prompt content or full telemetry event coverage.

---

## 14. Unsafe claims that should be avoided

Do **not** claim any of the following unless stronger evidence is recovered later:

- exact official full prompt-body equivalence
- exact official nonzero `cch` generation algorithm
- that all final on-wire paths always match the visible Bun/JS static path
- that every telemetry env field/value is exact official parity
- that current repo telemetry event names/timing fully match official Claude Code

---

## 15. Relationship to `protocl.md`

- `protocl.md` = chronological reverse-engineering notebook, raw recovered clues, offsets, caution notes
- `protocol.md` = current cleaned protocol reference and implementation-facing source of truth

When new captures or Bun recoveries supersede earlier assumptions, update `protocol.md` first and treat `protocl.md` as supporting detail/history.
