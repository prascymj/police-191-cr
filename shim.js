/* Runs the web app's pages on GitHub Pages (7 Nov 2026, DESIGN-pages-hosting.md).
 * The pages are the same templates as the Apps Script version (tools/build-site.mjs builds them); this script stands in
 * for what Apps Script used to give them:
 *   - Google Sign-In (Google Identity Services) instead of the browser's Google session; the ID token goes with every
 *     request and the API (Api.gs) checks it and the Sheet's sharing.
 *   - google.script.run / history / url, mapped onto the JSON API and the page's own URL.
 *   - the page's data (window.__BOOT): the last copy kept on this device is shown at once, then the latest is fetched;
 *     when it differs the page reloads with it. Import and status always ask the server.
 *   - links of the form ./?page=x, routed to the page files.
 *   - the private rules (outcome rules, manual decisions, draft categories: window.P191_RULES), sent by the API to
 *     signed-in people only; the public site carries none of them.
 * All inline page scripts are built as type="text/p191-deferred" and run here, in order, once the data is in place.
 */
(function () {
  'use strict';
  const CFG = window.P191_CONFIG || {};
  const Q = new URLSearchParams(location.search);

  // ---------- router ----------
  const FILES = { mobile: 'index.html', dashboard: 'dashboard.html', calls: 'dashboard.html', import: 'import.html', status: 'status.html' };
  const file = location.pathname.split('/').pop() || 'index.html';
  const want = Q.get('page');
  if (want && FILES[want]) {
    const q = new URLSearchParams(Q); q.delete('page');
    const target = FILES[want] + (q.toString() ? '?' + q : '') + (want === 'calls' ? '#calls' : location.hash);
    if (FILES[want] !== file || want === 'calls') { location.replace(target); return; }
  }

  const PAGE = document.documentElement.dataset.p191 || 'mobile';
  const FRESH_ONLY = PAGE === 'import' || PAGE === 'status';
  const K = { token: 'p191:idt', boot: 'p191:boot' };
  const store = {
    get(area, k) { try { return window[area].getItem(k); } catch (e) { return null; } },
    set(area, k, v) { try { window[area].setItem(k, v); return true; } catch (e) { return false; } },
    del(area, k) { try { window[area].removeItem(k); } catch (e) { /* nothing kept */ } }
  };

  // ---------- sign-in ----------
  const b64url = (s) => decodeURIComponent(atob(s.replace(/-/g, '+').replace(/_/g, '/')).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
  function claimsOf(t) { try { return JSON.parse(b64url(t.split('.')[1])); } catch (e) { return null; } }
  function savedToken() {
    const raw = store.get('sessionStorage', K.token);
    if (!raw) return null;
    try { const o = JSON.parse(raw); return o.exp * 1000 > Date.now() + 60000 ? o : null; } catch (e) { return null; }
  }
  function keepToken(t) {
    const c = CFG.mock ? { exp: Math.floor(Date.now() / 1000) + 3600, email: t } : claimsOf(t);
    if (!c) return null;
    const o = { t, exp: c.exp, email: String(c.email || '').toLowerCase() };
    store.set('sessionStorage', K.token, JSON.stringify(o));
    return o;
  }
  const inLine = /\bLine\//i.test(navigator.userAgent);

  let gisReady = null;
  function loadGis() {
    if (CFG.mock) return Promise.resolve(null);
    if (gisReady) return gisReady;
    gisReady = new Promise((resolve, reject) => {
      const done = () => (window.google && window.google.accounts && window.google.accounts.id ? resolve(window.google.accounts.id) : reject(new Error('gsi')));
      if (window.google && window.google.accounts && window.google.accounts.id) { done(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => { attachScript(); done(); };
      s.onerror = () => reject(new Error('โหลดระบบเข้าระบบของ Google ไม่สำเร็จ'));
      document.head.appendChild(s);
    });
    return gisReady;
  }
  let waiting = [];
  function gotCredential(t) {
    const o = keepToken(t);
    hideCard();
    const w = waiting; waiting = [];
    w.forEach((f) => (o ? f.ok(o) : f.fail(new Error('AUTH: เข้าระบบไม่สำเร็จ'))));
  }
  let initialised = false;
  function initGis(id) {
    if (initialised) return;
    initialised = true;
    id.initialize({ client_id: CFG.clientId, callback: (r) => gotCredential(r.credential), auto_select: true,
      cancel_on_tap_outside: false, use_fedcm_for_prompt: true, itp_support: true });
  }
  /** A valid ID token: the saved one, a silent One Tap sign-in, or (interactive) the sign-in card. */
  function token(interactive) {
    const s = savedToken();
    if (s) return Promise.resolve(s);
    return new Promise((ok, fail) => {
      waiting.push({ ok, fail });
      if (CFG.mock) { if (interactive) showCard(); else { waiting = waiting.filter((x) => x.ok !== ok); fail(new Error('AUTH: ต้องเข้าระบบ')); } return; }
      loadGis().then((id) => {
        initGis(id);
        if (interactive) showCard();
        try { id.prompt(); } catch (e) { /* the card is there */ }
        if (!interactive) setTimeout(() => {
          if (waiting.some((x) => x.ok === ok)) { waiting = waiting.filter((x) => x.ok !== ok); fail(new Error('AUTH: ต้องเข้าระบบ')); }
        }, 6000);
      }, (e) => { waiting = waiting.filter((x) => x.ok !== ok); if (interactive) showCard(e.message); fail(e); });
    });
  }

  // ---------- the sign-in card ----------
  const CARD_CSS = `
#p191-card{position:fixed;inset:0;z-index:1000;background:rgba(246,247,249,.97);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Sarabun,"Noto Sans Thai",Tahoma,sans-serif;color:#121317}
#p191-card .box{background:#fff;border:1px solid #d6d9e0;border-radius:4px;padding:20px;max-width:24rem;width:100%;line-height:1.6}
#p191-card h1{margin:0 0 2px;font-size:20px;color:#061c90}
#p191-card .org{font-size:13px;font-weight:600;color:#061c90;padding-bottom:10px;margin-bottom:12px;border-bottom:2px solid #061c90}
#p191-card p{margin:8px 0;font-size:14px}
#p191-card .note{font-size:13px;color:#585c66}
#p191-card .err{color:#a01b2e;font-weight:600}
#p191-card button{font:inherit;font-size:14px;padding:8px 14px;border:1px solid #061c90;border-radius:4px;background:#061c90;color:#fff;cursor:pointer}
#p191-card #p191-gbtn{margin:12px 0;min-height:44px}
#p191-bar{position:fixed;left:8px;right:8px;top:8px;z-index:900;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 12px;background:#fff;border:1px solid #d6d9e0;border-radius:4px;font:13px/1.5 Sarabun,"Noto Sans Thai",Tahoma,sans-serif;color:#121317;max-width:40rem;margin:0 auto}
#p191-bar button{font:inherit;padding:4px 10px;border:1px solid #061c90;border-radius:4px;background:#fff;color:#061c90;cursor:pointer;white-space:nowrap}`;
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); });
    kids.forEach((c) => e.append(c));
    return e;
  }
  function css() {
    if (document.getElementById('p191-css')) return;
    document.head.appendChild(el('style', { id: 'p191-css', text: CARD_CSS }));
  }
  function showCard(error, text) {
    css();
    hideCard();
    const box = el('div', { class: 'box' },
      el('h1', { text: 'เหตุ 191 จ.เชียงราย' }), el('div', { class: 'org', text: 'ตำรวจภูธรจังหวัดเชียงราย (ภ.จว.เชียงราย)' }));
    if (text) box.append(el('p', { class: 'err', text }));
    if (inLine && !CFG.mock) {
      box.append(el('p', { text: 'Google ไม่อนุญาตให้เข้าระบบในหน้าเว็บที่เปิดจากแอป LINE' }),
        el('p', { text: 'กดปุ่มเมนูมุมขวาบน (สามจุด) แล้วเลือก "เปิดในเบราว์เซอร์" หรือคัดลอกลิงก์ไปเปิดใน Safari หรือ Chrome' }),
        el('button', { type: 'button', text: 'คัดลอกลิงก์', onclick: (ev) => { try { navigator.clipboard.writeText(location.href); ev.target.textContent = 'คัดลอกแล้ว'; } catch (e) { /* select by hand */ } } }));
    } else {
      box.append(el('p', { text: 'เข้าระบบด้วยบัญชี Google ที่ได้รับแชร์ Sheet ข้อมูลเหตุ 191' }));
      if (CFG.mock) {
        box.append(el('button', { type: 'button', id: 'p191-gbtn', text: 'เข้าระบบทดสอบ (' + mockUser() + ')', onclick: () => gotCredential(mockUser()) }));
      } else {
        const holder = el('div', { id: 'p191-gbtn' });
        box.append(holder);
        loadGis().then((id) => { initGis(id); id.renderButton(holder, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'th', width: 280 }); },
          () => holder.append(el('p', { class: 'err', text: 'โหลดปุ่มเข้าระบบของ Google ไม่สำเร็จ ลองโหลดหน้าใหม่' })));
      }
      if (error) box.append(el('p', { class: 'err', text: error }));
      box.append(el('p', { class: 'note', text: 'ถ้าเปิดจากแอป LINE และเข้าระบบไม่ได้ ให้เปิดลิงก์นี้ใน Safari หรือ Chrome' }));
    }
    document.body.appendChild(el('div', { id: 'p191-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'เข้าระบบ' }, box));
  }
  function hideCard() { const c = document.getElementById('p191-card'); if (c) c.remove(); }
  function showBar(text, label, action) {
    css();
    const old = document.getElementById('p191-bar'); if (old) old.remove();
    document.body.appendChild(el('div', { id: 'p191-bar', role: 'status' }, el('span', { text }),
      ...(label ? [el('button', { type: 'button', text: label, onclick: action })] : [])));
  }
  function mockUser() { return (Q.get('mockuser') === 'viewer' ? 'viewer' : 'reviewer') + '@example.com'; }

  // ---------- API ----------
  async function post(action, args, t) {
    if (CFG.mock) return window.P191_MOCK.call(action, args || [], t.email);
    const res = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, args: args || [], idToken: t.t }), redirect: 'follow' });
    if (!res.ok) throw new Error('NETWORK: เชื่อมต่อระบบไม่สำเร็จ (' + res.status + ')');
    const out = await res.json();
    if (out.ms) console.info('p191 api', action, 'server ms', out.ms);
    if (out.ok) return out.result;
    const err = new Error(out.error.code + ': ' + out.error.message);
    err.code = out.error.code;
    throw err;
  }
  /** One API call with a token; when the token is refused, sign in again (interactive) and retry once. */
  async function api(action, args, interactive) {
    let t = await token(interactive);
    try { return await post(action, args, t); } catch (e) {
      if (e.code !== 'AUTH') throw e;
      store.del('sessionStorage', K.token);
      t = await token(true);
      return post(action, args, t);
    }
  }
  function onNoAccess(e) {
    if (e.code === 'NO_ACCESS') { forget(); showCard(null, e.message.replace(/^[A-Z_]+: /, '')); return true; }
    return false;
  }

  // ---------- google.script shim ----------
  function runner(ok, fail) {
    return new Proxy({}, { get(_, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'withSuccessHandler') return (f) => runner(f, fail);
      if (name === 'withFailureHandler') return (f) => runner(ok, f);
      return (...args) => { api(name, args, true).then((r) => ok && ok(r), (e) => { if (!onNoAccess(e)) (fail ? fail(e) : console.error(e)); }); };
    } });
  }
  const scriptShim = {
    run: runner(),
    history: { replace: (state, params, hash) => { try { history.replaceState(null, '', location.pathname + location.search + (hash ? '#' + hash : '')); } catch (e) { /* ignore */ } } },
    url: { getLocation: (cb) => cb({ hash: location.hash.slice(1), parameter: Object.fromEntries(Q) }) }
  };
  function attachScript() { window.google = window.google || {}; window.google.script = scriptShim; }
  attachScript();

  // ---------- the page's data on this device ----------
  function cached(email) {
    const raw = store.get('localStorage', K.boot);
    if (!raw) return null;
    try { const o = JSON.parse(raw); return !email || o.email === email ? o : null; } catch (e) { return null; }
  }
  function keep(boot) {
    const o = { email: boot.who.email, savedAt: new Date().toISOString(), json: JSON.stringify(boot) };
    store.set('localStorage', K.boot, JSON.stringify(o));
    return o;
  }
  function forget() {
    store.del('localStorage', K.boot);
    store.del('sessionStorage', K.token);
  }
  /** Sign out: forget the data on this device and the sign-in; One Tap will not pick the account by itself again. */
  function signOut() {
    forget();
    try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    location.href = 'index.html';
  }

  // ---------- running the page ----------
  function applyWho(who) {
    const b = document.body;
    b.dataset.canEdit = who.canEdit ? '1' : '';
    b.dataset.email = who.email || '';
    b.dataset.owner = who.isOwner ? '1' : '';
    // Built with the editor's menu; viewers lose the import links.
    if (!who.canEdit) document.querySelectorAll('a[href*="page=import"]').forEach((a) => { a.hidden = true; a.style.display = 'none'; });
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes('__P191_EMAIL__')) n.nodeValue = n.nodeValue.split('__P191_EMAIL__').join(who.email || '');
  }
  function applyFrom() {
    // Opened from the full dashboard: its look, and หน้าหลัก back to it (as Code.gs did with ?from=dashboard).
    const fromDash = Q.get('from') === 'dashboard';
    if (fromDash) document.body.classList.add('from-dash');
    document.querySelectorAll('a[href="__P191_HOME__"]').forEach((a) => { a.href = fromDash ? 'dashboard.html' : 'index.html'; });
    if (fromDash) document.querySelectorAll('a[href*="page=import"], a[href*="page=status"]').forEach((a) => { if (!/from=/.test(a.href)) a.href += '&from=dashboard'; });
  }
  let ran = false;
  function runScripts() {
    if (ran) return;
    ran = true;
    document.querySelectorAll('script[type="text/p191-deferred"]').forEach((old) => {
      const s = document.createElement('script');
      s.text = old.textContent;
      old.replaceWith(s);
    });
    // The page scripts listen for DOMContentLoaded, which has passed by now.
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.querySelectorAll('[data-p191-signout]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); signOut(); }));
  }
  let tick = null;
  function loading(text) {
    css();
    const t0 = Date.now();
    const draw = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      showBar(text + (s >= 2 ? ' ' + s + ' วินาที' : '') + (s >= 4 ? ' (ครั้งแรกอาจใช้ถึง 15 วินาที ครั้งต่อไปจะขึ้นทันที)' : ''));
    };
    draw();
    tick = setInterval(draw, 1000);
  }
  function doneLoading() { if (tick) clearInterval(tick); tick = null; const b = document.getElementById('p191-bar'); if (b) b.remove(); }
  const when = (iso) => { try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } };

  async function start() {
    applyFrom();
    if (!CFG.mock && (!CFG.apiUrl || !CFG.clientId)) { showCard(null, 'ยังไม่ได้ตั้งค่าระบบ (config.js: apiUrl, clientId)'); return; }
    if (FRESH_ONLY) {
      try {
        const sess = await api('session', [], true);
        const who = sess.who;
        window.P191_RULES = sess.config;
        applyWho(who);
        if (PAGE === 'import' && !who.canEdit) {
          document.querySelector('main').replaceChildren(el('p', { style: 'padding:24px', text: 'บัญชีนี้ดูข้อมูลได้อย่างเดียว นำเข้าข้อมูลไม่ได้' }));
          return;
        }
        runScripts();
      } catch (e) { if (!onNoAccess(e)) showCard(null, e.message.replace(/^[A-Z_]+: /, '')); }
      return;
    }
    const s = savedToken();
    const have = cached(s ? s.email : null);
    if (have) {
      // Draw at once from the copy on this device, then check for newer data.
      const boot = JSON.parse(have.json);
      window.__BOOT = { data: boot.data, summary: boot.summary };
      window.P191_RULES = boot.config;
      applyWho(boot.who);
      runScripts();
      try {
        const fresh = await api('boot', [], false);
        const kept = keep(fresh);
        if (kept.json !== have.json) location.reload();
      } catch (e) {
        if (onNoAccess(e)) return;
        showBar('ข้อมูลที่แสดงบันทึกไว้เมื่อ ' + when(have.savedAt) + ' เข้าระบบเพื่อดูข้อมูลล่าสุด', 'เข้าระบบ', () => {
          api('boot', [], true).then((f) => { keep(f); location.reload(); }, (err) => { if (!onNoAccess(err)) showBar(err.message.replace(/^[A-Z_]+: /, '')); });
        });
      }
      return;
    }
    try {
      loading('กำลังโหลดข้อมูล...');
      const fresh = await api('boot', [], true);
      keep(fresh);
      window.__BOOT = { data: fresh.data, summary: fresh.summary };
      window.P191_RULES = fresh.config;
      doneLoading();
      applyWho(fresh.who);
      runScripts();
    } catch (e) {
      doneLoading();
      if (!onNoAccess(e)) showCard(null, e.message.replace(/^[A-Z_]+: /, ''));
    }
  }

  window.P191 = { signOut, api: (a, args) => api(a, args, true) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function first() {
    document.removeEventListener('DOMContentLoaded', first);
    start();
  });
  else start();
})();
