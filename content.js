/**
 * Content script injected into the reCAPTCHA challenge iframe (bframe).
 *
 * Responsibilities:
 *   1. Detect the active image challenge and read its prompt.
 *   2. Collect the tile images as data URLs.
 *   3. Ask the background worker which tiles to click.
 *   4. Click those tiles with a realistic synthetic mouse-event sequence.
 *   5. Submit with Verify, and retry if the widget refreshes the images.
 */

const RECAPTCHA = {
  TILE_SELECTOR: ".rc-imageselecttile",
  TILE_IMAGE_SELECTOR: "img[src^='data:image']",
  PROMPT_SELECTOR: "#rc-imageselect-label-text, .rc-imageselect-label-text",
  VERIFY_SUBMIT_SELECTOR: "#recaptcha-verify-button",
  SKIP_SELECTOR: "#recaptcha-skip-button",
  RELOAD_SELECTOR: "#recaptcha-reload-button",
  TILE_WRAPPER_SELECTOR: ".rc-imageselect-tile",
};

let solving = false;
let solveTimer = null;
let lastSignature = "";
let attempts = 0;
const MAX_ATTEMPTS = 6;

function waitFor(predicate, timeoutMs = 10000, intervalMs = 200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch {
        value = null;
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

function getPrompt() {
  const el = document.querySelector(RECAPTCHA.PROMPT_SELECTOR);
  return (el?.textContent || "").trim();
}

function getTiles() {
  return Array.from(document.querySelectorAll(RECAPTCHA.TILE_SELECTOR)).filter(isVisible);
}

function isDynamicChallenge() {
  // Dynamic challenges expose the "skip" button and a refresh control.
  const hasSkip = Boolean(document.querySelector(RECAPTCHA.SKIP_SELECTOR));
  const infobar = document.querySelector("#rc-imageselect-infobar")?.textContent || "";
  const hasRefresh = Boolean(document.querySelector(RECAPTCHA.RELOAD_SELECTOR));
  return hasSkip || /new images|skip/i.test(infobar) || (hasRefresh && document.querySelectorAll(RECAPTCHA.TILE_SELECTOR).length > 0 && /dynamic/i.test(document.body?.className || ""));
}

function readTileImages() {
  const tiles = getTiles();
  return tiles.map((tile, index) => {
    const img = tile.querySelector(RECAPTCHA.TILE_IMAGE_SELECTOR);
    return {
      index,
      data: img?.src || "",
      selected: tile.classList.contains("rc-imageselect-tile-selected"),
    };
  });
}

/**
 * Dispatch a full pointer/mouse event chain so reCAPTCHA records a click that
 * resembles a genuine user interaction.
 */
async function clickTile(tile, index) {
  const rect = tile.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const jitterX = ((index * 37) % 13) - 6;
  const jitterY = ((index * 53) % 11) - 5;
  const x = rect.left + rect.width / 2 + jitterX;
  const y = rect.top + rect.height / 2 + jitterY;

  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: window.screenX + x,
    screenY: window.screenY + y,
    button: 0,
    buttons: 1,
    detail: 1,
  };

  const fire = (target, type, extra = {}) => {
    let event;
    if (type.startsWith("pointer")) {
      event = new PointerEvent(type, {
        ...common,
        ...extra,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: extra.pressure ?? 0.5,
      });
    } else if (type === "click") {
      event = new MouseEvent(type, { ...common, ...extra, buttons: 0 });
    } else {
      event = new MouseEvent(type, { ...common, ...extra });
    }
    target.dispatchEvent(event);
  };

  fire(tile, "pointerover");
  fire(tile, "pointerenter");
  fire(tile, "mouseover");
  fire(tile, "mouseenter");
  fire(tile, "pointermove");
  fire(tile, "mousemove");

  await new Promise((r) => setTimeout(r, 40 + (index % 4) * 15));

  fire(tile, "pointerdown", { pressure: 0.5 });
  fire(tile, "mousedown");
  await new Promise((r) => setTimeout(r, 50 + (index % 3) * 20));
  fire(tile, "pointerup", { pressure: 0 });
  fire(tile, "mouseup", { buttons: 0 });
  fire(tile, "click", { buttons: 0 });

  await new Promise((r) => setTimeout(r, 120 + (index % 5) * 30));
  return true;
}

async function clickVerifyButton() {
  const button = document.querySelector(RECAPTCHA.VERIFY_SUBMIT_SELECTOR);
  if (!button || !isVisible(button)) return false;
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  button.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
  button.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    }),
  );
  await new Promise((r) => setTimeout(r, 60));
  button.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0 }),
  );
  button.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0 }),
  );
  return true;
}

async function requestTargets(prompt, tiles, dynamic) {
  const response = await chrome.runtime.sendMessage({
    type: "SOLVE",
    prompt,
    dynamic,
    tiles: tiles.map((t) => ({ index: t.index, data: t.data })),
  });
  if (!response || !response.ok) {
    console.warn("[recaptcha-solver] solve failed:", response?.error || "unknown error");
    return [];
  }
  return Array.isArray(response.targets) ? response.targets : [];
}

async function solveChallenge() {
  if (solving) return;

  const prompt = getPrompt();
  if (!prompt) return;

  const tiles = getTiles();
  if (tiles.length < 4) return;

  solving = true;
  attempts += 1;

  try {
    const images = readTileImages();
    const dynamic = isDynamicChallenge();
    const targets = await requestTargets(prompt, images, dynamic);

    if (!targets.length) {
      console.warn("[recaptcha-solver] model returned no targets");
      attempts = 0;
      return;
    }

    console.log(
      `[recaptcha-solver] attempt ${attempts} (${dynamic ? "dynamic" : "static"}): clicking tiles ${targets.join(", ")}`,
    );

    for (const index of targets) {
      const tile = getTiles()[index];
      if (!tile) continue;
      await clickTile(tile, index);
    }

    await new Promise((r) => setTimeout(r, 700));
    await clickVerifyButton();

    // For dynamic challenges the widget swaps the images after a wrong pick.
    // Wait and re-solve if the challenge is still present.
    await new Promise((r) => setTimeout(r, 1600));
    const stillOpen = Boolean(document.querySelector(RECAPTCHA.VERIFY_SUBMIT_SELECTOR));
    if (stillOpen && attempts < MAX_ATTEMPTS) {
      lastSignature = ""; // force the observer to trigger another solve
      scheduleSolve(900);
    } else {
      attempts = 0;
    }
  } catch (error) {
    console.error("[recaptcha-solver] solve failed", error);
  } finally {
    solving = false;
  }
}

function scheduleSolve(delay = 500) {
  if (solveTimer) clearTimeout(solveTimer);
  solveTimer = setTimeout(() => solveChallenge(), delay);
}

function currentSignature() {
  const prompt = getPrompt();
  if (!prompt) return "";
  const tiles = getTiles();
  if (tiles.length < 4) return "";
  const thumbs = tiles.map((t) => (t.querySelector("img")?.src || "").slice(-28)).join("|");
  return `${prompt}::${thumbs}`;
}

function observeChallenge() {
  const root = document.body;
  if (!root) return;

  const observer = new MutationObserver(() => {
    const signature = currentSignature();
    if (!signature) return;
    if (signature !== lastSignature) {
      lastSignature = signature;
      scheduleSolve(800);
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "class"],
  });

  scheduleSolve(900);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, url: location.href });
  }
  if (message?.type === "SOLVE_NOW") {
    solveChallenge();
    sendResponse({ ok: true });
  }
  return true;
});

observeChallenge();
