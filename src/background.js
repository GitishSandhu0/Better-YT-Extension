/*
 * Better YouTube — service worker.
 *
 * Responsibilities:
 *   - keep static declarativeNetRequest rulesets in sync with user settings
 *   - persist daily/all-time counters reported by content scripts
 */
importScripts("/lib/config.js");

const {
  STORAGE_KEY,
  STATS_KEY,
  DEFAULTS,
  normalizeSettings,
  normalizeStats,
  emptyStats,
  isYouTubeUrl,
} = self.BY_CONFIG;

const ADS_RULESET = "ads";
const SHORTS_RULESET = "shorts_redirect";

async function readSettings() {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return normalizeSettings(stored[STORAGE_KEY]);
  } catch (error) {
    console.warn("[Better YouTube] Could not read settings", error);
    return { ...DEFAULTS };
  }
}

async function syncRulesets(settings) {
  const desired = new Map([
    [ADS_RULESET, !!settings.adblock],
    [SHORTS_RULESET, !!(settings.shorts && settings.redirectShorts)],
  ]);

  try {
    const current = new Set(
      await chrome.declarativeNetRequest.getEnabledRulesets()
    );
    const enableRulesetIds = [];
    const disableRulesetIds = [];

    for (const [id, shouldEnable] of desired) {
      if (shouldEnable && !current.has(id)) enableRulesetIds.push(id);
      if (!shouldEnable && current.has(id)) disableRulesetIds.push(id);
    }

    if (enableRulesetIds.length || disableRulesetIds.length) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds,
        disableRulesetIds,
      });
    }
  } catch (error) {
    console.warn("[Better YouTube] Could not update network rules", error);
  }
}

async function ensureDefaults() {
  const settings = await readSettings();
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });

  try {
    const stored = await chrome.storage.local.get(STATS_KEY);
    await chrome.storage.local.set({
      [STATS_KEY]: normalizeStats(stored[STATS_KEY]),
    });
  } catch (error) {
    console.warn("[Better YouTube] Could not initialize stats", error);
  }

  await syncRulesets(settings);
}

/* Keep rules correct whenever the worker wakes, not just on install. */
readSettings().then(syncRulesets);

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[STORAGE_KEY]) return;
  syncRulesets(normalizeSettings(changes[STORAGE_KEY].newValue));
});

/*
 * Counter writes are serialized: two content scripts finishing at the same
 * moment must not read-modify-write over each other.
 */
let statsQueue = Promise.resolve();

function enqueueStats(kind, count) {
  statsQueue = statsQueue
    .then(async () => {
      const stored = await chrome.storage.local.get(STATS_KEY);
      const stats = normalizeStats(stored[STATS_KEY]);

      if (kind === "ads") {
        stats.adsToday += count;
        stats.adsTotal += count;
      } else {
        stats.shortsToday += count;
        stats.shortsTotal += count;
      }

      await chrome.storage.local.set({ [STATS_KEY]: stats });
    })
    .catch((error) => {
      console.warn("[Better YouTube] Could not update stats", error);
    });

  return statsQueue;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "stats:bump") return false;

  const senderUrl = sender.url || (sender.tab && sender.tab.url);
  if (!isYouTubeUrl(senderUrl)) {
    sendResponse({ ok: false });
    return false;
  }

  const kind = message.kind;
  if (kind !== "ads" && kind !== "shorts") {
    sendResponse({ ok: false });
    return false;
  }

  const count = Math.max(1, Math.min(25, Number(message.count) || 1));

  enqueueStats(kind, count).then(() => sendResponse({ ok: true }));
  return true;
});
