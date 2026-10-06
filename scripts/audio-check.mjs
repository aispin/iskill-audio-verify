#!/usr/bin/env node
/**
 * audio-check.mjs — 证明「网页真的出声了」，而不是「音频节点被启动了」。
 *
 * 用法：
 *   node audio-check.mjs <url> [--wait 7000] [--gesture] [--no-gesture] [--json]
 *
 *   <url>            页面地址。dev server 常见 http://localhost:5173/
 *   --wait <ms>      首次交互前的等待（默认 7000）。要够长，让首屏 + 首帧 reload 跑完
 *   --gesture        在等待后模拟一次点击解锁音频（默认开）
 *   --no-gesture     跳过模拟点击（只做「手势前」那批断言）
 *   --json           以 JSON 输出，便于上层脚本消费
 *
 * 环境变量：
 *   CHROME_PATH      覆盖 Chrome 可执行文件路径（缺省自动在 ~/.cache/puppeteer 下找）
 *   PUPPETEER_PATH   覆盖 puppeteer-core 的入口 .js 路径
 *
 * ---------------------------------------------------------------
 * 它在页面里装了一个工具箱 window.__audioVerify，供你写项目专属断言：
 *
 *   __audioVerify.measure(ms, skipMs)  同步自旋采样 ms 毫秒，返回所有 AudioContext
 *                                      里 destination 旁路的最大 RMS（跳过前 skipMs，
 *                                      用于避开淡入/淡出过渡）
 *   __audioVerify.stats()              { contexts, probes, sources:{started,stopped,live},
 *                                        gestureSeen, warnedNoGesture }
 *   __audioVerify.mark()               记一个时间点，之后可用 stats() 算增量
 *   __audioVerify.probes               AnalyserNode 数组（每个 AudioContext 一个）
 *
 * 例子（在你自己的 puppeteer 脚本里）：
 *   await page.evaluate(() => window.__audioVerify.measure(600))
 *
 * 为什么需要「同步自旋」而不是 await sleep：音频图在独立线程渲染，但主线程在无头
 * 环境里会被 3D/大页面严重拖住，setTimeout 实测 900ms 只跑到 2 帧 —— 采不到东西。
 * 自旋不受节流影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/* ============================================================
 * 依赖发现：让这个脚本在别人的机器上也能跑
 * ============================================================ */

function findPuppeteer() {
  const cands = [
    process.env.PUPPETEER_PATH,
    path.join(os.homedir(), '.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
    path.join(os.homedir(), '.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer/lib/puppeteer/puppeteer.js'),
    'puppeteer-core', 'puppeteer',
  ].filter(Boolean)
  for (const c of cands) {
    if (!c.startsWith('/')) return c            // 交给 node 的模块解析
    if (fs.existsSync(c)) return c
  }
  throw new Error('找不到 puppeteer。请 npm i -D puppeteer 或设 PUPPETEER_PATH')
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const root = path.join(os.homedir(), '.cache/puppeteer')
  const want = ['chrome-headless-shell', 'chrome']
  for (const kind of want) {
    const base = path.join(root, kind)
    if (!fs.existsSync(base)) continue
    // 版本目录名带平台后缀，逐个探
    for (const ver of fs.readdirSync(base)) {
      const inner = path.join(base, ver)
      if (!fs.statSync(inner).isDirectory()) continue
      for (const sub of fs.readdirSync(inner)) {
        for (const exe of ['chrome-headless-shell', 'Google Chrome for Testing', 'chrome']) {
          const p = path.join(inner, sub, exe)
          if (fs.existsSync(p)) return p
        }
      }
    }
  }
  return undefined   // 交给 puppeteer 自己的缓存发现
}

/* ============================================================
 * CLI
 * ============================================================ */

const argv = process.argv.slice(2)
const url = argv.find((a) => !a.startsWith('--')) || 'http://localhost:5173/'
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? dflt : (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : true)
}
const waitMs = Number(flag('wait', 7000))
const doGesture = !argv.includes('--no-gesture')
const asJson = argv.includes('--json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '')
const AUDIO_RE = /\.(ogg|mp3|wav|m4a|aac|opus|webm|flac)(\?|$)/i

const { default: puppeteer } = await import(findPuppeteer())

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'shell',
  protocolTimeout: 300000,
  args: [
    '--no-sandbox',
    // 关键：模拟真实用户的自动播放策略。这样「无手势就建 AudioContext」会真的暴露出来。
    // 想让音频在无头下无条件出声，改成 --autoplay-policy=no-user-gesture-required，
    // 但那会掩盖掉真实用户会遇到的拦截 —— 见 SKILL.md「两种 autoplay flag」。
    '--autoplay-policy=document-user-activation-required',
    '--hide-scrollbars', '--disable-dev-shm-usage',
  ],
  defaultViewport: { width: 1600, height: 900 },
})

const page = await browser.newPage()

/* ============================================================
 * 页面侧工具箱：必须在任何应用代码之前装好
 * ============================================================ */

await page.evaluateOnNewDocument(() => {
  const log = { contexts: [], gestureSeen: false, warnedNoGesture: false }
  const probes = []
  const sources = { started: 0, stopped: 0, live: new Set() }
  const t0 = performance.now()

  window.__audioVerify = {
    log, probes, sources, mark: () => ({ t: Math.round(performance.now() - t0), ...sources, started: sources.started, stopped: sources.stopped }),
    stats: () => ({
      contexts: log.contexts.length,
      contextStates: log.contexts.map((c) => c.state),
      probes: probes.length,
      gestureSeen: log.gestureSeen,
      warnedNoGesture: log.warnedNoGesture,
      sources: { started: sources.started, stopped: sources.stopped, live: sources.live.size },
    }),
    /** 同步自旋采样，返回所有探针里的最大 RMS。skipMs 用于跳过淡入/淡出过渡。 */
    measure: (ms = 600, skipMs = 0) => {
      if (!probes.length) return null
      const bufs = probes.map((p) => new Float32Array(p.fftSize))
      const spin = (dur) => {
        let max = 0
        const w = performance.now()
        while (performance.now() - w < dur) {
          for (let k = 0; k < probes.length; k++) {
            const b = bufs[k]
            probes[k].getFloatTimeDomainData(b)
            let s = 0
            for (let i = 0; i < b.length; i++) s += b[i] * b[i]
            const r = Math.sqrt(s / b.length)
            if (r > max) max = r
          }
        }
        return +max.toFixed(6)
      }
      if (skipMs) spin(skipMs)
      return spin(ms)
    },
  }

  // ---- 手势标记：只认能带来 user activation 的事件 ----
  // wheel / scroll 不算 activation，加进来会误判「已解锁」。
  const GESTURES = ['pointerdown', 'touchstart', 'keydown']
  const onGesture = () => { log.gestureSeen = true; GESTURES.forEach((e) => window.removeEventListener(e, onGesture)) }
  GESTURES.forEach((e) => window.addEventListener(e, onGesture, { passive: true }))

  // ---- 捕获「无手势就建 AudioContext」的警告（这是真实用户会遇到的 bug）----
  const origWarn = console.warn
  console.warn = function (...a) {
    try { if (!log.gestureSeen && String(a[0]).includes('AudioContext was not allowed')) log.warnedNoGesture = true } catch { }
    return origWarn.apply(this, a)
  }

  // ---- 旁路探针：任何连到 ctx.destination 的节点都再分一路给 AnalyserNode ----
  // ⚠️ connect() 定义在 AudioNode.prototype 上，不是 AudioContext.prototype。
  //    挂错原型会静默失效（origConnect 变 undefined，被 catch 吞掉）。
  // ⚠️ 一个页面可能有**多个** AudioContext，所以探针要按 context 存一组；
  //    只留最后一个会被后建的顶掉，测出来全是 0。
  const origConnect = window.AudioNode.prototype.connect
  window.AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      const c = this.context
      if (c && dest === c.destination) {
        if (!c.__probe) {
          c.__probe = c.createAnalyser()
          c.__probe.fftSize = 2048
          origConnect.call(c.__probe, c.destination)   // 保证被渲染图拉取
          probes.push(c.__probe)
        }
        origConnect.call(this, c.__probe)
      }
    } catch { /* 旁路失败不影响被测代码 */ }
    return origConnect.call(this, dest, ...rest)
  }

  // ---- AudioContext 计数 ----
  const Orig = window.AudioContext || window.webkitAudioContext
  if (Orig) {
    const Wrapped = function (...a) {
      const c = new Orig(...a)
      log.contexts.push({ state: c.state, t: Math.round(performance.now() - t0), gestureSeen: log.gestureSeen })
      return c
    }
    Wrapped.prototype = Orig.prototype
    Object.setPrototypeOf(Wrapped, Orig)
    window.AudioContext = Wrapped
    window.webkitAudioContext = Wrapped
  }

  // ---- 源计数：抓「启动了但从未 stop()」的循环（音频泄漏）----
  if (window.AudioBufferSourceNode) {
    const P = window.AudioBufferSourceNode.prototype
    const oStart = P.start, oStop = P.stop
    P.start = function (...a) { sources.started++; sources.live.add(this); return oStart.apply(this, a) }
    P.stop = function (...a) { sources.stopped++; sources.live.delete(this); return oStop.apply(this, a) }
  }
})

/* ============================================================
 * Node 侧采集
 * ============================================================ */

const audioReqs = []
const httpBad = []
const consoleMsgs = []
let navs = 0
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++ })
page.on('console', (m) => { if (m.type() !== 'log') consoleMsgs.push(m.type() + ': ' + m.text()) })
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message))
page.on('request', (r) => { const u = rel(r.url()); if (AUDIO_RE.test(u)) audioReqs.push(u) })
page.on('response', (r) => { if (r.status() >= 400) httpBad.push('http' + r.status() + ' ' + rel(r.url())) })

const out = { url, waitMs, pre: {}, post: {}, probes: {}, requests: {}, notes: {} }

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(waitMs)

/* ---- 阶段 1：手势之前 ---- */
out.pre = await page.evaluate(() => window.__audioVerify.stats())
out.pre.audioRequests = [...new Set(audioReqs)]
out.pre.audio404 = httpBad.filter((x) => AUDIO_RE.test(x))
out.pre.baselineRms = await page.evaluate(() => window.__audioVerify.measure(300))

/* ---- 阶段 2：一次手势 ---- */
if (doGesture) {
  await page.mouse.click(800, 450)
  await sleep(1200)
}
out.post = await page.evaluate(() => window.__audioVerify.stats())

/* ---- 阶段 3：泄漏与静音检查 ---- */
out.probes.baseline = await page.evaluate(() => window.__audioVerify.measure(300))
out.probes.leaked = out.post.sources.live

/* ---- 阶段 4：汇总 ---- */
out.requests.all = [...new Set(audioReqs)]
out.requests.bad = httpBad
out.notes.audioContextWarnings = consoleMsgs.filter((m) => /AudioContext was not allowed/i.test(m))
out.notes.navs = navs
out.notes.console = consoleMsgs.slice(0, 20)

const fail = []
if (out.pre.contexts > 0) fail.push(`手势前就建了 ${out.pre.contexts} 个 AudioContext（真实用户会收到 autoplay 警告）`)
if (out.notes.audioContextWarnings.length) fail.push('控制台出现 "AudioContext was not allowed to start"')
if (out.pre.audio404.length) fail.push(`音频资源 404: ${out.pre.audio404.join(', ')}`)
if (doGesture && !out.post.gestureSeen) fail.push('手势没被记录（检查是否真的点在页面上）')
out.verdict = fail.length ? { pass: false, reasons: fail } : { pass: true }

if (asJson) {
  console.log(JSON.stringify(out, null, 1))
} else {
  const Y = (b) => (b ? '✓' : '✗')
  console.log(`\n=== ${url} ===`)
  console.log(`\n--- 手势之前 ---`)
  console.log(`AudioContext 创建: ${out.pre.contexts}  ${Y(out.pre.contexts === 0)}`)
  console.log(`已发出音频请求: ${out.pre.audioRequests.length ? out.pre.audioRequests.join(', ') : '(无)'}`)
  console.log(`音频 404: ${out.pre.audio404.length ? out.pre.audio404.join(', ') : '(无)'} ${Y(!out.pre.audio404.length)}`)
  console.log(`底噪 RMS: ${out.pre.baselineRms ?? '(无探针)'}`)
  if (doGesture) {
    console.log(`\n--- 一次手势之后 ---`)
    console.log(`gestureSeen: ${out.post.gestureSeen}  AudioContext 状态: ${JSON.stringify(out.post.contextStates)}`)
    console.log(`探针数: ${out.post.probes}（= AudioContext 数）`)
  }
  console.log(`\n--- 泄漏 / 静音 ---`)
  console.log(`BufferSource 启动 ${out.post.sources.started} / 停止 ${out.post.sources.stopped} / 残留 ${out.probes.leaked}`)
  console.log(`当前 RMS: ${out.probes.baseline ?? '(无探针)'}`)
  console.log(`\n--- 音频请求总计 (${out.requests.all.length}) ---`)
  out.requests.all.forEach((u) => console.log('  ' + u))
  console.log(`--- HTTP>=400 (${out.requests.bad.length}) ---`)
  out.requests.bad.slice(0, 10).forEach((u) => console.log('  ' + u))
  console.log(`--- AudioContext 警告 (${out.notes.audioContextWarnings.length}) ---`)
  out.notes.audioContextWarnings.forEach((u) => console.log('  ' + u))
  console.log(`\n${out.verdict.pass ? '✅ PASS' : '❌ FAIL'}`)
  out.verdict.reasons?.forEach((r) => console.log('  - ' + r))
}

await browser.close()
process.exit(out.verdict.pass ? 0 : 1)
