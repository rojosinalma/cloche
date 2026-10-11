// Form shares: collect answers, autosave the draft, submit, bulk checklist tools.
const data = JSON.parse(document.getElementById('form-data').textContent);
const { base, fields } = data;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const card = (id) => $(`.form-field[data-field="${CSS.escape(id)}"]`);
const bar = { progress: $('#bar-progress span'), draft: $('#bar-draft'), submit: $('#bar-submit span') };
const submitBtn = $('#submit-btn');

let submissions = data.submissions || 0;
let submittedAt = data.submitted_at;
let lastSubmitted = null;        // JSON of the answers of the last submit seen by this page
let dirtySinceSubmit = false;    // draft saved after the last submit (from /status when lastSubmitted is unknown)
let saveTimer = null, retryTimer = null, saving = false, pendingSave = false, ended = false;

const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const present = (v) => Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null;

function collect() {
  const answers = {};
  for (const f of fields) {
    const el = card(f.id);
    if (!el) continue;
    let v;
    if (f.type === 'checklist' || f.type === 'tasklist') {
      v = $$('.opt-list input:checked', el).map((i) => (f.type === 'tasklist' ? Number(i.value) : i.value));
    } else if (f.type === 'radio') {
      v = $('input:checked', el)?.value;
    } else if (f.type === 'select') {
      v = $('select', el).value;
    } else if (f.type === 'text') {
      v = $('input, textarea', el).value;
    }
    if (present(v)) answers[f.id] = v;
  }
  return answers;
}

function apply(f, value) {
  const el = card(f.id);
  if (!el) return;
  if (f.type === 'checklist' || f.type === 'tasklist') {
    const set = new Set((Array.isArray(value) ? value : []).map(String));
    $$('.opt-list input', el).forEach((i) => { i.checked = set.has(i.value); });
  } else if (f.type === 'radio') {
    $$('input', el).forEach((i) => { i.checked = value != null && String(value) === i.value; });
  } else if (f.type === 'select') {
    $('select', el).value = value == null ? '' : String(value);
  } else if (f.type === 'text') {
    $('input, textarea', el).value = value == null ? '' : String(value);
  }
  refreshField(el, f);
}

// ── per-field decorations: row highlight, counter, limits, char count ──
function refreshField(el, f) {
  $$('.opt-row', el).forEach((r) => r.classList.toggle('on', $('input', r).checked));
  const count = $('[data-count]', el);
  if (count) {
    const rows = $$('.opt-row', el), checked = rows.filter((r) => $('input', r).checked).length;
    const shown = rows.filter((r) => !r.hidden).length;
    count.textContent = `${checked} of ${rows.length} selected` + (shown !== rows.length ? ` · ${shown} shown` : '');
  }
  const limits = $('[data-limits]', el);
  if (limits) {
    const n = $$('.opt-list input:checked', el).length;
    limits.classList.toggle('text-warning', (f.min != null && n < f.min) || (f.max != null && n > f.max));
  }
  const cc = $('[data-char-count]', el);
  if (cc) cc.textContent = `${$('input, textarea', el).value.length} / ${cc.dataset.max}`;
}

function refreshAll() {
  fields.forEach((f) => { const el = card(f.id); if (el) refreshField(el, f); });
  renderProgress();
  renderSubmit();
}

// ── sticky bar ──
function renderProgress() {
  const answers = collect();
  const answered = fields.filter((f) => f.id in answers).length;
  const missing = fields.filter((f) => f.required && !(f.id in answers)).length;
  bar.progress.textContent = `${answered} of ${fields.length} answered` + (missing ? ` · ${missing} required missing` : '');
  bar.progress.parentElement.classList.toggle('text-warning', missing > 0);
}

function renderSubmit() {
  if (!submissions) { bar.submit.textContent = 'Not submitted yet'; return; }
  const changed = lastSubmitted != null ? JSON.stringify(collect()) !== lastSubmitted : dirtySinceSubmit;
  bar.submit.textContent = `Submitted #${submissions} at ${fmtTime(submittedAt)}` + (changed ? ' · unsubmitted changes' : '');
  bar.submit.parentElement.classList.toggle('text-warning', changed);
}

function setDraft(state, text) {
  const icons = { idle: 'cloud-check', saving: 'cloud-arrow-up', saved: 'cloud-check', unsaved: 'cloud', failed: 'cloud-slash' };
  bar.draft.dataset.state = state;
  $('i', bar.draft).className = `bi bi-${icons[state]}`;
  $('span', bar.draft).textContent = text;
}

// ── autosave ──
function scheduleSave() {
  if (ended) return;
  clearTimeout(saveTimer); clearTimeout(retryTimer);
  setDraft('unsaved', 'Unsaved');
  if (submissions) dirtySinceSubmit = true;
  saveTimer = setTimeout(() => save(), 1000);
}

async function save(isRetry = false) {
  if (ended) return false;
  if (saving) { pendingSave = true; return false; }
  saving = true; pendingSave = false;
  setDraft('saving', 'Saving…');
  try {
    const res = await fetch(`${base}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' },
                                               body: JSON.stringify({ answers: collect() }) });
    const r = await res.json().catch(() => ({}));
    if (res.status === 410) return markEnded(r.reason || r.message);
    if (!res.ok || !r.ok) throw new Error(r.message || `HTTP ${res.status}`);
    setDraft('saved', `Saved ${fmtTime(r.saved_at || new Date().toISOString())}`);
    return true;
  } catch (e) {
    if (!isRetry) { setDraft('saving', 'Saving… (retrying)'); retryTimer = setTimeout(() => save(true), 5000); }
    else { setDraft('failed', 'Save failed'); toast('error', `Draft not saved: ${e.message}`); }
    return false;
  } finally {
    saving = false;
    if (pendingSave) scheduleSave();
  }
}

// ── submit ──
function showErrors(errors) {
  $$('[data-error-for]').forEach((e) => { e.textContent = ''; e.closest('.form-field').classList.remove('has-error'); });
  let first = null;
  for (const [id, msg] of Object.entries(errors || {})) {
    const slot = $(`[data-error-for="${CSS.escape(id)}"]`);
    if (!slot) continue;
    slot.textContent = msg;
    slot.closest('.form-field').classList.add('has-error');
    first ||= slot.closest('.form-field');
  }
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submit() {
  if (ended) return;
  clearTimeout(saveTimer); clearTimeout(retryTimer);
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Submitting…';
  try {
    if (bar.draft.dataset.state !== 'saved') await save();
    const res = await fetch(`${base}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                                                body: JSON.stringify({ answers: collect() }) });
    const r = await res.json().catch(() => ({}));
    if (res.status === 410) return markEnded(r.reason || r.message);
    if (res.status === 422) { showErrors(r.errors); toast('error', r.message || 'Please fix the marked fields'); return; }
    if (!res.ok || !r.ok) throw new Error(r.message || `HTTP ${res.status}`);
    showErrors({});
    submissions = r.submissions; submittedAt = r.submitted_at;
    lastSubmitted = JSON.stringify(collect()); dirtySinceSubmit = false;
    renderSubmit();
    toast('success', `Submitted #${submissions}`);
  } catch (e) {
    toast('error', `Submit failed: ${e.message}`);
  } finally {
    if (!ended) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="bi bi-send me-1"></i>Submit'; }
  }
}

function markEnded(reason) {
  if (ended) return false;
  ended = true;
  $$('#share-form input, #share-form select, #share-form textarea, #share-form button, .form-bar button').forEach((e) => { e.disabled = true; });
  setDraft('failed', 'Share ended');
  bar.submit.textContent = `Share ended (${reason || 'stopped'})`;
  toast('warning', `Share ended: ${reason || 'stopped'}`);
  return false;
}

// ── bulk toolbar ──
function wireBulk(el, f) {
  const filter = $('[data-filter]', el);
  if (!filter) return;
  const rows = $$('.opt-row', el), none = $('.opt-none', el);
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    rows.forEach((r) => { r.hidden = q !== '' && !r.dataset.text.includes(q); });
    none.hidden = rows.some((r) => !r.hidden);
    refreshField(el, f);
  });
  $$('[data-bulk]', el).forEach((btn) => btn.addEventListener('click', () => {
    const mode = btn.dataset.bulk;
    rows.filter((r) => !r.hidden).forEach((r) => { const i = $('input', r); i.checked = mode === 'invert' ? !i.checked : mode === 'all'; });
    refreshField(el, f); scheduleSave(); renderProgress(); renderSubmit();
  }));
}

// ── wiring ──
fields.forEach((f) => {
  const el = card(f.id);
  if (!el) return;
  const onChange = () => { refreshField(el, f); scheduleSave(); renderProgress(); renderSubmit(); };
  el.addEventListener('input', onChange);
  el.addEventListener('change', onChange);
  wireBulk(el, f);
});
submitBtn.addEventListener('click', submit);
$('#reset-confirm').addEventListener('click', () => {
  fields.forEach((f) => apply(f, f.default));
  bootstrap.Modal.getInstance($('#reset-modal'))?.hide();
  showErrors({});
  scheduleSave(); renderProgress(); renderSubmit();
  toast('warning', 'Form reset to its defaults');
});
window.addEventListener('beforeunload', (e) => {
  if (bar.draft.dataset.state === 'unsaved' || bar.draft.dataset.state === 'saving') { e.preventDefault(); e.returnValue = ''; }
});

// On load: was the draft touched after the last submit? /status says.
(async () => {
  if (!submissions) return;
  try {
    const r = await (await fetch(`${base}/status`, { headers: { accept: 'application/json' } })).json();
    if (r.draft_saved_at && r.submitted_at) dirtySinceSubmit = new Date(r.draft_saved_at) > new Date(r.submitted_at);
    if (r.submissions) { submissions = r.submissions; submittedAt = r.submitted_at; }
    renderSubmit();
  } catch (e) { /* bar already shows what the page knew */ }
})();

refreshAll();
