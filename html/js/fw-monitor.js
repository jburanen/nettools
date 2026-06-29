/**
 * fw-monitor.js — Check Point fw monitor command builder.
 * CIDR ranges (e.g. 10.0.0.0/24) are translated to fw monitor's mask syntax:
 * (src & 255.255.255.0) = 10.0.0.0
 * Only syntactically valid fields contribute to the generated command.
 */

'use strict';

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────

const optCount     = $('optCount');
const optOutput    = $('optOutput');
const optNoResolve = $('optNoResolve');
const ptI_lower    = $('ptI_lower');
const ptI_upper    = $('ptI_upper');
const ptO_lower    = $('ptO_lower');
const ptO_upper    = $('ptO_upper');
const protoSelect  = $('proto');
const srcHostInput = $('srcHost');
const srcPortInput = $('srcPort');
const dstHostInput = $('dstHost');
const dstPortInput = $('dstPort');
const hostInput    = $('host');
const portInput    = $('port');

const cmdText      = $('cmdText');
const cmdOutput    = document.querySelector('.cmd-output');
const copyBtn      = $('copyBtn');
const copyFeedback = $('copyFeedback');
const autoCopyNote = $('autoCopyNote');
const maskMsg      = $('maskMsg');

// ── Helpers ───────────────────────────────────────────────────

function prefixToMask(prefix) {
  const maskInt = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  return [
    (maskInt >>> 24) & 0xFF,
    (maskInt >>> 16) & 0xFF,
    (maskInt >>>  8) & 0xFF,
     maskInt         & 0xFF,
  ].join('.');
}

// ── Validation ────────────────────────────────────────────────

// Returns { valid, type: 'host'|'net'|null, ip?, network?, mask?, warning?, error? }
// fw monitor only supports IPv4 host/net addresses in filter expressions.
function parseHostInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { valid: true, type: null };

  if (s.includes('/')) {
    const slash     = s.lastIndexOf('/');
    const ipStr     = s.slice(0, slash);
    const prefixStr = s.slice(slash + 1);

    if (!/^\d+$/.test(prefixStr))
      return { valid: false, error: 'Prefix must be a number (0–32)' };
    const prefix = parseInt(prefixStr, 10);
    if (prefix < 0 || prefix > 32)
      return { valid: false, error: 'Prefix length must be 0–32' };
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr))
      return { valid: false, error: 'Enter a valid IPv4 address before the /' };
    const octets = ipStr.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255))
      return { valid: false, error: 'IP octet out of range (0–255)' };

    const ipInt   = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const maskInt = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    const netInt  = (ipInt & maskInt) >>> 0;
    const netIp   = [
      (netInt >>> 24) & 0xFF,
      (netInt >>> 16) & 0xFF,
      (netInt >>>  8) & 0xFF,
       netInt         & 0xFF,
    ].join('.');
    const maskStr = prefixToMask(prefix);

    return {
      valid: true,
      type: 'net',
      network: netIp,
      mask: maskStr,
      warning: ipInt !== netInt ? `Host bits cleared — using network address ${netIp}/${prefix}` : null,
    };
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255))
      return { valid: false, error: 'IP octet out of range (0–255)' };
    return { valid: true, type: 'host', ip: s };
  }

  if (/^\d+(\.\d+){1,2}$/.test(s))
    return { valid: false, error: 'Partial IP — use CIDR notation, e.g. 10.0.0.0/8' };

  return { valid: false, error: 'Enter a valid IPv4 address or CIDR range (e.g. 10.0.0.0/24)' };
}

// Builds a single fw monitor filter token for the given direction ('src' or 'dst').
// Returns null if the parsed result has no value.
function hostToken(dir, parsed) {
  if (!parsed.valid || !parsed.type) return null;
  if (parsed.type === 'host') return `${dir}=${parsed.ip}`;
  // CIDR → (dir & mask) = network
  return `(${dir} & ${parsed.mask}) = ${parsed.network}`;
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
  return { valid: false, error: 'Enter a port number (1–65535)' };
}

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
  const srcHostR = parseHostInput(srcHostInput.value);
  const srcPortR = parsePortInput(srcPortInput.value);
  const dstHostR = parseHostInput(dstHostInput.value);
  const dstPortR = parsePortInput(dstPortInput.value);
  const hostR    = parseHostInput(hostInput.value);
  const portR    = parsePortInput(portInput.value);
  const countR   = validatePositiveInt(optCount);

  setFieldMsg(srcHostInput, 'srcHostMsg', srcHostR);
  setFieldMsg(srcPortInput, 'srcPortMsg', srcPortR);
  setFieldMsg(dstHostInput, 'dstHostMsg', dstHostR);
  setFieldMsg(dstPortInput, 'dstPortMsg', dstPortR);
  setFieldMsg(hostInput,    'hostMsg',    hostR);
  setFieldMsg(portInput,    'portMsg',    portR);
  setFieldMsg(optCount,     'countMsg',   countR);

  // Inspection point mask — must have at least one point selected
  let mask = '';
  if (ptI_lower.checked) mask += 'i';
  if (ptI_upper.checked) mask += 'I';
  if (ptO_lower.checked) mask += 'o';
  if (ptO_upper.checked) mask += 'O';

  const noMask = mask === '';
  if (noMask) {
    maskMsg.textContent = '⚠ Select at least one inspection point';
    maskMsg.className = 'field-msg error';
  } else {
    maskMsg.textContent = '';
    maskMsg.className = 'field-msg';
  }

  const hasErrors = noMask ||
    [srcHostR, srcPortR, dstHostR, dstPortR, hostR, portR, countR].some(r => !r.valid);

  // Assemble command
  const parts = ['fw monitor'];

  if (mask) parts.push('-m', mask);

  if (countR.valid && countR.value) parts.push('-c', countR.value);

  if (optNoResolve.checked) parts.push('-u');

  // Build the fw monitor filter expression (accept <conditions>;)
  const conditions = [];

  const proto = protoSelect.value;
  if (proto) conditions.push(`proto=${proto}`);

  const srcT = hostToken('src', srcHostR);
  if (srcT) conditions.push(srcT);

  if (srcPortR.valid && srcPortR.value) conditions.push(`sport=${srcPortR.value}`);

  const dstT = hostToken('dst', dstHostR);
  if (dstT) conditions.push(dstT);

  if (dstPortR.valid && dstPortR.value) conditions.push(`dport=${dstPortR.value}`);

  // Either direction host: expand to (src=X or dst=X)
  if (hostR.valid && hostR.type) {
    const ht_src = hostToken('src', hostR);
    const ht_dst = hostToken('dst', hostR);
    conditions.push(`(${ht_src} or ${ht_dst})`);
  }

  // Either direction port: expand to (sport=X or dport=X)
  if (portR.valid && portR.value) {
    conditions.push(`(sport=${portR.value} or dport=${portR.value})`);
  }

  const filterBody = conditions.length > 0
    ? `accept ${conditions.join(' and ')};`
    : 'accept;';

  parts.push('-e', `"${filterBody}"`);

  const outputFile = optOutput.value.trim();
  if (outputFile) {
    parts.push('-o', /[\s&|;<>()]/.test(outputFile) ? `"${outputFile}"` : outputFile);
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
  ptI_lower, ptI_upper, ptO_lower, ptO_upper,
  optCount, optOutput, optNoResolve,
  protoSelect, srcHostInput, srcPortInput, dstHostInput, dstPortInput,
  hostInput, portInput,
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

// ── Output file quick actions ─────────────────────────────────

$('fillDefaultPath').addEventListener('click', () => {
  optOutput.value = '/var/log/fw/capture.cap';
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
