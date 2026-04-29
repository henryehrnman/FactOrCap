const API_URL = "http://127.0.0.1:8765/detect-claims";
const MAX_SENTENCES = 80;
const MAX_RESULTS = 10;
const MAX_HIGHLIGHTS = 25;

const analyzeBtn = document.getElementById("analyze-btn");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");

analyzeBtn.addEventListener("click", () => {
  runAnalysis().catch((error) => {
    console.error(error);
    updateStatus(`Error: ${error.message}`);
    analyzeBtn.disabled = false;
  });
});

function updateStatus(text) {
  statusEl.textContent = text;
}

function clearResults() {
  summaryEl.classList.add("hidden");
  summaryEl.textContent = "";
  resultsEl.innerHTML = "";
}

async function runAnalysis() {
  analyzeBtn.disabled = true;
  clearResults();
  updateStatus("Reading sentences from this page...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const extractionResponse = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractSentencesFromBody,
    args: [MAX_SENTENCES]
  });

  const sentences = extractionResponse?.[0]?.result ?? [];
  if (!sentences.length) {
    updateStatus("No readable sentences found on this page.");
    analyzeBtn.disabled = false;
    return;
  }

  updateStatus(`Scoring ${sentences.length} sentences with local model...`);
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentences })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Local model server returned ${response.status}. ${body || "Start server first."}`
    );
  }

  const data = await response.json();
  const allResults = data.results || [];
  const claimResults = allResults
    .filter((item) => item.prediction === "claim")
    .sort((a, b) => b.claim_probability - a.claim_probability);

  const highlightResponse = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: highlightClaimsOnPage,
    args: [claimResults.slice(0, MAX_HIGHLIGHTS).map((item) => item.sentence)]
  });
  const highlightedCount = highlightResponse?.[0]?.result ?? 0;

  renderSummary(claimResults.length, allResults.length);
  renderResults(claimResults.slice(0, MAX_RESULTS));
  updateStatus(`Done. Highlighted ${highlightedCount} claim sentence(s) on page.`);
  analyzeBtn.disabled = false;
}

function renderSummary(claimCount, totalCount) {
  summaryEl.classList.remove("hidden");
  summaryEl.textContent = `Detected ${claimCount} likely claims out of ${totalCount} extracted sentences.`;
}

function renderResults(results) {
  if (!results.length) {
    resultsEl.innerHTML = "<li>No likely claims found above threshold.</li>";
    return;
  }

  resultsEl.innerHTML = results
    .map(
      (item) =>
        `<li><span class="score">${(item.claim_probability * 100).toFixed(1)}%</span> - <span class="sentence">${escapeHtml(item.sentence)}</span></li>`
    )
    .join("");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extractSentencesFromBody(maxSentences) {
  const bodyText = (document.body?.innerText || "")
    .replace(/\s+/g, " ")
    .trim();

  const parts = bodyText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, " "))
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 320);

  const deduped = [];
  const seen = new Set();
  for (const sentence of parts) {
    const key = sentence.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(sentence);
    }
    if (deduped.length >= maxSentences) {
      break;
    }
  }

  return deduped;
}

function highlightClaimsOnPage(sentences) {
  const MARK_CLASS = "factorcap-claim-highlight";
  const STYLE_ID = "factorcap-claim-highlight-style";
  const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);

  const existingHighlights = document.querySelectorAll(`mark.${MARK_CLASS}`);
  for (const mark of existingHighlights) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize();
  }

  if (!Array.isArray(sentences) || !sentences.length) {
    return 0;
  }

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${MARK_CLASS} {
        background: #fde68a;
        color: #111827;
        padding: 0 2px;
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  const normalizedSentences = sentences
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  let highlightCount = 0;
  for (const sentence of normalizedSentences) {
    if (highlightSentenceInBody(sentence, MARK_CLASS, ignoredTags)) {
      highlightCount += 1;
    }
  }

  return highlightCount;
}

function highlightSentenceInBody(sentence, markClass, ignoredTags) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      if (ignoredTags.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest(`mark.${markClass}`)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.nodeValue || "";
      return text.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  let textNode = walker.nextNode();
  while (textNode) {
    const text = textNode.nodeValue || "";
    const matchIndex = text.indexOf(sentence);
    if (matchIndex !== -1) {
      const before = text.slice(0, matchIndex);
      const match = text.slice(matchIndex, matchIndex + sentence.length);
      const after = text.slice(matchIndex + sentence.length);

      const fragment = document.createDocumentFragment();
      if (before) {
        fragment.appendChild(document.createTextNode(before));
      }

      const mark = document.createElement("mark");
      mark.className = markClass;
      mark.textContent = match;
      fragment.appendChild(mark);

      if (after) {
        fragment.appendChild(document.createTextNode(after));
      }

      const parent = textNode.parentNode;
      if (!parent) {
        return false;
      }
      parent.replaceChild(fragment, textNode);
      return true;
    }
    textNode = walker.nextNode();
  }

  return false;
}
