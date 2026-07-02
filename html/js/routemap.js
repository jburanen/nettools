/**
 * routemap.js — multi-vendor route-map builder.
 *
 * Builds a list of route-map entries (sequence, permit/deny, match/set
 * clauses) and renders them as Check Point Gaia, Cisco IOS, or
 * Brocade/Ruckus/ICX config. Brocade/ICX shares Cisco's route-map grammar,
 * so both use the same renderer.
 *
 * An optional paste-in panel scans an existing route-map (any of the three
 * vendor syntaxes) for sequence numbers already in use, so new entries can
 * avoid colliding with them and the "suggest next" helper stays gap-aware.
 */

'use strict';

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────

const rmNameInput = $('rmName');

const pasteText = $('pasteText');
const pasteInfo = $('pasteInfo');

const entryTableBody = $('entryTableBody');
const entryEmpty     = $('entryEmpty');

const entrySeqInput   = $('entrySeq');
const entrySeqMsg     = 'entrySeqMsg';
const suggestSeqLink  = $('suggestSeq');
const entryActionSel  = $('entryAction');

const mPrefixList   = $('entryMatchPrefixList');
const mNextHopList  = $('entryMatchNextHopList');
const mTag          = $('entryMatchTag');
const mCommunity    = $('entryMatchCommunity');
const mCommunityEx  = $('entryMatchCommunityExact');
const mAsPath       = $('entryMatchAsPath');
const mInterface    = $('entryMatchInterface');

const sMetric        = $('entrySetMetric');
const sLocalPref     = $('entrySetLocalPref');
const sCommunity     = $('entrySetCommunity');
const sCommunityAdd  = $('entrySetCommunityAdditive');
const sAsPathPrepend = $('entrySetAsPathPrepend');
const sNextHop       = $('entrySetNextHop');
const sTag           = $('entrySetTag');
const sWeight        = $('entrySetWeight');
const sOrigin        = $('entrySetOrigin');

const addEntryBtn    = $('addEntryBtn');
const cancelEditBtn  = $('cancelEditBtn');

const vendorTabs   = Array.from(document.querySelectorAll('.vendor-tab'));
const outputPre    = $('rmOutput');
const copyBtn      = $('copyBtn');
const copyFeedback = $('copyFeedback');
const autoCopyNote = $('autoCopyNote');
const rmNameMsg    = 'rmNameMsg';

// ── State ─────────────────────────────────────────────────────

let entries = [];
let nextId = 1;
let editingId = null;
let activeVendor = 'gaia'; // 'gaia' | 'cisco' | 'brocade'

// ── Field message display (shared pattern with other builders) ──

function setFieldMsg(inputEl, msgId, result) {
  const msgEl = $(msgId);
  if (!msgEl) return;
  if (!result.valid) {
    inputEl.classList.add('error');
    msgEl.textContent = `⚠ ${result.error}`;
    msgEl.className = 'field-msg error';
  } else if (result.warning) {
    inputEl.classList.remove('error');
    msgEl.textContent = `→ ${result.warning}`;
    msgEl.className = 'field-msg warning';
  } else {
    inputEl.classList.remove('error');
    msgEl.textContent = '';
    msgEl.className = 'field-msg';
  }
}

// ── Field-level validators ───────────────────────────────────

function parseRouteMapName(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: false, error: 'Route-map name is required to generate output' };
  if (/\s/.test(s)) return { valid: false, error: 'Route-map name cannot contain spaces' };
  return { valid: true, value: s };
}

function parseSeqInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: false, error: 'Sequence number is required' };
  if (!/^\d+$/.test(s)) return { valid: false, error: 'Sequence must be a positive integer' };
  const n = parseInt(s, 10);
  if (n < 1 || n > 65535) return { valid: false, error: 'Sequence must be 1–65535' };
  return { valid: true, value: n };
}

function parseListName(raw, label) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: '' };
  if (/\s/.test(s)) return { valid: false, error: `${label} cannot contain spaces` };
  return { valid: true, value: s };
}

function parseOptionalInt(raw, label, min, max) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: '' };
  if (!/^\d+$/.test(s)) return { valid: false, error: `${label} must be a positive integer` };
  const n = parseInt(s, 10);
  if (n < min || n > max) return { valid: false, error: `${label} must be ${min}–${max}` };
  return { valid: true, value: String(n) };
}

const COMMUNITY_KEYWORDS = ['no-export', 'no-advertise', 'local-as', 'internet', 'graceful-shutdown'];

function parseCommunityValue(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: '' };
  const tokens = s.split(/\s+/);
  for (const t of tokens) {
    if (COMMUNITY_KEYWORDS.includes(t.toLowerCase())) continue;
    if (/^\d{1,10}:\d{1,5}$/.test(t)) continue;
    return { valid: false, error: `"${t}" is not a valid community — use ASN:NN or a well-known keyword` };
  }
  return { valid: true, value: tokens.join(' ') };
}

function parseAsPathPrepend(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: '' };
  const tokens = s.split(/\s+/);
  for (const t of tokens) {
    if (!/^\d{1,10}$/.test(t)) return { valid: false, error: `"${t}" is not a valid AS number` };
    const n = Number(t);
    if (n < 1 || n > 4294967295) return { valid: false, error: `AS number ${t} out of range (1–4294967295)` };
  }
  return { valid: true, value: tokens.join(' ') };
}

function parseIpv4Host(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: '' };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return { valid: false, error: 'Enter a valid IPv4 address' };
  const octets = s.split('.').map(Number);
  if (octets.some(o => o < 0 || o > 255)) return { valid: false, error: 'IP octet out of range (0–255)' };
  return { valid: true, value: s };
}

// ── Pasted route-map scanning ─────────────────────────────────

// Matches both Cisco/Brocade ("route-map NAME permit|deny SEQ") and Gaia
// ("set route-map NAME permit|deny SEQ ...") entry lines.
const IOS_SEQ_RE  = /^\s*route-map\s+(\S+)\s+(permit|deny)\s+(\d+)/gim;
const GAIA_SEQ_RE = /^\s*set\s+route-map\s+(\S+)\s+(permit|deny)\s+(\d+)/gim;

function parsePastedSeqs(text) {
  const found = [];
  const seen = new Set();
  for (const re of [IOS_SEQ_RE, GAIA_SEQ_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      const action = m[2].toLowerCase();
      const seq = parseInt(m[3], 10);
      const key = `${name.toLowerCase()}|${seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name, action, seq });
    }
  }
  return found;
}

// Seq numbers from the paste that apply to the current route-map name.
// If no name is set yet, treat every parsed seq as relevant (conservative).
function relevantPastedSeqs() {
  const parsed = parsePastedSeqs(pasteText.value);
  const nameR = parseRouteMapName(rmNameInput.value);
  if (!nameR.valid) return parsed;
  const wanted = nameR.value.toLowerCase();
  return parsed.filter(p => p.name.toLowerCase() === wanted);
}

// All sequence numbers currently in use — pasted + entries already added
// (excluding the entry currently being edited).
function usedSeqs(excludeId) {
  const fromPaste   = relevantPastedSeqs().map(p => p.seq);
  const fromEntries = entries.filter(e => e.id !== excludeId).map(e => e.seq);
  return new Set([...fromPaste, ...fromEntries]);
}

function suggestNextSeq(excludeId) {
  const used = usedSeqs(excludeId);
  if (!used.size) return 10;
  return Math.max(...used) + 10;
}

function updatePasteInfo() {
  const parsed = parsePastedSeqs(pasteText.value);
  if (!pasteText.value.trim()) {
    pasteInfo.textContent = '';
    return;
  }
  if (!parsed.length) {
    pasteInfo.textContent = 'No route-map sequence numbers recognized in the pasted text.';
    return;
  }
  const nameR = parseRouteMapName(rmNameInput.value);
  if (!nameR.valid) {
    const byName = {};
    parsed.forEach(p => { (byName[p.name] = byName[p.name] || []).push(p.seq); });
    const summary = Object.entries(byName)
      .map(([n, seqs]) => `${n} (${seqs.sort((a, b) => a - b).join(', ')})`)
      .join('; ');
    pasteInfo.textContent = `Found: ${summary} — enter a route-map name above to check for collisions.`;
    return;
  }
  const relevant = relevantPastedSeqs().map(p => p.seq).sort((a, b) => a - b);
  if (!relevant.length) {
    pasteInfo.textContent = `No entries for "${nameR.value}" found in the pasted text — new sequence numbers are unconstrained.`;
    return;
  }
  const collidesWithEntries = entries.filter(e => relevant.includes(e.seq));
  let msg = `Existing sequence numbers for "${nameR.value}": ${relevant.join(', ')}.`;
  if (collidesWithEntries.length) {
    msg += ` ⚠ collides with entry already added: ${collidesWithEntries.map(e => e.seq).join(', ')}`;
  }
  pasteInfo.textContent = msg;
}

// ── Entry form read/validate ─────────────────────────────────

function readEntryForm() {
  const seqR = parseSeqInput(entrySeqInput.value);
  if (seqR.valid && usedSeqs(editingId).has(seqR.value)) {
    seqR.valid = false;
    seqR.error = `Sequence ${seqR.value} is already in use — try ${suggestNextSeq(editingId)}`;
  }
  setFieldMsg(entrySeqInput, entrySeqMsg, seqR);

  const mPrefixListR  = parseListName(mPrefixList.value, 'Prefix-list');
  const mNextHopListR = parseListName(mNextHopList.value, 'Next-hop prefix-list');
  const mTagR         = parseOptionalInt(mTag.value, 'Match tag', 0, 4294967295);
  const mCommunityR   = parseListName(mCommunity.value, 'Community-list');
  const mAsPathR      = parseListName(mAsPath.value, 'AS-path list');
  const mInterfaceR   = parseListName(mInterface.value, 'Interface');

  const sMetricR        = parseOptionalInt(sMetric.value, 'Metric', 0, 4294967295);
  const sLocalPrefR     = parseOptionalInt(sLocalPref.value, 'Local preference', 0, 4294967295);
  const sCommunityR     = parseCommunityValue(sCommunity.value);
  const sAsPathPrependR = parseAsPathPrepend(sAsPathPrepend.value);
  const sNextHopR       = parseIpv4Host(sNextHop.value);
  const sTagR           = parseOptionalInt(sTag.value, 'Set tag', 0, 4294967295);
  const sWeightR        = parseOptionalInt(sWeight.value, 'Weight', 0, 65535);

  setFieldMsg(mPrefixList,  'entryMatchPrefixListMsg',  mPrefixListR);
  setFieldMsg(mNextHopList, 'entryMatchNextHopListMsg', mNextHopListR);
  setFieldMsg(mTag,         'entryMatchTagMsg',         mTagR);
  setFieldMsg(mCommunity,   'entryMatchCommunityMsg',   mCommunityR);
  setFieldMsg(mAsPath,      'entryMatchAsPathMsg',      mAsPathR);
  setFieldMsg(mInterface,   'entryMatchInterfaceMsg',   mInterfaceR);

  setFieldMsg(sMetric,        'entrySetMetricMsg',        sMetricR);
  setFieldMsg(sLocalPref,     'entrySetLocalPrefMsg',     sLocalPrefR);
  setFieldMsg(sCommunity,     'entrySetCommunityMsg',     sCommunityR);
  setFieldMsg(sAsPathPrepend, 'entrySetAsPathPrependMsg', sAsPathPrependR);
  setFieldMsg(sNextHop,       'entrySetNextHopMsg',       sNextHopR);
  setFieldMsg(sTag,           'entrySetTagMsg',           sTagR);
  setFieldMsg(sWeight,        'entrySetWeightMsg',        sWeightR);

  const results = [
    seqR, mPrefixListR, mNextHopListR, mTagR, mCommunityR, mAsPathR, mInterfaceR,
    sMetricR, sLocalPrefR, sCommunityR, sAsPathPrependR, sNextHopR, sTagR, sWeightR,
  ];
  const valid = results.every(r => r.valid);

  const entry = {
    seq: seqR.valid ? seqR.value : null,
    action: entryActionSel.value,
    match: {
      prefixList:  mPrefixListR.value,
      nextHopList: mNextHopListR.value,
      tag:         mTagR.value,
      community:   mCommunityR.value,
      communityExact: mCommunityEx.checked,
      asPath:      mAsPathR.value,
      interface:   mInterfaceR.value,
    },
    set: {
      metric:        sMetricR.value,
      localPref:     sLocalPrefR.value,
      community:     sCommunityR.value,
      communityAdditive: sCommunityAdd.checked,
      asPathPrepend: sAsPathPrependR.value,
      nextHop:       sNextHopR.value,
      tag:           sTagR.value,
      weight:        sWeightR.value,
      origin:        sOrigin.value,
    },
  };

  return { valid, entry };
}

function resetEntryForm() {
  entrySeqInput.value = String(suggestNextSeq(null));
  entryActionSel.value = 'permit';
  [mPrefixList, mNextHopList, mTag, mCommunity, mAsPath, mInterface].forEach(el => { el.value = ''; });
  mCommunityEx.checked = false;
  [sMetric, sLocalPref, sCommunity, sAsPathPrepend, sNextHop, sTag, sWeight].forEach(el => { el.value = ''; });
  sCommunityAdd.checked = false;
  sOrigin.value = '';
  editingId = null;
  addEntryBtn.textContent = 'Add Entry';
  cancelEditBtn.hidden = true;

  // Clear stale validation state
  const allFields = [
    entrySeqInput, mPrefixList, mNextHopList, mTag, mCommunity, mAsPath, mInterface,
    sMetric, sLocalPref, sCommunity, sAsPathPrepend, sNextHop, sTag, sWeight,
  ];
  allFields.forEach(el => el.classList.remove('error'));
}

// ── Summaries for the entry list ─────────────────────────────

function summarizeMatch(m) {
  const parts = [];
  if (m.prefixList)  parts.push(`prefix-list ${m.prefixList}`);
  if (m.nextHopList) parts.push(`next-hop ${m.nextHopList}`);
  if (m.tag)         parts.push(`tag ${m.tag}`);
  if (m.community)   parts.push(`community ${m.community}${m.communityExact ? ' (exact)' : ''}`);
  if (m.asPath)      parts.push(`as-path ${m.asPath}`);
  if (m.interface)   parts.push(`if ${m.interface}`);
  return parts.length ? parts.join(', ') : '—';
}

function summarizeSet(s) {
  const parts = [];
  if (s.metric)        parts.push(`metric ${s.metric}`);
  if (s.localPref)     parts.push(`local-pref ${s.localPref}`);
  if (s.community)     parts.push(`community ${s.community}${s.communityAdditive ? ' +' : ''}`);
  if (s.asPathPrepend) parts.push(`prepend ${s.asPathPrepend}`);
  if (s.nextHop)       parts.push(`next-hop ${s.nextHop}`);
  if (s.tag)           parts.push(`tag ${s.tag}`);
  if (s.weight)        parts.push(`weight ${s.weight}`);
  if (s.origin)        parts.push(`origin ${s.origin}`);
  return parts.length ? parts.join(', ') : '—';
}

// ── Vendor renderers ──────────────────────────────────────────

// Cisco IOS and Brocade/Ruckus/ICX (FastIron) share the same route-map grammar.
function renderIosLike(name, list) {
  if (!list.length) return null;
  const blocks = list.map(e => {
    const lines = [`route-map ${name} ${e.action} ${e.seq}`];
    const m = e.match, s = e.set;
    if (m.prefixList)  lines.push(` match ip address prefix-list ${m.prefixList}`);
    if (m.nextHopList) lines.push(` match ip next-hop prefix-list ${m.nextHopList}`);
    if (m.tag)         lines.push(` match tag ${m.tag}`);
    if (m.community)   lines.push(` match community ${m.community}${m.communityExact ? ' exact-match' : ''}`);
    if (m.asPath)      lines.push(` match as-path ${m.asPath}`);
    if (m.interface)   lines.push(` match interface ${m.interface}`);
    if (s.metric)        lines.push(` set metric ${s.metric}`);
    if (s.localPref)     lines.push(` set local-preference ${s.localPref}`);
    if (s.community)     lines.push(` set community ${s.community}${s.communityAdditive ? ' additive' : ''}`);
    if (s.asPathPrepend) lines.push(` set as-path prepend ${s.asPathPrepend}`);
    if (s.nextHop)       lines.push(` set ip next-hop ${s.nextHop}`);
    if (s.tag)           lines.push(` set tag ${s.tag}`);
    if (s.weight)        lines.push(` set weight ${s.weight}`);
    if (s.origin)        lines.push(` set origin ${s.origin}`);
    return lines.join('\n');
  });
  return blocks.join('\n!\n');
}

function renderGaia(name, list) {
  if (!list.length) return null;
  const blocks = list.map(e => {
    const p = `set route-map ${name} ${e.action} ${e.seq}`;
    const lines = [p];
    const m = e.match, s = e.set;
    if (m.prefixList)  lines.push(`${p} match ip-address-list ${m.prefixList}`);
    if (m.nextHopList) lines.push(`${p} match ip-next-hop-list ${m.nextHopList}`);
    if (m.tag)         lines.push(`${p} match tag ${m.tag}`);
    if (m.community)   lines.push(`${p} match community-list ${m.community}`);
    if (m.asPath)      lines.push(`${p} match as-path-list ${m.asPath}`);
    if (m.interface)   lines.push(`${p} match interface ${m.interface}`);
    if (s.metric)        lines.push(`${p} set metric ${s.metric}`);
    if (s.localPref)     lines.push(`${p} set local-preference ${s.localPref}`);
    if (s.community)     lines.push(`${p} set community ${s.community}${s.communityAdditive ? ' additive' : ''}`);
    if (s.asPathPrepend) lines.push(`${p} set as-path-prepend "${s.asPathPrepend}"`);
    if (s.nextHop)       lines.push(`${p} set next-hop ${s.nextHop}`);
    if (s.tag)           lines.push(`${p} set tag ${s.tag}`);
    if (s.weight)        lines.push(`${p} set weight ${s.weight}`);
    if (s.origin)        lines.push(`${p} set origin ${s.origin}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

const VENDOR_RENDERERS = {
  gaia:    renderGaia,
  cisco:   renderIosLike,
  brocade: renderIosLike,
};

// ── Entry list rendering ─────────────────────────────────────

function renderEntryList() {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  entryTableBody.innerHTML = '';
  entryEmpty.hidden = sorted.length > 0;

  sorted.forEach(e => {
    const tr = document.createElement('tr');

    const seqTd = document.createElement('td');
    seqTd.className = 'mono-cell';
    seqTd.textContent = e.seq;
    tr.appendChild(seqTd);

    const actionTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `rm-action-badge ${e.action}`;
    badge.textContent = e.action;
    actionTd.appendChild(badge);
    tr.appendChild(actionTd);

    const matchTd = document.createElement('td');
    matchTd.className = 'rm-summary-cell';
    matchTd.textContent = summarizeMatch(e.match);
    tr.appendChild(matchTd);

    const setTd = document.createElement('td');
    setTd.className = 'rm-summary-cell';
    setTd.textContent = summarizeSet(e.set);
    tr.appendChild(setTd);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'rm-summary-cell';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'rm-row-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'rm-row-btn';
    editBtn.textContent = 'edit';
    editBtn.addEventListener('click', () => loadEntryIntoForm(e.id));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'rm-row-btn rm-remove';
    removeBtn.textContent = 'remove';
    removeBtn.addEventListener('click', () => removeEntry(e.id));

    actionsWrap.appendChild(editBtn);
    actionsWrap.appendChild(removeBtn);
    actionsTd.appendChild(actionsWrap);
    tr.appendChild(actionsTd);

    entryTableBody.appendChild(tr);
  });
}

function loadEntryIntoForm(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  editingId = id;
  entrySeqInput.value = String(e.seq);
  entryActionSel.value = e.action;
  mPrefixList.value  = e.match.prefixList;
  mNextHopList.value = e.match.nextHopList;
  mTag.value         = e.match.tag;
  mCommunity.value   = e.match.community;
  mCommunityEx.checked = e.match.communityExact;
  mAsPath.value       = e.match.asPath;
  mInterface.value    = e.match.interface;
  sMetric.value        = e.set.metric;
  sLocalPref.value     = e.set.localPref;
  sCommunity.value     = e.set.community;
  sCommunityAdd.checked = e.set.communityAdditive;
  sAsPathPrepend.value = e.set.asPathPrepend;
  sNextHop.value       = e.set.nextHop;
  sTag.value           = e.set.tag;
  sWeight.value        = e.set.weight;
  sOrigin.value         = e.set.origin;

  addEntryBtn.textContent = 'Update Entry';
  cancelEditBtn.hidden = false;
  updateAll();
  entrySeqInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeEntry(id) {
  entries = entries.filter(e => e.id !== id);
  if (editingId === id) resetEntryForm();
  updateAll();
}

// ── Output rendering ─────────────────────────────────────────

let copyTimer = null;

function updateOutput() {
  const nameR = parseRouteMapName(rmNameInput.value);
  setFieldMsg(rmNameInput, rmNameMsg, nameR);

  const hasErrors = !nameR.valid || entries.length === 0;
  let text = null;
  if (nameR.valid && entries.length) {
    text = VENDOR_RENDERERS[activeVendor](nameR.value, [...entries].sort((a, b) => a.seq - b.seq));
  }

  if (text) {
    outputPre.textContent = text;
    outputPre.classList.remove('rm-output-empty');
  } else {
    outputPre.textContent = !nameR.valid
      ? 'Enter a route-map name above to generate output.'
      : 'Add at least one entry below to generate output.';
    outputPre.classList.add('rm-output-empty');
  }

  copyBtn.disabled = hasErrors;
  outputPre.classList.toggle('has-errors', hasErrors);

  clearTimeout(copyTimer);
  if (hasErrors) {
    autoCopyNote.textContent = '';
  } else {
    copyTimer = setTimeout(() => {
      navigator.clipboard.writeText(text).then(() => {
        autoCopyNote.textContent = '⎘ auto-copied';
        setTimeout(() => { autoCopyNote.textContent = ''; }, 2000);
      }).catch(() => {});
    }, 750);
  }
}

function updateAll() {
  updatePasteInfo();
  renderEntryList();
  updateOutput();
  suggestSeqLink.textContent = `use suggested (${suggestNextSeq(editingId)})`;
}

// ── Manual copy ───────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  clearTimeout(copyTimer);
  autoCopyNote.textContent = '';

  navigator.clipboard.writeText(outputPre.textContent).then(() => {
    copyFeedback.textContent = 'copied!';
    copyFeedback.classList.add('copied');
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyFeedback.textContent = '';
      copyFeedback.classList.remove('copied');
      copyBtn.textContent = 'Copy Command';
    }, 1500);
  }).catch(() => {
    copyFeedback.textContent = 'copy failed — select manually';
  });
});

// ── Vendor tab wiring ─────────────────────────────────────────

vendorTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeVendor = tab.dataset.vendor;
    vendorTabs.forEach(t => t.classList.toggle('active', t === tab));
    updateOutput();
  });
});

// ── Add / update / cancel entry ──────────────────────────────

addEntryBtn.addEventListener('click', () => {
  const { valid, entry } = readEntryForm();
  if (!valid) return;

  if (editingId != null) {
    const idx = entries.findIndex(e => e.id === editingId);
    if (idx !== -1) entries[idx] = { ...entry, id: editingId };
  } else {
    entries.push({ ...entry, id: nextId++ });
  }

  resetEntryForm();
  updateAll();
});

cancelEditBtn.addEventListener('click', () => {
  resetEntryForm();
  updateAll();
});

suggestSeqLink.addEventListener('click', () => {
  entrySeqInput.value = String(suggestNextSeq(editingId));
  readEntryForm();
});

// ── Live validation while typing ─────────────────────────────

const entryFormInputs = [
  entrySeqInput, entryActionSel,
  mPrefixList, mNextHopList, mTag, mCommunity, mCommunityEx, mAsPath, mInterface,
  sMetric, sLocalPref, sCommunity, sCommunityAdd, sAsPathPrepend, sNextHop, sTag, sWeight, sOrigin,
];
entryFormInputs.forEach(el => {
  el.addEventListener('input', readEntryForm);
  el.addEventListener('change', readEntryForm);
});

rmNameInput.addEventListener('input', updateAll);
pasteText.addEventListener('input', updateAll);

// ── Initial render ────────────────────────────────────────────

resetEntryForm();
updateAll();
