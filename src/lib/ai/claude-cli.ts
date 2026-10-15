import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import type { AiClient } from "./client";
import { AiRequestError } from "./errors";

/**
 * AI_PROVIDER=claude-cli: answer requests with the locally installed Claude Code CLI (`claude -p`),
 * which runs on the account it is logged in with instead of an ANTHROPIC_API_KEY. Tools, MCP servers
 * and session files are all disabled: every call is a single stateless completion.
 *
 * Limitations compared with the API: image blocks are dropped (listing photos are not sent), and
 * usage counts against the logged-in plan's limits.
 */

/** Per-request limit. Ranking ~200 listings in one go can take a few minutes through the CLI. */
export const CLI_TIMEOUT_MS = 360_000;

/**
 * Folders where the Claude desktop app keeps its bundled CLI (one subfolder per version). The app is an
 * MSIX package, so its %APPDATA% writes really live in its package folder: processes the app launches see
 * them at %APPDATA%\Claude\claude-code, everything else (e.g. FlipWatch started by Task Scheduler) only at
 * %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude-code.
 */
function desktopCliRoots(): string[] {
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "Claude", "claude-code"));
  if (process.env.LOCALAPPDATA) {
    const packages = path.join(process.env.LOCALAPPDATA, "Packages");
    try {
      for (const dir of readdirSync(packages)) {
        if (/^Claude_/i.test(dir)) roots.push(path.join(packages, dir, "LocalCache", "Roaming", "Claude", "claude-code"));
      }
    } catch {
      // no packaged apps
    }
  }
  return roots;
}

/** CLAUDE_CLI_PATH, else the newest CLI bundled with the Claude desktop app, else `claude` on PATH. */
export function resolveClaudeCliPath(): string {
  if (config.claudeCliPath) return config.claudeCliPath;
  if (process.platform === "win32") {
    const found: Array<{ version: string; exe: string }> = [];
    for (const root of desktopCliRoots()) {
      try {
        for (const version of readdirSync(root)) {
          // Older apps keep <version>\claude.exe; newer ones <version>\<build hash>\claude.exe.
          const dir = path.join(root, version);
          const candidates = [path.join(dir, "claude.exe")];
          try {
            for (const build of readdirSync(dir)) candidates.push(path.join(dir, build, "claude.exe"));
          } catch {
            // not a directory
          }
          const exe = candidates.filter((c) => existsSync(c)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
          if (exe) found.push({ version, exe });
        }
      } catch {
        // this location doesn't exist
      }
    }
    found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    const latest = found.at(-1);
    if (latest) return latest.exe;
  }
  return "claude";
}

function systemText(system: Anthropic.MessageCreateParamsNonStreaming["system"]): string | undefined {
  if (!system) return undefined;
  return typeof system === "string" ? system : system.map((block) => block.text).join("\n\n");
}

function userText(messages: Anthropic.MessageParam[]): string {
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

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function runCli(args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const env = { ...process.env };
  // Use the CLI's own login, never a key that happens to be in this process's environment.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ resolveClaudeCliPath(), args, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AiRequestError(`Could not start the Claude CLI (${resolveClaudeCliPath()}): ${err.message}`, { cause: err }));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (sig) return reject(new AiRequestError(signal?.aborted ? "Claude CLI request was aborted" : "Claude CLI request timed out"));
      // With --output-format json, errors are usually still reported as a JSON result on stdout.
      if (code !== 0 && !stdout.trim()) {
        return reject(new AiRequestError(`Claude CLI exited with code ${code}: ${stderr.trim().slice(0, 160) || "no output"}`));
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

export function createClaudeCliClient(): AiClient {
  return {
    messages: {
      async create(body, options) {
        const args = ["-p", "--output-format", "json", "--model", body.model, "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
        const system = systemText(body.system);
        if (system) args.push("--system-prompt", system);
        const format = body.output_config?.format;
        if (format?.type === "json_schema") args.push("--json-schema", JSON.stringify(format.schema));

        const timeout = Math.max(typeof options?.timeout === "number" ? options.timeout : CLI_TIMEOUT_MS, CLI_TIMEOUT_MS);
        const input = userText(body.messages);
        let stdout: string;
        try {
          stdout = await runCli(args, input, timeout, options?.signal ?? undefined);
        } catch (err) {
          // A slow answer is usually a one-off; try once more before giving up (not when the caller aborted).
          if (!(err instanceof AiRequestError) || !/timed out/.test(err.message) || options?.signal?.aborted) throw err;
          stdout = await runCli(args, input, timeout, options?.signal ?? undefined);
        }

        let result: CliResult;
        try {
          result = JSON.parse(stdout) as CliResult;
        } catch {
          throw new AiRequestError(`Claude CLI returned unreadable output: ${stdout.trim().slice(0, 160)}`);
        }
        if (result.is_error || result.subtype !== "success") {
          const detail = (result.result ?? result.subtype ?? "unknown error").toString().slice(0, 160);
          throw new AiRequestError(`Claude CLI error: ${detail}`, { status: result.api_error_status ?? null });
        }

        const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : (result.result ?? "");
        const usage = result.usage ?? {};
        return {
          id: "cli",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
          },
        } as Anthropic.Message;
      },
    },
  };
}
