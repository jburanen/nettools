/**
 * app.js — SYNtax UI controller
 * Wires DOM interactions to the Subnet library.
 * All computation is local; no network requests.
 */

'use strict';

// ── DOM references ────────────────────────────────────────────

const $ = id => document.getElementById(id);

const subnetInput  = $('subnetInput');
const calcBtn      = $('calcBtn');
const errorBox     = $('errorBox');
const resultsPanel = $('resultsPanel');
const resultGrid   = $('resultGrid');
const splitPanel   = $('splitPanel');
const splitPrefix  = $('splitPrefix');
const splitBtn     = $('splitBtn');
const subnetsTable = $('subnetsTable');
let currentResult = null;

// ── Hint values ───────────────────────────────────────────────

document.querySelectorAll('.hint-val').forEach(el => {
  el.addEventListener('click', () => {
    subnetInput.value = el.dataset.val;
    runCalculation();
  });
});

// ── Keyboard shortcut ─────────────────────────────────────────

subnetInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runCalculation();
});

calcBtn.addEventListener('click', runCalculation);

// ── Main calculation flow ─────────────────────────────────────

function runCalculation() {
  clearError();
  splitPanel.style.display = 'none';

  const raw = subnetInput.value.trim();

  if (!raw) {
    showError('Enter an IP address, CIDR notation, or IP and subnet mask.');
    return;
  }

  try {
    let result;

    if (raw.includes('/')) {
      // CIDR notation: 192.168.1.0/24
      result = Subnet.calculate(raw);
    } else if (raw.includes(' ')) {
      // Space-delimited IP + mask: 192.168.1.0 255.255.255.0
      const parts = raw.split(/\s+/);
      if (parts.length !== 2) {
        showError('Enter CIDR (e.g. 10.0.0.0/8) or an IP and mask separated by a space.');
        return;
      }
      result = Subnet.calculate(parts[0], parts[1]);
    } else {
      // Bare IP — treat as /32 host
      result = Subnet.calculate(raw + '/32');
    }

    currentResult = result;
    renderResults(result);
    resultsPanel.style.display = '';
    splitPanel.style.display   = '';
    splitPrefix.value = Math.min(result.prefix + 1, 30);

  } catch (err) {
    showError(err.message);
    resultsPanel.style.display = 'none';
    splitPanel.style.display   = 'none';
  }
}

// ── Render result cards ───────────────────────────────────────

function renderResults(r) {
  const cards = [
    { label: 'Network Address', value: r.network,    cls: 'cyan',  highlight: true },
    { label: 'Subnet Mask',     value: r.subnetMask                               },
    { label: 'Broadcast',       value: r.broadcast,  cls: 'red'   },
    { label: 'First Usable',    value: r.hostMin                                  },
    { label: 'Last Usable',     value: r.hostMax                                  },
    { label: 'Usable Hosts',    value: Subnet.commas(r.usableHosts), cls: 'green', highlight: true },
    { label: 'Wildcard Mask',   value: r.wildcard                                 },
    { label: 'RFC Scope',       value: r.rfc,        cls: r.rfc.includes('private') ? 'amber' : '' },
  ];

  resultGrid.innerHTML = '';
  cards.forEach(c => {
    const card = document.createElement('div');
    card.className = 'result-card' + (c.highlight ? ' highlight' : '');
    card.innerHTML = `
      <button class="copy-btn" title="Copy">copy</button>
      <div class="result-label">${c.label}</div>
      <div class="result-value${c.cls ? ' ' + c.cls : ''}">${escHtml(c.value)}</div>
    `;

    const copyBtn = card.querySelector('.copy-btn');
    card.addEventListener('click', () => {
      navigator.clipboard.writeText(c.value).then(() => {
        copyBtn.textContent = 'copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'copy';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    });

    resultGrid.appendChild(card);
  });

  // Binary breakdown card (full width)
  const binCard = document.createElement('div');
  binCard.className = 'result-card';
  binCard.style.gridColumn = '1 / -1';
  binCard.innerHTML = `
    <div class="result-label">Binary Breakdown</div>
    <div style="display:grid;gap:6px;margin-top:4px;font-size:0.76rem;line-height:1.7">
      <div><span style="color:var(--text-muted);display:inline-block;width:120px">IP Address</span>
           <span style="color:var(--text-primary)">${escHtml(r.ipBin)}</span></div>
      <div><span style="color:var(--text-muted);display:inline-block;width:120px">Subnet Mask</span>
           <span style="color:var(--cyan)">${escHtml(r.maskBin)}</span></div>
      <div><span style="color:var(--text-muted);display:inline-block;width:120px">Network</span>
           <span style="color:var(--amber)">${escHtml(r.networkBin)}</span></div>
    </div>
  `;
  resultGrid.appendChild(binCard);
}

// ── Subnet split ──────────────────────────────────────────────

splitBtn.addEventListener('click', () => {
  if (!currentResult) return;
  clearError();

  const newPrefix = parseInt(splitPrefix.value, 10);
  if (isNaN(newPrefix)) {
    showError('Enter a valid prefix length to split.');
    return;
  }

  try {
    const { subnets, total, truncated } = Subnet.split(currentResult.cidr, newPrefix, 256);
    renderSubnetsTable(subnets, total, truncated, newPrefix);
  } catch (err) {
    showError(err.message);
  }
});

function renderSubnetsTable(subnets, total, truncated, newPrefix) {
  const cols = ['#', 'Network', 'First Host', 'Last Host', 'Broadcast', 'Hosts'];

  let html = `<table class="subnets-table">
    <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>`;

  subnets.forEach((s, i) => {
    html += `<tr>
      <td class="dim">${i + 1}</td>
      <td class="mono-cell">${escHtml(s.cidr)}</td>
      <td class="mono-cell">${escHtml(s.hostMin)}</td>
      <td class="mono-cell">${escHtml(s.hostMax)}</td>
      <td class="mono-cell">${escHtml(s.broadcast)}</td>
      <td class="dim">${Subnet.commas(s.usableHosts)}</td>
    </tr>`;
  });

  html += '</tbody></table>';

  if (truncated) {
    html += `<p class="table-overflow-note">
      Showing first 256 of ${Subnet.commas(total)} /${newPrefix} subnets.
    </p>`;
  }

  subnetsTable.innerHTML = html;
}

// ── Utilities ─────────────────────────────────────────────────

function showError(msg) {
  errorBox.textContent = `⚠ ${msg}`;
  errorBox.style.display = '';
  subnetInput.classList.add('error');
}

function clearError() {
  errorBox.style.display = 'none';
  errorBox.textContent = '';
  subnetInput.classList.remove('error');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-calculate on load if URL has query ───────────────────

(() => {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  if (q) {
    subnetInput.value = decodeURIComponent(q);
    runCalculation();
  }
})();
