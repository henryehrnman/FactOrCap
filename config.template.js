// FactOrCap configuration template.
//
// LOCAL DEVELOPMENT
//   1. Copy this file to config.js (which is git-ignored).
//   2. Replace the placeholders with your real API keys.
//
// CI BUILD
//   .github/workflows/build.yml copies this template to config.js and
//   substitutes the placeholders with the matching repository secrets.

// Required — Google Fact Check Tools API key.
// Get one at https://console.cloud.google.com/apis/credentials
// (enable the "Fact Check Tools API" first; no billing required).
self.GOOGLE_FACT_CHECK_API_KEY = '__GOOGLE_FACT_CHECK_API_KEY__';

// Optional — Gemini API key for the AI fallback when a claim isn't
// found in the Fact Check Tools index. Leave this as the placeholder
// (or empty) to disable the AI fallback. Get a free key at
// https://aistudio.google.com/app/apikey
self.GEMINI_API_KEY = '__GEMINI_API_KEY__';
