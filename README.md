# FactOrCap

AI-powered fact-checking Chrome extension. Scans the page you're on, extracts checkable claims, and tells you what's **fact** and what's **cap**.

Powered by the [Google Fact Check Tools API](https://developers.google.com/fact-check/tools/api).

## Install

### Option 1 — Pre-built release (recommended for users)

1. Go to the [Releases page](../../releases) and download the latest `factorcap-<version>.zip`.
2. Unzip it anywhere on your computer.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped `factorcap` folder.
6. The FactOrCap icon appears in your toolbar — click it on any article to scan for claims.

The release zip ships with a working API key already embedded, so there is no setup. The key is API-restricted to the Fact Check Tools API only and shares one global free quota across all users.

### Option 2 — Build from source (developers)

1. Clone the repo.
2. Get a free API key at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) (create a project, enable **Fact Check Tools API**, create credentials → API key, restrict it to that one API). No billing required.
3. Create your local config:

   ```bash
   cp config.template.js config.js
   ```

   Open `config.js` and replace `__GOOGLE_FACT_CHECK_API_KEY__` with your key. `config.js` is git-ignored.
4. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repo folder.

After any code change, click the reload icon on the FactOrCap card and refresh whichever tab you're testing.

## How it works

1. Click the FactOrCap toolbar icon, or the floating pill in the corner of any page.
2. The content script extracts text from the page and identifies sentences that look like checkable claims.
3. Each claim is sent to the Google Fact Check Tools API, which returns ratings from professional fact-checkers (PolitiFact, Reuters Fact Check, AFP, etc.).
4. Claims are highlighted inline and listed in a sidebar, color-coded by verdict:
   - **Fact** — rated true / accurate / verified.
   - **Cap** — rated false, misleading, fabricated, etc.
   - **Unverified** — no matching fact-check found, or the rating didn't map cleanly.

## Project structure

```
manifest.json          ← Extension manifest (MV3)
background.js          ← Service worker; importScripts('config.js') for the API key
config.template.js     ← Tracked template; CI replaces the placeholder
config.js              ← Local-only (git-ignored) — your real API key lives here
content.js             ← Content script: scanning, highlighting, sidebar UI
content.css            ← Inline highlight styling
icons/                 ← Toolbar / store icons
.github/workflows/
  build.yml            ← Builds + releases the extension on push and on v*.*.* tags
```

## Releasing a new version

The CI workflow handles everything:

1. Bump `"version"` in `manifest.json`.
2. Tag and push:
   ```bash
   git tag v1.0.1
   git push origin main --tags
   ```
3. The **Build extension** workflow runs, injects the `GOOGLE_FACT_CHECK_API_KEY` repository secret into `config.js`, zips the extension, and publishes a GitHub Release with the `factorcap-1.0.1.zip` attached.

## Repository setup (one-time, for the maintainer)

1. **Make the repo public** so anyone can clone it and download Releases — Settings → General → "Change visibility" → Public.
2. **Add the API key as a repository secret** so the build workflow can inject it:
   - Settings → Secrets and variables → Actions → **New repository secret**.
   - Name: `GOOGLE_FACT_CHECK_API_KEY`. Value: your API key (`AIzaSy…`).
3. **Restrict the key in Google Cloud** so a leaked-from-zip key can't be reused for anything else:
   - [console.cloud.google.com](https://console.cloud.google.com/) → Credentials → click the key → **API restrictions → Restrict key → Fact Check Tools API**.
4. (Optional) Set a per-day quota cap on the API in Cloud Console under **APIs & Services → Quotas** to prevent runaway use.

## Security note

The pre-built release zip contains the API key in plain JavaScript. Anyone who downloads and unzips it can read the key. This is acceptable for FactOrCap because:

- The key is API-restricted to the free Fact Check Tools API only.
- The free tier's quota is generous and shared use is the intent.
- A misbehaving user can only burn quota, not run up a bill.

If at some point you need stronger isolation, switch to a settings-page model where each user pastes their own key into the extension (stored in `chrome.storage.sync`) instead of shipping a baked-in key.
