const API_ENDPOINT = 'https://your-api-endpoint.com/check';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'scanPage') {
    handleScan(msg.tabId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleScan(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageText
  });

  if (!result || result.length === 0) {
    return { claims: [] };
  }

  const claims = extractClaims(result);

  if (claims.length === 0) {
    return { claims: [] };
  }

  // TODO: Replace with actual API call once backend is ready.
  // For now, simulate API responses so the UI is fully testable.
  const checkedClaims = await checkClaimsAgainstApi(claims);

  return { claims: checkedClaims };
}

function extractPageText() {
  const bodyClone = document.body.cloneNode(true);

  const removable = bodyClone.querySelectorAll(
    'script, style, noscript, svg, img, video, audio, iframe, nav, footer, header, [role="navigation"], [role="banner"], [aria-hidden="true"]'
  );
  removable.forEach((el) => el.remove());

  const text = bodyClone.innerText || bodyClone.textContent || '';

  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 20)
    .join('\n');
}

/**
 * Naive claim extraction — splits text into sentences and filters for
 * ones that look like verifiable claims. This is a placeholder until
 * a model-based extractor is wired in.
 */
function extractClaims(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];

  const claimPatterns =
    /\b(is|are|was|were|has|have|had|will|can|could|should|would|percent|million|billion|according|study|research|found|showed|proved|reported|data|statistics|increase|decrease|cause|effect|average|rate|total)\b/i;

  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 300)
    .filter((s) => claimPatterns.test(s))
    .slice(0, 10)
    .map((text) => ({ text, verdict: 'checking' }));
}

/**
 * Sends claims to the fact-checking API. Currently simulated.
 * Replace the body of this function with a real fetch() call.
 */
async function checkClaimsAgainstApi(claims) {
  // ── Simulated API delay & responses for development ──
  await new Promise((r) => setTimeout(r, 1200));

  return claims.map((claim) => ({
    ...claim,
    verdict: Math.random() > 0.4 ? 'fact' : 'cap'
  }));

  // ── Real implementation (uncomment when API is ready) ──
  // try {
  //   const res = await fetch(API_ENDPOINT, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ claims: claims.map(c => c.text) })
  //   });
  //   const data = await res.json();
  //   return claims.map((claim, i) => ({
  //     ...claim,
  //     verdict: data.results[i] ? 'fact' : 'cap'
  //   }));
  // } catch (err) {
  //   console.error('API error:', err);
  //   return claims;
  // }
}
