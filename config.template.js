// FactOrCap configuration template.
//
// LOCAL DEVELOPMENT
//   1. Copy this file to config.js (which is git-ignored).
//   2. Replace the placeholder below with your Google Fact Check Tools
//      API key. Get a free key at:
//      https://console.cloud.google.com/apis/credentials
//      (Enable the "Fact Check Tools API" first; no billing required.)
//
// CI BUILD
//   .github/workflows/build.yml copies this template to config.js and
//   substitutes __GOOGLE_FACT_CHECK_API_KEY__ with the value of the
//   GOOGLE_FACT_CHECK_API_KEY repository secret. The resulting zip is
//   published to GitHub Releases on every v*.*.* tag.

self.GOOGLE_FACT_CHECK_API_KEY = '__GOOGLE_FACT_CHECK_API_KEY__';
