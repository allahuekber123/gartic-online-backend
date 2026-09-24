// ==UserScript==
// @name         gartic.online connector
// @namespace    https://gartic.online
// @version      0.1.0
// @description  Gartic.io oda kimliğini gartic.online sohbetine bağlar
// @match        https://gartic.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      YOUR-RAILWAY-DOMAIN.up.railway.app
// ==/UserScript==
(() => {
  'use strict';
  const BACKEND = 'https://YOUR-RAILWAY-DOMAIN.up.railway.app';
  const state = { passive: null, socket: null, started: false, joined: null };
  const text = (value) => typeof value === 'string' ? value : '';
  const clean = (value, max = 120) => text(value).trim().slice(0, max);
  const notice = (title, detail) => {
    const node = document.createElement('div');
    node.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:280px;padding:13px 15px;background:#17191d;color:#f5f4ef;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);font:12px Nunito,system-ui,sans-serif';
    node.innerHTML = `<strong style="display:block;font-size:12px">${title}</strong><small style="display:block;margin-top:4px;color:#9da1a8">${detail}</small>`;
    document.documentElement.appendChild(node); setTimeout(() => node.remove(), 5000);
  };
  const fromObject = (value, source) => {
    if (!value || typeof value !== 'object') return null;
    const game = value.game || value.room || value;
    const user = value.user || value.jogador || value.player || {};
    const roomId = clean(game.roomId || game.codigo || game.code || value.roomId || value.code);
    const userId = clean(user.id || user.userId || value.userId);
    const nickname = clean(user.nick || user.nickname || user.name || value.nickname);
    if (!roomId || !userId || !nickname) return null;
    return { roomId, userId, userIndex: clean(user.index || value.userIndex) || undefined, nickname, avatar: clean(user.foto || user.avatar || value.avatar, 500) || undefined, source };
  };
  const readPassive = () => {
    try {
      const cache = fromObject(window.CACHE_DATA, 'cache'); if (cache) return cache;
      const next = document.getElementById('__NEXT_DATA__');
      if (next?.textContent) { const data = JSON.parse(next.textContent); const found = fromObject(data.props?.pageProps?.data || data.props?.data, 'next-data'); if (found) return found; }
      const match = location.pathname.match(/\/([A-Za-z0-9]{4,})$/); const nick = clean(document.querySelector('#users .user .nick')?.textContent?.replace('✓', ''));
      if (match && nick) return { roomId: match[1], userId: `guest:${nick}`, nickname: nick, source: 'url' };
    } catch {}
    return null;
  };
  const observeGarticSocket = () => {
    const Original = window.WebSocket; if (!Original || Original.__garticOnlineWrapped) return;
    const Wrapped = function(url, protocols) { const ws = protocols ? new Original(url, protocols) : new Original(url); if (String(url).includes('gartic.io/socket.io')) {
      ws.addEventListener('message', (event) => { try { if (typeof event.data !== 'string' || !event.data.startsWith('42')) return; const packet = JSON.parse(event.data.slice(2)); if (packet[0] !== '5') return; const data = packet[1] || {}; const players = Array.isArray(data[5]) ? data[5] : []; const me = players.find((item) => String(item.id) === String(data[1]) || String(item.index) === String(data[2])); state.joined = { roomId: clean(data[3] || data.room || data.code), userId: clean(me?.id || data[1] || data[2]), userIndex: clean(data[2]), nickname: clean(me?.nick || data.nick), avatar: clean(me?.foto || me?.avatar), source: 'socket-join' }; if (state.socket && state.socket.connected) state.socket.emit('identity:confirm', state.joined); start(); } catch {} }); }
      return ws;
    };
    Wrapped.prototype = Original.prototype; Object.setPrototypeOf(Wrapped, Original); Wrapped.__garticOnlineWrapped = true; window.WebSocket = Wrapped;
  };
  const requestSession = (identity) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({ method: 'POST', url: `${BACKEND}/v1/session/anonymous`, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(identity), onload: (response) => { if (response.status >= 200 && response.status < 300) resolve(JSON.parse(response.responseText)); else reject(new Error('session rejected')); }, onerror: () => reject(new Error('backend unavailable')) });
  });
  const loadSocketIo = () => new Promise((resolve, reject) => { if (window.io) return resolve(window.io); const script = document.createElement('script'); script.src = 'https://cdn.socket.io/4.8.1/socket.io.min.js'; script.onload = () => resolve(window.io); script.onerror = reject; document.documentElement.appendChild(script); });
  async function start() {
    if (state.started) return; const identity = state.joined || state.passive || readPassive(); if (!identity?.roomId || !identity?.userId || !identity?.nickname) return;
    state.started = true; state.passive = identity;
    try { const session = await requestSession(identity); const io = await loadSocketIo(); state.socket = io(BACKEND, { auth: { token: session.token }, transports: ['websocket'] }); state.socket.on('connect', () => { if (state.joined) state.socket.emit('identity:confirm', state.joined); notice('gartic.online hazır', `${identity.nickname} · oda ${identity.roomId}`); }); state.socket.on('session:rejected', () => { state.started = false; state.socket?.disconnect(); notice('Oda doğrulanamadı', 'Gartic kimliği ile sayfa verisi eşleşmedi.'); }); state.socket.on('connect_error', () => { state.started = false; notice('Bağlantı kurulamadı', 'Sohbet sunucusu şu anda cevap vermiyor.'); }); state.socket.on('chat:message', (message) => window.dispatchEvent(new CustomEvent('gartic-online-message', { detail: message }))); } catch { state.started = false; notice('Bağlantı kurulamadı', 'Oda kimliği doğrulanamadı.'); }
  }
  observeGarticSocket(); state.passive = readPassive(); setTimeout(start, 1500); setInterval(() => { if (!state.started) { state.passive = readPassive(); start(); } }, 2000);
})();
