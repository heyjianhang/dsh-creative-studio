import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditor, $getRoot } from "lexical";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { markdownNodes, markdownTransformers } from "../src/client/markdown-document.ts";

test("Markdown body survives formatting, serialization and reopening", () => {
  const original = "# 小猫的故事\n\n中文 **加粗** 与 *斜体*\n\n- 场景\n- 道具\n\n1. 起点\n2. 结尾\n\n---\n\n> 引用\n\n```js\nconst value = 1;\n```\n\n[链接](https://example.com)";
  const editor = createEditor({ nodes: markdownNodes, onError: (e) => { throw e; } });
  editor.update(() => $convertFromMarkdownString(original, markdownTransformers, undefined, true), { discrete: true });
  const encoded = editor.getEditorState().read(() => $convertToMarkdownString(markdownTransformers, undefined, true));
  assert.match(encoded, /# 小猫的故事/);
  assert.match(encoded, /\*\*加粗\*\*/);
  assert.match(encoded, /\*斜体\*/);
  assert.match(encoded, /1\. 起点/);
  assert.match(encoded, /---/);
  assert.match(encoded, /const value = 1/);
  assert.match(encoded, /\[链接\]\(https:\/\/example.com\)/);
  const restored = createEditor({ nodes: markdownNodes, onError: (e) => { throw e; } });
  restored.setEditorState(restored.parseEditorState(JSON.stringify(editor.getEditorState())));
  assert.equal(restored.getEditorState().read(() => $convertToMarkdownString(markdownTransformers, undefined, true)), encoded);
  restored.update(() => $convertFromMarkdownString(encoded, markdownTransformers, undefined, true), { discrete: true });
  assert.equal(restored.getEditorState().read(() => $convertToMarkdownString(markdownTransformers, undefined, true)), encoded);
});

test("plain Chinese paragraphs and literal HTML remain editable text", () => {
  const editor = createEditor({ nodes: markdownNodes, onError: (e) => { throw e; } });
  editor.update(() => $convertFromMarkdownString("第一段。\n\n第二段。\n\n<script>alert(1)</script>", markdownTransformers, undefined, true), { discrete: true });
  editor.getEditorState().read(() => {
    assert.match($getRoot().getTextContent(), /第一段。/);
    assert.match($getRoot().getTextContent(), /第二段。/);
    assert.match($getRoot().getTextContent(), /<script>alert\(1\)<\/script>/);
  });
});
