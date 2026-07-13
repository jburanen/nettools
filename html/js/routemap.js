/**
 * routemap.js — multi-vendor route-map builder.
 *
 * Builds a list of route-map entries (sequence, permit/deny, match/set
 * clauses) and renders them as Check Point Gaia, Cisco IOS, or
 * Brocade/Ruckus/ICX config. Brocade/ICX shares Cisco's route-map grammar,
 * so both use the same renderer.
 *
 * Gaia's route-map grammar is structurally different from Cisco's, per
 * Check Point's Gaia Advanced Routing Admin Guide:
 *   set routemap <name> id <seq> {on|off}
 *   set routemap <name> id <seq> {allow|restrict}
 *   set routemap <name> id <seq> match network <cidr> {all|exact|between|refines}
 *   set routemap <name> id <seq> match protocol <proto>
 *   set routemap <name> id <seq> action metric value <n>
 *   ...
 * Networks are matched inline (no prefix-list object required); Cisco and
 * Brocade/ICX can only match a CIDR via a named prefix-list, so entering
 * CIDRs in the Networks field auto-generates an `ip prefix-list` block for
 * those two vendors.
 *
 * An optional paste-in panel imports an existing route-map (Gaia or
 * Cisco/Brocade/ICX syntax) into the entries table: each pasted entry becomes
 * an "existing" entry that can be modified or deleted. The generated output
 * is a change script — unchanged existing entries are omitted, modified ones
 * are deleted and re-created (so removed clauses don't linger on the device),
 * and deleted ones emit the vendor's delete/no command. The paste also learns
 * the route-map name when the name field is still empty, and flags
 * unrecognized or multi-route-map paste input as an error.
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
const entryActionSel  = $('entryAction');
const entryEnabled    = $('entryEnabled');

const mNetworks      = $('entryMatchNetworks');
const mNetworkMode   = $('entryMatchNetworkMode');
const mProtocol      = $('entryMatchProtocol');
const mPrefixList    = $('entryMatchPrefixList');
const mNextHopList   = $('entryMatchNextHopList');
const mTag           = $('entryMatchTag');
const mCommunity     = $('entryMatchCommunity');
const mCommunityEx   = $('entryMatchCommunityExact');
const mAsPath        = $('entryMatchAsPath');
const mInterface     = $('entryMatchInterface');

const sMetric        = $('entrySetMetric');
const sLocalPref     = $('entrySetLocalPref');
const sCommunity     = $('entrySetCommunity');
const sCommunityAdd  = $('entrySetCommunityAdditive');
const sAsPathPrepend = $('entrySetAsPathPrepend');
const sNextHop       = $('entrySetNextHop');
const sTag           = $('entrySetTag');
const sWeight        = $('entrySetWeight');
const sOrigin        = $('entrySetOrigin');

const advMatchSection = $('advMatchSection');
const advSetSection   = $('advSetSection');
const advMatchCount   = $('advMatchCount');
const advSetCount     = $('advSetCount');

const advMatchFields = [mPrefixList, mNextHopList, mTag, mCommunity, mCommunityEx, mAsPath, mInterface];
const advSetFields   = [sMetric, sLocalPref, sCommunity, sCommunityAdd, sAsPathPrepend, sNextHop, sTag, sWeight, sOrigin];

const addEntryBtn    = $('addEntryBtn');
const cancelEditBtn  = $('cancelEditBtn');

const vendorTabs   = Array.from(document.querySelectorAll('.vendor-tab'));
const outputPre    = $('rmOutput');
const copyBtn      = $('copyBtn');
const copyFeedback = $('copyFeedback');
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

function isValidCidr(s) {
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)) return false;
  const [ip, prefixStr] = s.split('/');
  const octets = ip.split('.').map(Number);
  if (octets.some(o => o < 0 || o > 255)) return false;
  const prefix = parseInt(prefixStr, 10);
  return prefix >= 0 && prefix <= 32;
}

function parseNetworks(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: [] };
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (!isValidCidr(l)) return { valid: false, error: `"${l}" is not a valid CIDR (e.g. 10.0.0.0/24)` };
  }
  return { valid: true, value: lines };
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

// ── Pasted route-map parsing ──────────────────────────────────

// Gaia: "set routemap NAME id SEQ <clause>"
const GAIA_LINE_RE = /^set\s+routemap\s+(\S+)\s+id\s+(\d+)\s*(.*)$/i;
// Cisco/Brocade/ICX stanza header: "route-map NAME permit|deny SEQ"
const IOS_HEADER_RE = /^route-map\s+(\S+)\s+(permit|deny)\s+(\d+)\s*$/i;

function blankEntryFields() {
  return {
    action: 'permit',
    enabled: true,
    match: {
      networks: [], networkMode: 'all', protocol: '', prefixList: '',
      nextHopList: '', tag: '', community: '', communityExact: false,
      asPath: '', interface: '',
    },
    set: {
      metric: '', localPref: '', community: '', communityAdditive: false,
      asPathPrepend: '', nextHop: '', tag: '', weight: '', origin: '',
    },
  };
}

const truncateLine = s => (s.length > 60 ? s.slice(0, 57) + '…' : s);

function applyGaiaClause(e, rest, warnings) {
  const r = rest.replace(/\s+/g, ' ').trim();
  if (!r) return;
  const rl = r.toLowerCase();
  const seqTag = `id ${e.seq}`;
  let m;
  if (rl === 'on')       { e.enabled = true;  return; }
  if (rl === 'off')      { e.enabled = false; return; }
  if (rl === 'allow')    { e.action = 'permit'; return; }
  if (rl === 'restrict') { e.action = 'deny';   return; }
  if ((m = r.match(/^match network (\S+)(?: (all|exact|between|refines))?$/i))) {
    if (!isValidCidr(m[1])) { warnings.push(`${seqTag}: "${m[1]}" is not a valid CIDR — skipped`); return; }
    e.match.networks.push(m[1]);
    if (m[2]) e.match.networkMode = m[2].toLowerCase();
    return;
  }
  if ((m = r.match(/^match protocol (\S+)$/i)))    { e.match.protocol = m[1]; return; }
  if ((m = r.match(/^match prefix-list (\S+)( preference \d+)?( on| off)?$/i))) { e.match.prefixList = m[1]; return; }
  if ((m = r.match(/^match tag (\d+)$/i)))         { e.match.tag = m[1]; return; }
  if ((m = r.match(/^match interface (\S+)$/i)))   { e.match.interface = m[1]; return; }
  if ((m = r.match(/^action metric value (\d+)$/i))) { e.set.metric = m[1]; return; }
  if ((m = r.match(/^action localpref (\d+)$/i)))    { e.set.localPref = m[1]; return; }
  if ((m = r.match(/^action nexthop ip (\S+)$/i)))   { e.set.nextHop = m[1]; return; }
  if ((m = r.match(/^action aspath-prepend-count (\d+)$/i))) {
    warnings.push(`${seqTag}: "aspath-prepend-count ${m[1]}" not imported — Gaia stores only a count; enter the AS numbers in the entry's AS-path prepend field`);
    return;
  }
  warnings.push(`${seqTag}: clause not imported: "${truncateLine(r)}"`);
}

function applyIosClause(e, line, warnings) {
  const r = line.replace(/\s+/g, ' ').trim();
  const seqTag = `seq ${e.seq}`;
  let m;
  if ((m = r.match(/^match ip address prefix-list (\S+)( .+)?$/i))) {
    e.match.prefixList = m[1];
    if (m[2]) warnings.push(`${seqTag}: only the first prefix-list name was imported from "${truncateLine(r)}"`);
    return;
  }
  if ((m = r.match(/^match ip next-hop prefix-list (\S+)$/i))) { e.match.nextHopList = m[1]; return; }
  if ((m = r.match(/^match source-protocol (\S+)$/i))) { e.match.protocol = m[1]; return; }
  if ((m = r.match(/^match tag (\d+)( .+)?$/i))) {
    e.match.tag = m[1];
    if (m[2]) warnings.push(`${seqTag}: only the first tag was imported from "${truncateLine(r)}"`);
    return;
  }
  if ((m = r.match(/^match community (.+?)( exact-match)?$/i))) { e.match.community = m[1]; e.match.communityExact = !!m[2]; return; }
  if ((m = r.match(/^match as-path (\S+)$/i)))     { e.match.asPath = m[1]; return; }
  if ((m = r.match(/^match interface (\S+)$/i)))   { e.match.interface = m[1]; return; }
  if ((m = r.match(/^set metric (\d+)$/i)))            { e.set.metric = m[1]; return; }
  if ((m = r.match(/^set local-preference (\d+)$/i)))  { e.set.localPref = m[1]; return; }
  if ((m = r.match(/^set community (.+?)( additive)?$/i))) { e.set.community = m[1]; e.set.communityAdditive = !!m[2]; return; }
  if ((m = r.match(/^set as-path prepend (.+)$/i)))    { e.set.asPathPrepend = m[1]; return; }
  if ((m = r.match(/^set ip next-hop (\S+)$/i)))       { e.set.nextHop = m[1]; return; }
  if ((m = r.match(/^set tag (\d+)$/i)))               { e.set.tag = m[1]; return; }
  if ((m = r.match(/^set weight (\d+)$/i)))            { e.set.weight = m[1]; return; }
  if ((m = r.match(/^set origin (igp|egp|incomplete)$/i))) { e.set.origin = m[1].toLowerCase(); return; }
  warnings.push(`${seqTag}: clause not imported: "${truncateLine(r)}"`);
}

// Parses the pasted text into full entry objects.
// Returns { empty:true } | { ok:false, error } | { ok:true, name, entries, warnings }.
function parsePastedRouteMap(text) {
  if (!text.trim()) return { ok: true, empty: true };

  const warnings = [];
  const maps = new Map(); // lowercased name -> { name, bySeq: Map(seq -> entry) }
  let prefixListNoted = false;
  let curIos = null; // entry receiving Cisco-style match/set continuation lines

  function getEntry(name, seq) {
    const key = name.toLowerCase();
    if (!maps.has(key)) maps.set(key, { name, bySeq: new Map() });
    const map = maps.get(key);
    if (!map.bySeq.has(seq)) map.bySeq.set(seq, { seq, ...blankEntryFields() });
    return map.bySeq.get(seq);
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('!') || line.startsWith('#')) { curIos = null; continue; }

    let m;
    if ((m = line.match(GAIA_LINE_RE))) {
      curIos = null;
      applyGaiaClause(getEntry(m[1], parseInt(m[2], 10)), m[3], warnings);
      continue;
    }
    if ((m = line.match(IOS_HEADER_RE))) {
      const e = getEntry(m[1], parseInt(m[3], 10));
      e.action = m[2].toLowerCase();
      curIos = e;
      continue;
    }
    if (/^ip prefix-list\s/i.test(line)) {
      if (!prefixListNoted) {
        warnings.push('ip prefix-list definitions are not imported — prefix-lists are matched by name only');
        prefixListNoted = true;
      }
      continue;
    }
    if (/^route-map\s/i.test(line)) {
      curIos = null;
      warnings.push(`"${truncateLine(line)}" skipped — route-map lines need an explicit permit/deny and sequence number`);
      continue;
    }
    if (curIos && /^(match|set)\s/i.test(line)) {
      applyIosClause(curIos, line, warnings);
      continue;
    }
    warnings.push(`line not recognized: "${truncateLine(line)}"`);
  }

  if (!maps.size) {
    return { ok: false, error: 'Could not recognize any route-map syntax in the pasted text — expected Gaia ("set routemap NAME id SEQ ...") or Cisco/Brocade/ICX ("route-map NAME permit|deny SEQ") entry lines.' };
  }
  if (maps.size > 1) {
    const names = [...maps.values()].map(v => v.name);
    return { ok: false, error: `Pasted text contains ${names.length} different route-maps: ${names.join(', ')} — paste only one route-map at a time.` };
  }

  const only = [...maps.values()][0];
  return {
    ok: true,
    name: only.name,
    entries: [...only.bySeq.values()].sort((a, b) => a.seq - b.seq),
    warnings,
  };
}

// ── Sync pasted entries into the entries table ────────────────

let pasteReport = { state: 'empty' };

// Reconciles the paste with the entries list. Pristine imports (existing,
// untouched) are refreshed in place or removed when they vanish from the
// paste; entries the user has modified or marked deleted are preserved.
function syncPastedEntries() {
  const res = parsePastedRouteMap(pasteText.value);

  // Learn the route-map name from the paste if the name field is still empty.
  if (res.ok && !res.empty && !parseRouteMapName(rmNameInput.value).valid) {
    rmNameInput.value = res.name;
  }
  const nameR = parseRouteMapName(rmNameInput.value);
  const nameMismatch = res.ok && !res.empty && nameR.valid &&
    nameR.value.toLowerCase() !== res.name.toLowerCase();
  const usable = res.ok && !res.empty && !nameMismatch;
  const parsedBySeq = usable ? new Map(res.entries.map(p => [p.seq, p])) : new Map();

  // Drop imports that no longer correspond to the paste. User-modified
  // entries survive; orphaned delete-marks and pristine imports do not.
  entries = entries.filter(e => {
    if (!e.existing || e.dirty) return true;
    return parsedBySeq.has(e.seq);
  });

  if (!usable) {
    // Whatever was imported no longer reflects a device config — delete-marks
    // lose their meaning and are dropped; modified imports become ordinary
    // new entries instead of losing the user's work.
    entries = entries.filter(e => !(e.existing && e.deleted));
    entries.forEach(e => {
      if (e.existing) { e.existing = false; e.dirty = false; delete e.origAction; delete e.origSeq; }
    });
    pasteReport =
      res.empty ? { state: 'empty' } :
      !res.ok   ? { state: 'error', error: res.error } :
                  { state: 'mismatch', pastedName: res.name, currentName: nameR.value };
    return;
  }

  // Match existing imports by their original device sequence (a modified
  // entry may have been renumbered in the editor); existing entries take
  // precedence over a manual entry that reuses a freed sequence number.
  const bySeq = new Map();
  entries.forEach(e => {
    const key = e.existing ? e.origSeq : e.seq;
    if (e.existing || !bySeq.has(key)) bySeq.set(key, e);
  });

  const collided = [];
  parsedBySeq.forEach((pe, seq) => {
    const holder = bySeq.get(seq);
    if (holder) {
      if (holder.existing && !holder.dirty && !holder.deleted) {
        // Pristine import — refresh from the paste, keep its id stable.
        holder.action = pe.action;
        holder.origAction = pe.action;
        holder.enabled = pe.enabled;
        holder.match = pe.match;
        holder.set = pe.set;
      } else if (!holder.existing) {
        collided.push(seq);
      }
      // Modified or delete-marked imports keep the user's state.
      return;
    }
    entries.push({ ...pe, id: nextId++, existing: true, dirty: false, deleted: false, origAction: pe.action, origSeq: pe.seq });
  });

  pasteReport = {
    state: 'ok',
    name: res.name,
    seqs: res.entries.map(p => p.seq),
    collided,
    warnings: res.warnings,
  };
}

// All sequence numbers currently in use (excluding the entry being edited).
// Delete-marked entries keep their sequence reserved so they can be restored
// without colliding — to reuse a sequence with new content, edit the entry.
function usedSeqs(excludeId) {
  return new Set(entries.filter(e => e.id !== excludeId).map(e => e.seq));
}

function suggestNextSeq(excludeId) {
  const used = usedSeqs(excludeId);
  if (!used.size) return 10;
  return Math.max(...used) + 10;
}

function setPasteInfo(text, isError) {
  pasteInfo.textContent = text;
  pasteInfo.classList.toggle('error', !!isError);
}

function updatePasteInfo() {
  switch (pasteReport.state) {
    case 'empty':
      setPasteInfo('', false);
      break;
    case 'error':
      setPasteInfo(`⚠ ${pasteReport.error}`, true);
      break;
    case 'mismatch':
      setPasteInfo(`⚠ Pasted route-map is named "${pasteReport.pastedName}", which doesn't match the route-map name above ("${pasteReport.currentName}") — its entries were not imported.`, true);
      break;
    case 'ok': {
      const n = pasteReport.seqs.length;
      let msg = `Imported ${n} existing entr${n === 1 ? 'y' : 'ies'} from "${pasteReport.name}" into the entries table below (seq ${pasteReport.seqs.join(', ')}). Edit or delete them there — the generated output only contains your changes.`;
      if (pasteReport.collided.length) {
        msg += `\n⚠ seq ${pasteReport.collided.join(', ')} not imported — already added manually with the same sequence number.`;
      }
      pasteReport.warnings.forEach(w => { msg += `\n→ ${w}`; });
      setPasteInfo(msg, pasteReport.collided.length > 0);
      break;
    }
  }
}

// ── Entry form read/validate ─────────────────────────────────

function readEntryForm() {
  const seqR = parseSeqInput(entrySeqInput.value);
  if (seqR.valid && usedSeqs(editingId).has(seqR.value)) {
    seqR.valid = false;
    seqR.error = `Sequence ${seqR.value} is already in use — try ${suggestNextSeq(editingId)}`;
  }
  setFieldMsg(entrySeqInput, entrySeqMsg, seqR);

  const mNetworksR    = parseNetworks(mNetworks.value);
  const mProtocolR    = parseListName(mProtocol.value, 'Source protocol');
  const mPrefixListR  = parseListName(mPrefixList.value, 'Prefix-list');
  const mNextHopListR = parseListName(mNextHopList.value, 'Next-hop prefix-list');
  const mTagR         = parseOptionalInt(mTag.value, 'Match tag', 0, 4294967295);
  const mCommunityR   = parseListName(mCommunity.value, 'Community-list');
  const mAsPathR      = parseListName(mAsPath.value, 'AS-path list');
  const mInterfaceR   = parseListName(mInterface.value, 'Interface');

  const sMetricR        = parseOptionalInt(sMetric.value, 'Metric', 0, 4294967295);
  const sLocalPrefR     = parseOptionalInt(sLocalPref.value, 'Local preference', 0, 65535);
  const sCommunityR     = parseCommunityValue(sCommunity.value);
  const sAsPathPrependR = parseAsPathPrepend(sAsPathPrepend.value);
  const sNextHopR       = parseIpv4Host(sNextHop.value);
  const sTagR           = parseOptionalInt(sTag.value, 'Set tag', 0, 4294967295);
  const sWeightR        = parseOptionalInt(sWeight.value, 'Weight', 0, 65535);

  setFieldMsg(mNetworks,    'entryMatchNetworksMsg',    mNetworksR);
  setFieldMsg(mProtocol,    'entryMatchProtocolMsg',    mProtocolR);
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
    seqR, mNetworksR, mProtocolR, mPrefixListR, mNextHopListR, mTagR, mCommunityR, mAsPathR, mInterfaceR,
    sMetricR, sLocalPrefR, sCommunityR, sAsPathPrependR, sNextHopR, sTagR, sWeightR,
  ];
  const valid = results.every(r => r.valid);

  const entry = {
    seq: seqR.valid ? seqR.value : null,
    action: entryActionSel.value,
    enabled: entryEnabled.checked,
    match: {
      networks:    mNetworksR.value,
      networkMode: mNetworkMode.value,
      protocol:    mProtocolR.value,
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

// ── Advanced sections ────────────────────────────────────────
// The advanced match / set fields are collapsed by default; the summary shows
// how many of them are populated so nothing hides silently.

function countFilled(fields) {
  return fields.filter(el => (el.type === 'checkbox' ? el.checked : el.value.trim() !== '')).length;
}

function updateAdvBadges() {
  const m = countFilled(advMatchFields);
  const s = countFilled(advSetFields);
  advMatchCount.textContent = m ? `· ${m} set` : '';
  advSetCount.textContent   = s ? `· ${s} set` : '';
  return { m, s };
}

function resetEntryForm() {
  entrySeqInput.value = String(suggestNextSeq(null));
  entryActionSel.value = 'permit';
  entryEnabled.checked = true;
  mNetworks.value = '';
  mNetworkMode.value = 'all';
  mProtocol.value = '';
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
    entrySeqInput, mNetworks, mProtocol, mPrefixList, mNextHopList, mTag, mCommunity, mAsPath, mInterface,
    sMetric, sLocalPref, sCommunity, sAsPathPrepend, sNextHop, sTag, sWeight,
  ];
  allFields.forEach(el => el.classList.remove('error'));

  advMatchSection.open = false;
  advSetSection.open = false;
  updateAdvBadges();
}

// ── Summaries for the entry list ─────────────────────────────

function summarizeMatch(m) {
  const parts = [];
  if (m.networks && m.networks.length) parts.push(`net ${m.networks.join(', ')} (${m.networkMode})`);
  if (m.protocol)    parts.push(`proto ${m.protocol}`);
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
//
// Output is a change script: unchanged existing (imported) entries are
// omitted, modified existing entries are deleted and re-created so clauses
// removed in the editor don't linger on the device, and delete-marked
// entries emit the vendor's delete/no command (always first, so a new entry
// can reuse a freed sequence number).

// Cisco IOS and Brocade/Ruckus/ICX (FastIron) share the same route-map grammar.
// Gaia has no per-entry "off" state equivalent, so disabled entries are
// omitted here (Gaia keeps them, rendered with "off").
function renderIosLike(name, list) {
  const noFor = e => `no route-map ${name} ${e.origAction || e.action} ${e.origSeq != null ? e.origSeq : e.seq}`;

  const changed = list.filter(e => !e.deleted && (!e.existing || e.dirty));
  const active = changed.filter(e => e.enabled);

  // All removals first — a re-created or new entry may reuse a freed sequence.
  const noLines = [
    ...list.filter(e => e.deleted).map(noFor),
    ...active.filter(e => e.existing).map(noFor),
  ];
  if (!noLines.length && !active.length) return null;

  const preLines = [];
  const blocks = active.map(e => {
    const m = e.match, s = e.set;
    const lines = [`route-map ${name} ${e.action} ${e.seq}`];

    if (m.networks.length) {
      const plName = `${name}-${e.seq}-NET`;
      m.networks.forEach((cidr, idx) => {
        const geLe = m.networkMode === 'all' ? ' le 32' : '';
        preLines.push(`ip prefix-list ${plName} seq ${(idx + 1) * 10} permit ${cidr}${geLe}`);
      });
      if (m.networkMode === 'between' || m.networkMode === 'refines') {
        preLines.push(`! note: Gaia "${m.networkMode}" match mode has no exact Cisco/Brocade equivalent — verify manually`);
      }
      lines.push(` match ip address prefix-list ${plName}`);
    }
    if (m.protocol)     lines.push(` match source-protocol ${m.protocol}`);
    if (m.prefixList)   lines.push(` match ip address prefix-list ${m.prefixList}`);
    if (m.nextHopList)  lines.push(` match ip next-hop prefix-list ${m.nextHopList}`);
    if (m.tag)          lines.push(` match tag ${m.tag}`);
    if (m.community)    lines.push(` match community ${m.community}${m.communityExact ? ' exact-match' : ''}`);
    if (m.asPath)       lines.push(` match as-path ${m.asPath}`);
    if (m.interface)    lines.push(` match interface ${m.interface}`);
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

  const parts = [];
  if (noLines.length) parts.push(noLines.join('\n'));
  if (preLines.length) parts.push(preLines.join('\n'));
  if (blocks.length) parts.push(blocks.join('\n!\n'));
  let out = parts.join('\n!\n');

  const disabledCount = changed.length - active.length;
  if (disabledCount) {
    out += `\n! note: ${disabledCount} disabled entr${disabledCount === 1 ? 'y' : 'ies'} omitted — Cisco/Brocade/ICX have no per-entry "off" state`;
  }
  return out;
}

function renderGaia(name, list) {
  const delFor = e => `delete routemap ${name} id ${e.origSeq != null ? e.origSeq : e.seq}`;

  const changed = list.filter(e => !e.deleted && (!e.existing || e.dirty));

  // All removals first — a re-created or new entry may reuse a freed sequence.
  const deletes = [
    ...list.filter(e => e.deleted).map(delFor),
    ...changed.filter(e => e.existing).map(delFor),
  ];
  if (!deletes.length && !changed.length) return null;

  const blocks = changed.map(e => {
    const p = `set routemap ${name} id ${e.seq}`;
    const lines = [
      `${p} ${e.enabled ? 'on' : 'off'}`,
      `${p} ${e.action === 'permit' ? 'allow' : 'restrict'}`,
    ];
    const m = e.match, s = e.set;
    m.networks.forEach(cidr => lines.push(`${p} match network ${cidr} ${m.networkMode}`));
    if (m.protocol)    lines.push(`${p} match protocol ${m.protocol}`);
    if (m.prefixList)  lines.push(`${p} match prefix-list ${m.prefixList} preference 1 on`);
    if (m.tag)         lines.push(`${p} match tag ${m.tag}`);
    if (m.interface)   lines.push(`${p} match interface ${m.interface}`);
    if (s.metric)        lines.push(`${p} action metric value ${s.metric}`);
    if (s.localPref)     lines.push(`${p} action localpref ${s.localPref}`);
    if (s.asPathPrepend) {
      const count = s.asPathPrepend.split(/\s+/).filter(Boolean).length;
      lines.push(`${p} action aspath-prepend-count ${count}`);
    }
    if (s.nextHop)       lines.push(`${p} action nexthop ip ${s.nextHop}`);
    return lines.join('\n');
  });

  const parts = [];
  if (deletes.length) parts.push(deletes.join('\n'));
  parts.push(...blocks);
  return parts.join('\n\n');
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
    if (e.deleted) tr.className = 'rm-row-deleted';

    const seqTd = document.createElement('td');
    seqTd.className = 'mono-cell';
    seqTd.textContent = e.seq;
    tr.appendChild(seqTd);

    const actionTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `rm-action-badge ${e.action}${e.enabled ? '' : ' off'}`;
    badge.textContent = e.action + (e.enabled ? '' : ' · off');
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

    const statusTd = document.createElement('td');
    const statusBadge = document.createElement('span');
    const status = e.deleted ? { cls: 'deleted', label: 'delete' }
      : e.existing ? (e.dirty ? { cls: 'modified', label: 'modified' } : { cls: 'existing', label: 'existing' })
      : { cls: 'new', label: 'new' };
    statusBadge.className = `rm-status-badge ${status.cls}`;
    statusBadge.textContent = status.label;
    statusTd.appendChild(statusBadge);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'rm-summary-cell';
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'rm-row-actions';

    if (e.deleted) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'rm-row-btn';
      restoreBtn.textContent = 'restore';
      restoreBtn.addEventListener('click', () => restoreEntry(e.id));
      actionsWrap.appendChild(restoreBtn);
    } else {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'rm-row-btn';
      editBtn.textContent = 'edit';
      editBtn.addEventListener('click', () => loadEntryIntoForm(e.id));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rm-row-btn rm-remove';
      // Removing an existing entry generates a delete command; removing a
      // new entry just drops it from the list.
      removeBtn.textContent = e.existing ? 'delete' : 'remove';
      removeBtn.addEventListener('click', () => removeEntry(e.id));

      actionsWrap.appendChild(editBtn);
      actionsWrap.appendChild(removeBtn);
    }
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
  entryEnabled.checked = e.enabled;
  mNetworks.value = e.match.networks.join('\n');
  mNetworkMode.value = e.match.networkMode;
  mProtocol.value = e.match.protocol;
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

  const { m, s } = updateAdvBadges();
  advMatchSection.open = m > 0;
  advSetSection.open = s > 0;

  updateAll();
  entrySeqInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  if (e.existing) {
    e.deleted = true; // stays in the table; emits a delete command in the output
  } else {
    entries = entries.filter(x => x.id !== id);
  }
  if (editingId === id) resetEntryForm();
  updateAll();
}

function restoreEntry(id) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  e.deleted = false;
  updateAll();
}

// ── Output rendering ─────────────────────────────────────────

let copyTimer = null;
let feedbackTimer = null;

function clearFeedback() {
  clearTimeout(feedbackTimer);
  copyFeedback.textContent = '';
  copyFeedback.classList.remove('copied', 'error');
  copyBtn.classList.remove('copied');
}

function showCopied() {
  clearFeedback();
  copyFeedback.textContent = 'copied!';
  copyFeedback.classList.add('copied');
  copyBtn.classList.add('copied');
  feedbackTimer = setTimeout(clearFeedback, 1500);
}

function updateOutput() {
  const nameR = parseRouteMapName(rmNameInput.value);
  setFieldMsg(rmNameInput, rmNameMsg, nameR);

  let text = null;
  if (nameR.valid && entries.length) {
    text = VENDOR_RENDERERS[activeVendor](nameR.value, [...entries].sort((a, b) => a.seq - b.seq));
  }
  const hasErrors = !text;

  if (text) {
    outputPre.textContent = text;
    outputPre.classList.remove('rm-output-empty');
  } else {
    outputPre.textContent = !nameR.valid
      ? 'Enter a route-map name below to generate output.'
      : !entries.length
        ? 'Add at least one entry below to generate output.'
        : 'No changes to output yet — edit or delete an existing entry, or add a new one.';
    outputPre.classList.add('rm-output-empty');
  }

  copyBtn.disabled = hasErrors;
  outputPre.classList.toggle('has-errors', hasErrors);

  clearTimeout(copyTimer);
  clearFeedback();
  if (!hasErrors) {
    copyTimer = setTimeout(() => {
      navigator.clipboard.writeText(text).then(showCopied).catch(() => {});
    }, 750);
  }
}

function updateAll() {
  syncPastedEntries();
  updatePasteInfo();
  renderEntryList();
  updateOutput();
}

// ── Manual copy ───────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  clearTimeout(copyTimer);

  navigator.clipboard.writeText(outputPre.textContent).then(showCopied).catch(() => {
    clearFeedback();
    copyFeedback.textContent = 'copy failed — select manually';
    copyFeedback.classList.add('error');
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
    if (idx !== -1) {
      const prev = entries[idx];
      entries[idx] = {
        ...entry,
        id: prev.id,
        existing: prev.existing,
        origAction: prev.origAction,
        origSeq: prev.origSeq,
        dirty: !!prev.existing, // updating an imported entry marks it modified
        deleted: false,
      };
    }
  } else {
    entries.push({ ...entry, id: nextId++, existing: false, dirty: false, deleted: false });
  }

  resetEntryForm();
  updateAll();
});

cancelEditBtn.addEventListener('click', () => {
  resetEntryForm();
  updateAll();
});

// ── Live validation while typing ─────────────────────────────

const entryFormInputs = [
  entrySeqInput, entryActionSel, entryEnabled,
  mNetworks, mNetworkMode, mProtocol,
  mPrefixList, mNextHopList, mTag, mCommunity, mCommunityEx, mAsPath, mInterface,
  sMetric, sLocalPref, sCommunity, sCommunityAdd, sAsPathPrepend, sNextHop, sTag, sWeight, sOrigin,
];
entryFormInputs.forEach(el => {
  el.addEventListener('input', onEntryFormInput);
  el.addEventListener('change', onEntryFormInput);
});

function onEntryFormInput() {
  readEntryForm();
  updateAdvBadges();
}

rmNameInput.addEventListener('input', updateAll);
pasteText.addEventListener('input', updateAll);

// ── Initial render ────────────────────────────────────────────

resetEntryForm();
updateAll();
