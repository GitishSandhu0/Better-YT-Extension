"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/config.js");
const sanitize = require("../lib/sanitize.js");

test("normalizeSettings returns defaults and ignores invalid values", () => {
  assert.deepEqual(config.normalizeSettings(null), { ...config.DEFAULTS });
  assert.equal(config.DEFAULTS.amoled, false);
  assert.equal(config.DEFAULTS.focus, false);

  const normalized = config.normalizeSettings({
    adblock: false,
    shorts: "yes",
    hdr: 1,
    redirectShorts: false,
    amoled: true,
    focus: true,
    unknown: true,
  });

  assert.equal(normalized.adblock, false);
  assert.equal(normalized.shorts, true);
  assert.equal(normalized.hdr, true);
  assert.equal(normalized.redirectShorts, false);
  assert.equal(normalized.amoled, true);
  assert.equal(normalized.focus, true);
  assert.equal("unknown" in normalized, false);
});

test("normalizeStats resets daily counters on a new day but keeps totals", () => {
  const stats = config.normalizeStats({
    day: "2000-01-01",
    adsToday: 12,
    shortsToday: 4,
    adsTotal: 99,
    shortsTotal: 20,
  });

  assert.equal(stats.adsToday, 0);
  assert.equal(stats.shortsToday, 0);
  assert.equal(stats.adsTotal, 99);
  assert.equal(stats.shortsTotal, 20);
  assert.equal(stats.day, config.todayKey());
});

test("isYouTubeUrl only accepts https YouTube hosts", () => {
  assert.equal(config.isYouTubeUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(config.isYouTubeUrl("https://youtube.com/shorts/abc"), true);
  assert.equal(config.isYouTubeUrl("http://www.youtube.com/watch?v=abc"), false);
  assert.equal(config.isYouTubeUrl("https://notyoutube.com/watch?v=abc"), false);
  assert.equal(config.isYouTubeUrl(undefined), false);
});

test("stripPlayerAds removes ad break fields and preserves playback data", () => {
  const response = {
    adPlacements: [{ adPlacementRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    playerAds: [{ playerAdRenderer: {} }],
    adBreakHeartbeatParams: "heartbeat",
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "Keep me" },
    streamingData: { adaptiveFormats: [{ itag: 137 }] },
  };

  const result = sanitize.stripPlayerAds(response);

  assert.equal(result.changed, true);
  assert.equal("adPlacements" in response, false);
  assert.equal("adSlots" in response, false);
  assert.equal("playerAds" in response, false);
  assert.equal("adBreakHeartbeatParams" in response, false);
  assert.deepEqual(response.videoDetails, {
    videoId: "dQw4w9WgXcQ",
    title: "Keep me",
  });
  assert.deepEqual(response.streamingData, {
    adaptiveFormats: [{ itag: 137 }],
  });

  const secondPass = sanitize.stripPlayerAds(response);
  assert.equal(secondPass.changed, false);
});

test("stripPlayerAds also handles a nested playerResponse wrapper", () => {
  const wrapper = {
    playerResponse: {
      adPlacements: [{}],
      playerAds: [{}],
      videoDetails: { videoId: "nested" },
    },
  };

  const result = sanitize.stripPlayerAds(wrapper);

  assert.equal(result.changed, true);
  assert.equal("adPlacements" in wrapper.playerResponse, false);
  assert.equal("playerAds" in wrapper.playerResponse, false);
  assert.equal(wrapper.playerResponse.videoDetails.videoId, "nested");
});

test("stripBrowseAds removes ad renderers from objects and arrays", () => {
  const data = {
    contents: [
      { videoRenderer: { videoId: "keep" } },
      { adSlotRenderer: { ad: true } },
      { inFeedAdLayoutRenderer: { ad: true } },
      {
        nested: {
          promotedVideoRenderer: { ad: true },
          videoRenderer: { videoId: "also-keep" },
        },
      },
    ],
    sidebar: {
      guidePromoRenderer: { ad: true },
      guideEntryRenderer: { title: "Home" },
    },
  };

  const result = sanitize.stripBrowseAds(data);

  assert.equal(result.changed, true);
  assert.equal(result.removed, 4);
  assert.equal(data.contents.length, 2);
  assert.equal("adSlotRenderer" in data.contents[1], false);
  assert.equal("inFeedAdLayoutRenderer" in data.contents[1], false);
  assert.equal("promotedVideoRenderer" in data.contents[1].nested, false);
  assert.equal("guidePromoRenderer" in data.sidebar, false);
  assert.equal(data.sidebar.guideEntryRenderer.title, "Home");
  assert.equal(data.contents[0].videoRenderer.videoId, "keep");
});

test("stripBrowseAds leaves clean data untouched", () => {
  const data = {
    contents: [
      { videoRenderer: { videoId: "one" } },
      { videoRenderer: { videoId: "two" } },
    ],
  };

  const result = sanitize.stripBrowseAds(data);

  assert.equal(result.changed, false);
  assert.equal(result.removed, 0);
  assert.equal(data.contents.length, 2);
});

test("getHDRInfo finds the highest-quality HDR format", () => {
  const response = {
    streamingData: {
      adaptiveFormats: [
        {
          height: 1080,
          fps: 30,
          bitrate: 2000,
          colorInfo: {
            transferCharacteristics: "COLOR_TRANSFER_CHARACTERISTICS_BT709",
          },
        },
        {
          height: 2160,
          fps: 60,
          bitrate: 9000,
          qualityLabel: "2160p60",
          mimeType: "video/webm; codecs=vp9.2",
          colorInfo: {
            transferCharacteristics:
              "COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084",
          },
        },
        {
          height: 1440,
          fps: 60,
          bitrate: 5000,
          colorInfo: {
            transferCharacteristics:
              "COLOR_TRANSFER_CHARACTERISTICS_ARIB_STD_B67",
          },
        },
      ],
    },
  };

  const info = sanitize.getHDRInfo(response);

  assert.ok(info);
  assert.equal(info.height, 2160);
  assert.equal(info.quality, "hd2160");
  assert.equal(info.fps, 60);
  assert.equal(info.transfer, "COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084");
});

test("getHDRInfo returns null for SDR-only videos", () => {
  const response = {
    streamingData: {
      adaptiveFormats: [
        {
          height: 1080,
          colorInfo: {
            transferCharacteristics: "COLOR_TRANSFER_CHARACTERISTICS_BT709",
            primaries: "COLOR_PRIMARIES_BT709",
          },
        },
      ],
    },
  };

  assert.equal(sanitize.getHDRInfo(response), null);
  assert.equal(sanitize.getHDRInfo(null), null);
  assert.equal(sanitize.getHDRInfo({}), null);
});

test("BT.2020 primaries alone count as HDR", () => {
  assert.equal(
    sanitize.isHDRFormat({
      colorInfo: { primaries: "COLOR_PRIMARIES_BT2020" },
    }),
    true
  );
});

test("qualityForHeight maps YouTube quality names", () => {
  assert.equal(sanitize.qualityForHeight(4320), "highres");
  assert.equal(sanitize.qualityForHeight(2160), "hd2160");
  assert.equal(sanitize.qualityForHeight(1440), "hd1440");
  assert.equal(sanitize.qualityForHeight(1080), "hd1080");
  assert.equal(sanitize.qualityForHeight(720), "hd720");
  assert.equal(sanitize.qualityForHeight(480), "large");
  assert.equal(sanitize.qualityForHeight(360), "medium");
  assert.equal(sanitize.qualityForHeight(240), "small");
  assert.equal(sanitize.qualityForHeight(144), "tiny");
});

test("heightFromQualityLabel reads common labels", () => {
  assert.equal(sanitize.heightFromQualityLabel("2160p60"), 2160);
  assert.equal(sanitize.heightFromQualityLabel("1080p"), 1080);
  assert.equal(sanitize.heightFromQualityLabel(""), 0);
});

test("apiKind classifies YouTube API endpoints", () => {
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/player?prettyPrint=false"),
    "player"
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/next?prettyPrint=false"),
    "browse"
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/browse"),
    "browse"
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/search?prettyPrint=false"),
    "browse"
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/guide"),
    "browse"
  );
  assert.equal(
    sanitize.apiKind(
      "https://www.youtube.com/youtubei/v1/reel/reel_watch_sequence?prettyPrint=false"
    ),
    "browse"
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    null
  );
  assert.equal(
    sanitize.apiKind("https://www.youtube.com/youtubei/v1/log_event"),
    null
  );
  assert.equal(sanitize.apiKind(""), null);
  assert.equal(sanitize.apiKind(null), null);
});
