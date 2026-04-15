const STATES = ['idle', 'scanning', 'results', 'empty', 'error'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showState(name) {
  STATES.forEach((s) => {
    const el = $(`#state-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function setScanningStatus(text) {
  $('#scanning-status').textContent = text;
}

function renderSummary(claims) {
  const facts = claims.filter((c) => c.verdict === 'fact').length;
  const caps = claims.filter((c) => c.verdict === 'cap').length;
  const pending = claims.filter((c) => c.verdict === 'checking').length;

  const container = $('#results-summary');
  container.innerHTML = '';

  const badges = [
    { cls: 'facts', count: facts, label: facts === 1 ? 'Fact' : 'Facts' },
    { cls: 'caps', count: caps, label: caps === 1 ? 'Cap' : 'Caps' }
  ];

  if (pending > 0) {
    badges.push({ cls: 'pending', count: pending, label: 'Checking' });
  }

  badges.forEach(({ cls, count, label }) => {
    const badge = document.createElement('div');
    badge.className = `summary-badge ${cls}`;
    badge.innerHTML = `<span class="count">${count}</span>${label}`;
    container.appendChild(badge);
  });
}

function renderClaims(claims) {
  const list = $('#claims-list');
  list.innerHTML = '';

  claims.forEach((claim, i) => {
    const li = document.createElement('li');
    li.className = `claim-card ${claim.verdict}`;
    li.style.animationDelay = `${i * 0.07}s`;

    const verdictContent =
      claim.verdict === 'checking'
        ? `<span class="spinner"></span> Checking`
        : claim.verdict === 'fact'
          ? `&#10003; Fact`
          : `&#10007; Cap`;

    li.innerHTML = `
      <div class="claim-header">
        <span class="claim-verdict ${claim.verdict}">${verdictContent}</span>
      </div>
      <p class="claim-text">${escapeHtml(claim.text)}</p>
    `;
    list.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function startScan() {
  showState('scanning');
  setScanningStatus('Extracting text from the page');

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) throw new Error('No active tab found');

    setScanningStatus('Extracting claims from the page');

    const response = await chrome.runtime.sendMessage({
      action: 'scanPage',
      tabId: tab.id
    });

    if (response.error) throw new Error(response.error);

    const claims = response.claims || [];

    if (claims.length === 0) {
      showState('empty');
      return;
    }

    showState('results');
    renderSummary(claims);
    renderClaims(claims);
  } catch (err) {
    console.error('Scan failed:', err);
    $('#error-message').textContent = err.message || 'Something went wrong.';
    showState('error');
  }
}

$('#btn-scan').addEventListener('click', startScan);
$('#btn-rescan').addEventListener('click', startScan);
$('#btn-rescan-empty').addEventListener('click', startScan);
$('#btn-retry').addEventListener('click', startScan);
