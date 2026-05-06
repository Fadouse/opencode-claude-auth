# Claude Code Internal Marker Analysis

## Scope

This document records local reverse-engineering findings from the official Claude client binary located at:

- `/home/fadouse/.local/share/claude/versions/2.1.87`
  Primary goals:

1. Determine whether the client appends a suspicious marker directly to outbound user message text.
2. Reconstruct the algorithm used to derive the marker.
3. Reconstruct the normal Claude Code request-construction path to Anthropic's Messages API.
4. Assess the best-supported interpretation of the marker's purpose and placement.
   This report is based on static recovery of readable code/text from the ELF `.bun` payload plus prior transcript/path verification. It is **not** a runtime packet capture.

---

## High-confidence conclusion

The strongest current evidence shows:

- the client does **not** directly append the recovered marker to `messages[*].content.text`
- instead, it derives a short prompt-dependent marker from the **first user message text**
- then wraps that marker inside a header-like string beginning with:
  - `x-anthropic-billing-header: cc_version=2.1.87.<marker>; ...`
- that string is inserted into the **system prompt path**
- the final request body then carries it inside the top-level `system` field, not as a literal suffix on the user message text
  Best-supported placement:
- **user message append**: low confidence
- **system prompt insertion**: high confidence
- **metadata-only field**: not supported for this marker path
- **real HTTP header emission for this exact string**: not supported by the recovered call path

---

## Recoverable marker algorithm

Recovered helper chain:

````js
function iw9(H){
  // returns first user message text
}
function x46(H,$){
  let K=[4,7,20].map((z)=>H[z]||"0").join(""),
      _=`${nw9}${K}${$}`;
  return KE7.createHash("sha256").update(_).digest("hex").slice(0,3)
}
function _E7(H){
  let $=iw9(H);
  return x46($,"2.1.87")
}
Recovered constant:
nw9 = "59cf53e54c78"
So the effective algorithm is:
text = first_user_message_text
chars = [text[4] || "0", text[7] || "0", text[20] || "0"].join("")
seed = "59cf53e54c78" + chars + "2.1.87"
marker = sha256(seed).digest("hex").slice(0, 3)
Meaning
This is a 3-hex-character prompt-derived short marker tied to:
- the first user prompt text
- a fixed constant
- the client version string
It is not a full prompt hash and not a direct transcript suffix algorithm.
---
Exact insertion path
Recovered string builder:
function TG$(H){
  let $=`${VERSION}.${H}`,
      z=`x-anthropic-billing-header: cc_version=${$}; cc_entrypoint=${q}; cch=00000; ...`;
  return z
}
Recovered assembly path inside jE7(...):
let V = _E7(k);
$ = D_([TG$(V), ZG$(...), ...$ , ...].filter(Boolean));
u = OM9($, S, {...});
Recovered D_ behavior:
function D_(H){ return H }
Recovered OM9(...) effect:
function OM9(H,$,q){
  return C46(H,...).map((K)=>({type:"text",text:K.text,...}))
}
Therefore the path is:
first user text
  -> iw9(...)
  -> x46(...)
  -> _E7(...)
  -> TG$(marker)
  -> inserted into system prompt array
  -> OM9(...)
  -> request body field: system
This is the strongest direct evidence for system-level insertion, not user-text mutation.
---
Reconstructed Claude Code request lifecycle
The broad request path recovered from the bundled JS is:
1. Entry wrappers
- Wa(...)
- kEH(...)
Both route into the main async generator:
- jE7(...)
2. Pre-request normalization inside jE7(...)
Recovered stages include:
- dJ(...)
- optional f$6(...) / Mf7(...)
- Zf7(...)
- fM9(...)
These normalize internal conversation state before Anthropic body construction.
3. Body construction for messages
Recovered builder:
- YM9(messages, cachingEnabled, querySource, cacheEditMode, cacheEditBlock, perMessageEdits, skipCacheWrite)
Recovered subordinate functions:
- HM9(...) for user messages
- $M9(...) for assistant messages
- m46(...) for insertion near tool_result blocks
Observed transformations in this path:
- add cache_control to selected final blocks
- insert cache-edit blocks
- add cache_reference to some tool_result blocks
- preserve/update structured content arrays
This is request-body mutation, but the currently recovered evidence does not show appending the short marker to messages[*].content.text.
4. Body construction for system
Recovered path:
- TG$(V) for marker-bearing string
- ZG$(...) for base identity/system prompt strings
- D_(...) keeps the array unchanged
- OM9(...) converts system strings into Anthropic system content blocks
5. Metadata and extra body fields
Recovered helper:
W6H()
This builds:
- metadata.user_id
Important nuance:
- gH(...) in that path is a JSON.stringify(...) helper, not the short marker hash routine.
Recovered helper:
IU$()
This merges:
- CLAUDE_CODE_EXTRA_BODY
- extra beta/body fields
6. Final payload constructor
Recovered closure inside jE7(...):
fH(...)
Recovered body structure includes:
{
  model,
  messages: YM9(...),
  system: OM9(...),
  tools,
  tool_choice,
  metadata: W6H(),
  max_tokens,
  thinking,
  temperature,
  context_management,
  output_config,
  speed,
  ...IU$(...)
}
7. SDK / transport layer
Recovered higher-level send calls:
uH.beta.messages.create({...D$, stream: !0}, ...)
O.beta.messages.create({...X, model:vL(X.model)}, ...)
Recovered lower-level SDK transport:
this._client.post("/v1/messages", {
  body:H,
  headers:W4([S_$(H.tools,H.messages), ...]),
  ...
})
and beta form:
this._client.post("/v1/messages?beta=true", {
  body:_,
  headers:W4([{"anthropic-beta": ...}, S_$(...), ...]),
  ...
})
Recovered S_$ behavior:
- header-only helper for x-stainless-helper
- no evidence it mutates message text
So the separation is:
- body shaping: jE7, YM9, HM9, $M9, OM9, W6H, IU$, fH
- header shaping / transport: SDK post(...), beta header composition, S_$
---
Comparison with normal Anthropic Messages API structure
Authoritative external baseline supports the following request shape for the Messages API:
- endpoint: POST /v1/messages
- top-level body fields include messages
- top-level system is separate from messages
- tools is a top-level request field
- optional beta behavior is carried by anthropic-beta headers
This external structure matches the locally recovered code split:
- Claude Code builds messages and system separately
- then the SDK sends the assembled body to /v1/messages or /v1/messages?beta=true
Relevant references:
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Anthropic Tool Use Overview: https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
- Bun single-file executable docs: https://bun.sh/docs/bundler/executables
---
What this does not prove
This report does not prove that:
- the binary is malicious
- the marker is emitted as a real HTTP header on the wire
- the marker is never transformed again at runtime in a later layer
- the final remote service interprets the marker in any specific documented way
It only supports the following high-confidence static statement:
> In the recovered bundled JS for Claude client 2.1.87, the prompt-derived short marker is inserted into a header-like string and carried into the Anthropic request body via the top-level system field, rather than being directly appended to user message text.
---
## Related prior local findings
Earlier transcript verification also found:
- raw `.jsonl` transcript files under `~/.claude/transcripts/` are plain JSONL
- previously observed `#RW|`-style prefixes were not present in raw bytes on disk
- those marker-like prefixes were consistent with display/render-layer artifacts, not transcript-file contents
That transcript result is separate from the API-path finding above, but it reinforces that suspicious visible markers may come from layers other than literal stored prompt text.
---
Bottom line
Best current interpretation:
- yes, there is a real prompt-derived internal marker algorithm
- no, current static evidence does not show it being appended directly to the user message text
- yes, current static evidence strongly supports it being wrapped into a string that enters the request via the system field
- yes, Claude Code otherwise follows the expected Anthropic Messages API split between messages, system, tools, and transport headers

---
## 2026-03-30 deeper Bun recovery update

This section extends the earlier static report with later Bun-payload recovery from `/tmp/claude-2.1.87.bun`.
The goal of this addendum is to record what is now directly recovered from the local 2.1.87 client, what remains unresolved, and which conclusions are safe to carry into repo behavior.

The preserved repo-local `claude-2.1.87.bun` artifact should be treated as a local reverse-engineering evidence snapshot/reference input, not as proof that every visible static path exactly matches final on-wire runtime behavior.

---
### Recovered `metadata.user_id` builder (`W6H`)

Later payload recovery moved `W6H()` from a high-level placeholder into a directly recovered function body:

```js
function W6H(){
  let extra = {}, raw = process.env.CLAUDE_CODE_EXTRA_METADATA;
  if (raw) {
    let parsed = E_(raw, false);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extra = parsed;
  }
  return {
    user_id: gH({
      ...extra,
      device_id: $S(),
      account_uuid: h9()?.accountUuid ?? "",
      session_id: V$(),
    })
  }
}
````

High-confidence implications:

- `metadata.user_id` is **not** a plain scalar id.
- It is a **JSON-stringified object** produced by `gH(...)`.
- The recovered field composition is:
  - `device_id` from `$S()`
  - `account_uuid` from `h9()?.accountUuid`
  - `session_id` from `V$()`
- `CLAUDE_CODE_EXTRA_METADATA`, if present and parseable as a JSON object, is merged into the same JSON payload before stringification.

This matches observed official request examples where `metadata.user_id` looked like a JSON string rather than a nested JSON object.

---

### Recovered device/session/account getters

Recovered helper roles now support a stronger field-source map:

- `V$()` returns the current in-memory Claude Code `sessionId`.
- `Os$()` rotates `sessionId` via `randomUUID()`.
- `$S()` returns the persistent device/install identifier:
  - if `A$().userID` exists, return it
  - else generate a new 32-byte random hex string and persist it
- `h9()?.accountUuid` is the current authenticated account UUID from local auth state.

Recovered `$S()` body:

```js
function $S() {
  let state = A$()
  if (state.userID) return state.userID
  let generated = randomBytes(32).toString("hex")
  x$((s) => ({ ...s, userID: generated }))
  return generated
}
```

This is the strongest current evidence that the local persisted `userID` is actually the request/telemetry `device_id`.

---

### Recovered Claude-side API wrapper (`py`)

The main Claude-side client-construction wrapper recovered from the Bun payload is:

```js
async function py({apiKey, maxRetries, model, fetchOverride, source})
```

Visible recovered behavior:

- builds Claude-specific `defaultHeaders` before constructing the Anthropic client
- includes headers such as:
  - `x-app: cli`
  - `User-Agent: cS()`
  - `X-Claude-Code-Session-Id: V$()`
  - optional remote/session/client-app headers
- merges custom headers from `M34()`
- refreshes/injects auth via `w34(...)`
- wraps fetch via `j34(...)`
- configures transport/proxy/TLS via `a1H({ forAnthropicAPI: true })`

Important negative finding:

- in the visible recovered `py -> M34 -> w34 -> j34 -> a1H -> Anthropic SDK` path, there is **no explicit insertion of `x-anthropic-billing-header` as an HTTP header** and no visible nonzero `cch` mutation.

This strengthens the architecture split:

- body/system/metadata shaping happens in Claude-side request builders (`W6H`, `TG$`, `ZG$`, `OM9`, `YM9`, etc.)
- transport/default headers/auth/proxy happen in `py`, `M34`, `w34`, `j34`, `a1H`, and the lower Anthropic SDK

---

### Recovered richer system prompt assembly

Earlier recovery showed that `TG$(marker)` produces the billing-header-like string and that the string enters the top-level `system` path.
Later Bun tracing strengthens this into a richer visible assembly pattern:

```js
let billingText = TG$(marker)
let system = [
  billingText ? { type: "text", text: billingText } : null,
  ...basePromptBlocksFromZG$(...),
  ...otherSystemBlocks,
].filter(Boolean)
```

High-confidence implication:

- the official client is not limited to the short identity prefix currently used in the repo runtime transform
- visible recovered runtime builds `system` from **multiple text blocks**, including the billing string from `TG$(...)` and richer base/system prompt text from `ZG$(...)`

This is stronger evidence for a dynamic multi-block system-prompt assembly than the repo's earlier short-prefix approximation.

What remains unresolved here is completeness: the recovered visible assembly is more complete than the earlier notes, but static extraction still does not prove every final runtime contributor in final order.

---

### Recovered telemetry architecture

Recovered Bun functions show that Claude Code 2.1.87 has a structured first-party telemetry/event pipeline.

Recovered env schema builder:

```js
function Zw4(){
  return {
    platform: "",
    node_version: "",
    terminal: "",
    package_managers: "",
    runtimes: "",
    is_running_with_bun: false,
    is_ci: false,
    is_claubbit: false,
    is_github_action: false,
    is_claude_code_action: false,
    is_claude_ai_auth: false,
    version: "",
    arch: "",
    linux_distro_id: "",
    linux_distro_version: "",
    linux_kernel: "",
    platform_raw: "",
    ...
  }
}
```

Recovered internal event schema builder:

```js
function vw4(){
  return {
    event_name: "",
    client_timestamp: undefined,
    model: "",
    session_id: "",
    user_type: "",
    betas: "",
    env: undefined,
    entrypoint: "",
    agent_sdk_version: "",
    is_interactive: false,
    client_type: "",
    process: "",
    additional_metadata: "",
    auth: undefined,
    event_id: "",
    device_id: "",
    email: "",
    parent_session_id: "",
    agent_type: "",
    skill_name: "",
    plugin_name: "",
    marketplace_name: "",
    ...
  }
}
```

Recovered first-party exporter behavior shows:

- logs are converted to final event payloads via `transformLogsToEvents(...)`
- failed exports are persisted into files prefixed `1p_failed_events.`
- failed batches are retried with backoff
- `ClaudeCodeInternalEvent` payloads include `event_id`, `event_name`, `client_timestamp`, `device_id`, `email`, `auth`, merged core/env/process fields, and optional base64-encoded `additional_metadata`
- `GrowthbookExperimentEvent` payloads include `device_id`, `session_id`, and auth bundle fields

This matches local newline-delimited failed-event files under `~/.claude/telemetry`.

---

### Telemetry/request metadata overlap

Recovered evidence now supports the following high-confidence relationship:

- request `metadata.user_id` uses:
  - `device_id: $S()`
  - `account_uuid: h9()?.accountUuid`
  - `session_id: V$()`
- telemetry builders/exporters also rely on the same core identifiers from `$S()`, `V$()`, and `_WH(!0)`

Recovered `_WH(!0)` bundle includes:

- `deviceId`
- `sessionId`
- `email`
- `appVersion`
- `platform`
- `organizationUuid`
- `accountUuid`
- `userType: "external"`

Therefore:

- `metadata.user_id` and first-party telemetry are not separate identity systems
- they are sibling projections of the same Claude Code runtime state
- `X-Claude-Code-Session-Id`, telemetry `session_id`, and `metadata.user_id.session_id` are best understood as the same session key surfacing in different channels

---

### `cch` boundary after deeper Bun tracing

Deeper unpacked-Bun tracing moved the `cch` analysis from a repo-level guess to a stronger official-client boundary.

What is directly recovered:

```js
function TG$(H) {
  let version = `2.1.87.${H}`,
    entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown",
    cch = " cch=00000;",
    workload = iP$() ? ` cc_workload=${iP$()};` : "",
    text = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workload}`
  return text
}
```

What is also directly recovered:

- no explicit `.set(...)`, `.append(...)`, or object-literal insertion of `x-anthropic-billing-header` into visible HTTP header builders
- no explicit visible mutation of `cch` in:
  - `py(...)`
  - `M34()`
  - `w34()`
  - `j34()`
  - `a1H()`
  - lower Anthropic SDK header/body assembly

High-confidence interpretation:

- the recovered visible Claude Code 2.1.87 JS/Bun path contains a **static template** with `cch=00000`
- if real official traffic sometimes shows nonzero `cch`, that replacement path is **not visible in the recovered JS path documented here**

Current safe boundary:

- **proven**: visible constructor emits `00000`
- **not proven**: final wire `cch` is always `00000`
- **unresolved**: where/how observed nonzero `cch` values are produced

---

### Updated caution boundary

This addendum still does not prove that:

- the visible `cch=00000` template is identical to every final on-wire request in all runtime paths
- the currently recovered `system` assembly is the complete final prompt without any additional later-stage contributors
- telemetry export format and request metadata are identical byte-for-byte across all code paths; only their shared field sources are currently supported

Updated best current interpretation:

- yes, `metadata.user_id` is best understood as a JSON-stringified `{device_id, account_uuid, session_id}` bundle rather than a plain scalar id
- yes, first-party telemetry and request metadata share the same underlying device/account/session context builders
- no, the real nonzero `cch` runtime derivation has not yet been recovered from the visible Bun/JS path and should not be guessed
