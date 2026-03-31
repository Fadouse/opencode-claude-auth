import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildBillingHeaderValue,
  buildBillingSystemText,
  computeCch,
  computeSeededCchHash,
  fillCchInSerializedBody,
  getPromptMarker,
  getAttributionHeader,
  isAttributionHeaderEnabled,
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import { runWithWorkload } from "./workload.ts"

describe("transforms", () => {
  it("transformBody preserves system text and prefixes tool names", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "OpenCode and opencode" }],
      tools: [{ name: "search" }],
      messages: [{ content: [{ type: "tool_use", name: "lookup" }] }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      tools: Array<{ name: string }>
      messages: Array<{ content: Array<{ name: string }> }>
    }

    assert.equal(parsed.system[0].text, "OpenCode and opencode")
    assert.equal(parsed.tools[0].name, "mcp_search")
    assert.equal(parsed.messages[0].content[0].name, "mcp_lookup")
  })

  it("transformBody keeps opencode-claude-auth system text unchanged", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "Use opencode-claude-auth plugin instructions as-is.",
        },
      ],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.equal(
      parsed.system[0].text,
      "Use opencode-claude-auth plugin instructions as-is.",
    )
  })

  it("transformBody keeps OpenCode and opencode URL/path text unchanged", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
        },
      ],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.equal(
      parsed.system[0].text,
      "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
    )
  })

  it("getPromptMarker derives a stable 3-hex marker from first user text and version", () => {
    const markerA = getPromptMarker("Hello from request body", "2.1.88")
    const markerB = getPromptMarker("Hello from request body", "2.1.88")
    const markerC = getPromptMarker("Different user message", "2.1.88")

    assert.equal(markerA, markerB)
    assert.match(markerA, /^[0-9a-f]{3}$/u)
    assert.notEqual(markerA, markerC)
  })

  it("buildBilling helpers format the recovered billing text", () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    delete process.env.CLAUDE_CODE_ENTRYPOINT

    try {
      const headerValue = buildBillingHeaderValue(
        "Hello from request body",
        "2.1.88",
      )
      assert.match(
        headerValue,
        /^cc_version=2\.1\.88\.[0-9a-f]{3}; cc_entrypoint=unknown; cch=00000;$/u,
      )
      assert.equal(
        buildBillingSystemText("Hello from request body", "2.1.88"),
        `x-anthropic-billing-header: ${headerValue}`,
      )
    } finally {
      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
    }
  })

  it("getAttributionHeader appends cc_workload when workload context is present", () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli"

    try {
      const header = runWithWorkload("cron", () =>
        getAttributionHeader("Hello from request body", "2.1.88"),
      )
      assert.match(
        header,
        /^x-anthropic-billing-header: cc_version=2\.1\.88\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000; cc_workload=cron;$/u,
      )
    } finally {
      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
    }
  })

  it("CLAUDE_CODE_ATTRIBUTION_HEADER=0 disables attribution header injection", () => {
    const originalAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0"

    try {
      assert.equal(isAttributionHeaderEnabled(), false)
      assert.equal(
        getAttributionHeader("Hello from request body", "2.1.88"),
        "",
      )

      const input = JSON.stringify({
        system: [{ type: "text", text: "Existing system" }],
        messages: [{ role: "user", content: "Hello from request body" }],
      })

      const output = transformBody(input, {
        accountUuid: "acct-123",
        cliVersion: "2.1.88",
        deviceId: "device-456",
        sessionId: "session-789",
      })
      assert.equal(typeof output, "string")

      const parsed = JSON.parse(output as string) as {
        system: Array<{ text: string; type: string }>
      }
      assert.deepEqual(parsed.system, [
        { type: "text", text: "Existing system" },
      ])
    } finally {
      if (typeof originalAttribution === "string") {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttribution
      } else {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      }
    }
  })

  it("transformBody injects billing text and metadata.user_id when context is provided", () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({
      workspace: "repo",
    })
    delete process.env.CLAUDE_CODE_ENTRYPOINT

    try {
      const input = JSON.stringify({
        metadata: { trace_id: "trace-1" },
        system: [{ type: "text", text: "Existing system" }],
        messages: [{ role: "user", content: "Hello from request body" }],
      })

      const output = transformBody(input, {
        accountUuid: "acct-123",
        cliVersion: "2.1.88",
        deviceId: "device-456",
        sessionId: "session-789",
      })
      assert.equal(typeof output, "string")

      const parsed = JSON.parse(output as string) as {
        metadata: { trace_id: string; user_id: string }
        system: Array<{ text: string; type: string }>
      }

      assert.match(
        parsed.system[0].text,
        /^x-anthropic-billing-header: cc_version=2\.1\.88\.[0-9a-f]{3}; cc_entrypoint=unknown; cch=[0-9a-f]{5};$/u,
      )
      assert.deepEqual(parsed.system[1], {
        type: "text",
        text: "Existing system",
      })
      assert.equal(parsed.metadata.trace_id, "trace-1")
      assert.deepEqual(JSON.parse(parsed.metadata.user_id), {
        device_id: "device-456",
        account_uuid: "acct-123",
        session_id: "session-789",
        workspace: "repo",
      })
    } finally {
      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
      delete process.env.CLAUDE_CODE_EXTRA_METADATA
    }
  })

  it("transformBody reorders top-level request keys to match official request shape", () => {
    const input = JSON.stringify({
      stream: true,
      output_config: { effort: "medium" },
      max_tokens: 64000,
      temperature: 1,
      metadata: { trace_id: "trace-1" },
      system: "Existing system",
      messages: [{ role: "user", content: "Hello from request body" }],
      model: "claude-opus-4-6",
    })

    const output = transformBody(input, {
      accountUuid: "acct-123",
      cliVersion: "2.1.88",
      deviceId: "device-456",
      sessionId: "session-789",
    })

    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), [
      "model",
      "messages",
      "system",
      "metadata",
      "max_tokens",
      "temperature",
      "output_config",
      "stream",
    ])
  })

  it("computeSeededCchHash matches the recovered seeded XXH64 runtime value", () => {
    const bodyText = '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=sdk-cli; cch=00000;"}]}'

    assert.equal(
      computeSeededCchHash(new TextEncoder().encode(bodyText)),
      0xa1fb9e4e37ea9c0fn,
    )
    assert.equal(computeCch(bodyText), "a9c0f")
  })

  it("fillCchInSerializedBody replaces the zero slot with a deterministic 5-hex cch", () => {
    const bodyText = '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=sdk-cli; cch=00000;"}]}'

    assert.equal(
      fillCchInSerializedBody(bodyText),
      '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=sdk-cli; cch=a9c0f;"}]}',
    )
  })

  it("transformBody strips unsupported effort while preserving format, temperature, and empty tools", () => {
    const input = JSON.stringify({
      stream: true,
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      temperature: 1,
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      model: "claude-haiku-4-5-20251001",
    })

    const output = transformBody(input, {
      accountUuid: "acct-123",
      cliVersion: "2.1.88",
      deviceId: "device-456",
      sessionId: "session-789",
    })

    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      output_config: { format: { type: string }; effort?: string }
      temperature: number
      tools: unknown[]
    }

    assert.equal(parsed.temperature, 1)
    assert.deepEqual(parsed.tools, [])
    assert.equal(parsed.output_config.effort, undefined)
    assert.equal(parsed.output_config.format.type, "json_schema")
    assert.deepEqual(Object.keys(parsed), [
      "model",
      "messages",
      "system",
      "tools",
      "metadata",
      "temperature",
      "output_config",
      "stream",
    ])
  })

  it("stripToolPrefix removes mcp_ from response payload names", () => {
    const input = '{"name":"mcp_search","type":"tool_use"}'
    assert.equal(stripToolPrefix(input), '{"name": "search","type":"tool_use"}')
  })

  it("transformResponseStream rewrites streamed tool names", async () => {
    const payload = '{"name":"mcp_lookup"}'
    const response = new Response(payload)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.equal(text, '{"name": "lookup"}')
  })

  it("transformResponseStream buffers across chunks until event boundary", async () => {
    const chunk1 = 'data: {"name":"mc'
    const chunk2 = 'p_search"}\n\ndata: {"type":"done"}\n\n'
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "search"'),
      `Expected stripped name in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_search"),
      `Should not contain mcp_search in: ${text}`,
    )
  })

  it("transformResponseStream withholds output until event boundary arrives", async () => {
    const encoder = new TextEncoder()
    let sendBoundary: (() => void) | undefined

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_test"}'))
        sendBoundary = () => {
          controller.enqueue(encoder.encode("\n\n"))
          controller.close()
        }
      },
    })

    const response = new Response(source)
    const transformed = transformResponseStream(response)
    const reader = transformed.body!.getReader()

    const pending = reader.read()
    const raceTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 50),
    )

    const first = await Promise.race([pending, raceTimeout])
    assert.equal(
      first,
      "timeout",
      "Expected no output before boundary, but got a chunk",
    )

    sendBoundary!()

    const { done, value } = await pending
    assert.equal(done, false)
    const decoder = new TextDecoder()
    const text = decoder.decode(value)
    assert.ok(
      text.includes('"name": "test"'),
      `Expected stripped name: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_test"),
      `Should not contain mcp_test: ${text}`,
    )

    const final = await reader.read()
    assert.equal(final.done, true)
  })

  it("transformResponseStream flushes remaining buffered data on stream end", async () => {
    const encoder = new TextEncoder()
    const chunk1 = 'data: {"name":"mcp_alpha"}\n\n'
    const chunk2 = 'data: {"name":"mcp_beta"}'

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "alpha"'),
      `Expected alpha stripped in: ${text}`,
    )
    assert.ok(
      text.includes('"name": "beta"'),
      `Expected beta stripped in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_alpha"),
      `Should not contain mcp_alpha in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_beta"),
      `Should not contain mcp_beta in: ${text}`,
    )
  })
})
