'use strict';

// ─── MQTT 3.1.1 over WebSocket ───────────────────────────────────────────────
// Implements just enough of the protocol for a read-mostly topic browser:
// CONNECT, SUBSCRIBE, PUBACK/PUBREC/PUBCOMP (QoS ack), PINGREQ, DISCONNECT.

class MQTTWsClient {
  constructor() {
    this.ws            = null;
    this._buf          = new Uint8Array(0);
    this._pktId        = 1;
    this._ping         = null;
    this.onConnect     = null;   // ()
    this.onDisconnect  = null;   // ()
    this.onMessage     = null;   // (topic:string, payload:Uint8Array)
    this.onError       = null;   // (message:string)
  }

  // opts: { clientId?, username?, password? }
  connect(url, opts = {}) {
    this._close();
    // Pull credentials into a local object so we can zero them out immediately
    // after the CONNECT packet is sent, rather than holding them for the WebSocket lifetime.
    const creds = { clientId: opts.clientId, username: opts.username, password: opts.password };
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      if (this.onError) this.onError('Invalid URL: ' + e.message);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      this._onOpen(creds);
      creds.username = undefined; // drop references the moment the CONNECT packet is sent
      creds.password = undefined;
    });
    ws.addEventListener('message', e  => this._recv(new Uint8Array(e.data)));
    ws.addEventListener('error',   ()  => {
      if (this.onError) this.onError('WebSocket connection failed — verify broker address, port, WebSocket path, and that the broker has WebSocket support enabled');
    });
    ws.addEventListener('close', () => {
      clearInterval(this._ping);
      this._ping = null;
      if (this.onDisconnect) this.onDisconnect();
    });
  }

  subscribe(filter, qos = 0) {
    if (!this._ready()) return;
    const tf  = _encStr(filter);
    const pid = this._nextPktId();
    const rem = 2 + tf.length + 1;
    const p   = new Uint8Array(2 + rem);
    let i = 0;
    p[i++] = 0x82;             // SUBSCRIBE fixed header
    p[i++] = rem;
    p[i++] = (pid >> 8) & 0xFF;
    p[i++] =  pid       & 0xFF;
    p.set(tf, i); i += tf.length;
    p[i]   = qos & 0x03;
    this.ws.send(p);
  }

  disconnect() {
    if (this._ready()) this.ws.send(new Uint8Array([0xE0, 0x00]));
    this._close();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _ready() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  _nextPktId() {
    const id = this._pktId;
    this._pktId = (this._pktId % 0xFFFF) + 1;
    return id;
  }

  _close() {
    clearInterval(this._ping);
    this._ping = null;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this._buf = new Uint8Array(0);
  }

  _onOpen({ clientId, username, password } = {}) {
    const cid = _encStr(clientId || ('nt_' + Math.random().toString(36).slice(2, 9)));

    // Build connect flags: clean session always set; username/password bits conditional
    let flags = 0x02;
    const payloadParts = [cid];
    if (username) {
      flags |= 0x80;
      payloadParts.push(_encStr(username));
      if (password) {
        flags |= 0x40;
        payloadParts.push(_encStr(password));
      }
    }

    // Protocol name "MQTT" with 2-byte length prefix
    const proto  = new Uint8Array([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54]);
    // Variable header: protocol level 4 (MQTT 3.1.1), connect flags, keepalive 60s
    const varHdr = new Uint8Array([...proto, 0x04, flags, 0x00, 0x3C]);

    const payloadLen = payloadParts.reduce((sum, p) => sum + p.length, 0);
    const rem = varHdr.length + payloadLen;
    const p   = new Uint8Array(2 + rem);
    let off = 0;
    p[off++] = 0x10; // CONNECT
    p[off++] = rem;
    p.set(varHdr, off); off += varHdr.length;
    for (const part of payloadParts) { p.set(part, off); off += part.length; }
    this.ws.send(p);

    this._ping = setInterval(() => {
      if (this._ready()) this.ws.send(new Uint8Array([0xC0, 0x00])); // PINGREQ
    }, 30_000);
  }

  _recv(data) {
    const merged = new Uint8Array(this._buf.length + data.length);
    merged.set(this._buf);
    merged.set(data, this._buf.length);
    this._buf = merged;

    while (this._buf.length >= 2) {
      // Decode variable-length remaining-length field (starts at byte 1)
      let i = 1, mul = 1, rem = 0;
      do {
        if (i >= this._buf.length) return; // wait for more data
        rem += (this._buf[i] & 0x7F) * mul;
        mul *= 128;
        if (mul > 0x200000) { this._buf = new Uint8Array(0); return; } // malformed
      } while ((this._buf[i++] & 0x80) !== 0);

      const total = i + rem;
      if (this._buf.length < total) return; // wait for more data

      this._handlePkt(this._buf[0], this._buf.slice(i, total));
      this._buf = this._buf.slice(total);
    }
  }

  _handlePkt(hdr, payload) {
    const type  = hdr >> 4;
    const flags = hdr & 0x0F;

    switch (type) {
      case 2: { // CONNACK
        const rc = payload[1];
        if (rc === 0) {
          if (this.onConnect) this.onConnect();
        } else {
          const REASONS = ['', 'Unacceptable protocol version', 'Client identifier rejected',
                           'Server unavailable', 'Bad username or password', 'Not authorised'];
          if (this.onError) this.onError('Connection refused: ' + (REASONS[rc] || 'code ' + rc));
          this._close();
        }
        break;
      }
      case 3: { // PUBLISH
        const qos = (flags >> 1) & 0x03;
        let off = 0;
        const tLen  = (payload[off++] << 8) | payload[off++];
        const topic = new TextDecoder().decode(payload.slice(off, off + tLen));
        off += tLen;
        if (qos === 1) {
          const pid = (payload[off] << 8) | payload[off + 1]; off += 2;
          if (this._ready()) this.ws.send(new Uint8Array([0x40, 0x02, (pid >> 8) & 0xFF, pid & 0xFF]));
        } else if (qos === 2) {
          const pid = (payload[off] << 8) | payload[off + 1]; off += 2;
          if (this._ready()) this.ws.send(new Uint8Array([0x50, 0x02, (pid >> 8) & 0xFF, pid & 0xFF]));
        }
        if (this.onMessage) this.onMessage(topic, payload.slice(off));
        break;
      }
      case 6: { // PUBREL — send PUBCOMP for QoS 2
        const pid = (payload[0] << 8) | payload[1];
        if (this._ready()) this.ws.send(new Uint8Array([0x70, 0x02, (pid >> 8) & 0xFF, pid & 0xFF]));
        break;
      }
      // SUBACK (9), UNSUBACK (11), PINGRESP (13): no action needed
    }
  }
}

// Encode a UTF-8 string as a 2-byte-length-prefixed byte array (MQTT string format)
function _encStr(str) {
  const b = new TextEncoder().encode(str);
  const r = new Uint8Array(2 + b.length);
  r[0] = (b.length >> 8) & 0xFF;
  r[1] =  b.length       & 0xFF;
  r.set(b, 2);
  return r;
}


// ─── App State ───────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const app = {
  client:         null,
  connected:      false,
  connecting:     false,
  connectTime:    null,
  tree:           _makeNode(), // root (no segment of its own)
  totalMsgs:      0,
  topicSet:       new Set(),
  clockTick:      null,
  sessionTimeout: null,
  detailTopic:    null,        // topic currently shown in the JSON detail drawer
};

function _makeNode() {
  return {
    children:    new Map(),  // segment → child node
    value:       null,       // display string | null (null = intermediate branch)
    rawJson:     null,       // parsed JSON object/array, or null if not JSON
    topicPath:   null,       // full topic string for leaf nodes
    count:       0,          // message count at this topic path
    lastUpdated: null,       // ms timestamp
    expanded:    false,
    dom: { row: null, value: null, age: null, count: null, jsonBtn: null }
  };
}


// ─── DOM References ───────────────────────────────────────────────────────────

const _$ = id => document.getElementById(id);
const els = {
  proto:         _$('mqttProto'),
  broker:        _$('mqttBroker'),
  port:          _$('mqttPort'),
  pathGroup:     _$('mqttPathGroup'),
  path:          _$('mqttPath'),
  username:      _$('mqttUsername'),
  password:      _$('mqttPassword'),
  connectBtn:    _$('mqttConnectBtn'),
  statusDot:     _$('mqttStatusDot'),
  statusText:    _$('mqttStatusText'),
  errorMsg:      _$('mqttError'),
  hint:          _$('mqttHint'),
  proxyWarning:  _$('mqttProxyWarning'),
  treePanel:     _$('mqttTreePanel'),
  stats:         _$('mqttStats'),
  tree:          _$('mqttTree'),
  expandAll:     _$('mqttExpandAllBtn'),
  collapseAll:   _$('mqttCollapseAllBtn'),
  clearBtn:      _$('mqttClearBtn'),
  detail:        _$('mqttDetail'),
  detailHeader:  _$('mqttDetailHeader'),
  detailTopic:   _$('mqttDetailTopic'),
  detailMeta:    _$('mqttDetailMeta'),
  detailBody:    _$('mqttDetailBody'),
  detailClose:   _$('mqttDetailClose'),
};


// ─── Connection Lifecycle ─────────────────────────────────────────────────────

els.connectBtn.addEventListener('click', () => {
  if (app.connected || app.connecting) doDisconnect();
  else doConnect();
});

els.broker.addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });

function _updateProxyWarning() {
  const useWss = els.proto.value === 'wss';
  els.pathGroup.style.display      = useWss ? '' : 'none';
  els.proxyWarning.style.display   = useWss ? 'none' : '';
  els.hint.textContent = useWss
    ? 'Connects directly to the broker over WebSocket+TLS. Broker must have WebSocket support and a trusted certificate.'
    : 'Connects via local proxy over native MQTT TCP. No WebSocket required on the broker.';
  const dot  = document.getElementById('sidebarProcessingDot');
  const text = document.getElementById('sidebarProcessingText');
  if (dot && text) {
    if (useWss) {
      dot.className  = 'footer-dot online';
      text.textContent = 'all processing: local';
    } else {
      dot.className  = 'footer-dot proxy';
      text.textContent = 'MQTT: proxied via web server';
    }
  }
}

els.proto.addEventListener('change', _updateProxyWarning);
_updateProxyWarning(); // apply on page load (mqtt:// is the default)

function doConnect() {
  const broker = els.broker.value.trim();
  if (!broker) { _showError('Enter a broker address.'); return; }

  const port    = els.port.value.trim() || '1883';
  const useWss  = els.proto.value === 'wss';
  let url;
  if (useWss) {
    const wsPath = (els.path.value.trim() || '/mqtt').replace(/^\/?/, '/');
    url = `wss://${broker}:${port}${wsPath}`;
  } else {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    url = `${wsProto}://${location.host}/mqtt-proxy?host=${encodeURIComponent(broker)}&port=${encodeURIComponent(port)}`;
  }

  _hideError();
  _setStatus('connecting');
  app.connecting = true;
  els.connectBtn.textContent = 'Cancel';

  app.client = new MQTTWsClient();

  app.client.onConnect = () => {
    els.password.value  = '';   // clear after broker has accepted credentials
    app.connected       = true;
    app.connecting      = false;
    app.connectTime     = Date.now();
    app.sessionTimeout  = setTimeout(_doSessionTimeout, SESSION_TIMEOUT_MS);
    _setStatus('connected', broker + ':' + port);
    els.connectBtn.textContent = 'Disconnect';
    app.client.subscribe('#');  // browse-only: subscribe to all topics
    _startClock();
  };

  app.client.onDisconnect = () => {
    els.password.value = ''; // clear in case the broker dropped before CONNACK (onConnect never fired)
    _clearSessionTimeout();
    app.connected  = false;
    app.connecting = false;
    _setStatus('disconnected');
    els.connectBtn.textContent = 'Connect';
    _stopClock();
  };

  app.client.onError = msg => {
    els.password.value = '';   // clear on auth failure too — don't leave it in the DOM
    _clearSessionTimeout();
    app.connected  = false;
    app.connecting = false;
    _showError(msg);
    _setStatus('error');
    els.connectBtn.textContent = 'Connect';
    _stopClock();
  };

  app.client.onMessage = (topic, payload) => _handleMessage(topic, payload);

  const username = els.username.value.trim() || undefined;
  const password = els.password.value || undefined;
  app.client.connect(url, { username, password });
}

function doDisconnect() {
  _clearSessionTimeout();
  if (app.client) { app.client.disconnect(); app.client = null; }
  app.connected  = false;
  app.connecting = false;
  _setStatus('disconnected');
  els.connectBtn.textContent = 'Connect';
  _stopClock();
}

function _clearSessionTimeout() {
  clearTimeout(app.sessionTimeout);
  app.sessionTimeout = null;
}

function _doSessionTimeout() {
  doDisconnect();
  _showError('Session closed after 15 minutes. Click Connect to reconnect.');
}

// Disconnect cleanly when the user navigates away or closes the tab
window.addEventListener('beforeunload', () => {
  if (app.connected || app.connecting) doDisconnect();
});
// pagehide covers mobile browsers and bfcache cases where beforeunload doesn't fire
window.addEventListener('pagehide', () => {
  if (app.connected || app.connecting) doDisconnect();
});


// ─── Tree Controls ────────────────────────────────────────────────────────────

els.expandAll.addEventListener('click', () => {
  _setAllExpanded(app.tree, true);
  _renderTree();
});
els.collapseAll.addEventListener('click', () => {
  _setAllExpanded(app.tree, false);
  _renderTree();
});
els.clearBtn.addEventListener('click', () => {
  _closeDetail();
  app.tree      = _makeNode();
  app.totalMsgs = 0;
  app.topicSet  = new Set();
  els.tree.innerHTML          = '';
  els.treePanel.style.display = 'none';
  _updateStats();
});

function _setAllExpanded(node, val) {
  node.expanded = val;
  for (const child of node.children.values()) _setAllExpanded(child, val);
}


// ─── Message Handling ─────────────────────────────────────────────────────────

function _handleMessage(topic, payload) {
  const { text, json } = _decodePayload(payload);
  const isNew    = !app.topicSet.has(topic);
  const wasJson  = node_wasJson(topic);

  app.totalMsgs++;
  app.topicSet.add(topic);

  // Walk/build the tree and update nodes along the path
  const segments = topic.split('/');
  let node = app.tree;
  for (const seg of segments) {
    if (!node.children.has(seg)) node.children.set(seg, _makeNode());
    node = node.children.get(seg);
  }
  node.value       = text;
  node.rawJson     = json;
  node.topicPath   = topic;
  node.count       = (node.count || 0) + 1;
  node.lastUpdated = Date.now();

  _updateStats();

  if (els.treePanel.style.display === 'none') els.treePanel.style.display = '';

  const jsonStatusChanged = wasJson !== (json !== null);

  if (isNew || jsonStatusChanged) {
    // New topic or JSON status flipped — rebuild tree (preserves expanded state)
    _renderTree();
  } else if (node.dom.value) {
    // Existing topic — update in place and flash
    node.dom.value.textContent = text;
    if (node.dom.count)   node.dom.count.textContent = '×' + node.count;
    if (node.dom.age)     { node.dom.age.textContent = 'just now'; node.dom.age.dataset.ts = String(node.lastUpdated); }
    _flashRow(node.dom.row);
  }

  // Live-update the detail drawer if this topic is currently selected
  if (app.detailTopic === topic) _updateDetailContent(node);
}

function node_wasJson(topic) {
  const segments = topic.split('/');
  let node = app.tree;
  for (const seg of segments) {
    if (!node.children.has(seg)) return false;
    node = node.children.get(seg);
  }
  return node.rawJson !== null;
}

// Returns { text: string, json: object|array|null }
function _decodePayload(bytes) {
  if (bytes.length === 0) return { text: '(empty)', json: null };

  let str = null;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded)) str = decoded;
  } catch (_) { /* binary data */ }

  if (str !== null) {
    // Only treat objects and arrays as "JSON" — scalars display fine as plain text
    try {
      const parsed = JSON.parse(str);
      if (parsed !== null && typeof parsed === 'object') {
        const compact = JSON.stringify(parsed);
        const text = compact.length > 80 ? compact.slice(0, 77) + '…' : compact;
        return { text, json: parsed };
      }
    } catch (_) { /* not JSON */ }

    return { text: str.length > 300 ? str.slice(0, 300) + '…' : str, json: null };
  }

  // Binary — hex fallback
  const hex = Array.from(bytes.slice(0, 48)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  return { text: bytes.length > 48 ? hex + ' …' : hex, json: null };
}


// ─── Tree Rendering ───────────────────────────────────────────────────────────

function _renderTree() {
  els.tree.innerHTML = '';
  _renderChildren(app.tree, els.tree, 0);
}

function _renderChildren(node, container, depth) {
  const sorted = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [seg, child] of sorted) _renderNode(seg, child, container, depth);
}

function _renderNode(seg, node, container, depth) {
  const hasChildren = node.children.size > 0;

  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  // Row
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (depth * 18 + 10) + 'px';
  node.dom.row = row;

  // Expand/collapse toggle or spacer
  if (hasChildren) {
    const btn = document.createElement('button');
    btn.className = 'tree-toggle';
    btn.textContent = node.expanded ? '▾' : '▸';
    btn.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
    row.appendChild(btn);

    // Wire after childrenEl is built below
    wrap._toggleBtn = btn;
  } else {
    const sp = document.createElement('span');
    sp.className = 'tree-spacer';
    row.appendChild(sp);
  }

  // Segment label
  const segEl = document.createElement('span');
  segEl.className = hasChildren ? 'tree-segment tree-segment--branch' : 'tree-segment';
  segEl.textContent = seg;
  row.appendChild(segEl);

  // Value display (leaf or mixed node with both value and children)
  if (node.value !== null) {
    const valEl = document.createElement('span');
    valEl.className = 'tree-value';
    valEl.textContent = node.value;
    node.dom.value = valEl;
    row.appendChild(valEl);

    if (node.rawJson !== null) {
      const jsonBtn = document.createElement('button');
      jsonBtn.className = 'tree-json-btn' + (app.detailTopic === node.topicPath ? ' active' : '');
      jsonBtn.textContent = '{ }';
      jsonBtn.title = 'View full JSON';
      jsonBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (app.detailTopic === node.topicPath) {
          _closeDetail();
        } else {
          _openDetail(node);
        }
      });
      node.dom.jsonBtn = jsonBtn;
      row.appendChild(jsonBtn);
    } else {
      node.dom.jsonBtn = null;
    }

    const ageEl = document.createElement('span');
    ageEl.className = 'tree-age';
    ageEl.textContent = _formatAge(Date.now() - node.lastUpdated);
    ageEl.dataset.ts = String(node.lastUpdated);
    node.dom.age = ageEl;
    row.appendChild(ageEl);

    const cntEl = document.createElement('span');
    cntEl.className = 'tree-count';
    cntEl.textContent = '×' + node.count;
    node.dom.count = cntEl;
    row.appendChild(cntEl);
  } else {
    node.dom.value   = null;
    node.dom.jsonBtn = null;
    node.dom.age     = null;
    node.dom.count   = null;
  }

  wrap.appendChild(row);

  // Children subtree
  if (hasChildren) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    childrenEl.style.display = node.expanded ? '' : 'none';
    node.dom.children = childrenEl;

    wrap._toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      wrap._toggleBtn.textContent = node.expanded ? '▾' : '▸';
      wrap._toggleBtn.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
      childrenEl.style.display = node.expanded ? '' : 'none';
    });

    _renderChildren(node, childrenEl, depth + 1);
    wrap.appendChild(childrenEl);
  }

  container.appendChild(wrap);
}

function _flashRow(rowEl) {
  if (!rowEl) return;
  rowEl.classList.remove('tree-row--flash');
  void rowEl.offsetWidth; // force reflow to restart the animation
  rowEl.classList.add('tree-row--flash');
}


// ─── Detail Drawer ────────────────────────────────────────────────────────────

els.detailClose.addEventListener('click', _closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeDetail(); });

function _openDetail(node) {
  app.detailTopic = node.topicPath;
  els.detailTopic.textContent = node.topicPath;
  _updateDetailContent(node);
  els.detail.classList.add('open');
  els.detail.setAttribute('aria-hidden', 'false');
  // Mark the badge active in the tree
  document.querySelectorAll('.tree-json-btn.active').forEach(b => b.classList.remove('active'));
  if (node.dom.jsonBtn) node.dom.jsonBtn.classList.add('active');
}

function _closeDetail() {
  app.detailTopic = null;
  els.detail.classList.remove('open');
  els.detail.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.tree-json-btn.active').forEach(b => b.classList.remove('active'));
}

function _updateDetailContent(node) {
  els.detailBody.innerHTML = node.rawJson !== null
    ? _renderJson(node.rawJson, 0)
    : _escHtml(node.value ?? '');
  const age = node.lastUpdated ? _formatAge(Date.now() - node.lastUpdated) : '';
  els.detailMeta.textContent = `${node.count} message${node.count !== 1 ? 's' : ''} · updated ${age}`;
  // Flash the header to signal a live update
  els.detailHeader.classList.remove('mqtt-detail-header--flash');
  void els.detailHeader.offsetWidth;
  els.detailHeader.classList.add('mqtt-detail-header--flash');
}

// Recursive syntax-highlighted JSON renderer
function _renderJson(val, depth) {
  if (val === null)                  return '<span class="jn">null</span>';
  if (val === true || val === false) return `<span class="jb">${val}</span>`;
  if (typeof val === 'number')       return `<span class="jd">${val}</span>`;
  if (typeof val === 'string')       return `<span class="js">"${_escHtml(val)}"</span>`;

  const pad  = '  '.repeat(depth);
  const pad1 = '  '.repeat(depth + 1);

  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map(v => pad1 + _renderJson(v, depth + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const keys = Object.keys(val);
  if (keys.length === 0) return '{}';
  const items = keys.map(k =>
    `${pad1}<span class="jk">"${_escHtml(k)}"</span>: ${_renderJson(val[k], depth + 1)}`
  );
  return `{\n${items.join(',\n')}\n${pad}}`;
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ─── Status & Clock ───────────────────────────────────────────────────────────

function _setStatus(state, detail) {
  const cls  = { connected: 'dot--connected', connecting: 'dot--connecting', error: 'dot--error', disconnected: '' };
  els.statusDot.className = 'mqtt-status-dot ' + (cls[state] || '');
  if (state === 'connected')    els.statusText.textContent = 'connected · ' + detail;
  else if (state === 'connecting') els.statusText.textContent = 'connecting…';
  else if (state === 'error')   els.statusText.textContent = 'connection failed';
  else                          els.statusText.textContent = 'disconnected';
}

function _showError(msg) { els.errorMsg.textContent = msg; els.errorMsg.style.display = ''; }
function _hideError()    { els.errorMsg.textContent = '';  els.errorMsg.style.display = 'none'; }

function _updateStats() {
  const m = app.totalMsgs, t = app.topicSet.size;
  els.stats.textContent = `${m.toLocaleString()} message${m !== 1 ? 's' : ''} · ${t} topic${t !== 1 ? 's' : ''}`;
}

function _startClock() {
  if (app.clockTick) return;
  app.clockTick = setInterval(_tickClock, 5_000);
}

function _stopClock() {
  clearInterval(app.clockTick);
  app.clockTick = null;
}

function _tickClock() {
  // Update uptime in status
  if (app.connected && app.connectTime) {
    const s = Math.floor((Date.now() - app.connectTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${ss}s` : `${ss}s`;
    const broker = els.broker.value.trim();
    const port   = els.port.value.trim() || '1883';
    _setStatus('connected', `${broker}:${port} · ${uptime}`);
  }
  // Refresh age timestamps on visible nodes
  const now = Date.now();
  document.querySelectorAll('.tree-age[data-ts]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (ts) el.textContent = _formatAge(now - ts);
  });
}

function _formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  return Math.floor(m / 60) + 'h ago';
}
