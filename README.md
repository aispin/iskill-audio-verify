# iskill-audio-verify

**证明网页「真的出声了」** —— 在 `AudioContext.destination` 前挂 `AnalyserNode` 旁路读时域 **RMS**，而不是只看音频节点有没有被启动。

本 skill 由一次真实的排查沉淀而来：某站点有两个音效**从来没有响过**，代码看起来完全正常、没有任何报错，只有控制台里几条容易被忽略的 404。修完之后把手法固化成了这个 skill。

---

## 它解决什么问题

`start()` 被调用 **≠** 出声了。中间还隔着四道门：

| # | 拦路的门 | 时长指纹能发现吗 | RMS 能发现吗 |
|---|---|---|---|
| 1 | 文件根本不存在（404） | ✗ | ✗（要靠请求断言） |
| 2 | `AudioContext` 还是 `suspended`（没经过用户手势） | ✗ | ✓ |
| 3 | 增益链路某一环是 0（被静音 / 音量 0） | ✗ | ✓ |
| 4 | 节点接了但不在通往 destination 的路径上 | ✗ | ✓ |

所以本 skill 给的是**信号级**的答案，和 `iskill-webgl-scene-probe` 的**指纹级**答案是互补的：

- `iskill-webgl-scene-probe`：**哪一个**音效触发了（buffer 时长指纹）、增益算出来多少、3D 场景怎么驱动
- `iskill-audio-verify`（本 skill）：它**到底有没有真的产生信号**、有没有被 404 吃掉、有没有泄漏

---

## 它能做什么

### 开箱即用：一条命令的通用体检

```bash
node scripts/audio-check.mjs <url> [--wait 7000] [--no-gesture] [--json]
```

自动断言并给出 PASS / FAIL（退出码 0 / 1，可直接进 CI）：

- 手势之前 `AudioContext` 创建数必须为 **0**（否则真实用户会收到 autoplay 拦截）
- 控制台不得出现 `AudioContext was not allowed to start`
- 音频资源不得有 **404**
- 报告探针数、`BufferSource` 启动/停止/**残留**、当前 RMS、全部音频请求

### 可组合：页面侧工具箱

脚本会在页面里装一个 `window.__audioVerify`，供你写项目专属断言：

```js
const rms = await page.evaluate(() => window.__audioVerify.measure(600))  // 同步自旋采样
const s   = await page.evaluate(() => window.__audioVerify.stats())       // contexts/probes/sources
```

---

## 核心手法

**旁路探针**：把 `AudioNode.prototype.connect` 包一层，凡是连到 `ctx.destination` 的节点都再分一路给 `AnalyserNode`。

**同步自旋采样**：音频图在独立线程渲染，主线程自旋不影响它；而 `await sleep` 在无头环境里会被严重节流（实测 900ms 只跑 **2 帧**），根本采不到东西。

**手势门控**：Chrome 在没有用户手势时 `new AudioContext()` 会打控制台警告且必然是 `suspended`。所以正确的做法不是「早点建 context 让它能出声」，而是**手势前不建** —— 一次性音效放弃、循环音效挂起等解锁后补播。

---

## 内置的踩坑清单（部分）

- `connect()` 定义在 **`AudioNode.prototype`** 上，不是 `AudioContext.prototype` —— 挂错原型会**静默失效**
- 一个页面可能有**多个** `AudioContext`，探针必须按 context 存一组，否则后建的会把前一个顶掉，测出来全是 0
- 断言要**相对底噪**，不能绝对为 0（环境音可能本来就该在响）
- **`wheel` / `scroll` 不是 user activation**，别加进手势列表
- 两种 autoplay flag 用错会**掩盖**真实 bug：验证「用户能不能听到」要用 `document-user-activation-required`
- 应用可能在首帧渲染后**整页 reload**，会清空 `gestureSeen` 和探针数组
- 生产构建里 DEV 钩子 / `/src/` 模块都不存在，脚本必须优雅降级

完整清单见 [`SKILL.md`](SKILL.md#七踩坑清单)。

---

## 安装

本 skill 放在 `~/Workbuddy/ISkills/iskill-audio-verify`，通过软链接暴露给 WorkBuddy：

```bash
ln -s ~/Workbuddy/ISkills/iskill-audio-verify ~/.workbuddy-ai/skills/iskill-audio-verify
```

依赖：`puppeteer-core`（或 `puppeteer`）+ 一个 Chrome 可执行文件。
两者都能用环境变量覆盖（`PUPPETEER_PATH` / `CHROME_PATH`），缺省会自动在
WorkBuddy 的托管 node 与 `~/.cache/puppeteer` 下寻找。

---

## 适用面

任何 **Web Audio / HTMLAudio** 网页项目，不限于 3D：

- 游戏 / 互动站点的音效验证
- 音乐播放器、播客站
- 带背景音乐的落地页
- PWA / 离线应用（顺带能验证 Service Worker 有没有把音频缓存对）

---

## License

MIT
