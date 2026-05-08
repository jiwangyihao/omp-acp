import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OmpRpcFrameParseError,
  isOmpRpcReadyFrame,
  isOmpRpcResponseFrame,
  parseOmpRpcFrame,
} from "../../../../src/runtime/omp/frames.ts";

describe("parseOmpRpcFrame", () => {
  it("parses ready frames", () => {
    const frame = parseOmpRpcFrame('{"type":"ready"}');

    assert.deepEqual(frame, { type: "ready" });
    assert.equal(isOmpRpcReadyFrame(frame), true);
  });

  it("parses response result frames preserving id and result", () => {
    const frame = parseOmpRpcFrame('{"type":"response","id":1,"result":{"ok":true}}');

    assert.equal(isOmpRpcResponseFrame(frame), true);
    assert.deepEqual(frame, { type: "response", id: 1, result: { ok: true } });
  });

  it("parses response error frames preserving id and error", () => {
    const frame = parseOmpRpcFrame(
      '{"type":"response","id":"abc","error":{"message":"boom"}}',
    );

    assert.equal(isOmpRpcResponseFrame(frame), true);
    assert.deepEqual(frame, {
      type: "response",
      id: "abc",
      error: { message: "boom" },
    });
  });

  it("parses known runtime events preserving raw payload", () => {
    for (const eventType of [
      "agent_start",
      "message_update",
      "host_tool_call",
      "host_tool_cancel",
      "extension_error",
    ]) {
      const raw = { type: eventType, sessionId: "s1", nested: { ok: true } };

      assert.deepEqual(parseOmpRpcFrame(JSON.stringify(raw)), {
        type: "event",
        eventType,
        raw,
      });
    }
  });

  it("parses unknown non-response and non-ready frames as events", () => {
    const raw = { type: "future_event", payload: { value: 42 } };
    const frame = parseOmpRpcFrame(JSON.stringify(raw));

    assert.deepEqual(frame, { type: "event", eventType: "future_event", raw });
    assert.equal(isOmpRpcResponseFrame(frame), false);
    assert.equal(isOmpRpcReadyFrame(frame), false);
  });

  it("rejects malformed JSON with OmpRpcFrameParseError", () => {
    assert.throws(
      () => parseOmpRpcFrame('{"type":"ready"'),
      (error) =>
        error instanceof OmpRpcFrameParseError &&
        error.message.includes("Invalid OMP RPC JSONL frame"),
    );
  });

  it("rejects JSON objects missing a string type", () => {
    for (const line of ['{}', '{"type":42}', '{"type":null}']) {
      assert.throws(
        () => parseOmpRpcFrame(line),
        (error) =>
          error instanceof OmpRpcFrameParseError && error.message.includes("missing string type"),
      );
    }
  });

  it("rejects response frames missing an id", () => {
    assert.throws(
      () => parseOmpRpcFrame('{"type":"response","result":{"ok":true}}'),
      (error) =>
        error instanceof OmpRpcFrameParseError && error.message.includes("missing id"),
    );
  });

  it("rejects non-object JSON values", () => {
    for (const line of ["null", "[]", "42"]) {
      assert.throws(
        () => parseOmpRpcFrame(line),
        (error) =>
          error instanceof OmpRpcFrameParseError && error.message.includes("must be an object"),
      );
    }
  });
});