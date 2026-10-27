import type { Key } from "./locales.ts";
const labels: Record<string, Key> = {
  generated_images: "usageGeneratedImages",
  input_images: "usageInputImages",
  input_tokens: "usageInputTokens",
  prompt_tokens: "usageInputTokens",
  output_tokens: "usageOutputTokens",
  completion_tokens: "usageOutputTokens",
  total_tokens: "usageTotalTokens",
  "tool_usage.web_search": "usageWebSearch",
};
export function mediaUsageItems(
  usage: Record<string, number>,
  t: (key: Key) => string,
) {
  return Object.entries(usage).map(([key, value]) => ({
    key,
    label: labels[key] ? t(labels[key]) : key,
    value: value.toLocaleString(),
  }));
}
export function mediaUsageSummary(
  usage: Record<string, number>,
  t: (key: Key) => string,
) {
  const fields = [
    "generated_images",
    ...(usage.total_tokens !== undefined
      ? ["total_tokens"]
      : usage.completion_tokens !== undefined
        ? ["completion_tokens"]
        : ["output_tokens"]),
  ];
  return fields
    .filter((key) => usage[key] !== undefined)
    .map(
      (key) =>
        `${labels[key] ? t(labels[key]) : key} ${usage[key]!.toLocaleString()}`,
    )
    .join(" · ");
}
