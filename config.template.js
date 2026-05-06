// FactOrCap configuration template.
//
// LOCAL DEVELOPMENT
//   1. Copy this file to config.js (which is git-ignored).
//   2. Replace the placeholder with your real API key.
//
// CI BUILD
//   .github/workflows/build.yml copies this template to config.js and
//   substitutes the placeholder with the matching repository secret.

// Required — Google Fact Check Tools API key.
// Get one at https://console.cloud.google.com/apis/credentials
// (enable the "Fact Check Tools API" first; no billing required).
self.GOOGLE_FACT_CHECK_API_KEY = '__GOOGLE_FACT_CHECK_API_KEY__';
