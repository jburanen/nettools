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

  connect(url, clientId) {
    this._close();
    let ws;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch (e) {
      if (this.onError) this.onError('Invalid URL: ' + e.message);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open',    () => this._onOpen(clientId));
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

  _onOpen(clientId) {
    const cid = _encStr(clientId || ('nt_' + Math.random().toString(36).slice(2, 9)));
    // Protocol name "MQTT" with 2-byte length prefix
    const proto  = new Uint8Array([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54]);
    // Variable header: protocol level 4 (MQTT 3.1.1), connect flags 0x02 (clean session), keepalive 60s
    const varHdr = new Uint8Array([...proto, 0x04, 0x02, 0x00, 0x3C]);
    const rem    = varHdr.length + cid.length;
    const p      = new Uint8Array(2 + rem);
    p[0] = 0x10; // CONNECT
    p[1] = rem;
    p.set(varHdr, 2);
    p.set(cid, 2 + varHdr.length);
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

const app = {
  client:        null,
  connected:     false,
  connecting:    false,
  connectTime:   null,
  subscriptions: [],         // active filter strings
  tree:          _makeNode(), // root (no segment of its own)
  totalMsgs:     0,
  topicSet:      new Set(),
  clockTick:     null,
};

function _makeNode() {
  return {
    children:    new Map(),  // segment → child node
    value:       null,       // string | null (null = intermediate branch)
    count:       0,          // message count at this topic path
    lastUpdated: null,       // ms timestamp
    expanded:    true,
    dom: { row: null, value: null, age: null, count: null }
  };
}


// ─── DOM References ───────────────────────────────────────────────────────────

const _$ = id => document.getElementById(id);
const els = {
  broker:      _$('mqttBroker'),
  port:        _$('mqttPort'),
  path:        _$('mqttPath'),
  proto:       _$('mqttProto'),
  connectBtn:  _$('mqttConnectBtn'),
  statusDot:   _$('mqttStatusDot'),
  statusText:  _$('mqttStatusText'),
  errorMsg:    _$('mqttError'),
  subPanel:    _$('mqttSubPanel'),
  topicInput:  _$('mqttTopicInput'),
  subBtn:      _$('mqttSubBtn'),
  subsList:    _$('mqttSubsList'),
  treePanel:   _$('mqttTreePanel'),
  stats:       _$('mqttStats'),
  tree:        _$('mqttTree'),
  expandAll:   _$('mqttExpandAllBtn'),
  collapseAll: _$('mqttCollapseAllBtn'),
  clearBtn:    _$('mqttClearBtn'),
};


// ─── Connection Lifecycle ─────────────────────────────────────────────────────

els.connectBtn.addEventListener('click', () => {
  if (app.connected || app.connecting) doDisconnect();
  else doConnect();
});

els.broker.addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });

function doConnect() {
  const broker = els.broker.value.trim();
  if (!broker) { _showError('Enter a broker address.'); return; }

  const port  = els.port.value.trim() || '1883';
  const path  = els.path.value.trim() || '/mqtt';
  const proto = els.proto.value;
  const url   = `${proto}://${broker}:${port}${path.startsWith('/') ? path : '/' + path}`;

  _hideError();
  _setStatus('connecting');
  app.connecting = true;
  els.connectBtn.textContent = 'Cancel';

  app.client = new MQTTWsClient();

  app.client.onConnect = () => {
    app.connected   = true;
    app.connecting  = false;
    app.connectTime = Date.now();
    _setStatus('connected', broker + ':' + port);
    els.connectBtn.textContent = 'Disconnect';
    els.subPanel.style.display = '';
    // Re-subscribe to any previously active filters
    for (const f of app.subscriptions) app.client.subscribe(f);
    // Default: subscribe to all topics if nothing active
    if (app.subscriptions.length === 0) _addSub('#');
    _startClock();
  };

  app.client.onDisconnect = () => {
    const wasConn = app.connected;
    app.connected  = false;
    app.connecting = false;
    _setStatus('disconnected');
    els.connectBtn.textContent = 'Connect';
    if (wasConn) els.subPanel.style.display = 'none';
    _stopClock();
  };

  app.client.onError = msg => {
    app.connected  = false;
    app.connecting = false;
    _showError(msg);
    _setStatus('error');
    els.connectBtn.textContent = 'Connect';
    _stopClock();
  };

  app.client.onMessage = (topic, payload) => _handleMessage(topic, payload);

  app.client.connect(url);
}

function doDisconnect() {
  if (app.client) { app.client.disconnect(); app.client = null; }
  app.connected  = false;
  app.connecting = false;
  _setStatus('disconnected');
  els.connectBtn.textContent = 'Connect';
  els.subPanel.style.display = 'none';
  _stopClock();
}


// ─── Subscriptions ────────────────────────────────────────────────────────────

els.subBtn.addEventListener('click', () => _addSub(els.topicInput.value.trim() || '#'));
els.topicInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') _addSub(els.topicInput.value.trim() || '#');
});

function _addSub(filter) {
  if (!filter || app.subscriptions.includes(filter)) { els.topicInput.value = ''; return; }
  app.subscriptions.push(filter);
  if (app.connected && app.client) app.client.subscribe(filter);
  els.topicInput.value = '';
  _renderSubsList();
}

function _removeSub(filter) {
  app.subscriptions = app.subscriptions.filter(f => f !== filter);
  _renderSubsList();
}

function _renderSubsList() {
  els.subsList.innerHTML = '';
  for (const f of app.subscriptions) {
    const chip = document.createElement('div');
    chip.className = 'mqtt-sub-chip';
    const label = document.createElement('span');
    label.className = 'mqtt-sub-filter';
    label.textContent = f;
    const btn = document.createElement('button');
    btn.className = 'mqtt-sub-remove';
    btn.setAttribute('aria-label', 'Remove subscription ' + f);
    btn.textContent = '×';
    btn.addEventListener('click', () => _removeSub(f));
    chip.appendChild(label);
    chip.appendChild(btn);
    els.subsList.appendChild(chip);
  }
}


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
  app.tree      = _makeNode();
  app.totalMsgs = 0;
  app.topicSet  = new Set();
  els.tree.innerHTML       = '';
  els.treePanel.style.display = 'none';
  _updateStats();
});

function _setAllExpanded(node, val) {
  node.expanded = val;
  for (const child of node.children.values()) _setAllExpanded(child, val);
}


// ─── Message Handling ─────────────────────────────────────────────────────────

function _handleMessage(topic, payload) {
  const value  = _decodePayload(payload);
  const isNew  = !app.topicSet.has(topic);

  app.totalMsgs++;
  app.topicSet.add(topic);

  // Walk/build the tree and update nodes along the path
  const segments = topic.split('/');
  let node = app.tree;
  for (const seg of segments) {
    if (!node.children.has(seg)) node.children.set(seg, _makeNode());
    node = node.children.get(seg);
  }
  node.value       = value;
  node.count       = (node.count || 0) + 1;
  node.lastUpdated = Date.now();

  _updateStats();

  if (els.treePanel.style.display === 'none') els.treePanel.style.display = '';

  if (isNew) {
    // New topic — rebuild entire tree (preserves expanded state)
    _renderTree();
  } else if (node.dom.value) {
    // Existing topic — update DOM in place and flash
    node.dom.value.textContent = value;
    if (node.dom.count) node.dom.count.textContent = '×' + node.count;
    if (node.dom.age)   { node.dom.age.textContent = 'just now'; node.dom.age.dataset.ts = String(node.lastUpdated); }
    _flashRow(node.dom.row);
  }
}

function _decodePayload(bytes) {
  if (bytes.length === 0) return '(empty)';
  try {
    const str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(str)) {
      return str.length > 300 ? str.slice(0, 300) + '…' : str;
    }
  } catch (_) { /* not valid UTF-8, fall through to hex */ }
  const hex = Array.from(bytes.slice(0, 48)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  return bytes.length > 48 ? hex + ' …' : hex;
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
    node.dom.value = null;
    node.dom.age   = null;
    node.dom.count = null;
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
