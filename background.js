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

const FACT_CHECK_BASE =
  'https://factchecktools.googleapis.com/v1alpha1/claims:search';

// Wikipedia REST endpoints — free, no key, no per-app quota.
// Used to enrich "unverified" claims with a real source the user can read.
const WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';

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
    const claim = normalizeClaimForLookup(msg.claim);
    const mode = msg.mode === 'enhanced' ? 'enhanced' : 'standard';
    const cached = readCache(claim, mode);
    if (cached) {
      sendResponse({ result: cached });
      return false;
    }
    const run =
      mode === 'enhanced'
        ? () => checkOneEnhanced(claim)
        : () => checkSingleClaim(claim);
    runOnce(`${mode}::${claim}`, run)
      .then((result) => {
        writeCache(claim, mode, result);
        sendResponse({ result });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// In-flight dedup + ~10-min in-memory verdict cache.
const inFlight = new Map();
const verdictCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeClaimForLookup(text) {
  return String(text || '')
    .replace(/\[\d+\]|\[citation needed\]|\[update\]|\[edit\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(claim, mode) {
  return `${mode}::${claim.toLowerCase()}`;
}

function readCache(claim, mode) {
  const hit = verdictCache.get(cacheKey(claim, mode));
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  if (hit) verdictCache.delete(cacheKey(claim, mode));
  return null;
}

function writeCache(claim, mode, result) {
  if (!result || result.verdict === 'checking') return;
  verdictCache.set(cacheKey(claim, mode), { v: result, t: Date.now() });
  if (verdictCache.size > 500) {
    const firstKey = verdictCache.keys().next().value;
    verdictCache.delete(firstKey);
  }
}

function runOnce(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function checkSingleClaim(claimText) {
  const factCheckResult = await checkWithGoogleFactCheck(claimText);

  // Decisive Google fact-check wins outright.
  if (factCheckResult.verdict !== 'unverified') return factCheckResult;

  // Otherwise, look up Wikipedia and attach what we find as context. We
  // intentionally do NOT promote this to fact/cap on our own — Wikipedia
  // alone can't decide a verdict — but having a real source the reader
  // can click on is far more useful than a blank "?".
  const wiki = await checkWithWikipedia(claimText);
  if (!wiki) return factCheckResult;

  // If Google had ANY hit (even unverified) that came with a source URL —
  // e.g. a "mixture" rated fact-check — keep that as primary, and append
  // Wikipedia context to the explanation. Otherwise Wikipedia is the
  // primary source.
  const hasGoogleSource = !!factCheckResult.sourceUrl;
  const wikiBlurb = `Wikipedia · ${wiki.title}: ${wiki.extract}`;

  if (hasGoogleSource) {
    return {
      ...factCheckResult,
      explanation: factCheckResult.explanation
        ? `${factCheckResult.explanation} — ${wikiBlurb}`
        : wikiBlurb
    };
  }

  return {
    text: claimText,
    verdict: 'unverified',
    rating: '',
    explanation: wikiBlurb,
    sourceUrl: wiki.url,
    publisher: 'Wikipedia',
    source: 'wikipedia'
  };
}

/**
 * One alternate query (stripped boilerplate) helps Google's index match
 * without sending shortened sentences that often retrieve unrelated hits.
 */
function buildSearchVariants(raw) {
  const t = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return [];

  const variants = [t];

  const strippedLead = t
    .replace(
      /^(according to|based on|reports?\s+(say|claim|suggest)|it(?:'s| is)\s+(said|claimed|reported)\s+that)\s+/i,
      ''
    )
    .trim();
  if (strippedLead.length >= 24 && strippedLead !== t) {
    variants.push(strippedLead);
  }

  return variants;
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
 * Searches Wikipedia for the most relevant article for a claim and
 * returns a trimmed page summary with its URL. Free, no key, no quota
 * specific to this app. Returns null if nothing usable comes back.
 */
async function checkWithWikipedia(claimText) {
  const query = buildWikiQuery(claimText);
  if (!query) return null;

  try {
    const searchUrl = `${WIKI_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=1`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'Api-User-Agent': 'FactOrCap/1.0 (chrome-extension)' }
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const top = searchData?.pages?.[0];
    if (!top?.key) return null;

    const sumUrl = `${WIKI_SUMMARY_URL}/${encodeURIComponent(top.key)}`;
    const sumRes = await fetch(sumUrl, {
      headers: { 'Api-User-Agent': 'FactOrCap/1.0 (chrome-extension)' }
    });
    if (!sumRes.ok) return null;
    const summary = await sumRes.json();

    if (summary?.type === 'disambiguation') return null;

    const extract = String(summary.extract || '').trim();
    if (!extract) return null;

    const trimmed =
      extract.length > 280 ? `${extract.slice(0, 277).trimEnd()}…` : extract;

    const url =
      summary.content_urls?.desktop?.page ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(top.key)}`;

    return {
      title: summary.title || top.key.replace(/_/g, ' '),
      url,
      extract: trimmed
    };
  } catch (err) {
    console.warn('FactOrCap: Wikipedia lookup failed', err);
    return null;
  }
}

/**
 * Trims the claim down to a query Wikipedia's search will accept. Strips
 * obvious framing ("according to…", "studies show that…") and caps to a
 * length the search endpoint handles well.
 */
function buildWikiQuery(claimText) {
  const t = String(claimText || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /^(according to|based on|reports?\s+(say|claim|suggest)|studies?\s+(say|show|suggest|find)s?\s+that|it(?:'s| is)\s+(said|claimed|reported)\s+that)\s+/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length > 250 ? t.slice(0, 250) : t;
}

/**
 * Prefer API rows whose indexed claim text overlaps the user's claim so
 * variants / fuzzy search do not latch onto unrelated fact-checks.
 */
function rankClaimsByRelevance(userClaim, apiClaims) {
  const u = userClaim.toLowerCase().trim();
  const scored = apiClaims.map((entry, i) => ({
    entry,
    score: scoreClaimOverlap(u, String(entry.text || '').toLowerCase()),
    i
  }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.entry);
}

function scoreClaimOverlap(userLc, claimLc) {
  if (!claimLc) return 0;
  if (userLc === claimLc) return 1000;
  if (userLc.includes(claimLc) || claimLc.includes(userLc)) return 500;
  const userWords = new Set(userLc.split(/\s+/).filter((w) => w.length > 2));
  let n = 0;
  for (const w of claimLc.split(/\s+/)) {
    if (w.length > 2 && userWords.has(w)) n++;
  }
  return n;
}

/**
 * Picks the best fact-check from Google's results and maps textualRating
 * to a verdict. Scans ranked claims — API order is not always best-first.
 */
function interpretBestMatch(claimText, apiClaims) {
  let fallback = null;

  for (const entry of rankClaimsByRelevance(claimText, apiClaims)) {
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

  const r = rating.toLowerCase();

  // Nuanced grades — keep as unverified instead of guessing fact vs cap.
  if (
    /\b(half[\s-]?true|half[\s-]?false|mixture|mixed|partly true|partially true|some\s+truth|element\s+of\s+truth)\b/i.test(
      r
    )
  ) {
    return 'unverified';
  }

  const falsePatterns =
    /\b(false|pants on fire|four\s*pinocchios?|three\s*pinocchios?|fake|incorrect|wrong|misleading|distort|manipulated|altered|fabricat|not true|cap|mostly false|barely true|no evidence|baseless|debunked|unsubstantiated|hoax|doctored|scam|miscaptioned|altered\s+video|out\s+of\s+context|lacks\s+context|missing\s+context|partially false|partly false)\b/i;
  const truePatterns =
    /\b(mostly true|largely true|substantially true|generally accurate|correct|accurate|verified|confirmed|right)\b|\btrue\b/i;

  if (falsePatterns.test(r)) return 'cap';
  if (truePatterns.test(r)) return 'fact';
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
      'Enhanced (ALPHA) backend not reachable at ' +
        ENHANCED_BACKEND_URL +
        '. Open a terminal in `backend/`, run `source .venv/bin/activate && ' +
        'uvicorn app.main:app --reload --port 8000`, then retry — or flip ' +
        'the toggle back to Standard.'
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
