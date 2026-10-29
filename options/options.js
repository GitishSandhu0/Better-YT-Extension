/* Better YouTube — options controller. */

(() => {
  "use strict";

  const config = self.BY_CONFIG;
  if (!config) return;

  const {
    DEFAULTS,
    STORAGE_KEY,
    STATS_KEY,
    normalizeSettings,
    normalizeStats,
    emptyStats,
  } = config;

  const controls = Array.from(
    document.querySelectorAll("input[data-setting]")
  );
  const reloadNotice = document.getElementById("reloadNotice");
  const noticeText = document.getElementById("noticeText");
  const saveStatus = document.getElementById("saveStatus");
  const numberFormatter = new Intl.NumberFormat();

  const reloadKeys = new Set([
    "adblock",
    "shorts",
    "hdr",
    "redirectShorts",
  ]);
  // `amoled` and `focus` are intentionally absent: the content script applies
  // them instantly.

  let settings = { ...DEFAULTS };
  let saveQueue = Promise.resolve();
  let saveStatusTimer = null;

  function renderSettings() {
    for (const control of controls) {
      control.checked = !!settings[control.dataset.setting];
    }
  }

  function renderStats(stats) {
    document.getElementById("statAdsToday").textContent =
      numberFormatter.format(stats.adsToday);
    document.getElementById("statShortsToday").textContent =
      numberFormatter.format(stats.shortsToday);
    document.getElementById("statAdsTotal").textContent =
      numberFormatter.format(stats.adsTotal);
    document.getElementById("statShortsTotal").textContent =
      numberFormatter.format(stats.shortsTotal);
  }

  function showSaved(text = "Saved") {
    saveStatus.textContent = text;
    saveStatus.classList.add("visible");

    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => {
      saveStatus.classList.remove("visible");
    }, 1800);
  }

  function showNotice(message) {
    noticeText.textContent =
      message || "Reload your YouTube tabs to apply everything.";
    reloadNotice.hidden = false;
  }

  function hideNotice() {
    reloadNotice.hidden = true;
  }

  function saveSetting(key, value) {
    settings = { ...settings, [key]: value };

    saveQueue = saveQueue
      .then(() =>
        chrome.storage.sync.set({ [STORAGE_KEY]: settings })
      )
      .then(() => {
        showSaved();
        if (reloadKeys.has(key)) showNotice();
      })
      .catch(() => {
        showNotice("Could not save settings. Try reloading the options page.");
      });
  }

  async function reloadYouTubeTabs() {
    try {
      const tabs = await chrome.tabs.query({
        url: ["*://youtube.com/*", "*://*.youtube.com/*"],
      });

      if (!tabs || tabs.length === 0) {
        showNotice("No YouTube tabs are open.");
        return;
      }

      await Promise.all(
        tabs.map((tab) => {
          if (tab.id == null) return Promise.resolve();
          return chrome.tabs.reload(tab.id);
        })
      );

      hideNotice();
      showSaved("Reloaded");
    } catch {
      showNotice("Could not reload tabs. Reload YouTube manually.");
    }
  }

  async function init() {
    try {
      document.getElementById("version").textContent = `v${
        chrome.runtime.getManifest().version
      }`;

      const [stored, statsStored] = await Promise.all([
        chrome.storage.sync.get(STORAGE_KEY),
        chrome.storage.local.get(STATS_KEY),
      ]);

      settings = normalizeSettings(stored[STORAGE_KEY]);
      renderSettings();
      renderStats(normalizeStats(statsStored[STATS_KEY]));

      if (!stored[STORAGE_KEY]) {
        try {
          await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
        } catch {
          /* Non-fatal. */
        }
      }
    } catch {
      showNotice("Could not load settings. Try reloading the options page.");
    }
  }

  for (const control of controls) {
    control.addEventListener("change", () => {
      saveSetting(control.dataset.setting, control.checked);
    });
  }

  document
    .getElementById("reloadYouTubeBtn")
    .addEventListener("click", reloadYouTubeTabs);

  document
    .getElementById("dismissNoticeBtn")
    .addEventListener("click", hideNotice);

  document.getElementById("resetStats").addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Reset all Better YouTube counters? Your settings will be kept."
    );
    if (!confirmed) return;

    const stats = emptyStats();

    try {
      await chrome.storage.local.set({ [STATS_KEY]: stats });
      renderStats(stats);
      showSaved("Stats reset");
    } catch {
      showNotice("Could not reset stats.");
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE_KEY]) {
      settings = normalizeSettings(changes[STORAGE_KEY].newValue);
      renderSettings();
    }

    if (area === "local" && changes[STATS_KEY]) {
      renderStats(normalizeStats(changes[STATS_KEY].newValue));
    }
  });

  init();
})();
