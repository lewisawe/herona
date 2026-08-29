'use strict';
/* Shared helpers used across the organizer / participant / coordinator pages. */

const $ = (id) => document.getElementById(id);
const short = (h) => (h && h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h || '—');
const ZERO = '0x' + '0'.repeat(64);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function announce(msg) {
  const a = $('announcer');
  if (!a) return;
  a.textContent = '';
  requestAnimationFrame(() => { a.textContent = msg; });
}

function busy(btn, isBusy, busyLabel) {
  if (isBusy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  // +2px guards against sub-pixel rounding that can clip the last line.
  el.style.height = (el.scrollHeight + 2) + 'px';
}

// Re-measure autogrow textareas once web fonts finish loading (scrollHeight is
// wrong while the fallback font is still in use, which can clip initial text).
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    document.querySelectorAll('textarea.autogrow').forEach((el) => autoGrow(el));
  });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/**
 * Render the shared "on-chain observer" panel from a snapshot.
 * Expects elements: badge, v-init, v-unlocked, v-count, v-tc, v-thc, v-rt,
 * commits, revealBox, revealTarget, and optionally the EVM panel ids.
 */
function renderObserver(s) {
  if (!s || !s.initialized) {
    if ($('badge')) { $('badge').textContent = 'NO CAMPAIGN'; $('badge').className = 'badge'; }
    return;
  }
  const unlocked = !!s.unlocked;
  if ($('badge')) {
    $('badge').textContent = unlocked ? 'UNLOCKED' : 'SEALED';
    $('badge').className = 'badge ' + (unlocked ? 'unlocked' : '');
    $('badge').setAttribute('aria-label', 'Campaign status: ' + (unlocked ? 'unlocked' : 'sealed'));
  }
  if ($('v-init')) $('v-init').textContent = String(s.initialized);
  if ($('v-unlocked')) { $('v-unlocked').textContent = String(unlocked); $('v-unlocked').className = 'v ' + (unlocked ? 'true' : 'false'); }
  if ($('v-count')) $('v-count').textContent = s.pledgeCount;
  if ($('v-tc')) { $('v-tc').textContent = short(s.targetCommit); $('v-tc').className = 'v muted'; }
  if ($('v-thc')) { $('v-thc').textContent = short(s.thresholdCommit); $('v-thc').className = 'v muted'; }
  if ($('v-rt')) {
    const rtShown = s.revealedTarget && s.revealedTarget !== ZERO;
    $('v-rt').textContent = rtShown ? short(s.revealedTarget) : '— (zero until reveal)';
    $('v-rt').className = 'v ' + (rtShown ? 'true' : 'muted');
  }

  const box = $('commits');
  if (box) {
    const existing = box.children.length;
    const commits = s.commitments || [];
    if (commits.length === 0) box.innerHTML = '';
    commits.forEach((c, i) => {
      if (i < existing) return;
      const div = document.createElement('div');
      div.className = 'commit';
      div.textContent = c;
      box.appendChild(div);
    });
  }

  const rb = $('revealBox');
  const rt = $('revealTarget');
  if (rb && rt) {
    if (unlocked && s.revealedTargetText) {
      rb.className = 'reveal-box on';
      rb.childNodes[0].nodeValue = 'Threshold reached. Midnight proved it in zero-knowledge. Revealed target:';
      rt.style.display = 'block';
      rt.textContent = '“' + s.revealedTargetText + '”';
    } else {
      rb.className = 'reveal-box';
      rb.childNodes[0].nodeValue = 'Before the hidden threshold: the target stays hidden. No first-mover risk. ';
      rt.style.display = 'none';
    }
  }

  // EVM panel (present on coordinator page)
  if ($('e-addr')) $('e-addr').textContent = short(s.evmAddress);
  if ($('e-relayer')) $('e-relayer').textContent = short(s.relayer);
  if ($('e-unlocked')) { $('e-unlocked').textContent = String(!!s.evmUnlocked); $('e-unlocked').className = 'v ' + (s.evmUnlocked ? 'true' : 'false'); }
  if ($('e-event') && s.settlementEvent) $('e-event').textContent = s.settlementEvent;
  if ($('e-gas') && s.settlementGas) $('e-gas').textContent = s.settlementGas;
  if ($('e-network') && s.evmNetwork) $('e-network').textContent = s.evmNetwork;
  if ($('e-tx') && s.settlementTx) {
    const link = $('e-tx');
    link.innerHTML = s.settlementExplorer
      ? `<a href="${s.settlementExplorer}" target="_blank" rel="noopener">${short(s.settlementTx)}</a>`
      : short(s.settlementTx);
  }
}

/** Poll /api/state and re-render the observer, for pages that watch live. */
function startObserverPolling(intervalMs = 1500) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try { renderObserver(await api('/api/state')); } catch { /* ignore transient */ }
    if (!stopped) setTimeout(tick, intervalMs);
  }
  tick();
  return () => { stopped = true; };
}

/** Build the shared nav bar. `active` is 'organizer' | 'pledge' | 'coordinator'. */
function navHtml(active) {
  const tab = (href, key, label) =>
    `<a class="tab ${active === key ? 'active' : ''}" href="${href}">${label}</a>`;
  return `
    <a class="home" href="/">
      <svg viewBox="0 0 24 24" fill="none" stroke="#ffb200" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      Sealed Collective Action
    </a>
    ${tab('/', 'organizer', 'Organizer')}
    ${tab('/pledge', 'pledge', 'Pledge')}
    ${tab('/coordinator', 'coordinator', 'Coordinator')}
  `;
}
