import { config } from "../../package.json";

export interface MechanicalTranslationService {
  id: string;
  name: string;
}

interface TranslateTaskLike {
  result?: string;
  status?: "waiting" | "processing" | "success" | "fail";
}

interface TranslateForZoteroAPI {
  getServices(): Array<{ id?: unknown; name?: unknown; type?: unknown }>;
  translate(
    raw: string,
    options: { pluginID: string; service: string; itemID?: number },
  ): Promise<TranslateTaskLike>;
}

interface TranslateForZoteroPlugin {
  api?: Partial<TranslateForZoteroAPI>;
  data?: {
    translate?: {
      services?: {
        getServiceNameByID?: (id: string) => string;
      };
    };
  };
}

function getPlugin(): TranslateForZoteroPlugin | null {
  return (
    ((Zotero as unknown as Record<string, unknown>)[
      "PDFTranslate"
    ] as TranslateForZoteroPlugin | undefined) ?? null
  );
}

function getAPI(): TranslateForZoteroAPI | null {
  const plugin = getPlugin();
  const api = plugin?.api;
  return typeof api?.getServices === "function" &&
    typeof api.translate === "function"
    ? (api as TranslateForZoteroAPI)
    : null;
}

export function getMechanicalTranslationServices(): MechanicalTranslationService[] {
  const api = getAPI();
  if (!api) return [];
  const serviceManager = getPlugin()?.data?.translate?.services;
  try {
    const seen = new Set<string>();
    const services: MechanicalTranslationService[] = [];
    for (const service of api.getServices()) {
      const id = typeof service.id === "string" ? service.id.trim() : "";
      if (!id || seen.has(id) || service.type !== "sentence") continue;
      seen.add(id);
      let translatedName = "";
      try {
        translatedName = serviceManager?.getServiceNameByID?.(id)?.trim() ?? "";
      } catch {
        // Older Translate for Zotero builds may not expose the name resolver.
      }
      services.push({
        id,
        name: translatedName ||
          (typeof service.name === "string" && service.name.trim()
            ? service.name.trim()
            : id),
      });
    }
    return services;
  } catch {
    return [];
  }
}

export function isTranslateForZoteroAvailable(): boolean {
  return getAPI() !== null;
}

export async function translateWithMechanicalEngine(
  text: string,
  service: string,
  itemID?: number,
): Promise<string> {
  const api = getAPI();
  if (!api) {
    throw new Error("未检测到 Translate for Zotero（“翻译”插件），请先安装并启用它。");
  }
  const task = await api.translate(text, {
    pluginID: config.addonID,
    service,
    ...(itemID && itemID > 0 ? { itemID } : {}),
  });
  const result = typeof task.result === "string" ? task.result.trim() : "";
  if (task.status === "fail") throw new Error(result || "机器翻译失败。");
  if (!result) throw new Error("翻译引擎没有返回译文。");
  return result;
}
