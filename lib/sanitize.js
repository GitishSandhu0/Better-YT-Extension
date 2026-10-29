/*
 * Better YouTube — pure data sanitizers.
 *
 * Everything in this file is deliberately DOM-free. It runs in the page's main
 * world (to scrub player/browse responses before YouTube reads them) and in
 * Node for unit tests.
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

  if (root) root.BYSanitize = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  /** Player-response fields that describe ad breaks. */
  const AD_KEYS = Object.freeze([
    "adPlacements",
    "adSlots",
    "playerAds",
    "adBreakHeartbeatParams",
  ]);

  /** Renderers that are ads/promotions in ytInitialData and browse responses. */
  const AD_RENDERER_KEYS = new Set([
    "adSlotRenderer",
    "adSlotAndLayoutMetadata",
    "adThumbnailRenderer",
    "inFeedAdLayoutRenderer",
    "bannerPromoRenderer",
    "statementBannerRenderer",
    "displayAdRenderer",
    "promotedSparklesWebRenderer",
    "promotedVideoRenderer",
    "compactPromotedVideoRenderer",
    "searchPywRenderer",
    "videoMastheadAdV3Renderer",
    "primetimePromoRenderer",
    "backgroundPromoRenderer",
    "guidePromoRenderer",
    "merchShelfRenderer",
    "brandVideoShelfRenderer",
    "brandVideoSingletonRenderer",
  ]);

  /** Hard limits so a pathological response can never freeze the page. */
  const MAX_NODES = 200000;
  const MAX_MS = 40;

  function isHDRFormat(format) {
    if (!format || typeof format !== "object") return false;

    const colorInfo = format.colorInfo;
    if (!colorInfo || typeof colorInfo !== "object") return false;

    const transfer = String(colorInfo.transferCharacteristics || "").toUpperCase();
    const primaries = String(colorInfo.primaries || "").toUpperCase();

    return (
      transfer.includes("SMPTEST2084") ||
      transfer.includes("ARIB_STD_B67") ||
      transfer.includes("SMPTE2086") ||
      transfer.includes("PQ") ||
      transfer.includes("HLG") ||
      primaries.includes("BT2020")
    );
  }

  function heightFromQualityLabel(label) {
    const match = String(label || "").match(/(\d{3,4})p/i);
    return match ? Number(match[1]) : 0;
  }

  function qualityForHeight(height) {
    if (height >= 4320) return "highres";
    if (height >= 2160) return "hd2160";
    if (height >= 1440) return "hd1440";
    if (height >= 1080) return "hd1080";
    if (height >= 720) return "hd720";
    if (height >= 480) return "large";
    if (height >= 360) return "medium";
    if (height >= 240) return "small";
    return "tiny";
  }

  /**
   * Finds the best HDR video format in a player response.
   * Returns null for SDR-only videos.
   */
  function getHDRInfo(playerResponse) {
    const formats =
      playerResponse &&
      playerResponse.streamingData &&
      playerResponse.streamingData.adaptiveFormats;

    if (!Array.isArray(formats)) return null;

    let best = null;

    for (const format of formats) {
      if (!isHDRFormat(format)) continue;

      const height =
        Number(format.height) || heightFromQualityLabel(format.qualityLabel);
      if (!height) continue;

      const fps = Number(format.fps) || 0;
      const bitrate = Number(format.bitrate) || 0;

      if (
        !best ||
        height > best.height ||
        (height === best.height && fps > best.fps) ||
        (height === best.height && fps === best.fps && bitrate > best.bitrate)
      ) {
        best = {
          height,
          fps,
          bitrate,
          quality: qualityForHeight(height),
          mimeType: String(format.mimeType || ""),
          transfer: String(
            (format.colorInfo && format.colorInfo.transferCharacteristics) || ""
          ),
        };
      }
    }

    return best;
  }

  /**
   * Removes ad break data from a player response, in place.
   * Returns { changed, removed }.
   */
  function stripPlayerAds(playerResponse) {
    const result = { changed: false, removed: [] };

    if (!playerResponse || typeof playerResponse !== "object") return result;

    const targets = [playerResponse];

    // Some callers hand us a wrapper object such as { playerResponse: {...} }.
    if (
      playerResponse.playerResponse &&
      typeof playerResponse.playerResponse === "object"
    ) {
      targets.push(playerResponse.playerResponse);
    }

    for (const target of targets) {
      for (const key of AD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          delete target[key];
          result.changed = true;
          result.removed.push(key);
        }
      }
    }

    return result;
  }

  function isAdObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;

    for (const key of Object.keys(value)) {
      if (AD_RENDERER_KEYS.has(key)) return true;
    }
    return false;
  }

  /**
   * Recursively removes ad renderers from ytInitialData / browse responses,
   * in place. Arrays have matching entries spliced out so YouTube does not
   * render empty tiles.
   *
   * A node/time budget keeps this cheap even on huge recommendation payloads.
   */
  function stripBrowseAds(data) {
    const result = { changed: false, removed: 0, truncated: false };

    if (!data || typeof data !== "object") return result;

    const stack = [data];
    const seen = new WeakSet();
    const started = Date.now();
    let nodes = 0;

    while (stack.length) {
      if (nodes >= MAX_NODES) {
        result.truncated = true;
        break;
      }

      // Check the clock in batches to avoid a Date.now() call per node.
      if ((nodes & 1023) === 0 && Date.now() - started > MAX_MS) {
        result.truncated = true;
        break;
      }

      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      nodes += 1;

      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          const item = node[index];

          if (!item || typeof item !== "object") continue;

          if (isAdObject(item)) {
            node.splice(index, 1);
            result.changed = true;
            result.removed += 1;
            continue;
          }

          stack.push(item);
        }
        continue;
      }

      for (const key of Object.keys(node)) {
        if (AD_RENDERER_KEYS.has(key)) {
          delete node[key];
          result.changed = true;
          result.removed += 1;
          continue;
        }

        const value = node[key];
        if (value && typeof value === "object") stack.push(value);
      }
    }

    return result;
  }

  /**
   * Classifies a YouTube API URL.
   * Returns "player", "browse", or null.
   */
  function apiKind(url) {
    if (typeof url !== "string" || !url) return null;

    if (url.includes("/youtubei/v1/player")) return "player";

    if (
      /\/(?:browse|next|search|guide)(?:[?/]|$)/.test(url) ||
      url.includes("/youtubei/v1/reel/reel_watch_sequence")
    ) {
      return "browse";
    }

    return null;
  }

  return {
    isHDRFormat,
    getHDRInfo,
    qualityForHeight,
    heightFromQualityLabel,
    stripPlayerAds,
    stripBrowseAds,
    apiKind,
  };
});
