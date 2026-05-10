import Anthropic from "@anthropic-ai/sdk";
import { currentOperator } from "@/lib/operators";

// Claude Opus 4.7 — most capable model, step-change in agentic coding over 4.6.
// 1M context, 128k max output. Pricing: $5/MTok in, $25/MTok out.
// https://platform.claude.com/docs/en/docs/about-claude/models/overview
export const CLAUDE_MODEL = "claude-opus-4-7";

// One Anthropic instance per operator. SDK construction is cheap, but caching
// keeps any HTTP keep-alive warm across calls within a single function instance.
const clientCache = new Map<string, Anthropic>();

function getClient(): Anthropic {
  const op = currentOperator();
  let client = clientCache.get(op.email);
  if (!client) {
    client = new Anthropic({ apiKey: op.anthropicKey });
    clientCache.set(op.email, client);
  }
  return client;
}

/** Test-only: clear the cached clients so getClient() rebuilds. */
export function __resetClaudeForTests(): void {
  clientCache.clear();
}

/**
 * Generate text from Claude. Caches the system prompt so repeated calls with
 * the same system prompt are cheap.
 */
export async function generateText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const res = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    system: [
      {
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: opts.user }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }
  return textBlock.text;
}

/**
 * Force structured JSON output via tool use. Returns the parsed object.
 */
export async function generateJSON<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  toolName?: string;
  maxTokens?: number;
  /** 0-1. Default omitted (Claude's default ≈ deterministic on tool use).
   *  Bump to ~1 for tasks where you actually want variety between calls
   *  (suggestions, exploratory generation). */
  temperature?: number;
}): Promise<T> {
  const toolName = opts.toolName ?? "submit";
  const res = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    system: [
      {
        type: "text",
        text: opts.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: toolName,
        description: "Submit the final structured response.",
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: opts.user }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return structured output");
  }
  return toolUse.input as T;
}
