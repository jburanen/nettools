/**
 * tcpdump.js — tcpdump command builder
 * Builds BPF filter expressions from form inputs, updates live, auto-copies.
 */

'use strict';

const $ = id => document.getElementById(id);

// Capture options
const ifaceInput       = $('iface');
const optVerbose       = $('optVerbose');
const optCount         = $('optCount');
const optSnaplen       = $('optSnaplen');
const optWrite         = $('optWrite');
const optNoResolve     = $('optNoResolve');
const optNoPortResolve = $('optNoPortResolve');
const optNoPromisc     = $('optNoPromisc');
const optTimestamp     = $('optTimestamp');

// Filter fields
const protoSelect  = $('proto');
const srcHostInput = $('srcHost');
const srcPortInput = $('srcPort');
const dstHostInput = $('dstHost');
const dstPortInput = $('dstPort');
const hostInput    = $('host');
const portInput    = $('port');
const extraFilter  = $('extraFilter');

// Output / sidebar
const cmdText       = $('cmdText');
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

// ── Command builder ───────────────────────────────────────────

function buildCommand() {
  const parts = ['tcpdump'];

  const iface = ifaceInput.value.trim();
  if (iface) parts.push('-i', iface);

  // -nn implies -n; avoid duplicating
  if (optNoPortResolve.checked) {
    parts.push('-nn');
  } else if (optNoResolve.checked) {
    parts.push('-n');
  }

  const verb = optVerbose.value;
  if (verb) parts.push(verb);

  if (optNoPromisc.checked) parts.push('-p');
  if (optTimestamp.checked)  parts.push('-tttt');

  const count = optCount.value.trim();
  if (count) parts.push('-c', count);

  const snaplen = optSnaplen.value.trim();
  if (snaplen) parts.push('-s', snaplen);

  const writeFile = optWrite.value.trim();
  if (writeFile) {
    parts.push('-w', /[\s&|;<>()]/.test(writeFile) ? `"${writeFile}"` : writeFile);
  }

  // BPF filter expression
  const fp = [];

  const proto = protoSelect.value;
  if (proto) fp.push(proto);

  const srcHost = srcHostInput.value.trim();
  const srcPort = srcPortInput.value.trim();
  const dstHost = dstHostInput.value.trim();
  const dstPort = dstPortInput.value.trim();
  const host    = hostInput.value.trim();
  const port    = portInput.value.trim();
  const extra   = extraFilter.value.trim();

  if (srcHost) fp.push(`src host ${srcHost}`);
  if (srcPort) fp.push(`src port ${srcPort}`);
  if (dstHost) fp.push(`dst host ${dstHost}`);
  if (dstPort) fp.push(`dst port ${dstPort}`);
  if (host)    fp.push(`host ${host}`);
  if (port)    fp.push(`port ${port}`);
  if (extra)   fp.push(extra);

  if (fp.length) {
    const filter = fp.join(' and ');
    // Quote compound expressions so the shell treats them as a single argument
    parts.push(fp.length > 1 ? `'${filter}'` : filter);
  }

  return parts.join(' ');
}

// ── Live update + auto-copy ───────────────────────────────────

let copyTimer = null;

function updateCommand() {
  const cmd = buildCommand();
  cmdText.textContent = cmd;

  clearTimeout(copyTimer);
  autoCopyNote.textContent = '';

  copyTimer = setTimeout(() => {
    navigator.clipboard.writeText(cmd).then(() => {
      autoCopyNote.textContent = '⎘ auto-copied';
      setTimeout(() => { autoCopyNote.textContent = ''; }, 2000);
    }).catch(() => {});
  }, 750);
}

const allInputs = [
  ifaceInput, optVerbose, optCount, optSnaplen, optWrite,
  optNoResolve, optNoPortResolve, optNoPromisc, optTimestamp,
  protoSelect, srcHostInput, srcPortInput, dstHostInput, dstPortInput,
  hostInput, portInput, extraFilter,
];

allInputs.forEach(el => {
  el.addEventListener('input', updateCommand);
  el.addEventListener('change', updateCommand);
});

// ── Manual copy button ────────────────────────────────────────

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
    copyFeedback.textContent = 'copy failed — select and copy manually';
  });
});

// ── Initial render ────────────────────────────────────────────

cmdText.textContent = buildCommand();
