'use strict';

const $ = (id) => document.getElementById(id);
const short = (h) => (h && h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h || '—');
const ZERO = '0x' + '0'.repeat(64);

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

function render(s) {
  if (!s || !s.initialized) {
    $('badge').textContent = 'NO CAMPAIGN';
    $('badge').className = 'badge sealed';
    $('phraserTag').textContent = 'agent: —';
    return;
  }
  const unlocked = !!s.unlocked;

  $('phraserTag').textContent = 'agent: ' + (s.phraser || '—').replace(' (→ offline on error)', '');

  $('badge').textContent = unlocked ? 'UNLOCKED' : 'SEALED';
  $('badge').className = 'badge ' + (unlocked ? 'unlocked' : 'sealed');

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

  // opaque commitments list
  const box = $('commits');
  const existing = box.children.length;
  (s.commitments || []).forEach((c, i) => {
    if (i < existing) return;
    const div = document.createElement('div');
    div.className = 'commit';
    div.textContent = c;
    box.appendChild(div);
  });
  if (!s.commitments || s.commitments.length === 0) box.innerHTML = '';

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

  // enable/disable stages
  $('pledgeCard').classList.toggle('disabled-veil', !s.initialized || unlocked);
  $('coordCard').classList.toggle('disabled-veil', !s.initialized || unlocked);
}

function logCoord(text, fired) {
  const log = $('coordLog');
  const e = document.createElement('div');
  e.className = 'entry';
  e.style.color = fired ? 'var(--success)' : 'var(--muted-fg)';
  e.textContent = text;
  log.prepend(e);
}

// ---- actions ----
$('createBtn').onclick = async () => {
  $('campaignErr').textContent = '';
  try {
    $('createBtn').disabled = true;
    $('createBtn').textContent = 'Deploying sealed campaign + EVM settler…';
    $('commits').innerHTML = '';
    $('phrasedOut').innerHTML = '';
    $('coordLog').innerHTML = '';
    const s = await api('/api/campaign', {
      target: $('target').value,
      threshold: Number($('threshold').value),
    });
    render(s);
  } catch (e) {
    $('campaignErr').textContent = e.message;
  } finally {
    $('createBtn').disabled = false;
    $('createBtn').textContent = 'Create sealed campaign';
  }
};

$('pledgeBtn').onclick = async () => {
  $('pledgeErr').textContent = '';
  const intent = $('intent').value.trim();
  if (!intent) { $('pledgeErr').textContent = 'Type an intent first.'; return; }
  try {
    $('pledgeBtn').disabled = true;
    $('pledgeBtn').textContent = 'AI phrasing + sealing…';
    const r = await api('/api/pledge', { rawIntent: intent });
    $('phrasedOut').innerHTML =
      `<div class="phrased"><span class="who">AI (${(r.phraser||'').replace(' (→ offline on error)','')}) phrased →</span>${escapeHtml(r.phrased)}</div>`;
    $('intent').value = '';
    render(r.snapshot);
  } catch (e) {
    $('pledgeErr').textContent = e.message;
  } finally {
    $('pledgeBtn').disabled = false;
    $('pledgeBtn').textContent = 'Submit private pledge';
  }
};

$('coordBtn').onclick = async () => {
  try {
    $('coordBtn').disabled = true;
    $('coordBtn').textContent = 'Checking Midnight proof…';
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
    }
  } catch (e) {
    logCoord('error: ' + e.message, false);
  } finally {
    $('coordBtn').disabled = false;
    $('coordBtn').textContent = 'Attempt coordinated reveal';
  }
};

$('resetBtn').onclick = async () => {
  await api('/api/reset', {});
  $('commits').innerHTML = '';
  $('phrasedOut').innerHTML = '';
  $('coordLog').innerHTML = '';
  $('e-event').textContent = '—';
  $('e-gas').textContent = '—';
  render({ initialized: false });
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// initial load
api('/api/state').then(render).catch(() => render({ initialized: false }));
