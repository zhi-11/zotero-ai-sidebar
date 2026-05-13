import type { PrefsStore } from './storage';

export type BuiltInPromptID =
  | 'summary'
  | 'readingRoute'
  | 'fullTextHighlight'
  | 'explainSelection';

export interface BuiltInPromptSettings {
  summary: string;
  readingRoute: string;
  fullTextHighlight: string;
  explainSelection: string;
}

export interface CustomPromptButton {
  id: string;
  label: string;
  prompt: string;
  shortcut?: string;
}

export interface QuickPromptSettings {
  builtIns: BuiltInPromptSettings;
  customButtons: CustomPromptButton[];
  selectionQuestionAnnotationEnabled: boolean;
}

export const DEFAULT_SUMMARY_PROMPT = [
  '请用中文总结这篇论文，按以下小标题分段输出（每段 1-3 句，可用 `- ` 列要点）：',
  '## 研究背景与问题',
  '## 核心方法',
  '## 关键公式 / 算法步骤',
  '## 主要贡献',
  '## 实验结果与结论',
  '## 适用场景',
  '## 局限性 / 不适用情形',
  '## 后续改进方向',
  '',
  '最后用一句话总体概括。',
].join('\n');

export const DEFAULT_READING_ROUTE_PROMPT = [
  '请参考 Keshav 的 three-pass approach，为当前论文生成一份“阅读路线”，而不是普通论文摘要。',
  '',
  '请先调用 zotero_get_current_item 获取标题、作者、年份、摘要等元数据；如果需要判断章节、图表、公式、实验或参考文献，请调用 zotero_get_full_pdf 或有针对性地检索/读取 PDF 内容。',
  '',
  '输出要求：',
  '## 0. 结论先行',
  '- 建议阅读深度：精读 / 粗读 / 暂时跳过（三选一）',
  '- 建议投入时间：',
  '- 判断依据：',
  '- 如果只看 10 分钟，应该看：',
  '',
  '## 1. 第一遍：读前判断',
  '- Category：这是什么类型的论文？',
  '- Context：它和哪些方向、问题或已有工作相关？',
  '- Correctness：主要假设初看是否可信？哪些地方需要后续验证？',
  '- Contributions：真正值得关注的贡献是什么？',
  '- Clarity：写作和结构是否清楚？',
  '- 是否值得继续读：',
  '',
  '## 2. 第二遍：重点阅读路线',
  '- 必读章节：',
  '- 必看图表：',
  '- 必看公式 / 算法：',
  '- 可以暂时跳过的细节：',
  '- 需要补的背景知识：',
  '- 建议追踪的参考文献：',
  '',
  '## 3. 第三遍：精读审视清单',
  '- 如果要复现，需要重建什么流程：',
  '- 需要重点挑战的假设：',
  '- 实验 / 证明中最需要检查的地方：',
  '- 可能的薄弱点：',
  '- 可以发展的后续问题：',
  '',
  '## 4. 下一步动作',
  '- 现在先读：',
  '- 读到哪里适合用“解释选区”：',
  '- 什么时候再用“全文重点”：',
  '- 是否还需要普通摘要：',
  '',
  '边界：',
  '- 不要写成普通“背景 / 方法 / 实验 / 贡献 / 局限”的完整论文摘要。',
  '- 只在支持阅读决策时简要提及论文内容。',
  '- 每个部分都必须落到可执行阅读动作：继续读、跳过、重点看、需要质疑、需要补背景。',
  '- 不要调用 zotero_append_to_note、zotero_annotate_passage 或任何写入/标注工具；插件会在回答完成后自动保存到专用阅读路线笔记。',
].join('\n');

export const DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT = [
  '请执行以下流程，对当前 PDF 标注重点：',
  '',
  '1. 先调用 zotero_get_current_item，读取标题、作者、年份和摘要；用摘要建立论文主线（研究问题、方法、结果、结论）。',
  '2. 再调用 zotero_get_reader_pdf_text，读取当前 Reader 的 PDF 文本层。注意：后续要高亮的 text 必须从这个工具输出中逐字复制，不要从 zotero_get_full_pdf 复制。',
  '3. 如果工具输出显示全文被截断（Truncated: yes / sent chars < total chars），请继续调用 zotero_get_reader_pdf_text 并传入 start/end 补读未覆盖的关键范围。',
  '4. 通读后，按用户要求和内容需要选出最值得标注的重点句（论点、关键定义、核心结果、关键限制、贡献点等）；未指定数量时建议 5–10 条。优先选择能支撑摘要主线的正文原句；避免标摘要性的整段、避免标公式。如果摘要里有高度概括贡献/结论的关键句，最多标 1 条。',
  '5. 对每一条调用 zotero_annotate_passage：',
  '   - text 字段必须是 PDF 中的逐字原文，不要改写、不要翻译、不要省略标点。',
  '   - comment 字段用中文，格式 "类别：理由"（如 "方法：先生成低分辨 attention 再上采样"），≤ 80 字。',
  '   - color 字段：按工具参数里的颜色预设描述挑 hex，注意类别映射可能与色彩直觉相反；类别不明确就不传。',
  '6. 全部标注完成后，再用一段中文总结：摘要主线、标了哪几句、正文补充了什么、可能漏掉的角度。',
  '',
  '注意：',
  '- 只有本次全文标注需要写入 PDF；不要调用与本任务无关的写工具。',
  '- 如果某句调用 zotero_annotate_passage 返回 "Passage not found"，可以稍微改写后重试（保持原句 80% 以上文字不变）；连续两次都找不到就放弃这句、继续下一条。',
].join('\n');

export const DEFAULT_EXPLAIN_SELECTION_PROMPT = [
  '请解释当前 PDF 选区的文字，总长度控制在 200-400 字。默认结合本轮已附带的附近上下文分析：先说明选区本身在说什么，再说明它在上下文中的作用，以及为什么值得关注。如果当前选区是在提出观点、给出论据/证据、定义概念、说明方法细节、承接/转折、限制条件或结论，请明确说出它属于哪一类；如果是观点或论据，必须说清楚这句话在论证链条里的作用。',
  '',
  '如果已附带的附近上下文仍不足，且当前模型可以调用 Zotero 工具，请继续用 zotero_search_pdf 或 zotero_read_pdf_range 读取更多相邻内容后再判断；避免基于孤立句子作过度推断。凡现有证据不足以支持的判断，请明确标注为“基于当前上下文尚不能确定”。',
  '',
  '系统会另行注入“建议注释”输出格式，按其要求列出要点即可，无需在本提示中重复格式说明。如果当前没有可用 PDF 选区，请提示我先选中文本。',
].join('\n');

export const DEFAULT_QUICK_PROMPT_SETTINGS: QuickPromptSettings = {
  builtIns: {
    summary: DEFAULT_SUMMARY_PROMPT,
    readingRoute: DEFAULT_READING_ROUTE_PROMPT,
    fullTextHighlight: DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT,
    explainSelection: DEFAULT_EXPLAIN_SELECTION_PROMPT,
  },
  customButtons: [],
  // Default ON: a free-form selection question gets a "建议注释" card with
  // both 💾 高亮+评论 and 🅣 新增文字 save buttons, so the user picks the
  // annotation type by clicking — no need to type "用 T 工具" in the prompt.
  selectionQuestionAnnotationEnabled: true,
};

const KEY = 'extensions.zotero-ai-sidebar.quickPrompts';
const MAX_CUSTOM_BUTTONS = 12;
const MAX_LABEL_CHARS = 32;
const MAX_PROMPT_CHARS = 20_000;

export function loadQuickPromptSettings(prefs: PrefsStore): QuickPromptSettings {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_QUICK_PROMPT_SETTINGS;
  try {
    return normalizeQuickPromptSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_QUICK_PROMPT_SETTINGS;
  }
}

export function saveQuickPromptSettings(
  prefs: PrefsStore,
  settings: QuickPromptSettings,
): void {
  prefs.set(KEY, JSON.stringify(normalizeQuickPromptSettings(settings)));
}

export function normalizeQuickPromptSettings(value: unknown): QuickPromptSettings {
  const input = value && typeof value === 'object'
    ? (value as Partial<QuickPromptSettings>)
    : {};
  const builtIns = input.builtIns && typeof input.builtIns === 'object'
    ? (input.builtIns as Partial<BuiltInPromptSettings>)
    : {};
  return {
    builtIns: {
      summary: promptValue(builtIns.summary, DEFAULT_SUMMARY_PROMPT),
      readingRoute: promptValue(
        builtIns.readingRoute,
        DEFAULT_READING_ROUTE_PROMPT,
      ),
      fullTextHighlight: promptValue(
        builtIns.fullTextHighlight,
        DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT,
      ),
      explainSelection: promptValue(
        builtIns.explainSelection,
        DEFAULT_EXPLAIN_SELECTION_PROMPT,
      ),
    },
    customButtons: normalizeCustomButtons(input.customButtons),
    // Treat ONLY explicit `false` as off — undefined / unknown / legacy
    // shapes default to on now (the toggle previously defaulted off).
    // Existing users who saved `false` before keep their disabled state;
    // new and never-touched profiles get the suggestion card by default.
    selectionQuestionAnnotationEnabled:
      input.selectionQuestionAnnotationEnabled !== false,
  };
}

function normalizeCustomButtons(value: unknown): CustomPromptButton[] {
  if (!Array.isArray(value)) return [];
  const buttons: CustomPromptButton[] = [];
  const seen = new Set<string>();
  const seenShortcuts = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<CustomPromptButton>;
    const label = stringValue(item.label).slice(0, MAX_LABEL_CHARS);
    const prompt = stringValue(item.prompt).slice(0, MAX_PROMPT_CHARS);
    const shortcut = uniqueShortcut(item.shortcut, seenShortcuts);
    if (!prompt || (!label && !shortcut)) continue;
    const baseId = stringValue(item.id) || label || shortcut;
    const id = uniqueID(baseId, seen);
    buttons.push({ id, label, prompt, ...(shortcut ? { shortcut } : {}) });
    if (buttons.length >= MAX_CUSTOM_BUTTONS) break;
  }
  return buttons;
}

function uniqueID(value: string, seen: Set<string>): string {
  const base = value
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `prompt-${seen.size + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) id = `${base}-${suffix++}`;
  seen.add(id);
  return id;
}

function promptValue(value: unknown, fallback: string): string {
  const prompt = stringValue(value).slice(0, MAX_PROMPT_CHARS);
  return prompt || fallback;
}

function uniqueShortcut(
  value: unknown,
  seenShortcuts: Set<string>,
): string {
  const shortcut = normalizeShortcut(value);
  if (!shortcut || seenShortcuts.has(shortcut)) return '';
  seenShortcuts.add(shortcut);
  return shortcut;
}

function normalizeShortcut(value: unknown): string {
  const shortcut = stringValue(value).toLowerCase();
  return /^[a-z0-9]$/.test(shortcut) ? shortcut : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
