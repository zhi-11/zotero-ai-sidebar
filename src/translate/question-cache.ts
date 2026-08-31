import {
  fnv1aHex64,
  getCachedTranslation,
  normalizeSentence,
  setCachedTranslation,
} from "./cache";
import type { QuestionAnswerEntry } from "./translator";

const QUESTION_CACHE_PREFIX = "question:";

export function questionCacheKey(sentence: string): string {
  return (
    QUESTION_CACHE_PREFIX + fnv1aHex64(normalizeSentence(sentence)).slice(0, 16)
  );
}

export async function getCachedQuestionAnswers(
  sentence: string,
): Promise<QuestionAnswerEntry[]> {
  const cached = await getCachedTranslation(questionCacheKey(sentence));
  if (!cached?.text) return [];
  try {
    return normalizeQuestionAnswers(JSON.parse(cached.text));
  } catch {
    return [];
  }
}

export function setCachedQuestionAnswers(
  sentence: string,
  entries: QuestionAnswerEntry[],
  model: string,
): Promise<void> {
  return setCachedTranslation(questionCacheKey(sentence), {
    text: JSON.stringify(normalizeQuestionAnswers(entries)),
    model,
    createdAt: Date.now(),
  });
}

export function normalizeQuestionAnswers(
  value: unknown,
): QuestionAnswerEntry[] {
  if (!Array.isArray(value)) return [];
  const out: QuestionAnswerEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Partial<QuestionAnswerEntry>;
    const question =
      typeof entry.question === "string" ? entry.question.trim() : "";
    const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
    if (question && answer) out.push({ question, answer });
  }
  return out;
}
