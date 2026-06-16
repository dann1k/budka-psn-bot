// Фич-тоглы бота. Значения берутся из config/features.json в корне репозитория —
// его можно править через true/false и коммитить в GitHub. Файл бандлится в Edge
// Function при деплое, поэтому новое значение «подтягивается» при следующем деплое
// (push в main → GitHub Actions → supabase functions deploy). Рантайм-фетча нет:
// флаг читается из бандла без сетевых задержек на каждый апдейт.
import featuresJson from "../../../config/features.json" with { type: "json" };

export type FeatureFlags = {
  /**
   * Чистить «командный мусор» меню: удалять сообщение с командой /menu сразу
   * после показа меню и само меню после выбора пункта (или его закрытия).
   * Удаление чужих сообщений в группе работает только если бот — админ с правом
   * «Удаление сообщений»; своё меню бот удаляет всегда. См. bot.ts.
   */
  deleteMenuMessages: boolean;
};

// Безопасные значения по умолчанию на случай, если ключ в JSON отсутствует или
// имеет неверный тип. По умолчанию фича выключена — включается явно в JSON.
const DEFAULTS: FeatureFlags = {
  deleteMenuMessages: false
};

export function loadFeatureFlags(): FeatureFlags {
  const raw = featuresJson as Partial<Record<keyof FeatureFlags, unknown>>;

  return {
    deleteMenuMessages:
      typeof raw.deleteMenuMessages === "boolean"
        ? raw.deleteMenuMessages
        : DEFAULTS.deleteMenuMessages
  };
}
