import * as Vault from './vault.js';

const STATUSES = ['wishlist', 'applied', 'followed_up', 'interviewing', 'offer', 'accepted',
                  'rejected', 'ghosted', 'withdrawn'];
const STATUS_LABEL = { followed_up: 'followed up' };
const DEFAULT_TEMPLATE =
`Hi {contact},

I hope you're doing well. I applied for the {position} position at {company} on {applied_on} and wanted to follow up on my application.

I'm still very interested in the role and would be happy to share anything else that would help.

Best regards,
{me}`;

const LS = { blob: 'jobvault.blob', sha: 'jobvault.sha', dirty: 'jobvault.dirty' };

// ---------------------------------------------------------------- config

const CFG = { ...window.JOB_CONFIG };
if (location.hostname.endsWith('.github.io')) {
  CFG.owner = location.hostname.split('.')[0];
  CFG.repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
}

// ---------------------------------------------------------------- state

let SQL;             // sql.js module
let db;              // open database (only while unlocked)
let vk;              // { key, salt, iterations } - key is a non-extractable CryptoKey
let lastPlain;       // last saved plaintext bytes, to skip no-op saves
let source;          // { blob, sha, from } chosen at boot
let remoteSha = null;
let loginToken = '';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const label = s => STATUS_LABEL[s] || s;
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- db helpers

function q(sql, params = []) {
  const st = db.prepare(sql);
  try {
    st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}
const run = (sql, params = []) => db.run(sql, params);
const setting = (k, dflt = '') => q('SELECT value FROM settings WHERE key = ?', [k])[0]?.value ?? dflt;
const setSetting = (k, v) => run('INSERT INTO settings(key, value) VALUES (?, ?) ' +
                                 'ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);

async function applySchema() {
  const res = await fetch('schema.sql', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load schema.sql');
  db.exec(await res.text());
}

// ---------------------------------------------------------------- GitHub storage

const hasRepo = () => CFG.owner && CFG.repo;
const repoUrl = () =>
  `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${CFG.path}`;

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Returns { blob, sha } or null if the vault doesn't exist yet. Throws on network/auth errors.
async function fetchRemote(token) {
  if (!hasRepo()) return null;
  const res = await fetch(`${repoUrl()}?ref=${encodeURIComponent(CFG.branch)}&t=${Date.now()}`,
                          { headers: ghHeaders(token), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
  const meta = await res.json();
  let b64 = meta.content;
  if (!b64 && meta.git_url) {   // files > 1 MB come back without inline content
    const blob = await fetch(meta.git_url, { headers: ghHeaders(token) }).then(r => r.json());
    b64 = blob.content;
  }
  return { blob: Vault.fromBase64(b64), sha: meta.sha };
}

async function pushRemote({ force = false } = {}) {
  const token = setting('github_token') || loginToken;
  if (!hasRepo() || !token) { syncState('saved locally', ''); return; }
  const b64 = localStorage.getItem(LS.blob);
  if (!b64) return;
  syncState('syncing…', '');
  let sha = remoteSha;
  if (force) sha = (await fetchRemote(token).catch(() => null))?.sha ?? null;
  const res = await fetch(repoUrl(), {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify({
      message: 'Update encrypted job vault',
      content: b64,
      branch: CFG.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.ok) {
    remoteSha = (await res.json()).content.sha;
    localStorage.setItem(LS.sha, remoteSha);
    localStorage.removeItem(LS.dirty);
    syncState('synced', 'ok');
  } else if (res.status === 409 || res.status === 422) {
    syncState('conflict', 'err');
    toast('The vault was changed on another device. Your changes are kept in this browser — ' +
          'in Settings → Backup, either push this copy (overwrite) or discard it and load the other one.', 9000);
  } else {
    syncState(`sync failed (${res.status})`, 'err');
    if (res.status === 401 || res.status === 403) toast('GitHub rejected the token. Check Settings.', 6000);
  }
}

function syncState(text, cls) {
  const el = $('#sync-state');
  el.textContent = text;
  el.className = 'sync ' + cls;
}

// ---------------------------------------------------------------- persistence

let pushTimer;
async function persist({ force = false } = {}) {
  const plain = db.export();
  db.exec('PRAGMA foreign_keys = ON');  // export() reopens the db and resets pragmas
  if (!force && lastPlain && plain.length === lastPlain.length && plain.every((b, i) => b === lastPlain[i]))
    return;
  lastPlain = plain;
  const blob = await Vault.seal(plain, vk.key, vk.salt, vk.iterations);
  try {
    localStorage.setItem(LS.blob, Vault.toBase64(blob));
    localStorage.setItem(LS.dirty, '1');
    if (remoteSha) localStorage.setItem(LS.sha, remoteSha);
  } catch {
    toast('Could not save in this browser (storage full or blocked).');
  }
  syncState('saving…', '');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushRemote().catch(e => syncState('offline', 'err')), 1200);
}

// Write + persist + rerender in one go.
async function mutate(fn) {
  fn();
  await persist();
  render();
}

function downloadBytes(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- login

async function boot() {
  try {
    SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
  } catch (e) {
    $('#login-hint').textContent = 'Failed to load the database engine: ' + e.message;
    return;
  }
  await chooseSource();
  $('#login-form').addEventListener('submit', onLogin);
  $('#login-token').addEventListener('change', async e => {
    loginToken = e.target.value.trim();
    await chooseSource();
  });
  $('#login-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    source = { blob: new Uint8Array(await f.arrayBuffer()), sha: null, from: 'file' };
    remoteSha = (await fetchRemote(loginToken).catch(() => null))?.sha ?? null;
    setLoginMode('unlock', `Unlock backup “${f.name}”.`);
  });
}

async function chooseSource() {
  const hint = $('#login-hint');
  hint.textContent = 'Looking for your vault…';
  let remote = null, remoteErr = null;
  try { remote = await fetchRemote(loginToken); } catch (e) { remoteErr = e; }

  const localB64 = localStorage.getItem(LS.blob);
  const local = localB64 ? { blob: Vault.fromBase64(localB64), sha: localStorage.getItem(LS.sha), from: 'local' } : null;
  const dirty = localStorage.getItem(LS.dirty) === '1';

  if (local && (dirty || !remote)) {
    source = local;
    remoteSha = local.sha;   // if GitHub moved on since, the next push reports a conflict
    setLoginMode('unlock', dirty ? 'Unlock your vault (this browser has unsynced changes).'
                                 : 'Unlock your vault (copy saved in this browser).');
  } else if (remote) {
    source = { ...remote, from: 'github' };
    remoteSha = remote.sha;
    setLoginMode('unlock', 'Unlock your vault.');
  } else if (remoteErr) {
    source = null;
    setLoginMode('none', `Could not reach the vault (${remoteErr.message}). If the repository is private, ` +
                         'add a GitHub token under “Other options”.');
    $('#login-adv').open = true;
  } else {
    source = null;
    remoteSha = null;
    setLoginMode('create', 'No vault found. Choose a strong password to create one — ' +
                           'there is no way to recover it if you forget it.');
  }
}

let loginMode = 'none';
function setLoginMode(mode, text) {
  loginMode = mode;
  $('#login-hint').textContent = text;
  $('#pw2-row').hidden = mode !== 'create';
  $('#pw2').required = mode === 'create';
  $('#pw').autocomplete = mode === 'create' ? 'new-password' : 'current-password';
  $('#login-btn').textContent = mode === 'create' ? 'Create vault' : 'Unlock';
  $('#login-btn').disabled = mode === 'none';
}

async function onLogin(e) {
  e.preventDefault();
  const pw = $('#pw').value;
  const err = $('#login-error');
  err.textContent = '';
  $('#login-btn').disabled = true;
  $('#login-btn').textContent = 'Working…';
  try {
    if (loginMode === 'create') {
      if (pw !== $('#pw2').value) throw new Error('Passwords do not match.');
      if (pw.length < 10) throw new Error('Use at least 10 characters.');
      const salt = Vault.randomSalt();
      vk = { key: await Vault.deriveKey(pw, salt, Vault.ITERATIONS), salt, iterations: Vault.ITERATIONS };
      db = new SQL.Database();
      await applySchema();
      setSetting('default_follow_up_days', '7');
      setSetting('auto_lock_minutes', '10');
      setSetting('follow_up_template', DEFAULT_TEMPLATE);
      if (loginToken) setSetting('github_token', loginToken);
    } else {
      const opened = await Vault.open(source.blob, pw);
      vk = { key: opened.key, salt: opened.salt, iterations: opened.iterations };
      db = new SQL.Database(opened.plain);
      lastPlain = opened.plain;
      await applySchema();
      if (loginToken && !setting('github_token')) setSetting('github_token', loginToken);
    }
    $('#pw').value = $('#pw2').value = '';
    await persist();   // no-op unless something changed (new vault, schema upgrade, token)
    if (source?.from === 'local' && localStorage.getItem(LS.dirty) === '1') pushRemote().catch(() => {});
    if (source?.from === 'file') { localStorage.setItem(LS.blob, Vault.toBase64(source.blob)); }
    enterApp();
  } catch (ex) {
    db?.close(); db = null; vk = null;
    err.textContent = ex.message;
    setLoginMode(loginMode, $('#login-hint').textContent);
  }
}

function lock() {
  // Reloading drops every decrypted byte and the key from memory.
  clearTimeout(pushTimer);
  if (localStorage.getItem(LS.dirty) === '1' && setting('github_token')) {
    pushRemote().finally(() => location.reload());
  } else {
    location.reload();
  }
}

let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  const mins = Number(setting('auto_lock_minutes', '10')) || 10;
  idleTimer = setTimeout(lock, mins * 60_000);
}

// ---------------------------------------------------------------- app

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (!$('#sync-state').textContent)
    syncState(setting('github_token') ? 'synced' : 'local only — add a GitHub token', setting('github_token') ? 'ok' : '');
  $('#repo-path').textContent = hasRepo() ? `${CFG.owner}/${CFG.repo}/${CFG.path}` : '(not configured)';

  for (const sel of [$('#status-filter'), $('#app-form [name=status]')])
    sel.insertAdjacentHTML('beforeend', STATUSES.map(s => `<option value="${s}">${label(s)}</option>`).join(''));

  $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#lock-btn').addEventListener('click', lock);
  $('#search').addEventListener('input', renderApps);
  $('#status-filter').addEventListener('change', renderApps);
  $('#add-btn').addEventListener('click', () => openAppDialog());
  $('#app-cancel').addEventListener('click', () => $('#app-dialog').close());
  $('#app-form').addEventListener('submit', saveApp);
  $('#app-delete').addEventListener('click', deleteApp);
  $('#apps-table tbody').addEventListener('click', onTableClick);
  $('#apps-table tbody').addEventListener('change', onTableChange);
  $('#due-list').addEventListener('click', onDueClick);
  $('#stats').addEventListener('click', e => {
    const s = e.target.closest('[data-filter]');
    if (s) { $('#status-filter').value = s.dataset.filter; renderApps(); }
  });
  $('#sql-run').addEventListener('click', runSql);
  $('#sql-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); }
  });
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#passwd-form').addEventListener('submit', changePassword);
  $('#notif-btn').addEventListener('click', async () => {
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Notifications enabled.' : 'Notifications were not allowed.');
    notifyDue();
  });
  $('#dl-vault').addEventListener('click', () => {
    const b64 = localStorage.getItem(LS.blob);
    if (b64) downloadBytes(Vault.fromBase64(b64), `jobs-${today()}.vault`);
  });
  $('#dl-sqlite').addEventListener('click', () => {
    if (!confirm('This file will NOT be encrypted. Anyone who gets it can read all your applications. Continue?')) return;
    downloadBytes(db.export(), `jobs-${today()}.sqlite`);
    db.exec('PRAGMA foreign_keys = ON');
  });
  $('#discard-local').addEventListener('click', () => {
    if (!confirm('Forget the copy stored in this browser (including unsynced changes) and reload from GitHub?')) return;
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
  $('#force-push').addEventListener('click', () => {
    if (confirm('Overwrite the copy on GitHub with the one in this browser?')) pushRemote({ force: true });
  });

  for (const ev of ['pointerdown', 'keydown', 'scroll'])
    addEventListener(ev, resetIdle, { passive: true });
  resetIdle();
  addEventListener('beforeunload', e => {
    if (localStorage.getItem(LS.dirty) === '1' && setting('github_token')) e.preventDefault();
  });

  loadSettingsForm();
  render();
  notifyDue();
  setInterval(() => { renderDue(); notifyDue(); }, 60 * 60_000);
}

function showTab(name) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  $$('.tab').forEach(t => { t.hidden = t.id !== `tab-${name}`; });
}

function render() {
  renderApps();
  renderDue();
}

function renderApps() {
  const term = $('#search').value.trim().toLowerCase();
  const status = $('#status-filter').value;
  const where = [], params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (term) {
    where.push("lower(company || ' ' || position || ' ' || coalesce(location,'') || ' ' || coalesce(notes,'')) LIKE ?");
    params.push(`%${term}%`);
  }
  const rows = q(`SELECT * FROM v_applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY (next_follow_up IS NULL), next_follow_up, COALESCE(applied_on, created_at) DESC`, params);
  const now = today();
  $('#apps-table tbody').innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td class="company">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.company)}</a>` : esc(r.company)}</td>
      <td>${esc(r.position)}${r.location ? `<div class="muted small">${esc(r.location)}</div>` : ''}</td>
      <td><select class="pill" data-status="${r.status}" aria-label="Status">
        ${STATUSES.map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${label(s)}</option>`).join('')}
      </select></td>
      <td>${esc(r.applied_on || '—')}</td>
      <td class="${r.next_follow_up && r.next_follow_up <= now ? 'overdue' : ''}">${esc(r.next_follow_up || '—')}</td>
      <td class="actions"><button class="small" data-act="edit">Edit</button></td>
    </tr>`).join('');
  $('#apps-empty').hidden = rows.length > 0;
  $('#apps-table').parentElement.hidden = rows.length === 0;

  const stats = q('SELECT status, COUNT(*) AS n FROM applications GROUP BY status ORDER BY n DESC');
  const total = stats.reduce((a, s) => a + s.n, 0);
  $('#stats').innerHTML = total ? `<span class="stat" data-filter="">All<b>${total}</b></span>` +
    stats.map(s => `<span class="stat" data-filter="${s.status}" data-status="${s.status}">${label(s.status)}<b>${s.n}</b></span>`).join('') : '';
}

function renderDue() {
  const rows = q('SELECT * FROM v_due_followups');
  const badge = $('#due-badge');
  badge.hidden = rows.length === 0;
  badge.textContent = rows.length;
  $('#due-empty').hidden = rows.length > 0;
  $('#due-list').innerHTML = rows.map(r => `
    <div class="due-item" data-id="${r.id}">
      <div class="info">
        <strong>${esc(r.company)}</strong> — ${esc(r.position)}
        <div class="when">${r.days_overdue > 0 ? `${r.days_overdue} day${r.days_overdue > 1 ? 's' : ''} overdue` : 'Due today'}
          · ${label(r.status)} · last contact ${esc(r.last_contact_on || r.applied_on || '—')}</div>
      </div>
      <button data-act="draft">${r.contact_email ? 'Draft email' : 'Copy message'}</button>
      <button data-act="sent" class="primary">Mark as sent</button>
      <button data-act="snooze">Snooze 3 days</button>
      <button data-act="ghosted" class="ghost">Mark ghosted</button>
    </div>`).join('');
}

function notifyDue() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = q('SELECT COUNT(*) AS n FROM v_due_followups')[0].n;
  // Never put company names in a notification: they can show on a lock screen.
  if (n) new Notification('Job Organiser', { body: `${n} follow-up${n > 1 ? 's are' : ' is'} due.`, tag: 'due' });
}

// ---------------------------------------------------------------- applications

function openAppDialog(id) {
  const form = $('#app-form');
  form.reset();
  const r = id ? q('SELECT * FROM applications WHERE id = ?', [id])[0] : {
    status: 'applied', applied_on: today(), follow_up_days: setting('default_follow_up_days', '7'),
  };
  for (const el of form.elements) if (el.name) el.value = r[el.name] ?? '';
  $('#app-dialog-title').textContent = id ? 'Edit application' : 'Add application';
  $('#app-delete').hidden = !id;
  const events = id ? q('SELECT at, kind, detail FROM events WHERE application_id = ? ORDER BY at DESC, id DESC', [id]) : [];
  $('#app-events').innerHTML = events.length ? '<strong>History</strong><ul>' + events.map(e =>
    `<li>${esc(e.at.slice(0, 16))} UTC — ${esc(e.kind)}${e.detail ? ': ' + esc(e.detail.replace(/_/g, ' ')) : ''}</li>`).join('') + '</ul>' : '';
  $('#app-dialog').showModal();
}

async function saveApp(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const nul = v => (v === '' ? null : v);
  const vals = [f.company.trim(), f.position.trim(), nul(f.location), nul(f.url), nul(f.contact_name),
                nul(f.contact_email), f.status, nul(f.applied_on), nul(f.last_contact_on),
                Number(f.follow_up_days || 0), nul(f.notes)];
  try {
    await mutate(() => {
      if (f.id) {
        run(`UPDATE applications SET company=?, position=?, location=?, url=?, contact_name=?, contact_email=?,
             status=?, applied_on=?, last_contact_on=?, follow_up_days=?, notes=? WHERE id=?`, [...vals, f.id]);
      } else {
        run(`INSERT INTO applications(company, position, location, url, contact_name, contact_email,
             status, applied_on, last_contact_on, follow_up_days, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, vals);
      }
    });
    $('#app-dialog').close();
    toast(f.id ? 'Saved.' : 'Application added.');
  } catch (ex) {
    toast('Error: ' + ex.message);
  }
}

async function deleteApp() {
  const id = $('#app-form [name=id]').value;
  if (!id || !confirm('Delete this application and its history?')) return;
  await mutate(() => run('DELETE FROM applications WHERE id = ?', [id]));
  $('#app-dialog').close();
  toast('Deleted.');
}

function onTableClick(e) {
  const btn = e.target.closest('button[data-act="edit"]');
  if (btn) openAppDialog(Number(btn.closest('tr').dataset.id));
}

async function onTableChange(e) {
  if (!e.target.matches('select.pill')) return;
  const id = Number(e.target.closest('tr').dataset.id);
  await mutate(() => run('UPDATE applications SET status = ? WHERE id = ?', [e.target.value, id]));
}

function fillTemplate(r) {
  const vars = {
    company: r.company, position: r.position, applied_on: r.applied_on || 'recently',
    contact: r.contact_name || 'there', me: setting('my_name', ''),
  };
  return setting('follow_up_template', DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

async function onDueClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.due-item').dataset.id);
  const r = q('SELECT * FROM applications WHERE id = ?', [id])[0];
  switch (btn.dataset.act) {
    case 'draft': {
      const body = fillTemplate(r);
      if (r.contact_email) {
        const subject = `Following up: ${r.position} application`;
        location.href = `mailto:${encodeURIComponent(r.contact_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      } else {
        await navigator.clipboard.writeText(body);
        toast('Message copied to the clipboard.');
      }
      break;
    }
    case 'sent':
      await mutate(() => {
        run(`UPDATE applications SET last_contact_on = ?, snooze_until = NULL,
             status = CASE WHEN status = 'applied' THEN 'followed_up' ELSE status END WHERE id = ?`, [today(), id]);
        run("INSERT INTO events(application_id, kind, detail) VALUES (?, 'follow_up', 'message sent')", [id]);
      });
      toast('Marked as sent — reminder reset.');
      break;
    case 'snooze':
      await mutate(() => run("UPDATE applications SET snooze_until = date(?, '+3 days') WHERE id = ?", [today(), id]));
      break;
    case 'ghosted':
      await mutate(() => run("UPDATE applications SET status = 'ghosted' WHERE id = ?", [id]));
      break;
  }
}

// ---------------------------------------------------------------- SQL console

async function runSql() {
  const out = $('#sql-out'), err = $('#sql-error');
  err.textContent = '';
  out.innerHTML = '';
  try {
    const results = db.exec($('#sql-input').value);
    db.exec('PRAGMA foreign_keys = ON');
    out.innerHTML = results.map(r => `
      <div class="table-wrap"><table>
        <thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.values.map(row => `<tr>${row.map(v => `<td>${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`).join('') || `<p class="muted">OK. ${db.getRowsModified()} row(s) changed by the last statement.</p>`;
    await persist();
    render();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

// ---------------------------------------------------------------- settings

const SETTING_KEYS = ['default_follow_up_days', 'my_name', 'follow_up_template', 'github_token', 'auto_lock_minutes'];

function loadSettingsForm() {
  const form = $('#settings-form');
  for (const k of SETTING_KEYS) form.elements[k].value = setting(k, k === 'follow_up_template' ? DEFAULT_TEMPLATE : form.elements[k].value);
}

async function saveSettings(e) {
  e.preventDefault();
  const form = e.target;
  const hadToken = !!setting('github_token');
  await mutate(() => { for (const k of SETTING_KEYS) setSetting(k, form.elements[k].value.trim()); });
  resetIdle();
  $('#settings-ok').textContent = 'Saved.';
  setTimeout(() => { $('#settings-ok').textContent = ''; }, 2000);
  if (!hadToken && setting('github_token')) pushRemote().catch(() => syncState('offline', 'err'));
}

async function changePassword(e) {
  e.preventDefault();
  const a = $('#np1').value, b = $('#np2').value, msg = $('#passwd-msg');
  if (a !== b) { msg.textContent = 'Passwords do not match.'; return; }
  msg.textContent = 'Re-encrypting…';
  const salt = Vault.randomSalt();
  vk = { key: await Vault.deriveKey(a, salt, Vault.ITERATIONS), salt, iterations: Vault.ITERATIONS };
  await persist({ force: true });
  e.target.reset();
  msg.textContent = 'Password changed. Update the JOBVAULT_PASSWORD secret on GitHub.';
}

boot();
