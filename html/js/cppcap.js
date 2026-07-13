/**
 * cppcap.js — Check Point cppcap command builder (sk141412).
 * cppcap filters use standard pcap-filter (BPF) syntax, so host/port/CIDR
 * handling matches the tcpdump builder: CIDR ranges become `net` primitives.
 * Only syntactically valid fields contribute to the generated command.
 */

'use strict';

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────

const ifaceInput      = $('iface');
const ifaceExclude    = $('ifaceExclude');
const optDirection    = $('optDirection');
const optSnaplen      = $('optSnaplen');
const optFrameLimit   = $('optFrameLimit');
const optByteLimit    = $('optByteLimit');
const optOutput       = $('optOutput');
const optRotateSize   = $('optRotateSize');
const optRotateCount  = $('optRotateCount');
const optL2           = $('optL2');
const optL3           = $('optL3');
const optL4           = $('optL4');
const optProcId       = $('optProcId');
const optNoTimestamp  = $('optNoTimestamp');
const vsInclude       = $('vsInclude');
const vsExclude       = $('vsExclude');
const protoSelect     = $('proto');
const srcHostInput    = $('srcHost');
const srcPortInput    = $('srcPort');
const dstHostInput    = $('dstHost');
const dstPortInput    = $('dstPort');
const hostInput       = $('host');
const portInput       = $('port');
const extraFilter     = $('extraFilter');

const protoNot   = $('protoNot');
const srcHostNot = $('srcHostNot');
const srcPortNot = $('srcPortNot');
const dstHostNot = $('dstHostNot');
const dstPortNot = $('dstPortNot');
const hostNot    = $('hostNot');
const portNot    = $('portNot');

const cmdText      = $('cmdText');
const cmdOutput    = document.querySelector('.cmd-output');
const copyBtn      = $('copyBtn');
const copyFeedback = $('copyFeedback');
const displayMsg   = $('displayMsg');

// ── Validation ────────────────────────────────────────────────

// Returns { valid, filterKey, value, warning?, error? }
// filterKey is 'host' for bare IPs/hostnames or 'net' for CIDR ranges.
function parseHostInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, filterKey: null, value: null };

  // IPv6 (contains colon) — pass through as-is with 'host'
  if (s.includes(':')) {
    return { valid: true, filterKey: 'host', value: s };
  }

  // CIDR notation (contains slash) → translate to 'net' keyword
  if (s.includes('/')) {
    const slash     = s.lastIndexOf('/');
    const ipStr     = s.slice(0, slash);
    const prefixStr = s.slice(slash + 1);

    if (!/^\d+$/.test(prefixStr)) {
      return { valid: false, error: 'Prefix must be a number (0–32)' };
    }
    const prefix = parseInt(prefixStr, 10);
    if (prefix < 0 || prefix > 32) {
      return { valid: false, error: 'Prefix length must be 0–32' };
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr)) {
      return { valid: false, error: 'Enter a valid IPv4 address before the /' };
    }
    const octets = ipStr.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      return { valid: false, error: 'IP octet out of range (0–255)' };
    }

    // Apply mask to derive the true network address
    const ipInt   = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const maskInt = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    const netInt  = (ipInt & maskInt) >>> 0;
    const netIp   = [
      (netInt >>> 24) & 0xFF,
      (netInt >>> 16) & 0xFF,
      (netInt >>>  8) & 0xFF,
       netInt         & 0xFF,
    ].join('.');
    const cidr = `${netIp}/${prefix}`;

    return {
      valid: true,
      filterKey: 'net',
      value: cidr,
      warning: ipInt !== netInt ? `Host bits cleared — using network address ${cidr}` : null,
    };
  }

  // Bare IPv4 (four dot-separated groups)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      return { valid: false, error: 'IP octet out of range (0–255)' };
    }
    return { valid: true, filterKey: 'host', value: s };
  }

  // Partial IP-like (e.g. "10.0") — suggest CIDR
  if (/^\d+(\.\d+){1,2}$/.test(s)) {
    return { valid: false, error: 'Partial IP — use CIDR notation, e.g. 10.0.0.0/8' };
  }

  // Hostname: starts and ends with alphanumeric, allows hyphens and dots inside
  if (/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(s)) {
    return { valid: true, filterKey: 'host', value: s };
  }

  return { valid: false, error: 'Enter a valid IP, CIDR (e.g. 10.0.0.0/8), or hostname' };
}

// Returns { valid, value, error? }
function parsePortInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: null };

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 1 || n > 65535) return { valid: false, error: 'Port must be 1–65535' };
    return { valid: true, value: s };
  }

  // Service name: starts with a letter, alphanumeric + hyphens
  if (/^[a-zA-Z][a-zA-Z0-9\-]*$/.test(s)) {
    return { valid: true, value: s };
  }

  return { valid: false, error: 'Enter a port number (1–65535) or service name (e.g. https)' };
}

// Returns { valid, value, error? } — for number inputs with min=1
function validatePositiveInt(el) {
  const s = el.value.trim();
  if (!s) {
    return (el.validity && el.validity.badInput)
      ? { valid: false, error: 'Must be a positive integer' }
      : { valid: true, value: null };
  }
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 1) return { valid: false, error: 'Must be a positive integer' };
  return { valid: true, value: String(n) };
}

// Returns { valid, value, error? } — for number inputs where 0 is meaningful
function validateNonNegativeInt(el) {
  const s = el.value.trim();
  if (!s) {
    return (el.validity && el.validity.badInput)
      ? { valid: false, error: 'Must be a whole number (0 or higher)' }
      : { valid: true, value: null };
  }
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0) return { valid: false, error: 'Must be a whole number (0 or higher)' };
  return { valid: true, value: String(n) };
}

// Returns { valid, value, error? } — file size with optional K/M/G suffix
function parseRotateSize(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, value: null };
  const m = s.match(/^(\d+)([kmgKMG])?$/);
  if (!m) return { valid: false, error: 'Enter a number with optional K, M, or G suffix (e.g. 100M)' };
  if (parseInt(m[1], 10) < 1) return { valid: false, error: 'Size must be at least 1' };
  return { valid: true, value: m[1] + (m[2] ? m[2].toUpperCase() : '') };
}

// Interface field — cppcap has no default interface in R82+, and "any" is
// expensive. Warnings only; the flag flips to -I when EXCLUDE is active.
function parseIfaceInput(raw, excludeActive) {
  const s = (raw || '').trim();
  if (!s) {
    if (excludeActive) return { valid: false, error: 'Enter the interface to exclude (-I)' };
    return { valid: true, value: null, warning: '-i is mandatory in R82 and higher' };
  }
  if (!/^[a-zA-Z0-9._:\-]+$/.test(s)) {
    return { valid: false, error: 'Enter a valid interface name (e.g. eth0, bond1, any)' };
  }
  if (s === 'any' && !excludeActive) {
    return { valid: true, value: s, warning: 'Capturing on all interfaces may cause high CPU usage' };
  }
  return { valid: true, value: s };
}

// Prefixes a BPF primitive with `not` when its NOT pill is active.
function withNot(primitive, notEl) {
  return notEl.classList.contains('active') ? `not ${primitive}` : primitive;
}

// ── Field message display ─────────────────────────────────────

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

// ── Command builder ───────────────────────────────────────────

function buildCommand() {
  const excludeActive = ifaceExclude.classList.contains('active');

  const ifaceR      = parseIfaceInput(ifaceInput.value, excludeActive);
  const snaplenR    = validateNonNegativeInt(optSnaplen);
  const frameLimR   = validatePositiveInt(optFrameLimit);
  const byteLimR    = validatePositiveInt(optByteLimit);
  const rotSizeR    = parseRotateSize(optRotateSize.value);
  const rotCountR   = validatePositiveInt(optRotateCount);
  const vsIncludeR  = validateNonNegativeInt(vsInclude);
  const vsExcludeR  = validateNonNegativeInt(vsExclude);
  const srcHostR    = parseHostInput(srcHostInput.value);
  const srcPortR    = parsePortInput(srcPortInput.value);
  const dstHostR    = parseHostInput(dstHostInput.value);
  const dstPortR    = parsePortInput(dstPortInput.value);
  const hostR       = parseHostInput(hostInput.value);
  const portR       = parsePortInput(portInput.value);

  const outputFile = optOutput.value.trim();

  // Cross-field rules: -w needs -o, -W needs -w, -v and -V are exclusive
  if (rotSizeR.valid && rotSizeR.value && !outputFile) {
    rotSizeR.valid = false;
    rotSizeR.error = 'Rotation requires an output file (-o)';
  }
  if (rotCountR.valid && rotCountR.value && !(rotSizeR.valid && rotSizeR.value)) {
    rotCountR.valid = false;
    rotCountR.error = 'File count limit requires a rotation size (-w)';
  }
  if (vsIncludeR.valid && vsIncludeR.value !== null &&
      vsExcludeR.valid && vsExcludeR.value !== null) {
    vsExcludeR.valid = false;
    vsExcludeR.error = 'Use either -v or -V, not both';
  }

  setFieldMsg(ifaceInput,     'ifaceMsg',      ifaceR);
  setFieldMsg(optSnaplen,     'snaplenMsg',    snaplenR);
  setFieldMsg(optFrameLimit,  'frameLimitMsg', frameLimR);
  setFieldMsg(optByteLimit,   'byteLimitMsg',  byteLimR);
  setFieldMsg(optRotateSize,  'rotateSizeMsg', rotSizeR);
  setFieldMsg(optRotateCount, 'rotateCountMsg', rotCountR);
  setFieldMsg(vsInclude,      'vsIncludeMsg',  vsIncludeR);
  setFieldMsg(vsExclude,      'vsExcludeMsg',  vsExcludeR);
  setFieldMsg(srcHostInput,   'srcHostMsg',    srcHostR);
  setFieldMsg(srcPortInput,   'srcPortMsg',    srcPortR);
  setFieldMsg(dstHostInput,   'dstHostMsg',    dstHostR);
  setFieldMsg(dstPortInput,   'dstPortMsg',    dstPortR);
  setFieldMsg(hostInput,      'hostMsg',       hostR);
  setFieldMsg(portInput,      'portMsg',       portR);

  // Screen-only flags are dropped while writing to a file
  const displayFlags = [
    [optL2,          '-D'],
    [optL3,          '-N'],
    [optL4,          '-T'],
    [optProcId,      '-P'],
    [optNoTimestamp, '-Q'],
  ];
  const anyDisplayChecked = displayFlags.some(([el]) => el.checked);
  if (outputFile && anyDisplayChecked) {
    displayMsg.textContent = '→ Screen output flags are omitted while an output file (-o) is set';
    displayMsg.className = 'field-msg warning';
  } else {
    displayMsg.textContent = '';
    displayMsg.className = 'field-msg';
  }

  const hasErrors = [
    ifaceR, snaplenR, frameLimR, byteLimR, rotSizeR, rotCountR,
    vsIncludeR, vsExcludeR,
    srcHostR, srcPortR, dstHostR, dstPortR, hostR, portR,
  ].some(r => !r.valid);

  // Assemble command from valid fields only
  const parts = ['cppcap'];

  if (ifaceR.valid && ifaceR.value) {
    parts.push(excludeActive ? '-I' : '-i', ifaceR.value);
  }

  const dir = optDirection.value;
  if (dir) parts.push('-d', dir);

  if (snaplenR.valid && snaplenR.value !== null) parts.push('-c', snaplenR.value);
  if (byteLimR.valid && byteLimR.value)          parts.push('-b', byteLimR.value);
  if (frameLimR.valid && frameLimR.value)        parts.push('-p', frameLimR.value);

  if (vsIncludeR.valid && vsIncludeR.value !== null) {
    parts.push('-v', vsIncludeR.value);
  } else if (vsExcludeR.valid && vsExcludeR.value !== null) {
    parts.push('-V', vsExcludeR.value);
  }

  if (!outputFile) {
    displayFlags.forEach(([el, flag]) => { if (el.checked) parts.push(flag); });
  }

  // BPF filter expression
  const fp = [];

  const proto = protoSelect.value;
  if (proto) fp.push(withNot(proto, protoNot));

  if (srcHostR.valid && srcHostR.value) fp.push(withNot(`src ${srcHostR.filterKey} ${srcHostR.value}`, srcHostNot));
  if (srcPortR.valid && srcPortR.value) fp.push(withNot(`src port ${srcPortR.value}`, srcPortNot));
  if (dstHostR.valid && dstHostR.value) fp.push(withNot(`dst ${dstHostR.filterKey} ${dstHostR.value}`, dstHostNot));
  if (dstPortR.valid && dstPortR.value) fp.push(withNot(`dst port ${dstPortR.value}`, dstPortNot));
  if (hostR.valid    && hostR.value)    fp.push(withNot(`${hostR.filterKey} ${hostR.value}`, hostNot));
  if (portR.valid    && portR.value)    fp.push(withNot(`port ${portR.value}`, portNot));

  const extra = extraFilter.value.trim();
  if (extra) fp.push(extra);

  if (fp.length) parts.push('-f', `"${fp.join(' and ')}"`);

  if (outputFile) {
    parts.push('-o', /[\s&|;<>()]/.test(outputFile) ? `"${outputFile}"` : outputFile);
    if (rotSizeR.valid && rotSizeR.value) {
      parts.push('-w', rotSizeR.value);
      if (rotCountR.valid && rotCountR.value) parts.push('-W', rotCountR.value);
    }
  }

  return { cmd: parts.join(' '), hasErrors };
}

// ── Live update + auto-copy ───────────────────────────────────

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

function updateCommand() {
  const { cmd, hasErrors } = buildCommand();
  cmdText.textContent = cmd;

  copyBtn.disabled = hasErrors;
  cmdOutput.classList.toggle('has-errors', hasErrors);

  clearTimeout(copyTimer);
  clearFeedback();
  if (hasErrors) {
    copyFeedback.textContent = '⚠ fix errors above';
    copyFeedback.classList.add('error');
  } else {
    copyTimer = setTimeout(() => {
      navigator.clipboard.writeText(cmd).then(showCopied).catch(() => {});
    }, 750);
  }
}

const allInputs = [
  ifaceInput, optDirection, optSnaplen, optFrameLimit, optByteLimit,
  optOutput, optRotateSize, optRotateCount,
  optL2, optL3, optL4, optProcId, optNoTimestamp,
  vsInclude, vsExclude,
  protoSelect, srcHostInput, srcPortInput, dstHostInput, dstPortInput,
  hostInput, portInput, extraFilter,
];

allInputs.forEach(el => {
  el.addEventListener('input', updateCommand);
  el.addEventListener('change', updateCommand);
});

// ── NOT toggles (interface -I + filter negation) ──────────────

const allNotToggles = [
  ifaceExclude,
  protoNot,
  srcHostNot, srcPortNot,
  dstHostNot, dstPortNot,
  hostNot, portNot,
];
allNotToggles.forEach(btn => {
  btn.addEventListener('click', () => {
    const active = btn.classList.toggle('active');
    btn.setAttribute('aria-pressed', String(active));
    updateCommand();
  });
});

// ── Manual copy ───────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  clearTimeout(copyTimer);

  navigator.clipboard.writeText(cmdText.textContent).then(showCopied).catch(() => {
    clearFeedback();
    copyFeedback.textContent = 'copy failed — select manually';
    copyFeedback.classList.add('error');
  });
});

// ── Quick actions ─────────────────────────────────────────────

$('fillFullFrame').addEventListener('click', () => {
  optSnaplen.value = '0';
  updateCommand();
  optSnaplen.focus();
});

$('fillDefaultPath').addEventListener('click', () => {
  optOutput.value = '/var/log/capture.pcap';
  updateCommand();
  optOutput.focus();
});

$('clearOutput').addEventListener('click', () => {
  optOutput.value = '';
  updateCommand();
  optOutput.focus();
});

// ── Initial render (no auto-copy on load) ────────────────────

cmdText.textContent = buildCommand().cmd;
