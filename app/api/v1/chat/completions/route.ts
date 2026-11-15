import { randomUUID } from "node:crypto";
import { cloudDbProxy } from "@/lib/cloud-api";
import { slideMessagesForUpstream } from "@/lib/context-window";
import { NoSourceError, routeChat } from "@/lib/gateway";
import { findModel } from "@/lib/models";
import { authenticatePlatformApiKey } from "@/lib/platform-api-auth";
import { isAbortError, type ChatMessage } from "@/lib/providers";
import { balance, settleAssistantMessage, createConversation, addUserMessage } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CLIENT_SYSTEM_CHARS = 20_000;

type OpenAiMessage = { role: string; content: string | { type: string; text?: string }[] };

function extractTextContent(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p && "text" in p ? String(p.text ?? "") : ""))
    .join("");
}

function normalizeMessages(raw: OpenAiMessage[]): {
  messages: ChatMessage[];
  clientSystemPrompt?: string;
} {
  const systemChunks: string[] = [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const content = extractTextContent(m.content);
    if (!content.trim()) continue;
    const role = m.role?.toLowerCase?.() ?? m.role;
    if (role === "system" || role === "developer") {
      systemChunks.push(content.trim());
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role: role as "user" | "assistant", content });
  }
  const merged = systemChunks.join("\n\n").trim();
  return {
    messages: slideMessagesForUpstream(out),
    clientSystemPrompt: merged ? merged.slice(0, MAX_CLIENT_SYSTEM_CHARS) : undefined,
  };
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * OpenAI 相容出租接口（封測）。
 * Authorization: Bearer sk_...（users.api_key 或 PLATFORM_API_KEYS）
 * Body: { model, messages, stream? }
 * system／developer 會合併為 customSystemPrompt 透傳上游。
 */
export async function POST(req: Request) {
  const proxied = await cloudDbProxy(req);
  if (proxied) return proxied;
  const auth = await authenticatePlatformApiKey(req);
  if (!auth) {
    return Response.json(
      {
        error: {
          message: "Invalid API key. Use your sk_live_… from the dashboard, or PLATFORM_API_KEYS admin key.",
          type: "invalid_request_error",
        },
      },
      { status: 401 },
    );
  }

  const userId = auth.user.id;

  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    messages?: OpenAiMessage[];
    stream?: boolean;
  };

  const model = findModel(body.model ?? "");
  if (!model) {
    return Response.json({ error: { message: `Unknown model: ${body.model}`, type: "invalid_request_error" } }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: { message: "messages required", type: "invalid_request_error" } }, { status: 400 });
  }

  if ((await balance(userId)) <= 0) {
    return Response.json({ error: { message: "Insufficient credits", type: "insufficient_quota" } }, { status: 402 });
  }

  const { messages, clientSystemPrompt } = normalizeMessages(body.messages);
  if (!messages.length || messages[0].role !== "user") {
    return Response.json(
      { error: { message: "messages must include a user turn", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // 影子對話：只記本輪最後一則 user（完整上下文由客戶端 messages 提供）
  const lastUser = [...messages].reverse().find((m) => m.role === "user")!;
  const convId = await createConversation(userId, lastUser.content.slice(0, 30), model.id);
  await addUserMessage(convId, lastUser.content, model.id);

  const completionId = `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const wantStream = Boolean(body.stream);

  if (wantStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(sse(obj)));
        let answer = "";
        try {
          send({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });

          for await (const ev of routeChat(model, messages, userId, req.signal, undefined, clientSystemPrompt)) {
            if (ev.type === "text") {
              answer += ev.text;
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: model.id,
                choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
              });
            }
            if (ev.type === "done") {
              await settleAssistantMessage({
                userId,
                conversationId: convId,
                content: answer,
                model: model.id,
                sourceId: ev.sourceId,
                inputTokens: ev.usage.inputTokens,
                cachedInputTokens: ev.usage.cachedInputTokens,
                outputTokens: ev.usage.outputTokens,
                officialCostPoints: ev.officialCostPoints,
                chargedPoints: ev.chargedPoints,
                jobId: ev.jobId,
              });
              send({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: model.id,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: ev.usage.inputTokens,
                  completion_tokens: ev.usage.outputTokens,
                  total_tokens: ev.usage.inputTokens + ev.usage.outputTokens,
                },
              });
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          if (req.signal.aborted || isAbortError(e)) {
            // 客戶端取消：安靜結束
          } else {
            const msg =
              e instanceof NoSourceError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : String(e);
            send({ error: { message: msg, type: "server_error" } });
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  // non-stream
  let answer = "";
  let doneEv: Awaited<ReturnType<typeof collectDone>> | null = null;
  try {
    doneEv = await collectDone(model, messages, userId, req.signal, (t) => {
      answer += t;
    }, clientSystemPrompt);
  } catch (e) {
    const status = e instanceof NoSourceError ? 503 : 500;
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e), type: "server_error" } },
      { status },
    );
  }

  await settleAssistantMessage({
    userId,
    conversationId: convId,
    content: answer,
    model: model.id,
    sourceId: doneEv.sourceId,
    inputTokens: doneEv.usage.inputTokens,
    cachedInputTokens: doneEv.usage.cachedInputTokens,
    outputTokens: doneEv.usage.outputTokens,
    officialCostPoints: doneEv.officialCostPoints,
    chargedPoints: doneEv.chargedPoints,
    jobId: doneEv.jobId,
  });

  return Response.json({
    id: completionId,
    object: "chat.completion",
    created,
    model: model.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: doneEv.usage.inputTokens,
      completion_tokens: doneEv.usage.outputTokens,
      total_tokens: doneEv.usage.inputTokens + doneEv.usage.outputTokens,
    },
  });
}

async function collectDone(
  model: Parameters<typeof routeChat>[0],
  messages: ChatMessage[],
  userId: string,
  signal: AbortSignal | undefined,
  onText: (t: string) => void,
  customSystemPrompt?: string,
) {
  let done: {
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    officialCostPoints: number;
    chargedPoints: number;
    sourceId: string;
    jobId?: string;
  } | null = null;

  for await (const ev of routeChat(model, messages, userId, signal, undefined, customSystemPrompt)) {
    if (ev.type === "text") onText(ev.text);
    if (ev.type === "done") {
      done = {
        usage: ev.usage,
        officialCostPoints: ev.officialCostPoints,
        chargedPoints: ev.chargedPoints,
        sourceId: ev.sourceId,
        jobId: ev.jobId,
      };
    }
  }
  if (!done) throw new Error("No completion");
  return done;
}
