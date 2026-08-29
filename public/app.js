'use strict';

const $ = (id) => document.getElementById(id);
const short = (h) => (h && h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h || '—');
const ZERO = '0x' + '0'.repeat(64);

/** Announce a state change to screen readers via the global live region. */
function announce(msg) {
  const a = $('announcer');
  a.textContent = '';
  // Rebreak the text node so repeated identical messages still announce.
  requestAnimationFrame(() => { a.textContent = msg; });
}

/** Toggle an async button's busy state accessibly. */
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

/** Dim + fully disable a stage for both mouse and keyboard (inert). */
function setStageDisabled(card, disabled) {
  card.classList.toggle('disabled-veil', disabled);
  if (disabled) card.setAttribute('inert', '');
  else card.removeAttribute('inert');
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

let wasUnlocked = false;

function render(s) {
  if (!s || !s.initialized) {
    $('badge').textContent = 'NO CAMPAIGN';
    $('badge').className = 'badge';
    $('badge').setAttribute('aria-label', 'Campaign status: no campaign');
    $('phraserTag').textContent = 'agent: —';
    setStageDisabled($('pledgeCard'), true);
    setStageDisabled($('coordCard'), true);
    wasUnlocked = false;
    return;
  }
  const unlocked = !!s.unlocked;

  $('phraserTag').textContent = 'agent: ' + (s.phraser || '—').replace(' (→ offline on error)', '');

  $('badge').textContent = unlocked ? 'UNLOCKED' : 'SEALED';
  $('badge').className = 'badge ' + (unlocked ? 'unlocked' : '');
  $('badge').setAttribute('aria-label', 'Campaign status: ' + (unlocked ? 'unlocked' : 'sealed'));

  $('v-init').textContent = String(s.initialized);
  $('v-unlocked').textContent = String(unlocked);
  $('v-unlocked').className = 'v ' + (unlocked ? 'true' : 'false');
  $('v-count').textContent = s.pledgeCount;
  $('v-tc').textContent = short(s.targetCommit);
  $('v-tc').className = 'v muted';
  $('v-thc').textContent = short(s.thresholdCommit);
  $('v-thc').className = 'v muted';
  const rtShown = s.revealedTarget && s.revealedTarget !== ZERO;
  $('v-rt').textContent = rtShown ? short(s.revealedTarget) : '— (zero until reveal)';
  $('v-rt').className = 'v ' + (rtShown ? 'true' : 'muted');

  // opaque commitments list (append only the new ones)
  const box = $('commits');
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

  // reveal box
  const rb = $('revealBox');
  const rt = $('revealTarget');
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

  // EVM panel
  $('e-addr').textContent = short(s.evmAddress);
  $('e-relayer').textContent = short(s.relayer);
  $('e-unlocked').textContent = String(!!s.evmUnlocked);
  $('e-unlocked').className = 'v ' + (s.evmUnlocked ? 'true' : 'false');
  if (s.settlementEvent) $('e-event').textContent = s.settlementEvent;
  if (s.settlementGas) $('e-gas').textContent = s.settlementGas;

  // enable/disable stages (both mouse and keyboard)
  setStageDisabled($('pledgeCard'), unlocked);
  setStageDisabled($('coordCard'), unlocked);

  // announce the pivotal transition once
  if (unlocked && !wasUnlocked) {
    announce('Threshold reached. Midnight proof valid. Coordinated action settled cross-chain. Revealed target: ' + (s.revealedTargetText || ''));
  }
  wasUnlocked = unlocked;
}

function logCoord(text, fired) {
  const log = $('coordLog');
  const e = document.createElement('div');
  e.className = 'entry';
  e.style.color = fired ? 'var(--green)' : 'var(--steel)';
  e.textContent = text;
  log.prepend(e);
}

// ---- actions ----
$('createBtn').onclick = async () => {
  $('campaignErr').textContent = '';
  const target = $('target').value.trim();
  const threshold = Number($('threshold').value);
  if (!target) { $('campaignErr').textContent = 'Enter a target first.'; $('target').focus(); return; }
  if (!Number.isInteger(threshold) || threshold < 1) { $('campaignErr').textContent = 'Threshold must be a whole number ≥ 1.'; $('threshold').focus(); return; }
  try {
    busy($('createBtn'), true, 'Deploying sealed campaign + EVM settler…');
    $('commits').innerHTML = '';
    $('phrasedOut').innerHTML = '';
    $('coordLog').innerHTML = '';
    $('e-event').textContent = '—';
    $('e-gas').textContent = '—';
    const s = await api('/api/campaign', { target, threshold });
    render(s);
    announce('Sealed campaign created with a hidden threshold. The ledger reveals only opaque commitments.');
    $('intent').focus();
  } catch (e) {
    $('campaignErr').textContent = e.message;
  } finally {
    busy($('createBtn'), false);
  }
};

$('pledgeBtn').onclick = async () => {
  $('pledgeErr').textContent = '';
  const intent = $('intent').value.trim();
  if (!intent) { $('pledgeErr').textContent = 'Type an intent first.'; $('intent').focus(); return; }
  try {
    busy($('pledgeBtn'), true, 'AI phrasing + sealing…');
    const r = await api('/api/pledge', { rawIntent: intent });
    $('phrasedOut').innerHTML =
      `<div class="phrased"><span class="who">AI (${escapeHtml((r.phraser||'').replace(' (→ offline on error)',''))}) phrased →</span>${escapeHtml(r.phrased)}</div>`;
    $('intent').value = '';
    render(r.snapshot);
    announce(`Pledge sealed. ${r.snapshot.pledgeCount} opaque commitment${r.snapshot.pledgeCount === 1 ? '' : 's'} on the ledger. Still sealed.`);
    $('intent').focus();
  } catch (e) {
    $('pledgeErr').textContent = e.message;
  } finally {
    busy($('pledgeBtn'), false);
  }
};

$('coordBtn').onclick = async () => {
  try {
    busy($('coordBtn'), true, 'Checking Midnight proof…');
    const r = await api('/api/coordinate', {});
    render(r.snapshot);
    if (r.fired) {
      logCoord('FIRED — proof valid, relayed to EVM chain.', true);
      const ev = r.settlement && r.settlement.event;
      $('e-event').textContent = ev ? 'CollectiveActionUnlocked' : '—';
      $('e-gas').textContent = r.settlement ? r.settlement.gasUsed : '—';
      $('evmCard').classList.add('fired-flash');
      setTimeout(() => $('evmCard').classList.remove('fired-flash'), 700);
    } else {
      logCoord('HELD — ' + r.reason, false);
      announce('Coordinator held. Midnight proof reports the threshold is not reached. Nothing crossed chains.');
    }
  } catch (e) {
    logCoord('error: ' + e.message, false);
  } finally {
    busy($('coordBtn'), false);
  }
};

$('resetBtn').onclick = async () => {
  await api('/api/reset', {});
  $('commits').innerHTML = '';
  $('phrasedOut').innerHTML = '';
  $('coordLog').innerHTML = '';
  $('e-event').textContent = '—';
  $('e-gas').textContent = '—';
  wasUnlocked = false;
  render({ initialized: false });
  announce('Reset. No campaign.');
  $('target').focus();
};

// Keyboard: Enter submits the target field and the pledge textarea (Shift+Enter = newline).
$('target').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('createBtn').click(); } });
$('threshold').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('createBtn').click(); } });
$('intent').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('pledgeBtn').click(); }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// initial load
api('/api/state').then(render).catch(() => render({ initialized: false }));
