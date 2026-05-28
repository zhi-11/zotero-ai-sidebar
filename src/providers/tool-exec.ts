import type { AgentTool, ToolExecutionResult } from "./types";
import type { AgentPermissionMode } from "../settings/types";

export interface ToolRunOutcome {
  status: "completed" | "error";
  result: ToolExecutionResult;
}

// Shared local-tool execution for every provider tool loop. This is the SINGLE
// place that enforces the requiresApproval/YOLO gate — CLAUDE.md non-negotiable
// "No hidden Zotero writes". Both the OpenAI Responses loop and the Anthropic
// Messages loop funnel through here so the gate cannot diverge.
//
// `args` is the already-parsed argument object: OpenAI parses its function_call
// `arguments` JSON string first, while Anthropic's `tool_use.input` arrives
// parsed. Keeping parsing in the callers lets each surface its own
// provider-shaped "invalid arguments" error.
export async function runValidatedTool(
  toolMap: Map<string, AgentTool>,
  name: string,
  args: unknown,
  signal: AbortSignal,
  permissionMode: AgentPermissionMode,
): Promise<ToolRunOutcome> {
  if (signal.aborted) {
    return {
      status: "error",
      result: { output: "Tool call aborted.", summary: "工具调用已停止" },
    };
  }

  const tool = toolMap.get(name);
  if (!tool) {
    return {
      status: "error",
      result: {
        output: `Unknown local tool: ${name}`,
        summary: `未知工具 ${name}`,
      },
    };
  }

  // INVARIANT: write tools (annotations, future Zotero mutations) MUST gate
  // through requiresApproval. In default mode they refuse; only YOLO mode
  // bypasses. There is no UI approval prompt yet — that is the planned path
  // mirroring Codex's `AskForApproval::OnRequest`.
  if (tool.requiresApproval && permissionMode !== "yolo") {
    return {
      status: "error",
      result: {
        output: `Local tool ${name} requires approval. Enable YOLO mode to run it without approval.`,
        summary: `需要审批: ${name}`,
      },
    };
  }

  try {
    return { status: "completed", result: await tool.execute(args) };
  } catch (err) {
    return {
      status: "error",
      result: {
        output: err instanceof Error ? err.message : String(err),
        summary: `工具执行失败: ${name}`,
      },
    };
  }
}
