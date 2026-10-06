---
name: iskill-audio-verify
summary: 证明网页「真的出声了」——在 AudioContext.destination 前挂 AnalyserNode 旁路读时域 RMS，而不是只看音频节点有没有被启动。附手势门控（无手势建 AudioContext 会被 Chrome 拦）、音频 404 猎杀、惰性媒体首屏不下载、循环泄漏检测，以及一套踩坑清单。
description: 当需要验证或排查网页音频时使用——音效到底有没有真的响、为什么没声、为什么「代码看着完全正常却从没响过」、控制台有音频 404、首屏下载了很大的音频、AudioContext was not allowed to start、静音/音量对某个声音不生效、音频泄漏（声音停不下来）。触发词：音频验证、音效没声、听不到声音、真的出声了吗、web audio 验证、audio verify、RMS、AnalyserNode、autoplay 被拦、AudioContext suspended、音频 404、静音不生效、音频泄漏、BGM 首屏下载、音效从来没响过。适用于任何 Web Audio / HTMLAudio 网页项目（不限于 3D）。
agent_created: true
---

# iskill-audio-verify · 证明网页真的出声了

## 与 `iskill-webgl-scene-probe` 的分工

| | 回答的问题 | 手段 |
|---|---|---|
| `iskill-webgl-scene-probe` | **哪一个**音效被触发了？增益算出来多少？3D 场景怎么驱动？ | 挂 `AudioBufferSourceNode.start`，用 buffer 时长当指纹 |
| **本技能** | 它**到底有没有真的产生信号**？有没有被 404 吃掉？有没有泄漏？ | `AnalyserNode` 旁路读时域 RMS |

**`start()` 被调用 ≠ 出声了。** 中间还隔着四道门：

1. 文件根本不存在（404）→ 静默无声
2. `AudioContext` 还是 `suspended`（没经过用户手势）→ 无声
3. 增益链路里某一环是 0（被静音 / 音量 0 / 父节点没接上）→ 无声
4. 节点接了但**不在通往 destination 的路径上** → 无声

时长指纹能证明「第 1~4 道门之前，代码确实走到了」，但证明不了穿过去了。**RMS 能。**

---

## 一、核心手法：AnalyserNode 旁路 + 同步自旋采样

在**任何应用代码之前**（`evaluateOnNewDocument`）把 `connect` 包一层：凡是连到
`ctx.destination` 的节点，都再分一路给一个 `AnalyserNode`。

```js
await page.evaluateOnNewDocument(() => {
  const probes = []
  window.__audioVerify = { probes }

  // ⚠️ connect() 定义在 AudioNode.prototype 上，不是 AudioContext.prototype！
  //    挂错原型会静默失效（origConnect 变 undefined，被 try/catch 吞掉），
  //    症状是「探针装上了但永远是 0」。
  const origConnect = window.AudioNode.prototype.connect
  window.AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      const c = this.context
      if (c && dest === c.destination) {
        // ⚠️ 一个页面可能有**多个** AudioContext，探针要按 context 存一组。
        //    只留最后一个会被后建的顶掉 → 测出来全是 0（这个假阴性骗过一次）。
        if (!c.__probe) {
          c.__probe = c.createAnalyser()
          c.__probe.fftSize = 2048
          origConnect.call(c.__probe, c.destination)  // 让它被渲染图拉取
          probes.push(c.__probe)
        }
        origConnect.call(this, c.__probe)
      }
    } catch { /* 旁路失败不影响被测代码 */ }
    return origConnect.call(this, dest, ...rest)
  }
})
```

读取时**必须同步自旋**，不能 `await sleep`：

```js
// ✓ 对：音频图在独立线程渲染，主线程自旋不影响它
const rms = await page.evaluate((ms) => {
  const p = window.__audioVerify.probes[0]
  const buf = new Float32Array(p.fftSize)
  let max = 0
  const w = performance.now()
  while (performance.now() - w < ms) {
    p.getFloatTimeDomainData(buf)
    let s = 0
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
    const r = Math.sqrt(s / buf.length)
    if (r > max) max = r
  }
  return +max.toFixed(6)
}, 600)

// ✗ 错：无头下主线程被大页面/3D 拖死，setTimeout 被严重节流
//   实测 900ms 只跑到 **2 帧**，采样点几乎全落在声音开始之前或结束之后。
```

**判据**：`RMS > 0.0005` 才算真的在发声。`0` 就是没声。

### 断言要**相对底噪**，不能绝对为 0

页面里可能本来就有合法的环境音（背景音乐、加载时的循环音效）。先量一段「什么都不新建」的底噪：

```js
const baseline = await measure(300)          // 什么都不做，先看现在有没有在响
const muted    = await measure(300)          // 把目标声音静音后再量
assert(muted <= Math.max(baseline * 1.15, 0.002))
```

实测案例：底噪 `0.058`，一开始以为「静音失效了」，其实是**加载器的铅笔循环本来就该在响**。
把加载器跳过（`?noloader=1`）后底噪精确为 `0`，断言立刻干净。

---

## 二、手势门控：80% 的「没声」根因在这里

Chrome / Safari 的自动播放策略：**没有用户手势就不让出声**。于是有两类完全不同的失败：

| 现象 | 根因 |
|---|---|
| `AudioContext` 一直是 `suspended` | 建得太早，用户还没交互 |
| 控制台 `The AudioContext was not allowed to start...` | 同上，且**这是在真实用户那里也会发生的 bug** |

### 两种 autoplay flag，用错会掩盖 bug

```js
// ① 想验证「真实用户会不会被拦」→ 用这个（本技能默认）
'--autoplay-policy=document-user-activation-required'

// ② 想让音频在无头下无条件出声 → 用这个
'--autoplay-policy=no-user-gesture-required'
```

⚠️ `iskill-webgl-scene-probe` 里写的是 ② —— 它适合「我要听清增益算得对不对」，
但**会掩盖掉「无手势建 AudioContext」这个真实 bug**。要验证「用户能不能听到」，
必须用 ①，并且**断言控制台没有 `AudioContext was not allowed` 警告**。

### 正确做法：模块自己做手势门控

如果某个音效是在**页面加载时就请求**的（加载动画的沙沙声之类），它天然早于任何点击。
这时**不要为了让它出声就在挂载时建 AudioContext** —— 那是拿一条控制台警告换一条静音。

正确语义分两类：

```js
// 一次性音效：手势前直接放弃（等价于「它今天本来就是静音」）
// 循环音效：挂起（armed），第一个手势到达时补播
//   —— 加载动画的循环声本来就该「加载期间一直在响」，补播是正确语义
const GESTURES = ['pointerdown', 'touchstart', 'keydown']
```

⚠️ **`wheel` / `scroll` 不算 user activation**。加进手势列表会解锁出一个
**仍然是 suspended** 的 context，等于把警告请回来。只认 `pointerdown` /
`touchstart` / `keydown`。

### 验证手势门控的两条断言

```js
// 手势之前：一个 AudioContext 都不该被创建
assert(pre.contexts === 0)
// 手势之后：至少一个，且 state === 'running'
assert(post.contextStates.includes('running'))
```

---

## 三、音频 404：性价比最高的一条断言

**先把这一条加上，它抓到的 bug 比其余所有断言加起来还多。**

```js
page.on('request', (r) => { if (/\.(ogg|mp3|wav|m4a|aac|opus|flac)(\?|$)/i.test(r.url())) audioReqs.push(r.url()) })
page.on('response', (r) => { if (r.status() >= 400) httpBad.push(r.status() + ' ' + r.url()) })
```

### 真实案例（值得完整讲一遍，因为它是一种通用反模式）

某项目的音效调度器长这样：

```js
const soundPaths = { 'szumwiatru': '...', /* 只登记了 5 个 */ }
const path = soundPaths[soundName] || `/sounds/${soundName}.mp3`   // ← 兜底
```

兜底看起来是「优雅降级」，实际是**把任何没登记的名字变成一个真实请求**。
而实际被调用的名字里有两个根本没有素材：

- `play('pencil')` —— 加载动画的铅笔沙沙声（循环）
- `play('tear')` —— 撕纸离场 + 每次页面转场（**每次转场触发两次**：关闭一次、打开一次）

结果：**这两个音效从来没有响过**，而且每次访问至少 2 条 404、每进一个页面再 2 条。
代码看起来完全正常，没有任何报错，控制台只有几条容易被忽略的 404。

**修法**：把兜底换成显式白名单，未登记的名字在 DEV 下 `console.warn`。
这样拼错名字会在**开发时**暴露，而不是变成生产环境一条静默 404。

> **通用反模式**：`MAP[name] || \`/path/${name}.ext\`` 这类兜底，
> 在「名字是有限枚举」的场景下永远是有害的 —— 它把编译期能发现的错误推迟成了运行期静默失败。

---

## 四、惰性媒体：首屏不该下载大文件

`new Audio(src)` + `preload = 'auto'` + `.load()` 在**挂载时**执行 ⇒ 每个访客首屏就下载整个音频，
哪怕他从不点播放、哪怕已静音、哪怕选的是另一套音源。

```js
// ✗ 挂载时就取
bgm = new Audio('/sounds/bgm.ogg')
bgm.preload = 'auto'
bgm.load()          // ← 1.8 MB 开始下载

// ✓ 惰性：只在真正 play() 时才取
const ensureAudio = () => {
  if (bgm) return bgm
  bgm = new Audio()          // 先不带 src
  bgm.preload = 'none'
  bgm.src = BGM_URL          // 设 src 也不会取（preload=none）
  bgm.volume = rememberedVolume   // ← 音量要存在模块变量里，否则「没播过就拖音量条」会丢
  return bgm
}
```

**断言方式**：在「首屏阶段」的请求列表里，那个大文件**不该出现**。

```js
assert(!pre.audioRequests.some((u) => /bgm|\.ogg$/.test(u)))
```

改完之后，同一份报告里要能看到它**按需**出现（驱动一次播放，它才出现在请求里）——
两头都断言，才算证明「惰性 + 仍然能播」。

---

## 五、循环泄漏：启动了但从未 `stop()`

长驻的循环音效（环境音、加载声）一旦漏停，会一直占着音频线程、盖住别的声音，
而且**用户只会说「有杂音」**，很难定位。

用 `start`/`stop` 计数就能一眼看出：

```js
const P = window.AudioBufferSourceNode.prototype
const oStart = P.start, oStop = P.stop
P.start = function (...a) { sources.started++; sources.live.add(this); return oStart.apply(this, a) }
P.stop  = function (...a) { sources.stopped++; sources.live.delete(this); return oStop.apply(this, a) }
// sources.live.size = 启动了但从未 stop 的源
```

⚠️ **`live.size > 0` 不一定是泄漏**：正在播的循环本来就在里面。判据是
**「该停的时候它还在不在」**。配合底噪一起看：`live=1` 且底噪 ≈ 0
⇒ 那是刚 `stop()` 完、拆解还挂在节流过的 `setTimeout` 里（正常）；
`live=1` 且底噪明显 > 0 ⇒ 真的还在响。

---

## 六、怎么驱动被测应用的音频

### 6.1 零改动：只观察（最通用）

什么都不用改：装好旁路，然后**驱动真实 UI**（点按钮、滚页面、开门），
量 RMS。适合「不知道声音什么时候会响」的探索式验证。

### 6.2 DEV 钩子：精确到单个音效（推荐）

给音频模块加一个**只在 DEV 生效**的调试钩子（生产构建会被摇掉）：

```js
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__paperSfx = {
    create: createPaperSfx,                    // 与业务同一条代码路径
    names: [...PAPER_SFX],
    state: () => ({ gestureSeen, ctxState: ctx ? ctx.state : null, armed: [...armedLoops.keys()] }),
  }
}
```

于是可以做**逐音效的精确断言**：`create('tear', {volume:1})` → 量 RMS → `stop()`。

⚠️ 生产构建里这个钩子不存在，脚本要**优雅降级**（`if (!window.__x) return {skip:'生产构建'}`），
否则会在生产页面上抛 `TypeError`。

### 6.3 通过打包器的模块图驱动**真代码**（Vite）

Vite dev server 按 URL 提供模块，而**同一个 URL ⇒ 同一个模块实例**。
所以可以直接 `import()` 到应用正在用的那个模块对象，拿到的是**真函数、真状态**，不是复制品：

```js
await page.evaluate(async () => {
  const m = await import('/src/utils/audioManager.js')   // 与应用共享同一实例
  m.playBackgroundMusic()
})
```

⚠️ **生产构建里没有 `/src/` 模块**，这个 URL 会 404。必须 try/catch 降级，
否则你会看到一条自己造成的 `http404`，误以为产品有问题。

### 6.4 别用「重新实现一遍」代替「驱动真代码」

自己 `new AudioContext()` 手搓一个振荡器去验证「Web Audio 能不能出声」是**没有意义的** ——
它证明的是浏览器，不是你的代码。探针的价值全在「接在**被测应用**的音频图上」。

---

## 七、踩坑清单

1. **`connect()` 在 `AudioNode.prototype` 上，不在 `AudioContext.prototype` 上。**
   挂错原型**静默失效**（拿到的 `origConnect` 是 `undefined`，被 `try/catch` 吞掉），
   症状是「探针数 0 / RMS 永远 0」。
2. **一个页面可能有多个 `AudioContext`。** 实测某站点同时存在 2 个（合成音效一个、
   成就铃声一个）。探针必须**按 context 存一组**，只留最后一个会被后建的顶掉。
   （顺带：并存多个 context 本身也是浪费，Chrome 有数量上限，值得建议合并。）
3. **无头下 `setTimeout` 会被严重节流**（实测 900ms 只跑 2 帧）。
   采样一律**同步自旋**；音频图在独立线程，自旋不会影响它。
4. **断言要相对底噪**，不要绝对为 0 —— 环境音/加载音可能本来就该在响。
5. **`wheel` / `scroll` 不是 user activation**，别加进手势列表。
6. **两种 autoplay flag 用错会掩盖 bug**：验证「真实用户能不能听到」必须用
   `document-user-activation-required`，而不是 `no-user-gesture-required`。
7. **不要在挂载时就建 `AudioContext` 来「修」音频 404/静音** ——
   那是拿一条控制台警告（真实用户也会看到）换一条静音。
   正确做法是手势门控 + 一次性放弃 / 循环挂起。
8. **`AnalyserNode` 建议也连到 `destination`**，保证它被渲染图拉取。
   （Chrome 里只挂输入通常也能出数据，但连上去是零成本的确定性。）
9. **应用可能在首帧渲染后整页 reload**（HMR / StrictMode）。
   reload 会清空所有页面级状态，包括模块里的 `gestureSeen` 和探针数组 ——
   于是「手势后」的断言可能落在**刚 reload 过的**页面上，拿到 `gestureSeen: false`。
   **先 soak 够（≥6~7s）再开始断言**，并在报告里带上 `navs` 计数自证。
10. **生产构建里 DEV 钩子 / `/src/` 模块都不存在**，脚本必须优雅降级，
    否则你会看到自己造成的错误并误判产品。
11. **别把「文件在磁盘上」当成「能播」**：格式不被浏览器支持（如缺解码器）、
    采样率异常、`Content-Type` 错，都会让一个 200 的请求变成静音。RMS 才能区分。
12. **`HTMLMediaElement` 走的是另一条路**（`<audio>` / `new Audio()`），
    不受 `AudioNode.prototype.connect` 影响。要同时挂 `HTMLMediaElement.prototype.play`
    才能知道它被调用了（但**音量/静音仍要单独查 `volume`/`muted` 属性**）。

---

## 八、一键脚本

`scripts/audio-check.mjs` —— 零应用改动的通用体检，装了页面侧工具箱供你扩展：

```bash
node scripts/audio-check.mjs <url> [--wait 7000] [--no-gesture] [--json]
```

| 环境变量 | 作用 |
|---|---|
| `CHROME_PATH` | 覆盖 Chrome 路径（缺省自动在 `~/.cache/puppeteer` 下找） |
| `PUPPETEER_PATH` | 覆盖 puppeteer-core 入口（缺省自动找 WorkBuddy 的托管 node） |

页面侧工具箱（写项目专属断言时用）：

| 成员 | 作用 |
|---|---|
| `__audioVerify.measure(ms, skipMs)` | 同步自旋采样，返回所有探针里的最大 RMS |
| `__audioVerify.stats()` | `{contexts, contextStates, probes, gestureSeen, warnedNoGesture, sources}` |
| `__audioVerify.probes` | 每个 AudioContext 一个 `AnalyserNode` |

它自动做这几件事并给出 PASS/FAIL：

- 手势前 `AudioContext` 创建数必须为 0
- 控制台不得出现 `AudioContext was not allowed to start`
- 音频资源不得有 404
- 报告探针数、BufferSource 启动/停止/残留、当前 RMS、全部音频请求

**退出码 0 = PASS / 1 = FAIL**，可直接进 CI。

---

## 九、完整验证配方（按顺序做，别跳）

1. **列全部音频请求 + 404** ← 先做这个，最容易抓到真 bug
2. **手势前**：`AudioContext` 创建数应为 0；不该有大文件请求
3. **一次手势**：`contextStates` 应包含 `running`；探针数应等于 context 数
4. **底噪**：先量「什么都不新建」的 RMS，作为后续断言的参照
5. **逐音效**：`create(name)` → `measure(600)` → `stop()`；断言 RMS > 0.0005
6. **静音契约**：`muted = true` → RMS 应回到 ≈ 底噪；`muted = false` → 应恢复
7. **泄漏**：`live` 计数与底噪一起判读
8. **生产构建再跑一遍**（DEV 钩子会被摇掉，那部分应报 skip 而不是 fail）
