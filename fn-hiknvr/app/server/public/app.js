/* 飞海监控 v0.2.1 · 首页=摄像机快照入口，点进去=单画面（声音/抓拍/全屏/回放） */
const $ = s => document.querySelector(s);
const BASE = location.pathname.replace(/[^/]*$/, '');      // 统一网关 /app/fn-hiknvr/ 与端口直连 / 都适用
const U = p => BASE + String(p).replace(/^\//, '');
let cams = [], ready = false, activeId = null, soundOn = false;
let list = [], firstRender = true, homeSig = '', thumbLock = false, lastThumbAt = 0;

const two = n => String(n).padStart(2, '0');
const fmtSize = b => b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtTime = ms => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const fmtDay = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setTop(txt, cls) { $('#stattxt').textContent = txt; $('#dot').className = 'dot ' + (cls || ''); }
const activeCam = () => cams.find(c => c.id === activeId) || null;

/* ================= 首页：摄像机快照 ================= */
const imgOf = new Map();
const cards = new Map();
function renderHome(force) {
  const conf = cams.filter(c => c.configured);
  const sig = (ready ? '1' : '0') + '|' + conf.map(c => c.id + ':' + c.name).join(',');
  if (force || sig !== homeSig) {                       // 只有「摄像机台数/名字」变了才重建 DOM
    homeSig = sig;
    const box = $('#cams'); box.innerHTML = ''; imgOf.clear(); cards.clear();
    for (const cam of conf) {
      const d = document.createElement('div');
      d.className = 'thumb'; d.dataset.id = cam.id;
      d.innerHTML = '<img alt=""><span class="tl"></span><span class="tr"></span><span class="ph hidden">无画面</span>';
      d.querySelector('.tl').textContent = cam.name || '摄像机';
      d.onclick = () => openCam(cam.id);
      box.appendChild(d);
      const card = { el: d, img: d.querySelector('img'), badge: d.querySelector('.tr'), ph: d.querySelector('.ph') };
      cards.set(cam.id, card); imgOf.set(cam.id, card.img);
    }
    if (cams.length < 4) {
      const a = document.createElement('a');
      a.className = 'thumb add'; a.href = 'settings.html';
      a.innerHTML = '<span>＋ 添加摄像机</span>';
      box.appendChild(a);
    }
    refreshThumbs(true);
  }
  for (const cam of conf) {                             // 状态标就地刷新，不动图片节点（避免重复抓图）
    const c = cards.get(cam.id); if (!c) continue;
    if (cam.liveAlive) { c.el.classList.remove('off'); c.ph.classList.add('hidden'); c.badge.className = 'tr live'; c.badge.textContent = '● 直播'; }
    else { c.el.classList.add('off'); c.ph.classList.remove('hidden'); c.badge.className = 'tr off'; c.badge.textContent = '离线'; }
  }
}
function refreshThumbs(force) {
  if (activeId || thumbLock) return;
  if (!force && Date.now() - lastThumbAt < 3000) return;      // 轻量防抖
  const todo = cams.filter(c => c.liveAlive && imgOf.get(c.id));
  if (!todo.length) return;
  lastThumbAt = Date.now();
  thumbLock = true;
  (async () => {
    try {
      for (const cam of todo) {
        if (activeId) break;
        const url = U('api/snap?cam=' + encodeURIComponent(cam.id) + '&w=960&t=') + Date.now();
        await new Promise(res => {
          const t = imgOf.get(cam.id);
          if (!t) return res();
          const fin = () => res();
          t.onload = fin; t.onerror = fin; t.src = url;
          setTimeout(fin, 9000);
        });
      }
    } finally { thumbLock = false; }
  })();
}

/* ================= H.265 引导 ================= */
// 管线是 -c:v copy（不转码）→ 摄像机若是 H.265，浏览器播 HLS 会黑屏/转圈。
// 两种触发：① 服务端已探到该机是 H.265（cam.h265）② 直播连续失败 3 次 → 给「可能是 H.265」的提示
const h265Dismissed = new Set();
let liveFails = 0;
const H265_FULL = '管线不做转码，浏览器 / 手机网页放不了 H.265，所以画面会一直黑屏或转圈。<br>任选一种：'
  + '① 到摄像机后台把「主码流」编码改成 <b>H.264</b>（推荐，改完保存即可）；'
  + '② 若子码流是 H.264，先切「子码流预览」；'
  + '③ 用支持 HEVC 的播放器（PotPlayer / VLC）或摄像机自带 App 看。';
const H265_HINT = '画面一直出不来？如果这台摄像机用的是 <b>H.265</b> 编码，浏览器放不了，会黑屏或一直转圈。<br>'
  + '① 到摄像机后台把编码改成 <b>H.264</b>（推荐）；② 或用支持 HEVC 的播放器 / 摄像机自带 App 看。';
function applyH265(cam, isHint) {
  const el = $('#h265'); if (!el || !cam) return;
  // 用「最新的」状态判断（live 里的 cam 可能是旧对象）
  const c = (cams.find(x => x.id === cam.id)) || cam;
  const known = !!c.h265, on = known || !!isHint;
  if (!on || h265Dismissed.has(c.id)) { el.classList.add('hidden'); return; }
  const t = $('#h265ttl'); if (t) t.textContent = known ? '⚠️ 这台摄像机是 H.265 编码' : '⚠️ 画面起不来？可能是 H.265 编码';
  const x = $('#h265txt'); if (x) x.innerHTML = known ? H265_FULL : H265_HINT;
  el.classList.remove('hidden');
}
// 播放连续失败时的「软提示」判定：只有【码流活着 + 浏览器放不了 + 编码未知】才提示
// 已知是 H.264 → 多半是掉线/离线（不弹编码提示）；管线本身没活 → 不是编码问题
function maybeH265Hint(cam) {
  if (!cam) return;
  const c = cams.find(x => x.id === cam.id) || cam;
  if (c.h265) { applyH265(c); return; }
  if (c.codec) { applyH265(c); return; }      // 已知非 H.265 → 保持隐藏
  if (!c.liveAlive || !c.configured) return;  // 离线/未配置 → 不打扰
  applyH265(c, true);
}
if ($('#h265ok')) $('#h265ok').onclick = () => { if (activeId) h265Dismissed.add(activeId); $('#h265').classList.add('hidden'); };

/* ================= 进入 / 退出单台（用 history 状态机，手机返回键可控）================= */
function enterCam(cam, pushIt) {
  activeId = cam.id; soundOn = false; firstRender = true; liveFails = 0;
  h265Dismissed.delete(cam.id); applyH265(cam);
  $('#home').classList.add('hidden'); $('#cam').classList.remove('hidden');
  $('#camname').textContent = cam.name || '摄像机';
  $('#camst').textContent = cam.liveAlive ? '● 直播中' : '○ 离线';
  $('#mute').textContent = '🔇 声音';
  if (pushIt !== false) { try { history.pushState({ v: 'cam', id: cam.id }, '', '#cam/' + cam.id); } catch { } }
  startLive(cam); refreshList();
  window.scrollTo({ top: 0 });
}
function openCam(id) { const cam = cams.find(c => c.id === id); if (cam) enterCam(cam, true); }
function closePlay() {
  const p = $('#play');
  if (p.classList.contains('hidden')) return;
  p.classList.add('hidden');
  if (fsEl()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { } }
  try { $('#pv').pause(); $('#pv').removeAttribute('src'); $('#pv').load(); } catch { }
  const cam = activeCam(); if (cam) $('#lv').play().catch(() => { });
}
function doClose() {                      // 回列表（不碰 history）
  activeId = null; stopLive(); closePlay();
  $('#cam').classList.add('hidden'); $('#home').classList.remove('hidden');
  refreshThumbs();
}
function route() {                        // popstate 驱动：手机返回键 / 页面内返回都走这里
  const st = history.state || {};         // 初始历史项没有 state → 视为首页
  if (st.v === 'play') return;                                       // 保持回放层
  if (st.v === 'cam') {
    closePlay();
    const cam = cams.find(c => c.id === st.id);
    if (cam) { if (activeId !== cam.id) enterCam(cam, false); } else doClose();
    return;
  }
  closePlay(); if (activeId) doClose();
}
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
$('#back').onclick = () => { const st = history.state || {}; if (st.v === 'cam') history.back(); else doClose(); };

/* ================= 直播 ================= */
let hls = null;
function setOv(txt, cls) { $('#lov').textContent = txt; $('#lov').className = 'overlay ' + (cls || ''); }
function stopLive() {
  if (hls) { try { hls.destroy(); } catch { } hls = null; }
  try { const v = $('#lv'); v.removeAttribute('src'); v.load(); } catch { }
}
function startLive(cam, forceMain) {
  stopLive();
  const v = $('#lv'); hls = null;
  const url = U('live/' + cam.id + '/' + (cam.previewStream === 'sub' && !forceMain ? 'index-sub.m3u8' : 'index.m3u8'));
  const onErr = () => {
    setOv('连接中…');
    if (++liveFails >= 3) maybeH265Hint(cam);     // 连续失败 3 次（≈7 秒）→ 按规则给软提示
    setTimeout(() => {
      if (activeId !== cam.id) return;
      if (cam.previewStream === 'sub' && !forceMain) startLive(cam, true);   // 子码流不可用 → 回退主码流
      else startLive(cam);
    }, 2500);
  };
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 1, enableWorker: true });
    hls.loadSource(url); hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (e, d) => { if (d && d.fatal) onErr(); });
    v.addEventListener('playing', () => { liveFails = 0; setOv('直播', 'rec'); applyH265(cam); }, { once: true });
  } else { v.src = url; }
  v.muted = !soundOn;
  v.play().catch(() => { });
  setOv('连接中…');
}
$('#mute').onclick = () => {
  soundOn = !soundOn;
  const v = $('#lv'); v.muted = !soundOn;
  $('#mute').textContent = soundOn ? '🔊 有声音' : '🔇 声音';
  if (soundOn) { v.play().catch(() => { }); v.volume = 1; }
};
$('#snap').onclick = () => { if (activeId) window.open(U('api/snap?cam=' + encodeURIComponent(activeId)) + '&t=' + Date.now(), '_blank'); };

/* 直播卡死自愈：currentTime 12s 不前进 → 重载这一路 */
setInterval(() => {
  if (!activeId) return;
  const v = $('#lv');
  if (v.paused) return;
  if (v.currentTime !== v._ct) { v._ct = v.currentTime; v._ctAt = Date.now(); return; }
  if (Date.now() - (v._ctAt || 0) > 12000) { v._ctAt = Date.now(); const cam = activeCam(); if (cam) startLive(cam); }
}, 4000);

/* ================= 全屏（竖屏自动旋转 90°） ================= */
let fsRotManual = null, fsBox = null;
function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function layoutFs() {
  const on = !!fsEl();
  document.querySelectorAll('.fsexit').forEach(b => b.classList.add('hidden'));   // 两个播放器各有一个，只显示当前全屏的那个
  if (!on) {
    if (fsBox) { fsBox.classList.remove('fs-rot', 'fs-hint-on'); const v = fsBox.querySelector('video'); if (v) v.style.cssText = ''; }
    fsBox = null; return;
  }
  fsBox = fsEl();
  const fe = fsBox.querySelector('.fsexit'); if (fe) fe.classList.remove('hidden');
  const v = fsBox.querySelector('video'); if (!v) return;
  const rotate = fsRotManual === null ? (window.innerHeight > window.innerWidth) : fsRotManual;
  if (rotate) {
    const W = window.innerWidth, H = window.innerHeight;
    fsBox.classList.add('fs-rot', 'fs-hint-on');
    v.style.position = 'absolute'; v.style.left = '50%'; v.style.top = '50%';
    v.style.width = H + 'px'; v.style.height = W + 'px'; v.style.maxWidth = 'none';
    v.style.transform = 'translate(-50%,-50%) rotate(90deg)';
    setTimeout(() => fsBox && fsBox.classList.remove('fs-hint-on'), 2600);
  } else { fsBox.classList.remove('fs-rot', 'fs-hint-on'); v.style.cssText = ''; }
}
async function doFs(el) {
  fsRotManual = null;
  try { if (el.requestFullscreen) await el.requestFullscreen(); else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); } catch { }
  setTimeout(layoutFs, 250);
}
$('#fs').onclick = () => { if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; } doFs($('#pbox')); };
$('#pbox').addEventListener('dblclick', e => { if (!e.target.closest('button')) doFs($('#pbox')); });
document.querySelectorAll('.fsexit').forEach(b => {
  b.onclick = e => { e.stopPropagation(); try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { } };
});
const fs2 = $('#fs2');                                   // 回放页的全屏按钮
if (fs2) fs2.onclick = () => { if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; } doFs($('#pbox2')); };
document.addEventListener('fullscreenchange', () => setTimeout(layoutFs, 60));
document.addEventListener('webkitfullscreenchange', () => setTimeout(layoutFs, 60));
window.addEventListener('orientationchange', () => setTimeout(layoutFs, 350));
window.addEventListener('resize', () => setTimeout(layoutFs, 200));

/* ================= 状态 ================= */
async function refreshStatus() {
  try {
    const j = await (await fetch(U('api/status'))).json();
    if (j.version && $('#ver')) $('#ver').textContent = 'v' + j.version;   // 版本号随安装包自动显示
    if ($('#pwnag')) $('#pwnag').classList.toggle('hidden', !j.defaultPass);   // 还在用默认密码 → 顶部提醒
    cams = j.cameras || [];
    ready = !!j.configured;
    $('#setup').classList.toggle('hidden', ready);
    const conf = cams.filter(c => c.configured), on = conf.filter(c => c.liveAlive).length;
    let txt;
    if (!conf.length) txt = '未配置摄像机';
    else if (on === conf.length) txt = `${conf.length} 台在线 · 录像中`;
    else txt = `${on} 台在线 · ${conf.length - on} 台离线`;
    setTop(txt, on ? 'live' : 'off');
    if (activeId) {
      const cam = activeCam();
      if (!cam) { doClose(); }
      else {
        $('#camname').textContent = cam.name || '摄像机';
        $('#camst').textContent = cam.liveAlive ? '● 直播中' : '○ 离线';
        applyH265(cam);
      }
    }
    renderHome();
    const fp = [];
    if (j.diskLow) fp.push('⚠️ 磁盘空间不足，已暂停录像（清理后自动恢复）');
    if (j.disk) fp.push(`存储：剩余 ${fmtSize(j.disk.free)} / 共 ${fmtSize(j.disk.total)}（保留 ${j.retentionDays} 天）`);
    if (j.res) fp.push(`资源：CPU ${Math.round(j.res.cpu)}% ｜ 内存 ${fmtSize(j.res.mem)}`);
    if (j.recordRoot) fp.push(`目录：${j.recordRoot}`);
    $('#foot').innerHTML = fp.join('<br>');
  } catch { setTop('无法连接服务', 'off'); }
}

/* ================= 回放列表（只显示当前这台） ================= */
const WEEK = '日一二三四五六';
const expandedDays = new Set(), expandedHours = new Set();
const seg = it => String(it.rel || it.name || '').split('/');
const camOf = it => seg(it)[0] || '';
const dateOf = it => seg(it)[1] || '';
const secOf = it => it.event ? '事件' : ((seg(it)[2] === '上午' || seg(it)[2] === '下午') ? seg(it)[2] : '连续');
function renderList() {
  const cam = activeCam();
  const box = $('#list');
  const arr = cam ? list.filter(x => camOf(x) === cam.dir) : [];
  box.innerHTML = '';
  if (!arr.length) { box.innerHTML = '<div class="empty">暂无录像</div>'; $('#recinfo').textContent = ''; return; }
  $('#recinfo').textContent = `${arr.length} 段 · ${fmtSize(arr.reduce((a, b) => a + b.size, 0))}`;
  const days = new Map();
  for (const it of arr) { const k = dateOf(it); if (!days.has(k)) days.set(k, []); days.get(k).push(it); }
  const keys = [...days.keys()].sort().reverse();
  keys.forEach((k, idx) => {
    if (firstRender && idx === 0) expandedDays.add(k);
    const items = days.get(k).slice().sort((a, b) => b.start - a.start);
    const sizeSum = items.reduce((a, b) => a + b.size, 0);
    const dayEl = document.createElement('div');
    dayEl.className = 'day' + (expandedDays.has(k) ? '' : ' collapsed');
    const h = document.createElement('h3');
    h.innerHTML = `<span class="h-l">📅 ${k} <span class="cnt">周${WEEK[new Date(k + 'T00:00:00').getDay()]}</span></span>`
      + `<span class="h-r"><span class="cnt">${items.length} 段 · ${fmtSize(sizeSum)}</span> <b class="arw">${expandedDays.has(k) ? '▾' : '▸'}</b></span>`;
    h.onclick = () => { if (expandedDays.has(k)) expandedDays.delete(k); else expandedDays.add(k);
      dayEl.classList.toggle('collapsed'); h.querySelector('.arw').textContent = dayEl.classList.contains('collapsed') ? '▸' : '▾'; };
    const body = document.createElement('div'); body.className = 'body';
    for (const s of ['上午', '下午', '事件', '连续']) {
      const ls = items.filter(it => secOf(it) === s);
      if (!ls.length) continue;
      const sd = document.createElement('div'); sd.className = 'sec';
      sd.innerHTML = `<h4>${s} <span class="cnt">${ls.length}</span></h4>`;
      const hours = new Map();
      for (const it of ls) { const hh = new Date(it.start).getHours(); if (!hours.has(hh)) hours.set(hh, []); hours.get(hh).push(it); }
      for (const hh of [...hours.keys()].sort((a, b) => b - a)) {
        const hkey = `${k}|${s}|${hh}`;
        const hItems = hours.get(hh);
        const hSize = hItems.reduce((a, b) => a + b.size, 0);
        const hEl = document.createElement('div');
        hEl.className = 'hour' + (expandedHours.has(hkey) ? '' : ' collapsed');
        const hr = document.createElement('div'); hr.className = 'hr';
        hr.innerHTML = `<span class="h-l">${two(hh)}:00 – ${two(hh)}:59</span>`
          + `<span class="h-r">${hItems.length} 段 · ${fmtSize(hSize)} <b class="arw">${expandedHours.has(hkey) ? '▾' : '▸'}</b></span>`;
        hr.onclick = () => { if (expandedHours.has(hkey)) expandedHours.delete(hkey); else expandedHours.add(hkey);
          hEl.classList.toggle('collapsed'); hr.querySelector('.arw').textContent = hEl.classList.contains('collapsed') ? '▸' : '▾'; };
        const g = document.createElement('div'); g.className = 'grid';
        for (const it of hItems) {
          const d = document.createElement('div');
          if (it.complete === false) {
            d.className = 'item rec';
            d.innerHTML = `<div class="t">⏺ 录制中…</div><div class="s">${fmtSize(it.size)}</div>`;
          } else {
            d.className = 'item';
            d.innerHTML = `<div class="t">${fmtTime(it.start)}${it.event ? '<span class="badge">事件</span>' : ''}</div><div class="s">${fmtSize(it.size)}</div>`;
            d.onclick = () => playRec(it);
          }
          g.appendChild(d);
        }
        hEl.appendChild(hr); hEl.appendChild(g);
        sd.appendChild(hEl);
      }
      body.appendChild(sd);
    }
    dayEl.appendChild(h); dayEl.appendChild(body); box.appendChild(dayEl);
  });
  firstRender = false;
}
async function refreshList() {
  try { list = await (await fetch(U('api/list'))).json(); renderList(); }
  catch { $('#list').innerHTML = '<div class="empty">读取失败</div>'; }
}
function playRec(it) {
  try { $('#lv').pause(); } catch { }
  $('#play').classList.remove('hidden');
  try { if ((history.state || {}).v !== 'play') history.pushState({ v: 'play' }, '', location.href); } catch { }
  const v = $('#pv');
  v.src = U('rec/') + String(it.rel || it.name).split('/').map(encodeURIComponent).join('/');
  v.play().catch(() => { });
  $('#ptitle').textContent = `${it.event ? '事件录像 · ' : ''}${fmtDay(it.start)} ${fmtTime(it.start)} · ${fmtSize(it.size)}`;
  window.scrollTo({ top: 0 });
}
$('#pback').onclick = () => {
  const st = history.state || {};
  if (st.v === 'play') history.back(); else closePlay();
};

/* ================= 启动 ================= */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register(U('sw.js'), { scope: BASE }).catch(() => { });
}
(async () => {
  // 初始历史项不写 state（首页 state 为空即可，由 route() 兜底判断）
  // 一次性诊断（哪个版本页面 / 是否被套在 iframe 里 / 文档来源），只发一次，便于定位手机端行为
  try { fetch(U('api/diag?top=' + (window.top === window ? '1' : '0') + '&v=0.4.0-6&ref=' +
    encodeURIComponent(document.referrer || '') + '&ua=' + encodeURIComponent(navigator.userAgent))).catch(() => { }); } catch { }
  await refreshStatus();
  const m = /^#cam\/(.+)$/.exec(location.hash || '');
  if (m) { const cam = cams.find(c => c.id === m[1]); if (cam) enterCam(cam, false); } else route();
  setInterval(refreshStatus, 5000);
  setInterval(() => { if (activeId) refreshList(); }, 15000);
  // 快照只在「进软件」时抓一次（不再定时刷新，省资源）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshStatus(); refreshThumbs(); } });
})();
