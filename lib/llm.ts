import OpenAI from "openai";
import { currentOperator } from "@/lib/operators";

// GPT-5.5 — OpenAI's flagship as of 2026-04. 1M context, image input,
// function calling, automatic prompt caching. Pricing: $5/MTok in, $30/MTok out.
// https://developers.openai.com/api/docs/models/gpt-5.5
export const LLM_MODEL = "gpt-5.5";

// We use the Responses API (not Chat Completions): GPT-5.5 rejects function
// tools + reasoning_effort together on /v1/chat/completions and points to
// /v1/responses, which supports the combination natively.
//
// GPT-5.5 is a reasoning model — reasoning tokens bill as output and count
// against max_output_tokens. These structured generation tasks don't need deep
// reasoning, so we keep effort low (quality stays high, cost/latency stay sane)
// and pad the token cap with headroom for the reasoning pass.
const REASONING_EFFORT = "low" as const;
const REASONING_HEADROOM = 8000;

// One OpenAI client per operator. Construction is cheap, but caching keeps any
// HTTP keep-alive warm across calls within a single function instance. Keyed by
// operator email so a leaked key only burns one operator's account.
const clientCache = new Map<string, OpenAI>();

function getClient(): OpenAI {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = new OpenAI({ apiKey: op.openaiKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cached clients so getClient() rebuilds. */
export function __resetLLMForTests(): void {
  clientCache.clear();
}

/**
 * Generate text. OpenAI caches the (long, stable) system prompt automatically
 * — no cache_control needed — so repeated calls with the same system prompt are
 * cheap. `instructions` is the system prompt; `input` is the user turn.
 */
export async function generateText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const res = await getClient().responses.create({
    model: LLM_MODEL,
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: (opts.maxTokens ?? 2048) + REASONING_HEADROOM,
    instructions: opts.system,
    input: opts.user,
  });

  const text = res.output_text;
  if (!text) throw new Error("No text response from the model");
  return text;
}

/**
 * Force structured JSON output via a single mandated function call. Non-strict —
 * the JSON schema is a strong hint, not a hard contract, mirroring how the
 * prompts treat it; callers validate the parsed object with Zod (+ their own
 * coercion) afterwards.
 *
 * Pass `images` (public URLs) to give the model vision — each is sent as an
 * input_image content part ahead of the text (used by generateStyles so the
 * model sees the rendered base before proposing restyles).
 */
export async function generateJSON<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  toolName?: string;
  maxTokens?: number;
  images?: string[];
}): Promise<T> {
  const toolName = opts.toolName ?? "submit";

  const content: OpenAI.Responses.ResponseInputContent[] = [
    ...(opts.images ?? []).map(
      (url): OpenAI.Responses.ResponseInputImage => ({
        type: "input_image",
        image_url: url,
        detail: "auto",
      })
    ),
    { type: "input_text", text: opts.user },
  ];

  const res = await getClient().responses.create({
    model: LLM_MODEL,
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: (opts.maxTokens ?? 4096) + REASONING_HEADROOM,
    instructions: opts.system,
    input: [{ role: "user", content }],
    tools: [
      {
        type: "function",
        name: toolName,
        description: "Submit the final structured response.",
        parameters: opts.schema,
        strict: false,
      },
    ],
    tool_choice: { type: "function", name: toolName },
  });

  const call = res.output.find(
    (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call"
  );
  if (!call) {
    throw new Error("Model did not return structured output");
  }
  return JSON.parse(call.arguments) as T;
}
