/**
 * tcpdump.js — tcpdump command builder with input validation and CIDR translation.
 * CIDR notation (e.g. 10.0.0.0/8) is parsed and translated to tcpdump's `net` keyword.
 * Only syntactically valid fields contribute to the generated command.
 */

'use strict';

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────

const ifaceInput       = $('iface');
const optVerbose       = $('optVerbose');
const optCount         = $('optCount');
const optWrite         = $('optWrite');
const optNoResolve     = $('optNoResolve');
const optNoPortResolve = $('optNoPortResolve');
const optNoPromisc     = $('optNoPromisc');
const optTimestamp     = $('optTimestamp');
const protoSelect      = $('proto');
const srcHostInput     = $('srcHost');
const srcPortInput     = $('srcPort');
const dstHostInput     = $('dstHost');
const dstPortInput     = $('dstPort');
const hostInput        = $('host');
const portInput        = $('port');
const extraFilter      = $('extraFilter');

const cmdText       = $('cmdText');
const cmdOutput     = document.querySelector('.cmd-output');
const copyBtn       = $('copyBtn');
const copyFeedback  = $('copyFeedback');
const autoCopyNote  = $('autoCopyNote');
const sidebar       = $('sidebar');
const sidebarToggle = $('sidebarToggle');

// ── Sidebar (mobile) ──────────────────────────────────────────

sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
document.addEventListener('click', e => {
  if (sidebar.classList.contains('open') &&
      !sidebar.contains(e.target) &&
      e.target !== sidebarToggle) {
    sidebar.classList.remove('open');
  }
});

// ── Validation ────────────────────────────────────────────────

// Returns { valid, filterKey, value, warning?, error? }
// filterKey is 'host' for bare IPs/hostnames or 'net' for CIDR ranges.
// value is the translated filter operand (network address for CIDR).
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
  // Validate all filterable fields
  const srcHostR = parseHostInput(srcHostInput.value);
  const srcPortR = parsePortInput(srcPortInput.value);
  const dstHostR = parseHostInput(dstHostInput.value);
  const dstPortR = parsePortInput(dstPortInput.value);
  const hostR    = parseHostInput(hostInput.value);
  const portR    = parsePortInput(portInput.value);
  const countR   = validatePositiveInt(optCount);

  // Update per-field error/warning messages
  setFieldMsg(srcHostInput, 'srcHostMsg', srcHostR);
  setFieldMsg(srcPortInput, 'srcPortMsg', srcPortR);
  setFieldMsg(dstHostInput, 'dstHostMsg', dstHostR);
  setFieldMsg(dstPortInput, 'dstPortMsg', dstPortR);
  setFieldMsg(hostInput,    'hostMsg',    hostR);
  setFieldMsg(portInput,    'portMsg',    portR);
  setFieldMsg(optCount,     'countMsg',   countR);

  const hasErrors = [srcHostR, srcPortR, dstHostR, dstPortR, hostR, portR, countR]
    .some(r => !r.valid);

  // Assemble command from valid fields only
  const parts = ['tcpdump'];

  const iface = ifaceInput.value.trim();
  if (iface) parts.push('-i', iface);

  // -nn implies -n; never emit both
  if (optNoPortResolve.checked) {
    parts.push('-nn');
  } else if (optNoResolve.checked) {
    parts.push('-n');
  }

  const verb = optVerbose.value;
  if (verb) parts.push(verb);

  if (optNoPromisc.checked) parts.push('-p');
  if (optTimestamp.checked)  parts.push('-tttt');

  if (countR.valid && countR.value) parts.push('-c', countR.value);

  const writeFile = optWrite.value.trim();
  if (writeFile) {
    parts.push('-w', /[\s&|;<>()]/.test(writeFile) ? `"${writeFile}"` : writeFile);
  }

  // BPF filter expression
  const fp = [];

  const proto = protoSelect.value;
  if (proto) fp.push(proto);

  // src/dst fields use filterKey ('host' or 'net') as the qualifier
  if (srcHostR.valid && srcHostR.value) fp.push(`src ${srcHostR.filterKey} ${srcHostR.value}`);
  if (srcPortR.valid && srcPortR.value) fp.push(`src port ${srcPortR.value}`);
  if (dstHostR.valid && dstHostR.value) fp.push(`dst ${dstHostR.filterKey} ${dstHostR.value}`);
  if (dstPortR.valid && dstPortR.value) fp.push(`dst port ${dstPortR.value}`);
  if (hostR.valid    && hostR.value)    fp.push(`${hostR.filterKey} ${hostR.value}`);
  if (portR.valid    && portR.value)    fp.push(`port ${portR.value}`);

  const extra = extraFilter.value.trim();
  if (extra) fp.push(extra);

  if (fp.length) {
    const filter = fp.join(' and ');
    // Single primitives need no quotes; compound expressions do
    parts.push(fp.length > 1 ? `'${filter}'` : filter);
  }

  return { cmd: parts.join(' '), hasErrors };
}

// ── Live update + auto-copy ───────────────────────────────────

let copyTimer = null;

function updateCommand() {
  const { cmd, hasErrors } = buildCommand();
  cmdText.textContent = cmd;

  copyBtn.disabled = hasErrors;
  cmdOutput.classList.toggle('has-errors', hasErrors);

  clearTimeout(copyTimer);
  if (hasErrors) {
    autoCopyNote.textContent = '⚠ fix errors above';
  } else {
    autoCopyNote.textContent = '';
    copyTimer = setTimeout(() => {
      navigator.clipboard.writeText(cmd).then(() => {
        autoCopyNote.textContent = '⎘ auto-copied';
        setTimeout(() => { autoCopyNote.textContent = ''; }, 2000);
      }).catch(() => {});
    }, 750);
  }
}

const allInputs = [
  ifaceInput, optVerbose, optCount, optWrite,
  optNoResolve, optNoPortResolve, optNoPromisc, optTimestamp,
  protoSelect, srcHostInput, srcPortInput, dstHostInput, dstPortInput,
  hostInput, portInput, extraFilter,
];

allInputs.forEach(el => {
  el.addEventListener('input', updateCommand);
  el.addEventListener('change', updateCommand);
});

// ── Manual copy ───────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  clearTimeout(copyTimer);
  autoCopyNote.textContent = '';

  navigator.clipboard.writeText(cmdText.textContent).then(() => {
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

// ── Initial render (no auto-copy on load) ────────────────────

cmdText.textContent = buildCommand().cmd;
