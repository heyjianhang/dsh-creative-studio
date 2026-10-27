import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMediaUsage } from "../src/shared/media-usage.ts";
import { mediaProviders } from "../src/shared/media-providers.ts";

test("keeps provider counters and nested tool usage without deriving money or preserving strings", () => {
  assert.deepEqual(
    normalizeMediaUsage({
      generated_images: 1,
      output_tokens: 20,
      total_tokens: 20,
      tool_usage: { web_search: 2 },
      secret: "credential",
      invalid: NaN,
      negative: -1,
    }),
    {
      generated_images: 1,
      output_tokens: 20,
      total_tokens: 20,
      "tool_usage.web_search": 2,
    },
  );
  assert.equal(normalizeMediaUsage(null), undefined);
  assert.equal(normalizeMediaUsage({ secret: "never expose" }), undefined);
});
test("provider presets keep separate native and Plan routes", () => {
  assert.equal(
    mediaProviders.native.baseUrl,
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  assert.equal(
    mediaProviders.plan.baseUrl,
    "https://ark.cn-beijing.volces.com/api/plan/v3",
  );
  assert.notEqual(mediaProviders.native.keyHint, mediaProviders.plan.keyHint);
});
