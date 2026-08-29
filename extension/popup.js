const testButton = document.getElementById("testButton");
const syncButton = document.getElementById("syncButton");
const syncStatus = document.getElementById("syncStatus");
const resultsCard = document.getElementById("resultsCard");
const resultsList = document.getElementById("resultsList");
const bestResultEl = document.getElementById("bestResult");
const privateInput = document.getElementById("privateCouponInput");
const addPrivateButton = document.getElementById("addPrivateButton");
const privateList = document.getElementById("privateCouponList");
const feedUrlInput = document.getElementById("feedUrlInput");
const saveFeedUrlButton = document.getElementById("saveFeedUrlButton");
const generatedAtEl = document.getElementById("generatedAt");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatRelativeTime(iso) {
  if (!iso) return "nunca";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.round(hours / 24);
  return `há ${days}d`;
}

async function refreshSyncStatus() {
  const data = await chrome.storage.local.get([
    "syncStatus",
    "lastSyncAt",
    "coupons",
    "generatedAt",
    "feedUrl",
  ]);

  feedUrlInput.value = data.feedUrl || "";

  if (!data.feedUrl) {
    syncStatus.textContent = "Configure a URL do seu cupons.json abaixo";
    generatedAtEl.textContent = "";
    return;
  }

  const count = data.coupons?.length ?? 0;
  if (data.syncStatus === "erro") {
    syncStatus.textContent = `Erro ao sincronizar (${formatRelativeTime(
      data.lastSyncAt
    )})`;
  } else {
    syncStatus.textContent = `${count} cupons · sincronizado ${formatRelativeTime(
      data.lastSyncAt
    )}`;
  }

  generatedAtEl.textContent = data.generatedAt
    ? `Lista gerada em ${new Date(data.generatedAt).toLocaleString("pt-BR")}`
    : "";
}

function renderResults(results, best) {
  resultsCard.hidden = false;
  resultsList.innerHTML = "";

  for (const r of results) {
    const row = document.createElement("div");
    const cls =
      r.outcome === "success"
        ? "result-row--success"
        : r.outcome === "error"
        ? "result-row--error"
        : "result-row--pending";
    row.className = `result-row ${cls}`;

    const label =
      r.outcome === "success"
        ? "✓ aplicado"
        : r.outcome === "error"
        ? "✗ inválido"
        : "… sem resposta clara";

    const discount =
      typeof r.discountDetected === "number" && r.discountDetected > 0
        ? ` (R$ ${r.discountDetected.toFixed(2)})`
        : "";

    const codeSpan = document.createElement("span");
    codeSpan.textContent = r.code;
    const statusSpan = document.createElement("span");
    statusSpan.textContent = `${label}${discount}`;

    row.appendChild(codeSpan);
    row.appendChild(statusSpan);
    resultsList.appendChild(row);
  }

  bestResultEl.textContent = best
    ? `Melhor cupom: ${best.code}${
        best.discountDetected
          ? ` — R$ ${best.discountDetected.toFixed(2)} de desconto`
          : ""
      }`
    : "Nenhum cupom válido encontrado para esta página.";
}

function showMessage(text) {
  resultsCard.hidden = false;
  resultsList.innerHTML = "";
  const p = document.createElement("p");
  p.className = "card__hint";
  p.textContent = text;
  resultsList.appendChild(p);
  bestResultEl.textContent = "";
}

async function loadPrivateCoupons() {
  const { privateCoupons = [] } = await chrome.storage.local.get(
    "privateCoupons"
  );
  privateList.innerHTML = "";
  privateCoupons.forEach((code) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = code;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = "Remover";
    removeBtn.addEventListener("click", async () => {
      const { privateCoupons: current = [] } = await chrome.storage.local.get(
        "privateCoupons"
      );
      const updated = current.filter((c) => c !== code);
      await chrome.storage.local.set({ privateCoupons: updated });
      loadPrivateCoupons();
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    privateList.appendChild(li);
  });
}

testButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  testButton.disabled = true;
  testButton.textContent = "Testando…";
  showMessage("Testando cupons na página, aguarde…");

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_TEST",
    });

    if (!response) {
      showMessage("Sem resposta da página. Recarregue a aba e tente de novo.");
    } else if (!response.ok) {
      const messages = {
        "campo-nao-encontrado": "Não encontrei um campo de cupom nesta página.",
        "sem-cupons-para-este-site":
          "Não há cupons conhecidos para este site ainda.",
      };
      showMessage(
        messages[response.reason] ||
          "Não foi possível testar cupons nesta página."
      );
    } else {
      renderResults(response.results, response.best);
    }
  } catch (err) {
    showMessage(
      "Não foi possível falar com esta aba. Recarregue a página e tente novamente."
    );
  } finally {
    testButton.disabled = false;
    testButton.textContent = "Testar cupons agora";
  }
});

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  syncButton.textContent = "Sincronizando…";
  await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
  await refreshSyncStatus();
  syncButton.disabled = false;
  syncButton.textContent = "Sincronizar lista";
});

addPrivateButton.addEventListener("click", async () => {
  const code = privateInput.value.trim().toUpperCase();
  if (!code) return;
  const { privateCoupons = [] } = await chrome.storage.local.get(
    "privateCoupons"
  );
  if (!privateCoupons.includes(code)) {
    await chrome.storage.local.set({
      privateCoupons: [...privateCoupons, code],
    });
  }
  privateInput.value = "";
  loadPrivateCoupons();
});

privateInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addPrivateButton.click();
});

saveFeedUrlButton.addEventListener("click", async () => {
  const url = feedUrlInput.value.trim();
  saveFeedUrlButton.disabled = true;
  saveFeedUrlButton.textContent = "Salvando…";
  await chrome.runtime.sendMessage({ type: "SET_FEED_URL", url });
  await refreshSyncStatus();
  saveFeedUrlButton.disabled = false;
  saveFeedUrlButton.textContent = "Salvar";
});

refreshSyncStatus();
loadPrivateCoupons();
