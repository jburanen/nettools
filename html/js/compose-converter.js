'use strict';

const $ = id => document.getElementById(id);

const converterInput      = $('converterInput');
const detectionBadge      = $('detectionBadge');
const outputPanel         = $('outputPanel');
const outputLabel         = $('outputLabel');
const outputBlocks        = $('outputBlocks');
const warningList         = $('warningList');
const copyOutputBtn       = $('copyOutputBtn');
const copyOutputFeedback  = $('copyOutputFeedback');

// ── Detection ─────────────────────────────────────────────────

function detectInput(text) {
  const t = text.trim().replace(/\\\n\s*/g, ' ');
  if (!t) return 'empty';
  if (/^docker\s+run\s/i.test(t)) return 'docker-run';
  if (/^(version\s*:|services\s*:)/m.test(t)) return 'compose';
  return 'unknown';
}

// ── Shell tokenizer ───────────────────────────────────────────

function tokenizeShell(cmd) {
  const tokens = [];
  let cur = '', inSq = false, inDq = false, i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inSq) {
      if (ch === "'") inSq = false; else cur += ch;
    } else if (inDq) {
      if (ch === '"') inDq = false;
      else if (ch === '\\' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === "'") {
      inSq = true;
    } else if (ch === '"') {
      inDq = true;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ── docker run → compose ──────────────────────────────────────

function parseDockerRun(raw) {
  const cmd = raw.replace(/\\\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = tokenizeShell(cmd);

  const r = {
    name: null, image: null, command: [],
    ports: [], environment: [], volumes: [], networks: [],
    restart: null, hostname: null, user: null, working_dir: null,
    env_file: [], labels: [], entrypoint: null, network_mode: null,
    privileged: false, read_only: false, stdin_open: false, tty: false,
    mem_limit: null, cpu_shares: null,
    cap_add: [], cap_drop: [], devices: [], dns: [], extra_hosts: [], links: [],
  };

  const NEED_VALUE = new Set([
    '--name', '-p', '--publish', '-e', '--env', '-v', '--volume',
    '--network', '--net', '--restart', '--hostname', '-h', '-u', '--user',
    '-w', '--workdir', '--env-file', '-l', '--label', '--entrypoint',
    '-m', '--memory', '--cpu-shares', '--link', '--device', '--dns',
    '--add-host', '--cap-add', '--cap-drop',
  ]);

  let i = 0;
  if (tokens[i] === 'docker') i++;
  if (tokens[i] === 'run') i++;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (!tok.startsWith('-')) {
      r.image = tok;
      r.command = tokens.slice(i + 1);
      break;
    }

    // --flag=value form
    let flag = tok, value = null;
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      flag = tok.slice(0, eq);
      value = tok.slice(eq + 1);
    }

    // Combined short flags: -it, -di, etc.
    if (/^-[a-zA-Z]{2,}$/.test(flag) && !flag.startsWith('--')) {
      for (const ch of flag.slice(1)) {
        if (ch === 'i') r.stdin_open = true;
        else if (ch === 't') r.tty = true;
      }
      i++; continue;
    }

    if (NEED_VALUE.has(flag) && value === null) value = tokens[++i];

    switch (flag) {
      case '--name':        r.name = value; break;
      case '-p':
      case '--publish':     r.ports.push(value); break;
      case '-e':
      case '--env':         r.environment.push(value); break;
      case '-v':
      case '--volume':      r.volumes.push(value); break;
      case '--network':
      case '--net':
        if (value === 'host' || value === 'none') r.network_mode = value;
        else r.networks.push(value);
        break;
      case '--restart':     r.restart = value; break;
      case '--hostname':
      case '-h':            r.hostname = value; break;
      case '-u':
      case '--user':        r.user = value; break;
      case '-w':
      case '--workdir':     r.working_dir = value; break;
      case '--env-file':    r.env_file.push(value); break;
      case '-l':
      case '--label':       r.labels.push(value); break;
      case '--entrypoint':  r.entrypoint = value; break;
      case '-m':
      case '--memory':      r.mem_limit = value; break;
      case '--cpu-shares':  r.cpu_shares = value; break;
      case '--link':        r.links.push(value); break;
      case '--device':      r.devices.push(value); break;
      case '--dns':         r.dns.push(value); break;
      case '--add-host':    r.extra_hosts.push(value); break;
      case '--cap-add':     r.cap_add.push(value); break;
      case '--cap-drop':    r.cap_drop.push(value); break;
      case '--privileged':  r.privileged = true; break;
      case '--read-only':   r.read_only = true; break;
      case '-i':            r.stdin_open = true; break;
      case '-t':            r.tty = true; break;
      // ignored: -d, --detach, --rm, --pull, --platform, --pid, --ipc, etc.
    }
    i++;
  }
  return r;
}

function renderCompose(p) {
  if (!p.image) return { error: 'No image found in the docker run command.' };

  const warnings = [];
  const svcName = (p.name || p.image.split('/').pop().split(':')[0] || 'app')
    .replace(/[^a-z0-9_-]/gi, '_').toLowerCase();

  const I = n => ' '.repeat(n);
  const lines = ['services:', `${I(2)}${svcName}:`, `${I(4)}image: ${p.image}`];

  if (p.name)         lines.push(`${I(4)}container_name: ${p.name}`);
  if (p.restart)      lines.push(`${I(4)}restart: ${p.restart}`);
  if (p.network_mode) lines.push(`${I(4)}network_mode: ${p.network_mode}`);
  if (p.hostname)     lines.push(`${I(4)}hostname: ${p.hostname}`);
  if (p.user)         lines.push(`${I(4)}user: "${p.user}"`);
  if (p.working_dir)  lines.push(`${I(4)}working_dir: ${p.working_dir}`);
  if (p.privileged)   lines.push(`${I(4)}privileged: true`);
  if (p.read_only)    lines.push(`${I(4)}read_only: true`);
  if (p.stdin_open)   lines.push(`${I(4)}stdin_open: true`);
  if (p.tty)          lines.push(`${I(4)}tty: true`);
  if (p.mem_limit)    lines.push(`${I(4)}mem_limit: ${p.mem_limit}`);
  if (p.cpu_shares)   lines.push(`${I(4)}cpu_shares: ${p.cpu_shares}`);
  if (p.entrypoint)   lines.push(`${I(4)}entrypoint: ${p.entrypoint}`);

  if (p.command.length === 1) {
    lines.push(`${I(4)}command: ${p.command[0]}`);
  } else if (p.command.length > 1) {
    lines.push(`${I(4)}command:`);
    p.command.forEach(c => lines.push(`${I(6)}- ${c}`));
  }

  if (p.ports.length) {
    lines.push(`${I(4)}ports:`);
    p.ports.forEach(v => lines.push(`${I(6)}- "${v}"`));
  }
  if (p.environment.length) {
    lines.push(`${I(4)}environment:`);
    p.environment.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.env_file.length) {
    lines.push(`${I(4)}env_file:`);
    p.env_file.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.volumes.length) {
    lines.push(`${I(4)}volumes:`);
    p.volumes.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.networks.length) {
    lines.push(`${I(4)}networks:`);
    p.networks.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.labels.length) {
    lines.push(`${I(4)}labels:`);
    p.labels.forEach(v => lines.push(`${I(6)}- "${v}"`));
  }
  if (p.cap_add.length) {
    lines.push(`${I(4)}cap_add:`);
    p.cap_add.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.cap_drop.length) {
    lines.push(`${I(4)}cap_drop:`);
    p.cap_drop.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.devices.length) {
    lines.push(`${I(4)}devices:`);
    p.devices.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.dns.length) {
    lines.push(`${I(4)}dns:`);
    p.dns.forEach(v => lines.push(`${I(6)}- ${v}`));
  }
  if (p.extra_hosts.length) {
    lines.push(`${I(4)}extra_hosts:`);
    p.extra_hosts.forEach(v => lines.push(`${I(6)}- "${v}"`));
  }
  if (p.links.length) {
    lines.push(`${I(4)}links:  # deprecated — prefer shared networks`);
    p.links.forEach(v => lines.push(`${I(6)}- ${v}`));
    warnings.push('--link is deprecated. Use a shared network instead.');
  }

  const externalNets = p.networks.filter(n => n !== 'bridge' && n !== 'host' && n !== 'none');
  if (externalNets.length) {
    lines.push('', 'networks:');
    externalNets.forEach(n => {
      lines.push(`${I(2)}${n}:`);
      lines.push(`${I(4)}external: true`);
    });
  }

  return { output: lines.join('\n'), warnings };
}

// ── YAML parser (compose subset) ──────────────────────────────

function parseYAML(text) {
  const toks = [];
  for (const raw of text.split('\n')) {
    // Strip inline comments, respecting quoted strings
    let stripped = '', inSq = false, inDq = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "'" && !inDq) inSq = !inSq;
      else if (c === '"' && !inSq) inDq = !inDq;
      else if (c === '#' && !inSq && !inDq) break;
      stripped += c;
    }
    const trimmed = stripped.trimEnd();
    if (!trimmed.trim()) continue;
    toks.push({ indent: trimmed.search(/\S/), content: trimmed.trim() });
  }

  let pos = 0;
  const peek    = () => pos < toks.length ? toks[pos] : null;
  const consume = () => toks[pos++];

  function scalar(s) {
    s = s.trim();
    if (!s) return null;
    if ((s[0] === '"' && s[s.length - 1] === '"') ||
        (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1);
    if (s === 'true')  return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    return s;
  }

  function flowSeq(s) {
    s = s.trim();
    if (!s.startsWith('[') || !s.endsWith(']')) return null;
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let cur = '', inQ = false, qc = '';
    for (const c of inner) {
      if (!inQ && (c === '"' || c === "'")) { inQ = true; qc = c; cur += c; }
      else if (inQ && c === qc)             { inQ = false; cur += c; }
      else if (!inQ && c === ',')           { items.push(scalar(cur.trim())); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) items.push(scalar(cur.trim()));
    return items;
  }

  function node(baseIndent) {
    const first = peek();
    if (!first || first.indent < baseIndent) return null;
    return (first.content.startsWith('- ') || first.content === '-')
      ? seq(first.indent)
      : map(first.indent);
  }

  function map(baseIndent) {
    const obj = {};
    while (true) {
      const t = peek();
      if (!t || t.indent < baseIndent) break;
      if (t.indent > baseIndent) { consume(); continue; }
      if (t.content.startsWith('- ')) break;
      consume();
      const ci = t.content.indexOf(':');
      if (ci === -1) continue;
      const key    = t.content.slice(0, ci).trim();
      const rawVal = t.content.slice(ci + 1).trim();
      if (!rawVal || rawVal === '|' || rawVal === '>') {
        const next = peek();
        obj[key] = (next && next.indent > baseIndent) ? node(next.indent) : null;
      } else if (rawVal.startsWith('[')) {
        obj[key] = flowSeq(rawVal) ?? scalar(rawVal);
      } else {
        obj[key] = scalar(rawVal);
      }
    }
    return obj;
  }

  function seq(baseIndent) {
    const arr = [];
    while (true) {
      const t = peek();
      if (!t || t.indent < baseIndent) break;
      if (t.indent > baseIndent) { consume(); continue; }
      if (!t.content.startsWith('- ') && t.content !== '-') break;
      consume();
      const item = t.content === '-' ? '' : t.content.slice(2).trim();
      if (!item) {
        const next = peek();
        arr.push((next && next.indent > baseIndent) ? node(next.indent) : null);
      } else if (item.includes(':') && !/^["']/.test(item)) {
        // Inline mapping: - key: value
        const ci = item.indexOf(':');
        const k  = item.slice(0, ci).trim();
        const v  = item.slice(ci + 1).trim();
        const inner = { [k]: v ? scalar(v) : null };
        if (!v) {
          const next = peek();
          if (next && next.indent > baseIndent) Object.assign(inner, map(next.indent));
        }
        arr.push(inner);
      } else {
        arr.push(scalar(item));
      }
    }
    return arr;
  }

  return map(0);
}

// ── compose → docker run ──────────────────────────────────────

function sq(s) {
  s = String(s);
  return /[ \t"'\\#&|;<>()$`!]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function asList(v) {
  if (Array.isArray(v)) return v.filter(x => x !== null && x !== undefined).map(String);
  if (v !== null && v !== undefined) return [String(v)];
  return [];
}

function renderDockerRun(svcName, svc, warnings) {
  if (svc.build && !svc.image) {
    warnings.push(`${svcName}: uses build: — build the image first, then replace with image: <tag>.`);
    return null;
  }
  if (!svc.image) {
    warnings.push(`${svcName}: no image specified — skipped.`);
    return null;
  }

  const parts = ['docker run -d'];
  parts.push(`--name ${svc.container_name || svcName}`);

  if (svc.restart)      parts.push(`--restart ${svc.restart}`);
  if (svc.network_mode) parts.push(`--network ${svc.network_mode}`);
  if (svc.hostname)     parts.push(`--hostname ${svc.hostname}`);
  if (svc.user)         parts.push(`--user ${sq(svc.user)}`);
  if (svc.working_dir)  parts.push(`--workdir ${svc.working_dir}`);
  if (svc.privileged)   parts.push('--privileged');
  if (svc.read_only)    parts.push('--read-only');
  if (svc.stdin_open)   parts.push('-i');
  if (svc.tty)          parts.push('-t');
  if (svc.mem_limit)    parts.push(`--memory ${svc.mem_limit}`);
  if (svc.cpu_shares)   parts.push(`--cpu-shares ${svc.cpu_shares}`);

  asList(svc.ports).forEach(p => parts.push(`-p ${p}`));

  const env = svc.environment;
  if (Array.isArray(env)) {
    env.forEach(e => parts.push(`-e ${sq(String(e))}`));
  } else if (env && typeof env === 'object') {
    Object.entries(env).forEach(([k, v]) => parts.push(`-e ${sq(`${k}=${v ?? ''}`)}`));
  }

  asList(svc.env_file).forEach(f => parts.push(`--env-file ${f}`));
  asList(svc.volumes).forEach(v => parts.push(`-v ${v}`));

  const nets = svc.networks;
  if (Array.isArray(nets)) {
    nets.forEach(n => {
      const name = (n && typeof n === 'object') ? Object.keys(n)[0] : String(n);
      if (name !== 'bridge' && name !== 'default') parts.push(`--network ${name}`);
    });
  } else if (nets && typeof nets === 'object') {
    Object.keys(nets).forEach(n => {
      if (n !== 'bridge' && n !== 'default') parts.push(`--network ${n}`);
    });
  }

  const labels = svc.labels;
  if (Array.isArray(labels)) {
    labels.forEach(l => parts.push(`--label ${sq(String(l))}`));
  } else if (labels && typeof labels === 'object') {
    Object.entries(labels).forEach(([k, v]) => parts.push(`--label ${sq(`${k}=${v}`)}`));
  }

  asList(svc.cap_add).forEach(c => parts.push(`--cap-add ${c}`));
  asList(svc.cap_drop).forEach(c => parts.push(`--cap-drop ${c}`));
  asList(svc.devices).forEach(d => parts.push(`--device ${d}`));
  asList(svc.dns).forEach(d => parts.push(`--dns ${d}`));
  asList(svc.extra_hosts).forEach(h => parts.push(`--add-host ${sq(String(h))}`));

  if (svc.entrypoint) {
    const ep = Array.isArray(svc.entrypoint) ? svc.entrypoint.join(' ') : String(svc.entrypoint);
    parts.push(`--entrypoint ${sq(ep)}`);
  }

  if (svc.depends_on)  warnings.push(`${svcName}: depends_on omitted — start dependencies manually.`);
  if (svc.logging)     warnings.push(`${svcName}: logging config omitted — use --log-driver / --log-opt.`);
  if (svc.healthcheck) warnings.push(`${svcName}: healthcheck omitted — add --health-* flags manually.`);
  if (svc.deploy)      warnings.push(`${svcName}: deploy config omitted (Swarm/resource constraints).`);
  if (svc.build && svc.image) warnings.push(`${svcName}: build config omitted — using image: ${svc.image}.`);

  parts.push(svc.image);

  if (svc.command) {
    const cmd = Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command);
    parts.push(cmd);
  }

  return parts.join(' \\\n  ');
}

function composeToDockerRun(text) {
  let parsed;
  try { parsed = parseYAML(text); } catch (e) { return { error: `YAML parse error: ${e.message}` }; }
  if (!parsed || !parsed.services) {
    return { error: 'No services: block found. Is this a valid docker-compose file?' };
  }

  const warnings = [];
  const results  = [];

  for (const [name, svc] of Object.entries(parsed.services)) {
    const cmd = renderDockerRun(name, svc || {}, warnings);
    if (cmd) results.push({ name, cmd });
  }

  if (!results.length) return { error: 'No convertible services found.' };
  return { results, warnings };
}

// ── UI ────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showError(msg) {
  outputPanel.style.display = 'block';
  outputBlocks.innerHTML = `<div class="convert-error">⚠ ${escHtml(msg)}</div>`;
  warningList.innerHTML  = '';
  copyOutputBtn.style.display = 'none';
}

function showOutput(blocks, warnings) {
  outputPanel.style.display   = 'block';
  copyOutputBtn.style.display = '';

  outputBlocks.innerHTML = blocks.map(b => {
    const lbl = b.label ? `<div class="service-block-label">${escHtml(b.label)}</div>` : '';
    return `${lbl}<pre class="compose-output-pre">${escHtml(b.text)}</pre>`;
  }).join('');

  warningList.innerHTML = warnings.length
    ? '<ul class="warning-items">' +
      warnings.map(w => `<li>${escHtml(w)}</li>`).join('') +
      '</ul>'
    : '';
}

function getAllOutputText() {
  return Array.from(outputBlocks.querySelectorAll('pre'))
    .map(el => el.textContent)
    .join('\n\n');
}

function update() {
  const text = converterInput.value;
  const type = detectInput(text);

  if (type === 'empty') {
    detectionBadge.textContent = '';
    detectionBadge.className   = 'detection-badge';
    outputPanel.style.display  = 'none';
    return;
  }

  if (type === 'unknown') {
    detectionBadge.textContent = '⚠ not recognized — paste a docker run command or docker-compose.yml';
    detectionBadge.className   = 'detection-badge detection-unknown';
    outputPanel.style.display  = 'none';
    return;
  }

  if (type === 'docker-run') {
    detectionBadge.textContent = '→ docker run detected — converting to docker-compose.yml';
    detectionBadge.className   = 'detection-badge detection-run';
    const result = renderCompose(parseDockerRun(text));
    if (result.error) { showError(result.error); return; }
    outputLabel.textContent = '// docker-compose.yml';
    showOutput([{ label: null, text: result.output }], result.warnings);
    return;
  }

  if (type === 'compose') {
    detectionBadge.textContent = '→ compose file detected — converting to docker run';
    detectionBadge.className   = 'detection-badge detection-compose';
    const result = composeToDockerRun(text);
    if (result.error) { showError(result.error); return; }
    outputLabel.textContent = result.results.length === 1
      ? '// docker run command'
      : `// docker run commands (${result.results.length} services)`;
    showOutput(
      result.results.map(r => ({
        label: result.results.length > 1 ? `# ${r.name}` : null,
        text:  r.cmd,
      })),
      result.warnings,
    );
  }
}

let debounce = null;
converterInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(update, 300);
});

copyOutputBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(getAllOutputText()).then(() => {
    copyOutputFeedback.textContent = 'copied!';
    copyOutputFeedback.classList.add('copied');
    copyOutputBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyOutputFeedback.textContent = '';
      copyOutputFeedback.classList.remove('copied');
      copyOutputBtn.textContent = 'Copy';
    }, 1500);
  }).catch(() => {
    copyOutputFeedback.textContent = 'copy failed — select manually';
  });
});
