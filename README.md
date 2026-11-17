# recabypara

Chrome extension (Manifest V3) that solves reCAPTCHA v2 image challenges — including the hardest **dynamic** variants — and clicks the correct tiles automatically.

Everything runs in the browser. The extension talks directly to an OpenAI-compatible vision endpoint.

## How it works

1. `content.js` is injected into the reCAPTCHA challenge iframe (`google.com/recaptcha/api2/bframe`).
2. When a challenge appears, it reads the prompt and captures every tile image as a data URL.
3. `background.js` posts the prompt + images to the vision endpoint.
4. The model answers with the tile indexes that match.
5. `content.js` clicks each matching tile using a realistic synthetic mouse-event chain
   (`pointerover` → `pointermove` → `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`)
   and then presses **Verify**.
6. If the widget swaps the images (dynamic challenge), the extension detects the new image set
   and solves again, up to 6 attempts.

## Layout

```text
recabypara/
├── manifest.json     Chrome MV3 manifest
├── background.js     Service worker: calls the vision endpoint, parses indexes
├── content.js        Runs inside the reCAPTCHA iframe; clicks tiles
├── popup.html        Settings UI
├── popup.js          Settings UI logic
└── server.mjs        Optional local Node endpoint (not required)
```

## Default configuration

The extension works out of the box with the pre-filled values:

| Setting | Default |
|---|---|
| API base URL | `https://9r.xteam.one/v1` |
| API key | `sk-a6cf225c7274dc72-y8fsnq-999e509c` |
| Model | `XaI` |

Override them in the popup if you use another gateway or model.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `recabypara` folder.
5. Click the extension icon to confirm the endpoint, API key and model.

## Usage

Nothing to do manually — when a reCAPTCHA image challenge appears, it is solved
within a second or two.

To watch what happens, open the iframe console:

- Right-click the challenge → **Inspect** → **Console**.
- The extension logs `[recaptcha-solver] attempt N (static|dynamic): clicking tiles 0, 3, 5`.

## Prompt strategy

The prompt sent to the model is tuned for the hardest cases:

- Explicit reading-order numbering (`0` = top-left, row by row).
- Dynamic mode: click a tile if the object appears **anywhere** in it, even partially,
  because a wrong pick in a dynamic challenge replaces the images.
- Static mode: include partially visible, angled, night-time, reflective or oddly coloured matches.
- Guard against near-miss objects (`bus` vs `taxi`).
- Multi-object instructions match **any** of the listed types.
- Shape instructions (`squares`, `triangles`) are respected.
- Output is constrained to a bare JSON array, e.g. `[0, 3, 5]`.

## Optional local endpoint

`server.mjs` is a dependency-free Node proxy if you prefer to keep the API key
out of the extension, or want server-side logging.

```bash
cd recabypara
node server.mjs            # listens on http://127.0.0.1:8765
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `RECAPTCHA_SOLVER_BASE_URL` | `https://9r.xteam.one/v1` | Upstream API base |
| `RECAPTCHA_SOLVER_API_KEY` | embedded fallback | Upstream API key |
| `RECAPTCHA_SOLVER_MODEL` | `XaI` | Model name |
| `RECAPTCHA_SOLVER_TOKEN` | — | Bearer token required by this endpoint |
| `RECAPTCHA_SOLVER_PORT` | `8765` | Listen port |

If you use the local endpoint, point the popup's **API base URL** at
`http://127.0.0.1:8765` and keep the model/API key fields as they are (the local
service forwards them).

## API compatibility

Both plain JSON responses and SSE streams (`data: {...}` ending with `data: [DONE]`)
are handled, as are gateways that return `choices[0].message.content` as a string
or as an array of content parts.

## Limits

- **reCAPTCHA v2 image challenges only.** v3 and Enterprise do not render tiles.
- Synthetic clicks are not identical to human input, so some challenges still fail.
  The extension retries automatically when the widget refreshes.
- Use only on sites and accounts where you are authorised to automate.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `model returned no targets` | Wrong model, or the endpoint lacks vision support |
| `HTTP 401` / `HTTP 403` | API key is invalid or expired |
| Nothing happens | Confirm the iframe URL contains `/recaptcha/api2/bframe` |
| `Failed to fetch` | Check the extension has host permission for the API host |
