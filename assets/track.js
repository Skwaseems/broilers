// Visitor watch (Admin → Visitors): which pages and buttons each visit used, sent to the Worker's /track.
// Nothing typed in the form is sent. A name and mobile are attached only once that phone has sent the
// order form (its saved copy). Pages call it through a queue so they never wait for this file:
//   (window.sbTrackQ = window.sbTrackQ || []).push(['form', 'detail']);
(function () {
  'use strict';
  var URL_ = 'https://sharhan-whatsapp.waseemshaikh597.workers.dev/track';
  var ua = navigator.userAgent || '';
  var q = window.sbTrackQ || [];
  function noop() {}
  function off() { window.sbTrackQ = { push: noop }; }
  function get(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function put(store, k, v) { try { window[store].setItem(k, v); } catch (e) {} }

  // Search engines and link previews aren't visitors; admins' own devices are left out (set by admin.html).
  if (/bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp\//i.test(ua) || navigator.webdriver || get('localStorage', 'sb-no-track') === '1') { off(); return; }

  function rid() {
    var a = new Uint8Array(12), s = '';
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 12; j++) a[j] = Math.random() * 256; }
    for (var i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
    return s + Date.now().toString(36).slice(-4);
  }
  var search = typeof window.__sbLanding === 'string' ? window.__sbLanding : location.search;
  function param(name) { var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(search); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; }
  function pretty(slug) { return String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // Where this visit came from.
  function source() {
    var u = param('utm_source');
    if (u) return u.slice(0, 40);
    if (/Instagram/i.test(ua)) return 'Instagram';
    if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
    var r = '';
    try { r = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
    if (r && r !== location.hostname) {
      if (/google\./i.test(r)) return 'Google';
      if (/bing\./i.test(r)) return 'Bing';
      if (/facebook|fb\.com/i.test(r)) return 'Facebook';
      if (/instagram/i.test(r)) return 'Instagram';
      if (/whatsapp|wa\.me/i.test(r)) return 'WhatsApp';
      if (/workers\.dev/i.test(r)) return 'WhatsApp catalogue';
      return r.replace(/^www\./, '').slice(0, 40);
    }
    if (/^\/p\//.test(location.pathname) || param('item')) return 'WhatsApp catalogue';
    return 'Direct / WhatsApp chat';
  }
  // This page, in words.
  function pageName() {
    var p = location.pathname, item = param('item');
    if (/^\/p\//.test(p)) {
      var h = document.querySelector('h1');
      return 'Product page: ' + ((h && h.textContent.trim()) || pretty(p.slice(3)));
    }
    if (/[?&]order=1(&|$)/.test(search)) return 'Order form page' + (item ? ' (' + pretty(item) + ')' : '');
    if (p === '/' || p === '/index.html') return 'Home page' + (item ? ' (' + pretty(item) + ')' : '');
    return p;
  }

  var vid = get('localStorage', 'sb-vid');
  if (!vid || !/^[a-z0-9]{10,24}$/.test(vid)) { vid = rid(); put('localStorage', 'sb-vid', vid); }
  var st = null;
  try { st = JSON.parse(get('sessionStorage', 'sb-visit') || 'null'); } catch (e) {}
  // A new visit after 30 minutes away.
  if (!st || !st.sid || !Array.isArray(st.ev) || Date.now() - (st.last || 0) > 30 * 60 * 1000) {
    var n = (parseInt(get('localStorage', 'sb-visits'), 10) || 0) + 1;
    put('localStorage', 'sb-visits', String(n));
    st = { sid: rid(), start: Date.now(), last: Date.now(), n: n, src: source(), ev: [] };
  }

  // Name and mobile only from a form this phone has already sent.
  function savedWho() {
    try {
      var d = JSON.parse(get('localStorage', 'sb-requisition-v1') || 'null');
      if (d && d.weeklySent && d.company) return { name: d.company, mobile: String(d.pmMobile || '').replace(/\D/g, '').slice(-10) };
    } catch (e) {}
    return null;
  }

  var timer = null;
  function payload() {
    st.last = Date.now();
    put('sessionStorage', 'sb-visit', JSON.stringify(st));
    var who = st.who || savedWho();
    return JSON.stringify({
      sid: st.sid, vid: vid, n: st.n, start: st.start, src: st.src, ev: st.ev, who: who,
      w: Math.round(window.innerWidth || 0), lang: get('localStorage', 'sb-lang') || document.documentElement.getAttribute('data-sb-lang') || ''
    });
  }
  function send(leaving) {
    clearTimeout(timer);
    timer = null;
    var body = payload();
    // text/plain needs no CORS preflight; the Worker reads it as JSON.
    if (leaving && navigator.sendBeacon) { try { if (navigator.sendBeacon(URL_, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {} }
    try { fetch(URL_, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(noop); } catch (e) {}
  }
  function track(e, d, who) {
    e = String(e || '');
    d = String(d || '').slice(0, 80);
    if (!/^[a-z]{2,12}$/.test(e)) return;
    var last = st.ev[st.ev.length - 1];
    if (last && last.e === e && last.d === d && e !== 'weekly' && e !== 'order') return; // the same tap twice
    if (st.ev.length >= 60) st.ev.splice(1, 1); // keep the first page and the latest actions
    st.ev.push({ t: Math.round((Date.now() - st.start) / 1000), e: e, d: d });
    if (who && who.name) st.who = { name: String(who.name).slice(0, 80), mobile: String(who.mobile || '').replace(/\D/g, '').slice(-10) };
    var now = e === 'weekly' || e === 'order' || e === 'credit' || st.ev.length === 1;
    if (now) send(false);
    else if (!timer) timer = setTimeout(function () { send(false); }, 4000);
  }

  // Taps that leave the page: WhatsApp, call, map, email.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href') || '';
    if (/wa\.me|whatsapp\.com/i.test(h)) track('wa', '');
    else if (/^tel:/i.test(h)) track('call', '');
    else if (/^mailto:/i.test(h)) track('mail', '');
    else if (/maps\.app\.goo\.gl|google\.[a-z.]+\/maps|goo\.gl\/maps/i.test(h)) track('map', '');
  }, true);
  window.addEventListener('sb-lang', function () {
    var l = document.documentElement.getAttribute('data-sb-lang');
    if (l && l !== 'en') track('lang', l === 'hi' ? 'Hindi' : l === 'mr' ? 'Marathi' : l);
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(true); });
  window.addEventListener('pagehide', function () { send(true); });

  // Each page load is a "page" event; then whatever the page queued before this file loaded.
  function start() {
    q = Array.isArray(window.sbTrackQ) ? window.sbTrackQ : q;
    track('page', pageName());
    for (var i = 0; i < q.length; i++) track(q[i][0], q[i][1], q[i][2]);
    window.sbTrackQ = { push: function (a) { track(a[0], a[1], a[2]); } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
