/**
 * reCAPTCHA solver endpoint (Node.js, zero dependencies).
 *
 * Exposes:
 *   GET  /health
 *   POST /solve   -> { prompt, dynamic, tiles: [{ index, data }] }
 *                 -> { targets: number[], raw: string }
 *
 * Environment:
 *   RECAPTCHA_SOLVER_BASE_URL   default: https://9r.xteam.one/v1
 *   RECAPTCHA_SOLVER_API_KEY    default: embedded fallback key
 *   RECAPTCHA_SOLVER_MODEL      default: XaI
 *   RECAPTCHA_SOLVER_TOKEN      optional bearer token for THIS endpoint
 *   RECAPTCHA_SOLVER_PORT       default: 8765
 */

import http from "node:http";
import process from "node:process";

const BASE_URL = (process.env.RECAPTCHA_SOLVER_BASE_URL || "https://9r.xteam.one/v1").replace(/\/$/, "");
const API_KEY = process.env.RECAPTCHA_SOLVER_API_KEY || "sk-a6cf225c7274dc72-y8fsnq-999e509c";
const MODEL = process.env.RECAPTCHA_SOLVER_MODEL || "XaI";
const TOKEN = process.env.RECAPTCHA_SOLVER_TOKEN || "";
const PORT = Number(process.env.RECAPTCHA_SOLVER_PORT || 8765);

/**
 * Prompt designed for the hardest reCAPTCHA cases, including dynamic
 * challenges where the object may appear in only part of a tile.
 */
function buildPrompt(prompt, tileCount, dynamic) {
  const rows = tileCount > 9 ? 4 : 3;
  const cols = Math.ceil(tileCount / rows);

  const mode = dynamic
    ? `This is a DYNAMIC challenge. The target object may be partially cut off at
tile edges, may be small, blurred, rotated, or partially occluded. Click a tile
if the object appears anywhere in that tile, even partially, because in dynamic
challenges clicking the wrong tile shows new images.`
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

function parseIndexes(text, tileCount) {
  if (!text) return [];

  const bracket = String(text).match(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/);
  let candidates = [];

  if (bracket) {
    candidates = (bracket[0].match(/\d+/g) || []).map(Number);
  } else {
    candidates = (String(text).match(/\d+/g) || []).map(Number);
  }

  const unique = [...new Set(candidates)].filter((n) => Number.isInteger(n) && n >= 0 && n < tileCount);
  return unique.sort((a, b) => a - b);
}

async function solveChallenge({ prompt, tiles, dynamic }) {
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
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Upstream HTTP ${response.status}: ${body.slice(0, 400)}`);
    }

    // Some gateways answer with plain JSON, others with an SSE stream that
    // ends with "data: [DONE]". Handle both.
    const rawBody = await response.text();
    const payload = parseUpstreamBody(rawBody);
    const raw = extractContent(payload);
    return { targets: parseIndexes(raw, tiles.length), raw: String(raw).trim() };
  } finally {
    clearTimeout(timeout);
  }
}

function parseUpstreamBody(body) {
  const text = String(body || "").trim();
  if (!text) return {};

  // Strip an SSE prefix if present.
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
        // Concatenate streamed content fragments.
        const text = chunks
          .map((chunk) => chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || "")
          .join("");
        merged.choices[0].message = { ...merged.choices[0].message, content: text };
      }
      return merged;
    }
  }

  // Plain JSON, possibly with a trailing "data: [DONE]" marker.
  const jsonPart = text.split(/\ndata:\s*\[DONE\]/)[0].trim();
  try {
    return JSON.parse(jsonPart);
  } catch {
    /* fall through */
  }

  // Last resort: find the first balanced JSON object.
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

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? payload?.output_text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0].replace(/\/$/, "");

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && (path === "/health" || path === "")) {
    sendJson(res, 200, { ok: true, model: MODEL, baseUrl: BASE_URL });
    return;
  }

  if (req.method === "POST" && path === "/solve") {
    if (TOKEN) {
      const header = req.headers.authorization || "";
      const bearer = header.replace(/^Bearer\s+/i, "").trim();
      if (bearer !== TOKEN) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 25_000_000) req.destroy();
    });

    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch (error) {
        sendJson(res, 400, { error: `invalid JSON body: ${error.message}` });
        return;
      }

      const prompt = String(payload.prompt || "").trim();
      const tiles = Array.isArray(payload.tiles) ? payload.tiles : [];

      if (!prompt) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }
      if (!tiles.length) {
        sendJson(res, 400, { error: "tiles are required" });
        return;
      }

      try {
        const result = await solveChallenge({
          prompt,
          tiles,
          dynamic: payload.dynamic,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, { error: String(error?.message || error) });
      }
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[solver] listening on http://127.0.0.1:${PORT}`);
  console.log(`[solver] upstream=${BASE_URL} model=${MODEL} token=${TOKEN ? "yes" : "no"}`);
});
