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

const FACT_CHECK_BASE =
  'https://factchecktools.googleapis.com/v1alpha1/claims:search';

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
    publisher
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
    publisher: ''
  };
}
