const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const modelInput = document.getElementById("model");
const enabledInput = document.getElementById("enabled");
const statusEl = document.getElementById("status");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function load() {
  const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  baseUrlInput.value = settings.baseUrl || "";
  apiKeyInput.value = settings.apiKey || "";
  modelInput.value = settings.model || "";
  enabledInput.checked = settings.enabled !== false;
}

async function save() {
  const settings = {
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    enabled: enabledInput.checked,
  };
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings });
  setStatus("Saved.", "ok");
}

async function test() {
  setStatus("Testing…");
  const base = baseUrlInput.value.trim().replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKeyInput.value.trim()}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => ({}));
    const count = Array.isArray(data?.data) ? data.data.length : null;
    setStatus(count !== null ? `OK — ${count} models available.` : "OK — endpoint reachable.", "ok");
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "err");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
