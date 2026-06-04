import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import {
  registerPreferences,
  unregisterPreferences,
} from "./modules/preferences";
import { loadPresets, savePresets, zoteroPrefs } from "./settings/storage";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_ANNOTATION_COLORS,
  DEFAULT_TRANSLATE_SETTINGS,
  DEFAULT_SENTENCE_EXCEPTIONS,
  type AnnotationColorPreset,
  type ModelPreset,
  type ProviderKind,
  type TranslateContextLevel,
  type TranslateOverlayPosition,
  type TranslateOverlaySize,
  type TranslateSettings,
  type TranslateThinking,
  type TranslateTriggerMode,
} from "./settings/types";
import {
  loadTranslateSettings,
  normalizeAnnotationColors,
  saveTranslateSettings,
} from "./translate/settings";
import { TranslateModeController } from "./translate/translate-mode";
import { matchesKeybinding, parseKeybinding } from "./translate/keybinding";

interface WindowState {
  monitorID?: number;
  cleanup: Array<() => void>;
}

const windowStates = new WeakMap<Window, WindowState>();
const translateControllers = new WeakMap<object, TranslateModeController>();
const liveTranslateControllers = new Set<TranslateModeController>();
let readerToolbarHandler: ((event: ReaderToolbarEvent) => void) | null = null;

const READER_TRANSLATE_GROUP_ID = "zst-reader-translate-button";
const READER_TRANSLATE_STYLE_ID = "zst-reader-translate-style";

interface ReaderToolbarEvent {
  reader: ReaderLike;
  doc: Document;
  append: (node: Node) => void;
}

interface ReaderLike {
  _internalReader?: {
    _primaryView?: {
      _iframeWindow?: Window;
      iframeWindow?: Window;
      _iframe?: { contentWindow?: Window };
      iframe?: { contentWindow?: Window };
    };
    _secondaryView?: {
      _iframeWindow?: Window;
      iframeWindow?: Window;
      _iframe?: { contentWindow?: Window };
      iframe?: { contentWindow?: Window };
    };
    _iframeWindow?: Window;
    iframeWindow?: Window;
    _iframe?: { contentWindow?: Window };
    iframe?: { contentWindow?: Window };
  };
  _window?: Window;
  window?: Window;
  _iframe?: { contentWindow?: Window };
  iframe?: { contentWindow?: Window };
  _iframeWindow?: Window;
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));
  await registerPreferences();
  registerReaderToolbarButton();
  refreshExistingReaderToolbarButtons();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`);
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-preferences.ftl`,
  );
  installTranslateShortcut(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  disableTranslateMode(win);
  const state = windowStates.get(win);
  if (state?.monitorID != null) win.clearInterval(state.monitorID);
  for (const cleanup of state?.cleanup ?? []) cleanup();
  windowStates.delete(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterReaderToolbarButton();
  for (const ctrl of liveTranslateControllers) ctrl.disable();
  liveTranslateControllers.clear();
  for (const win of Zotero.getMainWindows()) {
    void onMainWindowUnload(win);
  }
  unregisterPreferences();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: unknown },
) {}

async function onPrefsEvent(type: string, data: { [key: string]: unknown }) {
  if (type !== "load") return;
  const win = data.window as Window | undefined;
  if (!win?.document) return;
  setupPreferencesPane(win.document);
}

function setupPreferencesPane(doc: Document): void {
  renderPresetSettings(doc);
  renderTranslateSettings(doc);

  const root = byID<HTMLElement>(doc, "zst-settings");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";

  byID<HTMLButtonElement>(doc, "zst-preset-add-openai")?.addEventListener(
    "click",
    () => {
      const preset = makePreset("openai");
      renderPresetRows(doc, [...readPresetControls(doc), preset]);
      setStatus(doc, "zst-preset-status", "已新增 OpenAI 配置，保存后生效。");
    },
  );
  byID<HTMLButtonElement>(doc, "zst-preset-add-anthropic")?.addEventListener(
    "click",
    () => {
      const preset = makePreset("anthropic");
      renderPresetRows(doc, [...readPresetControls(doc), preset]);
      setStatus(doc, "zst-preset-status", "已新增 Anthropic 配置，保存后生效。");
    },
  );
  byID<HTMLButtonElement>(doc, "zst-preset-save")?.addEventListener("click", () => {
    const presets = readPresetControls(doc);
    savePresets(zoteroPrefs(), presets);
    renderPresetSettings(doc);
    renderTranslateSettings(doc);
    setStatus(doc, "zst-preset-status", "账号配置已保存。");
  });
  byID<HTMLSelectElement>(doc, "zst-translate-preset")?.addEventListener(
    "change",
    () => refreshTranslateModelSelect(doc),
  );
  byID<HTMLButtonElement>(doc, "zst-translate-save")?.addEventListener(
    "click",
    () => {
      saveTranslateSettings(zoteroPrefs(), readTranslateSettingsControls(doc));
      renderTranslateSettings(doc);
      setStatus(doc, "zst-translate-status", "翻译设置已保存。");
    },
  );
  byID<HTMLButtonElement>(doc, "zst-color-add")?.addEventListener("click", () => {
    addColorRow(doc, { label: "", color: "#ffd400" });
  });
  byID<HTMLButtonElement>(doc, "zst-color-save")?.addEventListener("click", () => {
    const settings = loadTranslateSettings(zoteroPrefs());
    saveTranslateSettings(zoteroPrefs(), {
      ...settings,
      annotationColors: readColorControls(doc),
    });
    renderColorSettings(doc);
    setStatus(doc, "zst-color-status", "颜色已保存。");
  });
  byID<HTMLButtonElement>(doc, "zst-color-reset")?.addEventListener("click", () => {
    renderColorRows(doc, DEFAULT_ANNOTATION_COLORS);
    const settings = loadTranslateSettings(zoteroPrefs());
    saveTranslateSettings(zoteroPrefs(), {
      ...settings,
      annotationColors: DEFAULT_ANNOTATION_COLORS,
    });
    setStatus(doc, "zst-color-status", "已恢复默认颜色。");
  });
  byID<HTMLButtonElement>(doc, "zst-color-import-button")?.addEventListener(
    "click",
    () => importColorControls(doc),
  );
  renderExceptionSettings(doc);
}

function renderExceptionSettings(doc: Document): void {
  const textarea = byID<HTMLTextAreaElement>(doc, "zst-exception-list");
  if (!textarea) return;
  const all = loadTranslateSettings(zoteroPrefs()).sentenceExceptions;
  const defaults = new Set(DEFAULT_SENTENCE_EXCEPTIONS);
  const userOnly = all.filter((w) => !defaults.has(w));
  textarea.value = userOnly.join(", ");
  setStatus(doc, "zst-exception-status", "已加载例外词。");
}

function registerReaderToolbarButton(): void {
  if (readerToolbarHandler) return;
  readerToolbarHandler = (event: ReaderToolbarEvent) => {
    Zotero.debug("Sentence Translator renderToolbar event");
    const { reader, doc, append } = event;
    if (!reader || !doc || doc.getElementById(READER_TRANSLATE_GROUP_ID)) {
      if (reader && doc) syncTranslateButtonsForReader(reader, doc);
      return;
  // Shortcut record button
  let shortcutRecording = false;
  let shortcutRecordHandler: ((ev: KeyboardEvent) => void) | null = null;
  byID<HTMLButtonElement>(doc, "zst-shortcut-record")?.addEventListener("click", () => {
    const btn = byID<HTMLButtonElement>(doc, "zst-shortcut-record");
    const input = byID<HTMLInputElement>(doc, "zst-translate-shortcut");
    if (!btn || !input) return;
    if (shortcutRecording) return;
    shortcutRecording = true;
    btn.textContent = "?????...";
    shortcutRecordHandler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const parts: string[] = [];
      if (ev.ctrlKey) parts.push("Ctrl");
      if (ev.altKey) parts.push("Alt");
      if (ev.shiftKey) parts.push("Shift");
      if (ev.metaKey) parts.push("Meta");
      const key = ev.key;
      if (key && !["Control", "Alt", "Shift", "Meta"].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
      }
      if (parts.length > 1) {
        input.value = parts.join("+");
      }
      cleanupRecord();
    };
    // Listen on both doc and window for broader capture
    doc.addEventListener("keydown", shortcutRecordHandler, true);
    doc.defaultView?.addEventListener?.("keydown", shortcutRecordHandler, true);
  });
  function cleanupRecord() {
    const btn = byID<HTMLButtonElement>(doc, "zst-shortcut-record");
    if (btn) btn.textContent = "??";
    shortcutRecording = false;
    if (shortcutRecordHandler) {
      doc.removeEventListener("keydown", shortcutRecordHandler, true);
      doc.defaultView?.removeEventListener?.("keydown", shortcutRecordHandler, true);
      shortcutRecordHandler = null;
    }
  }

  byID<HTMLButtonElement>(doc, "zst-exception-save")?.addEventListener("click", () => {
    const settings = loadTranslateSettings(zoteroPrefs());
    const raw = byID<HTMLTextAreaElement>(doc, "zst-exception-list")?.value ?? "";
    const userAdditions = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    saveTranslateSettings(zoteroPrefs(), {
      ...settings,
      sentenceExceptions: [...DEFAULT_SENTENCE_EXCEPTIONS, ...userAdditions],
    });
    renderExceptionSettings(doc);
    setStatus(doc, "zst-exception-status", "已保存例外词。");
  });
  byID<HTMLButtonElement>(doc, "zst-exception-reset")?.addEventListener("click", () => {
    const settings = loadTranslateSettings(zoteroPrefs());
    saveTranslateSettings(zoteroPrefs(), {
      ...settings,
      sentenceExceptions: DEFAULT_SENTENCE_EXCEPTIONS,
    });
    renderExceptionSettings(doc);
    setStatus(doc, "zst-exception-status", "已恢复默认例外词。");
  });
    }
    append(createReaderTranslateButton(doc, reader));
    syncTranslateButtonsForReader(reader, doc);
  };
  (Zotero as any).Reader?.registerEventListener?.(
    "renderToolbar",
    readerToolbarHandler,
    addon.data.config.addonID,
  );
  Zotero.debug("Sentence Translator registered renderToolbar listener");
}

function refreshExistingReaderToolbarButtons(): void {
  const readers = (Zotero as any).Reader?._readers;
  if (!Array.isArray(readers)) {
    Zotero.debug("Sentence Translator found no Zotero.Reader._readers array");
    return;
  }
  for (const reader of readers as ReaderLike[]) {
    const doc = readerToolbarDocument(reader);
    if (!doc || doc.getElementById(READER_TRANSLATE_GROUP_ID)) continue;
    const button = createReaderTranslateButton(doc, reader);
    const toolbar = existingReaderToolbar(doc);
    if (toolbar) toolbar.append(button);
    Zotero.debug("Sentence Translator injected existing reader toolbar button");
  }
}

function unregisterReaderToolbarButton(): void {
  if (!readerToolbarHandler) return;
  (Zotero as any).Reader?.unregisterEventListener?.(
    "renderToolbar",
    readerToolbarHandler,
  );
  readerToolbarHandler = null;
}

function renderPresetSettings(doc: Document): void {
  renderPresetRows(doc, loadPresets(zoteroPrefs()));
  setStatus(doc, "zst-preset-status", "已加载账号配置。");
}

function renderPresetRows(doc: Document, presets: ModelPreset[]): void {
  const list = byID<HTMLElement>(doc, "zst-preset-list");
  if (!list) return;
  list.replaceChildren();
  for (const preset of presets) {
    const row = el(doc, "details", "zst-card zst-preset-row") as HTMLDetailsElement;
    row.open = true;
    row.dataset.id = preset.id;

    const summary = el(doc, "summary", "zst-preset-summary");
    summary.textContent = `${preset.label || preset.provider} - ${preset.model || "未选择模型"}`;

    const provider = select(doc, [
      ["openai", "OpenAI / 兼容接口"],
      ["anthropic", "Anthropic / 兼容接口"],
    ], preset.provider);
    provider.dataset.field = "provider";

    const label = input(doc, preset.label);
    label.dataset.field = "label";
    const apiKey = input(doc, preset.apiKey, "password");
    apiKey.dataset.field = "apiKey";
    const baseUrl = input(doc, preset.baseUrl);
    baseUrl.dataset.field = "baseUrl";
    baseUrl.placeholder = "留空使用官方默认地址";
    const model = input(doc, preset.model);
    model.dataset.field = "model";
    model.placeholder = "例如 gpt-5.4-mini 或 claude-sonnet-4-6";
    const maxTokens = input(doc, String(preset.maxTokens || 8192), "number");
    maxTokens.dataset.field = "maxTokens";
    maxTokens.setAttribute("min", "256");
    maxTokens.setAttribute("step", "256");

    const remove = button(doc, "删除");
    remove.addEventListener("click", () => row.remove());

    row.append(
      summary,
      grid(doc, [
        ["Provider", provider],
        ["名称", label],
        ["API Key", apiKey],
        ["Base URL", baseUrl],
        ["模型", model],
        ["Max tokens", maxTokens],
      ]),
      actions(doc, remove),
    );
    list.append(row);
  }
}

function readPresetControls(doc: Document): ModelPreset[] {
  return Array.from(doc.querySelectorAll(".zst-preset-row")).map((node) => {
    const row = node as HTMLElement;
    const provider = providerValue(controlValue(row, "provider"));
    const baseUrl = controlValue(row, "baseUrl") || DEFAULT_BASE_URLS[provider];
    const model = controlValue(row, "model") || DEFAULT_MODELS[provider];
    const isDeepSeek =
      provider === "openai" &&
      (baseUrl.toLowerCase().includes("deepseek") ||
        model.toLowerCase().startsWith("deepseek-"));
    return {
      id: row.dataset.id || makeId("preset"),
      provider,
      label: controlValue(row, "label") || (provider === "anthropic" ? "Claude" : "GPT"),
      apiKey: controlValue(row, "apiKey"),
      baseUrl,
      model,
      models: model ? [model] : [],
      maxTokens: numberValue(controlValue(row, "maxTokens"), 8192),
      extras: provider === "anthropic"
        ? { vendor: "compat", reasoningEffort: "high" }
        : {
            reasoningEffort: "none",
            reasoningSummary: "none",
            ...(isDeepSeek ? { openaiUseChatCompletions: true } : {}),
          },
    };
  });
}

function renderTranslateSettings(doc: Document): void {
  const settings = loadTranslateSettings(zoteroPrefs());
  const presetSelect = byID<HTMLSelectElement>(doc, "zst-translate-preset");
  if (presetSelect) {
    presetSelect.replaceChildren();
    for (const preset of loadPresets(zoteroPrefs())) {
      presetSelect.append(option(doc, preset.id, preset.label || preset.model || preset.provider));
    }
    presetSelect.value =
      settings.presetId || firstOptionValue(presetSelect) || "";
  }

  setSelectValue(doc, "zst-translate-thinking", settings.thinking);
  setSelectValue(doc, "zst-translate-context", settings.ctxLevel);
  setSelectValue(doc, "zst-translate-position", settings.overlayPosition);
  setSelectValue(doc, "zst-translate-size", settings.overlaySize);
  setSelectValue(doc, "zst-translate-trigger", settings.triggerMode);
  setInputValue(doc, "zst-translate-next-key", settings.nextSentenceKey);
  setInputValue(doc, "zst-translate-prev-key", settings.prevSentenceKey);
  const saveComment = byID<HTMLInputElement>(doc, "zst-translate-save-comment");
  if (saveComment) saveComment.checked = settings.saveTranslationComment;
  setInputValue(doc, "zst-translate-shortcut", settings.translateToggleShortcut);
  setInputValue(doc, "zst-translate-fontsize", String(settings.overlayFontSize));
  refreshTranslateModelSelect(doc, settings.model);
  renderColorSettings(doc);
  setStatus(doc, "zst-translate-status", "已加载翻译设置。");
}

function refreshTranslateModelSelect(doc: Document, desired = ""): void {
  const presetId = byID<HTMLSelectElement>(doc, "zst-translate-preset")?.value ?? "";
  const modelSelect = byID<HTMLSelectElement>(doc, "zst-translate-model");
  if (!modelSelect) return;
  const preset = loadPresets(zoteroPrefs()).find((p) => p.id === presetId);
  const models = dedupe([...(preset?.models ?? []), preset?.model ?? ""]);
  modelSelect.replaceChildren();
  for (const model of models) modelSelect.append(option(doc, model, model));
  modelSelect.value =
    desired || preset?.model || firstOptionValue(modelSelect) || "";
}

function readTranslateSettingsControls(doc: Document): TranslateSettings {
  return {
    ...DEFAULT_TRANSLATE_SETTINGS,
    enabled: false,
    presetId: byID<HTMLSelectElement>(doc, "zst-translate-preset")?.value ?? "",
    model: byID<HTMLSelectElement>(doc, "zst-translate-model")?.value ?? "",
    thinking: thinkingValue(byID<HTMLSelectElement>(doc, "zst-translate-thinking")?.value),
    ctxLevel: ctxLevelValue(byID<HTMLSelectElement>(doc, "zst-translate-context")?.value),
    overlayPosition: positionValue(byID<HTMLSelectElement>(doc, "zst-translate-position")?.value),
    overlaySize: sizeValue(byID<HTMLSelectElement>(doc, "zst-translate-size")?.value),
    triggerMode: triggerValue(byID<HTMLSelectElement>(doc, "zst-translate-trigger")?.value),
    nextSentenceKey:
      byID<HTMLInputElement>(doc, "zst-translate-next-key")?.value.trim() ||
      DEFAULT_TRANSLATE_SETTINGS.nextSentenceKey,
    prevSentenceKey:
      byID<HTMLInputElement>(doc, "zst-translate-prev-key")?.value.trim() ||
      DEFAULT_TRANSLATE_SETTINGS.prevSentenceKey,
    annotationColors: readColorControls(doc),
    saveTranslationComment:
      byID<HTMLInputElement>(doc, "zst-translate-save-comment")?.checked !==
      false,
    translateToggleShortcut:
      byID<HTMLInputElement>(doc, "zst-translate-shortcut")?.value.trim() ??
      "",
    overlayFontSize: numberValue(
      byID<HTMLInputElement>(doc, "zst-translate-fontsize")?.value ?? "14",
      14,
    ),
  };
}

function renderColorSettings(doc: Document): void {
  renderColorRows(doc, loadTranslateSettings(zoteroPrefs()).annotationColors);
  setStatus(doc, "zst-color-status", "已加载标注颜色。");
}

function renderColorRows(doc: Document, colors: AnnotationColorPreset[]): void {
  const list = byID<HTMLElement>(doc, "zst-color-list");
  if (!list) return;
  list.replaceChildren();
  for (const color of colors) addColorRow(doc, color);
}

function addColorRow(doc: Document, preset: AnnotationColorPreset): void {
  const list = byID<HTMLElement>(doc, "zst-color-list");
  if (!list) return;
  const row = el(doc, "div", "zst-color-row");
  const label = input(doc, preset.label);
  label.dataset.field = "label";
  label.placeholder = "含义，例如 method";
  const colorText = input(doc, preset.color);
  colorText.dataset.field = "color";
  colorText.placeholder = "#ffd400";
  const remove = button(doc, "删除");
  remove.addEventListener("click", () => row.remove());
  row.append(label, colorText, remove);
  list.append(row);
}

function readColorControls(doc: Document): AnnotationColorPreset[] {
  const rows = Array.from(doc.querySelectorAll(".zst-color-row")) as HTMLElement[];
  const parsed = rows.map((row) => [
    controlValue(row, "label"),
    controlValue(row, "color"),
  ]);
  return normalizeAnnotationColors(parsed);
}

function importColorControls(doc: Document): void {
  const raw = byID<HTMLTextAreaElement>(doc, "zst-color-import")?.value ?? "";
  try {
    const colors = normalizeAnnotationColors(JSON.parse(raw));
    renderColorRows(doc, colors);
    const settings = loadTranslateSettings(zoteroPrefs());
    saveTranslateSettings(zoteroPrefs(), {
      ...settings,
      annotationColors: colors,
    });
    setStatus(doc, "zst-color-status", `已导入 ${colors.length} 个颜色。`);
  } catch (err) {
    setStatus(doc, "zst-color-status", `导入失败：${errorMessage(err)}`);
  }
}

function createReaderTranslateButton(
  doc: Document,
  reader: ReaderLike,
): HTMLButtonElement {
  ensureReaderTranslateToolbarStyle(doc);

  const translateBtn = doc.createElement("button");
  translateBtn.id = READER_TRANSLATE_GROUP_ID;
  translateBtn.type = "button";
  translateBtn.tabIndex = -1;
  translateBtn.className = "toolbar-button zst-reader-translate-button";
  translateBtn.title = "点击开启/关闭逐句翻译模式 (Alt+T)";
  translateBtn.textContent = "译";
  translateBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleTranslateModeForReader(reader, translateBtn);
  });
  return translateBtn;
}

function installTranslateShortcut(win: Window): void {
  const state = ensureWindowState(win);
  const installedWindows = new WeakSet<Window>();
  const addWindow = (targetWin: Window | null | undefined) => {
    if (!targetWin || installedWindows.has(targetWin)) return;
    installedWindows.add(targetWin);
    const handler = (event: KeyboardEvent) => {
      const settings = loadTranslateSettings(zoteroPrefs());
      // Check configurable shortcut first
      const customShortcut = parseKeybinding(settings.translateToggleShortcut);
      if (customShortcut && matchesKeybinding(event, customShortcut)) {
        if (isEditableEventTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        const reader = getActiveReader(win);
        if (reader) void toggleTranslateModeForReader(reader);
        return;
      }
      // Built-in Alt+T fallback
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "t") return;
      if (isEditableEventTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const reader = getActiveReader(win);
      if (reader) void toggleTranslateModeForReader(reader);
    };
    targetWin.addEventListener("keydown", handler, true);
    state.cleanup.push(() =>
      targetWin.removeEventListener("keydown", handler, true),
    );
  };

  const installLikelyReaderWindows = () => {
    addWindow(win);
    for (const readerWin of activeReaderWindows(getActiveReader(win))) {
      addWindow(readerWin);
    }
  };
  installLikelyReaderWindows();
  const shortcutMonitor = win.setInterval(installLikelyReaderWindows, 500);
  state.cleanup.push(() => win.clearInterval(shortcutMonitor));
}

async function toggleTranslateModeForReader(
  reader: ReaderLike,
  btn?: HTMLElement,
): Promise<void> {
  const ctrl = await getOrCreateTranslateController(reader);
  if (!ctrl) {
    flashButton(btn, "无PDF");
    return;
  }
  if (ctrl.isEnabled()) {
    ctrl.disable();
    translateControllers.delete(reader);
    liveTranslateControllers.delete(ctrl);
  } else {
    try {
      await ctrl.enable();
    } catch (err) {
      Zotero.debug(`Sentence Translate enable failed: ${errorMessage(err)}`);
      flashButton(btn, "失败");
    }
  }
  syncTranslateButtonsForReader(reader, btn?.ownerDocument ?? undefined);
}

async function getOrCreateTranslateController(
  reader: ReaderLike,
): Promise<TranslateModeController | null> {
  if (!reader) return null;
  const prefs = zoteroPrefs();
  const presets = loadPresets(prefs);
  const existing = translateControllers.get(reader);
  if (existing?.isForReader(reader)) {
    existing.refreshPresets(presets);
    return existing;
  }
  existing?.disable();
  const ctrl = new TranslateModeController({ prefs, presets, reader });
  translateControllers.set(reader, ctrl);
  liveTranslateControllers.add(ctrl);
  return ctrl;
}

function disableTranslateMode(win: Window): void {
  const reader = getActiveReader(win);
  if (!reader) return;
  const ctrl = translateControllers.get(reader);
  ctrl?.disable();
  if (ctrl) liveTranslateControllers.delete(ctrl);
  translateControllers.delete(reader);
  syncTranslateButtonsForReader(reader);
}

function syncTranslateButtonsForReader(reader: ReaderLike, doc?: Document): void {
  const enabled = translateControllers.get(reader)?.isEnabled() ?? false;
  const docs = new Set<Document>();
  if (doc) docs.add(doc);
  for (const readerWin of activeReaderWindows(reader)) {
    if (readerWin.document) docs.add(readerWin.document);
  }
  for (const targetDoc of docs) {
    const buttons = Array.from(
      targetDoc.querySelectorAll(".zst-reader-translate-button"),
    ) as HTMLElement[];
    for (const button of buttons) {
      button.classList.toggle("zst-reader-translate-button--active", enabled);
      button.textContent = enabled ? "译✓" : "译";
    }
  }
}

function activeReaderWindows(reader: any): Window[] {
  const windows: Window[] = [];
  const add = (value: unknown) => {
    const win = value as Window | null | undefined;
    if (win && !windows.includes(win)) windows.push(win);
  };
  add(reader?._internalReader?._primaryView?._iframeWindow);
  add(reader?._primaryView?._iframeWindow);
  add(reader?._internalReader?._primaryView?.iframeWindow);
  add(reader?._internalReader?._primaryView?._iframe?.contentWindow);
  add(reader?._internalReader?._primaryView?.iframe?.contentWindow);
  add(reader?._internalReader?._secondaryView?._iframeWindow);
  add(reader?._secondaryView?._iframeWindow);
  add(reader?._internalReader?._secondaryView?.iframeWindow);
  add(reader?._internalReader?._secondaryView?._iframe?.contentWindow);
  add(reader?._internalReader?._secondaryView?.iframe?.contentWindow);
  add(reader?._internalReader?._iframeWindow);
  add(reader?._internalReader?.iframeWindow);
  add(reader?._internalReader?._iframe?.contentWindow);
  add(reader?._internalReader?.iframe?.contentWindow);
  add(reader?._window);
  add(reader?.window);
  add(reader?._iframeWindow);
  add(reader?._iframe?.contentWindow);
  add(reader?.iframe?.contentWindow);
  return windows;
}

function readerToolbarDocument(reader: ReaderLike): Document | null {
  const win = (reader as any)?._iframeWindow as Window | undefined;
  return win?.document ?? null;
}

function existingReaderToolbar(doc: Document): HTMLElement | null {
  return (
    (doc.querySelector(".toolbar") as HTMLElement | null) ??
    (doc.querySelector("[role='toolbar']") as HTMLElement | null) ??
    doc.body
  );
}

function getActiveReader(win: Window | null | undefined): any {
  const tabID = (win as any)?.Zotero_Tabs?.selectedID;
  return tabID ? (Zotero as any).Reader?.getByTabID?.(tabID) : null;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  const element =
    target && (target as { nodeType?: number }).nodeType === 1
      ? (target as Element)
      : null;
  return !!element?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
}

function ensureReaderTranslateToolbarStyle(doc: Document): void {
  if (doc.getElementById(READER_TRANSLATE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = READER_TRANSLATE_STYLE_ID;
  style.textContent = `
.zst-reader-translate-button {
  min-width: 30px;
  height: 28px;
  border-radius: 6px;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.zst-reader-translate-button:hover {
  background: rgba(128, 128, 128, 0.14);
}
.zst-reader-translate-button--active {
  color: #d34a24;
  background: rgba(239, 91, 43, 0.14);
  border-color: #ef5b2b;
}
`;
  (doc.head ?? doc.documentElement)?.append(style);
}

function ensureWindowState(win: Window): WindowState {
  let state = windowStates.get(win);
  if (!state) {
    state = { cleanup: [] };
    windowStates.set(win, state);
  }
  return state;
}

function makePreset(provider: ProviderKind): ModelPreset {
  const model = DEFAULT_MODELS[provider];
  return {
    id: makeId("preset"),
    provider,
    label: provider === "anthropic" ? "Claude" : "GPT",
    apiKey: "",
    baseUrl: DEFAULT_BASE_URLS[provider],
    model,
    models: model ? [model] : [],
    maxTokens: 8192,
    extras: provider === "anthropic"
      ? { vendor: "compat", reasoningEffort: "high" }
      : { reasoningEffort: "none", reasoningSummary: "none" },
  };
}

function providerValue(value: string): ProviderKind {
  return value === "anthropic" ? "anthropic" : "openai";
}

function thinkingValue(value: unknown): TranslateThinking {
  return value === "off" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : "low";
}

function ctxLevelValue(value: unknown): TranslateContextLevel {
  return value === "paragraph" || value === "page" ? value : "none";
}

function positionValue(value: unknown): TranslateOverlayPosition {
  return value === "below" || value === "left" || value === "right" || value === "auto" ? value : "above";
}

function sizeValue(value: unknown): TranslateOverlaySize {
  return value === "adaptive" ? "adaptive" : "compact";
}

function triggerValue(value: unknown): TranslateTriggerMode {
  return value === "double" ? "double" : "single";
}

function setSelectValue(doc: Document, id: string, value: string): void {
  const node = byID<HTMLSelectElement>(doc, id);
  if (node) node.value = value;
}

function firstOptionValue(selectNode: HTMLSelectElement): string {
  return (selectNode.options.item(0) as HTMLOptionElement | null)?.value ?? "";
}

function setInputValue(doc: Document, id: string, value: string): void {
  const node = byID<HTMLInputElement>(doc, id);
  if (node) node.value = value;
}

function numberValue(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function controlValue(root: ParentNode, field: string): string {
  const control = root.querySelector(`[data-field="${field}"]`) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  return control?.value.trim() ?? "";
}

function grid(doc: Document, rows: Array<[string, HTMLElement]>): HTMLElement {
  const wrap = el(doc, "div", "zst-grid");
  for (const [label, control] of rows) {
    wrap.append(el(doc, "label", "", label), control);
  }
  return wrap;
}

function actions(doc: Document, ...buttons: HTMLElement[]): HTMLElement {
  const wrap = el(doc, "div", "zst-actions");
  wrap.append(...buttons);
  return wrap;
}

function input(doc: Document, value: string, type = "text"): HTMLInputElement {
  const node = doc.createElement("input");
  node.type = type;
  node.value = value;
  return node;
}

function select<T extends string>(
  doc: Document,
  options: Array<[T, string]>,
  value: string,
): HTMLSelectElement {
  const node = doc.createElement("select");
  for (const [optionValue, label] of options) {
    node.append(option(doc, optionValue, label));
  }
  node.value = value;
  return node;
}

function option(doc: Document, value: string, label: string): HTMLOptionElement {
  const node = doc.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function button(doc: Document, text: string): HTMLButtonElement {
  const node = doc.createElement("button");
  node.type = "button";
  node.textContent = text;
  return node;
}

function el(doc: Document, tag: string, className = "", text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(doc: Document, id: string, message: string): void {
  const node = byID<HTMLElement>(doc, id);
  if (node) node.textContent = message;
}

function flashButton(btn: HTMLElement | undefined, text: string): void {
  if (!btn) return;
  const original = btn.textContent ?? "";
  btn.textContent = text;
  btn.ownerDocument?.defaultView?.setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

function byID<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
