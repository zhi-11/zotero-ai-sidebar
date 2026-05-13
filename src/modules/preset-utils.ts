import { getProvider } from "../providers/factory";
import type { Message } from "../providers/types";
import { savePresets, zoteroPrefs } from "../settings/storage";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  REASONING_EFFORT_OPTIONS,
  type AgentPermissionMode,
  type ModelPreset,
  type ProviderKind,
  type ReasoningEffort,
} from "../settings/types";

export interface PresetState {
  presets: ModelPreset[];
  selectedId: string | null;
  sending?: boolean;
}

export function selectedPreset(state: PresetState): ModelPreset | null {
  return (
    state.presets.find((p) => p.id === state.selectedId) ??
    state.presets[0] ??
    null
  );
}

export function selectedChatPreset(state: PresetState): ModelPreset | null {
  const presets = configuredPresets(state);
  return presets.find((p) => p.id === state.selectedId) ?? presets[0] ?? null;
}

export function configuredPresets(state: PresetState): ModelPreset[] {
  return state.presets.filter(isPresetConfigured);
}

export function isPresetConfigured(preset: ModelPreset): boolean {
  return !!preset.apiKey.trim() && !!preset.model.trim();
}

export function agentPermissionMode(
  preset: ModelPreset | null | undefined,
): AgentPermissionMode {
  return preset?.extras?.agentPermissionMode === "yolo" ? "yolo" : "default";
}

export function withAgentPermissionMode(
  preset: ModelPreset,
  mode: AgentPermissionMode,
): ModelPreset {
  return {
    ...preset,
    extras: {
      ...preset.extras,
      agentPermissionMode: mode,
    },
  };
}

// Reasoning effort is editable for any preset that actually consumes it:
// OpenAI Responses presets always do; Anthropic presets do iff their vendor
// is Claude or DeepSeek (compat = unknown third-party that never gets a
// thinking field, so the control is meaningless and stays disabled).
export function isReasoningDisabledForDraft(draft: ModelPreset): boolean {
  if (draft.provider === "openai") return false;
  if (draft.provider === "anthropic") {
    const vendor = draft.extras?.vendor ?? "compat";
    return vendor === "compat";
  }
  return true;
}

// DeepSeek's Anthropic-format endpoint advertises only two effective effort
// values — high and max (their docs note 3: low/medium → high, xhigh →
// max). The composer dropdown for DeepSeek presets surfaces just those, so
// users can't pick a level that silently maps to something else.
const REASONING_EFFORT_OPTIONS_DEEPSEEK: Array<[ReasoningEffort, string]> = [
  ['high', 'High - 标准思考（DeepSeek 默认）'],
  // We persist 'xhigh' on the preset; on the wire DeepSeek reads it as
  // max. Same approach used by the translate panel for consistency.
  ['xhigh', 'Max - 强思考（复杂任务）'],
];

export function reasoningEffortOptionsForPreset(
  preset: ModelPreset,
): Array<[ReasoningEffort, string]> {
  if (preset.provider === 'anthropic' && preset.extras?.vendor === 'deepseek') {
    return REASONING_EFFORT_OPTIONS_DEEPSEEK;
  }
  return REASONING_EFFORT_OPTIONS;
}

// Collapse a persisted effort to one that exists in the preset's visible
// option list. Currently only DeepSeek collapses — low/medium → high.
export function collapseReasoningForPreset(
  preset: ModelPreset,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (preset.provider === 'anthropic' && preset.extras?.vendor === 'deepseek') {
    if (effort === 'low' || effort === 'medium') return 'high';
  }
  return effort;
}

export function withReasoningEffort(
  preset: ModelPreset,
  effort: ReasoningEffort,
): ModelPreset {
  return {
    ...preset,
    extras: {
      ...preset.extras,
      reasoningEffort: effort,
    },
  };
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return (
    REASONING_EFFORT_OPTIONS.find(([value]) => value === effort)?.[1] ?? effort
  );
}

export function reasoningEffortShortLabel(effort: ReasoningEffort): string {
  const label = reasoningEffortLabel(effort);
  return label.split(" - ")[0] || label;
}

export function persist(state: PresetState) {
  savePresets(zoteroPrefs(), state.presets);
}

export function upsertPreset(state: PresetState, next: ModelPreset) {
  const index = state.presets.findIndex((p) => p.id === next.id);
  state.presets =
    index >= 0
      ? state.presets.map((p) => (p.id === next.id ? next : p))
      : [...state.presets, next];
}

export function presetSelectLabel(preset: ModelPreset): string {
  return `${preset.label} (${preset.provider})`;
}

export function updateToolbarOption(mount: HTMLElement, preset: ModelPreset) {
  const option = Array.from(
    mount.querySelectorAll(".preset-switcher option"),
  ).find((node) => (node as HTMLOptionElement).value === preset.id) as
    | HTMLOptionElement
    | undefined;
  if (option) {
    option.textContent = presetSelectLabel(preset);
  }
}

export async function testPresetConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<{ message: string; preset: ModelPreset }> {
  if (!preset.apiKey.trim()) throw new Error("API Key 为空");
  if (!preset.model.trim()) throw new Error("Model 为空");
  if (preset.provider === "openai") {
    return testOpenAIConnectivity(preset, signal);
  }

  const testPreset = {
    ...preset,
    maxTokens: Math.min(Math.max(preset.maxTokens || 256, 256), 512),
  };
  const messages: Message[] = [{ role: "user", content: "Reply OK." }];
  const provider = getProvider(testPreset);
  let sawAnyChunk = false;

  for await (const chunk of provider.stream(
    messages,
    "Connectivity test. Reply with OK only.",
    testPreset,
    signal,
  )) {
    if (chunk.type === "error") throw new Error(chunk.message);
    sawAnyChunk = true;
    if (chunk.type === "text_delta" || chunk.type === "usage") break;
  }

  return {
    preset,
    message: sawAnyChunk
      ? `连接成功：${preset.provider} / ${preset.model}`
      : `连接完成：${preset.provider} / ${preset.model}`,
  };
}

async function testOpenAIConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<{ message: string; preset: ModelPreset }> {
  const withMaxTokens = await requestOpenAIConnectivity(preset, signal, true);
  if (withMaxTokens.ok) {
    return {
      preset: withOmitMaxOutputTokens(preset, false),
      message: `连接成功：${preset.provider} / ${preset.model}（支持 Max tokens）`,
    };
  }

  if (!isUnsupportedMaxOutputTokens(withMaxTokens.body)) {
    throw new Error(openAITestErrorMessage(withMaxTokens));
  }

  const withoutMaxTokens = await requestOpenAIConnectivity(
    preset,
    signal,
    false,
  );
  if (!withoutMaxTokens.ok) {
    throw new Error(openAITestErrorMessage(withoutMaxTokens));
  }

  return {
    preset: withOmitMaxOutputTokens(preset, true),
    message:
      `连接成功：${preset.provider} / ${preset.model}` +
      "（服务不支持 Max tokens，已保存为不发送）",
  };
}

type OpenAITestResult =
  | { ok: true }
  | { ok: false; status: number; body: string };

async function requestOpenAIConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
  includeMaxOutputTokens: boolean,
): Promise<OpenAITestResult> {
  const body = {
    model: preset.model,
    instructions: "Connectivity test. Reply OK only.",
    input: [{ role: "user", content: "Reply OK." }],
    ...(includeMaxOutputTokens ? { max_output_tokens: 256 } : {}),
    reasoning:
      preset.provider === "openai"
        ? {
            effort: preset.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
            ...(preset.extras?.reasoningSummary === "none"
              ? {}
              : {
                  summary:
                    preset.extras?.reasoningSummary ??
                    DEFAULT_REASONING_SUMMARY,
                }),
          }
        : undefined,
    stream: true,
    store: false,
  };
  const response = await fetch(openAIResponsesUrl(preset.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${preset.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  return {
    ok: false,
    status: response.status,
    body: await response.text(),
  };
}

function openAIResponsesUrl(baseUrl: string): string {
  const root = baseUrl.trim() || "https://api.openai.com/v1";
  return `${root.replace(/\/+$/, "")}/responses`;
}

function isUnsupportedMaxOutputTokens(body: string): boolean {
  return /unsupported parameter:\s*max_output_tokens|max_output_tokens.*unsupported/i.test(
    body,
  );
}

function openAITestErrorMessage(
  result: Exclude<OpenAITestResult, { ok: true }>,
) {
  return `HTTP ${result.status}: ${result.body || "no body"}`;
}

function withOmitMaxOutputTokens(
  preset: ModelPreset,
  omit: boolean,
): ModelPreset {
  const extras = { ...preset.extras };
  if (omit) extras.omitMaxOutputTokens = true;
  else delete extras.omitMaxOutputTokens;
  return { ...preset, extras };
}

export function presetSignature(preset: ModelPreset): string {
  return JSON.stringify({
    id: preset.id,
    provider: preset.provider,
    label: preset.label,
    apiKey: preset.apiKey,
    baseUrl: preset.baseUrl,
    model: preset.model,
    models: preset.models ?? [],
    maxTokens: preset.maxTokens,
    extras: preset.extras ?? {},
  });
}

export function sanitizedTestError(err: unknown, apiKey: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (apiKey) message = message.split(apiKey).join("[API_KEY]");
  if (message.toLowerCase().includes("abort")) {
    return "连接超时或已取消";
  }
  return `连接失败：${message}`;
}

export function updateSendControls(mount: HTMLElement, state: PresetState) {
  const preset = selectedChatPreset(state);
  const ready = !!preset?.apiKey && !!preset.model && !state.sending;
  const textarea = mount.querySelector(
    ".input-row textarea",
  ) as HTMLTextAreaElement | null;
  const button = mount.querySelector(
    ".input-row button",
  ) as HTMLButtonElement | null;
  if (textarea) {
    textarea.disabled = !preset;
  }
  if (button && button.textContent === "发送") {
    button.disabled = !ready;
    button.title = preset && !ready ? "请先填写 API Key 和 Model ID" : "";
  }
}

export function makePreset(provider: ProviderKind): ModelPreset {
  return {
    id: makeId(),
    provider,
    label: provider === "anthropic" ? "Claude" : "GPT",
    apiKey: "",
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: DEFAULT_MODELS[provider],
    maxTokens: 8192,
    extras:
      provider === "openai"
        ? {
            reasoningEffort: DEFAULT_REASONING_EFFORT,
            reasoningSummary: DEFAULT_REASONING_SUMMARY,
            agentPermissionMode: "default",
          }
        : {
            agentPermissionMode: "default",
          },
  };
}

function makeId(): string {
  return `preset-${Date.now()}-${Zotero.Utilities.randomString(6)}`;
}

