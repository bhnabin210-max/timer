/* ==========================================================================
   LockIn — offline build (adapted from app.js)
   Timer runs fully on-device. Finished sessions go into a local queue and are
   synced to api/session-sync.php whenever the phone is online.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.LOCKIN_CFG || {};
  var API = String(CFG.apiBase || '').replace(/\/+$/, '');
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var KEY_QUEUE = 'lockin.queue', KEY_HIST = 'lockin.history',
      KEY_ACTIVE = 'lockin.active', KEY_PREFS = 'lockin.prefs';
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var state = {
    phase: 'setup', mode: 'timer', durationSec: 25 * 60,
    startTs: 0, endTs: 0, strikes: 0, uuid: null, meta: {},
    tick: null, surrendering: false, finishing: false, suppressUntil: 0,
    pausedAt: 0, pausedTotal: 0, manualPaused: false, wakeLock: null, lastSave: 0
  };

  var RING_R = 96, RING_C = 2 * Math.PI * RING_R;
  var FREE_SEC = 43200;           // free-timer sentinel; must match api/session-*.php
  var GIVEUP_MS = 5000;
  function totalSec() { return state.mode === 'timer' ? FREE_SEC : state.durationSec; }
  var QUOTES = [
    '"Discipline is choosing what you want most over what you want now."',
    '"The secret to getting ahead is getting started." — Mark Twain',
    '"Focus on being productive instead of busy." — Tim Ferriss',
    '"Small daily improvements are the key to staggering long-term results."',
    '"You don\'t have to be great to start, but you have to start to be great."',
    '"Concentration is the secret of strength." — Ralph Waldo Emerson',
    '"How we spend our days is how we spend our lives." — Annie Dillard',
    '"Motivation gets you started. Habit keeps you going." — Jim Ryun',
    '"Deep work is the superpower of the 21st century." — Cal Newport',
    '"One session at a time. That\'s how streaks are built."'
  ];

  /* ---------------------------- Helpers ---------------------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }
  function fmtHuman(sec) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + 'h';
    return m + 'm';
  }
  function praiseFor(sec) {
    if (sec >= 3 * 3600) return { emoji: '👑', label: 'Legendary', line: 'Three hours in one sitting is almost unheard of. You did that.' };
    if (sec >= 2 * 3600) return { emoji: '🧠', label: 'Elite focus', line: 'Two hours straight is rare air — very few people can hold focus this long.' };
    if (sec >= 90 * 60) return { emoji: '⚡', label: 'Deep worker', line: 'Only a small fraction of people ever focus for an hour and a half straight.' };
    if (sec >= 60 * 60) return { emoji: '🔥', label: 'Locked in', line: 'A full hour of real focus puts you ahead of most people.' };
    if (sec >= 30 * 60) return { emoji: '💪', label: 'Strong session', line: 'Half an hour of uninterrupted focus — more than most people manage in a day.' };
    if (sec >= 15 * 60) return { emoji: '🌱', label: 'Building', line: 'You showed up and stayed. That already beats the crowd.' };
    return { emoji: '✨', label: 'Started', line: 'Every grinder starts somewhere — and you started.' };
  }
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }
  function showScreen(name) {
    $$('.screen').forEach(function (el) { el.classList.remove('active'); });
    $('#screen-' + name).classList.add('active');
    state.phase = name;
    window.scrollTo(0, 0);
  }
  function locked() { return state.phase === 'lock'; }
  function grace(ms) { state.suppressUntil = Date.now() + (ms || 1200); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function sha256Hex(str) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }).catch(function () { return null; });
  }

  /* ---------------------- Timer (pause logic as original) ---------------------- */
  function focusedElapsedMs() {
    var now = state.pausedAt || Date.now();
    return Math.max(0, now - state.startTs - state.pausedTotal);
  }
  function pauseTimer() {
    if (!locked() || state.finishing || state.surrendering || state.pausedAt) return;
    state.pausedAt = Date.now();
    var b = $('#paused-badge'); if (b) b.style.display = '';
    persistActive(true); tickNow();
  }
  function resumeTimer() {
    if (!state.pausedAt) return;
    state.pausedTotal += Date.now() - state.pausedAt;
    state.pausedAt = 0;
    var b = $('#paused-badge'); if (b) b.style.display = 'none';
    persistActive(true);
    if (locked() && !state.finishing) tickNow();
  }
  function setPauseButton(paused) {
    var b = $('#btn-pause'); if (!b) return;
    b.textContent = paused ? '▶ Resume' : '⏸ Pause';
    b.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }
  function toggleManualPause() {
    if (!locked() || state.finishing || state.surrendering) return;
    if (state.manualPaused) {
      state.manualPaused = false; resumeTimer(); setPauseButton(false); grace(800); toast('Timer resumed.');
    } else {
      state.manualPaused = true; pauseTimer(); setPauseButton(true); toast('Timer paused.');
    }
  }

  /* An interrupted session (app killed) can be recovered from this snapshot. */
  function persistActive(force) {
    var now = Date.now();
    if (!force && now - state.lastSave < 4000) return;
    state.lastSave = now;
    lsSet(KEY_ACTIVE, {
      uuid: state.uuid, startTs: state.startTs, pausedAt: state.pausedAt, pausedTotal: state.pausedTotal,
      mode: state.mode, durationSec: state.durationSec, strikes: state.strikes, meta: state.meta, lastTs: now
    });
  }

  /* -------------------------- Local data -------------------------- */
  function earned(rec) {
    var free = rec.duration_sec === FREE_SEC;
    var reached = free ? rec.completed_sec >= 600 : rec.completed_sec >= rec.duration_sec;
    return reached && rec.strikes === 0 && !rec.gave_up;   // same rule as session-finish.php
  }
  function localDay(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function localStreak() {
    var days = {};
    lsGet(KEY_HIST, []).forEach(function (h) { if (h.deserves) days[h.day] = 1; });
    var cur = 0, d = new Date();
    if (!days[localDay(d.getTime())]) d.setDate(d.getDate() - 1);
    while (days[localDay(d.getTime())]) { cur++; d.setDate(d.getDate() - 1); }
    var best = 0, run = 0, prev = null;
    Object.keys(days).sort().forEach(function (k) {
      run = (prev && dayDiff(prev, k) === 1) ? run + 1 : 1;
      if (run > best) best = run; prev = k;
    });
    return { current: cur, best: best };
  }
  function saveResult(rec) {
    var q = lsGet(KEY_QUEUE, []); q.push(rec); lsSet(KEY_QUEUE, q);
    var h = lsGet(KEY_HIST, []);
    h.push({ uuid: rec.client_uuid, day: localDay(rec.finished_at), completed_sec: rec.completed_sec,
             deserves: earned(rec), synced: false });
    lsSet(KEY_HIST, h.slice(-300));
    lsDel(KEY_ACTIVE);
  }

  /* ------------------------------ Sync ------------------------------ */
  var syncState = { busy: false, error: null };
  function paintSync(el) {
    if (!el) return;
    var n = lsGet(KEY_QUEUE, []).length, txt, cls = '';
    el.textContent = '';
    if (syncState.busy) txt = '🔄 Syncing ' + n + ' session' + (n === 1 ? '' : 's') + '…';
    else if (n === 0) txt = '☁ All sessions synced';
    else if (syncState.error) { txt = '⚠ ' + n + ' saved on this phone — ' + syncState.error; cls = 'chip-gold'; }
    else if (navigator.onLine === false) { txt = '📴 Offline — ' + n + ' session' + (n === 1 ? '' : 's') + ' saved on this phone'; cls = 'chip-gold'; }
    else txt = '⏳ ' + n + ' waiting to sync';
    var chip = document.createElement('span'); chip.className = 'chip ' + cls; chip.textContent = txt; el.appendChild(chip);
    if (n > 0 && !syncState.busy) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost'; b.textContent = 'Sync now';
      b.addEventListener('click', function () { syncNow(true); });
      el.appendChild(b);
    }
  }
  function renderSync() { paintSync($('#sync-area')); paintSync($('#finish-sync')); }

  function postJson(path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (CFG.syncKey) headers['X-Lockin-Key'] = CFG.syncKey;
    var req = fetch(API + path, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { throw new Error('server did not return JSON'); } });
    var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timed out')); }, 20000); });
    return Promise.race([req, timeout]);
  }
  function markSynced(done) {
    var h = lsGet(KEY_HIST, []);
    h.forEach(function (x) { if (done[x.uuid]) { x.synced = true; } });
    lsSet(KEY_HIST, h);
  }
  function syncNow(manual) {
    if (syncState.busy) return;
    var q = lsGet(KEY_QUEUE, []);
    if (!q.length) { syncState.error = null; renderSync(); return; }
    if (!API) { syncState.error = 'no server address set'; renderSync(); return; }
    if (navigator.onLine === false) {
      syncState.error = null; renderSync();
      if (manual) toast('You are offline — sessions stay saved on this phone.');
      return;
    }
    syncState.busy = true; syncState.error = null; renderSync();
    postJson('/api/session-sync.php', { sessions: q.slice(0, 20) }).then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.results)) throw new Error((res && res.message) || 'unexpected reply');
      var done = {}, anyErr = false;
      res.results.forEach(function (r) { if (r.status === 'error') anyErr = true; else done[r.client_uuid] = r; });
      var rest = lsGet(KEY_QUEUE, []).filter(function (s) { return !done[s.client_uuid]; });
      lsSet(KEY_QUEUE, rest); markSynced(done);
      syncState.busy = false;
      if (anyErr) syncState.error = 'server error, will retry';
      renderSync();
      if (!anyErr && rest.length && Object.keys(done).length) syncNow();
    }).catch(function (e) {
      syncState.busy = false;
      syncState.error = /fetch|network/i.test(String(e && e.message)) ? 'no connection' : String((e && e.message) || 'sync failed');
      renderSync();
    });
  }

  /* --------------------------- Setup screen --------------------------- */
  var pills = $$('.pill[data-min]');
  var customInput = $('#custom-min');
  function setDuration(sec) {
    state.durationSec = Math.max(60, Math.min(14400, Math.round(sec)));
    pills.forEach(function (p) { p.setAttribute('aria-pressed', String(parseInt(p.dataset.min, 10) * 60 === state.durationSec)); });
    if (customInput) customInput.value = Math.round(state.durationSec / 60);
  }
  pills.forEach(function (p) { p.addEventListener('click', function () { setDuration(parseInt(p.dataset.min, 10) * 60); }); });

  var modeTimerBtn = $('#mode-timer'), modeGoalBtn = $('#mode-goal'), goalWrap = $('#goal-wrap'), modeHint = $('#mode-hint');
  function setMode(m) {
    state.mode = (m === 'goal') ? 'goal' : 'timer';
    var goal = state.mode === 'goal';
    modeTimerBtn.setAttribute('aria-pressed', String(!goal));
    modeGoalBtn.setAttribute('aria-pressed', String(goal));
    goalWrap.hidden = !goal;
    modeHint.textContent = goal
      ? 'Counts down to your goal. Hit it with zero strikes to extend your streak.'
      : "Counts up from 0:00. Finish whenever you're done — no goal, no pressure.";
  }
  modeTimerBtn.addEventListener('click', function () { setMode('timer'); });
  modeGoalBtn.addEventListener('click', function () { setMode('goal'); });
  customInput.addEventListener('change', function () {
    var v = parseInt(customInput.value, 10); if (!v || v < 1) v = 1; setDuration(v * 60);
  });

  var prefs = lsGet(KEY_PREFS, {});
  if (prefs.name) $('#field-name').value = prefs.name;
  if (prefs.anon) $('#field-anon').checked = true;
  if (prefs.email) { $('#field-email').value = prefs.email; $('#consent-email').checked = !!prefs.consent; }

  var startBtn = $('#btn-start');
  function resetStartBtn() { startBtn.disabled = false; startBtn.textContent = 'Lock in'; }
  startBtn.addEventListener('click', function () {
    var name = ($('#field-name').value || '').trim();
    var email = ($('#field-email').value || '').trim();
    var consent = $('#consent-email').checked;
    var anonymous = $('#field-anon').checked;
    if (email && !consent) { toast('Tick the consent box (or clear the email) to continue.'); $('#consent-email').focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('That email does not look valid.'); $('#field-email').focus(); return; }
    if (state.mode === 'goal') {
      var mins = parseInt(customInput.value, 10);
      if (mins && mins * 60 !== state.durationSec) setDuration(mins * 60);
    }
    lsSet(KEY_PREFS, { name: name, anon: anonymous, email: email, consent: consent });
    startBtn.disabled = true; startBtn.textContent = 'Locking in…';
    (email ? sha256Hex(email.toLowerCase()) : Promise.resolve(null)).then(function (hash) {
      state.meta = { name: name || null, anonymous: anonymous, email: email || null, emailHash: hash };
      state.uuid = uuid();
      enterLockMode();
    });
  });

  /* ----------------------------- Lock mode ----------------------------- */
  var ringBar = $('#lock-ring-bar'), giveupBtn = $('#giveup');

  function enterLockMode() {
    showScreen('lock');
    grace(2000);
    requestFullscreen(); requestWakeLock();
    state.finishing = false; state.surrendering = false;
    state.startTs = Date.now(); state.endTs = state.startTs + totalSec() * 1000;
    state.pausedAt = 0; state.pausedTotal = 0; state.manualPaused = false;
    setPauseButton(false);
    $('#paused-badge').style.display = 'none';
    $('#strike-overlay').classList.remove('open');
    updateStrikes(0);
    $('#giveup-label').textContent = state.mode === 'timer' ? 'finish (hold 5s)' : 'give up (hold 5s)';
    ringBar.style.strokeDasharray = String(RING_C); ringBar.style.strokeDashoffset = String(RING_C);
    persistActive(true);
    tickNow();
    state.tick = setInterval(tickNow, 250);
  }

  function tickNow() {
    var now = state.pausedAt || Date.now();
    var remainingMs = state.endTs - now + state.pausedTotal;
    var elapsedMs = Math.max(0, now - state.startTs - state.pausedTotal);
    var shownSec = state.mode === 'timer' ? Math.floor(elapsedMs / 1000) : Math.max(0, remainingMs / 1000);
    $('#lock-time').textContent = fmt(shownSec);
    $('#lock-clock').textContent = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var frac = state.mode === 'timer'
      ? (elapsedMs % 3600000) / 3600000
      : Math.min(1, Math.max(0, 1 - remainingMs / (state.durationSec * 1000)));
    ringBar.style.strokeDashoffset = String(RING_C * (1 - frac));
    if (!state.finishing) persistActive(false);
    if (remainingMs <= 0 && !state.finishing && !state.pausedAt) finishSession(false);
  }

  function requestFullscreen() {
    var el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) { try { var p = fn.call(el); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  function exitFullscreen() {
    try { if (document.fullscreenElement) { var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {}); } } catch (e) {}
  }
  function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (wl) { state.wakeLock = wl; }).catch(function () {});
      }
    } catch (e) {}
  }
  function updateStrikes(n) {
    state.strikes = n;
    var el = $('#strikes-badge');
    el.textContent = n === 0 ? 'clean · 0 strikes' : n + ' strike' + (n === 1 ? '' : 's');
    el.className = 'chip' + (n === 0 ? '' : ' chip-gold');
    if (locked()) persistActive(true);
  }

  function violation(reason) {
    if (!locked() || state.finishing || state.surrendering) return;
    if (Date.now() < state.suppressUntil) return;
    grace(1200);
    updateStrikes(state.strikes + 1);
    $('#strike-reason').textContent = reason;
    $('#strike-overlay').classList.add('open');
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      pauseTimer();
      violation('you left the app');
    } else if (locked() && !state.finishing) {
      requestWakeLock();
      if (!state.manualPaused) { resumeTimer(); tickNow(); }
      syncNow();
    }
  });
  window.addEventListener('blur', function () { pauseTimer(); violation('the app lost focus'); });
  window.addEventListener('focus', function () {
    if (locked() && !state.finishing && !state.manualPaused) { resumeTimer(); tickNow(); }
  });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && locked()) violation('fullscreen was exited');
  });
  document.addEventListener('keydown', function (e) {
    if (!locked()) return;
    if ((e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      e.preventDefault(); toggleManualPause();
    }
  });

  $('#btn-pause').addEventListener('click', toggleManualPause);
  $('#btn-resume').addEventListener('click', function () {
    $('#strike-overlay').classList.remove('open');
    grace(1500); requestFullscreen(); tickNow();
  });

  /* Give up / finish: press and hold 5 seconds */
  var holdTimer = null;
  function startHold() { if (!locked() || state.finishing) return; giveupBtn.classList.add('holding'); holdTimer = setTimeout(surrender, GIVEUP_MS); }
  function cancelHold() { giveupBtn.classList.remove('holding'); if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
  giveupBtn.addEventListener('pointerdown', startHold);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { giveupBtn.addEventListener(ev, cancelHold); });
  function surrender() {
    cancelHold();
    if (state.finishing) return;
    state.surrendering = true;
    finishSession(state.mode !== 'timer');   // free timer: holding the button is a normal finish
  }

  /* ------------------------------- Finish ------------------------------- */
  function finishSession(gaveUp) {
    if (state.finishing) return;
    state.finishing = true; state.manualPaused = false;
    clearInterval(state.tick);
    if (state.wakeLock && state.wakeLock.release) { try { state.wakeLock.release(); } catch (e) {} }
    exitFullscreen();
    $('#strike-overlay').classList.remove('open');

    var elapsed = Math.round(focusedElapsedMs() / 1000), total = totalSec();
    var completed = (gaveUp || state.mode === 'timer') ? Math.min(total, Math.max(0, elapsed)) : total;
    var rec = {
      client_uuid: state.uuid, started_at: state.startTs, finished_at: Date.now(),
      duration_sec: total, completed_sec: completed, strikes: state.strikes, gave_up: !!gaveUp,
      name: state.meta.name, anonymous: !!state.meta.anonymous,
      email: state.meta.email, email_hash: state.meta.emailHash
    };
    saveResult(rec);
    renderFinish(rec);
    syncNow();
  }

  var quoteTimer = null;
  function renderFinish(r) {
    var free = r.duration_sec === FREE_SEC, full = r.completed_sec >= r.duration_sec, gaveUp = r.gave_up;
    $('#finish-title').textContent = gaveUp ? 'You tapped out.' : (full || free ? 'Session complete. You locked in. 🔒' : 'Session ended.');
    $('#finish-sub').textContent = gaveUp
      ? ('You held ' + fmtHuman(r.completed_sec) + (free ? '' : ' of a ' + fmtHuman(r.duration_sec) + ' target') + '. Come back stronger.')
      : ('You locked in for ' + fmtHuman(r.completed_sec) + ' straight. Zero mercy given to distractions.');

    var streak = localStreak(), chips = $('#finish-chips');
    chips.innerHTML = '';
    [
      ['🎯 ' + fmtHuman(r.completed_sec) + ' focused', ''],
      [r.strikes === 0 ? '🛡 clean — no strikes' : '⚠ ' + r.strikes + ' strike' + (r.strikes === 1 ? '' : 's'), r.strikes === 0 ? '' : 'chip-gold'],
      streak.current >= 2 ? ['🔥 ' + streak.current + '-day streak (best ' + streak.best + ')', ''] : null
    ].forEach(function (c) {
      if (!c) return;
      var el = document.createElement('span'); el.className = 'chip ' + c[1]; el.textContent = c[0]; chips.appendChild(el);
    });

    var pr = praiseFor(r.completed_sec), praiseEl = $('#finish-praise');
    praiseEl.textContent = '';
    var t = document.createElement('strong'); t.textContent = pr.emoji + ' ' + pr.label;
    var l = document.createElement('span'); l.textContent = pr.line;
    praiseEl.appendChild(t); praiseEl.appendChild(l);

    var qEl = $('#quote'), qi = Math.floor(Math.random() * QUOTES.length);
    qEl.textContent = QUOTES[qi];
    clearInterval(quoteTimer);
    quoteTimer = setInterval(function () {
      qEl.classList.add('fading');
      setTimeout(function () { qi = (qi + 1) % QUOTES.length; qEl.textContent = QUOTES[qi]; qEl.classList.remove('fading'); }, 400);
    }, 4500);

    renderSync();
    showScreen('finish');
  }

  $('#btn-again').addEventListener('click', function () {
    clearInterval(quoteTimer); resetStartBtn(); renderSync(); showScreen('setup');
  });

  /* ----------------------- Recovery, back button, sync triggers ----------------------- */
  (function recoverActive() {
    var a = lsGet(KEY_ACTIVE, null);
    if (!a || !a.uuid) return;
    lsDel(KEY_ACTIVE);
    var total = a.mode === 'timer' ? FREE_SEC : a.durationSec;
    var upto = a.pausedAt || a.lastTs;
    var completed = Math.min(total, Math.max(0, Math.floor((upto - a.startTs - a.pausedTotal) / 1000)));
    if (completed < 30) return;
    var meta = a.meta || {};
    saveResult({
      client_uuid: a.uuid, started_at: a.startTs, finished_at: a.lastTs,
      duration_sec: total, completed_sec: completed,
      strikes: (a.strikes || 0) + (a.pausedAt ? 0 : 1),     // app closed in foreground = a strike
      gave_up: a.mode === 'goal' && completed < total,
      name: meta.name || null, anonymous: !!meta.anonymous, email: meta.email || null, email_hash: meta.emailHash || null
    });
    toast('Recovered an interrupted session (' + fmtHuman(completed) + ').');
  })();

  var CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) {
    CapApp.addListener('backButton', function () {
      if (locked() && !state.finishing) { toast('Still locked in — hold the button 5 seconds to end.'); return; }
      if (state.phase === 'finish') { $('#btn-again').click(); return; }
      CapApp.exitApp();
    });
  }

  window.addEventListener('online', function () { syncState.error = null; renderSync(); syncNow(); });
  window.addEventListener('offline', renderSync);
  setInterval(function () { if (lsGet(KEY_QUEUE, []).length) syncNow(); }, 60000);
  renderSync();
  syncNow();
})();
