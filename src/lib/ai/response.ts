import type Anthropic from "@anthropic-ai/sdk";
import { AiRequestError } from "./errors";

/** The concatenated text of a response, or a descriptive error for refusals and truncation. */
export function responseText(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    throw new AiRequestError(`Claude declined to answer${category ? ` (${category})` : ""}`, { type: "refusal" });
  }
  if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
    throw new AiRequestError("Claude's answer was cut off before it finished", { type: "max_tokens" });
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new AiRequestError("Claude returned an empty answer");
  return text;
}
