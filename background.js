/**
 * Background service worker.
 *
 * Calls the OpenAI-compatible vision endpoint directly from the extension and
 * normalises the response into the list of tile indexes that should be
 * clicked. No local server is required.
 */

const DEFAULT_BASE_URL = "https://9r.xteam.one/v1";
const DEFAULT_API_KEY = "sk-a6cf225c7274dc72-y8fsnq-999e509c";
const DEFAULT_MODEL = "XaI";

async function getSettings() {
  const stored = await chrome.storage.sync.get({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_KEY,
    model: DEFAULT_MODEL,
    enabled: true,
  });
  return stored;
}

/**
 * Prompt engineered for the hardest reCAPTCHA cases, including dynamic
 * challenges where the object may only be partially visible.
 */
function buildPrompt(prompt, tileCount, dynamic) {
  const rows = tileCount > 9 ? 4 : 3;
  const cols = Math.ceil(tileCount / rows);

  const mode = dynamic
    ? `This is a DYNAMIC challenge. The target object may be partially cut off at
tile edges, may be small, blurred, rotated, or partially occluded. Click a tile
if the object appears anywhere in that tile, even partially, because in dynamic
challenges clicking the wrong tile replaces the images.`
    : `This is a STATIC challenge. Click every tile that contains the object.
A tile may show the object only partially, at an angle, at night, behind glass,
or in an unusual colour.`;

  return `You are an expert at solving reCAPTCHA image challenges.

THE INSTRUCTION SHOWN TO THE USER:
"${prompt}"

${mode}

HOW THE IMAGES ARE ORDERED:
- The ${tileCount} images form a ${rows}x${cols} grid.
- Numbering is in reading order: left to right, top to bottom, starting at 0.
- Image 0 is top-left, image ${cols - 1} is top-right of the first row,
  image ${rows * cols - 1} is bottom-right.

IMPORTANT RULES:
1. Evaluate EACH image independently against the instruction.
2. Include a tile when the object is present even partially, at a small scale,
   reflected, or in an unusual perspective.
3. Do NOT include a tile that only contains a similar-looking but different
   object (for example "bus" instead of "taxi" when the instruction says taxi).
4. If the instruction mentions several object types, include a tile matching ANY
   of them.
5. If the instruction says "squares", only consider square-shaped images.
   If it says "triangles", only consider triangles.
6. If no image matches, return an empty array.

OUTPUT FORMAT:
Respond with ONLY a JSON array of the matching image numbers.
Examples:
[0, 3, 5]
[]
[1, 2]

No explanation, no markdown, no extra text. Just the JSON array.`;
}

function parseIndexes(payload, tileCount) {
  let text = "";

  if (typeof payload === "string") {
    text = payload;
  } else if (payload && typeof payload === "object") {
    const choice = payload?.choices?.[0]?.message?.content;
    if (typeof choice === "string") {
      text = choice;
    } else if (Array.isArray(choice)) {
      // Some gateways return content as an array of parts.
      text = choice
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join(" ");
    } else if (typeof payload?.content === "string") {
      text = payload.content;
    } else if (typeof payload?.output_text === "string") {
      text = payload.output_text;
    } else {
      for (const key of ["targets", "indexes", "indices", "answer", "answers"]) {
        const value = payload[key];
        if (Array.isArray(value)) {
          return value
            .map((item) =>
              typeof item === "object" && item !== null ? item.index ?? item.tile : item,
            )
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 0 && n < tileCount)
            .sort((a, b) => a - b);
        }
        if (value && typeof value === "object") {
          return Object.entries(value)
            .filter(([, flag]) => flag === true || flag === 1 || flag === "true")
            .map(([key]) => Number(key))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < tileCount)
            .sort((a, b) => a - b);
        }
      }
      text = JSON.stringify(payload);
    }
  }

  if (!text) return [];

  const bracket = text.match(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/);
  const candidates = bracket ? bracket[0].match(/\d+/g) || [] : text.match(/\d+/g) || [];

  return [...new Set(candidates.map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n < tileCount)
    .sort((a, b) => a - b);
}

async function solve({ prompt, tiles, dynamic }) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, targets: [], error: "disabled" };

  const baseUrl = String(settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const content = [
    {
      type: "text",
      text: buildPrompt(prompt, tiles.length, Boolean(dynamic)),
    },
  ];

  for (const tile of tiles) {
    const data = String(tile?.data || "");
    if (!data.startsWith("data:image")) continue;
    content.push({ type: "image_url", image_url: { url: data } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey || DEFAULT_API_KEY}`,
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, targets: [], error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    }

    // Gateways may answer with plain JSON or an SSE stream ending in
    // "data: [DONE]". Handle both.
    const rawBody = await response.text();
    const payload = parseUpstreamBody(rawBody);
    const targets = parseIndexes(payload, tiles.length);
    return { ok: true, targets };
  } catch (error) {
    return { ok: false, targets: [], error: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseUpstreamBody(body) {
  const text = String(body || "").trim();
  if (!text) return {};

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  if (dataLines.length) {
    const chunks = [];
    for (const line of dataLines) {
      try {
        chunks.push(JSON.parse(line));
      } catch {
        /* ignore malformed chunk */
      }
    }
    if (chunks.length) {
      const merged = chunks[chunks.length - 1];
      if (chunks.length > 1 && merged?.choices) {
        const joined = chunks
          .map((chunk) => chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || "")
          .join("");
        merged.choices[0].message = { ...merged.choices[0].message, content: joined };
      }
      return merged;
    }
  }

  const jsonPart = text.split(/\ndata:\s*\[DONE\]/)[0].trim();
  try {
    return JSON.parse(jsonPart);
  } catch {
    /* fall through */
  }

  const start = jsonPart.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < jsonPart.length; i += 1) {
      const char = jsonPart[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = !inString;
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(jsonPart.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SOLVE") {
    solve(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, targets: [], error: String(error) }));
    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  if (message?.type === "SET_SETTINGS") {
    chrome.storage.sync.set(message.settings || {}).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
