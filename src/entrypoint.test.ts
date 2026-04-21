import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as entry from "../opencode-claude-auth.js"

describe("package entrypoint", () => {
  it("re-exports both server plugins", () => {
    assert.equal(typeof entry.ClaudeAuthPlugin, "function")
    assert.equal(typeof entry.ApiKeyProviderPlugin, "function")
    assert.equal(typeof entry.default, "function")
  })
})
