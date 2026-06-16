// Фич-тоглы бота. Значения берутся из config/features.json в корне репозитория —
// его можно править (true/false, числа) и коммитить в GitHub. Файл бандлится в Edge
// Function при деплое, поэтому новое значение «подтягивается» при следующем деплое
// (push в main → GitHub Actions → supabase functions deploy). Рантайм-фетча нет:
// флаги читаются из бандла без сетевых задержек на каждый апдейт.
import featuresJson from "../../../config/features.json" with { type: "json" };

// Множители разрешения рендера PNG-карточек по типам ответа. 1 = текущее
// поведение. >1 — крупнее/чётче, но дороже по CPU; <1 — мельче/быстрее.
// Зажимаются в [RENDER_SCALE_MIN, RENDER_SCALE_MAX], чтобы опечатка в конфиге
// (например 10) не убила воркер. ВНИМАНИЕ: для растущих карточек (table/popular)
// множитель поднимает и пиксельный бюджет — на больших чатах высокие значения
// могут упереться в лимит CPU Edge Function (~2с) и привести к сбою рендера.
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 2;
const DEFAULT_RENDER_SCALE = 1;

// Период обхода детектора платин: не чаще раза в 5 мин (рейт-лимиты PSN) и не реже
// раза в 6 ч (иначе анонсы запаздывают слишком сильно). Дефолт — 20 мин.
export const POLL_MINUTES_MIN = 5;
export const POLL_MINUTES_MAX = 360;
const DEFAULT_POLL_MINUTES = 20;

export type RenderScaleFlags = {
  /** Сводка игрока (/summary, кнопка «Моя сводка») — renderGamerCard. */
  summary: number;
  /** Таблица группы (/table) — renderLeaderboard. */
  table: number;
  /** Популярные игры (/popular) — renderPopularGames. */
  popular: number;
};

export type PlatinumWatcherFlags = {
  /** Включён ли фоновый детектор платин (только self-hosted, server/main.ts). */
  enabled: boolean;
  /** Период обхода аккаунтов в минутах (зажимается в [POLL_MINUTES_MIN, MAX]). */
  pollMinutes: number;
};

export type FeatureFlags = {
  /**
   * Чистить «командный мусор» меню: удалять сообщение с командой /menu сразу
   * после показа меню и само меню после выбора пункта (или его закрытия).
   * Удаление чужих сообщений в группе работает только если бот — админ с правом
   * «Удаление сообщений»; своё меню бот удаляет всегда. См. bot.ts.
   */
  deleteMenuMessages: boolean;
  /**
   * Множители разрешения PNG-карточек по типам ответа (см. RenderScaleFlags).
   * Прокидываются в renderer.tsx как scaleMultiplier.
   */
  renderScale: RenderScaleFlags;
  /**
   * Фоновый детектор новых платин: постит уведомление в чат(ы), когда
   * привязанный игрок выбивает платину. Работает только в self-hosted рантайме
   * (server/main.ts), не в Edge Functions. См. platinum-watcher.ts.
   */
  platinumWatcher: PlatinumWatcherFlags;
};

// Безопасные значения по умолчанию на случай, если ключ в JSON отсутствует или
// имеет неверный тип. deleteMenuMessages по умолчанию выключен; множители = 1
// (= текущее поведение рендера).
const DEFAULTS: FeatureFlags = {
  deleteMenuMessages: false,
  renderScale: {
    summary: DEFAULT_RENDER_SCALE,
    table: DEFAULT_RENDER_SCALE,
    popular: DEFAULT_RENDER_SCALE
  },
  platinumWatcher: {
    enabled: false,
    pollMinutes: DEFAULT_POLL_MINUTES
  }
};

// Валидирует один множитель: положительное конечное число, зажатое в допустимый
// диапазон. Мусор/отсутствие → дефолт 1.
function readRenderScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RENDER_SCALE;
  }

  return Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, value));
}

// Зажимает период обхода в [POLL_MINUTES_MIN, POLL_MINUTES_MAX]; мусор → дефолт.
function readPollMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_POLL_MINUTES;
  }

  return Math.min(POLL_MINUTES_MAX, Math.max(POLL_MINUTES_MIN, value));
}

export function loadFeatureFlags(): FeatureFlags {
  const raw = featuresJson as {
    deleteMenuMessages?: unknown;
    renderScale?: Record<string, unknown>;
    platinumWatcher?: Record<string, unknown>;
  };
  const renderScale = raw.renderScale ?? {};
  const platinumWatcher = raw.platinumWatcher ?? {};

  return {
    deleteMenuMessages:
      typeof raw.deleteMenuMessages === "boolean"
        ? raw.deleteMenuMessages
        : DEFAULTS.deleteMenuMessages,
    renderScale: {
      summary: readRenderScale(renderScale.summary),
      table: readRenderScale(renderScale.table),
      popular: readRenderScale(renderScale.popular)
    },
    platinumWatcher: {
      enabled:
        typeof platinumWatcher.enabled === "boolean"
          ? platinumWatcher.enabled
          : DEFAULTS.platinumWatcher.enabled,
      pollMinutes: readPollMinutes(platinumWatcher.pollMinutes)
    }
  };
}
