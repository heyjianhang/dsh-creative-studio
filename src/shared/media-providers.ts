export const mediaProviders = {
  native: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    nameKey: "volcProvider",
    descriptionKey: "volcMetered",
    keyHint: "nativeKeyPlaceholder",
  },
  plan: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    nameKey: "volcPlan",
    descriptionKey: "volcSubscription",
    keyHint: "planKeyPlaceholder",
  },
} as const;
export type MediaProviderId = keyof typeof mediaProviders;

/** Custom gateways remain configurable; the official host has distinct routes. */
export function validateProviderRoute(mode: MediaProviderId, baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.hostname !== "ark.cn-beijing.volces.com") return;
  const expected = mediaProviders[mode].baseUrl;
  if (url.protocol !== "https:" || baseUrl.replace(/\/+$/, "") !== expected)
    throw new Error(
      `${mode === "plan" ? "火山Agent Plan" : "火山方舟"}的 Base URL 应为 ${expected}。两种供应商使用不同的专属密钥与模型目录。`,
    );
}
