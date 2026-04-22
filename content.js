(() => {
  const SIDEBAR_WIDTH = 380;
  let sidebarRoot = null;
  let shadowRoot = null;
  let isOpen = false;
  let claims = [];
  let activeClaimId = null;

  // ─── Message listener ───────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'toggleScan') {
      if (isOpen) {
        closeSidebar();
        removeHighlights();
      } else {
        runScan();
      }
    }
  });

  // ─── Scan pipeline ──────────────────────────────────────
  async function runScan() {
    removeHighlights();
    injectSidebar();
    openSidebar();
    renderSidebarLoading();

    const pageText = extractPageText();
    const extracted = extractClaims(pageText);

    if (extracted.length === 0) {
      renderSidebarEmpty();
      return;
    }

    claims = extracted.map((text, i) => ({
      id: `foc-claim-${i}`,
      text,
      verdict: 'checking',
      explanation: ''
    }));

    highlightClaimsInPage();
    renderSidebarClaims();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'checkClaims',
        claims: claims.map((c) => c.text)
      });

      if (response.error) throw new Error(response.error);

      response.results.forEach((result, i) => {
        if (claims[i]) {
          claims[i].verdict = result.verdict;
          claims[i].explanation = result.explanation;
          claims[i].rating = result.rating || '';
          claims[i].sourceUrl = result.sourceUrl || '';
          claims[i].publisher = result.publisher || '';
        }
      });

      updateHighlightVerdicts();
      renderSidebarClaims();
    } catch (err) {
      console.error('FactOrCap: API error', err);
      renderSidebarError(err.message);
    }
  }

  // ─── Text extraction ────────────────────────────────────
  function extractPageText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(
      'script, style, noscript, svg, img, video, audio, iframe, [aria-hidden="true"]'
    ).forEach((el) => el.remove());

    const text = clone.innerText || clone.textContent || '';
    return text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 20)
      .join('\n');
  }

  /**
   * Placeholder claim extractor — splits into sentences and keeps ones
   * that look like verifiable statements. Replace with model output.
   */
  function extractClaims(text) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const pattern =
      /\b(is|are|was|were|has|have|had|will|can|could|should|would|percent|million|billion|according|study|research|found|showed|proved|reported|data|statistics|increase|decrease|cause|effect|average|rate|total)\b/i;

    return sentences
      .map((s) => s.trim())
      .filter((s) => s.length > 30 && s.length < 300)
      .filter((s) => pattern.test(s))
      .slice(0, 15);
  }

  // ─── DOM highlighting ───────────────────────────────────
  function highlightClaimsInPage() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.parentElement?.closest('.foc-sidebar-root')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.textContent.trim().length < 20) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    claims.forEach((claim) => {
      const searchStr = claim.text.replace(/[.!?]+$/, '').trim();
      for (const node of textNodes) {
        const idx = node.textContent.indexOf(searchStr);
        if (idx === -1) continue;

        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + searchStr.length);

        const mark = document.createElement('mark');
        mark.className = 'foc-highlight';
        mark.dataset.claimId = claim.id;
        mark.dataset.verdict = claim.verdict;
        mark.addEventListener('click', () => onClaimClick(claim.id));

        range.surroundContents(mark);
        break;
      }
    });
  }

  function updateHighlightVerdicts() {
    claims.forEach((claim) => {
      const el = document.querySelector(`[data-claim-id="${claim.id}"]`);
      if (el) el.dataset.verdict = claim.verdict;
    });
  }

  function removeHighlights() {
    document.querySelectorAll('.foc-highlight').forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
    claims = [];
    activeClaimId = null;
  }

  // ─── Claim click handler ────────────────────────────────
  function onClaimClick(claimId) {
    if (!isOpen) openSidebar();

    document.querySelectorAll('.foc-highlight.foc-active').forEach((el) => {
      el.classList.remove('foc-active');
    });

    const mark = document.querySelector(`[data-claim-id="${claimId}"]`);
    if (mark) mark.classList.add('foc-active');

    activeClaimId = claimId;
    renderSidebarClaims();

    const card = shadowRoot.querySelector(`[data-sidebar-claim="${claimId}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ─── Sidebar injection ─────────────────────────────────
  function injectSidebar() {
    if (sidebarRoot) return;

    sidebarRoot = document.createElement('div');
    sidebarRoot.className = 'foc-sidebar-root';
    document.body.appendChild(sidebarRoot);

    shadowRoot = sidebarRoot.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getSidebarCSS();
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'foc-panel';
    panel.innerHTML = `
      <header class="foc-header">
        <h1 class="foc-logo">Fact<span class="foc-accent">Or</span>Cap</h1>
        <button class="foc-close" aria-label="Close sidebar">&times;</button>
      </header>
      <div class="foc-body"></div>
    `;
    shadowRoot.appendChild(panel);

    shadowRoot.querySelector('.foc-close').addEventListener('click', () => {
      closeSidebar();
      removeHighlights();
    });
  }

  function openSidebar() {
    if (!sidebarRoot) injectSidebar();
    isOpen = true;
    const panel = shadowRoot.querySelector('.foc-panel');
    requestAnimationFrame(() => panel.classList.add('open'));
    document.body.style.marginRight = `${SIDEBAR_WIDTH}px`;
    document.body.style.transition = 'margin-right 0.3s ease';
  }

  function closeSidebar() {
    if (!shadowRoot) return;
    isOpen = false;
    const panel = shadowRoot.querySelector('.foc-panel');
    panel.classList.remove('open');
    document.body.style.marginRight = '';
    document.querySelectorAll('.foc-highlight.foc-active').forEach((el) => {
      el.classList.remove('foc-active');
    });
    activeClaimId = null;
  }

  // ─── Sidebar rendering ─────────────────────────────────
  function getBody() {
    return shadowRoot.querySelector('.foc-body');
  }

  function renderSidebarLoading() {
    getBody().innerHTML = `
      <div class="foc-state-msg">
        <div class="foc-spinner"></div>
        <p>Scanning page for claims&hellip;</p>
      </div>
    `;
  }

  function renderSidebarEmpty() {
    getBody().innerHTML = `
      <div class="foc-state-msg">
        <p class="foc-empty-icon">&#128196;</p>
        <p>No checkable claims found on this page.</p>
      </div>
    `;
  }

  function renderSidebarError(msg) {
    getBody().innerHTML = `
      <div class="foc-state-msg foc-error">
        <p class="foc-empty-icon">&#9888;</p>
        <p>${msg || 'Something went wrong. Click the extension icon to try again.'}</p>
      </div>
    `;
  }

  function renderSidebarClaims() {
    const body = getBody();
    const factCount = claims.filter((c) => c.verdict === 'fact').length;
    const capCount = claims.filter((c) => c.verdict === 'cap').length;
    const unverifiedCount = claims.filter((c) => c.verdict === 'unverified').length;
    const checkingCount = claims.filter((c) => c.verdict === 'checking').length;

    body.innerHTML = `
      <div class="foc-summary">
        <div class="foc-badge foc-badge-fact">
          <span class="foc-badge-count">${factCount}</span>
          <span class="foc-badge-label">${factCount === 1 ? 'Fact' : 'Facts'}</span>
        </div>
        <div class="foc-badge foc-badge-cap">
          <span class="foc-badge-count">${capCount}</span>
          <span class="foc-badge-label">${capCount === 1 ? 'Cap' : 'Caps'}</span>
        </div>
        ${
          unverifiedCount > 0
            ? `<div class="foc-badge foc-badge-unverified">
                <span class="foc-badge-count">${unverifiedCount}</span>
                <span class="foc-badge-label">Unverified</span>
              </div>`
            : ''
        }
        ${
          checkingCount > 0
            ? `<div class="foc-badge foc-badge-checking">
                <span class="foc-badge-count">${checkingCount}</span>
                <span class="foc-badge-label">Checking</span>
              </div>`
            : ''
        }
      </div>
      <ul class="foc-claims"></ul>
    `;

    const list = body.querySelector('.foc-claims');

    claims.forEach((claim) => {
      const li = document.createElement('li');
      li.className = `foc-card foc-card-${claim.verdict}${claim.id === activeClaimId ? ' foc-card-active' : ''}`;
      li.dataset.sidebarClaim = claim.id;

      const verdictLabels = {
        checking: '<span class="foc-mini-spinner"></span> Checking',
        fact: '&#10003; Fact',
        cap: '&#10007; Cap',
        unverified: '&#63; Unverified'
      };
      const verdictLabel = verdictLabels[claim.verdict] || verdictLabels.checking;

      const ratingHtml = claim.rating
        ? `<span class="foc-rating">Rated: &ldquo;${escapeHtml(claim.rating)}&rdquo;</span>`
        : '';

      const sourceHtml = claim.sourceUrl
        ? `<a class="foc-source-link" href="${escapeHtml(claim.sourceUrl)}" target="_blank" rel="noopener">
            ${claim.publisher ? escapeHtml(claim.publisher) : 'View source'} &#8599;
          </a>`
        : '';

      li.innerHTML = `
        <div class="foc-card-top">
          <span class="foc-verdict foc-verdict-${claim.verdict}">${verdictLabel}</span>
          ${ratingHtml}
        </div>
        <p class="foc-card-text">${escapeHtml(claim.text)}</p>
        ${claim.explanation ? `<p class="foc-card-explanation">${escapeHtml(claim.explanation)}</p>` : ''}
        ${sourceHtml}
      `;

      li.addEventListener('click', () => {
        const mark = document.querySelector(`[data-claim-id="${claim.id}"]`);
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          onClaimClick(claim.id);
        }
      });

      list.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── Sidebar CSS (shadow-scoped) ───────────────────────
  function getSidebarCSS() {
    return `
      :host { all: initial; }

      .foc-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: ${SIDEBAR_WIDTH}px;
        height: 100vh;
        background: #0f1117;
        color: #e4e6ed;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        display: flex;
        flex-direction: column;
        z-index: 2147483647;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        border-left: 1px solid #2a2e3b;
      }

      .foc-panel.open {
        transform: translateX(0);
      }

      /* ── Header ── */
      .foc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #2a2e3b;
        flex-shrink: 0;
      }

      .foc-logo {
        font-size: 18px;
        font-weight: 800;
        letter-spacing: -0.5px;
        color: #e4e6ed;
        margin: 0;
      }

      .foc-accent {
        color: #7c6aef;
      }

      .foc-close {
        background: none;
        border: none;
        color: #8b8fa3;
        font-size: 24px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
        line-height: 1;
        transition: color 0.15s, background 0.15s;
      }

      .foc-close:hover {
        color: #e4e6ed;
        background: #1a1d27;
      }

      /* ── Body / scrollable area ── */
      .foc-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
      }

      .foc-body::-webkit-scrollbar { width: 5px; }
      .foc-body::-webkit-scrollbar-track { background: transparent; }
      .foc-body::-webkit-scrollbar-thumb { background: #2a2e3b; border-radius: 4px; }

      /* ── State messages ── */
      .foc-state-msg {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 60px 20px;
        color: #8b8fa3;
        font-size: 14px;
        gap: 12px;
      }

      .foc-empty-icon {
        font-size: 36px;
        opacity: 0.5;
      }

      .foc-error { color: #f87171; }

      /* ── Spinner ── */
      .foc-spinner {
        width: 28px;
        height: 28px;
        border: 3px solid #2a2e3b;
        border-top-color: #7c6aef;
        border-radius: 50%;
        animation: foc-spin 0.7s linear infinite;
      }

      .foc-mini-spinner {
        display: inline-block;
        width: 10px;
        height: 10px;
        border: 2px solid #7c6aef;
        border-top-color: transparent;
        border-radius: 50%;
        animation: foc-spin 0.6s linear infinite;
        vertical-align: middle;
      }

      @keyframes foc-spin {
        to { transform: rotate(360deg); }
      }

      /* ── Summary badges ── */
      .foc-summary {
        display: flex;
        gap: 10px;
        margin-bottom: 16px;
      }

      .foc-badge {
        flex: 1;
        text-align: center;
        padding: 10px 6px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
      }

      .foc-badge-count {
        display: block;
        font-size: 22px;
        font-weight: 800;
        margin-bottom: 2px;
      }

      .foc-badge-fact {
        background: rgba(52, 211, 153, 0.1);
        border: 1px solid rgba(52, 211, 153, 0.25);
        color: #34d399;
      }

      .foc-badge-cap {
        background: rgba(248, 113, 113, 0.1);
        border: 1px solid rgba(248, 113, 113, 0.25);
        color: #f87171;
      }

      .foc-badge-unverified {
        background: rgba(251, 191, 36, 0.1);
        border: 1px solid rgba(251, 191, 36, 0.25);
        color: #fbbf24;
      }

      .foc-badge-checking {
        background: rgba(124, 106, 239, 0.08);
        border: 1px solid rgba(124, 106, 239, 0.2);
        color: #7c6aef;
      }

      /* ── Claim cards ── */
      .foc-claims {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .foc-card {
        background: #1a1d27;
        border: 1px solid #2a2e3b;
        border-radius: 10px;
        padding: 14px 16px;
        cursor: pointer;
        transition: border-color 0.2s, background 0.2s, transform 0.15s;
      }

      .foc-card:hover {
        transform: translateY(-1px);
      }

      .foc-card-active {
        outline: 2px solid rgba(124, 106, 239, 0.5);
        outline-offset: -1px;
      }

      .foc-card-fact {
        border-color: rgba(52, 211, 153, 0.25);
        background: rgba(52, 211, 153, 0.06);
      }

      .foc-card-fact.foc-card-active {
        outline-color: rgba(52, 211, 153, 0.5);
      }

      .foc-card-cap {
        border-color: rgba(248, 113, 113, 0.25);
        background: rgba(248, 113, 113, 0.06);
      }

      .foc-card-cap.foc-card-active {
        outline-color: rgba(248, 113, 113, 0.5);
      }

      .foc-card-unverified {
        border-color: rgba(251, 191, 36, 0.25);
        background: rgba(251, 191, 36, 0.04);
      }

      .foc-card-unverified.foc-card-active {
        outline-color: rgba(251, 191, 36, 0.5);
      }

      .foc-card-checking {
        border-color: rgba(124, 106, 239, 0.2);
        background: rgba(124, 106, 239, 0.04);
      }

      .foc-card-top {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }

      .foc-verdict {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 3px 10px;
        border-radius: 20px;
      }

      .foc-verdict-fact {
        color: #34d399;
        background: rgba(52, 211, 153, 0.12);
        border: 1px solid rgba(52, 211, 153, 0.3);
      }

      .foc-verdict-cap {
        color: #f87171;
        background: rgba(248, 113, 113, 0.12);
        border: 1px solid rgba(248, 113, 113, 0.3);
      }

      .foc-verdict-unverified {
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.1);
        border: 1px solid rgba(251, 191, 36, 0.25);
      }

      .foc-verdict-checking {
        color: #7c6aef;
        background: rgba(124, 106, 239, 0.1);
        border: 1px solid rgba(124, 106, 239, 0.25);
      }

      .foc-rating {
        font-size: 11px;
        color: #8b8fa3;
        font-style: italic;
      }

      .foc-card-text {
        font-size: 13px;
        line-height: 1.6;
        color: #e4e6ed;
        margin: 0;
      }

      .foc-card-explanation {
        font-size: 12px;
        line-height: 1.5;
        color: #8b8fa3;
        margin: 10px 0 0;
        padding-top: 10px;
        border-top: 1px solid #2a2e3b;
      }

      .foc-source-link {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin-top: 8px;
        font-size: 11px;
        font-weight: 600;
        color: #7c6aef;
        text-decoration: none;
        transition: color 0.15s;
      }

      .foc-source-link:hover {
        color: #a594ff;
        text-decoration: underline;
      }
    `;
  }
})();
