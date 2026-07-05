'use strict';

(function () {
  const html = `
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <a href="index.html" class="logo">
      <span class="logo-bracket">[</span>
      <span class="logo-text">NET</span>
      <span class="logo-accent">TOOLS</span>
      <span class="logo-bracket">]</span>
    </a>
    <p class="logo-sub">// browser-local utilities</p>
  </div>

  <nav class="tool-nav">
    <div class="nav-section-label">// network</div>
    <a href="subnet.html" class="nav-item" data-tool="subnet">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">Subnet Calculator</span>
    </a>
    <div class="nav-section-label">// utilities</div>
    <a href="compose-converter.html" class="nav-item" data-tool="compose-converter">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">Compose Converter</span>
    </a>
    <a href="mqtt.html" class="nav-item" data-tool="mqtt">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">MQTT Client</span>
    </a>

    <div class="nav-section-label">// command builders</div>
    <a href="tcpdump.html" class="nav-item" data-tool="tcpdump">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">tcpdump</span>
    </a>
    <a href="fw-monitor.html" class="nav-item" data-tool="fw-monitor">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">fw monitor</span>
    </a>
    <div class="nav-item disabled" title="Coming soon">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">cppcap</span>
      <span class="nav-badge">2 weeks</span>
    </div>
    <a href="fw-zdebug.html" class="nav-item" data-tool="fw-zdebug">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">fw ctl zdebug</span>
    </a>

    <div class="nav-section-label">// configurators</div>
    <div class="nav-item disabled" title="Coming soon">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">Skyline</span>
      <span class="nav-badge">2 weeks</span>
    </div>
    <a href="routemap.html" class="nav-item" data-tool="routemap">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">routemap</span>
      <span class="wip-badge">WIP</span>
    </a>
    <div class="nav-item disabled" title="Coming soon">
      <span class="nav-icon">⬡</span>
      <span class="nav-label">Route-based VPN</span>
      <span class="nav-badge">2 weeks</span>
    </div>
  </nav>

  <div class="sidebar-footer">
    <span class="footer-dot online" id="sidebarProcessingDot"></span>
    <span id="sidebarProcessingText">all processing: local</span>
  </div>
  <div class="sidebar-meta">
    <a href="https://github.com/jburanen/nettools" class="meta-github" target="_blank" rel="noopener">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      github.com/jburanen/nettools
    </a>
    <p class="meta-disclaimer">Licensed under <a href="https://choosealicense.com/licenses/gpl-3.0/" class="meta-link" target="_blank" rel="noopener">GNU GPLv3</a></p>
    <p class="meta-disclaimer">Accuracy not guaranteed. If something doesn't work, it's Claude's fault.</p>
    <p class="meta-disclaimer">Got an idea? <a href="https://github.com/jburanen/nettools/issues/new?labels=enhancement" class="meta-link" target="_blank" rel="noopener">Submit an issue</a> at Github with the Enhancement label.</p>
    </div>
</aside>`;

  const mount = document.getElementById('sidebar-mount');
  if (mount) mount.outerHTML = html;

  // Optional custom brand text from /generated/config.js (.env-driven).
  // logoText keeps the primary color, logoAccent keeps the cyan accent —
  // each overrides independently; unset spans keep the built-in NET/TOOLS.
  const cfg = window.NETTOOLS_CONFIG || {};
  if (cfg.logoText) {
    const el = document.querySelector('.logo-text');
    if (el) el.textContent = cfg.logoText;
  }
  if (cfg.logoAccent) {
    const el = document.querySelector('.logo-accent');
    if (el) el.textContent = cfg.logoAccent;
  }
  if (cfg.logoSub) {
    const el = document.querySelector('.logo-sub');
    if (el) el.textContent = cfg.logoSub;
  }
  if (cfg.logoLink) {
    const el = document.querySelector('.logo');
    if (el) el.setAttribute('href', cfg.logoLink);
  }

  // Remove nav entries for modules disabled via .env (config.js has already
  // normalized cfg.disabledModules to an array of slugs).
  (cfg.disabledModules || []).forEach(slug => {
    const item = document.querySelector(`.nav-item[data-tool="${slug}"]`);
    if (item) item.remove();
  });
  // Drop any section header left with no nav items after removals.
  document.querySelectorAll('.nav-section-label').forEach(label => {
    let el = label.nextElementSibling, hasItem = false;
    while (el && !el.classList.contains('nav-section-label')) {
      if (el.classList.contains('nav-item')) { hasItem = true; break; }
      el = el.nextElementSibling;
    }
    if (!hasItem) label.remove();
  });

  // Mark the active nav item based on the current page filename
  const page = window.location.pathname.split('/').pop() || 'index.html';
  const toolMap = { 'subnet.html': 'subnet', 'tcpdump.html': 'tcpdump', 'fw-monitor.html': 'fw-monitor', 'fw-zdebug.html': 'fw-zdebug', 'compose-converter.html': 'compose-converter', 'mqtt.html': 'mqtt', 'routemap.html': 'routemap' };
  const activeTool = toolMap[page];
  if (activeTool) {
    const link = document.querySelector(`.nav-item[data-tool="${activeTool}"]`);
    if (link) link.classList.add('active');
  }

  // Mobile sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const toggle  = document.getElementById('sidebarToggle');
  if (sidebar && toggle) {
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      sidebar.classList.toggle('open');
    });
    document.addEventListener('click', e => {
      if (sidebar.classList.contains('open') &&
          !sidebar.contains(e.target) &&
          !toggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  }
})();
