/** Offline stand-ins for the Anthropic client (test-only). */
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import type { AiClient } from "../client";

export interface RecordedCall {
  body: Anthropic.MessageCreateParamsNonStreaming;
  options?: Anthropic.RequestOptions;
}

export type FakeResponder = (body: Anthropic.MessageCreateParamsNonStreaming, callIndex: number) => Anthropic.Message | Promise<Anthropic.Message>;

export interface FakeClient extends AiClient {
  calls: RecordedCall[];
}

/** A client whose `messages.create` records every call and answers through `respond` (throw to simulate API errors). */
export function createFakeClient(respond: FakeResponder): FakeClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    messages: {
      async create(body, options) {
        calls.push({ body: structuredClone(body), options });
        return respond(body, calls.length - 1);
      },
    },
  };
}

export function textMessage(
  text: string,
  overrides: { stopReason?: Anthropic.StopReason; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {},
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: overrides.model ?? "claude-haiku-4-5-20251001",
    container: null,
    diagnostics: null,
    content: [{ type: "text", text, citations: null }],
    stop_reason: overrides.stopReason ?? "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: overrides.inputTokens ?? 1200,
      output_tokens: overrides.outputTokens ?? 250,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: overrides.cacheReadTokens ?? null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

export function jsonMessage(value: unknown, overrides?: Parameters<typeof textMessage>[1]): Anthropic.Message {
  return textMessage(JSON.stringify(value), overrides);
}

/** The typed SDK error the real client would throw for this HTTP status. */
export function apiError(status: number, type: string, message: string): APIError {
  return APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers({ "request-id": "req_test" }));
}

/** Content blocks of the first user message of a recorded call. */
export function userContent(call: RecordedCall): Anthropic.ContentBlockParam[] {
  const content = call.body.messages[0]?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content ?? [];
}

export function userText(call: RecordedCall): string {
  return userContent(call)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}
