#!/usr/bin/env node
// 飞海监控 (fn-hiknvr) · v0.2 —— 多摄像机 · 连续+事件双轨录像 · 本地移动侦测
// 只读拉流(RTSP)，绝不改动摄像机设置。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.NVR_CONF || path.join(__dir, 'config.json');
// ★ Docker/容器模式：由环境变量 NVR_DOCKER=1 开启（影响默认目录、存储空间枚举、建议目录）
const DOCKER = String(process.env.NVR_DOCKER || '') === '1';
const PUB = path.join(__dir, 'public');
const DATA_ROOT = process.env.NVR_DATA || path.join(__dir, 'data');
const REC_ROOT = process.env.NVR_REC_ROOT || path.join(DATA_ROOT, 'rec');
const SNAP_ROOT = path.join(DATA_ROOT, 'snap');

// ---------- 多品牌 RTSP 地址模板：main=主码流 / sub=子码流 ----------
const BRANDS = ['hik', 'dahua', 'uniview', 'tplink', 'custom'];
function brandRtsp(brand, ip, port, user, pass, channel, main) {
  const auth = `${encodeURIComponent(user || '')}:${encodeURIComponent(pass || '')}@`;
  const host = `${ip}:${port || 554}`;
  const ch = Math.max(1, parseInt(channel) || 1);
  switch (brand) {
    case 'dahua':   return `rtsp://${auth}${host}/cam/realmonitor?channel=${ch}&subtype=${main ? 0 : 1}`;
    case 'uniview': return `rtsp://${auth}${host}/media/video${main ? 1 : 2}`;
    case 'tplink':  return `rtsp://${auth}${host}/stream${main ? 1 : 2}`;
    case 'hik':
    default:        return `rtsp://${auth}${host}/Streaming/Channels/${ch * 100 + (main ? 1 : 2)}`;
  }
}
const MAX_CAMS = 4;                        // 与界面/文档一致：最多 4 台摄像机
const camConfigured = cam => !!(cam && cam.ip);
const camIdGen = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function newCamera(o = {}) {
  return { id: camIdGen(), name: '', ip: '', port: 554, user: '', pass: '', channel: 1, brand: 'hik',
           previewStream: 'main', rtspMain: '', rtspSub: '', ...o };
}
// ★ 统一取流地址生成：custom 且有主码流地址 → 原样保留用户填写；否则按品牌模板生成
function computeUrls(cam) {
  if (cam.brand === 'custom' && cam.rtspMain) {
    return { rtspMain: cam.rtspMain, rtspSub: typeof cam.rtspSub === 'string' ? cam.rtspSub : '' };
  }
  if (cam.ip) {
    return { rtspMain: brandRtsp(cam.brand, cam.ip, cam.port, cam.user, cam.pass, cam.channel, true),
             rtspSub: brandRtsp(cam.brand, cam.ip, cam.port, cam.user, cam.pass, cam.channel, false) };
  }
  return { rtspMain: '', rtspSub: '' };
}
function applyCameraUrls(c) {
  for (const cam of c.cameras) {
    const u = computeUrls(cam);
    cam.rtspMain = u.rtspMain; cam.rtspSub = u.rtspSub;
  }
  return c;
}
// 目录名 = 摄像机名（清洗后）；重名自动加后缀；改名时同步重命名现有目录
function safeName(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return t.slice(0, 40);
}
function syncCameraDirs(root) {
  const used = new Set();
  cfg.cameras.forEach((cam, i) => {
    let want = safeName(cam.name) || ('摄像机' + (i + 1));
    let d = want, k = 2;
    while (used.has(d)) d = want + '-' + (k++);
    used.add(d);
    if (cam.dir && cam.dir !== d) {
      const oldP = path.join(root, cam.dir), newP = path.join(root, d);
      try { if (fs.existsSync(oldP) && !fs.existsSync(newP)) fs.renameSync(oldP, newP); } catch {}
    }
    cam.dir = d;
  });
}
function defaultConfig() {
  return {
    cameras: [newCamera()],
    record: { enabled: true, segmentSeconds: 300, retentionDays: 3, root: REC_ROOT },
    live: { root: path.join(DATA_ROOT, 'live') },
    ring: { root: path.join(DATA_ROOT, 'ring'), segmentSeconds: 2 },
    motion: { enabled: true, fps: 2, width: 64, height: 48, diffThreshold: 22, changedRatio: 0.03,
              holdSeconds: 8, preRoll: 15, postRoll: 15 },
    http: { port: Number(process.env.NVR_PORT || 8091), host: process.env.NVR_HTTP_HOST || '127.0.0.1', user: process.env.NVR_HTTP_USER || 'admin', pass: process.env.NVR_HTTP_PASS || '' },  // 默认只听本机；局域网访问请改 host 并设置口令
    https: { enabled: String(process.env.NVR_HTTPS || 'false') === 'true', port: Number(process.env.NVR_HTTPS_PORT || 8444),
             host: '127.0.0.1', domain: process.env.NVR_DOMAIN || '', certDir: process.env.NVR_CERT_DIR || '' }
  };
}
function writeCfg() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(CFG_PATH, 0o600); } catch {}     // 内含摄像头密码，仅本用户可读
}
if (!fs.existsSync(CFG_PATH)) {
  try { fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(CFG_PATH, JSON.stringify(defaultConfig(), null, 2));
  try { fs.chmodSync(CFG_PATH, 0o600); } catch {}
}
try { fs.chmodSync(CFG_PATH, 0o600); } catch {}       // 老配置文件也收紧权限
let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
// ★ 配置归一化：老版本/手工改过的配置缺字段时，用默认值补齐（避免启动时 undefined 崩溃）
function mergeDefaults(dst, def) {
  for (const k of Object.keys(def)) {
    const dv = def[k];
    if (dst[k] === undefined || dst[k] === null) { dst[k] = dv; continue; }
    if (dv && typeof dv === 'object' && !Array.isArray(dv) && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeDefaults(dst[k], dv);
  }
  return dst;
}
cfg = mergeDefaults(cfg, defaultConfig());
// ★ Docker/容器：这几个环境变量优先于配置文件（方便用 -e 配置监听地址与访问口令）
if (process.env.NVR_HTTP_HOST) cfg.http.host = process.env.NVR_HTTP_HOST;
if (process.env.NVR_HTTP_USER) cfg.http.user = process.env.NVR_HTTP_USER;
if (process.env.NVR_HTTP_PASS) cfg.http.pass = process.env.NVR_HTTP_PASS;
if (process.env.NVR_RETENTION_DAYS) cfg.record.retentionDays = Math.min(365, Math.max(1, parseInt(process.env.NVR_RETENTION_DAYS) || 3));
if (process.env.NVR_SEGMENT_SECONDS) cfg.record.segmentSeconds = Math.min(3600, Math.max(60, parseInt(process.env.NVR_SEGMENT_SECONDS) || 300));
// ---- 老版本(单摄像机 camera)配置迁移 ----
if (!Array.isArray(cfg.cameras)) {
  const old = cfg.camera || {};
  cfg.cameras = [newCamera({ name: old.name || '', ip: old.ip || '', port: old.port || 554, user: old.user || '',
    pass: old.pass || '', channel: old.channel || 1, previewStream: cfg.previewStream === 'sub' ? 'sub' : 'main' })];
  delete cfg.camera; delete cfg.previewStream;
}
// 允许 0 台（用户可删光摄像机）：不再自动补一台空白摄像机
if (!cfg.http) cfg.http = { port: 8091, host: '127.0.0.1', user: 'admin', pass: '' };
// ★ 首次安装的默认录像目录落在隐藏的系统目录（@appshare/@appdata）里，文件管理器看不见 →
//   换成「剩余空间最大的存储空间」下的可见目录（如 /volX/1000/NVR），用户仍可在设置页改。
try {
if (!DOCKER && (!cfg.record.root || /\/@(appdata|appshare)\//.test(cfg.record.root))) {
  const sug = suggestRoot(null);
  let ok = false;
  if (sug && insideVolume(sug) && !/\/@(appdata|appshare)\//.test(sug)) {
    try { fs.mkdirSync(sug, { recursive: true }); fs.accessSync(sug, fs.constants.W_OK); ok = true; } catch {}
  }
  if (ok) { log(`[cfg] 默认录像目录 ${cfg.record.root || '(空)'} → ${sug}（可在设置页修改）`); cfg.record.root = sug; writeCfg(); }
  else if (sug) log(`[cfg] 建议目录 ${sug} 不可写，保留 ${cfg.record.root || '(空)'}`);
}
} catch (e) { log('[cfg] 默认目录处理跳过：' + (e && e.message)); }

// ★ 旧配置归一化：老 config.json 缺 brand/rtspMain/rtspSub 时补默认（默认按海康，不破坏旧配置）
for (const cam of cfg.cameras) {
  if (!BRANDS.includes(cam.brand)) cam.brand = 'hik';
  if (typeof cam.rtspMain !== 'string') cam.rtspMain = '';
  if (typeof cam.rtspSub !== 'string') cam.rtspSub = '';
}
applyCameraUrls(cfg);
for (const cam of cfg.cameras) if (!cam.id) cam.id = camIdGen();
syncCameraDirs(cfg.record.root);

// ⚠️ 已移除旧的 migrateRootLayout（会把录像根下所有「日期目录」搬进第一台摄像机目录）——
// 当录像根与其它应用共用时会误搬别人的数据。
// ⚠️ 也移除了它的补救函数 repairForeignDateDirs()：该函数会把「早于今天」的日期目录搬出摄像机目录
//    并剥掉文件名前缀 —— 正常运行时会把历史录像搬乱，不能留在启动流程里（补救已完成，不需要再跑）。

const PREFIX = process.env.NVR_PREFIX ?? '/app/fn-hiknvr';
const APPVER = process.env.NVR_APPVER || '';   // 由 cmd/main 注入，供界面显示版本号
function refreshPaths() {
  syncCameraDirs(cfg.record.root);
  for (const d of [cfg.record.root, cfg.live.root, cfg.ring.root, SNAP_ROOT]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { log('[cfg] 目录不可用', d, e.code || e.message); } }
  for (const cam of cfg.cameras) {
    for (const d of [path.join(cfg.live.root, cam.id), path.join(cfg.ring.root, cam.id)]) fs.mkdirSync(d, { recursive: true });
  }
}
refreshPaths();

const FFMPEG = process.env.NVR_FFMPEG || (['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) || 'ffmpeg');
// ★ 日志脱敏：ffmpeg 的 stderr 会带完整输入地址（含摄像头密码），一律先脱敏再写日志
// 用函数声明（会提升）：启动早期（配置归一化/路径准备）就要用，不能依赖 const 的初始化顺序
function redact(s) {
  return String(s)
    .replace(/rtsp:\/\/[^\s@/]*@/gi, 'rtsp://***@')
    .replace(/([?&](?:password|pwd|auth)=)[^&\s]*/gi, '$1***');
}
function log(...a) { console.log(new Date().toISOString(), ...a.map(x => (typeof x === 'string' ? redact(x) : x))); }

// ★ 安全：未设置访问口令时，禁止把服务监听到非本机地址（旧配置自动纠正）
function fixHosts() {
  for (const x of [cfg.http, cfg.https]) {
    if (!x || !x.host) continue;
    const h = String(x.host);
    if (!(cfg.http && cfg.http.pass) && !['127.0.0.1', 'localhost', '::1'].includes(h)) {
      log(`[sec] 未设置访问口令，监听地址 ${h} → 127.0.0.1（如需局域网访问，请设置 http.user / http.pass）`);
      x.host = '127.0.0.1';
    }
  }
}
fixHosts();

// ★ 保命：单个请求的异步错误绝不能让进程挂掉（挂了 = 停止录像）
process.on('uncaughtException', e => { log('[fatal-guard] uncaughtException:', e && e.message); });
process.on('unhandledRejection', e => { log('[fatal-guard] unhandledRejection:', e && (e.message || e)); });
const two = n => String(n).padStart(2, '0');
let shuttingDown = false;

// ---------- 每台摄像机的运行状态 ----------
const state = { cams: new Map() };
function cs(cam) {
  let s = state.cams.get(cam.id);
  if (!s) {
    s = { mainProc: null, motionProc: null, recDir: null, codec: '', h265: false, codecAt: 0, codecBusy: false,
          motion: { lastFrame: null, lastMotionTs: 0, eventActive: false, eventStart: 0,
                    lastEventEnd: 0, lastScore: 0, eventCount: 0, frames: 0, lastError: '' } };
    state.cams.set(cam.id, s);
  }
  return s;
}
const liveDirOf = cam => path.join(cfg.live.root, cam.id);
const ringDirOf = cam => path.join(cfg.ring.root, cam.id);
const recDirOf  = cam => path.join(cfg.record.root, cam.dir || cam.id);
const contDirOf  = (cam, d) => path.join(recDirOf(cam), ymdOf(d), halfOf(d), hourLabel(d));
const eventDirOf = (cam, d) => path.join(recDirOf(cam), ymdOf(d), '事件');

const COMMON = ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-use_wallclock_as_timestamps', '1'];
const ymdOf = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const halfOf = d => (d.getHours() < 12 ? '上午' : '下午');
const hourLabel = d => `${two(d.getHours())}:00-${two(d.getHours())}:59:59`;
const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; };

function killP(proc) { try { proc?.kill('SIGTERM'); } catch {} }
function killHard(proc) { const pid = proc?.pid; killP(proc); if (pid) setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 5000); }

// ★ 记录本进程拉起的 ffmpeg 子进程 pid。
// 容器里 node 就是 PID 1，它拉起的子进程 ppid 也等于 1 → reapOrphans 只看 ppid==1 时
// 会把自己正在拉流的管线当成「孤儿」杀掉（每 60 秒一次，录像每分钟断几秒）。
const CHILD_PIDS = new Set();
function trackChild(p) { try { if (p && p.pid) { CHILD_PIDS.add(p.pid); p.once('exit', () => CHILD_PIDS.delete(p.pid)); } } catch {} return p; }

// ---------- 主码流管线：一次拉流 → ① 连续录像 ② 事件环形 ③ HLS 直播（3 路输出）----------
// 海康只允许 3 路并发 RTSP 会话；main 拉 1 路复制成 3 输出、motion 走子码流 = 每台 2 路会话。
// ---------- 拉流重试退避 + 告警降噪 ----------
const RETRY_BASE_MAIN = 5000, RETRY_BASE_MOTION = 3000, RETRY_MAX = 30000, RETRY_HEALTHY = 30000;
// 认证失败（401/Unauthorized）专用长退避：
// 账号密码不对、或相机把账号「非法登录锁定」时，正确密码也会 401 —— 快速重试等于继续累加失败次数，
// 会把锁定越刷越长（自己把自己锁死）。所以认证失败时改用 1 → 5 → 15 → 30 分钟的长退避。
const AUTH_RETRY_STEPS = [60000, 300000, 900000, 1800000];
// 进程正常跑够 RETRY_HEALTHY（30 秒）就重置退避：摄像头恢复后不会因为退避越等越久
function nextRetryDelay(s, key, base) {
  const ran = Date.now() - (s[key + 'Start'] || 0);
  if (ran >= RETRY_HEALTHY) { s[key + 'Delay'] = 0; s[key + 'Fails'] = 0; s[key + 'Shown'] = 0; s[key + 'Auth'] = 0; s[key + 'AuthFails'] = 0; s[key + 'AuthMode'] = false; return base; }
  s[key + 'Fails'] = (s[key + 'Fails'] || 0) + 1;
  // ① 认证失败 → 长退避（避免反复试错把相机账号锁死）
  const authAt = s[key + 'Auth'] || 0;
  if (authAt && Date.now() - authAt < 60000) {          // 本次退出前 ffmpeg 报过 401
    s[key + 'Auth'] = 0; s[key + 'AuthMode'] = true;
    const n = (s[key + 'AuthFails'] = (s[key + 'AuthFails'] || 0) + 1);
    const delay = AUTH_RETRY_STEPS[Math.min(n, AUTH_RETRY_STEPS.length) - 1];
    s[key + 'Delay'] = delay;
    return delay;
  }
  // ② 其它错误（网络断、相机重启中、超时…）→ 保持原来的短退避
  s[key + 'AuthMode'] = false;
  const delay = s[key + 'Delay'] ? Math.min(s[key + 'Delay'] * 2, RETRY_MAX) : base;
  s[key + 'Delay'] = delay;
  return delay;
}
// 只在失败的第 1 次和每 10 次打一条，避免一直刷屏
function retryLog(s, key, tag, delay) {
  const n = s[key + 'Fails'] || 1;
  const grew = delay > (s[key + 'Shown'] || 0);
  if (s[key + 'AuthMode']) {                       // 认证失败：提醒用户可能密码错 / 账号被相机锁了
    if (n === 1 || grew) { s[key + 'Shown'] = delay; log(`[${tag}] 认证失败（用户名/密码不对，或账号被相机临时锁定），改为 ${Math.round(delay / 60000)} 分钟后重试（避免连续试错把账号越锁越久）`); }
    return;
  }
  if (n === 1 || grew || n % 10 === 0) {          // 首次、退避每次变长、以及每 10 次时各记一条
    s[key + 'Shown'] = delay;
    log(`[${tag}] 拉流进程退出，${Math.round(delay / 1000)} 秒后重启${n > 1 ? `（连续第 ${n} 次）` : ''}`);
  }
}
// ffmpeg stderr 降噪：同类告警最多每 30 秒打一条，并统计省略次数
function logStderr(s, tag, raw) {
  const one = String(raw || '').trim().replace(/\s*\n+\s*/g, ' ⏎ '); if (!one) return;
  // 认证失败（401/Unauthorized）打标：本次进程退出后走「长退避」，避免反复试错把相机账号锁死
  if (/401|unauthorized/i.test(one)) { const sk = String(tag).split(':')[0]; if (sk === 'main' || sk === 'motion') s[sk + 'Auth'] = Date.now(); }
  const key = one.replace(/0x[0-9a-fA-F]+/g, '#').replace(/\d+/g, '#').slice(0, 200);   // 归一化：指针地址/数字都抹掉
  const now = Date.now();
  if (s.errKey === key) {
    s.errN = (s.errN || 1) + 1;
    if (now - (s.errTs || 0) < 30000) return;
    s.errTs = now; log(`[${tag}] 同类告警已重复 ${s.errN} 次，最近一条：${one.slice(0, 200)}`); return;
  }
  if (s.errKey && s.errN > 1) log(`[${tag}] （上一条同类告警共出现 ${s.errN} 次）`);
  s.errKey = key; s.errN = 1; s.errTs = now; log(`[${tag}]`, one.slice(0, 300));
}
function ringKeepCount() {
  const span = cfg.motion.preRoll + cfg.motion.postRoll + 20;
  return Math.max(6, Math.ceil(span / cfg.ring.segmentSeconds));
}
function startMain(cam) {
  const s = cs(cam);
  if (shuttingDown || !cfg.record.enabled || !camConfigured(cam) || s.mainProc) return;
  if (diskLow()) {                                   // 磁盘写满保护：暂停录像，1 分钟后再试
    if (!diskPaused) { diskPaused = true; log('[disk] 剩余空间不足 500MB，已暂停录像（等清理后自动恢复）'); cleanup().catch(() => {}); }
    setTimeout(() => startMain(cam), 60000);
    return;
  }
  if (diskPaused) { diskPaused = false; log('[disk] 空间已恢复，继续录像'); }
  const RING = ringDirOf(cam), LIVE = liveDirOf(cam);
  const dir = contDirOf(cam, new Date());
  for (const d of [dir, RING, LIVE]) fs.mkdirSync(d, { recursive: true });
  s.recDir = dir;
  const recOut = path.join(dir, cam.dir.replace(/%/g, '%%') + '-%Y%m%d-%H%M%S.mp4');
  const ringOut = path.join(RING, '%Y%m%d-%H%M%S.ts');
  const A = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1'];
  const args = [...COMMON, '-i', cam.rtspMain,
    ...A, '-f', 'segment', '-segment_time', String(cfg.record.segmentSeconds), '-reset_timestamps', '1',
    '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart', '-strftime', '1', recOut,
    ...A, '-f', 'segment', '-segment_time', String(cfg.ring.segmentSeconds), '-reset_timestamps', '1',
    '-segment_format', 'mpegts', '-strftime', '1', ringOut,
    ...A, '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(LIVE, 'seg%d.ts'), path.join(LIVE, 'index.m3u8')];
  if (!s.mainFails) log(`[main:${cam.dir}] start -> ${ymdOf(new Date())}/${halfOf(new Date())}`);
  const p = trackChild(spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
  s.mainProc = p; s.mainStart = Date.now();
  p.stderr.on('data', d => logStderr(s, `main:${cam.dir}`, d.toString()));
  p.on('exit', () => { s.mainProc = null;
    if (shuttingDown || !cfg.record.enabled || !cfg.cameras.includes(cam)) { s.mainDelay = 0; s.mainFails = 0; return; }
    if (s.mainPlanned) {                     // 计划内重启（切目录）→ 立即恢复，不计入失败次数
      s.mainPlanned = false; s.mainDelay = 0; s.mainFails = 0;
      log(`[main:${cam.dir}] 计划内重启（切换目录），立即恢复`);
      setTimeout(() => startMain(cam), 200);
      return;
    }
    const delay = nextRetryDelay(s, 'main', RETRY_BASE_MAIN);
    retryLog(s, 'main', `main:${cam.dir}`, delay);
    setTimeout(() => startMain(cam), delay); });
}

// 跨「上午/下午」、跨天、跨小时自动切目录
setInterval(() => {
  if (shuttingDown || !cfg.record.enabled) return;
  for (const cam of cfg.cameras) {
    const s = cs(cam);
    if (s.mainProc && diskLow()) { log('[disk] 剩余空间不足，停止录像'); killP(s.mainProc); }
    const want = contDirOf(cam, new Date());
    if (s.recDir && want !== s.recDir) {
      log(`[main:${cam.dir}] 切换目录 ->`, path.relative(recDirOf(cam), want));
      s.recDir = want;
      // ★ 计划内退出：让退出处理器立即重启（不等 5 秒退避），跨小时/跨天切换只留极小空档
      if (s.mainProc) { s.mainPlanned = true; killP(s.mainProc); } else startMain(cam);
    }
  }
}, 30000);

// ---------- 移动侦测（子码流 -> 低分辨率灰度原始帧） ----------
function startMotion(cam) {
  const s = cs(cam);
  if (shuttingDown || !cfg.motion.enabled || !cfg.record.enabled || !camConfigured(cam) || s.motionProc) return;
  if (!cam.rtspSub) return;          // 子码流为空（自定义/无子码流）：跳过移动侦测与子码流直播
  const { width: W, height: H, fps } = cfg.motion;
  const frameSize = W * H;
  const LIVE = liveDirOf(cam);
  fs.mkdirSync(LIVE, { recursive: true });
  // 同一路子码流连接 → ① 省资源的 HLS 直播（供宫格用）② 低分辨率灰度帧做移动侦测
  const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-i', cam.rtspSub,
    '-map', '0:v', '-an', '-c:v', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(LIVE, 'sub%d.ts'), path.join(LIVE, 'index-sub.m3u8'),
    '-map', '0:v', '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'];
  if (!s.motionFails) log(`[motion:${cam.dir}] start (${W}x${H}@${fps}fps)`);
  const p = trackChild(spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  s.motionProc = p; s.motionStart = Date.now();
  let buf = Buffer.alloc(0);
  p.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= frameSize) {
      const f = buf.subarray(0, frameSize); buf = buf.subarray(frameSize);
      analyzeFrame(cam, f, frameSize);
    }
  });
  p.stderr.on('data', d => logStderr(s, `motion:${cam.dir}`, d.toString()));
  p.on('exit', () => { s.motionProc = null;
    if (shuttingDown || !cfg.motion.enabled || !cfg.cameras.includes(cam)) { s.motionDelay = 0; s.motionFails = 0; return; }
    const delay = nextRetryDelay(s, 'motion', RETRY_BASE_MOTION);
    retryLog(s, 'motion', `motion:${cam.dir}`, delay);
    setTimeout(() => startMotion(cam), delay); });
}
function analyzeFrame(cam, frame, size) {
  const m = cs(cam).motion;
  m.frames++;
  if (m.lastFrame) {
    let changed = 0;
    for (let i = 0; i < size; i++) if (Math.abs(frame[i] - m.lastFrame[i]) > cfg.motion.diffThreshold) changed++;
    const ratio = changed / size;
    m.lastScore = ratio;
    if (ratio >= cfg.motion.changedRatio) onMotion(cam, ratio);
  }
  m.lastFrame = Buffer.from(frame);
}
function onMotion(cam, ratio) {
  const m = cs(cam).motion, now = Date.now();
  m.lastMotionTs = now;
  if (!m.eventActive) {
    m.eventActive = true; m.eventStart = now; m.eventCount++;
    log(`[motion:${cam.dir}] 事件开始 ratio=${ratio.toFixed(3)}`);
  }
}
setInterval(async () => {
  for (const cam of cfg.cameras) {
    const m = cs(cam).motion;
    if (!m.eventActive) continue;
    if (Date.now() - m.lastMotionTs < cfg.motion.holdSeconds * 1000) continue;
    m.eventActive = false; m.lastEventEnd = Date.now();
    log(`[motion:${cam.dir}] 事件结束`);
    try { await assembleClip(cam, m.eventStart, m.lastEventEnd); } catch (e) { log('[event] 剪辑失败', e.message); }
  }
}, 1000);

function parseRingMs(name) {
  const x = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ts$/);
  if (!x) return null;
  return new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5], +x[6]).getTime();
}
// 白名单：只有「符合本应用命名规则」的录像才归我们管（清理/扫描只动这些，避免误删同目录下别人的视频）
function oursName(name) {
  for (const cam of cfg.cameras) {
    const d = cam.dir; if (!d) continue;
    const re = new RegExp('^' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d{8}-\\d{6}(-E)?\\.mp4$');
    if (re.test(name)) return true;
  }
  return false;
}
const parseRecMs = name => {
  const x = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-E)?\.mp4$/);   // 允许 <摄像机名>- 前缀
  if (!x) return null;
  return new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5], +x[6]).getTime();
};
async function assembleClip(cam, fromMs, toMs) {
  const RING = ringDirOf(cam);
  const from = fromMs - cfg.motion.preRoll * 1000, to = toMs + cfg.motion.postRoll * 1000;
  const completeBefore = Date.now() - cfg.ring.segmentSeconds * 1000 - 500;
  let files = [];
  try {
    files = (await fsp.readdir(RING)).map(f => ({ f, t: parseRingMs(f) }))
      .filter(o => o.t !== null && o.t >= from && o.t <= to && o.t <= completeBefore)
      .sort((a, b) => a.t - b.t).map(o => o.f);
  } catch {}
  if (!files.length) { log(`[event:${cam.dir}] 无可用环形分片`); return; }
  const listPath = path.join(RING, `_concat_${Date.now()}.txt`);
  const outDir = eventDirOf(cam, new Date(toMs));
  await fsp.mkdir(outDir, { recursive: true });
  const outName = `${cam.dir}-${stamp(toMs)}-E.mp4`;
  await fsp.writeFile(listPath, files.map(f => `file '${path.join(RING, f)}'`).join('\n') + '\n');
  await new Promise(res => {
    const p = trackChild(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', '-y', path.join(outDir, outName)], { stdio: ['ignore', 'ignore', 'pipe'] }));
    p.stderr.on('data', d => log('[event]', d.toString().trim()));
    p.on('exit', () => res());
  });
  await fsp.unlink(listPath).catch(() => {});
  log(`[event:${cam.dir}] 已生成 ${outName}（${files.length} 片）`);
}

// ---------- 抓拍 ----------
function newestLiveSeg(cam, kind) {
  const LIVE = liveDirOf(cam);
  try {
    const now = Date.now();
    const re = kind === 'sub' ? /^sub\d+\.ts$/ : kind === 'main' ? /^seg\d+\.ts$/ : /\.ts$/;
    const arr = fs.readdirSync(LIVE).filter(f => re.test(f))
      .map(f => ({ p: path.join(LIVE, f), m: fs.statSync(path.join(LIVE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!arr.length) return null;
    return (arr.find(x => now - x.m > 1200) || arr[0]).p;
  } catch { return null; }
}
async function snapshot(cam, opts = {}) {
  // opts.w: 缩略图宽度（0=原图）；opts.sub: 优先取子码流片段（更省 CPU/流量）
  const w = +opts.w || 0, sub = !!opts.sub;
  const name = w ? `thumb-${cam.id}.jpg` : `${cam.dir}-${stamp(Date.now())}.jpg`;
  const out = path.join(SNAP_ROOT, name), tmp = out + '.tmp';
  fs.mkdirSync(SNAP_ROOT, { recursive: true });
  const vf = w ? ['-vf', `scale=${w}:-2`] : [];
  const grab = src => new Promise(res => {
    const fin = () => { try { if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) fs.renameSync(tmp, out); } catch {} res(); };
    const rtsp = /^rtsp:\/\//i.test(src);
    const args = ['-hide_banner', '-loglevel', 'error', ...(rtsp ? ['-rtsp_transport', 'tcp'] : []), '-i', src, '-frames:v', '1', ...vf, '-f', 'image2', '-q:v', '4', '-y', tmp];
    const p = trackChild(spawn(FFMPEG, args, { stdio: 'ignore' }));
    p.on('exit', fin); p.on('error', fin);
    setTimeout(() => { try { p.kill(); } catch {} fin(); }, 8000);
  });
  const seg = newestLiveSeg(cam, sub ? 'sub' : 'main') || (sub ? newestLiveSeg(cam, 'main') : null);
  if (seg) await grab(seg);
  if (!fs.existsSync(out) && cam.rtspMain) {
    await grab(cam.rtspMain);
  }
  return fs.existsSync(out) ? out : null;
}
// 缩略图并发去重（首页 5~6s 一次，多台顺序请求）
const snapInflight = new Map();
function snapshotShared(cam, opts) {
  const key = (opts && opts.w ? 't' : 'f') + cam.id + (opts && opts.sub ? 's' : '');
  let pr = snapInflight.get(key);
  if (!pr) { pr = snapshot(cam, opts).finally(() => snapInflight.delete(key)); snapInflight.set(key, pr); }
  return pr;
}
// 清理一天前的快照文件（缩略图是固定名覆盖，只有手动抓拍会累积）
function pruneSnaps() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(SNAP_ROOT)) {
      const p = path.join(SNAP_ROOT, f);
      try { if (now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
// 老录像文件名（20260922-134720.mp4）补上「摄像机名-」前缀 —— 幂等，一次性
function migrateNames() {
  let n = 0;
  for (const cam of cfg.cameras) {
    const walk = d => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/^\d{8}-\d{6}(-E)?\.mp4$/.test(e.name)) continue;
        try { fs.renameSync(p, path.join(d, cam.dir + '-' + e.name)); n++; } catch {}
      }
    };
    walk(recDirOf(cam));
  }
  if (n) log(`[migrate] 录像文件名已补「摄像机名-」前缀：${n} 个`);
}
// （已移除：旧录像根的一次性搬迁，属于开发环境的历史路径，公开版本不需要）

// ---------- 保留清理 / 环形清理 ----------
async function walkMp4(root) {
  const out = [];
  const rec = async dir => {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && parseRecMs(e.name) !== null && oursName(e.name)) out.push(p);
    }
  };
  await rec(root);
  return out;
}
async function pruneEmptyDirs(dir) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return true; }
  let empty = true;
  for (const e of ents) {
    if (e.isDirectory()) { const sub = path.join(dir, e.name); if (await pruneEmptyDirs(sub)) await fsp.rmdir(sub).catch(() => {}); else empty = false; }
    else empty = false;
  }
  return empty;
}
async function hasMoov(fp) {
  try {
    const fh = await fsp.open(fp, 'r'); const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0); await fh.close();
    return buf.subarray(0, bytesRead).includes(Buffer.from('moov'));
  } catch { return false; }
}
const moovCache = new Map();
async function fileComplete(fp, st) {
  const c = moovCache.get(fp);
  if (c && c.mtimeMs === st.mtimeMs) return c.complete;
  const complete = await hasMoov(fp);
  if (moovCache.size > 5000) moovCache.clear();
  moovCache.set(fp, { mtimeMs: st.mtimeMs, complete });
  return complete;
}
async function sweepBrokenTails() {
  const now = Date.now(); let n = 0;
  for (const fp of await walkMp4(cfg.record.root)) {
    try {
      const st = await fsp.stat(fp);
      const age = now - st.mtimeMs;
      if (age < 90000 || age > 3600000) continue;
      if (!(await hasMoov(fp))) { await fsp.unlink(fp).catch(() => {}); n++; log('[sweep] 删除损坏尾段', path.basename(fp)); }
    } catch {}
  }
  if (n) log(`[sweep] 清理损坏片段 ${n} 个`);
}
async function cleanup() {
  const cutoff = Date.now() - cfg.record.retentionDays * 86400_000;
  let n = 0;
  for (const p of await walkMp4(cfg.record.root)) {
    const t = parseRecMs(path.basename(p));
    if (t !== null && t < cutoff) { await fsp.unlink(p).catch(() => {}); n++; }
  }
  if (n) { log(`[cleanup] 删除过期录像 ${n} 个`); await pruneEmptyDirs(cfg.record.root); }
}
async function ringJanitor() {
  const keep = ringKeepCount();
  for (const cam of cfg.cameras) {
    const RING = ringDirOf(cam);
    try {
      const files = (await fsp.readdir(RING)).filter(f => f.endsWith('.ts'))
        .map(f => ({ f, t: parseRingMs(f) })).filter(o => o.t).sort((a, b) => a.t - b.t);
      for (const o of files.slice(0, Math.max(0, files.length - keep))) await fsp.unlink(path.join(RING, o.f));
    } catch {}
  }
}
setInterval(cleanup, 600000); setInterval(ringJanitor, 3000);

// ---------- 假死看门狗 ----------
const WATCH = {};
function _rchar(pid) { try { const s = fs.readFileSync(`/proc/${pid}/io`, 'utf8'); const m = s.match(/rchar:\s*(\d+)/); return m ? +m[1] : null; } catch { return null; } }
function watchStage(key, proc, limitMs) {
  if (!proc || !proc.pid) { delete WATCH[key]; return; }
  const rc = _rchar(proc.pid);
  const w = WATCH[key];
  if (!w || w.pid !== proc.pid || rc == null) { WATCH[key] = { pid: proc.pid, rc: rc || 0, t: Date.now() }; return; }
  if (rc > w.rc) { w.rc = rc; w.t = Date.now(); }
  else if (Date.now() - w.t > limitMs) {
    log(`[watch] ${key} 假死 ${Math.round((Date.now() - w.t) / 1000)}s 无数据，重启进程`);
    WATCH[key] = { pid: 0, rc: 0, t: Date.now() };
    killHard(proc);
  }
}
setInterval(() => {
  if (shuttingDown) return;
  for (const cam of cfg.cameras) {
    const s = cs(cam);
    watchStage('main:' + cam.id, s.mainProc, 30000);
    watchStage('motion:' + cam.id, s.motionProc, 30000);
  }
}, 10000);

// ---------- 孤儿清理 ----------
function _cmdline(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } }
function reapOrphans() {
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = +d; if (pid === process.pid) continue;
    let ppid = -1;
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.lastIndexOf(')'); ppid = +s.slice(r + 2).split(' ')[1]; } catch { continue; }
    if (ppid !== 1) continue;
    // ★ 容器里本进程就是 PID 1 → 自己拉起的子进程 ppid 同样是 1，必须按 pid 白名单排除，
    //   否则每 60 秒会把正在拉流的管线当孤儿杀掉（表现为「每分钟断一次、约 5 秒空档」）。
    if (CHILD_PIDS.has(pid)) continue;
    const c = _cmdline(pid);
    if (!/^\S*ffmpeg\b/.test(c)) continue;
    // 判据收紧：必须引用本应用的数据目录（live/ring 输出），避免误杀用户或其它应用拉同一台摄像头的 ffmpeg
    if (!c.includes(DATA_ROOT + '/')) continue;
    try { process.kill(pid, 'SIGKILL'); n++; log('[reap] 清理孤儿 ffmpeg pid=' + pid); } catch {}
  }
  if (n) log(`[reap] 共清理 ${n} 个孤儿 ffmpeg`);
}
// ★ 按摄像机 id 精确杀流（不依赖 state，删除摄像机时用）
function killByCamRef(id) {
  let n = 0;
  const a = `${DATA_ROOT}/live/${id}/`, b = `${DATA_ROOT}/ring/${id}/`;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = +d; if (pid === process.pid) continue;
    const c = _cmdline(pid);
    if (!/^\S*ffmpeg\b/.test(c)) continue;
    if (!c.includes(a) && !c.includes(b)) continue;
    try { process.kill(pid, 'SIGKILL'); n++; } catch {}
  }
  if (n) log(`[cam] 已停止摄像机 ${id} 的 ${n} 个拉流进程`);
  return n;
}
// ★ 兜底：杀掉「引用了已不在配置里的摄像机目录」的 ffmpeg（覆盖删机/崩溃/竞态）
function reapStale() {
  const ids = new Set(cfg.cameras.map(c => c.id));
  const re = new RegExp(DATA_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/(?:live|ring)\\/([^\\/\\s]+)\\/', 'g');
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = +d; if (pid === process.pid) continue;
    const c = _cmdline(pid);
    if (!/^\S*ffmpeg\b/.test(c)) continue;
    re.lastIndex = 0; let alien = false, m;
    while ((m = re.exec(c))) { if (!ids.has(m[1])) { alien = true; break; } }
    if (!alien) continue;
    try { process.kill(pid, 'SIGKILL'); n++; log('[reap] 清理失效摄像机管线 pid=' + pid); } catch {}
  }
  if (n) log(`[reap] 共清理 ${n} 个失效管线进程`);
}

async function migrateFaststart() {
  const marker = path.join(DATA_ROOT, '.faststart-migrated');
  if (fs.existsSync(marker)) return;
  let n = 0;
  for (const fp of await walkMp4(cfg.record.root)) {
    try {
      const fh = await fsp.open(fp, 'r'); const head = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(head, 0, 65536, 0); await fh.close();
      if (!head.subarray(0, bytesRead).includes(Buffer.from('moof'))) continue;
      const tmp = fp + '.tmp.mp4';
      await new Promise(res => { const p = trackChild(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', fp, '-c', 'copy', '-movflags', '+faststart', '-y', tmp], { stdio: ['ignore', 'ignore', 'pipe'] })); p.stderr.on('data', d => log('[migrate]', d.toString().trim())); p.on('exit', () => res()); });
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) { await fsp.rename(tmp, fp); n++; } else { await fsp.unlink(tmp).catch(() => {}); }
    } catch {}
  }
  fs.writeFileSync(marker, new Date().toISOString());
  log(`[migrate] faststart 完成，remux ${n} 个`);
}

setTimeout(() => { cleanup(); ringJanitor(); }, 5000);
setTimeout(() => { sweepBrokenTails().catch(e => log('[sweep] 失败', e.message)); }, 90000);
setTimeout(() => { migrateFaststart().catch(e => log('[migrate] 失败', e.message)); }, 8000);

// ---------- 启动 / 重启管线 ----------
// 录像根目录 + 一份说明文件：让用户装完立刻能在文件管理器里看到一个文件（= 映射成功），也顺带说明目录结构。
const REC_NOTE = [
  '飞海监控 · 录像说明',
  '=====================',
  '',
  '这个文件夹是「飞海监控」保存录像的地方，录像会自动按下面的结构生成：',
  '',
  '    摄像机名字 / 日期 / 上午|下午 / 时间段 / 录像文件.mp4',
  '',
  '· 看到本文件，说明录像目录映射成功。',
  '· 想让录像换个地方存：改 docker 启动命令里 -v 左边那段路径（或在设置页「保存目录」里改），删掉容器重建即可。',
  '  摄像机配置存在数据卷里，重建不会丢。',
  '· 本文件可以删，删了下次启动会重新生成，不影响录像。',
  ''
].join('\n');
function prepareRecRoot() {
  try {
    fs.mkdirSync(cfg.record.root, { recursive: true });
    const note = path.join(cfg.record.root, '录像说明.txt');
    if (!fs.existsSync(note)) fs.writeFileSync(note, REC_NOTE);
  } catch (e) { log('[rec] 录像目录准备失败: ' + (e && e.message)); }
}
function startAll() {
  prepareRecRoot();
  for (const cam of cfg.cameras) { startMain(cam); startMotion(cam); if (!cs(cam).codec) setTimeout(() => probeCodec(cam), 5000); }
  log(`[rec] 已启动 ${cfg.cameras.filter(camConfigured).length} 台摄像机的连续+事件录像`);
}
// ★ 必须等旧 ffmpeg 真正退出再起新的（否则旧进程仍占着 RTSP 会话 → 新进程被拒 SETUP 500 → 用户感觉要等 20~30 秒）
function restartPipeline() {
  const olds = [];
  for (const s of state.cams.values()) { if (s.mainProc) olds.push(s.mainProc); if (s.motionProc) olds.push(s.motionProc); }
  const pids = olds.map(p => p.pid).filter(Boolean);
  for (const s of state.cams.values()) { s.mainProc = null; s.motionProc = null; s.recDir = null; }
  olds.forEach(killP);
  const t0 = Date.now();
  const iv = setInterval(() => {
    const alive = pids.some(pid => fs.existsSync(`/proc/${pid}`));
    if (!alive || Date.now() - t0 > 6000) {
      clearInterval(iv);
      pids.forEach(pid => { try { process.kill(pid, 'SIGKILL'); } catch {} });
      for (const cam of cfg.cameras) {
        try { const L = liveDirOf(cam); for (const f of fs.readdirSync(L)) if (/\.(ts|m3u8)$/.test(f)) fs.unlinkSync(path.join(L, f)); } catch {}
      }
      try { refreshPaths(); } catch {}
      if (!shuttingDown) startAll();
      log(`[cfg] 管线重启完成（旧进程退出耗时 ${Date.now() - t0}ms）`);
    }
  }, 250);
  log('[cfg] 配置已更新，正在重启管线…');
}
async function waitLiveReady(ms) {
  const cam = cfg.cameras.find(camConfigured);
  if (!cam) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const pl = fs.readFileSync(path.join(liveDirOf(cam), 'index.m3u8'), 'utf8');
      if ((pl.match(/\.ts/g) || []).length >= 1) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// ---------- 测试连接 ----------
function probeStream(url, ms) {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, error: '未填写摄像机地址' });
    const args = ['-hide_banner', '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', url, '-t', '0.5', '-f', 'null', '-'];
    let err = '';
    const p = trackChild(spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, ms || 15000);
    p.stderr.on('data', d => err += d.toString());
    p.on('exit', () => {
      clearTimeout(to);
      const vm = /Stream #0:\d+.*?Video:\s*([A-Za-z0-9_]+)/.exec(err);
      const codec = vm ? vm[1].toLowerCase() : '';
      const hasAudio = /Stream #0:\d+.*?Audio:/.test(err);
      const wm = /,\s*(\d{3,5})x(\d{3,5})/.exec(err);
      if (!codec) {
        let msg = '连接失败';
        if (/401|Unauthorized/i.test(err)) msg = '认证失败：用户名或密码不对（注意区分大小写）\n若确认无误，可能是相机临时锁定了该账号（连续错 7 次会锁约 30 分钟，重启相机可立即解锁）';
        else if (/Connection refused|No route to host|timed out|Could not find codec|Connection timed out/i.test(err)) msg = '连不上：检查 IP / 端口 / 网络';
        else if (/404|Not Found/i.test(err)) msg = '通道不存在：检查通道号';
        // 把 ffmpeg 的原话带回去（只留最后几行）——出问题时用户/开发者能直接看到真实原因
        const detail = err.trim().split('\n').slice(-8).join('\n');
        return resolve({ ok: false, error: msg, detail });
      }
      resolve({ ok: true, codec, width: wm ? +wm[1] : 0, height: wm ? +wm[2] : 0, audio: hasAudio, h265: /^(hevc|h265)$/.test(codec) });
    });
  });
}

// ---------- 编码探测（H.265 引导用）----------
// 目的：管线是 -c:v copy（不转码），若摄像机是 H.265，浏览器播 HLS 会黑屏/转圈 → 前端要提前给引导
async function probeCodec(cam) {
  const s = cs(cam);
  if (s.codecBusy || shuttingDown || !camConfigured(cam)) return;
  const url = cam.rtspMain || cam.rtspSub;
  if (!url) { s.codec = ''; s.h265 = false; return; }
  s.codecBusy = true;
  try {
    const r = await probeStream(url, 12000);
    if (r && r.ok) { s.codec = r.codec || ''; s.h265 = !!r.h265; s.codecAt = Date.now(); log(`[codec:${cam.dir || cam.id}] ${s.codec}${s.h265 ? '（H.265 → 网页会黑屏，已提示用户）' : ''}`); }
  } catch { } finally { s.codecBusy = false; }
}

// ---------- 目录浏览（保存目录选择器） ----------
function volumes() {
  const out = [];
  if (DOCKER) {
    // 容器里没有 /volN：用挂载点（默认 /rec 录像），可用 NVR_VOL_ROOTS 覆盖（逗号分隔）
    // ★ 数据目录（配置 + 内部缓存 live/ring/snap）不列出来：用户用不上，露出来只会选错。
    const roots = (process.env.NVR_VOL_ROOTS || '/rec,/data').split(',').map(s => s.trim()).filter(Boolean);
    const recOnly = roots.filter(p => path.normalize(p) !== path.normalize(DATA_ROOT));
    for (const p of (recOnly.length ? recOnly : roots)) {
      let total = 0, free = 0;
      try { const s = fs.statfsSync(p); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch { continue; }
      const isRec = path.normalize(p) === path.normalize(REC_ROOT);
      out.push({ path: p, name: isRec ? '录像目录（你映射进容器的那个文件夹）' : p, total, free });
    }
    return out;
  }
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, mnt, fstype] = line.split(' ');
      const m = /^\/vol(\d+)$/.exec(mnt || '');
      if (!m) continue;
      let total = 0, free = 0;
      try { const s = fs.statfsSync(mnt); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch {}
      out.push({ path: mnt, name: '存储空间 ' + m[1], total, free });
    }
  } catch {}
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
function volRoots() { return volumes().map(v => v.path); }   // 函数声明（提升）
function insideVolume(p) {
  const n = path.normalize(p);
  return volRoots().some(r => n === r || n.startsWith(r + path.sep));
}
function suggestRoot(uid) {
  if (DOCKER) return REC_ROOT;              // 容器里就是映射进来的那个文件夹，别再往下套一层
  const vols = volumes(); if (!vols.length) return null;
  const best = vols.slice().sort((a, b) => b.free - a.free)[0];
  const cands = [];
  if (uid) cands.push(path.join(best.path, String(uid)));
  try {
    for (const e of fs.readdirSync(best.path)) if (/^\d+$/.test(e)) { cands.push(path.join(best.path, e)); break; }
  } catch {}
  cands.push(best.path);
  return path.join(cands[0], 'NVR');
}
async function browse(dir) {
  const n = path.normalize(dir);
  if (!insideVolume(n)) return { error: '路径不在存储空间内' };
  let ents = [];
  try { ents = await fsp.readdir(n, { withFileTypes: true }); } catch (e) { return { error: '无法读取该目录（权限不足或不存在）' }; }
  const dirs = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('@') || e.name.startsWith('.')) continue;
    dirs.push({ name: e.name, path: path.join(n, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  let free = 0, total = 0;
  try { const s = fs.statfsSync(n); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
  let writable = false;
  try { fs.accessSync(n, fs.constants.W_OK); writable = true; } catch {}
  const parent = n === '/' ? null : path.dirname(n);
  return { path: n, parent: insideVolume(parent) && parent !== n ? parent : null, dirs, free, total, writable,
           isRoot: volRoots().includes(n) };
}

// ============ ONVIF（WS-Discovery 发现 + WS-UsernameToken 取流）—— 零依赖，仅 node 标准库 ============
const WS_ADDR = '239.255.255.250', WS_PORT = 3702;
function localIpv4() {
  const out = [];
  try {
    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  } catch {}
  return out;
}
function wsProbeXml() {
  const msgId = 'urn:uuid:' + crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>${msgId}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}
const xmlTagText = (xml, tag) => {
  const m = new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`).exec(xml);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
};
const xmlTagBody = (xml, tag) => {
  const m = new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`).exec(xml);
  return m ? m[1] : '';
};
function parseScopeName(scopes) {
  if (!scopes) return '';
  let name = '';
  const nm = /onvif:\/\/www\.onvif\.org\/name\/([^\s]+)/i.exec(scopes);
  if (nm) name = nm[1];
  else { const hw = /onvif:\/\/www\.onvif\.org\/hardware\/([^\s]+)/i.exec(scopes); if (hw) name = hw[1]; }
  try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch {}
  return name;
}
function parseWsDiscovery(xml, rinfo) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_]+:)?(ProbeMatch|Hello)[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const types = xmlTagText(body, 'Types');
    if (types && !/NetworkVideoTransmitter/i.test(types)) continue;
    const xaddrs = xmlTagText(body, 'XAddrs');
    const xaddr = (xaddrs || '').trim().split(/\s+/).find(u => /^https?:\/\//i.test(u)) || '';
    if (!xaddr) continue;
    let ip = ''; try { ip = new URL(xaddr).hostname; } catch {}
    out.push({ xaddr, ip: ip || rinfo.address, name: parseScopeName(xmlTagText(body, 'Scopes')), types });
  }
  return out;
}
// 逐网卡取 IPv4 /24 网段（组播探针 + 单播兜底扫描）
function localNets() {
  const out = [];
  try {
    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const sweep = !/^(172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(a.address);  // 跳过 docker/链路本地
        out.push({ ip: a.address, base: a.address.replace(/\d+$/, ''), sweep });
      }
    }
  } catch {}
  return out;
}
function onvifDiscover(timeoutMs = 6000) {
  return new Promise(resolve => {
    const found = new Map();
    let done = false;
    const socks = [];
    const probe = Buffer.from(wsProbeXml());
    const finish = () => { if (done) return; done = true; for (const s of socks) { try { s.close(); } catch {} } resolve([...found.values()]); };
    const onMsg = (msg, rinfo) => {
      let s; try { s = msg.toString('utf8'); } catch { return; }
      if (!/NetworkVideoTransmitter|XAddrs/i.test(s)) return;
      for (const it of parseWsDiscovery(s, rinfo)) if (!found.has(it.xaddr)) found.set(it.xaddr, it);
    };
    const nets = localNets();
    if (!nets.length) { setTimeout(finish, 200); return; }
    for (const n of nets) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(s);
      s.on('error', () => {});
      s.on('message', onMsg);
      s.bind(0, n.ip, () => {
        try { s.setMulticastInterface(n.ip); } catch {}
        try { s.addMembership(WS_ADDR, n.ip); } catch {}
        try { s.setBroadcast(true); s.setMulticastTTL(4); } catch {}
        const fire = () => { try { s.send(probe, WS_PORT, WS_ADDR, () => {}); } catch {} };
        fire(); setTimeout(fire, 1000); setTimeout(fire, 2500);
        // 单播兜底：组播被交换机/AP 拦掉时，同网段逐个地址探一遍（254 包，很轻）
        if (n.sweep) for (let i = 1; i < 255; i++) {
          const target = n.base + i;
          if (target === n.ip) continue;
          setTimeout(() => { try { s.send(probe, WS_PORT, target, () => {}); } catch {} }, 120 + (i % 64) * 5);
        }
      });
    }
    setTimeout(finish, timeoutMs);
  });
}
const xmlEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function wsseHeader(user, pass) {
  const nonceRaw = crypto.randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonceRaw, Buffer.from(created, 'utf8'), Buffer.from(pass || '', 'utf8')]))
    .digest('base64');
  return `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${xmlEsc(user)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceRaw.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}
async function onvifSoap(url, action, bodyInner, user, pass) {
  const env = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${wsseHeader(user, pass)}<s:Body>${bodyInner}</s:Body></s:Envelope>`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'SOAPAction': action }, body: env, signal: ctl.signal });
    const text = await resp.text();
    return { status: resp.status, text };
  } catch (e) {
    throw Object.assign(new Error(e && e.name === 'AbortError' ? 'ONVIF 请求超时' : 'ONVIF 网络错误：' + (e && e.message)), { net: true });
  } finally { clearTimeout(to); }
}
function soapFaultMessage(text) {
  const m = /<(?:[A-Za-z0-9_]+:)?(?:Text|Reason)[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?(?:Text|Reason)>/.exec(text);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
}
function soapAuthFail(text, status) {
  if (status === 401 || status === 403) return true;
  if (/NotAuthorized|FailedAuthentication|access is denied|InvalidSecurity|BadPassword|Failed to authenticate|用户名或密码/i.test(text)) return true;
  return false;
}
const authErr = () => Object.assign(new Error('ONVIF 认证失败：用户名或密码不对'), { auth: true });
// 海康等相机密码错误次数超限后会临时锁定（默认 7 次 / 锁 30 分钟），要给出可操作的提示
const soapLocked = text => /locked because of entering wrong|temporarily locked|is locked[^.]*wrong|锁定/i.test(String(text || ''));
const lockErr = () => Object.assign(new Error('ONVIF 账号被临时锁定'), { locked: true });
function throwSoapAuth(r) {
  if (soapLocked(r.text)) throw lockErr();
  if (soapAuthFail(r.text, r.status)) throw authErr();
}
async function onvifGetDeviceInfo(xaddr, user, pass) {
  const r = await onvifSoap(xaddr, 'http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation',
    '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>', user, pass);
  throwSoapAuth(r);
  if (r.status === 404 || !/<(?:[A-Za-z0-9_]+:)?(?:Envelope|GetDeviceInformationResponse)/i.test(r.text)) {
    throw Object.assign(new Error('该设备未开启 ONVIF（或地址不对）：HTTP ' + r.status), { noOnvif: true });
  }
  const fault = soapFaultMessage(r.text); if (fault) throw new Error(fault);
  return { manufacturer: xmlTagText(r.text, 'Manufacturer'), model: xmlTagText(r.text, 'Model'),
    firmwareVersion: xmlTagText(r.text, 'FirmwareVersion'), serialNumber: xmlTagText(r.text, 'SerialNumber'),
    hardwareId: xmlTagText(r.text, 'HardwareId') };
}
async function onvifMediaAddr(xaddr, user, pass) {
  const r = await onvifSoap(xaddr, 'http://www.onvif.org/ver10/device/wsdl/GetCapabilities',
    '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>', user, pass);
  const mediaBlock = xmlTagBody(r.text, 'Media');
  if (mediaBlock) { const x = xmlTagText(mediaBlock, 'XAddr'); if (/^https?:\/\//i.test(x)) return x; }
  return xaddr.replace(/device_service$/i, 'media_service');
}
async function onvifGetProfiles(mediaAddr, user, pass) {
  const r = await onvifSoap(mediaAddr, 'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
    '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>', user, pass);
  throwSoapAuth(r);
  const fault = soapFaultMessage(r.text); if (fault) throw new Error(fault);
  const out = [];
  const re = /<[^>]*Profiles[^>]*token="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*Profiles>/g;
  let m;
  while ((m = re.exec(r.text))) {
    const token = m[1], body = m[2];
    const resBlock = xmlTagBody(body, 'Resolution');
    const w = /<[^>]*\bWidth\b[^>]*>(\d+)/.exec(resBlock);
    const h = /<[^>]*\bHeight\b[^>]*>(\d+)/.exec(resBlock);
    const width = w ? +w[1] : 0, height = h ? +h[1] : 0;
    out.push({ token, name: xmlTagText(body, 'Name'), width, height, resolution: width && height ? `${width}×${height}` : '' });
  }
  return out;
}
async function onvifGetStreamUri(mediaAddr, user, pass, token) {
  const body = `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${xmlEsc(token)}</ProfileToken></GetStreamUri>`;
  const r = await onvifSoap(mediaAddr, 'http://www.onvif.org/ver10/media/wsdl/GetStreamUri', body, user, pass);
  throwSoapAuth(r);
  const fault = soapFaultMessage(r.text); if (fault) throw new Error(fault);
  return xmlTagText(r.text, 'Uri');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };
// 鉴权规则：
//  · 统一网关（Unix Socket）转发来的请求 —— 网关已校验飞牛登录态，直接放行（socket 由文件权限保护）
//  · TCP（本机/局域网）—— 设了口令走 Basic；未设口令时只允许本机回环访问
// Docker 版默认账号口令均为 admin（开箱即用）；用户可在设置页自行修改，改完写入配置、重启不丢。
const isDefaultPass = () => !!(cfg.http && cfg.http.pass === 'admin');
function authed(req, viaSock) {
  if (viaSock) return true;
  if (cfg.http.pass) {
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!m) return false;
    const raw = Buffer.from(m[1], 'base64').toString();
    const i = raw.indexOf(':');
    return i > 0 && raw.slice(0, i) === cfg.http.user && raw.slice(i + 1) === cfg.http.pass;
  }
  const ra = String((req.socket && req.socket.remoteAddress) || '');
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}
function sendFile(req, res, fp) {
  let st; try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end('not found'); }
  const H = { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  const onErr = e => { log('[sendFile] 读取失败', fp, e.message); try { if (!res.headersSent) res.writeHead(500); res.destroy(); } catch {} };
  const m = range && range.match(/bytes=(\d*)-(\d*)/);
  let start = m && m[1] ? +m[1] : 0, end = m && m[2] ? +m[2] : st.size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
  if (m && start <= end) {                                   // 合法区间 → 206
    H['Content-Range'] = `bytes ${start}-${end}/${st.size}`; H['Content-Length'] = end - start + 1;
    res.writeHead(206, H); fs.createReadStream(fp, { start, end }).on('error', onErr).pipe(res);
  } else {                                                   // 非法/无 Range → 200 全量
    H['Content-Length'] = st.size; res.writeHead(200, H); fs.createReadStream(fp).on('error', onErr).pipe(res);
  }
}
const BODY_LIMIT = 1024 * 1024;                                  // 请求体上限 1MB
function readBody(req, limit) {
  const lim = limit || BODY_LIMIT;
  return new Promise((res, rej) => {
    let b = '', n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > lim) { try { req.pause(); } catch {} rej(new Error('request body too large')); return; }
      b += d;
    });
    req.on('end', () => res(b));
    req.on('error', e => rej(e));
  });
}

function camBrief(cam) {
  const s = cs(cam);
  const m = s.motion;
  return { id: cam.id, name: cam.name, dir: cam.dir, configured: camConfigured(cam),
    previewStream: cam.rtspSub ? cam.previewStream : 'main', brand: cam.brand, hasSub: !!cam.rtspSub,
    recAlive: !!s.mainProc, liveAlive: !!s.mainProc, ringAlive: !!s.mainProc, motionAlive: !!s.motionProc,
    codec: s.codec || '', h265: !!s.h265,
    motion: { active: m.eventActive, lastMotionTs: m.lastMotionTs, lastScore: m.lastScore, eventCount: m.eventCount },
    live: `/live/${cam.id}/index.m3u8` };
}
// 并发受限的 map：列表接口原先是一条条串行 stat + 读 moov，录像多时（几百条以上）在机械盘上会明显变慢
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}
async function listRecordings(camDirFilter) {
  const files = await walkMp4(cfg.record.root);
  const rows = await mapLimit(files, 8, async fp => {
    const name = path.basename(fp), t = parseRecMs(name); if (t === null) return null;
    const rel = path.relative(cfg.record.root, fp).split(path.sep).join('/');
    const seg = rel.split('/');
    const camDir = seg.length > 1 ? seg[0] : '';
    if (camDirFilter && camDir !== camDirFilter) return null;
    const st = await fsp.stat(fp).catch(() => null); if (!st) return null;
    const complete = await fileComplete(fp, st);
    return { name, rel, cam: camDir, dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      start: t, size: st.size, event: /-E\.mp4$/.test(name), complete };
  });
  const out = rows.filter(Boolean);
  out.sort((a, b) => b.start - a.start); return out;
}

// 容器里探不到 NAS 的局域网 IP；用户第一次用浏览器打开时，用 Host 头把"真实访问地址"打进日志（只打一次）
const seenHosts = new Set();
function noteAccessHost(req) {
  const h = String(req.headers.host || '');
  if (!DOCKER || !h || seenHosts.has(h) || seenHosts.size >= 10) return;
  seenHosts.add(h);
  const rip = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  log(`[http] 访问地址 http://${h}${rip && rip !== '::1' && rip !== '127.0.0.1' ? `（来自 ${rip}）` : ''}`);
}
const handler = async (req, res, viaSock) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  noteAccessHost(req);
  if (PREFIX && (p === PREFIX || p.startsWith(PREFIX + '/'))) {
    p = p.slice(PREFIX.length) || '/';
    if (u.pathname === PREFIX) { res.writeHead(302, { Location: PREFIX + '/' + (u.search || '') }); return res.end(); }
  }
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }   // 免登录存活探针（供容器健康检查）
  if (!authed(req, viaSock)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="nvr"' });
    return res.end('auth required：未设口令时仅允许本机访问；局域网访问请在 config.json 设置 http.pass');
  }
  try {
    if (p === '/api/status') {
      return json(res, {
        cameras: cfg.cameras.map(camBrief),
        configured: cfg.cameras.some(camConfigured),
        enabled: cfg.record.enabled,
        docker: DOCKER,
        defaultPass: isDefaultPass(), httpUser: cfg.http.user || '',
        retentionDays: cfg.record.retentionDays, segmentSeconds: cfg.record.segmentSeconds,
        recordRoot: cfg.record.root, disk: diskInfo(), diskLow: diskLow(), res: { cpu: RES.cpu, mem: RES.mem }, serverTime: Date.now(),
        version: APPVER
      });
    }
    if (p === '/api/motion') {
      const id = u.searchParams.get('cam');
      const cam = cfg.cameras.find(c => c.id === id) || cfg.cameras[0];
      if (!cam) return json(res, {});
      const m = cs(cam).motion;
      let ring = 0; try { ring = (await fsp.readdir(ringDirOf(cam))).filter(f => f.endsWith('.ts')).length; } catch {}
      return json(res, { active: m.eventActive, lastMotionTs: m.lastMotionTs, lastScore: m.lastScore,
        eventCount: m.eventCount, frames: m.frames, ring });
    }
    if (p === '/api/diag') { log('[diag]', decodeURIComponent(u.search.slice(1)).slice(0, 120)); return json(res, { ok: true }); }
    if (p === '/api/list') { const cam = u.searchParams.get('cam'); return json(res, await listRecordings(cam || null)); }
    if (p === '/api/snap') {
      const id = u.searchParams.get('cam');
      const cam = cfg.cameras.find(c => c.id === id) || cfg.cameras[0];
      const w = Math.max(0, Math.min(3840, +u.searchParams.get('w') || 0));
      const sub = u.searchParams.get('sub') === '1';
      // 限流：同一路缩略图 1.5 秒内只生成一次，避免被高频请求反复起 ffmpeg
      if (cam && w) {
        const tp = path.join(SNAP_ROOT, `thumb-${cam.id}.jpg`);
        try { const st = fs.statSync(tp); if (Date.now() - st.mtimeMs < 1500) return sendFile(req, res, tp); } catch {}
      }
      const s = cam ? await snapshotShared(cam, { w, sub }) : null;
      if (!s) { res.writeHead(503); return res.end('no snap'); }
      return sendFile(req, res, s);
    }
    // ---- 目录浏览 ----
    if (p === '/api/browse') {
      const dir = u.searchParams.get('path');
      if (!dir) return json(res, { roots: volumes(), suggest: suggestRoot(req.headers['x-trim-userid']) });
      return json(res, await browse(dir));
    }
    if (p === '/api/mkdir' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const name = String(body.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
      const parent = body.parent;
      if (!name || !parent) { status(res, 400); return json(res, { ok: false, error: '名字不能为空' }); }
      const full = path.normalize(path.join(parent, name));
      if (!insideVolume(full)) { status(res, 400); return json(res, { ok: false, error: '路径不在存储空间内' }); }
      try { fs.mkdirSync(full, { recursive: true }); return json(res, { ok: true, path: full }); }
      catch (e) { status(res, 500); return json(res, { ok: false, error: e.message }); }
    }
    // ---- 修改访问口令（需已登录 + 校验当前密码）----
    if (p === '/api/setpass' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const cur = String(body.current ?? ''), np = String(body.newPass ?? ''), np2 = String(body.newPass2 ?? body.newPass ?? '');
      if (!cfg.http.pass) { status(res, 400); return json(res, { ok: false, error: '当前未启用访问口令' }); }
      if (cur !== cfg.http.pass) { status(res, 403); return json(res, { ok: false, error: '当前密码不正确' }); }
      if (np.length < 4) { status(res, 400); return json(res, { ok: false, error: '新密码至少 4 位' }); }
      if (np !== np2) { status(res, 400); return json(res, { ok: false, error: '两次输入的新密码不一致' }); }
      if (np === cfg.http.pass) { return json(res, { ok: true, unchanged: true }); }
      cfg.http.pass = np;
      writeCfg();
      log('[sec] 访问口令已更新（下次请求需用新口令）');
      return json(res, { ok: true });
    }
    if (p === '/api/config') {
      if (req.method === 'GET') {
        const c = JSON.parse(JSON.stringify(cfg));
        const hasPass = {};
        for (const cam of c.cameras) {
          hasPass[cam.id] = !!cam.pass; cam.pass = '';
          if (cam.brand !== 'custom') { cam.rtspMain = ''; cam.rtspSub = ''; }
        }
        return json(res, { config: c, hasPass, configured: cfg.cameras.some(camConfigured), enabled: cfg.record.enabled,
          docker: DOCKER, defaultPass: isDefaultPass(), httpUser: cfg.http.user || '',
          volumes: volumes(), suggest: suggestRoot(req.headers['x-trim-userid']) });
      }
      if (req.method === 'PUT') {
        let body; try { body = JSON.parse(await readBody(req)); }
        catch (e) { status(res, /too large/.test(e.message) ? 413 : 400); res.__bad = true; return json(res, { ok: false, error: /too large/.test(e.message) ? '请求体过大' : 'bad json' }); }
        const sig = () => cfg.cameras.map(cam => [cam.id, cam.ip, cam.port, cam.user, cam.pass, cam.channel, cam.previewStream, cam.brand, cam.rtspMain, cam.rtspSub].join(':')).join('|')
                       + '#' + [cfg.record.root, cfg.record.segmentSeconds].join('|');
        const before = sig();
        if (Array.isArray(body.cameras)) {
          const old = new Map(cfg.cameras.map(c => [c.id, c]));
          // ★ 先校验自定义 RTSP 字段，非法直接 400（避免半更新）
          for (const inp of body.cameras.slice(0, MAX_CAMS)) {
            const b = BRANDS.includes(inp.brand) ? inp.brand : 'hik';
            if (b !== 'custom') continue;
            const main = String(inp.rtspMain || '').trim();
            if (!main) { status(res, 400); return json(res, { ok: false, error: '自定义 RTSP：主码流地址必填' }); }
            if (!/^rtsp:\/\/\S+$/i.test(main)) { status(res, 400); return json(res, { ok: false, error: '自定义 RTSP：主码流地址必须以 rtsp:// 开头，且不能含空格/换行' }); }
            const sub = String(inp.rtspSub || '').trim();
            if (sub && !/^rtsp:\/\/\S+$/i.test(sub)) { status(res, 400); return json(res, { ok: false, error: '自定义 RTSP：子码流地址必须以 rtsp:// 开头，且不能含空格/换行' }); }
          }
          cfg.cameras = body.cameras.slice(0, MAX_CAMS).map(inp => {
            const prev = old.get(inp.id) || {};
            const cam = newCamera({ ...prev, id: inp.id && old.has(inp.id) ? inp.id : (inp.id || camIdGen()) });
            for (const k of ['name', 'ip', 'user']) if (inp[k] !== undefined) cam[k] = String(inp[k]).trim();
            if (inp.pass) cam.pass = String(inp.pass);          // 空 = 保持原密码
            cam.port = Math.max(1, parseInt(inp.port) || 554);
            cam.channel = Math.max(1, parseInt(inp.channel) || 1);
            cam.previewStream = inp.previewStream === 'sub' ? 'sub' : 'main';
            cam.brand = BRANDS.includes(inp.brand) ? inp.brand : 'hik';
            if (cam.brand === 'custom') {
              cam.rtspMain = String(inp.rtspMain || '').trim();
              cam.rtspSub = String(inp.rtspSub || '').trim();
            } else { cam.rtspMain = ''; cam.rtspSub = ''; }
            return cam;
          });
          for (const id of [...state.cams.keys()]) if (!cfg.cameras.some(c => c.id === id)) {
            killByCamRef(id);                                  // ★ 必须真正停流：否则旧管线会一直占着摄像头的并发会话额度
            state.cams.delete(id);                             // 回收已删除摄像机的状态
          }
        }
        const rec = body.record || {};
        if (rec.retentionDays !== undefined) cfg.record.retentionDays = Math.min(365, Math.max(1, parseInt(rec.retentionDays) || 3));
        if (rec.segmentSeconds !== undefined) cfg.record.segmentSeconds = Math.min(3600, Math.max(60, parseInt(rec.segmentSeconds) || 300));
        if (rec.root) {
          const nr = path.normalize(String(rec.root).trim());
          if (!insideVolume(nr)) { status(res, 400); return json(res, { ok: false, error: '保存目录必须在存储空间（/vol1、/vol2…）内' }); }
          try { fs.mkdirSync(nr, { recursive: true }); fs.accessSync(nr, fs.constants.W_OK); cfg.record.root = nr; }
          catch { status(res, 400); return json(res, { ok: false, error: '该目录不可写，请换一个' }); }
        }
        if (rec.enabled !== undefined) cfg.record.enabled = !!rec.enabled;
        applyCameraUrls(cfg);
        refreshPaths();
        fixHosts();
        writeCfg();
        const changed = before !== sig();
        let liveReady = true;
        if (changed) { restartPipeline(); liveReady = await waitLiveReady(6000); }
        return json(res, { ok: true, configured: cfg.cameras.some(camConfigured), enabled: cfg.record.enabled,
          restarted: changed, liveReady, cameras: cfg.cameras.map(camBrief) });
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    if (p === '/api/test') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const prev = body.id ? cfg.cameras.find(c => c.id === body.id) : null;
      const cam = Object.assign({}, prev || {}, body.camera || {});
      if (!cam.pass && prev) cam.pass = prev.pass;
      cam.brand = BRANDS.includes(cam.brand) ? cam.brand : 'hik';
      if (!cam.ip) { status(res, 400); return json(res, { ok: false, error: '未填写摄像机 IP' }); }
      const u = computeUrls(cam);
      const main = u.rtspMain ? await probeStream(u.rtspMain) : { ok: false, error: '无主码流地址' };
      const sub = u.rtspSub ? await probeStream(u.rtspSub) : { ok: false, error: '未配置子码流' };
      const h265 = (main.h265 || sub.h265) || false;
      // 把测试结果记进该摄像机状态 → 直播页也能直接给出 H.265 引导（不用等下次启动探测）
      if (prev) { const st = cs(prev); if (main.ok || sub.ok) { st.codec = (main.ok && main.codec) || (sub.ok && sub.codec) || ''; st.h265 = h265; st.codecAt = Date.now(); } }
      return json(res, { ok: !!(main.ok || sub.ok), main, sub, h265,
        advice: h265 ? '该码流为 H.265，手机/浏览器无法直接播放。请到摄像头后台「配置 → 视音频 → 视频」把编码改为 H.264（建议主、子码流都改），保存后再回来测试。' : '' });
    }
    // ---- ONVIF 自动发现 + 取流 ----
    if (p === '/api/onvif/discover' && req.method === 'POST') {
      let devices = [];
      try { devices = await onvifDiscover(); } catch (e) { log('[onvif] 发现失败', e.message); }
      return json(res, { ok: true, devices });
    }
    if (p === '/api/onvif/profiles' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const xaddr = String(body.xaddr || '').trim();
      if (!xaddr) { status(res, 400); return json(res, { ok: false, error: '缺少设备地址 xaddr' }); }
      // 密码留空时：若带 id 则回退到该摄像机已保存的账号密码（避免重复输入）
      const stored = body.id ? (cfg.cameras.find(c => c.id === body.id) || {}) : {};
      const user = String(body.user || stored.user || '');
      const pass = String(body.pass || stored.pass || '');
      if (!user || !pass) { status(res, 400); return json(res, { ok: false, error: '请先填写该摄像机的用户名和密码（ONVIF 取流需要认证）' }); }
      try {
        const info = await onvifGetDeviceInfo(xaddr, user, pass);
        const mediaAddr = await onvifMediaAddr(xaddr, user, pass);
        const profs = await onvifGetProfiles(mediaAddr, user, pass);
        const streams = [];
        for (const pf of profs) {
          try {
            const uri = await onvifGetStreamUri(mediaAddr, user, pass, pf.token);
            streams.push({ name: pf.name, token: pf.token, uri, resolution: pf.resolution, width: pf.width, height: pf.height });
          } catch (e) { streams.push({ name: pf.name, token: pf.token, uri: '', resolution: pf.resolution, error: e.message }); }
        }
        return json(res, { ok: true, info, profiles: streams });
      } catch (e) {
        log('[onvif] profiles 失败', redact(e.message || ''));
        if (e && e.auth) { status(res, 401); return json(res, { ok: false, error: 'ONVIF 认证失败：用户名或密码不对' }); }
        if (e && e.locked) { status(res, 423); return json(res, { ok: false, locked: true, error: '摄像机的 ONVIF 账号被临时锁定（密码错误次数过多），请等 30 分钟后再试；或到摄像机后台「配置 → 系统 → 安全管理 → 非法登录」里解锁（可把锁定次数放宽）。' }); }
        status(res, 400); return json(res, { ok: false, error: 'ONVIF 取流失败：' + (e.message || '未知错误') });
      }
    }
    // ---- 直播（每台一路） ----
    if (p === '/live/index.m3u8' || p.startsWith('/live/')) {
      const rest = p.slice(6).replace(/^\//, '');
      let camId = null, file = rest;
      if (rest.includes('/')) { const seg = rest.split('/'); camId = seg[0]; file = seg.slice(1).join('/'); }
      const cam = camId ? cfg.cameras.find(c => c.id === camId)
                        : (cfg.cameras.find(camConfigured) || cfg.cameras[0]);
      if (!cam) { res.writeHead(404); return res.end('no camera'); }
      return sendFile(req, res, path.join(liveDirOf(cam), path.basename(file)));
    }
    if (p.startsWith('/rec/')) {
      const rel = decodeURIComponent(p.slice(5));
      const fp = path.normalize(path.join(cfg.record.root, rel));
      if (fp !== cfg.record.root && !fp.startsWith(cfg.record.root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
      return sendFile(req, res, fp);
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    if (['/', '/index.html', '/app.js', '/sw.js', '/settings.html'].includes(p)) {
      log('[req]', p, '|dest=' + (req.headers['sec-fetch-dest'] || '-'),
        '|ua=' + String(req.headers['user-agent'] || '-').slice(0, 34),
        '|ref=' + String(req.headers['referer'] || '-').slice(0, 60));
    }
    const fp = path.join(PUB, rel);
    if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
    if (fs.existsSync(fp)) return sendFile(req, res, fp);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('[http] error', e.message);
    try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('err: ' + e.message); }
    catch (e2) { log('[http] error(2)', e2.message); try { res.destroy(); } catch {} }
  }
};
function status(res, code) { res.__code = code; }
function json(res, o, code) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(code || res.__code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o));
}
const DISK_MIN_FREE = 500 * 1024 * 1024;             // 录像盘剩余 < 500MB 时暂停录像，等清理后自动恢复
function diskFree() { try { const s = fs.statfsSync(cfg.record.root); return s.bavail * s.bsize; } catch { return null; } }
function diskLow() { const f = diskFree(); return f !== null && f < DISK_MIN_FREE; }
let diskPaused = false;
function diskInfo() {
  try { const s = fs.statfsSync(cfg.record.root); const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, usedRatio: 1 - free / total, path: cfg.record.root }; } catch { return null; }
}
// ---- 进程资源采样 ----
const RES = { cpu: 0, mem: 0 };
let resPrev = null;
function _jiffies(pid) { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.lastIndexOf(')'); const a = s.slice(r + 2).split(' '); return (+a[11]) + (+a[12]); } catch { return null; } }
function _rss(pid) { try { const m = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' '); return (+m[1]) * 4096; } catch { return 0; } }
function _kids(pid) { try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } }
function sampleRes() {
  const pids = [process.pid, ..._kids(process.pid)];
  let j = 0, rss = 0;
  for (const p of pids) { const x = _jiffies(p); if (x != null) j += x; rss += _rss(p); }
  const now = Date.now();
  if (resPrev) { const dt = (now - resPrev.t) / 1000; if (dt > 0) RES.cpu = Math.max(0, ((j - resPrev.j) / 100 / dt) * 100); }
  resPrev = { t: now, j }; RES.mem = rss;
}
sampleRes(); setInterval(sampleRes, 5000);

function resolveCert() {
  try {
    const base = cfg.https?.certDir; if (!base) return null;
    const cands = [];
    for (const sub of fs.readdirSync(base)) {
      const fc = path.join(base, sub, 'fullchain.crt');
      if (!fs.existsSync(fc)) continue;
      const key = fs.readdirSync(path.join(base, sub)).find(f => f.endsWith('.key'));
      if (key) cands.push([fs.statSync(fc).mtimeMs, fc, path.join(base, sub, key)]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    return cands[0] ? [cands[0][1], cands[0][2]] : null;
  } catch { return null; }
}
const httpServer = http.createServer(handler);
const servers = [httpServer];
const SOCK = process.env.NVR_SOCK || '';
if (SOCK) {
  try { fs.unlinkSync(SOCK); } catch {}
  const sockServer = http.createServer((req, res) => handler(req, res, true));   // viaSock：仅网关可走信任分支
  sockServer.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o666); } catch {}
    log('[main] unix socket', SOCK, 'prefix', PREFIX);
  });
  sockServer.on('error', e => log('[sock] 启动失败', e.message));
  servers.push(sockServer);
}
let httpsServer = null;
if (cfg.https && cfg.https.enabled) {
  try {
    const c = resolveCert();
    if (c) { httpsServer = https.createServer({ cert: fs.readFileSync(c[0]), key: fs.readFileSync(c[1]) }, handler);
      servers.push(httpsServer); log('[https] 证书', c[0]); }
    else log('[https] 未找到可用证书');
  } catch (e) { log('[https] 启动失败', e.message); }
}
function shutdown() {
  shuttingDown = true; log('[main] 退出中…');
  for (const s of state.cams.values()) { killP(s.mainProc); killP(s.motionProc); }
  servers.forEach(s => s.close(() => {}));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

reapOrphans();
reapStale();
setInterval(() => { reapOrphans(); reapStale(); }, 60000);
pruneSnaps();
setInterval(pruneSnaps, 3600000);
migrateNames();
startAll();
function lanIPv4() {
  const out = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (!a || a.family !== 'IPv4' || a.internal) continue;
        const ip = a.address;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) continue;   // Docker 默认网段：容器自己的 IP，打印出来只会误导用户
        if (/^169\.254\./.test(ip)) continue;                  // 保留地址
        out.push(ip);
      }
    }
  } catch {}
  return out;
}
// 启动后打印一段人话信息：访问地址（本机真实 IP，不是 0.0.0.0）+ 用户名 + 当前口令
function announceAccess() {
  if (!DOCKER) return;
  const port = cfg.http.port;
  const ips = lanIPv4();
  const urls = ips.length ? ips.map(i => `http://${i}:${port}`).join('  ·  ') : `http://<这台NAS的IP>:${port}`;
  const user = cfg.http.user || 'admin', pass = cfg.http.pass || '';
  log('==============================================================');
  log(` 飞海监控 已启动    访问地址：${urls}`);
  if (pass) {
    log(` 用户名：${user}    密码：${pass}${isDefaultPass() ? '   ← 默认口令，建议在「设置 → 🔑 访问口令」里改掉' : ''}`);
    if (!isDefaultPass()) log(' （已经是你自己改过的口令；忘了就加 -e NVR_HTTP_PASS=新密码 重建容器）');
  } else {
    log(' 未设置访问口令（仅限本机访问）；局域网访问请设 NVR_HTTP_PASS');
  }
  log('==============================================================');
  if (!ips.length) log(' （容器看不到 NAS 的局域网 IP，用你 NAS 的地址访问即可；打开网页后这里会打印真实地址）');
}

httpServer.on('error', e => log('[http] 监听失败', e.message));
httpServer.listen(cfg.http.port, cfg.http.host, () => { log(`[main] http://${cfg.http.host}:${cfg.http.port}  cameras=${cfg.cameras.length}  rec=${cfg.record.root}`); announceAccess(); });
if (httpsServer) httpsServer.listen(cfg.https.port, cfg.https.host || '0.0.0.0', () =>
  log(`[main] https://${cfg.https.host || '0.0.0.0'}:${cfg.https.port}`));
