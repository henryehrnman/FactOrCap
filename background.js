// --- API key is loaded from config.js. That file is git-ignored and
//     is generated either locally (cp config.template.js config.js,
//     then paste your key) or by the GitHub Actions build, which
//     substitutes the GOOGLE_FACT_CHECK_API_KEY repository secret
//     into config.template.js. See README.md for full setup.
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
  } catch {
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

  // Only fall back to the model when Google's index has no decisive match,
  // and only if a Gemini key is configured.
  if (factCheckResult.verdict === 'unverified' && GEMINI_ENABLED) {
    let aiResult = await checkWithGemini(claimText, false);
    if (aiResult?.verdict === 'unverified') {
      const retry = await checkWithGemini(claimText, true);
      if (retry) aiResult = retry;
    }
    if (aiResult) return aiResult;
  }

  return factCheckResult;
}

/**
 * Extra query shapes improve recall against Google's claim index (verbatim
 * page text often mismatches how fact-checkers phrase the claim).
 */
function buildSearchVariants(raw) {
  const t = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return [];

  const variants = new Set([t]);

  const strippedLead = t
    .replace(
      /^(according to|based on|reports?\s+(say|claim|suggest)|it(?:'s| is)\s+(said|claimed|reported)\s+that)\s+/i,
      ''
    )
    .trim();
  if (strippedLead.length >= 24) variants.add(strippedLead);

  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences[0] && sentences.length > 1 && sentences[0].length >= 24) {
    variants.add(sentences[0].trim());
  }

  if (t.length > 160) {
    const cut = t
      .slice(0, 140)
      .replace(/\s+\S*$/, '')
      .trim();
    if (cut.length >= 40) variants.add(cut);
  }

  return [...variants];
}

async function checkWithGoogleFactCheck(claimText) {
  if (!HAS_VALID_GOOGLE_KEY) {
    return unverifiedResult(
      claimText,
      'FactOrCap is not configured: add a real GOOGLE_FACT_CHECK_API_KEY in config.js.'
    );
  }

  const variants = buildSearchVariants(claimText);
  let lastCandidate = null;

  try {
    for (const query of variants) {
      const params = new URLSearchParams({
        query,
        key: GOOGLE_FACT_CHECK_API_KEY,
        languageCode: 'en'
      });

      const res = await fetch(`${FACT_CHECK_BASE}?${params}`);

      if (!res.ok) {
        console.warn('FactOrCap: API returned', res.status, await res.text());
        continue;
      }

      const data = await res.json();

      if (!data.claims || data.claims.length === 0) {
        lastCandidate = lastCandidate || unverifiedResult(claimText);
        continue;
      }

      const interpreted = interpretBestMatch(claimText, data.claims);
      if (interpreted.verdict !== 'unverified') return interpreted;
      lastCandidate = interpreted;
    }

    return lastCandidate || unverifiedResult(claimText);
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
function geminiPrompt(claimText, retry) {
  if (retry) {
    return (
      'You already judged this claim as unverified. Re-read it.\n\n' +
      'Respond with "unverified" ONLY if the claim is purely subjective ' +
      '(taste, moral opinion), unfalsifiable, or impossible to assess from ' +
      'general knowledge.\n\n' +
      'For anything testable (history, geography, science, public events, ' +
      'quotes, numbers, whether something exists), you MUST choose ' +
      '"fact" or "cap" — whichever fits mainstream consensus and reputable ' +
      'sources better. Prefer "cap" when the claim exaggerates or omits ' +
      'critical context.\n\n' +
      'Keep the explanation to one short sentence.\n\nClaim: ' +
      claimText
    );
  }
  return (
    'You are a careful fact-checker. Evaluate the claim using widely ' +
    'available mainstream knowledge from reputable sources.\n\n' +
    'Use "fact" when the claim is accurate or essentially accurate.\n' +
    'Use "cap" when it is false, misleading, omits crucial context, or ' +
    'is fabricated.\n' +
    'Use "unverified" ONLY when the claim is purely subjective, ' +
    'ambiguous without scope, or cannot be assessed from general ' +
    'knowledge (not merely because you want to hedge).\n\n' +
    'Keep the explanation to one short sentence.\n\nClaim: ' +
    claimText
  );
}

async function checkWithGemini(claimText, retry) {
  const body = {
    contents: [
      {
        parts: [
          {
            text: geminiPrompt(claimText, retry)
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
 * Picks the best fact-check from Google's results and maps textualRating
 * to a verdict. Scans every returned claim — ordering is not always best-first.
 */
function interpretBestMatch(claimText, apiClaims) {
  let fallback = null;

  for (const entry of apiClaims) {
    const review = entry.claimReview?.[0];
    if (!review) continue;

    const rating = (review.textualRating || '').toLowerCase();
    const verdict = ratingToVerdict(rating);

    const built = buildFactCheckerResult(claimText, review, verdict);

    if (verdict !== 'unverified') return built;
    if (!fallback) fallback = built;
  }

  return fallback || unverifiedResult(claimText);
}

function buildFactCheckerResult(claimText, review, verdict) {
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
  if (!rating || !String(rating).trim()) return 'unverified';

  const falsePatterns =
    /\b(false|pants on fire|four\s*pinocchios?|three\s*pinocchios?|fake|incorrect|wrong|misleading|distort|manipulated|altered|fabricat|not true|cap|mostly false|barely true|no evidence|baseless|debunked|unsubstantiated|hoax|doctored|scam|miscaptioned|altered\s+video|out\s+of\s+context|lacks\s+context|missing\s+context|partially false|partly false)\b/i;
  const truePatterns =
    /\b(true|correct|accurate|verified|confirmed|right|mostly true|largely true|substantially true|generally accurate|true\s*\(?with\s*caveats?\)?)\b/i;
  const mixedLeansCap =
    /\b(half[\s-]?true|half[\s-]?false|mixture|mixed|partly true|partially true|some\s+truth|element\s+of\s+truth)\b/i;

  if (falsePatterns.test(rating)) return 'cap';
  if (truePatterns.test(rating)) return 'fact';
  // IFCN "mixture" / PolitiFact-style grades — treat as misleading unless clearly true above.
  if (mixedLeansCap.test(rating)) return 'cap';
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
  } catch {
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
