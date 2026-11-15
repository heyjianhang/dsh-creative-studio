import type { Settings } from "../shared/contracts.ts";
export class WorkError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
export const fingerprint = (s: Settings) =>
  `${s.baseUrl.replace(/\/$/, "")}|${s.model}|${s.segmentSeconds}|v1`;

async function errorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let body = "",
    size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16384) return;
      body += decoder.decode(chunk.value, { stream: true });
    }
    const value = JSON.parse(body + decoder.decode());
    return typeof value?.error?.code === "string"
      ? value.error.code
      : undefined;
  } catch {
    return;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function errorMessage(status: number, code: string | undefined) {
  // Map known codes instead of exposing provider messages containing account or request data.
  switch (code) {
    case "ModelNotOpen":
      return "当前账号尚未开通此嵌入模型，请在火山方舟「开通管理」中开通后重试";
    case "InvalidEndpointOrModel.NotFound":
      return "模型或接入点不存在，或当前密钥无权访问，请检查模型 ID 与模型权限";
    case "InvalidEndpointOrModel.ModelIDAccessDisabled":
      return "当前账号不支持直接使用模型 ID，请填写有权限的推理接入点 ID";
    case "PathNotFound":
    case "InvalidAction":
      return "火山 API 路径不存在，请检查 API 地址，应填写到 /api/v3";
    case "UnsupportedModel":
      return "当前模型不支持此套餐，请使用支持嵌入模型的火山方舟 API Key";
    case "AccountOverdueError":
      return "火山账号欠费或尚未开通对应计费项，请检查账号状态";
    case "InvalidEndpoint.ClosedEndpoint":
      return "推理接入点已关闭或暂不可用，请检查接入点状态";
  }
  if (status === 401) return "API Key 无效或已失效，请检查密钥";
  if (status === 403) return "火山拒绝访问，请检查密钥权限与账号状态";
  if (status === 404)
    return "未找到模型或接口，请检查 API 地址、模型 ID 和模型开通状态（HTTP 404）";
  return `火山服务返回 HTTP ${status}${status === 429 || status >= 500 ? "，稍后可重试" : "，请检查模型和输入格式"}`;
}

export async function embed(
  settings: Settings,
  key: string | undefined,
  input: { text: string } | { image: string },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<number[]> {
  if (!key) throw new WorkError("尚未配置火山 API Key，请在设置中保存后重试");
  const url = new URL(
    settings.baseUrl.replace(/\/$/, "") + "/embeddings/multimodal",
  );
  if (url.protocol !== "https:") throw new WorkError("API 地址必须使用 HTTPS");
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      body: JSON.stringify({
        model: settings.model,
        encoding_format: "float",
        input: [
          "text" in input
            ? { type: "text", text: input.text }
            : { type: "image_url", image_url: { url: input.image } },
        ],
      }),
    });
  } catch (e) {
    signal.throwIfAborted();
    throw new WorkError(
      "火山请求超时或网络不可用，请检查网络和 API 地址",
      true,
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const retryHeader = response.headers.get("retry-after") ?? "0";
    const retryMillis = /^\d+(\.\d+)?$/.test(retryHeader)
      ? Number(retryHeader) * 1000
      : Date.parse(retryHeader) - Date.now();
    const retryAfter = Math.min(
      120000,
      Math.max(0, Number.isFinite(retryMillis) ? retryMillis : 0),
    );
    const code = await errorCode(response);
    signal.throwIfAborted();
    throw new WorkError(
      errorMessage(response.status, code),
      retryable,
      retryAfter,
    );
  }
  const value = (await response.json().catch(() => {
    throw new WorkError("火山返回格式无效，请稍后重试", true);
  })) as {
    data?: { embedding?: unknown } | { embedding?: unknown }[];
  };
  const vector = Array.isArray(value.data)
    ? value.data[0]?.embedding
    : value.data?.embedding;
  if (
    !Array.isArray(vector) ||
    vector.length < 2 ||
    vector.length > 65536 ||
    vector.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new WorkError("火山返回了无效向量，请检查模型类型");
  const norm = Math.sqrt(vector.reduce((s, n) => s + n * n, 0));
  if (!norm || !Number.isFinite(norm))
    throw new WorkError("火山返回了零向量或无效向量");
  return vector.map((n) => n / norm);
}
export function similarity(a: number[], b: number[]) {
  if (a.length !== b.length) return -1;
  return a.reduce((s, n, i) => s + n * b[i], 0);
}
