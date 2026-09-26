// ==UserScript==
// @name         gartic.online oda sohbeti
// @namespace    https://gartic.online
// @version      1.5.0
// @description  Gartic.io Kayıtlar panelini oda sohbetine bağlar
// @match        https://gartic.io/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==
(() => {
  'use strict';

  const FLAG = '__garticOnlineV1';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const DEFAULT_BACKEND = 'https://gartic-online-backend-production.up.railway.app';
  const MAX_MESSAGES = 200;
  const MAX_DOM_MESSAGES = 100;

  const store = {
    get(key, fallback = null) { try { const v = window.localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch {} },
  };
  const ADMIN_KEY = store.get('garticOnlineAdminKey', '');
  const BACKEND = (store.get('garticOnlineBackend') || DEFAULT_BACKEND).replace(/\/$/, '');

  const loadIgnored = () => {
    try { const list = JSON.parse(store.get('garticOnlineIgnored', '[]')); return new Set(Array.isArray(list) ? list.map(String) : []); }
    catch { return new Set(); }
  };
  const saveIgnored = () => store.set('garticOnlineIgnored', JSON.stringify([...state.ignored]));

  const state = {
    key: null, identity: null, session: null, socket: null, attempt: 0,
    status: 'idle', errorAt: 0, refreshes: 0, failNotified: false, announcedKey: null,
    messages: [], seen: new Set(), messageRoom: null, host: null, bar: null,
    ignored: loadIgnored(), draft: '', members: new Map(),
  };
  window.__garticOnline = { state };

  const $ = (selector, root = document) => root.querySelector(selector);
  const clean = (value, max = 120) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim().slice(0, max);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const isMine = (m) => !!state.session?.user?.id && m.senderId === state.session.user.id;
  const isVisible = (m) => isMine(m) || !state.ignored.has(String(m.senderId));

  // ---------- Gartic oda nesnesinden kimlik ----------
  // room.js oyun dizisi: game[1]=oyuncu index'i, game[2]=oyuncu id'si,
  // game[3]=oda kodu, game[5]=oyuncu listesi.
  function readContext() {
    const data = window.CACHE_DATA;
    if (!data || typeof data !== 'object' || !document.getElementById('screenRoom')) return null;
    const game = data.game;
    if (!game) return null;
    const userIndex = clean(game[1]);
    const userId = clean(game[2]);
    const roomId = clean(game[3]);
    if (!userIndex || !userId || !roomId) return null;
    const players = Array.isArray(game[5]) ? game[5] : [];
    const me = players.find((p) => p && (String(p.id) === userId || String(p.index) === userIndex));
    const nickname = clean(me?.nick || data.user?.nome || data.user?.nick, 40);
    if (!nickname) return null;
    const avatarValue = me?.avatar ?? data.user?.avatar;
    return { roomId, userId, userIndex, nickname, avatar: avatarValue == null ? undefined : clean(avatarValue, 500), source: 'cache' };
  }

  // ---------- Toast: Gartic'in kendi popUps sıçrama animasyonuyla ----------
  const TOAST_ICON = {
    ok: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>',
    error: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 1 21h22L12 2Zm0 15.6a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm1-4.6h-2V9h2v4Z"/></svg>',
  };
  function toast(title, detail, error = false) {
    let node = $('#go-toast');
    if (!node) { node = el('div'); node.id = 'go-toast'; document.documentElement.appendChild(node); }
    node.classList.remove('go-toast-out');
    void node.offsetWidth; // yeniden başlat: aynı toast art arda gelirse animasyon tekrarlasın
    node.className = 'go-toast go-toast-in' + (error ? ' go-toast-error' : '');
    const icon = el('span', 'go-toast-icon'); icon.innerHTML = error ? TOAST_ICON.error : TOAST_ICON.ok;
    const text = el('div', 'go-toast-text');
    text.append(el('strong', '', title), el('small', '', detail));
    node.replaceChildren(icon, text);
    clearTimeout(node._timer);
    node._timer = setTimeout(() => {
      node.classList.remove('go-toast-in'); node.classList.add('go-toast-out');
    }, 4200);
  }

  // ---------- Gartic'in KAYITLAR listesine mesaj ekleme (kendi .msg yapısıyla) ----------
  const chatBox = () => $('#screenRoom #chat');
  // .scrollElements dikey (column) kutu; mesajlar burada alt alta dizilir.
  // .history yatay (row) bir sarmalayıcı olduğu için doğrudan oraya eklenirse mesajlar yan yana diziliyordu.
  const chatHost = () => $('#screenRoom #chat .scrollElements') || $('#screenRoom #chat .history');

  function updateRecordsTitle() {
    const chat = chatBox();
    if (!chat) return;
    // Sadece #chat'in kendi başlık h5'ine dokun; sayfadaki başka "KAYITLAR" eşleşmelerine dokunma
    // (geniş bir seçici mobil/gizli elemanlara da isabet edip başlığın başka yerde tekrar çıkmasına sebep oluyordu).
    chat.querySelectorAll(':scope > h5').forEach((node) => {
      if (node.textContent?.trim().toUpperCase() === 'KAYITLAR') node.textContent = 'CHAT';
    });
  }

  function findScroller(host) {
    for (let n = host; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  }
  const nearBottom = (host) => { const s = findScroller(host); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 48; };
  const scrollToEnd = (host) => { const s = findScroller(host); if (s) s.scrollTop = s.scrollHeight; };

  // Gartic'in gerçek chat mesajı: <div class="msg [you]"><div><strong>Nick</strong> <span>metin</span></div></div>
  // Bu yapı sayesinde renk/yazı tipi Gartic'in kendi CSS'inden geliyor, hiçbir şey ezmiyoruz.
  function messageNode(m) {
    const mine = isMine(m);
    const row = el('div', mine ? 'msg go-msg you' : 'msg go-msg');
    row.dataset.id = String(m.id);
    row.dataset.sender = String(m.senderId);
    const body = el('div');
    const nick = el('button', 'go-profile', m.nickname || 'Misafir');
    nick.type = 'button'; nick.dataset.sender = String(m.senderId); nick.title = 'Profili aç';
    // Boşluk butonun İÇİNDE değil dışında olmalı: Chrome <button> iç düzeni son boşluğu siliyor.
    body.append(nick, document.createTextNode(' '), el('span', '', m.body));
    if (!mine) {
      const btn = el('button', 'go-ign', '⦸');
      btn.type = 'button'; btn.title = 'Bu kullanıcıyı yoksay';
      body.append(document.createTextNode(' '), btn);
    }
    row.append(body);
    return row;
  }

  function renderAll() {
    const host = chatHost();
    state.host = host;
    updateBar();
    if (!host) return;
    host.querySelectorAll('.go-msg').forEach((n) => n.remove());
    host.append(...state.messages.filter(isVisible).slice(-MAX_DOM_MESSAGES).map(messageNode));
    scrollToEnd(host);
  }

  function addMessage(m) {
    if (!m || !m.id || state.seen.has(m.id)) return;
    state.seen.add(m.id);
    state.messages.push(m);
    if (state.messages.length > MAX_MESSAGES) state.seen.delete(state.messages.shift().id);
    if (!isVisible(m)) return;
    const host = chatHost();
    if (!host) return;
    if (host !== state.host) return renderAll();
    const stick = nearBottom(host) || isMine(m);
    host.appendChild(messageNode(m));
    const nodes = host.querySelectorAll('.go-msg');
    if (nodes.length > MAX_DOM_MESSAGES) nodes[0].remove();
    if (stick) scrollToEnd(host);
  }

  function ignoreSender(id) {
    state.ignored.add(String(id));
    saveIgnored();
    const host = chatHost();
    host?.querySelectorAll('.go-msg').forEach((n) => { if (n.dataset.sender === String(id)) n.remove(); });
    updateBar();
  }

  document.addEventListener('click', (event) => {
    const btn = event.target instanceof Element ? event.target.closest('.go-ign') : null;
    const row = btn?.closest('.go-msg');
    if (row) ignoreSender(row.dataset.sender);
  }, true);

  const AVATAR_PALETTE = ['#0a5efb', '#21c19b', '#f8bf33', '#f45531', '#1791ff', '#a259ff', '#ff5fa2', '#00c2a8'];
  function hashColor(seed) {
    let hash = 0;
    const text = String(seed || '');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  }
  const ICON_IGNORE = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4C7 4 2.7 7.1 1 12c1.7 4.9 6 8 11 8s9.3-3.1 11-8c-1.7-4.9-6-8-11-8Zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/><path fill="currentColor" d="m3 3 18 18-1.4 1.4L1.6 4.4 3 3Z" opacity=".9"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm12.6 1.4L6.4 19 5 17.6 17.6 5 19 6.4Z"/></svg>';

  function profilePopup(senderId, nickname) {
    $('#go-profile-popup')?.remove();
    const name = clean(nickname, 40) || 'Oyuncu';
    const color = hashColor(senderId || name);
    const initial = [...name.trim()][0]?.toUpperCase() || '?';
    const isSelf = isMine({ senderId });

    const overlay = el('div', 'go-profile-overlay'); overlay.id = 'go-profile-popup';
    const card = el('div', 'go-profile-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', name);

    const band = el('div', 'go-profile-band'); band.style.background = `linear-gradient(135deg, ${color}, #0a1f4d)`;
    const closeTop = el('button', 'go-profile-x'); closeTop.type = 'button'; closeTop.innerHTML = ICON_CLOSE; closeTop.title = 'Kapat';
    closeTop.addEventListener('click', () => closePopup());
    band.append(closeTop);

    const avatar = el('div', 'go-profile-avatar', initial); avatar.style.background = color;

    const body = el('div', 'go-profile-body');
    const title = el('strong', 'go-profile-name', name);
    const subtitle = el('small', 'go-profile-sub', isSelf ? 'bu sensin' : 'gartic.online sohbet kullanıcısı');
    body.append(title, subtitle);

    if (!isSelf) {
      const actions = el('div', 'go-profile-actions');
      const ignore = el('button', 'go-profile-action go-profile-action-danger'); ignore.type = 'button';
      ignore.innerHTML = `${ICON_IGNORE}<span>Yoksay</span>`;
      ignore.addEventListener('click', () => { ignoreSender(senderId); closePopup(); });
      actions.append(ignore);
      body.append(actions);
    }

    card.append(band, avatar, body);
    overlay.append(card);

    function closePopup() {
      overlay.classList.remove('go-profile-visible');
      overlay.classList.add('go-profile-leaving');
      setTimeout(() => overlay.remove(), 180);
    }

    overlay.addEventListener('click', (event) => { if (event.target === overlay) closePopup(); });
    overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopup(); });
    document.body.append(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('go-profile-visible')));
    closeTop.focus();
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.go-profile') : null;
    if (button) profilePopup(button.dataset.sender, button.textContent?.trim());
  }, true);

  // ---------- Alttaki yazı satırı: cevap kutusunun stilini klonlayıp Gartic temasına uydur ----------
  function ensureBar() {
    const chat = chatBox();
    if (!chat) return null;
    const answerForm = $('#interaction #answer form');
    const answerInput = answerForm?.querySelector('.textGame input.mousetrap, input[name="answer"], input');
    let bar = $('#go-bar');
    if (bar && bar.isConnected && bar.parentElement === chat) { state.bar = bar; return bar; }
    if (bar) bar.remove();

    const answerShell = answerInput?.closest('.textGame');
    bar = el('form', `${answerShell?.className || 'textGame'} go-bar`); bar.id = 'go-bar';
    const input = answerInput ? answerInput.cloneNode(false) : el('input');
    input.id = 'go-input'; input.name = 'gartic-online-chat'; input.type = 'text'; input.maxLength = 500; input.autocomplete = 'off'; input.value = state.draft; input.disabled = false;
    if (answerInput) {
      input.placeholder = answerInput.getAttribute('placeholder') || '';
      const computed = getComputedStyle(answerInput);
      for (const property of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border', 'border-radius', 'padding', 'height', 'box-sizing', 'outline']) input.style.setProperty(property, computed.getPropertyValue(property));
    }
    bar.append(input);

    input.addEventListener('input', () => { state.draft = input.value; });
    for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    bar.addEventListener('submit', onSubmit);

    chat.appendChild(bar);
    state.bar = bar;
    updateBar();
    renderUserBadges();
    return bar;
  }

  function badgeNode(isAdmin) {
      const badge = el('span', isAdmin ? 'go-crown' : 'go-user-badge');
      badge.innerHTML = isAdmin
        ? '<svg viewBox="0 0 24 24" aria-label="Yönetici"><path fill="currentColor" d="m3 7 4.2 3.2L12 4l4.8 6.2L21 7l-1.2 11H4.2L3 7Zm3 9h12l.25-2.2-3.5 2.1L12 11l-2.75 4.9-3.5-2.1L6 16Z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-label="gartic.online kullanıcısı"><circle cx="12" cy="8" r="3.2" fill="currentColor"/><path fill="currentColor" d="M5 20c.4-3.5 2.8-5.4 7-5.4s6.6 1.9 7 5.4H5Z"/></svg>';
      return badge;
  }

  function renderUserBadges() {
    document.querySelectorAll('#users .go-companion-badge').forEach((node) => node.remove());
    for (const member of state.members.values()) {
      const nick = clean(member.nickname, 40);
      if (!nick) continue;
      const row = [...document.querySelectorAll('#users .user:not(.empty)')].find((node) => node.querySelector('.nick')?.textContent?.trim() === nick);
      const target = row?.querySelector('.infosPlayer .nick');
      if (!target) continue;
      const badge = badgeNode(Boolean(member.isAdmin));
      badge.classList.add('go-companion-badge');
      badge.title = member.isAdmin ? 'gartic.online yöneticisi' : 'gartic.online sohbet kullanıcısı';
      target.before(badge);
    }
  }

  function updateBar() {
    const input = $('#go-input');
    if (input) input.placeholder = state.status === 'online' ? 'Sohbet için yaz…' : 'Bağlanıyor…';
  }
  function setStatus(status) { state.status = status; updateBar(); }

  function onSubmit(event) {
    event.preventDefault();
    const input = $('#go-input');
    if (!input) return;
    const body = clean(input.value, 500);
    if (!body) return;
    if (state.status !== 'online' || !state.socket?.connected) { toast('Bağlı değil', 'Sunucuya bağlanınca tekrar dene.', true); return; }
    input.value = ''; state.draft = '';
    state.socket.timeout(5000).emit('chat:send', { body }, (error, result) => {
      if (error || !result?.ok) {
        toast('Mesaj gönderilemedi', result?.error === 'rate_limited' ? 'Çok hızlı yazıyorsun.' : 'Mesaj iletilemedi.', true);
        const now = $('#go-input');
        if (now && !now.value) { now.value = body; state.draft = body; }
      }
    });
  }

  // ---------- Backend ----------
  async function requestSession(identity) {
    const headers = { 'Content-Type': 'application/json' };
    if (ADMIN_KEY) headers['x-gartic-admin-key'] = ADMIN_KEY;
    const response = await fetch(`${BACKEND}/v1/session/anonymous`, {
      method: 'POST', headers, body: JSON.stringify(identity), credentials: 'omit',
    });
    if (!response.ok) throw new Error(`session_${response.status}`);
    return response.json();
  }

  let ioPromise = null;
  function loadSocketIo() {
    if (window.io && window.io.protocol >= 5) return Promise.resolve(window.io);
    ioPromise ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.socket.io/4.8.1/socket.io.min.js';
      script.onload = () => (window.io ? resolve(window.io) : reject(new Error('socket_io_missing')));
      script.onerror = () => { ioPromise = null; reject(new Error('socket_io_load_failed')); };
      (document.head || document.documentElement).appendChild(script);
    });
    return ioPromise;
  }

  function teardown() {
    const socket = state.socket;
    state.socket = null;
    if (socket) { try { socket.removeAllListeners(); socket.disconnect(); } catch {} }
  }

  function fail(title, detail) {
    teardown();
    state.errorAt = Date.now();
    setStatus('error');
    if (!state.failNotified) { state.failNotified = true; toast(title, detail, true); }
  }

  function leave() {
    state.attempt++;
    teardown();
    state.key = null; state.identity = null; state.session = null;
    state.messages = []; state.seen.clear(); state.messageRoom = null; state.members.clear(); renderUserBadges();
    setStatus('idle');
  }

  async function onConnectError(attempt, socket, error) {
    if (attempt !== state.attempt) return;
    if (error?.message === 'unauthorized') {
      if (state.refreshes >= 3) return fail('Oturum yenilenemedi', 'Sayfayı yenile.');
      state.refreshes++;
      try {
        state.session = await requestSession(state.identity);
        if (attempt === state.attempt) socket.connect();
      } catch {
        if (attempt === state.attempt) fail('Bağlantı kurulamadı', 'Oturum yenilenemedi.');
      }
      return;
    }
    setStatus('connecting');
  }

  async function connect(ctx, key) {
    const attempt = ++state.attempt;
    teardown();
    state.key = key;
    state.identity = { roomId: ctx.roomId, userId: ctx.userId, userIndex: ctx.userIndex, nickname: ctx.nickname, avatar: ctx.avatar, source: ctx.source };
    state.refreshes = 0;
    if (state.messageRoom !== ctx.roomId) {
      state.messages = []; state.seen.clear(); state.messageRoom = ctx.roomId; renderAll();
    }
    setStatus('connecting');
    try {
      const session = await requestSession(state.identity);
      if (attempt !== state.attempt) return;
      state.session = session;
      const io = await loadSocketIo();
      if (attempt !== state.attempt) return;
      const socket = io(BACKEND, {
        auth: (cb) => cb({ token: state.session.token }),
        transports: ['websocket'], reconnection: true, timeout: 8000,
      });
      state.socket = socket;
      socket.on('connect', () => {
        if (attempt !== state.attempt) return;
        state.failNotified = false;
        setStatus('online');
        socket.emit('identity:confirm', state.identity);
        if (state.announcedKey !== key) { state.announcedKey = key; toast('Oda sohbeti hazır', `${ctx.nickname} · ${ctx.roomId}`); }
      });
      socket.on('chat:message', addMessage);
      socket.on('chat:history', (list) => Array.isArray(list) && list.forEach(addMessage));
      socket.on('room:ready', (payload) => {
        if (Array.isArray(payload?.history)) payload.history.forEach(addMessage);
        if (Array.isArray(payload?.members)) { state.members = new Map(payload.members.filter((m) => m?.userId).map((m) => [String(m.userId), m])); renderUserBadges(); }
      });
      socket.on('room:presence', (member) => { if (member?.userId) { state.members.set(String(member.userId), member); renderUserBadges(); } });
      socket.on('room:leave', (member) => { if (member?.userId) { state.members.delete(String(member.userId)); renderUserBadges(); } });
      socket.on('session:rejected', () => { if (attempt === state.attempt) fail('Oda doğrulanamadı', 'Gartic kimliği eşleşmedi.'); });
      socket.on('disconnect', (reason) => {
        if (attempt !== state.attempt) return;
        if (reason === 'io server disconnect') { state.errorAt = Date.now(); setStatus('error'); return; }
        setStatus('connecting');
      });
      socket.on('connect_error', (error) => onConnectError(attempt, socket, error));
    } catch (error) {
      if (attempt === state.attempt) fail('Bağlantı kurulamadı', error?.message || 'Sunucuya ulaşılamadı.');
    }
  }

  // ---------- Ana döngü ----------
  function ensureStyle() {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    let style = $('#go-style');
    if (!style) { style = el('style'); style.id = 'go-style'; parent.appendChild(style); }
    style.textContent = CSS;
  }

  function tick() {
    ensureStyle();
    document.querySelectorAll('#go-members').forEach((node) => node.remove());
    updateRecordsTitle();
    const ctx = readContext();
    if (!ctx) { if (state.key) leave(); return; }
    ensureBar();
    renderUserBadges();
    if (chatHost() !== state.host) renderAll();
    const key = `${ctx.roomId}|${ctx.userId}|${ctx.nickname}`;
    if (key !== state.key) { state.failNotified = false; connect(ctx, key); }
    else if (state.status === 'error' && Date.now() - state.errorAt > 15000) connect(ctx, key);
  }

  // Gartic'in kendi .msg / .history / .textGame CSS'ini olduğu gibi kullanıyoruz.
  // Buradaki kurallar sadece Gartic'te karşılığı olmayan yeni parçalar için
  // (mesajları alt alta diz, iki paneli eşitle, yoksay butonu, giriş satırı, toast).
  const CSS = `
/* CEVAPLAR ve CHAT panellerini tam eşit genişlikte yap, aradaki boşluğu ortala */
#screenRoom .ctt #interaction #answer{width:auto !important;flex:1 1 0 !important;min-width:0 !important}
#screenRoom .ctt #interaction #chat{width:auto !important;flex:1 1 0 !important;min-width:0 !important}
/* mesajlar .scrollElements içine ekleniyor: bu kutu zaten dikey (column), üzerine ekstra bir şey vermiyoruz */
.go-msg{position:relative;max-width:100%;overflow-wrap:anywhere;flex:0 0 auto}
.go-msg .go-ign{padding:0 2px;border:0;background:transparent;color:#c2c7cd;font-size:12px;cursor:pointer;opacity:0;vertical-align:middle}
.go-msg:hover .go-ign{opacity:1}
.go-msg .go-ign:hover{color:#ee191d}
.go-user-badge,.go-crown{display:inline-flex;width:19px;height:19px;margin:0 5px 0 0;vertical-align:-5px;color:#8da8c7;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55))}.go-crown{color:#e0ae3b}.go-user-badge svg,.go-crown svg{display:block;width:100%;height:100%}
.go-profile{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer;margin:0}.go-profile:hover{text-decoration:underline}

/* Profil popup: yay gibi zıplayarak açılan, avatarlı, blur arka planlı kart */
.go-profile-overlay{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.6);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity 220ms ease}
.go-profile-overlay.go-profile-visible{opacity:1}
.go-profile-overlay.go-profile-leaving{opacity:0;transition:opacity 160ms ease}
.go-profile-card{position:relative;width:260px;display:flex;flex-direction:column;align-items:center;border-radius:18px;overflow:hidden;background:#181c24;box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);transform:translateY(24px) scale(.72);opacity:0;transition:transform 220ms ease,opacity 220ms ease}
.go-profile-visible .go-profile-card{transform:translateY(0) scale(1);opacity:1;transition:transform 480ms cubic-bezier(.34,1.56,.64,1),opacity 200ms ease}
.go-profile-leaving .go-profile-card{transform:translateY(10px) scale(.92);opacity:0;transition:transform 160ms ease,opacity 160ms ease}
.go-profile-band{position:relative;width:100%;height:64px}
.go-profile-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border:0;border-radius:50%;background:rgba(0,0,0,.28);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.go-profile-x:hover{background:rgba(0,0,0,.45)}
.go-profile-x svg{width:14px;height:14px}
.go-profile-avatar{width:72px;height:72px;border-radius:50%;margin-top:-36px;display:flex;align-items:center;justify-content:center;font:32px NunitoBlack,Arial,sans-serif;color:#fff;border:4px solid #181c24;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.go-profile-body{display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 20px 20px;width:100%;box-sizing:border-box}
.go-profile-name{font:19px NunitoBlack,Arial,sans-serif;color:#fff;text-align:center;word-break:break-word}
.go-profile-sub{font:12.5px Nunito,Arial,sans-serif;color:#8b95a7}
.go-profile-actions{margin-top:14px;width:100%}
.go-profile-action{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:40px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#232833;color:#e7eaf0;font:13.5px NunitoBold,Arial,sans-serif;cursor:pointer;transition:transform 120ms ease,background 120ms ease}
.go-profile-action svg{width:16px;height:16px;flex:none}
.go-profile-action:hover{background:#2c323f;transform:translateY(-1px)}
.go-profile-action:active{transform:translateY(0)}
.go-profile-action-danger{color:#ff8080}
.go-profile-action-danger:hover{background:#3a1c1c;color:#ff9d9d}
#screenRoom #chat{overflow:hidden}#screenRoom #chat .history{max-width:100%;overflow-x:hidden}#go-bar{align-self:stretch;box-sizing:border-box;flex:none;margin:8px 10px 6px;padding:0;font-family:Nunito,Arial,sans-serif}
#interaction #answer .textGame{margin-left:auto;margin-right:auto}#go-bar .textGame,#go-bar{display:block}
#go-bar input{width:100%;box-sizing:border-box}

/* Toast: Gartic'in kendi popup açılış animasyonu (0.6 -> 1.1 -> 1 sıçrama) */
#go-toast{position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:11px;min-width:230px;max-width:340px;padding:13px 16px;border-radius:10px;background:#0e1c3d;border:1px solid rgba(255,255,255,.09);box-shadow:0 14px 34px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03) inset;font-family:Nunito,Arial,sans-serif;opacity:0;visibility:hidden}
#go-toast.go-toast-in{visibility:visible;animation:goToastIn .5s cubic-bezier(.34,1.56,.64,1) forwards}
#go-toast.go-toast-out{visibility:visible;animation:goToastOut .28s ease-in forwards}
#go-toast.go-toast-error{background:#3a1414;border-color:rgba(255,120,120,.18)}
.go-toast-icon{flex:none;width:26px;height:26px;color:#3ddc97;filter:drop-shadow(0 0 6px rgba(61,220,151,.55))}
#go-toast.go-toast-error .go-toast-icon{color:#ff6b6b;filter:drop-shadow(0 0 6px rgba(255,107,107,.55))}
.go-toast-icon svg{display:block;width:100%;height:100%}
.go-toast-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.go-toast-text strong{font-family:NunitoBlack,Arial,sans-serif;font-size:14px;color:#fff;letter-spacing:.2px}
.go-toast-text small{font-size:12.5px;color:#aab4c8;line-height:1.3;overflow-wrap:anywhere}
#go-toast.go-toast-error .go-toast-text small{color:#e3b3b3}
@keyframes goToastIn{0%{opacity:0;transform:translateY(18px) scale(.55) rotate(-2deg)}55%{opacity:1;transform:translateY(-4px) scale(1.06) rotate(.5deg)}80%{transform:translateY(1px) scale(.99) rotate(0)}100%{opacity:1;transform:translateY(0) scale(1) rotate(0)}}
@keyframes goToastOut{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(10px) scale(.9)}}
`;

  tick();
  setInterval(tick, 1000);
})();
