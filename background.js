// ── API key is loaded from config.js. That file is git-ignored and
//    is generated either locally (cp config.template.js config.js,
//    then paste your key) or by the GitHub Actions build, which
//    substitutes the GOOGLE_FACT_CHECK_API_KEY repository secret
//    into config.template.js. See README.md for full setup.
try {
  importScripts('config.js');
} catch {
  console.error(
    'FactOrCap: config.js not found. Copy config.template.js to config.js ' +
      'and paste your Google Fact Check Tools API key.'
  );
}

const GOOGLE_FACT_CHECK_API_KEY =
  self.GOOGLE_FACT_CHECK_API_KEY || 'YOUR_API_KEY_HERE';
const HAS_VALID_GOOGLE_KEY =
  GOOGLE_FACT_CHECK_API_KEY &&
  GOOGLE_FACT_CHECK_API_KEY !== 'YOUR_API_KEY_HERE' &&
  !GOOGLE_FACT_CHECK_API_KEY.startsWith('__GOOGLE_FACT_CHECK_API_KEY__') &&
  !GOOGLE_FACT_CHECK_API_KEY.startsWith(
    'CI_PLACEHOLDER_SET_GOOGLE_FACT_CHECK_API_KEY_SECRET'
  );

const GEMINI_API_KEY = self.GEMINI_API_KEY || '';
const GEMINI_ENABLED =
  GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('__GEMINI_API_KEY__');

const FACT_CHECK_BASE =
  'https://factchecktools.googleapis.com/v1alpha1/claims:search';

const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Local backend that runs the pgvector + NLI + Wikipedia pipeline.
// Used when the user flips the sidebar toggle to "Enhanced (ALPHA)".
const ENHANCED_BACKEND_URL = 'http://127.0.0.1:8000/verify';

// Maps the backend's verdict vocabulary onto the extension's.
const ENHANCED_VERDICT_MAP = {
  true: 'fact',
  false: 'cap',
  unverified: 'unverified'
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggleScan' });
  } catch (_err) {
    // No content script on this tab — usually because the page was already
    // open when the extension was loaded/reloaded. Inject it on demand,
    // then resend. chrome:// and other privileged pages will fail here too;
    // we swallow the secondary error so the service worker stays clean.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'toggleScan' });
    } catch (injectErr) {
      console.warn(
        'FactOrCap: cannot run on this tab (likely a chrome:// or store page).',
        injectErr?.message || injectErr
      );
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'checkClaim') {
    const run =
      msg.mode === 'enhanced'
        ? () => checkOneEnhanced(msg.claim)
        : () => checkSingleClaim(msg.claim);
    run()
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function checkSingleClaim(claimText) {
  const factCheckResult = await checkWithGoogleFactCheck(claimText);

  // Only fall back to the model when Google's index has no published
  // fact-check for this claim, and only if a Gemini key is configured.
  if (factCheckResult.verdict === 'unverified' && GEMINI_ENABLED) {
    const aiResult = await checkWithGemini(claimText);
    if (aiResult) return aiResult;
  }

  return factCheckResult;
}

async function checkWithGoogleFactCheck(claimText) {
  if (!HAS_VALID_GOOGLE_KEY) {
    return unverifiedResult(
      claimText,
      'FactOrCap is not configured: add a real GOOGLE_FACT_CHECK_API_KEY in config.js.'
    );
  }

  const params = new URLSearchParams({
    query: claimText,
    key: GOOGLE_FACT_CHECK_API_KEY,
    languageCode: 'en'
  });

  try {
    const res = await fetch(`${FACT_CHECK_BASE}?${params}`);

    if (!res.ok) {
      console.warn('FactOrCap: API returned', res.status, await res.text());
      return unverifiedResult(claimText);
    }

    const data = await res.json();

    if (!data.claims || data.claims.length === 0) {
      return unverifiedResult(claimText);
    }

    return interpretBestMatch(claimText, data.claims);
  } catch (err) {
    console.error('FactOrCap: fetch error for claim', err);
    return unverifiedResult(claimText);
  }
}

/**
 * Asks Gemini 2.5 Flash to evaluate the claim and return a structured
 * verdict. Uses Gemini's responseSchema feature so the model is forced
 * to emit valid JSON in the exact shape we expect — no fragile prompt
 * parsing. Returns null on any failure so the caller falls back to the
 * original "unverified" result.
 */
async function checkWithGemini(claimText) {
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              'You are a careful fact-checker. Evaluate the following ' +
              'claim using widely available, mainstream knowledge. Use ' +
              '"fact" if the claim is clearly true or accurate, "cap" ' +
              'if it is clearly false, misleading, or fabricated, and ' +
              '"unverified" if you do not have enough reliable ' +
              'information either way. Keep the explanation to one ' +
              'short sentence.\n\nClaim: ' +
              claimText
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          verdict: {
            type: 'string',
            enum: ['fact', 'cap', 'unverified']
          },
          explanation: { type: 'string' }
        },
        required: ['verdict', 'explanation']
      }
    }
  };

  try {
    const res = await fetch(`${GEMINI_BASE}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.warn('FactOrCap: Gemini returned', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (
      !parsed.verdict ||
      !['fact', 'cap', 'unverified'].includes(parsed.verdict)
    ) {
      return null;
    }

    return {
      text: claimText,
      verdict: parsed.verdict,
      rating: '',
      explanation: parsed.explanation || '',
      sourceUrl: '',
      publisher: 'Gemini 2.5 Flash',
      source: 'ai'
    };
  } catch (err) {
    console.error('FactOrCap: Gemini fallback failed', err);
    return null;
  }
}

/**
 * Picks the most relevant fact-check from Google's results and maps
 * its textualRating to a fact / cap / unverified verdict.
 */
function interpretBestMatch(claimText, apiClaims) {
  const best = apiClaims[0];
  const review = best.claimReview?.[0];

  if (!review) return unverifiedResult(claimText);

  const rating = (review.textualRating || '').toLowerCase();
  const verdict = ratingToVerdict(rating);

  const publisher = review.publisher?.name || review.publisher?.site || '';
  const sourceUrl = review.url || '';
  const title = review.title || '';

  const parts = [];
  if (title) parts.push(title);
  if (publisher) parts.push(`— ${publisher}`);

  return {
    text: claimText,
    verdict,
    rating: review.textualRating || '',
    explanation: parts.join(' ') || `Rated "${review.textualRating}"`,
    sourceUrl,
    publisher,
    source: 'fact-checker'
  };
}

/**
 * Maps common textualRating strings from fact-checkers to our
 * three-state verdict system. Ratings vary across publishers, so
 * this covers the most common patterns.
 */
function ratingToVerdict(rating) {
  const falsePatterns =
    /\b(false|pants on fire|fake|incorrect|wrong|misleading|distort|manipulated|altered|fabricat|not true|cap|mostly false|barely true|no evidence)\b/i;
  const truePatterns =
    /\b(true|correct|accurate|verified|confirmed|right|mostly true|largely true)\b/i;

  if (falsePatterns.test(rating)) return 'cap';
  if (truePatterns.test(rating)) return 'fact';
  return 'unverified';
}

function unverifiedResult(
  claimText,
  explanation = "No matching fact-check found in Google's database."
) {
  return {
    text: claimText,
    verdict: 'unverified',
    rating: '',
    explanation,
    sourceUrl: '',
    publisher: '',
    source: 'fact-checker'
  };
}

/**
 * Enhanced (ALPHA) mode: post one claim to the local backend's /verify
 * endpoint. Calls are made per-claim (instead of as a batch) so the
 * sidebar can render each verdict as it arrives — the backend processes
 * verify_claims sequentially anyway, so wall-clock cost is the same.
 *
 * The backend runs pgvector retrieval over the ingested news + fact-
 * checker corpus, scores candidates with DeBERTa NLI, falls back to
 * Wikipedia for general factual claims, and combines with a Google Fact
 * Check Tools call. We map its richer response onto the same
 * {text, verdict, rating, ...} shape the sidebar already renders.
 */
async function checkOneEnhanced(claimText) {
  let res;
  try {
    res = await fetch(ENHANCED_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims: [claimText] })
    });
  } catch (err) {
    console.error('FactOrCap: enhanced backend fetch failed', err);
    throw new Error(
      'Enhanced backend unreachable at ' +
        ENHANCED_BACKEND_URL +
        '. Start it with `uvicorn app.main:app` (from backend/) or switch to Standard mode.'
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Enhanced backend returned ${res.status}. ${body.slice(0, 200) || 'See service logs.'}`
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error('Enhanced backend returned non-JSON body.');
  }

  const r = Array.isArray(data?.results) ? data.results[0] : null;
  if (!r) {
    return {
      text: claimText,
      verdict: 'unverified',
      rating: '',
      explanation: 'Enhanced backend returned no result for this claim.',
      sourceUrl: '',
      publisher: '',
      source: 'enhanced'
    };
  }
  return mapEnhancedResult(claimText, r);
}

function mapEnhancedResult(claimText, result) {
  const verdict = ENHANCED_VERDICT_MAP[result.verdict] || 'unverified';
  const topFc = pickTopFactCheck(result.fact_checks);
  const topEv = pickTopEvidence(result.evidence);

  const sourceUrl = topFc?.review_url || topEv?.url || '';
  const publisher =
    topFc?.publisher ||
    (topEv ? `${topEv.source}${topEv.title ? ` — ${topEv.title}` : ''}` : '');

  const score = typeof result.score === 'number' ? result.score : null;
  const confidence =
    typeof result.confidence === 'number' ? result.confidence : null;

  // Prefer a real fact-check label (e.g. "Mostly False"); fall back to a
  // signed numeric score so the user can still gauge magnitude.
  const rating =
    topFc?.rating || (score !== null ? `Score ${formatSigned(score)}` : '');

  const explanationParts = [];
  if (confidence !== null) {
    explanationParts.push(`confidence ${(confidence * 100).toFixed(0)}%`);
  }
  if (topEv) {
    const label = topEv.nli_label || 'evidence';
    const title = topEv.title || topEv.source;
    explanationParts.push(`top: ${title} (${label})`);
  } else if (topFc) {
    explanationParts.push(`via ${topFc.publisher || 'fact-checker'}`);
  }
  const explanation =
    explanationParts.length > 0
      ? `Local backend · ${explanationParts.join(' · ')}`
      : 'Verified by the local backend.';

  return {
    text: claimText,
    verdict,
    rating,
    explanation,
    sourceUrl,
    publisher,
    source: 'enhanced',
    score,
    confidence
  };
}

function pickTopFactCheck(list) {
  if (!Array.isArray(list)) return null;
  // Prefer parseable matches; the backend already filtered by relevance.
  return list.find((f) => f && f.parseable !== false) || list[0] || null;
}

function pickTopEvidence(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const e of list) {
    const sim = typeof e.similarity === 'number' ? e.similarity : 0;
    const nli = typeof e.nli_score === 'number' ? e.nli_score : 0;
    const ranked = Math.abs(nli) * sim;
    if (ranked > bestScore) {
      bestScore = ranked;
      best = e;
    }
  }
  return best;
}

function formatSigned(n) {
  const fixed = n.toFixed(2);
  return n >= 0 ? `+${fixed}` : fixed;
}
