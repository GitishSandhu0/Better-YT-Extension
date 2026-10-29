/*
 * Better YouTube — main world.
 *
 * Runs at document_start inside the page's own JavaScript context, before
 * YouTube's player code. It:
 *   1. advertises HDR display capabilities
 *   2. scrubs ad break data out of player responses
 *   3. scrubs ad/promo renderers out of feed and menu responses
 *   4. pins the best HDR quality when a video has an HDR variant
 *
 * No network requests are made here and no data leaves the browser.
 */
(() => {
  "use strict";

  const sanitize = self.BYSanitize;
  if (!sanitize) return;

  const { stripPlayerAds, stripBrowseAds, getHDRInfo, apiKind } = sanitize;

  /*
   * This script runs in the page's main world. Chrome only injects a given
   * content-script file once per frame, so it cannot share lib/config.js with
   * the isolated content script. Keep the few settings this world needs local.
   */
  const MIRROR_KEY = "by.settings.v1";
  const SETTING_KEYS = ["adblock", "hdr", "hdrQuality"];

  function normalizeSettings(value) {
    const out = {};
    for (const key of SETTING_KEYS) {
      out[key] =
        value && typeof value[key] === "boolean" ? value[key] : true;
    }
    return out;
  }

  let settings = readMirror();
  let lastHdrKey = "";
  let lastHdrReportAt = 0;
  let pinKey = "";
  let scanTimer = null;

  function readMirror() {
    try {
      const raw = window.localStorage.getItem(MIRROR_KEY);
      return normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return normalizeSettings(null);
    }
  }

  function post(message) {
    try {
      window.postMessage({ source: "better-yt-main", ...message }, "*");
    } catch {
      /* The page is going away or the message is not cloneable. */
    }
  }

  function report(kind, count = 1) {
    post({ type: "stats", kind, count });
  }

  /* ----------------------------------------------------------------------- *
   * HDR capability spoofing
   * ----------------------------------------------------------------------- */

  const nativeMatchMedia =
    typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null;
  const nativeColorDepth = window.screen && window.screen.colorDepth;
  const nativePixelDepth = window.screen && window.screen.pixelDepth;

  const HDR_QUERY_RE =
    /(?:video-)?dynamic-range\s*:\s*high|color-gamut\s*:\s*(?:p3|rec2020)/i;

  function fakeMediaQueryList(query) {
    return {
      matches: true,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    };
  }

  if (nativeMatchMedia) {
    try {
      window.matchMedia = function betterYTMatchMedia(query) {
        if (settings.hdr && HDR_QUERY_RE.test(String(query))) {
          let list = null;

          try {
            list = nativeMatchMedia(query);
          } catch {
            list = null;
          }

          if (list) {
            try {
              Object.defineProperty(list, "matches", {
                configurable: true,
                enumerable: true,
                get: () => true,
              });
              return list;
            } catch {
              /* Not extensible in this browser; fall through to a fake. */
            }
          }

          return fakeMediaQueryList(String(query));
        }

        return nativeMatchMedia(query);
      };
    } catch {
      /* Non-fatal. */
    }
  }

  function spoofScreenDepth(property, nativeValue) {
    if (typeof nativeValue !== "number") return;

    const getter = () => (settings.hdr ? 30 : nativeValue);

    try {
      Object.defineProperty(window.screen, property, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
      return;
    } catch {
      /* Try the prototype below. */
    }

    try {
      const proto = Object.getPrototypeOf(window.screen);
      Object.defineProperty(proto, property, {
        configurable: true,
        get: getter,
      });
    } catch {
      /* Non-fatal. */
    }
  }

  if (window.screen) {
    spoofScreenDepth("colorDepth", nativeColorDepth);
    spoofScreenDepth("pixelDepth", nativePixelDepth);
  }

  /* ----------------------------------------------------------------------- *
   * Response sanitizing
   * ----------------------------------------------------------------------- */

  function handlePlayerResponse(data) {
    if (!data || typeof data !== "object") return;

    try {
      const result = stripPlayerAds(data);
      if (result.changed) report("ads", 1);

      const player = data.streamingData ? data : data.playerResponse;

      /*
       * Partial player objects are common during navigation. Treat only a
       * response with actual adaptive formats as authoritative; otherwise an
       * empty response could remove a valid HDR badge.
       */
      const formats = player?.streamingData?.adaptiveFormats;
      if (!Array.isArray(formats) || formats.length === 0) return;

      const info = getHDRInfo(player);
      reportHDR(player, info);
      maybePinHDR(player, info);
    } catch {
      /* Never break playback because of a shape change in YouTube's data. */
    }
  }

  function handleBrowseData(data) {
    if (!data || typeof data !== "object") return;

    try {
      const result = stripBrowseAds(data);
      if (result.removed > 0) {
        report("ads", Math.min(result.removed, 5));
      }
    } catch {
      /* Non-fatal. */
    }
  }

  function reportHDR(player, info) {
    const videoId =
      (player && player.videoDetails && player.videoDetails.videoId) || "";
    const key = `${videoId}:${
      info ? `${info.quality}:${info.height}` : "sdr"
    }`;
    const now = Date.now();

    if (key === lastHdrKey && now - lastHdrReportAt < 2000) return;

    lastHdrKey = key;
    lastHdrReportAt = now;

    if (!settings.hdr) {
      post({ type: "hdr", available: false, videoId });
      return;
    }

    if (!info) {
      post({ type: "hdr", available: false, videoId });
      return;
    }

    post({
      type: "hdr",
      available: true,
      videoId,
      height: info.height,
      fps: info.fps,
      quality: info.quality,
      transfer: info.transfer,
    });
  }

  function maybePinHDR(player, info) {
    if (!settings.hdr || !settings.hdrQuality || !info) return;
    if (info.height < 240) return;

    // Never force a 4K stream into a tiny embedded player.
    try {
      if (window.top !== window) return;
    } catch {
      return;
    }

    const videoId =
      (player && player.videoDetails && player.videoDetails.videoId) || "";
    const key = `${videoId}:${info.quality}`;
    if (key === pinKey) return;
    pinKey = key;

    let attempts = 0;

    const apply = () => {
      if (!settings.hdr || !settings.hdrQuality) return;

      const playerElement = document.querySelector("#movie_player");
      if (
        !playerElement ||
        typeof playerElement.setPlaybackQualityRange !== "function"
      ) {
        if (attempts < 10) {
          attempts += 1;
          setTimeout(apply, 600);
        }
        return;
      }

      try {
        playerElement.setPlaybackQualityRange(info.quality);
      } catch {
        /* The player may not be ready yet. */
      }

      try {
        playerElement.setPlaybackQuality(info.quality);
      } catch {
        /* Deprecated API, still present on most player versions. */
      }
    };

    setTimeout(apply, 400);
    setTimeout(apply, 1800);
    setTimeout(apply, 4000);
  }

  function rebuildResponse(original, data) {
    let body;
    try {
      body = JSON.stringify(data);
    } catch {
      return original;
    }
    if (typeof body !== "string") return original;

    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    try {
      const response = new Response(body, {
        status: original.status,
        statusText: original.statusText,
        headers,
      });

      try {
        Object.defineProperty(response, "url", {
          configurable: true,
          value: original.url,
        });
      } catch {
        /* Optional. */
      }

      return response;
    } catch {
      return original;
    }
  }

  /* ----------------------------------------------------------------------- *
   * fetch hook
   * ----------------------------------------------------------------------- */

  const nativeFetch = window.fetch;

  if (typeof nativeFetch === "function") {
    try {
      window.fetch = function betterYTFetch(input) {
        const url =
          typeof input === "string"
            ? input
            : input && typeof input.url === "string"
              ? input.url
              : String(input);

        const kind = settings.adblock ? apiKind(url) : null;
        if (!kind) {
          return nativeFetch.apply(window, arguments);
        }

        return nativeFetch.apply(window, arguments).then((response) => {
          if (
            !response ||
            !response.ok ||
            response.status === 204 ||
            response.status === 205
          ) {
            return response;
          }

          let clone;
          try {
            clone = response.clone();
          } catch {
            return response;
          }

          return clone
            .json()
            .then((data) => {
              if (kind === "player") handlePlayerResponse(data);
              else handleBrowseData(data);
              return rebuildResponse(response, data);
            })
            .catch(() => response);
        });
      };
    } catch {
      /* Non-fatal. */
    }
  }

  /* ----------------------------------------------------------------------- *
   * XHR hook (best effort; modern YouTube mostly uses fetch)
   * ----------------------------------------------------------------------- */

  const XHR = window.XMLHttpRequest;

  if (XHR && XHR.prototype) {
    try {
      const nativeOpen = XHR.prototype.open;
      XHR.prototype.open = function betterYTOpen(method, url) {
        try {
          this.__betterYTUrl =
            typeof url === "string" ? url : String(url);
        } catch {
          /* Non-fatal. */
        }
        return nativeOpen.apply(this, arguments);
      };
    } catch {
      /* Non-fatal. */
    }

    const xhrKind = (xhr) =>
      settings.adblock ? apiKind(xhr && xhr.__betterYTUrl) : null;

    const sanitizeXhrText = (xhr, text, kind) => {
      if (!text || xhr.readyState !== 4) return text;

      try {
        if (
          xhr.__betterYTRawText === text &&
          typeof xhr.__betterYTSanitizedText === "string"
        ) {
          return xhr.__betterYTSanitizedText;
        }

        const data = JSON.parse(text);
        if (kind === "player") handlePlayerResponse(data);
        else handleBrowseData(data);

        const output = JSON.stringify(data);
        xhr.__betterYTRawText = text;
        xhr.__betterYTSanitizedText = output;
        return output;
      } catch {
        return text;
      }
    };

    const responseDescriptor = Object.getOwnPropertyDescriptor(
      XHR.prototype,
      "response"
    );

    if (responseDescriptor && typeof responseDescriptor.get === "function") {
      try {
        Object.defineProperty(XHR.prototype, "response", {
          configurable: true,
          enumerable: responseDescriptor.enumerable,
          get: function betterYTResponse() {
            const value = responseDescriptor.get.call(this);
            const kind = xhrKind(this);

            if (!kind || value == null) return value;

            if (typeof value === "string") {
              return sanitizeXhrText(this, value, kind);
            }

            if (typeof value === "object" && this.readyState === 4) {
              try {
                if (kind === "player") handlePlayerResponse(value);
                else handleBrowseData(value);
              } catch {
                /* Non-fatal. */
              }
            }

            return value;
          },
        });
      } catch {
        /* Non-fatal. */
      }
    }

    const textDescriptor = Object.getOwnPropertyDescriptor(
      XHR.prototype,
      "responseText"
    );

    if (textDescriptor && typeof textDescriptor.get === "function") {
      try {
        Object.defineProperty(XHR.prototype, "responseText", {
          configurable: true,
          enumerable: textDescriptor.enumerable,
          get: function betterYTResponseText() {
            const text = textDescriptor.get.call(this);
            const kind = xhrKind(this);
            if (!kind) return text;
            return sanitizeXhrText(this, text, kind);
          },
        });
      } catch {
        /* Non-fatal. */
      }
    }
  }

  /* ----------------------------------------------------------------------- *
   * Inline globals (ytInitialPlayerResponse, ytInitialData, ...)
   * ----------------------------------------------------------------------- */

  function installGlobalHook(name, sanitizer) {
    let stored;

    try {
      stored = window[name];
    } catch {
      stored = undefined;
    }

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          return stored;
        },
        set(value) {
          try {
            sanitizer(value);
          } catch {
            /* Non-fatal. */
          }
          stored = value;
        },
      });
    } catch {
      /* Fall back to scanGlobals(). */
    }

    if (stored) {
      try {
        sanitizer(stored);
      } catch {
        /* Non-fatal. */
      }
    }
  }

  installGlobalHook("ytInitialPlayerResponse", handlePlayerResponse);
  installGlobalHook("ytInitialData", handleBrowseData);
  installGlobalHook("ytInitialGuideData", handleBrowseData);
  installGlobalHook("ytInitialReelWatchSequenceResponse", handleBrowseData);

  function scanGlobals() {
    try {
      if (window.ytInitialPlayerResponse) {
        handlePlayerResponse(window.ytInitialPlayerResponse);
      }
    } catch {
      /* Non-fatal. */
    }

    try {
      if (window.ytInitialData) handleBrowseData(window.ytInitialData);
    } catch {
      /* Non-fatal. */
    }

    try {
      if (window.ytInitialGuideData) {
        handleBrowseData(window.ytInitialGuideData);
      }
    } catch {
      /* Non-fatal. */
    }

    try {
      const ytplayer = window.ytplayer;
      const args = ytplayer && ytplayer.config && ytplayer.config.args;

      if (args && args.raw_player_response) {
        handlePlayerResponse(args.raw_player_response);
      }

      if (args && typeof args.player_response === "string") {
        const parsed = JSON.parse(args.player_response);
        const result = stripPlayerAds(parsed);
        if (result.changed) {
          args.player_response = JSON.stringify(parsed);
          report("ads", 1);
        }
      }
    } catch {
      /* Non-fatal. */
    }
  }

  function scanCurrentPlayer() {
    const player = document.querySelector("#movie_player");

    if (player && typeof player.getPlayerResponse === "function") {
      try {
        const response = player.getPlayerResponse();
        if (response) handlePlayerResponse(response);
      } catch {
        /* Non-fatal. */
      }
    }

    scanGlobals();
  }

  function scheduleScan(delay = 700) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanCurrentPlayer();
    }, delay);
  }

  function refreshFromMirror() {
    const previous = settings;
    settings = readMirror();

    if (!settings.hdr) {
      post({ type: "hdr", available: false });
    } else if (!previous.hdr) {
      lastHdrKey = "";
      scheduleScan(300);
    }

    if (settings.hdrQuality && !previous.hdrQuality) pinKey = "";
  }

  /* ----------------------------------------------------------------------- *
   * Settings + navigation wiring
   * ----------------------------------------------------------------------- */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== "better-yt-content") return;

    if (data.type === "settings") {
      const previous = settings;
      settings = normalizeSettings(data.settings);

      if (!settings.hdr) {
        post({ type: "hdr", available: false });
      } else if (!previous.hdr) {
        lastHdrKey = "";
        scheduleScan(300);
      }

      if (settings.hdrQuality && !previous.hdrQuality) pinKey = "";

      if (settings.adblock && !previous.adblock) scheduleScan(300);
      return;
    }

    if (data.type === "scan") scheduleScan(300);
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== MIRROR_KEY) return;
    refreshFromMirror();
  });

  window.addEventListener("yt-navigate-start", () => {
    lastHdrKey = "";
    pinKey = "";
    post({ type: "hdr", available: false });
  });

  window.addEventListener("yt-navigate-finish", () => {
    refreshFromMirror();
    scheduleScan(900);
  });

  window.addEventListener("popstate", () => {
    refreshFromMirror();
    scheduleScan(900);
  });

  document.addEventListener(
    "DOMContentLoaded",
    () => scheduleScan(500),
    { once: true }
  );

  window.addEventListener("load", () => scheduleScan(300), { once: true });

  // Catch ytplayer config which is created after the initial globals.
  setTimeout(() => scheduleScan(800), 800);
})();
