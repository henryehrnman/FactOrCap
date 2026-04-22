# FactOrCap

AI-powered fact-checking Chrome extension. Scans the page you're on, extracts checkable claims, and tells you what's **fact** and what's **cap**.

## How It Works

1. Click the FactOrCap icon in your toolbar.
2. Hit **Scan Page** — the extension extracts text from the current page.
3. Claims are identified and sent to a fact-checking API.
4. Each claim is labeled **Fact** (true) or **Cap** (false).

## Project Structure

```
manifest.json        ← Extension manifest (MV3)
background.js        ← Service worker: coordinates scanning & API calls
content.js           ← Content script: extracts page text
popup/
  popup.html         ← Popup UI shell
  popup.css          ← Styling (dark theme, animations)
  popup.js           ← Popup logic & state management
icons/
  icon48.png         ← Toolbar icon
  icon128.png        ← Store / management icon
```

## Load the Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `FactOrCap` folder.
4. The extension icon will appear in your toolbar.

## Configuration

The fact-checking API endpoint is defined in `background.js`:

```js
const API_ENDPOINT = 'https://your-api-endpoint.com/check';
```

Replace it with your actual endpoint. The API should accept a JSON body like:

```json
{ "claims": ["Claim one.", "Claim two."] }
```

And respond with:

```json
{ "results": [true, false] }
```

Until you connect a real API, the extension uses simulated responses so the UI is fully testable.
