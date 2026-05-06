# FactOrCap

AI-powered fact-checking Chrome extension. Scans the page you're on, extracts checkable claims, and tells you what's **fact** and what's **cap**.

Powered by the [Google Fact Check Tools API](https://developers.google.com/fact-check/tools/api), with optional fallback to [Gemini 2.5 Flash](https://ai.google.dev/) for claims that haven't been published in the fact-check index.

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
2. Get a free **Fact Check Tools API key** at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) (create a project, enable **Fact Check Tools API**, create credentials → API key, restrict it to that one API). No billing required.
3. *(Optional but recommended)* Get a free **Gemini API key** at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) for the AI fallback on claims with no published fact-check.
4. Create your local config:

   ```bash
   cp config.template.js config.js
   ```

   Open `config.js`. Paste your Fact Check Tools key in place of `__GOOGLE_FACT_CHECK_API_KEY__` and your Gemini key in place of `__GEMINI_API_KEY__` (or leave the Gemini line as `''` to disable the fallback). `config.js` is git-ignored.
5. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repo folder.

After any code change, click the reload icon on the FactOrCap card and refresh whichever tab you're testing.

## How it works

1. Click the FactOrCap toolbar icon, or the floating pill in the corner of any page.
2. The content script extracts text from the page and identifies sentences that look like checkable claims.
3. Each claim is sent to the Google Fact Check Tools API, which returns ratings from professional fact-checkers (PolitiFact, Reuters Fact Check, AFP, etc.).
4. If no published fact-check exists for a claim and a Gemini API key is configured, the claim is sent to Gemini 2.5 Flash for an AI-generated verdict. AI verdicts are tagged with a small **AI** badge in the sidebar so you can tell them apart from human fact-checker verdicts.
5. Claims are highlighted inline and listed in a sidebar, color-coded by verdict:
   - **Fact** — rated true / accurate / verified.
   - **Cap** — rated false, misleading, fabricated, etc.
   - **Unverified** — no matching fact-check found, and either Gemini wasn't configured or wasn't confident enough.

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
2. **Add the API keys as repository secrets** so the build workflow can inject them:
   - Settings → Secrets and variables → Actions → **New repository secret**.
   - Required: `GOOGLE_FACT_CHECK_API_KEY` — your Fact Check Tools key.
   - Optional: `GEMINI_API_KEY` — your Gemini key. If omitted the build still succeeds; the AI fallback is just disabled in that build.
3. **Restrict each key in Google Cloud / AI Studio** so a leaked-from-zip key can't be reused for anything else:
   - Fact Check Tools key: [console.cloud.google.com](https://console.cloud.google.com/) → Credentials → click the key → **API restrictions → Restrict key → Fact Check Tools API**.
   - Gemini key: keys created via AI Studio are already scoped to the Generative Language API only.
4. (Optional) Set per-day quota caps on both APIs to prevent runaway use.

## Security note

The pre-built release zip contains both API keys in plain JavaScript. Anyone who downloads and unzips it can read them. This is acceptable for FactOrCap because:

- Each key is restricted to a single, low-stakes API (Fact Check Tools and Generative Language).
- Both APIs have generous free tiers and shared use is the intent.
- A misbehaving user can only burn shared quota, not run up a bill — assuming you don't enable billing on either project.

If you ever need stronger isolation, switch to a settings-page model where each user pastes their own keys into the extension (stored in `chrome.storage.sync`) instead of shipping baked-in keys.
