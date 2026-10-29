/* Better YouTube — popup controller. */

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
    isYouTubeUrl,
  } = config;

  const controls = Array.from(
    document.querySelectorAll("input[data-setting]")
  );
  const reloadBtn = document.getElementById("reloadBtn");
  const hint = document.getElementById("hint");
  const numberFormatter = new Intl.NumberFormat();

  let settings = { ...DEFAULTS };
  let activeTab = null;
  let hintTimer = null;
  let saveQueue = Promise.resolve();

  function renderSettings() {
    for (const control of controls) {
      const key = control.dataset.setting;
      control.checked = !!settings[key];
    }
  }

  function renderStats(stats) {
    document.getElementById("adsToday").textContent = numberFormatter.format(
      stats.adsToday
    );
    document.getElementById("shortsToday").textContent = numberFormatter.format(
      stats.shortsToday
    );
    document.getElementById("adsTotal").textContent = numberFormatter.format(
      stats.adsTotal
    );
  }

  function setHint(text) {
    hint.textContent = text;
    hint.classList.toggle("visible", !!text);

    if (hintTimer) clearTimeout(hintTimer);
    if (!text) return;

    hintTimer = setTimeout(() => {
      hint.textContent = "";
      hint.classList.remove("visible");
    }, 5000);
  }

  function updateReloadVisibility() {
    reloadBtn.hidden = !activeTab;
  }

  function isYouTubeTab(tab) {
    return !!tab && isYouTubeUrl(tab.url);
  }

  function saveSetting(key, value) {
    settings = { ...settings, [key]: value };

    saveQueue = saveQueue
      .then(() =>
        chrome.storage.sync.set({ [STORAGE_KEY]: settings })
      )
      .catch(() => {
        setHint("Could not save settings.");
      });

    let message = "Reload YouTube to apply this change.";
    if (key === "hdr") {
      message = "Reload YouTube to request HDR streams.";
    } else if (key === "amoled") {
      message = "AMOLED background applied instantly.";
    } else if (key === "focus") {
      message = "Focus mode applied instantly.";
    }
    setHint(message);

    updateReloadVisibility();
  }

  async function init() {
    try {
      const [stored, statsStored, tabs] = await Promise.all([
        chrome.storage.sync.get(STORAGE_KEY),
        chrome.storage.local.get(STATS_KEY),
        chrome.tabs
          .query({ active: true, currentWindow: true })
          .catch(() => []),
      ]);

      settings = normalizeSettings(stored[STORAGE_KEY]);
      renderSettings();
      renderStats(normalizeStats(statsStored[STATS_KEY]));

      activeTab = (tabs || []).find(isYouTubeTab) || null;
      updateReloadVisibility();
    } catch {
      setHint("Could not load settings.");
    }
  }

  for (const control of controls) {
    control.addEventListener("change", () => {
      saveSetting(control.dataset.setting, control.checked);
    });
  }

  document.getElementById("optionsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("optionsLink").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  reloadBtn.addEventListener("click", () => {
    if (!activeTab || activeTab.id == null) return;
    chrome.tabs.reload(activeTab.id);
    window.close();
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
