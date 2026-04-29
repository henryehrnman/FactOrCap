// ── API key is loaded from config.js. That file is git-ignored and
//    is generated either locally (cp config.template.js config.js,
//    then paste your key) or by the GitHub Actions build, which
//    substitutes the GOOGLE_FACT_CHECK_API_KEY repository secret
//    into config.template.js. See README.md for full setup.
try {
  importScripts('config.js');
} catch (err) {
  console.error(
    'FactOrCap: config.js not found. Copy config.template.js to config.js ' +
      'and paste your Google Fact Check Tools API key.'
  );
}

const GOOGLE_FACT_CHECK_API_KEY =
  self.GOOGLE_FACT_CHECK_API_KEY || 'YOUR_API_KEY_HERE';

const GEMINI_API_KEY = self.GEMINI_API_KEY || '';
const GEMINI_ENABLED =
  GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('__GEMINI_API_KEY__');

const FACT_CHECK_BASE =
  'https://factchecktools.googleapis.com/v1alpha1/claims:search';

const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { action: 'toggleScan' });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'checkClaims') {
    checkAllClaims(msg.claims)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function checkAllClaims(claimTexts) {
  const results = await Promise.all(claimTexts.map(checkSingleClaim));
  return results;
}

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
    if (!parsed.verdict || !['fact', 'cap', 'unverified'].includes(parsed.verdict)) {
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

function unverifiedResult(claimText) {
  return {
    text: claimText,
    verdict: 'unverified',
    rating: '',
    explanation: 'No matching fact-check found in Google\'s database.',
    sourceUrl: '',
    publisher: '',
    source: 'fact-checker'
  };
}
