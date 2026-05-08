import assert from "node:assert/strict";
import test from "node:test";
import { translateDiffPayloadToToolCallContent } from "../../../src/translate/diffs.ts";

test("translateDiffPayloadToToolCallContent maps create, modify, and delete diff payloads", () => {
  assert.deepEqual(translateDiffPayloadToToolCallContent({ path: "C:\\repo\\file.ts", newText: "created" }), [
    { type: "diff", path: "C:\\repo\\file.ts", oldText: null, newText: "created" },
  ]);

  assert.deepEqual(
    translateDiffPayloadToToolCallContent({ filePath: "/repo/file.ts", oldText: "before", newText: "after" }),
    [{ type: "diff", path: "/repo/file.ts", oldText: "before", newText: "after" }],
  );

  assert.deepEqual(
    translateDiffPayloadToToolCallContent({ path: "/repo/deleted.ts", oldText: "gone", newText: "" }),
    [{ type: "diff", path: "/repo/deleted.ts", oldText: "gone", newText: "" }],
  );
});

test("translateDiffPayloadToToolCallContent maps rename with new text to delete plus create", () => {
  assert.deepEqual(
    translateDiffPayloadToToolCallContent({
      operation: "rename",
      oldPath: "C:\\repo\\old.ts",
      newPath: "/repo/new.ts",
      oldText: "old",
      newText: "new",
    }),
    [
      { type: "diff", path: "C:\\repo\\old.ts", oldText: "old", newText: "" },
      { type: "diff", path: "/repo/new.ts", oldText: null, newText: "new" },
    ],
  );
});

test("translateDiffPayloadToToolCallContent reports unsupported rename missing string newText", () => {
  assert.deepEqual(
    translateDiffPayloadToToolCallContent({ operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" }),
    {
      unsupported: true,
      rawOutput: {
        error: "Unsupported rename diff payload: rename requires string newText",
        diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" },
      },
    },
  );
});
