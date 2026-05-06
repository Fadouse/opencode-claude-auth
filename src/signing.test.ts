import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  extractFirstUserMessageText,
  computeSeededCchHash,
  computeCch,
  fillCchInSerializedBody,
  computeVersionSuffix,
  buildBillingHeaderValue,
} from "./signing.ts"

describe("signing", () => {
  describe("extractFirstUserMessageText", () => {
    it("extracts string content from user message", () => {
      assert.equal(
        extractFirstUserMessageText([{ role: "user", content: "hello" }]),
        "hello",
      )
    })

    it("extracts first text block from array content", () => {
      assert.equal(
        extractFirstUserMessageText([
          {
            role: "user",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ]),
        "first",
      )
    })

    it("skips non-user messages", () => {
      assert.equal(
        extractFirstUserMessageText([
          { role: "assistant", content: "hi" },
          { role: "user", content: "hello" },
        ]),
        "hello",
      )
    })

    it("returns empty string when no user message", () => {
      assert.equal(
        extractFirstUserMessageText([{ role: "assistant", content: "hi" }]),
        "",
      )
    })

    it("returns empty string for empty messages array", () => {
      assert.equal(extractFirstUserMessageText([]), "")
    })

    it("returns empty string when no text blocks in array content", () => {
      assert.equal(
        extractFirstUserMessageText([
          {
            role: "user",
            content: [{ type: "image" }],
          },
        ]),
        "",
      )
    })
  })

  describe("computeCch", () => {
    const bodyText =
      '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=sdk-cli; cch=00000;"}]}'

    it("matches the recovered seeded XXH64 test vector", () => {
      assert.equal(
        computeSeededCchHash(new TextEncoder().encode(bodyText)),
        0xa1fb9e4e37ea9c0fn,
      )
      assert.equal(computeCch(bodyText), "a9c0f")
    })

    it("fills the serialized body placeholder deterministically", () => {
      assert.equal(
        fillCchInSerializedBody(bodyText),
        '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=sdk-cli; cch=a9c0f;"}]}',
      )
    })
  })

  describe("computeVersionSuffix", () => {
    it("matches test vector: 'hey' + v2.1.37 → 0d9", () => {
      assert.equal(computeVersionSuffix("hey", "2.1.37"), "0d9")
    })

    it("matches test vector: 'hey' + v2.1.90 → b39", () => {
      assert.equal(computeVersionSuffix("hey", "2.1.90"), "b39")
    })

    it("pads short messages with '0' for OOB indices", () => {
      // "hey" has length 3, so indices 4, 7, 20 all produce "0"
      // sampled = "000"
      assert.equal(computeVersionSuffix("hey", "2.1.37"), "0d9")
    })

    it("samples correct character indices from long message", () => {
      // "Hello, how are you doing today?"
      //  01234567890123456789012345678901
      //      ^  ^            ^
      //  [4]='o' [7]='h' [20]='o'
      assert.equal(
        computeVersionSuffix("Hello, how are you doing today?", "2.1.90"),
        "494",
      )
    })

    it("handles empty string (all indices pad to '0')", () => {
      const result = computeVersionSuffix("", "2.1.90")
      assert.equal(typeof result, "string")
      assert.equal(result.length, 3)
    })
  })

  describe("buildBillingHeaderValue", () => {
    it("produces a placeholder header for simple string message", () => {
      const result = buildBillingHeaderValue(
        [{ role: "user", content: "hey" }],
        "2.1.126",
        "sdk-cli",
      )
      assert.equal(
        result,
        "x-anthropic-billing-header: cc_version=2.1.126.88c; cc_entrypoint=sdk-cli; cch=00000;",
      )
    })

    it("uses first text block from array content", () => {
      const result = buildBillingHeaderValue(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "hey" },
              { type: "text", text: "ignored" },
            ],
          },
        ],
        "2.1.126",
        "sdk-cli",
      )
      assert.equal(
        result,
        "x-anthropic-billing-header: cc_version=2.1.126.88c; cc_entrypoint=sdk-cli; cch=00000;",
      )
    })

    it("handles missing user message with the placeholder slot", () => {
      const result = buildBillingHeaderValue([], "2.1.126", "sdk-cli")
      assert.ok(result.includes("cch=00000"))
      assert.ok(result.includes("cc_version=2.1.126.88c"))
    })

    it("uses provided entrypoint", () => {
      const result = buildBillingHeaderValue(
        [{ role: "user", content: "hey" }],
        "2.1.126",
        "sdk-cli",
      )
      assert.ok(result.includes("cc_entrypoint=sdk-cli"))
    })
  })
})
