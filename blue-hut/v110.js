/* ===== v110：图片走 WebP / 计时只算真播放 / 切歌与歌词不串 / 断流不误判 / 返回小屋不断歌 / 上下文带进度 ===== */
(function () {
  if (window.__v110) return;
  window.__v110 = true;

  function $id(x) { return document.getElementById(x); }
  function page() { return document.getElementById('musicPage'); }
  function audio() { return window.muAudio || null; }

  /* ---------- 1) 一起听计时：只在真播放时累计；换歌、暂停、重进都不清零 ---------- */
  var LS_ACC = 'muTogetherAccumSec';
  var acc = Math.max(0, parseFloat(localStorage.getItem(LS_ACC)) || 0);
  var running = false, since = 0, tick = null;
  function saveAcc() { try { localStorage.setItem(LS_ACC, String(Math.floor(acc))); } catch (e) {} }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ' 分 ' + s + ' 秒';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  function total() { return acc + (running ? (Date.now() - since) / 1000 : 0); }
  function paint() {
    var p = page(); if (!p) return;
    var el = p.querySelector('#muTogether'); if (!el) return;
    var a = audio(), playing = !!(a && !a.paused && a.getAttribute('src'));
    el.textContent = '一起听了 ' + fmt(total()) + (playing ? '' : (a && a.getAttribute('src') ? '（暂停中）' : ''));
  }
  window.muStartTogether = function () {
    if (!page()) return;
    var a = audio();
    if (!a || a.paused || !a.getAttribute('src')) { paint(); return; }   // 没在放就不计时
    if (running) return;
    running = true; since = Date.now();
    if (tick) clearInterval(tick);
    tick = setInterval(paint, 1000);
    paint();
  };
  window.muStopTogether = function () {
    if (running) { acc += (Date.now() - since) / 1000; running = false; saveAcc(); }
    if (tick) { clearInterval(tick); tick = null; }
    paint();
  };
  setInterval(function () {                       // 常驻秒表：暂停中也能看到累计值
    if (running) { acc = Math.floor(total()); since = Date.now(); saveAcc(); }
    paint();
  }, 1000);

  /* ---------- 2) 把音乐状态（含进度、歌词、累计）一起交给后端，AI 才看得到 ---------- */
  if (typeof window.fetch === 'function' && !window.__v110Fetch) {
    window.__v110Fetch = true;
    var of = window.fetch;
    window.fetch = function (u, o) {
      try {
        if (o && typeof o.body === 'string' && String(u).indexOf('/room/poll') >= 0) {
          var b = JSON.parse(o.body);
          b.state = b.state || {};
          var a = audio();
          b.state.together = { sec: Math.floor(total()), running: running };
          if (a) {
            b.state.pos = Math.round((a.currentTime || 0) * 10) / 10;
            b.state.dur = Math.round((a.duration || 0) * 10) / 10;
            b.state.paused = !!a.paused;
          }
          var cur = window.muSongs && window.muCur >= 0 ? window.muSongs[window.muCur] : null;
          if (cur) b.state.songId = cur.id;
          o = Object.assign({}, o, { body: JSON.stringify(b) });
        }
      } catch (e) {}
      return of.apply(this, [u, o]);
    };
  }

  /* ---------- 3) 聊天上下文补上进度/音量，让他知道放到哪了 ---------- */
  var _ctx = window.muChatContext;
  if (typeof _ctx === 'function') {
    window.muChatContext = function () {
      var t = ''; try { t = _ctx(); } catch (e) {}
      var a = audio();
      if (a && a.getAttribute('src')) {
        t += '（放到 ' + fmt(Math.floor(a.currentTime || 0)) + ' / ' + fmt(Math.floor(a.duration || 0)) +
             '，' + (a.paused ? '现在是暂停的' : '正在放') + '，音量 ' + Math.round((a.volume || 0) * 100) + '%）';
      }
      return t;
    };
  }

  /* ---------- 4) 聊天头像用他设置的那张图 ---------- */
  function syncHeadAvatar() {
    var av = $id('muChatAvatar'), boy = $id('muAvBoy');
    if (!av || !boy) return;
    if (boy.naturalWidth > 0 && boy.getAttribute('src')) {
      if (!av.__v110pic) {
        av.__v110pic = 1;
        av.style.backgroundImage = 'url("' + boy.src + '")';
        av.style.backgroundSize = 'cover';
        av.style.backgroundPosition = 'center';
        av.style.color = 'transparent';
      }
    } else if (av.__v110pic) {
      av.__v110pic = 0; av.style.backgroundImage = ''; av.style.color = '';
    }
  }
  setInterval(syncHeadAvatar, 1200);

  /* ---------- 5) 歌词：旧歌的歌词响应绝不能盖到新歌 ---------- */
  var lyricSeq = 0;
  window.muLoadLyric = function (id, after) {
    var my = ++lyricSeq;
    var inner = $id('muLyInner');
    if (inner) { inner.style.transform = 'translateY(0)'; inner.innerHTML = '<div class="muLyEmpty">歌词加载中…</div>'; }
    try { window.muLyric = []; window.muLyIdx = -1; } catch (e) {}
    ncm('/lyric', { id: id }).then(function (d) {
      if (my !== lyricSeq) return;                       // 已经不是这首了，丢掉
      var txt = (d && d.lrc && d.lrc.lyric) || '';
      var list = muParseLrc(txt);
      if (my !== lyricSeq) return;
      window.muLyric = list;
      if (!list.length) {
        if (inner) inner.innerHTML = '<div class="muLyEmpty">这首歌没有歌词</div>';
        if (after) after(); return;
      }
      if (inner) {
        inner.innerHTML = list.map(function (l) { return '<div class="muLyLine">' + muH(l.text) + '</div>'; }).join('');
      }
      if (after) after();
    }).catch(function () {
      if (my !== lyricSeq) return;
      if (inner) inner.innerHTML = '<div class="muLyEmpty">歌词加载失败</div>';
    });
  };

  /* ---------- 6) 切歌：序号守卫，旧响应丢弃；失败再确认一次才跳 ---------- */
  var playSeq = 0;
  window.muPlayIndex = function (i) {
    var songs = window.muSongs;
    if (!songs || !songs.length) return;
    if (i < 0 || i >= songs.length) return;
    var s = songs[i], my = ++playSeq, a = audio();
    window.muCur = i;
    try { muSetNow(s); } catch (e) {}
    try { muRenderSongs(); } catch (e) {}
    try { muPushRecent(s); } catch (e) {}
    try {
      muLoadLyric(s.id, function () {
        if (my !== playSeq) return;
        if (window.muChatOpen) muChatSpeak('切到《' + s.name + '》了，' + ((window.muAiCfg && muAiCfg.name) || '我') + '在听。', true);
      });
    } catch (e) {}
    if (a) { try { a.pause(); } catch (e) {} }          // 先停旧的，避免两份声音
    ncm('/song/url', { id: s.id }).then(function (d) {
      if (my !== playSeq) return;                        // 已经换到别的歌，别动新歌
      var u = d && d.data && d.data[0] && d.data[0].url;
      if (!u) {
        muSetNow(s, '这首暂无版权，等一下自动跳下一首');
        setTimeout(function () { if (my !== playSeq) return; try { muStep(1); } catch (e) {} }, 1200);
        return;
      }
      if (location.protocol === 'https:' && /^http:\/\//.test(u)) u = u.replace(/^http:\/\//, 'https://');
      window.__v110Src = u; window.__v110Retry = 0; window.__v110SongId = s.id;
      if (!a) return;
      a.src = u;
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { var b = $id('muPlay'); if (b) b.classList.remove('playing'); });
    }).catch(function (e) {
      if (my !== playSeq) return;
      muSetNow(s, '播放地址取不到：' + ((e && e.message) || '网络问题'));
      setTimeout(function () { if (my !== playSeq) return; try { muStep(1); } catch (e) {} }, 1800);
    });
  };

  /* ---------- 7) 断流自愈：只在前台、没在缓冲、没在拖动时才判卡；3 次封顶 ---------- */
  var lastT = -1, stuck = 0, coolUntil = 0;
  setInterval(function () {
    var a = audio();
    if (!a || a.paused || !a.getAttribute('src')) return;
    if (document.visibilityState !== 'visible') { lastT = -1; stuck = 0; return; }  // 后台被节流，不算故障
    if (a.seeking || a.readyState < 3) { lastT = a.currentTime; stuck = 0; return; } // 缓冲中，不算断流
    if (Math.abs(a.currentTime - (lastT < 0 ? a.currentTime : lastT)) < 0.2) stuck++; else stuck = 0;
    lastT = a.currentTime;
    if (stuck >= 6 && Date.now() > coolUntil) { stuck = 0; recover(); }
  }, 1000);

  function recover() {
    var a = audio(), src = window.__v110Src;
    if (!a || !src) return;
    var same = (window.__v110SongId != null) && (window.muSongs && window.muCur >= 0) &&
               (window.muSongs[window.muCur].id === window.__v110SongId);
    if (!same) return;                                   // 歌已经换了，别管旧连接
    if ((window.__v110Retry || 0) >= 3) {
      window.__v110Retry = 0;
      try { muChatSpeak('这首歌的源一直断，我换下一首。', true); } catch (e) {}
      try { muStep(1); } catch (e) {}
      return;
    }
    window.__v110Retry = (window.__v110Retry || 0) + 1;
    var pos = a.currentTime || 0;
    coolUntil = Date.now() + 15000;                      // 15 秒冷却，避免连环重试
    try { a.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now(); } catch (e) { return; }
    var t = setTimeout(function () {                     // 超时保护
      try { if (a.readyState < 2) a.pause(); } catch (e) {}
    }, 15000);
    a.addEventListener('loadedmetadata', function once() {
      clearTimeout(t);
      a.removeEventListener('loadedmetadata', once);
      try { a.currentTime = pos; } catch (e) {}
      try { a.play(); } catch (e) {}
    });
  }

  /* ---------- 8) 返回小屋：音乐继续，不暂停、不重载、不丢进度 ---------- */
  window.closeMusicPage = function () {
    var p = page(); if (!p) return;
    p.classList.remove('on');
    document.body.style.overflow = '';
    try { muStopQr(); } catch (e) {}
    try { muStopNotes(); } catch (e) {}
    try { muStopProactive(); } catch (e) {}
    window.muChatOpen = false;
    try { muCloseSheets(); } catch (e) {}
    ['#muChatPanel', '#muChatCfg', '#muVolRow', '#muLyricBox'].forEach(function (sel) {
      var el = p.querySelector(sel); if (el) el.classList.remove('on');
    });
    // 注意：这里不再 muAudio.pause()，也不动 muStopTogether（人在小屋也还在听）
  };

  /* ---------- 9) 重进一起听：把歌曲/歌词/进度/按钮状态对回来 ---------- */
  function syncUI() {
    var a = audio(); if (!a) return;
    var b = $id('muPlay');
    if (b) b.classList.toggle('playing', !a.paused && a.currentTime > 0);
    var seek = $id('muSeek');
    if (seek && a.duration) seek.value = Math.round((a.currentTime / a.duration) * 1000);
    var ct = $id('muCurT'), dt = $id('muDurT');
    if (ct) ct.textContent = muFmt(a.currentTime || 0);
    if (dt && a.duration) dt.textContent = muFmt(a.duration);
    try { muSyncLyric(); } catch (e) {}
    try { muSyncChatHead(); } catch (e) {}
    paint();
  }
  var _open = window.openMusicPage;
  if (typeof _open === 'function') {
    window.openMusicPage = function () {
      _open.apply(window, arguments);
      setTimeout(syncUI, 300);
      setTimeout(syncUI, 1200);
    };
  }

  /* 歌词面板/菜单/音量条：点它们别误触唱片（唱片是点一下暂停） */
  setInterval(function () {
    ['muLyricBox', 'muLyricToggle', 'muMenu', 'muVolRow'].forEach(function (id) {
      var el = $id(id);
      if (!el || el.__v110iso) return;
      el.__v110iso = 1;
      ['click', 'pointerdown', 'touchstart'].forEach(function (ev) {
        el.addEventListener(ev, function (e) { e.stopPropagation(); }, true);
      });
    });
  }, 1500);

  /* 播放/暂停事件：计时跟着走 */
  var hook = setInterval(function () {
    var a = audio(); if (!a) return;
    clearInterval(hook);
    a.addEventListener('play', function () { try { window.muStartTogether(); } catch (e) {} });
    a.addEventListener('pause', function () { try { window.muStopTogether(); } catch (e) {} });
    a.addEventListener('ended', function () { try { window.muStopTogether(); } catch (e) {} });
  }, 500);
})();

/* ===== v110.1：图片失败自动重试；音频真出错时说和做一致 ===== */
(function () {
  if (window.__v110_1) return;
  window.__v110_1 = 1;
  function isArt(im) {
    return im && im.tagName === 'IMG' &&
      (im.id === 'room' || (' ' + (im.className || '') + ' ').indexOf(' sprite ') > -1);
  }
  function say(t) { try { if (typeof setStatus === 'function') setStatus(t); } catch (e) {} }
  document.addEventListener('error', function (ev) {
    var im = ev.target;
    if (!isArt(im)) return;
    var n = Number(im.__loadRetry || 0);
    if (n >= 2) { say('这张图重试两次都没下来：' + (im.alt || im.id || '')); return; }
    im.__loadRetry = n + 1;
    var src = String(im.getAttribute('src') || '').split('?')[0];
    if (!src) return;
    say('图片没加载上，正在重试（' + im.__loadRetry + '/2）：' + (im.alt || ''));
    setTimeout(function () { im.style.visibility = ''; im.src = src + '?r=' + Date.now(); }, 700);
  }, true);
  document.addEventListener('load', function (ev) {
    var im = ev.target;
    if (!isArt(im)) return;
    im.style.visibility = '';
    if (im.__loadRetry) { im.__loadRetry = 0; say(''); }
  }, true);

  var errs = 0, lastSong = null;
  var hook = setInterval(function () {
    var a = window.muAudio; if (!a) return;
    clearInterval(hook);
    a.addEventListener('error', function () {
      var code = a.error && a.error.code;
      var cur = window.muSongs && window.muCur >= 0 ? window.muSongs[window.muCur] : null;
      if (!cur) return;
      if (lastSong !== cur.id) { lastSong = cur.id; errs = 0; }
      errs++;
      var txt = code === 4 ? '这首歌手机播不了，我换下一首'
        : code === 2 ? '网络断了，我在重连这首歌'
        : '音频出问题了，我在重连';
      say(txt);
      try { muChatSpeak(txt, true); } catch (e) {}
      if (errs >= 2 || code === 4) { try { muStep(1); } catch (e) {} return; }
      var pos = a.currentTime || 0;
      try {
        a.src = String(window.__v110Src || a.src).split('?')[0] + '?e=' + Date.now();
        a.addEventListener('loadedmetadata', function once() {
          a.removeEventListener('loadedmetadata', once);
          try { a.currentTime = pos; } catch (e) {}
          try { a.play(); } catch (e) {}
        });
      } catch (e) {}
    });
  }, 600);
})();
