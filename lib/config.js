/*
 * Better YouTube — shared configuration.
 *
 * This file is loaded as a classic script in three different environments:
 *   - content scripts (isolated world)
 *   - the page's main world
 *   - the extension service worker (via importScripts)
 *
 * It also exports itself through CommonJS so the sanitizer tests can run in Node.
 */
(function (root, factory) {
  "use strict";

  const api = factory();

  if (
    typeof module === "object" &&
    module.exports &&
    typeof process !== "undefined" &&
    process.versions &&
    process.versions.node
  ) {
    module.exports = api;
  }

  if (root) {
    root.BY_CONFIG = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  /** chrome.storage.sync key holding the user's settings object. */
  const STORAGE_KEY = "settings";

  /** localStorage key used to hand settings to the page's main world synchronously. */
  const MIRROR_KEY = "by.settings.v1";

  /** chrome.storage.local key holding counters. */
  const STATS_KEY = "stats";

  const DEFAULTS = Object.freeze({
    adblock: true,
    shorts: true,
    hdr: true,
    redirectShorts: true,
    aggressiveSkip: true,
    hdrQuality: true,
    hdrBadge: true,
    amoled: false,
    focus: false,
  });

  /**
   * Direct ad renderers, used for counting. Wrappers are handled by CSS :has()
   * so we do not count both a wrapper and the ad inside it.
   */
  const AD_COUNT_SELECTOR = [
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-display-ad-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-compact-promoted-video-renderer",
    "ytd-search-pyw-renderer",
    "ytd-video-masthead-ad-v3-renderer",
    "ytd-primetime-promo-renderer",
    "ytd-background-promo-renderer",
    "ytd-guide-promo-renderer",
    "ytd-merch-shelf-renderer",
    "#masthead-ad",
    "#player-ads",
    "ytm-promoted-sparkles-web-renderer",
    "ytm-companion-slot-renderer",
  ].join(",");

  /**
   * Shorts containers. We deliberately do not include ytd-shorts (the Shorts
   * player page) here: if link conversion is disabled, direct Shorts links
   * should still be watchable.
   */
  const SHORTS_COUNT_SELECTOR = [
    "ytd-reel-shelf-renderer",
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytd-rich-item-renderer:has(a[href^='/shorts/'])",
    "ytd-video-renderer:has(a[href^='/shorts/'])",
    "ytd-compact-video-renderer:has(a[href^='/shorts/'])",
    "ytd-grid-video-renderer:has(a[href^='/shorts/'])",
    "ytd-playlist-video-renderer:has(a[href^='/shorts/'])",
    "ytd-guide-entry-renderer:has(a[href^='/shorts'])",
    "ytd-mini-guide-entry-renderer:has(a[href^='/shorts'])",
    "ytm-reel-shelf-renderer",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-shelf-renderer",
  ].join(",");

  /** YouTube's "ad blockers are not allowed" dialog. */
  const ENFORCEMENT_SELECTOR =
    "ytd-enforcement-message-view-model, yt-confirm-dialog-renderer:has(ytd-enforcement-message-view-model)";

  /** /shorts/<11-char id> */
  const SHORTS_PATH_RE = /^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/;

  function normalizeSettings(value) {
    const out = { ...DEFAULTS };
    if (!value || typeof value !== "object") return out;

    for (const key of Object.keys(DEFAULTS)) {
      if (typeof value[key] === "boolean") out[key] = value[key];
    }
    return out;
  }

  function todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function emptyStats() {
    return {
      day: todayKey(),
      adsToday: 0,
      shortsToday: 0,
      adsTotal: 0,
      shortsTotal: 0,
    };
  }

  function normalizeStats(value) {
    const out = emptyStats();
    if (!value || typeof value !== "object") return out;

    for (const key of ["adsToday", "shortsToday", "adsTotal", "shortsTotal"]) {
      const number = Number(value[key]);
      if (Number.isFinite(number) && number > 0) out[key] = Math.floor(number);
    }

    // Daily counters reset when the local calendar day changes. All-time
    // counters are preserved.
    if (value.day && value.day !== out.day) {
      out.adsToday = 0;
      out.shortsToday = 0;
    }

    return out;
  }

  function isYouTubeUrl(url) {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        (parsed.hostname === "youtube.com" ||
          parsed.hostname.endsWith(".youtube.com"))
      );
    } catch {
      return false;
    }
  }

  return {
    STORAGE_KEY,
    MIRROR_KEY,
    STATS_KEY,
    DEFAULTS,
    AD_COUNT_SELECTOR,
    SHORTS_COUNT_SELECTOR,
    ENFORCEMENT_SELECTOR,
    SHORTS_PATH_RE,
    normalizeSettings,
    normalizeStats,
    emptyStats,
    todayKey,
    isYouTubeUrl,
  };
});
