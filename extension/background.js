// background.js — Service worker (Manifest V3)
//
// Responsável por: buscar periodicamente o cupons.json publicado no GitHub
// Pages e guardar em chrome.storage.local, pra o content.js e o popup.js não
// precisarem fazer fetch toda hora. Não guarda nem envia nada sobre a sua
// navegação — só lê um JSON público que você mesmo hospeda.

const ALARM_NAME = "sync-cupons";
const DEFAULT_SYNC_MINUTES = 60; // não faz sentido sincronizar mais rápido que
                                  // o scraper roda (também a cada hora)

async function getFeedUrl() {
  const { feedUrl } = await chrome.storage.local.get("feedUrl");
  return feedUrl || "";
}

async function syncCoupons() {
  const feedUrl = await getFeedUrl();
  if (!feedUrl) {
    await chrome.storage.local.set({ syncStatus: "sem-url", lastSyncAt: null });
    return { ok: false, reason: "sem-url" };
  }

  try {
    const response = await fetch(feedUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const coupons = Array.isArray(data.coupons) ? data.coupons : [];

    await chrome.storage.local.set({
      coupons,
      generatedAt: data.generated_at || null,
      lastSyncAt: new Date().toISOString(),
      syncStatus: "ok",
    });

    return { ok: true, count: coupons.length };
  } catch (err) {
    await chrome.storage.local.set({
      syncStatus: "erro",
      lastSyncError: String(err),
      lastSyncAt: new Date().toISOString(),
    });
    return { ok: false, reason: String(err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: DEFAULT_SYNC_MINUTES });
  syncCoupons();
});

chrome.runtime.onStartup.addListener(() => {
  syncCoupons();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncCoupons();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SYNC_NOW") {
    syncCoupons().then(sendResponse);
    return true; // mantém o canal aberto pra resposta assíncrona
  }

  if (message?.type === "SET_FEED_URL") {
    chrome.storage.local.set({ feedUrl: message.url }).then(() => {
      syncCoupons().then(sendResponse);
    });
    return true;
  }

  return false;
});
