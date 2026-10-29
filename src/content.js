/*
 * Better YouTube — isolated content script.
 *
 * Handles everything that needs DOM access:
 *   - applies CSS filter classes from settings (no flash on reload)
 *   - filters Focus mode sections and manages the Home reveal button
 *   - counts blocked ads/Shorts for the popup
 *   - skips/closes video ads as a fallback to player-data stripping
 *   - removes YouTube's anti-adblock dialog
 *   - redirects /shorts/ links when the SPA misses the network rule
 *   - renders the HDR status badge
 */
(() => {
  "use strict";

  const config = self.BY_CONFIG;
  if (!config) return;

  const {
    DEFAULTS,
    MIRROR_KEY,
    STORAGE_KEY,
    normalizeSettings,
    AD_COUNT_SELECTOR,
    SHORTS_COUNT_SELECTOR,
    ENFORCEMENT_SELECTOR,
    SHORTS_PATH_RE,
  } = config;

  let settings = readMirror();
  let observer = null;
  let observerWaitingForRoot = false;
  let sweepTimer = null;
  let adTimer = null;
  let adState = null;
  let playbackRecoveryTimer = null;
  let playbackRecoveryStage = 0;
  let playbackRecoveryStartedAt = 0;
  let playbackRecoveryNavKey = "";
  let contentPlaybackSeen = false;
  let lastHdr = null;
  let badgeRetryTimer = null;
  let badgeRetryCount = 0;
  let reportTimer = null;
  let pending = { ads: 0, shorts: 0 };
  let shortRedirectCounted = false;
  let lastShortRedirectId = "";
  let focusHomeButton = null;
  let focusLocationKey = "";

  const seenAds = new WeakSet();
  const seenShorts = new WeakSet();

  const FOCUS_HIDDEN_ATTR = "data-by-focus-hidden";
  const FOCUS_SEARCH_RECOMMENDED_RE =
    /^(shorts|people also watched|people also search for|related searches|related videos|for you|recommended|you might also like|you may also like|explore more|more from youtube|watch again|because you watched)/i;

  function readMirror() {
    try {
      const raw = window.localStorage.getItem(MIRROR_KEY);
      return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveMirror(value) {
    try {
      window.localStorage.setItem(MIRROR_KEY, JSON.stringify(value));
    } catch {
      /* Storage can be disabled by the user. */
    }
  }

  function applyClasses() {
    const root = document.documentElement;
    if (!root) return;

    root.classList.toggle("by-adblock", !!settings.adblock);
    root.classList.toggle("by-shorts", !!settings.shorts);
    root.classList.toggle("by-amoled", !!settings.amoled);
    root.classList.toggle("by-focus", !!settings.focus);

    const focusHome = !!settings.focus && location.pathname === "/";
    root.classList.toggle("by-focus-home", focusHome);
    if (!focusHome) root.classList.remove("by-focus-reveal-home");
  }

  function notifyMain() {
    try {
      window.postMessage(
        { source: "better-yt-content", type: "settings", settings },
        "*"
      );
    } catch {
      /* Non-fatal. */
    }
  }

  function applySettings(next, options = {}) {
    settings = normalizeSettings(next);

    if (options.writeMirror !== false) saveMirror(settings);

    applyFeatureState();

    if (options.notifyMain !== false) notifyMain();
  }

  /* ----------------------------------------------------------------------- *
   * Stats
   * ----------------------------------------------------------------------- */

  function report(kind, count = 1) {
    if (kind === "ads" && !settings.adblock) return;
    if (kind === "shorts" && !settings.shorts) return;

    const amount = Math.max(1, Math.min(25, Number(count) || 1));
    pending[kind] += amount;

    if (reportTimer) return;
    reportTimer = setTimeout(flushReports, 1200);
  }

  function flushReports() {
    reportTimer = null;

    const ads = pending.ads;
    const shorts = pending.shorts;
    pending = { ads: 0, shorts: 0 };

    if (ads > 0) sendStats("ads", ads);
    if (shorts > 0) sendStats("shorts", shorts);
  }

  function sendStats(kind, count) {
    let remaining = count;

    while (remaining > 0) {
      const chunk = Math.min(remaining, 25);
      remaining -= chunk;

      try {
        const result = chrome.runtime.sendMessage({
          type: "stats:bump",
          kind,
          count: chunk,
        });

        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
      } catch {
        /* The extension was reloaded or removed. */
      }
    }
  }

  /* ----------------------------------------------------------------------- *
   * Mutation-driven DOM filtering
   * ----------------------------------------------------------------------- */

  function startObserver() {
    if (observer) return;

    const root = document.documentElement;

    if (!root) {
      if (observerWaitingForRoot) return;
      observerWaitingForRoot = true;
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          observerWaitingForRoot = false;
          if (settings.adblock || settings.shorts || settings.focus) {
            startObserver();
          }
        },
        { once: true }
      );
      return;
    }

    try {
      observer = new MutationObserver(scheduleSweep);
      observer.observe(root, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
  }

  function scheduleSweep() {
    if (sweepTimer) return;

    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      sweep();
    }, 150);
  }

  function sweep() {
    if (settings.adblock) {
      countNew(AD_COUNT_SELECTOR, seenAds, "ads");
      removeEnforcement();
    }

    if (settings.shorts) {
      countNew(SHORTS_COUNT_SELECTOR, seenShorts, "shorts");
      hideShortsTabs();
      maybeRedirectShorts();
    }

    if (settings.hdr && settings.hdrBadge && lastHdr && lastHdr.available) {
      ensureHdrBadge();
    }

    if (settings.focus) {
      hideFocusSections();
      syncFocusHomeButton();
    }
  }

  function countNew(selector, seen, kind) {
    let count = 0;

    try {
      document.querySelectorAll(selector).forEach((element) => {
        if (seen.has(element)) return;
        seen.add(element);
        count += 1;
      });
    } catch {
      return;
    }

    if (count > 0) report(kind, count);
  }

  /* ----------------------------------------------------------------------- *
   * Anti-adblock dialog
   * ----------------------------------------------------------------------- */

  function removeEnforcement() {
    let found = false;

    try {
      document.querySelectorAll(ENFORCEMENT_SELECTOR).forEach((node) => {
        found = true;
        const dialog = node.closest(
          "tp-yt-paper-dialog, yt-confirm-dialog-renderer"
        );
        (dialog || node).remove();
      });
    } catch {
      /* Non-fatal. */
    }

    if (!found) return;

    const video = document.querySelector("#movie_player video");
    if (video && video.paused) {
      const result = video.play();
      if (result && typeof result.catch === "function") result.catch(() => {});
    }
  }

  /* ----------------------------------------------------------------------- *
   * Video ad fallback: click skip, otherwise mute + fast-forward short ads
   * ----------------------------------------------------------------------- */

  function startAdSkipper() {
    if (adTimer) return;
    adTimer = setInterval(adTick, 500);
    adTick();
  }

  function stopAdSkipper() {
    if (adTimer) clearInterval(adTimer);
    adTimer = null;
    restoreAdPlayback();
  }

  function isSkipButtonReady(button) {
    if (!button || button.disabled) return false;
    if (button.getAttribute("aria-disabled") === "true") return false;
    return !button.classList.contains("ytp-ad-skip-button-disabled");
  }

  function adTick() {
    if (!settings.adblock) return;

    const player = document.querySelector("#movie_player");
    if (!player) {
      restoreAdPlayback();
      return;
    }

    const showing = isAdShowing(player);

    if (!showing) {
      restoreAdPlayback();
      return;
    }

    if (!adState) {
      adState = {
        video: null,
        wasMuted: null,
        rate: 1,
        startedAt: Date.now(),
        reported: false,
      };
    }

    // Even though CSS hides the ad module, programmatic clicks still work.
    const skip = player.querySelector(
      ".ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-container button, .ytp-ad-skip-button-slot button"
    );
    const skipReady = isSkipButtonReady(skip);
    const adUi = hasAdUi(player);

    /*
     * A blocked ad can leave `ad-showing` behind after the ad UI is gone.
     * Wait briefly for the real ad UI to settle, then discard the stale state
     * without muting, seeking, or counting the content video as an ad.
     */
    if (!adUi && !skipReady) {
      if (Date.now() - adState.startedAt > 1500) {
        undoAggressivePlayback();
        adState = null;
      }
      return;
    }

    if (!adState.reported) {
      adState.reported = true;
      report("ads", 1);
    }

    if (skipReady) {
      try {
        skip.click();
      } catch {
        /* Non-fatal. */
      }
    }

    if (!settings.aggressiveSkip) {
      // If aggressive skipping was just turned off mid-ad, undo our changes.
      undoAggressivePlayback();
      return;
    }

    // Give the ad UI a moment to become stable before touching the media.
    if (Date.now() - adState.startedAt < 500) return;

    const video = player.querySelector("video");
    if (!video) return;

    if (adState.video !== video) {
      adState.video = video;
      adState.wasMuted = video.muted;

      const playerRate =
        typeof player.getPlaybackRate === "function"
          ? Number(player.getPlaybackRate())
          : NaN;

      adState.rate =
        Number.isFinite(playerRate) && playerRate > 0 && playerRate <= 4
          ? playerRate
          : video.playbackRate || 1;
    }

    if (!video.muted) {
      try {
        video.muted = true;
      } catch {
        /* Non-fatal. */
      }
    }

    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;

    /*
     * Only fast-forward when the current media is clearly a short ad clip.
     * Server-side stitched ads can expose the whole video's duration; seeking
     * to the end there would skip the actual video.
     */
    if (duration <= 120) {
      if (video.playbackRate < 16) {
        try {
          video.playbackRate = 16;
        } catch {
          /* Non-fatal. */
        }
      }

      const target = Math.max(0, duration - 0.15);
      if (video.currentTime < target - 0.2) {
        try {
          video.currentTime = target;
        } catch {
          /* Non-fatal. */
        }
      }
    } else if (duration <= 600 && video.playbackRate < 4) {
      try {
        video.playbackRate = 4;
      } catch {
        /* Non-fatal. */
      }
    }
  }

  function undoAggressivePlayback() {
    if (!adState) return;

    const video = adState.video;
    if (video) {
      try {
        if (adState.wasMuted != null) video.muted = adState.wasMuted;
      } catch {
        /* Non-fatal. */
      }

      try {
        video.playbackRate = adState.rate || 1;
      } catch {
        /* Non-fatal. */
      }
    }

    adState.video = null;
    adState.wasMuted = null;
    adState.rate = 1;
  }

  function restoreAdPlayback() {
    if (!adState) return;
    undoAggressivePlayback();
    adState = null;
  }

  function isAdShowing(player) {
    return (
      !!player &&
      (player.classList.contains("ad-showing") ||
        player.classList.contains("ad-interrupting"))
    );
  }

  /*
   * `ad-showing` can briefly outlive a blocked ad. Only touch the media when
   * there is an actual ad UI, so a stale class can never mute or seek the
   * real video.
   */
  function hasAdUi(player) {
    if (!player) return false;

    try {
      if (
        player.querySelector(
          ".ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-container button, .ytp-ad-skip-button-slot button"
        )
      ) {
        return true;
      }

      const module = player.querySelector(".ytp-ad-module");
      if (module && module.childElementCount > 0) return true;

      return !!player.querySelector(
        ".ytp-ad-player-overlay, .ytp-ad-preview-container, .ytp-ad-text, .ytp-ad-duration-remaining, .ytp-ad-simple-ad-badge, .ytp-ad-progress-list"
      );
    } catch {
      return false;
    }
  }

  /* ----------------------------------------------------------------------- *
   * Playback recovery
   *
   * Blocking an ad can leave YouTube in a cued/buffering state: the player
   * knows the video duration but never requests the content stream. If no
   * real ad is on screen, nudge playback and, as a last resort, reload the
   * current video once. This is intentionally conservative: it never runs in
   * a hidden tab, during an actual ad, or after content has already played.
   * ----------------------------------------------------------------------- */

  function clearPlaybackRecovery() {
    if (playbackRecoveryTimer) clearTimeout(playbackRecoveryTimer);
    playbackRecoveryTimer = null;
  }

  function resetPlaybackRecovery() {
    clearPlaybackRecovery();
    playbackRecoveryNavKey = "";
    playbackRecoveryStage = 0;
    playbackRecoveryStartedAt = 0;
    contentPlaybackSeen = false;
  }

  function schedulePlaybackRecovery(delay = 1500) {
    if (!settings.adblock || contentPlaybackSeen) return;
    if (playbackRecoveryTimer) clearTimeout(playbackRecoveryTimer);
    playbackRecoveryTimer = setTimeout(checkPlaybackRecovery, delay);
  }

  function startPlaybackRecovery() {
    if (!settings.adblock || location.pathname !== "/watch") {
      clearPlaybackRecovery();
      return;
    }

    const key = location.href;
    if (key !== playbackRecoveryNavKey) {
      playbackRecoveryNavKey = key;
      playbackRecoveryStartedAt = Date.now();
      playbackRecoveryStage = 0;
      contentPlaybackSeen = false;
    }

    if (!contentPlaybackSeen && !playbackRecoveryTimer) {
      schedulePlaybackRecovery(1200);
    }
  }

  function videoIdFromLocation() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function tryPlay(player, video) {
    try {
      if (player && typeof player.playVideo === "function") {
        player.playVideo();
      }
    } catch {
      /* The player API may not be ready yet. */
    }

    try {
      const result = video && video.play();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      /* Autoplay policy or a detached media element. */
    }
  }

  function checkPlaybackRecovery() {
    playbackRecoveryTimer = null;

    if (!settings.adblock || location.pathname !== "/watch") return;

    // A hidden tab is expected to pause media; do not fight that behavior.
    if (document.visibilityState !== "visible") {
      schedulePlaybackRecovery(2000);
      return;
    }

    const player = document.querySelector("#movie_player");
    const video = player && player.querySelector("video");

    if (!player || !video) {
      if (Date.now() - playbackRecoveryStartedAt < 20000) {
        schedulePlaybackRecovery(1500);
      }
      return;
    }

    const adShowing = isAdShowing(player);
    const adUi = hasAdUi(player);
    const state =
      typeof player.getPlayerState === "function"
        ? Number(player.getPlayerState())
        : -1;
    const elapsed = Date.now() - playbackRecoveryStartedAt;

    /*
     * YouTube can queue an ad but never start it, leaving the content video
     * cued behind it. Once five seconds have passed without any media data,
     * bypass the ad UI entirely and ask the player to load the content again.
     */
    const noMedia = video.currentTime < 1 && video.readyState < 2;
    const forcePastAd = noMedia && elapsed >= 5000;


    if ((adShowing || adUi) && !forcePastAd) {
      schedulePlaybackRecovery(1000);
      return;
    }

    if (contentPlaybackSeen || video.ended) return;

    if (state === 1 && video.currentTime > 0.5) {
      contentPlaybackSeen = true;
      return;
    }

    if (elapsed > 30000) return;

    const stalled =
      video.currentTime < 1 &&
      (video.paused ||
        video.readyState < 2 ||
        state === -1 ||
        state === 3 ||
        state === 5);

    if (!stalled) {
      schedulePlaybackRecovery(1500);
      return;
    }

    /*
     * If an ad has blocked the media pipeline for five seconds, skip the
     * gentle play() nudge and reload the content directly.
     */
    if (forcePastAd && playbackRecoveryStage < 2) {
      playbackRecoveryStage = 2;

      const videoId = videoIdFromLocation();
      if (videoId && typeof player.loadVideoById === "function") {
        try {
          player.loadVideoById(videoId, 0);
        } catch {
          tryPlay(player, video);
        }
      } else {
        tryPlay(player, video);
      }

      schedulePlaybackRecovery(2500);
      return;
    }

    if (playbackRecoveryStage === 0) {
      playbackRecoveryStage = 1;
      tryPlay(player, video);
      schedulePlaybackRecovery(1000);
      return;
    }

    if (playbackRecoveryStage === 1) {
      playbackRecoveryStage = 2;

      const videoId = videoIdFromLocation();
      if (videoId && typeof player.loadVideoById === "function") {
        try {
          const current = Number(player.getCurrentTime());
          player.loadVideoById(videoId, current > 1 ? current : 0);
        } catch {
          tryPlay(player, video);
        }
      } else {
        tryPlay(player, video);
      }

      schedulePlaybackRecovery(3000);
      return;
    }

    playbackRecoveryStage = 3;
    tryPlay(player, video);
  }

  /* ----------------------------------------------------------------------- *
   * Shorts
   * ----------------------------------------------------------------------- */

  /*
   * DNR redirects happen before this content script starts, so the original
   * /shorts/ URL is never visible here. The network rule appends this marker;
   * consume it once, count the filtered Short, and remove it from the URL.
   */
  function consumeShortRedirectMarker() {
    if (
      location.pathname !== "/watch" ||
      !location.hash.startsWith("#by-shorts")
    ) {
      return;
    }

    if (!shortRedirectCounted) {
      shortRedirectCounted = true;
      report("shorts", 1);
      flushReports();
    }

    try {
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${location.search}`
      );
    } catch {
      /* DOMContentLoaded retries after the document URL is committed. */
    }
  }

  function maybeRedirectShorts() {
    if (!settings.shorts || !settings.redirectShorts) return;

    const match = location.pathname.match(SHORTS_PATH_RE);
    if (!match) return;
    if (lastShortRedirectId === match[1]) return;

    lastShortRedirectId = match[1];

    const params = new URLSearchParams(location.search);
    const timestamp = params.get("t");
    const target = `/watch?v=${match[1]}${
      timestamp ? `&t=${encodeURIComponent(timestamp)}` : ""
    }`;

    const redirect = () => {
      try {
        location.replace(target);
      } catch {
        /* Non-fatal. */
      }
    };

    /*
     * The page is about to unload, so a batched stats write could be lost.
     * Send this one immediately and give the worker a moment to persist it.
     */
    try {
      const result = chrome.runtime.sendMessage({
        type: "stats:bump",
        kind: "shorts",
        count: 1,
      });

      if (result && typeof result.then === "function") {
        Promise.race([
          result.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]).finally(redirect);
        return;
      }
    } catch {
      /* The extension was reloaded or removed. */
    }

    redirect();
  }

  function hideShortsTabs() {
    if (!settings.shorts) return;

    let tabs;
    try {
      tabs = document.querySelectorAll("tp-yt-paper-tab, yt-tab-shape");
    } catch {
      return;
    }

    tabs.forEach((tab) => {
      if ((tab.textContent || "").trim().toLowerCase() !== "shorts") return;
      if (tab.hasAttribute("data-better-yt-shorts")) return;

      tab.dataset.betterYtDisplay = tab.style.display;
      tab.style.display = "none";
      tab.setAttribute("data-better-yt-shorts", "");
    });
  }

  function restoreShortsTabs() {
    let tabs;
    try {
      tabs = document.querySelectorAll("[data-better-yt-shorts]");
    } catch {
      return;
    }

    tabs.forEach((tab) => {
      tab.style.display = tab.dataset.betterYtDisplay || "";
      tab.removeAttribute("data-better-yt-shorts");
      delete tab.dataset.betterYtDisplay;
    });
  }

  /* ----------------------------------------------------------------------- *
   * Focus mode
   * ----------------------------------------------------------------------- */

  function normalizeFocusText(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function markFocusHidden(node) {
    if (!node || node.hasAttribute(FOCUS_HIDDEN_ATTR)) return;
    node.setAttribute(FOCUS_HIDDEN_ATTR, "");
  }

  function restoreFocusHidden() {
    let nodes;
    try {
      nodes = document.querySelectorAll(`[${FOCUS_HIDDEN_ATTR}]`);
    } catch {
      return;
    }

    nodes.forEach((node) => node.removeAttribute(FOCUS_HIDDEN_ATTR));
  }

  /*
   * Read a section's own title, not the title of a video inside it. Search
   * results use a single item-section renderer for both direct results and
   * Shorts shelves, so a broad text lookup would hide the real results too.
   */
  function focusSectionTitle(node) {
    if (!node) return "";

    const title = node.querySelector(
      ":scope > #header #title, :scope > #header #title-text, :scope > #title, :scope > #title-text, :scope > h2, :scope > h3"
    );

    return normalizeFocusText(title && title.textContent);
  }

  function hideFocusSections() {
    if (!settings.focus) return;

    const locationKey = `${location.pathname}${location.search}`;
    if (locationKey !== focusLocationKey) {
      focusLocationKey = locationKey;
      restoreFocusHidden();
    }

    try {
      document.querySelectorAll("ytd-guide-section-renderer").forEach((section) => {
        const title = normalizeFocusText(
          section.querySelector("#guide-section-title")?.textContent
        );
        if (title.includes("more from youtube")) markFocusHidden(section);
      });

      document
        .querySelectorAll(
          "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer"
        )
        .forEach((entry) => {
          const title = normalizeFocusText(
            entry.querySelector(".title")?.textContent || entry.textContent
          );
          const href =
            entry.querySelector("a[href]")?.getAttribute("href") || "";

          if (
            title === "youtube premium" ||
            title === "youtube music" ||
            title === "youtube kids" ||
            title === "youtube tv" ||
            href.startsWith("/premium") ||
            href.includes("music.youtube.com") ||
            href.includes("youtubekids.com") ||
            href.includes("tv.youtube.com")
          ) {
            markFocusHidden(entry);
          }
        });

      document
        .querySelectorAll(
          "ytd-rich-section-renderer, ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer"
        )
        .forEach((section) => {
          if (focusSectionTitle(section).includes("more from youtube")) {
            markFocusHidden(section);
          }
        });

      if (location.pathname.startsWith("/results")) {
        document
          .querySelectorAll(
            "ytd-search ytd-item-section-renderer, ytd-search ytd-shelf-renderer, ytd-search ytd-reel-shelf-renderer, ytd-search ytd-rich-shelf-renderer, ytd-search grid-shelf-view-model"
          )
          .forEach((section) => {
            const title = focusSectionTitle(section);
            if (title && FOCUS_SEARCH_RECOMMENDED_RE.test(title)) {
              markFocusHidden(section);
            }
          });
      }
    } catch {
      /* YouTube's DOM changes frequently; a failed scan is non-fatal. */
    }
  }

  function updateFocusHomeButton() {
    if (!focusHomeButton) return;

    const revealed = document.documentElement.classList.contains(
      "by-focus-reveal-home"
    );

    focusHomeButton.textContent = revealed
      ? "Hide home recommendations"
      : "Show home recommendations";
    focusHomeButton.setAttribute("aria-pressed", revealed ? "true" : "false");
  }

  function removeFocusHomeButton() {
    if (focusHomeButton) {
      focusHomeButton.remove();
      focusHomeButton = null;
    }

    const existing = document.getElementById("by-focus-home-btn");
    if (existing) existing.remove();
  }

  function ensureFocusHomeButton() {
    if (!settings.focus) {
      removeFocusHomeButton();
      return;
    }

    if (focusHomeButton && focusHomeButton.isConnected) {
      updateFocusHomeButton();
      return;
    }

    if (!document.body) return;

    const button = document.createElement("button");
    button.id = "by-focus-home-btn";
    button.type = "button";
    button.className = "by-focus-home-btn";
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      const root = document.documentElement;
      if (!root || !settings.focus) return;

      root.classList.toggle("by-focus-reveal-home");
      updateFocusHomeButton();
      window.scrollTo(0, 0);
    });

    document.body.appendChild(button);
    focusHomeButton = button;
    updateFocusHomeButton();
  }

  function syncFocusHomeButton() {
    if (!settings.focus) {
      removeFocusHomeButton();
      return;
    }

    ensureFocusHomeButton();
  }

  /* ----------------------------------------------------------------------- *
   * HDR badge
   * ----------------------------------------------------------------------- */

  function handleHdrMessage(data) {
    if (!data.available) {
      lastHdr = null;
      removeHdrBadge();
      return;
    }

    lastHdr = data;
    badgeRetryCount = 0;

    if (!settings.hdr || !settings.hdrBadge) {
      removeHdrBadge();
      return;
    }

    ensureHdrBadge();
  }

  function ensureHdrBadge() {
    if (!lastHdr || !lastHdr.available || !settings.hdr || !settings.hdrBadge) {
      removeHdrBadge();
      return;
    }

    const player = document.querySelector("#movie_player");

    if (!player) {
      if (!badgeRetryTimer && badgeRetryCount < 10) {
        badgeRetryCount += 1;
        badgeRetryTimer = setTimeout(() => {
          badgeRetryTimer = null;
          ensureHdrBadge();
        }, 1000);
      }
      return;
    }

    badgeRetryCount = 0;

    let badge = document.getElementById("by-hdr-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "by-hdr-badge";
      badge.className = "by-hdr-badge";
      badge.setAttribute("role", "status");
    }

    const host =
      player.querySelector(".ytp-chrome-top-buttons") || player;

    if (badge.parentElement !== host) host.appendChild(badge);

    const height = Number(lastHdr.height) || 0;
    badge.textContent = height ? `HDR ${height}p` : "HDR";
    badge.title = `Better YouTube: HDR source active${
      lastHdr.transfer ? ` (${lastHdr.transfer})` : ""
    }`;
  }

  function removeHdrBadge() {
    if (badgeRetryTimer) {
      clearTimeout(badgeRetryTimer);
      badgeRetryTimer = null;
    }

    const badge = document.getElementById("by-hdr-badge");
    if (badge) badge.remove();
  }

  /* ----------------------------------------------------------------------- *
   * Feature state + settings sync
   * ----------------------------------------------------------------------- */

  function applyFeatureState() {
    consumeShortRedirectMarker();
    applyClasses();

    if (settings.adblock) {
      startObserver();
      startAdSkipper();
      startPlaybackRecovery();
      removeEnforcement();
    } else {
      stopAdSkipper();
      resetPlaybackRecovery();
    }

    if (settings.shorts) {
      startObserver();
      hideShortsTabs();
      maybeRedirectShorts();
    } else {
      restoreShortsTabs();
    }

    if (settings.hdr && settings.hdrBadge && lastHdr && lastHdr.available) {
      ensureHdrBadge();
    } else {
      removeHdrBadge();
    }

    if (settings.focus) {
      startObserver();
      hideFocusSections();
      syncFocusHomeButton();
    } else {
      restoreFocusHidden();
      focusLocationKey = "";
      removeFocusHomeButton();
    }

    if (settings.adblock || settings.shorts || settings.focus) scheduleSweep();
    else stopObserver();
  }

  function loadFromChrome() {
    try {
      const request = chrome.storage.sync.get(STORAGE_KEY);
      if (!request || typeof request.then !== "function") return;

      request
        .then((stored) => {
          const next =
            stored && stored[STORAGE_KEY]
              ? normalizeSettings(stored[STORAGE_KEY])
              : settings;

          applySettings(next, { writeMirror: true, notifyMain: true });

          if (!stored || !stored[STORAGE_KEY]) {
            try {
              const write = chrome.storage.sync.set({
                [STORAGE_KEY]: next,
              });
              if (write && typeof write.catch === "function") {
                write.catch(() => {});
              }
            } catch {
              /* Non-fatal. */
            }
          }
        })
        .catch(() => {});
    } catch {
      /* The extension context is unavailable. */
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== "better-yt-main") return;

    if (
      data.type === "stats" &&
      (data.kind === "ads" || data.kind === "shorts")
    ) {
      report(data.kind, data.count);
      return;
    }

    if (data.type === "hdr") handleHdrMessage(data);
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== MIRROR_KEY || !event.newValue) return;

    try {
      applySettings(JSON.parse(event.newValue), { writeMirror: false });
    } catch {
      /* Non-fatal. */
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      applySettings(changes[STORAGE_KEY].newValue);
    });
  } catch {
    /* The extension context is unavailable. */
  }

  window.addEventListener("yt-navigate-start", () => {
    shortRedirectCounted = false;
    lastHdr = null;
    resetPlaybackRecovery();
    removeHdrBadge();
    document.documentElement.classList.remove("by-focus-reveal-home");
  });

  window.addEventListener("yt-navigate-finish", () => {
    if (!location.pathname.startsWith("/shorts/")) {
      lastShortRedirectId = "";
    }
    applyFeatureState();
    scheduleSweep();
    maybeRedirectShorts();
  });

  document.addEventListener(
    "playing",
    (event) => {
      const video = event.target;
      if (!video || video.tagName !== "VIDEO") return;

      const player =
        video.closest("#movie_player") ||
        document.querySelector("#movie_player");

      if (isAdShowing(player) || hasAdUi(player)) return;

      contentPlaybackSeen = true;
      clearPlaybackRecovery();
    },
    true
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPlaybackRecovery();
    } else {
      clearPlaybackRecovery();
    }
  });

  window.addEventListener("popstate", () => {
    document.documentElement.classList.remove("by-focus-reveal-home");
    applyClasses();
    syncFocusHomeButton();
    scheduleSweep();
    maybeRedirectShorts();
  });

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      consumeShortRedirectMarker();
      applyClasses();
      syncFocusHomeButton();
      if (settings.adblock || settings.shorts || settings.focus) scheduleSweep();
    },
    { once: true }
  );

  // Apply the local mirror immediately so the first paint is already filtered.
  applyFeatureState();
  maybeRedirectShorts();
  loadFromChrome();
})();
