import { createPdfLocator, type PdfLocator } from "../context/pdf-locator";
import {
  detectSentenceAtPoint,
  detectSentenceFromSelection,
  type DetectedSentence,
} from "./sentence-detect";
import {
  mountOverlay,
  mountSelectionPopupGuard,
  type OverlayHandle,
} from "./overlay";
import { logTranslateDebug } from "./debug-log";
import {
  analyzeSentence,
  answerSentenceQuestion,
  cleanTranslationOutput,
  explainSentence,
  translateSentence,
  type AnalysisResult,
  type ExplainResult,
  type QuestionAnswerEntry,
} from "./translator";
import {
  cacheKey,
  fnv1aHex64,
  getCachedTranslation,
  normalizeSentence,
  setCachedTranslation,
  type CacheEntry,
} from "./cache";
import { loadTranslateSettings, saveTranslateSettings } from "./settings";
import {
  getMechanicalTranslationServices,
  translateWithMechanicalEngine,
} from "./mechanical-translator";
import { matchesKeybinding, parseKeybinding } from "./keybinding";
import {
  getCachedQuestionAnswers,
  setCachedQuestionAnswers,
} from "./question-cache";
import { splitSentences, type SplitOptions } from "./sentence-splitter";
import {
  saveTranslationHighlight,
  appendQuestionAnswerAnnotation,
  type TranslationAnnotationDraft,
} from "./annotation";
import type {
  AnnotationColorPreset,
  ModelPreset,
  TranslateOverlayMode,
  TranslateSettings,
} from "../settings/types";
import { loadPresets, type PrefsStore } from "../settings/storage";

interface ReaderLike {
  _internalReader?: {
    _primaryView?: { _iframeWindow?: Window };
    _secondaryView?: { _iframeWindow?: Window };
    _iframeWindow?: Window;
  };
  _iframeWindow?: Window;
}

export interface TranslateModeContext {
  prefs: PrefsStore;
  presets: ModelPreset[];
  reader: ReaderLike;
}

export class TranslateModeController {
  private overlay: OverlayHandle | null = null;
  private modePopupGuard: { destroy(): void } | null = null;
  private current: DetectedSentence | null = null;
  private locator: PdfLocator | null = null;
  private pointerDownHandler: ((ev: PointerEvent) => void) | null = null;
  private mouseDownHandler: ((ev: MouseEvent) => void) | null = null;
  private pointerUpHandler: ((ev: PointerEvent) => void) | null = null;
  private mouseUpHandler: ((ev: MouseEvent) => void) | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;
  private dblClickHandler: ((ev: MouseEvent) => void) | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private keyWindows: Window[] = [];
  private abortCtrl: AbortController | null = null;
  private boundWindow: Window | null = null;
  private pointerStart: { x: number; y: number } | null = null;
  private pendingDoubleClick: { at: number; x: number; y: number } | null =
    null;
  private lastActivation: { at: number; x: number; y: number } | null = null;
  private lastDoubleActivation: { at: number; x: number; y: number } | null =
    null;
  private active = false;
  private currentMode: TranslateOverlayMode = "translate";
  private modeInitialized = false;
  private translationCache = new Map<string, CacheEntry>();
  private analysisCache = new Map<string, AnalysisResult>();
  private explanationCache = new Map<string, ExplainResult>();
  private questionSessions = new Map<string, QuestionAnswerEntry[]>();
  private prefetchControllers = new Set<AbortController>();
  private prefetchInFlight = new Set<string>();
  private prefetchGeneration = 0;

  constructor(private ctx: TranslateModeContext) {}

  isForReader(reader: ReaderLike): boolean {
    return this.ctx.reader === reader;
  }

  isEnabled(): boolean {
    return this.active && this.boundWindow !== null;
  }

  refreshPresets(presets: ModelPreset[]): void {
    this.ctx.presets = presets;
  }

  async enable(): Promise<void> {
    const win = readerWindow(this.ctx.reader);
    if (!win) throw new Error("No active PDF Reader window is available.");
    if (
      this.boundWindow === win &&
      this.pointerDownHandler &&
      this.pointerUpHandler &&
      this.clickHandler &&
      this.dblClickHandler &&
      this.keyHandler
    )
      return;
    if (this.boundWindow) this.disable();
    if (!this.locator) {
      this.locator = await createPdfLocator(this.ctx.reader);
    }

    this.boundWindow = win;
    this.active = true;
    ensureModeStyle(win.document);
    win.document.body?.classList.add("zai-translate-mode-on");
    // Hide Zotero's native selection popup throughout translate mode so it
    // can never cover or race the translation overlay. Without this, the
    // overlay can mount under the popup until something incidentally
    // dismisses the popup (focus change, screenshot tool, etc.).
    try {
      this.modePopupGuard = mountSelectionPopupGuard(win.document);
    } catch (err) {
      debugLog("mountSelectionPopupGuard threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      debugLog("translate mode enabled", {
        windowUrl: safeWindowUrl(win),
        hasParent: safeHasParent(win),
      });
    } catch {
      /* never let logging crash enable() */
    }
    this.pointerDownHandler = (ev) => {
      this.rememberPointerStart(ev);
    };
    this.mouseDownHandler = (ev) => {
      if (!("PointerEvent" in win)) this.rememberPointerStart(ev);
    };
    this.pointerUpHandler = (ev) => {
      this.handleTranslatePointerUp(ev);
    };
    this.mouseUpHandler = (ev) => {
      if ("PointerEvent" in win) return;
      this.handleTranslatePointerUp(ev);
    };
    this.clickHandler = (ev) => {
      debugLog("click", {
        mode: this.translateTriggerMode(),
        drag: !this.isClickWithoutDrag(ev),
        detail: ev.detail,
        button: ev.button,
      });
      if (this.translateTriggerMode() !== "single") return;
      if (ev.detail !== 1 || !this.isClickWithoutDrag(ev)) return;
      this.scheduleActivation(ev, false);
    };
    this.dblClickHandler = (ev) => {
      if (this.translateTriggerMode() !== "double") return;
      this.scheduleDoubleActivation(ev);
    };
    this.keyHandler = (ev) => {
      this.handleKey(ev);
    };
    win.addEventListener("pointerdown", this.pointerDownHandler, true);
    win.addEventListener("mousedown", this.mouseDownHandler, true);
    win.addEventListener("pointerup", this.pointerUpHandler, true);
    win.addEventListener("mouseup", this.mouseUpHandler, true);
    win.addEventListener("click", this.clickHandler, true);
    win.addEventListener("dblclick", this.dblClickHandler, true);
    this.keyWindows = keyEventWindows(win);
    for (const keyWin of this.keyWindows) {
      keyWin.addEventListener("keydown", this.keyHandler, true);
    }
  }

  private async refreshCurrentMode(
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
  ): Promise<void> {
    if (this.currentMode === "translate") {
      await this.renderForCurrent(true);
      return;
    }
    if (this.currentMode === "analyze") {
      this.analysisCache.delete(normalizeSentence(current.text));
      await this.runAnalysis(current, overlay, settings, true);
      return;
    }
    if (this.currentMode === "question") {
      overlay.setQuestionAnswers(this.questionEntries(current.text));
      return;
    }
    const key = explanationCacheKey(current.text);
    this.explanationCache.delete(key);
    await this.runExplanation(current, overlay, settings, true);
  }

  private async switchOverlayMode(
    mode: TranslateOverlayMode,
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
  ): Promise<void> {
    if (!availableOverlayModes(settings).includes(mode)) return;
    this.currentMode = mode;

    if (mode === "question") {
      overlay.setQuestionAnswers(this.questionEntries(current.text));
      overlay.setMode(mode);
      return;
    }

    if (mode === "analyze") {
      const normalized = normalizeSentence(current.text);
      const cached = this.analysisCache.get(normalized);
      if (cached) overlay.setAnalysis(cached.blocks);
      overlay.setMode(mode);
      if (!cached) await this.runAnalysis(current, overlay, settings);
      return;
    }

    if (mode === "explain") {
      const key = explanationCacheKey(current.text);
      const cached = this.explanationCache.get(key);
      if (cached) overlay.setExplanation(cached.text);
      overlay.setMode(mode);
      if (!cached) await this.runExplanation(current, overlay, settings);
      return;
    }

    overlay.setMode(mode);
  }

  private async runAnalysis(
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
    forceRefresh = false,
  ): Promise<void> {
    const normalized = normalizeSentence(current.text);
    const preset = pickPreset(this.ctx.presets, settings.presetId);
    if (!preset) {
      overlay.setError("未找到翻译账号配置");
      return;
    }
    const model = settings.model || preset.model || "";
    if (!model) {
      overlay.setError("未选择模型");
      return;
    }

    const persistentKey =
      "analysis:" + fnv1aHex64(normalizeSentence(current.text)).slice(0, 16);
    const persistentCached = forceRefresh
      ? undefined
      : await getCachedTranslation(persistentKey);
    if (persistentCached) {
      try {
        const blocks = JSON.parse(
          persistentCached.text,
        ) as AnalysisResult["blocks"];
        const result: AnalysisResult = { blocks };
        this.analysisCache.set(normalized, result);
        overlay.setAnalysis(blocks);
        return;
      } catch {
        // Ignore invalid legacy cache entries and request a fresh analysis.
      }
    }

    overlay.setStatus("分析中…");
    const analysisCtrl = new AbortController();
    try {
      const result = await analyzeSentence(
        current.text,
        preset,
        model,
        analysisCtrl.signal,
      );
      if (this.overlay !== overlay) return;
      this.analysisCache.set(normalized, result);
      void setCachedTranslation(persistentKey, {
        text: JSON.stringify(result.blocks),
        model,
        createdAt: Date.now(),
      });
      overlay.setAnalysis(result.blocks);
    } catch (err) {
      if (this.overlay !== overlay) return;
      overlay.setError("分析失败：" + errorMessage(err));
    }
  }

  private async runExplanation(
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
    forceRefresh = false,
  ): Promise<void> {
    const preset = pickPreset(this.ctx.presets, settings.presetId);
    if (!preset) {
      overlay.setError("未找到翻译账号配置");
      return;
    }
    const model = settings.model || preset.model || "";
    if (!model) {
      overlay.setError("未选择模型");
      return;
    }

    const persistentKey = explanationCacheKey(current.text);
    const persistentCached = forceRefresh
      ? undefined
      : await getCachedTranslation(persistentKey);
    if (persistentCached) {
      const result: ExplainResult = { text: persistentCached.text };
      this.explanationCache.set(persistentKey, result);
      overlay.setExplanation(result.text);
      return;
    }

    overlay.setStatus("详解中…");
    const explainCtrl = new AbortController();
    const explainLevel = settings.ctxLevel === "page" ? "page" : "paragraph";
    try {
      const result = await explainSentence({
        sentence: current.text,
        contextLabel: contextLabel(explainLevel),
        contextText: contextText(current, explainLevel),
        preset,
        model,
        thinking: settings.thinking,
        prompt: settings.explainPrompt,
        signal: explainCtrl.signal,
      });
      if (this.overlay !== overlay) return;
      this.explanationCache.set(persistentKey, result);
      void setCachedTranslation(persistentKey, {
        text: result.text,
        model,
        createdAt: Date.now(),
      });
      overlay.setExplanation(result.text);
    } catch (err) {
      if (this.overlay !== overlay) return;
      overlay.setError("详解失败：" + errorMessage(err));
    }
  }

  private async runQuestion(
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
    question: string,
    translation: string,
  ): Promise<void> {
    const cleaned = question.trim();
    if (!cleaned || this.overlay !== overlay) return;
    const preset = pickPreset(this.ctx.presets, settings.presetId);
    if (!preset) {
      overlay.setQuestionError("请先在设置中配置一个翻译用的账号。");
      return;
    }
    const model = settings.model || preset.model || "";
    if (!model) {
      overlay.setQuestionError("请先为翻译账号选择模型。");
      return;
    }
    const key = normalizeSentence(current.text);
    const history = await this.loadQuestionEntries(current.text);
    overlay.setQuestionPending(cleaned);
    try {
      const result = await answerSentenceQuestion({
        sentence: current.text,
        question: cleaned,
        translation,
        history,
        contextLabel: contextLabel(settings.ctxLevel),
        contextText: contextText(current, settings.ctxLevel),
        preset,
        model,
        thinking: settings.thinking,
        signal: this.abortCtrl?.signal ?? new AbortController().signal,
      });
      if (this.overlay !== overlay) return;
      const entries = [...history, result];
      this.questionSessions.set(key, entries);
      overlay.setQuestionAnswers(entries);
      void setCachedQuestionAnswers(current.text, entries, model).catch((err) =>
        debugLog("question cache write failed", {
          error: errorMessage(err),
        }),
      );
    } catch (err) {
      if (this.overlay === overlay) {
        overlay.setQuestionError(errorMessage(err));
      }
    }
  }

  private questionEntries(sentence: string): QuestionAnswerEntry[] {
    return [...(this.questionSessions.get(normalizeSentence(sentence)) ?? [])];
  }

  private async loadQuestionEntries(
    sentence: string,
  ): Promise<QuestionAnswerEntry[]> {
    const key = normalizeSentence(sentence);
    if (this.questionSessions.has(key)) return this.questionEntries(sentence);
    const entries = await getCachedQuestionAnswers(sentence);
    this.questionSessions.set(key, entries);
    return [...entries];
  }

  private scheduleTranslationPrefetch(
    current: DetectedSentence,
    settings: TranslateSettings,
    preset: ModelPreset,
    model: string,
  ): void {
    if (
      !shouldPrefetchTranslations(
        settings.aiDisplayMode,
        settings.aiPrefetchCount,
      ) ||
      !this.active
    ) {
      return;
    }
    void this.prefetchNextSentences(current, settings, preset, model).catch(
      (err) =>
        debugLog("translation prefetch failed", { error: errorMessage(err) }),
    );
  }

  private async prefetchNextSentences(
    current: DetectedSentence,
    settings: TranslateSettings,
    preset: ModelPreset,
    model: string,
  ): Promise<void> {
    const generation = this.prefetchGeneration;
    const candidates = await this.collectFollowingSentences(
      current,
      settings.aiPrefetchCount,
      settings.sentenceExceptions,
    );
    if (
      generation !== this.prefetchGeneration ||
      !this.active ||
      !shouldPrefetchTranslations(
        settings.aiDisplayMode,
        settings.aiPrefetchCount,
      )
    ) {
      return;
    }
    await Promise.allSettled(
      candidates.map((candidate) =>
        this.prefetchSentence(candidate, settings, preset, model, generation),
      ),
    );
  }

  private async collectFollowingSentences(
    current: DetectedSentence,
    count: number,
    exceptions: string[],
  ): Promise<DetectedSentence[]> {
    if (!this.locator?.sentenceAtIndex || count <= 0) return [];
    const splitOptions: SplitOptions = { exceptions };
    const out: DetectedSentence[] = [];
    let pageIndex = current.bundle.pageIndex;
    let sentenceIndex = current.pageSentenceIndex + 1;
    let bundle = current.bundle;

    while (out.length < count && pageIndex < this.locator.pageCount) {
      const spans = splitSentences(bundle.normalizedText, splitOptions);
      if (sentenceIndex >= spans.length) {
        pageIndex += 1;
        sentenceIndex = 0;
        let nextBundle = null;
        while (pageIndex < this.locator.pageCount && !nextBundle) {
          nextBundle = await this.locator.getPageContent(pageIndex);
          if (!nextBundle) pageIndex += 1;
        }
        if (!nextBundle) break;
        bundle = nextBundle;
        continue;
      }
      const located = await this.locator.sentenceAtIndex(
        pageIndex,
        sentenceIndex,
        splitOptions,
      );
      sentenceIndex += 1;
      if (!located?.text.trim()) continue;
      out.push({ ...located, bundle });
    }
    return out;
  }

  private async prefetchSentence(
    candidate: DetectedSentence,
    settings: TranslateSettings,
    preset: ModelPreset,
    model: string,
    generation: number,
  ): Promise<void> {
    const key = cacheKey({
      sentence: candidate.text,
      target: "zh",
      endpoint: preset.baseUrl,
      model,
      thinking: settings.thinking,
      ctxLevel: settings.ctxLevel,
    });
    if (this.prefetchInFlight.has(key)) return;
    this.prefetchInFlight.add(key);
    const memoryKey = normalizeSentence(candidate.text);
    try {
      const cached = await getCachedTranslation(key);
      if (cached) {
        this.translationCache.set(memoryKey, cached);
        return;
      }
      if (!this.active || generation !== this.prefetchGeneration) return;
      const controller = new AbortController();
      this.prefetchControllers.add(controller);
      try {
        let buffer = "";
        for await (const chunk of translateSentence({
          sentence: candidate.text,
          contextLabel: contextLabel(settings.ctxLevel),
          contextText: contextText(candidate, settings.ctxLevel),
          preset,
          model,
          thinking: settings.thinking,
          signal: controller.signal,
        })) {
          if (chunk.type === "text" && chunk.text) {
            buffer += cleanTranslationOutput(chunk.text);
          } else if (chunk.type === "error") {
            throw new Error(chunk.message || "预翻译失败");
          } else if (chunk.type === "done" && buffer) {
            const entry: CacheEntry = {
              text: buffer,
              model,
              createdAt: Date.now(),
            };
            this.translationCache.set(memoryKey, entry);
            await setCachedTranslation(key, entry);
          }
        }
      } finally {
        this.prefetchControllers.delete(controller);
      }
    } finally {
      this.prefetchInFlight.delete(key);
    }
  }

  disable(): void {
    this.active = false;
    this.cancelTranslationPrefetch();
    if (this.boundWindow && this.pointerDownHandler) {
      this.boundWindow.removeEventListener(
        "pointerdown",
        this.pointerDownHandler,
        true,
      );
    }
    if (this.boundWindow && this.mouseDownHandler) {
      this.boundWindow.removeEventListener(
        "mousedown",
        this.mouseDownHandler,
        true,
      );
    }
    if (this.boundWindow && this.pointerUpHandler) {
      this.boundWindow.removeEventListener(
        "pointerup",
        this.pointerUpHandler,
        true,
      );
    }
    if (this.boundWindow && this.mouseUpHandler) {
      this.boundWindow.removeEventListener(
        "mouseup",
        this.mouseUpHandler,
        true,
      );
    }
    if (this.boundWindow && this.clickHandler) {
      this.boundWindow.removeEventListener("click", this.clickHandler, true);
    }
    if (this.boundWindow && this.dblClickHandler) {
      this.boundWindow.removeEventListener(
        "dblclick",
        this.dblClickHandler,
        true,
      );
    }
    if (this.keyHandler) {
      for (const keyWin of this.keyWindows) {
        keyWin.removeEventListener("keydown", this.keyHandler, true);
      }
    }
    this.boundWindow?.document.body?.classList.remove("zai-translate-mode-on");
    this.modePopupGuard?.destroy();
    this.modePopupGuard = null;
    this.boundWindow = null;
    this.pointerDownHandler = null;
    this.mouseDownHandler = null;
    this.pointerUpHandler = null;
    this.mouseUpHandler = null;
    this.clickHandler = null;
    this.dblClickHandler = null;
    this.keyHandler = null;
    this.keyWindows = [];
    this.pointerStart = null;
    this.pendingDoubleClick = null;
    this.lastActivation = null;
    this.lastDoubleActivation = null;
    this.dismissOverlay();
    this.locator?.dispose();
    this.locator = null;
  }

  private cancelTranslationPrefetch(): void {
    this.prefetchGeneration += 1;
    for (const controller of this.prefetchControllers) controller.abort();
    this.prefetchControllers.clear();
    // Keep the in-flight keys until each aborted task reaches its finally block.
    // This prevents an immediate mode toggle from starting duplicate requests.
  }

  private translateTriggerMode(): "single" | "double" {
    return loadTranslateSettings(this.ctx.prefs).triggerMode;
  }

  private rememberPointerStart(ev: MouseEvent): void {
    this.pointerStart =
      ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
  }

  private handleTranslatePointerUp(ev: MouseEvent): void {
    // Drag selections always activate translation regardless of triggerMode.
    // The trigger mode only governs how non-selection point gestures
    // (single vs double click) activate; the user's intent is unambiguous
    // when they finish a drag selection.
    const drag = !this.isClickWithoutDrag(ev);
    debugLog("pointerup", {
      mode: this.translateTriggerMode(),
      drag,
      detail: ev.detail,
    });
    if (drag) {
      this.pendingDoubleClick = null;
      if (ev.detail > 1) return;
      this.scheduleActivation(ev, true);
      return;
    }

    if (this.translateTriggerMode() === "single") {
      this.pendingDoubleClick = null;
      this.scheduleActivation(ev, false);
      return;
    }

    if (this.translateTriggerMode() === "double") {
      this.handleDoubleModePointerUp(ev);
    }
  }

  private handleDoubleModePointerUp(ev: MouseEvent): void {
    const now = Date.now();
    const current = { at: now, x: ev.clientX, y: ev.clientY };
    const previous = this.pendingDoubleClick;
    this.pendingDoubleClick = current;
    if (
      !previous ||
      now - previous.at > 450 ||
      distance(previous, current) > 8
    ) {
      return;
    }
    this.scheduleDoubleActivation(ev);
  }

  private scheduleDoubleActivation(ev: MouseEvent): void {
    if (!this.isClickWithoutDrag(ev)) return;
    if (this.isDuplicateDoubleActivation(ev)) return;
    this.scheduleActivation(ev, false);
  }

  private isClickWithoutDrag(ev: MouseEvent): boolean {
    if (!this.pointerStart) return true;
    return distance(this.pointerStart, { x: ev.clientX, y: ev.clientY }) <= 6;
  }

  private isDuplicateDoubleActivation(ev: MouseEvent): boolean {
    const now = Date.now();
    const last = this.lastDoubleActivation;
    if (
      last &&
      now - last.at < 350 &&
      distance(last, { x: ev.clientX, y: ev.clientY }) <= 6
    ) {
      return true;
    }
    this.lastDoubleActivation = { at: now, x: ev.clientX, y: ev.clientY };
    return false;
  }

  private scheduleActivation(
    ev: MouseEvent,
    preferSelection: boolean,
    delayMs = 0,
  ): void {
    if (ev.button !== 0) return;
    const target = ev.target as Node | null;
    if (closestElement(target, ".zai-translate-overlay")) return;
    const win = this.boundWindow;
    if (!this.isEnabled() || !win || !this.locator) return;
    if (!win.document.body?.classList.contains("zai-translate-mode-on")) {
      this.disable();
      return;
    }
    if (!eventHitsPage(win, ev.clientX, ev.clientY, target)) return;
    if (this.isDuplicateActivation(ev)) return;

    const clientX = ev.clientX;
    const clientY = ev.clientY;
    debugLog("scheduleActivation", {
      clientX,
      clientY,
      preferSelection,
      delayMs,
    });
    if (!preferSelection && delayMs <= 0) {
      void this.handleActivation(clientX, clientY, false);
      return;
    }
    win.setTimeout(
      () => {
        if (!this.isEnabled() || this.boundWindow !== win) return;
        void this.handleActivation(clientX, clientY, preferSelection);
      },
      delayMs > 0 ? delayMs : SELECTION_STABILIZE_DELAY_MS,
    );
  }

  private isDuplicateActivation(ev: MouseEvent): boolean {
    const now = Date.now();
    const last = this.lastActivation;
    if (
      last &&
      now - last.at < 250 &&
      distance(last, { x: ev.clientX, y: ev.clientY }) <= 6
    ) {
      debugLog("duplicateActivation", {
        ageMs: now - last.at,
        clientX: ev.clientX,
        clientY: ev.clientY,
      });
      return true;
    }
    this.lastActivation = { at: now, x: ev.clientX, y: ev.clientY };
    return false;
  }

  private async handleActivation(
    clientX: number,
    clientY: number,
    preferSelection: boolean,
  ): Promise<void> {
    const splitOptions: SplitOptions = {
      exceptions: loadTranslateSettings(this.ctx.prefs).sentenceExceptions,
    };
    if (!this.isEnabled() || !this.boundWindow || !this.locator) return;
    debugLog("handleActivation start", { clientX, clientY, preferSelection });

    let fromPoint: DetectedSentence | null = null;
    try {
      const fromSelection = preferSelection
        ? await detectSentenceFromSelection({
            iframeWindow: this.boundWindow as never,
            locator: this.locator,
            splitOptions,
          })
        : null;
      debugLog("detectSentenceFromSelection", {
        preferSelection,
        ok: !!fromSelection,
        text: fromSelection?.text?.slice(0, 60),
      });
      debugLog("detectSentenceAtPoint start", {
        skipped: !!fromSelection,
        clientX,
        clientY,
      });
      fromPoint =
        fromSelection ??
        (await detectSentenceAtPoint({
          iframeWindow: this.boundWindow as never,
          clientX,
          clientY,
          splitOptions,
          locator: this.locator,
        }));
      debugLog("detectSentenceAtPoint result", {
        ok: !!fromPoint,
        text: fromPoint?.text?.slice(0, 60),
        rectCount: fromPoint?.rects?.length ?? 0,
        pageIndex: fromPoint?.pageIndex,
      });
    } catch (err) {
      debugLog("detectSentence failed", { error: errorMessage(err) });
      return;
    }
    if (!fromPoint) {
      debugLog("handleActivation no detected sentence");
      return;
    }

    this.current = fromPoint;
    try {
      await this.renderForCurrent();
      debugLog("renderForCurrent finished");
    } catch (err) {
      debugLog("renderForCurrent threw", { error: errorMessage(err) });
      this.overlay?.setError(`翻译失败：${errorMessage(err)}`);
    }
  }

  private handleKey(ev: KeyboardEvent): void {
    if (!this.isEnabled()) return;
    if (!this.current) return;
    // The reader-level shortcut listener runs in capture phase. Editable
    // controls must receive Enter first so the Q&A form can submit instead of
    // advancing the PDF sentence. Escape remains a global close shortcut.
    if (ev.key !== "Escape" && isEditableEventTarget(ev.target)) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const next = parseKeybinding(settings.nextSentenceKey);
    const prev = parseKeybinding(settings.prevSentenceKey);
    const switchMode = parseKeybinding(settings.switchModeShortcut);
    if (next && matchesKeybinding(ev, next)) {
      consumeKeyEvent(ev);
      void this.jump(+1);
    } else if (prev && matchesKeybinding(ev, prev)) {
      consumeKeyEvent(ev);
      void this.jump(-1);
    } else if (switchMode && matchesKeybinding(ev, switchMode)) {
      const modes = availableOverlayModes(settings);
      if (modes.length < 2) return;
      consumeKeyEvent(ev);
      if (this.current && this.overlay) {
        const index = modes.indexOf(this.currentMode);
        const mode = modes[(index + 1) % modes.length] ?? modes[0]!;
        void this.switchOverlayMode(mode, this.current, this.overlay, settings);
      }
    } else if (ev.key === "Escape") {
      consumeKeyEvent(ev);
      this.dismissOverlay();
    }
  }

  private async jump(delta: number): Promise<void> {
    if (!this.isEnabled()) return;
    const current = this.current;
    if (!current || !this.locator) return;
    const targetIndex = current.pageSentenceIndex + delta;
    const splitOptions: SplitOptions = {
      exceptions: loadTranslateSettings(this.ctx.prefs).sentenceExceptions,
    };
    if (targetIndex < 0 || targetIndex >= current.pageSentenceCount) return;

    if (this.locator.sentenceAtIndex) {
      const located = await this.locator.sentenceAtIndex(
        current.bundle.pageIndex,
        targetIndex,
        splitOptions,
      );
      if (!located) return;
      const bundle =
        located.pageIndex === current.bundle.pageIndex
          ? current.bundle
          : await this.locator.getPageContent(located.pageIndex);
      if (!bundle) return;
      this.current = { ...located, bundle };
      await this.renderForCurrent();
      return;
    }

    const all = splitSentences(current.bundle.normalizedText, splitOptions);
    const span = all[targetIndex];
    if (!span) return;
    const origStart = current.bundle.normalizedToOriginal[span.start] ?? -1;
    const origEnd =
      current.bundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
    if (origStart < 0 || origEnd < 0) return;
    const text = current.bundle.pageText.slice(origStart, origEnd + 1).trim();
    if (!text) return;
    const located = await this.locator.locate(text, {
      minConfidence: 0.6,
      pageIndex: current.bundle.pageIndex,
    });
    if (!located) return;
    this.current = {
      ...current,
      text,
      pageIndex: located.pageIndex,
      pageLabel: located.pageLabel,
      rects: located.rects,
      sortIndex: located.sortIndex,
      pageSentenceIndex: targetIndex,
    };
    await this.renderForCurrent();
  }

  private async renderForCurrent(forceRefresh = false): Promise<void> {
    const current = this.current;
    if (!this.isEnabled() || !current || !this.boundWindow) return;
    const detected = current;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const enabledModes = availableOverlayModes(settings);
    if (!this.modeInitialized) {
      this.currentMode = enabledModes.includes(settings.defaultOverlayMode)
        ? settings.defaultOverlayMode
        : (enabledModes[0] ?? "translate");
      this.modeInitialized = true;
    } else if (!enabledModes.includes(this.currentMode)) {
      this.currentMode = enabledModes[0] ?? "translate";
    }
    this.ctx.presets = loadPresets(this.ctx.prefs);
    const preset = pickPreset(this.ctx.presets, settings.presetId);
    debugLog("renderForCurrent start", {
      forceRefresh,
      text: current.text.slice(0, 60),
      pageIndex: current.pageIndex,
      presetId: settings.presetId,
      model: settings.model || preset?.model || "",
      mode: this.currentMode,
    });

    const pageEl = this.boundWindow.document.querySelector(
      `.page[data-page-number="${current.pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) {
      debugLog("renderForCurrent missing pageEl", {
        pageIndex: current.pageIndex,
      });
      return;
    }

    this.clearOverlay();
    this.abortCtrl = new AbortController();

    const model = settings.model || preset?.model || "";
    const hint = `${displayKey(settings.nextSentenceKey)} 下一句 · ${displayKey(settings.prevSentenceKey)} 上一句`;
    let latestTranslation = "";
    let latestMachineTranslation = "";
    let translationDone = false;
    let aiStarted = false;
    let activeMechanicalEngine = settings.mechanicalEngineId;
    const enabledMechanicalIds = new Set(settings.mechanicalEngineIds);
    const mechanicalServices = getMechanicalTranslationServices().filter(
      (service) => enabledMechanicalIds.has(service.id),
    );
    if (
      !mechanicalServices.some(
        (service) => service.id === activeMechanicalEngine,
      )
    ) {
      activeMechanicalEngine = "";
    }

    const key =
      preset && model
        ? cacheKey({
            sentence: current.text,
            target: "zh",
            endpoint: preset.baseUrl,
            model,
            thinking: settings.thinking,
            ctxLevel: settings.ctxLevel,
          })
        : "";
    const memoryKey = normalizeSentence(current.text);
    const memoryCached = forceRefresh
      ? undefined
      : this.translationCache.get(memoryKey);
    const cached = memoryCached
      ? {
          text: memoryCached.text,
          model: memoryCached.model,
          createdAt: memoryCached.createdAt,
        }
      : forceRefresh || !key
        ? undefined
        : await getCachedTranslation(key);
    const cachedQuestionAnswers = await this.loadQuestionEntries(current.text);
    const aiInitiallyExpanded = shouldInitiallyExpandAI(
      this.currentMode,
      settings.aiDisplayMode,
      forceRefresh,
      !!cached,
    );
    let overlay: OverlayHandle | null = null;
    overlay = mountOverlay({
      iframeDoc: this.boundWindow.document,
      pageEl,
      rects: current.rects,
      pageContent: current.bundle,
      position: settings.overlayPosition,
      size: settings.overlaySize,
      fontSize: settings.overlayFontSize,
      analysisEnglishFontSize: settings.analysisEnglishFontSize,
      analysisChineseFontSize: settings.analysisChineseFontSize,
      showTranslationInAnalysis: settings.showTranslationInAnalysis,
      initialMode: this.currentMode,
      enabledModes,
      mechanicalEngines: mechanicalServices,
      selectedMechanicalEngine: activeMechanicalEngine,
      aiInitiallyExpanded,
      aiDisplayMode: settings.aiDisplayMode,
      initialQuestionAnswers: cachedQuestionAnswers,
      actions: {
        onClose: () => this.dismissOverlay(),
        onPrev: () => void this.jump(-1),
        onNext: () => void this.jump(+1),
        onRetry: () =>
          void this.refreshCurrentMode(current, overlay!, settings),
        onModeSwitch: (mode) =>
          void this.switchOverlayMode(mode, current, overlay!, settings),
        onMechanicalEngineSwitch: (engineId) => {
          activeMechanicalEngine = engineId;
          const latest = loadTranslateSettings(this.ctx.prefs);
          saveTranslateSettings(this.ctx.prefs, {
            ...latest,
            mechanicalEngineId: engineId,
          });
          if (engineId) void runMechanicalTranslation(this, engineId);
        },
        onAIExpand: () => {
          if (!aiStarted && !translationDone) void runAITranslation(this);
        },
        onAIDisplayModeSwitch: (mode) => {
          const latest = loadTranslateSettings(this.ctx.prefs);
          settings.aiDisplayMode = mode;
          saveTranslateSettings(this.ctx.prefs, {
            ...latest,
            aiDisplayMode: mode,
          });
          if (mode === "manual") this.cancelTranslationPrefetch();
          if (mode === "always-open" && !aiStarted && !translationDone) {
            void runAITranslation(this);
          } else if (
            mode === "always-open" &&
            translationDone &&
            preset &&
            model
          ) {
            this.scheduleTranslationPrefetch(current, settings, preset, model);
          }
        },
        onSaveColor: (colorPreset) => {
          if (!overlay) return;
          void this.saveTranslationAnnotation(
            current,
            overlay,
            latestTranslation,
            translationDone,
            colorPreset,
            settings.saveTranslationComment,
          );
        },
        onAskQuestion: (question) => {
          void this.runQuestion(
            current,
            overlay!,
            settings,
            question,
            latestTranslation || latestMachineTranslation,
          );
        },
        onSaveQuestionAnswers: () => {
          void this.saveQuestionAnnotations(
            current,
            overlay!,
            this.questionEntries(current.text),
            settings,
          );
        },
        hint,
        colors: settings.annotationColors,
      },
    });
    this.overlay = overlay;
    if (this.currentMode === "question") {
      overlay.setStatusLabel("● 可提问");
    } else if (this.currentMode !== "translate") {
      overlay.setStatus(this.currentMode === "analyze" ? "分析中…" : "详解中…");
    } else if (aiInitiallyExpanded && !cached) {
      overlay.setStatus("正在翻译…");
    } else if (!cached) {
      overlay.setStatusLabel("● AI 待展开");
    }
    debugLog("overlay mounted", {
      connected: overlay.el.isConnected,
      position: settings.overlayPosition,
      size: settings.overlaySize,
      fontSize: settings.overlayFontSize,
      analysisEnglishFontSize: settings.analysisEnglishFontSize,
      analysisChineseFontSize: settings.analysisChineseFontSize,
      showTranslationInAnalysis: settings.showTranslationInAnalysis,
      initialMode: this.currentMode,
      mechanicalEngine: activeMechanicalEngine,
      aiDisplayMode: settings.aiDisplayMode,
      aiCacheHit: !!cached,
    });

    if (activeMechanicalEngine) {
      void runMechanicalTranslation(this, activeMechanicalEngine);
    }
    if (cached) {
      debugLog("translation cache hit", {
        createdAt: cached.createdAt,
        model: cached.model,
      });
      latestTranslation = cleanTranslationOutput(cached.text);
      translationDone = true;
      overlay.setAIExpanded(true);
      overlay.setText(latestTranslation);
      this.runCurrentSecondaryMode(current, overlay, settings);
      if (preset && model) {
        this.scheduleTranslationPrefetch(current, settings, preset, model);
      }
      return;
    }

    if (aiInitiallyExpanded) await runAITranslation(this);

    async function runMechanicalTranslation(
      controller: TranslateModeController,
      engineId: string,
    ): Promise<void> {
      if (!overlay || !enabledMechanicalIds.has(engineId)) return;
      overlay.setMachineStatus("正在调用机器翻译…");
      try {
        const text = await translateWithMechanicalEngine(
          detected.text,
          engineId,
          controller.locator?.attachmentID,
        );
        if (
          controller.overlay !== overlay ||
          activeMechanicalEngine !== engineId
        )
          return;
        overlay.setMachineText(text);
        latestMachineTranslation = text;
      } catch (err) {
        if (
          controller.overlay !== overlay ||
          activeMechanicalEngine !== engineId
        )
          return;
        overlay.setMachineError(errorMessage(err));
      }
    }

    async function runAITranslation(
      controller: TranslateModeController,
    ): Promise<void> {
      if (!overlay || aiStarted || translationDone) return;
      aiStarted = true;
      overlay.setAIExpanded(true);
      if (!preset) {
        debugLog("renderForCurrent missing preset");
        overlay.setError("请先在设置中配置一个翻译用的账号。");
        return;
      }
      if (!model) {
        debugLog("renderForCurrent missing model");
        overlay.setError("请先为翻译账号选择模型。");
        return;
      }
      overlay.setStatus("正在翻译…");
      let buffer = "";
      let usageLabel = "";
      debugLog("translation request start", {
        model,
        thinking: settings.thinking,
        ctxLevel: settings.ctxLevel,
      });
      try {
        for await (const chunk of translateSentence({
          sentence: detected.text,
          contextLabel: contextLabel(settings.ctxLevel),
          contextText: contextText(detected, settings.ctxLevel),
          preset,
          model,
          thinking: settings.thinking,
          signal: controller.abortCtrl!.signal,
        })) {
          if (controller.overlay !== overlay) {
            debugLog("translation abandoned: overlay changed");
            return;
          }
          if (chunk.type === "text" && chunk.text) {
            const text = cleanTranslationOutput(chunk.text);
            overlay.appendText(text);
            buffer += text;
            latestTranslation = buffer;
            debugLog("translation text chunk", {
              chars: text.length,
              totalChars: buffer.length,
            });
          } else if (chunk.type === "error" && chunk.message) {
            debugLog("translation chunk error", { message: chunk.message });
            overlay.setError(chunk.message);
          } else if (chunk.type === "usage") {
            usageLabel = formatUsageLabel(
              chunk.input,
              chunk.output,
              chunk.cacheRead,
            );
          } else if (chunk.type === "done" && buffer) {
            const entry: CacheEntry = {
              text: buffer,
              model,
              createdAt: Date.now(),
            };
            controller.translationCache.set(memoryKey, entry);
            if (key) void setCachedTranslation(key, entry);
            latestTranslation = buffer;
            translationDone = true;
            overlay.setText(buffer);
            controller.runCurrentSecondaryMode(detected, overlay, settings);
            controller.scheduleTranslationPrefetch(
              detected,
              settings,
              preset,
              model,
            );
            if (usageLabel) overlay.setStatusLabel(`● 已完成 · ${usageLabel}`);
            else overlay.setDone();
            debugLog("translation done", { chars: buffer.length });
          } else if (chunk.type === "done") {
            overlay.setError("模型没有返回译文。");
          }
        }
      } catch (err) {
        const message = errorMessage(err);
        debugLog("translation threw", { error: message });
        if (controller.overlay === overlay) overlay.setError(message);
      }
    }
  }

  private runCurrentSecondaryMode(
    current: DetectedSentence,
    overlay: OverlayHandle,
    settings: TranslateSettings,
  ): void {
    if (this.currentMode === "analyze") {
      void this.runAnalysis(current, overlay, settings);
    } else if (this.currentMode === "explain") {
      void this.runExplanation(current, overlay, settings);
    }
  }

  private async saveTranslationAnnotation(
    current: DetectedSentence,
    overlay: OverlayHandle,
    translation: string,
    done: boolean,
    preset: AnnotationColorPreset,
    saveComment: boolean,
  ): Promise<void> {
    if (this.overlay !== overlay) return;
    const comment = translation.trim();
    if (!done || !comment) {
      overlay.setStatusLabel("● 翻译完成后可标注");
      return;
    }
    if (!this.locator?.attachmentID) {
      overlay.setError("保存标注失败：未找到当前 PDF 附件。");
      return;
    }

    overlay.setPaletteEnabled(false);
    overlay.setStatusLabel(`● 保存标注：${preset.label}`);
    try {
      const draft: TranslationAnnotationDraft = {
        text: current.text,
        attachmentID: this.locator.attachmentID,
        pageLabel: current.pageLabel,
        pageIndex: current.pageIndex,
        rects: current.rects,
        sortIndex: current.sortIndex,
      };
      await saveTranslationHighlight(draft, {
        comment: saveComment ? comment : "",
        color: preset.color,
      });
      if (this.overlay === overlay) {
        overlay.setStatusLabel(`● 已标注：${preset.label}`);
      }
    } catch (err) {
      if (this.overlay === overlay) {
        overlay.setError(`保存标注失败：${errorMessage(err)}`);
      }
    } finally {
      if (this.overlay === overlay) overlay.setPaletteEnabled(true);
    }
  }

  private async saveQuestionAnnotations(
    current: DetectedSentence,
    overlay: OverlayHandle,
    entries: QuestionAnswerEntry[],
    settings: TranslateSettings,
  ): Promise<void> {
    if (this.overlay !== overlay) return;
    if (!entries.length) {
      overlay.setQuestionAnnotationStatus("请先完成一次问答");
      return;
    }
    if (!this.locator?.attachmentID) {
      overlay.setQuestionAnnotationStatus("未找到当前 PDF 附件");
      return;
    }
    overlay.setQuestionAnnotationStatus("正在写入…");
    try {
      const draft: TranslationAnnotationDraft = {
        text: current.text,
        attachmentID: this.locator.attachmentID,
        pageLabel: current.pageLabel,
        pageIndex: current.pageIndex,
        rects: current.rects,
        sortIndex: current.sortIndex,
      };
      const result = await appendQuestionAnswerAnnotation(draft, {
        entries,
        type: settings.questionAnnotationType,
        color: settings.questionAnnotationColor,
      });
      if (this.overlay === overlay) {
        overlay.setQuestionAnnotationStatus(
          result.appended
            ? result.created
              ? "已创建批注"
              : `已追加 ${result.appended} 组问答`
            : "批注中已包含这些问答",
        );
      }
    } catch (err) {
      if (this.overlay === overlay) {
        overlay.setQuestionAnnotationStatus(`写入失败：${errorMessage(err)}`);
      }
    }
  }

  private clearOverlay(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.overlay?.destroy();
    this.overlay = null;
  }

  private dismissOverlay(): void {
    this.clearOverlay();
    this.current = null;
  }
}

function keyEventWindows(win: Window): Window[] {
  const out: Window[] = [];
  let current: Window | null = win;
  for (let i = 0; i < 4 && current; i++) {
    if (!out.includes(current)) out.push(current);
    let parent: Window | null = null;
    try {
      parent = current.parent;
      if (!parent || parent === current) break;
      // Accessing document verifies we can install a listener in that realm.
      void parent.document;
    } catch {
      break;
    }
    current = parent;
  }
  return out;
}

function consumeKeyEvent(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation?.();
}

function readerWindow(reader: ReaderLike): Window | null {
  const r = reader as ReaderLike;
  return (
    r._internalReader?._primaryView?._iframeWindow ??
    r._internalReader?._secondaryView?._iframeWindow ??
    r._internalReader?._iframeWindow ??
    r._iframeWindow ??
    null
  );
}

function closestElement(node: Node | null, selector: string): Element | null {
  const start =
    node && node.nodeType === 1
      ? (node as Element)
      : ((node as { parentElement?: Element | null } | null)?.parentElement ??
        null);
  return typeof start?.closest === "function" ? start.closest(selector) : null;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  const node = target as Node | null;
  return !!closestElement(
    node,
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
}

function eventHitsPage(
  win: Window,
  clientX: number,
  clientY: number,
  target: Node | null,
): boolean {
  if (closestElement(target, ".page,[data-page-number]")) return true;

  // Zotero Reader resolves pointer hits with elementsFromPoint(), because the
  // event target can be a child overlay while the PDF page is underneath.
  const elements =
    typeof win.document.elementsFromPoint === "function"
      ? Array.from(win.document.elementsFromPoint(clientX, clientY))
      : [];
  return elements.some((el) => closestElement(el, ".page,[data-page-number]"));
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickPreset(
  presets: ModelPreset[],
  desiredId: string,
): ModelPreset | null {
  if (!presets.length) return null;
  return presets.find((p) => p.id === desiredId) ?? presets[0]!;
}

function availableOverlayModes(
  settings: TranslateSettings,
): TranslateOverlayMode[] {
  return settings.overlayModeOrder.filter((mode) =>
    settings.visibleOverlayModes.includes(mode),
  );
}

export function shouldInitiallyExpandAI(
  mode: TranslateOverlayMode,
  displayMode: TranslateSettings["aiDisplayMode"],
  forceRefresh: boolean,
  hasCache: boolean,
): boolean {
  return (
    forceRefresh ||
    (mode !== "translate" && mode !== "question") ||
    displayMode === "always-open" ||
    hasCache
  );
}

export function shouldPrefetchTranslations(
  displayMode: TranslateSettings["aiDisplayMode"],
  count: TranslateSettings["aiPrefetchCount"],
): boolean {
  return displayMode === "always-open" && count > 0;
}

function explanationCacheKey(sentence: string): string {
  return "explain:" + fnv1aHex64(normalizeSentence(sentence)).slice(0, 16);
}

function displayKey(formatted: string): string {
  return formatted.replace("Shift+Enter", "⇧↵").replace("Enter", "↵");
}

function contextLabel(level: string): string | undefined {
  if (level === "paragraph") return "上下文段落";
  if (level === "page") return "当前页上下文";
  return undefined;
}

function contextText(
  current: DetectedSentence,
  level: string,
): string | undefined {
  if (level === "paragraph") return current.paragraphContext;
  if (level === "page") return current.bundle.pageText;
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatUsageLabel(
  input: number | undefined,
  output: number | undefined,
  cacheRead: number | undefined,
): string {
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  const cacheTokens = cacheRead ?? 0;
  const cache = cacheTokens > 0 ? `，缓存 ${cacheTokens}` : "";
  return `token ${inputTokens}/${outputTokens}${cache}`;
}

function safeWindowUrl(win: Window): string {
  try {
    return win.location?.href ?? "(no location)";
  } catch (err) {
    return `(location threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function safeHasParent(win: Window): boolean | string {
  try {
    return win.parent !== win;
  } catch (err) {
    return `(parent threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function debugLog(message: string, extra?: Record<string, unknown>): void {
  logTranslateDebug("zai-translate-mode", message, extra);
}

// Zotero updates PDF text selections asynchronously after pointerup.
const SELECTION_STABILIZE_DELAY_MS = 80;
// Linux/Zotero PDF sometimes delivers pointerup without a reliable click event.
const CLICK_FALLBACK_DELAY_MS = 120;
const MODE_STYLE_ID = "zai-translate-mode-style";

function ensureModeStyle(doc: Document): void {
  if (doc.getElementById(MODE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = MODE_STYLE_ID;
  style.textContent = `
body.zai-translate-mode-on .page { cursor: crosshair !important; }
body.zai-translate-mode-on .textLayer span:hover {
  background: rgba(74, 140, 247, 0.10);
  border-radius: 2px;
}
`;
  (doc.head ?? doc.documentElement)?.append(style);
}
