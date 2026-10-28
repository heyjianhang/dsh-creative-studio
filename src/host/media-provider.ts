import type {
  MediaJob,
  MediaParameters,
  MediaModel,
  ModelDiscovery,
} from "../shared/media-contracts.ts";
import { capabilities } from "../shared/media-contracts.ts";
import {
  validateProviderRoute,
  type MediaProviderId,
} from "../shared/media-providers.ts";
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly failure?: MediaJob["failure"],
  ) {
    super(message);
  }
}
export function validateMediaTarget(
  mode: MediaProviderId,
  base: string,
  model: MediaModel,
  directory?: ModelDiscovery,
) {
  try {
    validateProviderRoute(mode, base);
  } catch (e) {
    throw new ProviderError((e as Error).message, false, {
      kind: "configuration",
      code: "ProviderRouteMismatch",
    });
  }
  if (
    new URL(base).hostname !== "ark.cn-beijing.volces.com" ||
    model.model.startsWith("ep-")
  )
    return;
  if (!directory || directory.mode !== mode)
    throw new ProviderError(
      "无法核对供应商模型目录，请刷新模型列表后再生成",
      false,
      { kind: "configuration", code: "ModelDirectoryUnavailable" },
    );
  const found = directory.models.find((m) => m.model === model.model);
  if (!found?.capabilities || found.kind !== capabilities(model).kind)
    throw new ProviderError(
      `“${model.model}”不在${mode === "plan" ? "火山Agent Plan" : "火山方舟"}当前模型目录中，请在模型设置中重新选择；ep- 接入点可手动添加。`,
      false,
      { kind: "configuration", code: "ModelProviderMismatch" },
    );
}
export function imageSize(p: MediaParameters) {
  const sizes: Record<string, Record<string, string>> = {
    "1K": {
      "1:1": "1024x1024",
      "4:3": "1152x864",
      "3:4": "864x1152",
      "16:9": "1424x800",
      "9:16": "800x1424",
      "3:2": "1248x832",
      "2:3": "832x1248",
      "21:9": "1568x672",
    },
    "1.5K": {
      "1:1": "1536x1536",
      "4:3": "1792x1344",
      "3:4": "1344x1792",
      "16:9": "2048x1152",
      "9:16": "1152x2048",
      "3:2": "1872x1248",
      "2:3": "1248x1872",
      "21:9": "2352x1008",
    },
    "2K": {
      "1:1": "2048x2048",
      "4:3": "2304x1728",
      "3:4": "1728x2304",
      "16:9": "2848x1600",
      "9:16": "1600x2848",
      "3:2": "2496x1664",
      "2:3": "1664x2496",
      "21:9": "3136x1344",
    },
    "3K": {
      "1:1": "3072x3072",
      "4:3": "3456x2592",
      "3:4": "2592x3456",
      "16:9": "4096x2304",
      "9:16": "2304x4096",
      "3:2": "3744x2496",
      "2:3": "2496x3744",
      "21:9": "4704x2016",
    },
    "4K": {
      "1:1": "4096x4096",
      "4:3": "4704x3520",
      "3:4": "3520x4704",
      "16:9": "5504x3040",
      "9:16": "3040x5504",
      "3:2": "4992x3328",
      "2:3": "3328x4992",
      "21:9": "6240x2656",
    },
  };
  const value = sizes[p.resolution]?.[p.ratio];
  if (!value) throw new Error("图片比例或分辨率不受支持");
  return value;
}
export function buildMediaPayload(job: MediaJob, images: string[]) {
  const s = job.snapshot,
    p = s.parameters;
  if (job.kind === "image")
    return {
      model: s.model.model,
      prompt: s.prompt,
      size: imageSize(p),
      response_format: "url",
      stream: false,
      watermark: false,
      ...(capabilities(s.model).imageOutput === "png"
        ? { output_format: "png" }
        : { sequential_image_generation: "disabled" }),
      ...(p.seed >= 0 ? { seed: p.seed } : {}),
      ...(images.length
        ? { image: images.length === 1 ? images[0] : images }
        : {}),
    };
  return {
    model: s.model.model,
    content: [
      { type: "text", text: s.prompt },
      ...images.map((url, index) => ({
        type: "image_url",
        image_url: { url },
        role:
          s.references.filter((r) => r.data.kind === "image")[index]?.role ??
          (p.mode === "reference"
            ? "reference_image"
            : index === 0
              ? "first_frame"
              : "last_frame"),
      })),
    ],
    ratio: p.ratio,
    resolution: p.resolution,
    duration: p.duration,
    ...(capabilities(s.model).audio ? { generate_audio: p.audio } : {}),
    watermark: false,
    ...(p.seed >= 0 ? { seed: p.seed } : {}),
  };
}
export function providerFailure(
  base: string,
  key: string,
  rawCode: unknown,
  status?: number,
  requestId?: string | null,
) {
  const code = String(rawCode ?? status ?? "UnknownError")
    .replaceAll(key, "[redacted]")
    .slice(0, 100);
  const plan = new URL(base).pathname.startsWith("/api/plan/");
  const provider = plan ? "火山Agent Plan" : "火山方舟";
  const moderated =
    /^(Input|Output)(Text|Image|Video|Audio)(SensitiveContentDetected|RiskDetection)(\.|$)/.exec(
      code,
    );
  const subject = moderated
    ? (moderated[1] === "Output" ? "生成的" : "输入的") +
      ({ Text: "文字", Image: "图片", Video: "视频", Audio: "音频" }[
        moderated[2]!
      ] ?? "内容")
    : "";
  const hint = moderated
    ? `${subject}未通过${provider}内容审核，请调整提示词或参考素材后再试`
    : status === 401 || code === "AuthenticationError"
      ? `${provider}鉴权失败，请确认填写的是${plan ? "Agent Plan 专属" : "方舟按量计费"} Key；两种 Key 不能互用`
      : code.includes("ModelIDAccessDisabled")
        ? "当前模型不支持直接使用模型 ID，请配置已开通的 ep- 接入点"
        : code === "ModelNotOpen"
          ? "账号尚未开通这个模型，请先在火山控制台开通"
          : status === 403
            ? "没有模型权限或套餐额度不可用"
            : status === 404
              ? `${provider}未找到模型或当前账号无权访问，请核对模型 ID、接入点与开通权限`
              : status === 429
                ? "请求过于频繁或额度不足"
                : status !== undefined && status >= 500
                  ? "供应商服务暂时异常"
                  : "请检查模型参数与参考素材";
  return new ProviderError(`${hint}（${code}）`, false, {
    kind: moderated
      ? "moderation"
      : status === 401 || code === "AuthenticationError"
        ? "authentication"
        : status === 403 || code === "ModelNotOpen"
          ? "permission"
          : status === 404
            ? "configuration"
            : status === 429
              ? "rate-limit"
              : "provider",
    code,
    status,
    requestId:
      requestId && !requestId.includes(key) && /^[\w.-]{1,160}$/.test(requestId)
        ? requestId
        : undefined,
  });
}
export async function providerJSON(
  base: string,
  path: string,
  key: string,
  signal: AbortSignal,
  body?: unknown,
  method = body ? "POST" : "GET",
  fetcher: typeof fetch = fetch,
): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ProviderError(
      method === "POST"
        ? "提交结果暂时无法确认，未自动重发。请先在供应商控制台核对任务，避免重复计费。"
        : "暂时无法获取任务状态，请稍后继续获取结果",
      method === "POST",
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError(
      "供应商返回了无法解析的结果",
      method === "POST" && response.ok,
    );
  }
  if (!response.ok || data.error) {
    const error = providerFailure(
      base,
      key,
      data.error?.code,
      response.status,
      response.headers.get("x-request-id") ??
        response.headers.get("x-tt-logid"),
    );
    throw new ProviderError(
      error.message,
      method === "POST" &&
        response.status >= 500 &&
        error.failure?.kind !== "moderation",
      error.failure,
    );
  }
  return data;
}
