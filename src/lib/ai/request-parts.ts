import type Anthropic from "@anthropic-ai/sdk";

/**
 * Helpers for AI engines that are not the Anthropic API: FlipWatch builds every request in the Anthropic
 * Messages shape, and each engine translates it (and its answer back into an Anthropic.Message).
 */

export function systemText(system: Anthropic.MessageCreateParamsNonStreaming["system"]): string | undefined {
  if (!system) return undefined;
  return typeof system === "string" ? system : system.map((block) => block.text).join("\n\n");
}

/** All text of the conversation's messages (images dropped). */
export function userText(messages: Anthropic.MessageParam[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
            .map((block) => block.text)
            .join("\n\n"),
    )
    .join("\n\n");
}

/** The JSON Schema the answer must follow, when the request asks for structured output. */
export function outputSchema(body: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> | null {
  const format = body.output_config?.format;
  return format?.type === "json_schema" ? (format.schema as Record<string, unknown>) : null;
}

/** Wrap an engine's answer as the Anthropic.Message the rest of the app reads. */
export function asMessage(
  model: string,
  text: string,
  opts: { stop?: Anthropic.Message["stop_reason"]; inputTokens?: number; outputTokens?: number } = {},
): Anthropic.Message {
  return {
    id: "engine",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: opts.stop ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as Anthropic.Message;
}
