import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const Params = Type.Object({
  prompt: Type.String({ minLength: 1, description: "Image generation prompt." }),
  model: Type.Optional(Type.String({ description: "Images API model. Defaults to PI_CPA_IMAGE_MODEL or gpt-image-2." })),
  size: Type.Optional(Type.String({ description: "For example 1024x1024 or 1536x1024." })),
  quality: Type.Optional(Type.String({ description: "auto, low, medium, or high." })),
  background: Type.Optional(Type.String({ description: "auto, transparent, or opaque." })),
  outputFormat: Type.Optional(Type.Union([
    Type.Literal("png"),
    Type.Literal("jpeg"),
    Type.Literal("webp"),
  ])),
  outputDirectory: Type.Optional(Type.String({ description: "Output directory, relative to the Pi cwd." })),
});

export default function (pi: ExtensionAPI) {
  const imageTool = {
    name: "cpa_image_generate",
    label: "CPA Image Generation",
    description:
      "Generate an image through a CPA proxy using the OpenAI Images API.",
    promptSnippet: "Generate images through the configured CPA OpenAI proxy.",
    promptGuidelines: [
      "Use cpa_image_generate when the user asks to generate or render an image.",
      "Use a self-contained, detailed visual prompt.",
    ],
    parameters: Params,
    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      const config = await resolveProxyConfig(ctx);
      if (!config.apiKey) {
        return error("未找到 CPA API Key。请在 Pi 中配置 provider 凭据，或设置 PI_CPA_API_KEY。", { missing: "API key" });
      }

      const endpoint = imageEndpoint(config.baseUrl ?? "https://api.openai.com/v1");
      const model =
        params.model ??
        process.env.PI_CPA_IMAGE_MODEL ??
        "gpt-image-2";
      const outputFormat = params.outputFormat ?? "png";

      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        output_format: outputFormat,
      };
      for (const key of ["size", "quality", "background"]) {
        if (params[key] !== undefined) body[key] = params[key];
      }

      onUpdate?.({ content: [{ type: "text", text: "正在通过 CPA 调用 Images API…" }], details: {} });

      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const actor = process.env.PI_CPA_ACTOR_AUTHORIZATION ?? "local-proxy";
      if (actor) headers["X-OpenAI-Actor-Authorization"] = actor;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        return error(`CPA 请求失败：${message(err)}`);
      }

      const text = await response.text();
      if (!response.ok) {
        return error(`CPA 返回 HTTP ${response.status}：${text.slice(0, 1000)}`, { status: response.status });
      }

      const image = parseImageResponse(text);
      if (!image.data) {
        return error(`CPA 响应中没有找到 Images API 图片数据。${image.error ? ` ${image.error}` : ""}`);
      }

      const data = image.data.replace(/^data:image\/[^;]+;base64,/, "");
      const outputDir = path.resolve(ctx.cwd, params.outputDirectory ?? ".pi/generated-images");
      await mkdir(outputDir, { recursive: true });
      const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;
      const slug = String(params.prompt).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "image";
      const filePath = path.join(outputDir, `${Date.now()}-${slug}.${ext}`);
      await writeFile(filePath, Buffer.from(data, "base64"));

      const mimeType = outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
      return {
        content: [
          { type: "text", text: `图片已生成：${filePath}${image.revisedPrompt ? `\n修订提示词：${image.revisedPrompt}` : ""}` },
          { type: "image", data, mimeType },
        ],
        details: { path: filePath, model, endpoint, revisedPrompt: image.revisedPrompt },
      };
    },
  };
  pi.registerTool(imageTool);

  let imageRequest = false;
  let forceImageTool = false;
  pi.on("before_agent_start", (event) => {
    // ponytail: keyword routing covers explicit Chinese requests; /cpa-image avoids the heuristic.
    imageRequest = /^(?:请|帮我|麻烦)?\s*(?:生成|绘制|画|制作|设计)/.test(event.prompt.trim())
      && /缩略图|图片|图像|封面|海报|插画/.test(event.prompt)
      && !/脚本|代码|函数|接口|扩展|插件/.test(event.prompt);
    forceImageTool = imageRequest;
  });
  pi.on("before_provider_request", (event) => {
    if (!forceImageTool) return;
    forceImageTool = false;
    const payload = event.payload as any;
    // Only affect a standard Responses function tool when the request allows automatic selection.
    if (!Array.isArray(payload?.tools)
      || !payload.tools.some((tool: any) => tool.type === "function" && tool.name === imageTool.name)
      || (payload.tool_choice !== undefined && payload.tool_choice !== "auto")) return;
    return { ...payload, tool_choice: { type: "function", name: imageTool.name } };
  });
  pi.on("provider_stream_event", (event) => {
    const data = event.data as any;
    if (imageRequest && data?.type === "response.output_item.done" && data.item?.type === "image_generation_call") {
      // Record the unsupported item type, never image data, prompts, or credentials.
      pi.appendEntry("cpa-image-diagnostic", { model: event.model, itemType: data.item.type });
    }
  });
  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (imageRequest && msg.role === "assistant" && msg.stopReason === "stop"
      && !msg.content.some((block) => block.type === "toolCall" || (block.type === "text" && block.text.trim()))) {
      ctx.ui.notify("模型返回空回复，生图未执行。请使用 /cpa-image <提示词> 直接生图。", "warning");
    }
  });

  pi.registerCommand("cpa-image", {
    description: "直接使用 gpt-image-2 生成 1024×1024 PNG，不经过聊天模型工具选择。",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("用法：/cpa-image <提示词>", "warning");
        return;
      }
      ctx.ui.notify("正在通过 Images API 生图（gpt-image-2）…", "info");
      try {
        const result = await imageTool.execute("cpa-image-command", {
          prompt, model: "gpt-image-2", size: "1024x1024", outputFormat: "png",
        }, ctx.signal, undefined, ctx);
        pi.sendMessage({ customType: "cpa-image-result", content: result.content, details: result.details, display: true }, { triggerTurn: false });
      } catch (err) {
        pi.sendMessage({ customType: "cpa-image-result", content: `生图失败：${message(err)}`, details: { isError: true }, display: true }, { triggerTurn: false });
      }
    },
  });
}

function parseImageResponse(text: string): { data?: string; revisedPrompt?: string; error?: string } {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "无法解析 Images API 返回的 JSON。" };
  }

  const apiError = value?.error;
  if (apiError && typeof apiError.message === "string") return { error: apiError.message };

  const item = Array.isArray(value?.data)
    ? value.data.find((entry: any) => entry && typeof entry === "object")
    : undefined;
  if (typeof item?.b64_json === "string") {
    return {
      data: item.b64_json,
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
    };
  }

  return { error: "Images API 响应中没有找到 data[0].b64_json。" };
}

function imageEndpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/images/generations")) return normalized;
  if (normalized.endsWith("/responses")) return normalized.replace(/\/responses$/, "/images/generations");
  if (normalized.endsWith("/v1")) return `${normalized}/images/generations`;
  return `${normalized}/v1/images/generations`;
}

async function resolveProxyConfig(ctx: any): Promise<{ apiKey?: string; baseUrl?: string }> {
  const envKey = process.env.PI_CPA_API_KEY ?? process.env.OPENAI_API_KEY;
  const envBaseUrl = process.env.PI_CPA_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const providerId = process.env.PI_CPA_PROVIDER ?? "qianjue";
  const auth = await ctx.modelRegistry.getProviderAuth(providerId).catch(() => undefined);
  const provider = ctx.modelRegistry.getProvider(providerId);
  return {
    apiKey: envKey ?? auth?.auth.apiKey,
    baseUrl: envBaseUrl ?? auth?.auth.baseUrl ?? provider?.baseUrl,
  };
}

function error(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text }], details, isError: true } as any;
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
