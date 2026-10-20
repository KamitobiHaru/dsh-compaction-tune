# dsh-compaction-tune

给 DSH（DeepSeek Harness）的官方预设加**压缩更早、尾巴更小**的可选副本预设。两个副本共用一套
压缩参数：

| preset id | 选择器里显示 | 抄自 | 工具面 |
|---|---|---|---|
| `high-performance` | **「高性能」** | 官方 `standard` | 全套工具 |
| `high-performance-minimal` | **「高性能精简」** | 官方 `minimal` | 只有 `bash` + `read_image` |

默认在模型上下文 **40%** 处触发自动压缩，压缩后逐字保留约 **5%** 的消息预算。

- **不改动原版**：只新增预设行，`standard` 与 `minimal` 原样保留，随时切回对照
- **装完即用**：默认就是 0.4 / 0.05，不需要任何额外配置
- **可调**：阈值与保留比例用环境变量改，重启生效，**不需要重新安装**
- **覆盖所有模型**：任何 provider 下、任何声明了 `contextWindow` 的模型自动适用，无需逐个登记
- **跟得上上游**：自带 `verify`（自检）、`check`（上游漂移检测）、`sync`（按上游重新生成）

## 工作原理

DSH 的 Cordis 补丁里 `config` 是**整体替换、从不深合并**，而预设的插件清单位于
`preset-standard.config.plugins`（不是可单独 patch 的 `group` 行）—— 所以任何覆写都必须重述整份声明。
本 bundle 的做法是：逐字复制上游预设，只在 `compaction-basic` 一行上加一个 `!!js`
表达式，该表达式在 boot 时读环境变量算出压缩策略。`scripts/verify.mjs` 会断言每个生成物
**只比它的上游多这一处**。

改的是**两个策略参数**，压缩的算法（怎么压、摘要怎么生成）一个字没动：

| 参数 | 含义 | harness 默认 | 本 bundle 默认 |
|---|---|---|---|
| `thresholdRatio` | 上下文用量到窗口的百分之几触发压缩 | 0.8 | 0.4 |
| `retainRatio` | 压缩后逐字保留多长的最近尾巴 | 0.16 | 0.05 |

## 效果

触发点 = `floor(min(contextWindow × 0.4, contextWindow − maxTokens − 65536))`；
保留尾巴 = `min(0.05, 阈值 / 2) × (contextWindow − maxTokens)` 个 token（逐字保留，其余压成摘要）。

| 路由 | contextWindow / maxTokens | 触发 | 逐字保留 |
|---|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | 1,000,000 / 384,000 | 400,000 | 30,800 |
| `opencode-go/mimo-v2.6-*`、`muse-spark-1.3-*` | 1,048,576 / 131,072 | 419,430 | 45,875 |
| `command-code-goat/*`（未声明 maxTokens） | 1,000,000 / 1,048,576 | ≤ 比例项 | 同上 |

本机 `web` profile 实际在用的路由都属于第三类（都没有声明 `maxTokens`），所以触发点只能由比例项决定：
`command-code-goat/deepseek/deepseek-v4.1-flash` 与 `command-code-goat/minimax/minimax-m3.1-flash:free` → 400,000，
`command-code-goat/z-ai/glm-5.3-flash` → 419,430。用 `node scripts/set-ratio.mjs --show` 可随时读到本机真实数字。

## 「高性能精简」与官方 minimal 的差别

只有一处：官方 `minimal` 的 `compaction-basic` 没有任何 config，用的是 harness 默认值；本副本把
那一行换成读环境变量的表达式。所以这个预设是**官方 minimal 的逐字副本 + 一处压缩注入**。

工具面与官方 `minimal` 完全一致：模型只看到 `bash`（常驻 shell）和 `read_image`，系统提示词只有一句。

**它不挂 `tool-result-pruner`**（官方 `minimal` 也不挂）。那个插件裁的是**工具输出文本**
（超过 8192 字符就只留头 4096 + 尾 1024），只在压缩触发时才裁。官方 `standard` 挂它，本副本不挂：
保持「生成物 = 上游 + 恰好一处差异」这个可断言的不变量。代价是 minimal 场景里模型只能靠 `bash`
读文件，超长的原始输出会整段进摘要器，摘要更容易因为「summary is not smaller than the shadowed
content」而放弃本次压缩；好处是工具结果永远保持原样。

## 安装

前置：可用的 DSH（生成时版本 `0.2.1-rc.2`），`dsh web` 能正常启动。

**方式一：命令行**

    dsh plugin --profile web add github:KamitobiHaru/dsh-compaction-tune#v0.5.0

**方式二：GUI** —— 左侧「插件」页面，安装同一个 spec。

**方式三：让 DSH 里的 agent 装** —— 用 `plugin_manager` 工具，`install_bundle`，target 填同一个 spec。

> **装完请重启一次 `dsh web`。** 补丁本身是热重载的（新会话即可生效），但实测「安装 bundle / 改
> profile patch」之后，**正在运行的会话会掉光工具**（任何调用都返回 `unknown tool`），重启即恢复。

## 使用

装完并重启后，预设选择器里会出现 **「高性能」** 和 **「高性能精简」** 两张卡。
生效的默认预设 = `selectedDefault ?? default`：默认是「高性能」（`high-performance`），
想换成另一个，在新会话里选一次，GUI 会把选择写回 profile patch，之后新会话默认用它。
原版 `standard` 与 `minimal` 仍在选择器里，可随时对照。

两个预设**共用同一套环境变量** —— 同一台机器 = 一套压缩策略，预设只决定工具面。

### 调整阈值与保留比例

    cd <本 bundle 的仓库或安装目录>
    node scripts/set-ratio.mjs 0.3                 # 只改触发比例，保留比例自动派生
    node scripts/set-ratio.mjs 0.4 --retain 0.05   # 两个值都显式给
    node scripts/set-ratio.mjs --show              # 当前值 + 本 profile 所有模型的触发/保留数
    node scripts/set-ratio.mjs --unset             # 回到 bundle 默认 0.4 / 0.05

脚本写入 `$DSH_HOME/.env`；也可以直接用启动环境变量（优先级高于 `.env`）：

    HARNESS_COMPACTION_THRESHOLD_RATIO=0.3 dsh web

| 变量 | 默认 | 含义 |
|---|---|---|
| `HARNESS_COMPACTION_THRESHOLD_RATIO`（别名 `DSH_COMPACTION_THRESHOLD_RATIO`） | `0.4` | 触发比，会话测量值 ≥ 阈值时在 `agent/pre-step` 自动压缩 |
| `HARNESS_COMPACTION_RETAIN_RATIO`（别名同上） | `min(0.05, 阈值 / 2)` | 压缩后逐字保留的最近尾巴占消息预算的比例 |

这两个变量**同时作用于两个预设**（改一处，两张卡一起变）。

两点注意：`.env` 里**不能**用 `DSH_*` 名字（DSH 视为 bootstrap-only，会让启动直接报错），所以 `.env`
用 `HARNESS_*`，`DSH_*` 只作命令行别名；环境变量在 **boot 时读一次**，改完要重启 `dsh web`。

### 怎么选保留比例

`retainRatio` 只决定"压缩后逐字留多少最近内容"，不改变触发点。同一个比例在不同模型上的绝对值差很多，
按**绝对值**校更靠谱：

| retainRatio | flash（预算 616k） | 占 400k 触发点 | mimo / muse（预算 917.5k） |
|---|---|---|---|
| 0.16（DSH 内置默认） | 98,560 | 24.6% | 146,800 |
| 0.08 | 49,280 | 12.3% | 73,400 |
| **0.05（本 bundle 默认）** | **30,800** | **7.7%** | **45,875** |
| 0.03 | 18,480 | 4.6% | 27,525 |

- **占窗口 5–20% 是主流区间**。0.16 在 1M 窗口上只占 9.9%，并不离谱；问题是它占触发点 24.6%，
  一次压缩只压掉约四分之三，压完还剩 11 万。
- **0.16 是按 200k 级窗口校准的**：`0.16 × (200k − 32k) ≈ 27k`。窗口越大、`maxTokens` 声明得越大
  （保留基数是 `contextWindow − maxTokens`），这个比例算出来的绝对值就越大。
- **经验规则：`retain ≲ 触发点 / 4`**，同时可压区间要远大于摘要。0.4/0.05 下可压约 36 万，压完稳态
  ≈ 4 万（工具 5.2k + 系统 1.4k + 摘要 + 尾巴 30.8k），比 0.16 时小 2.7 倍。
- 别低于 ~20k：更早的细节只剩摘要，长任务里会开始反复回读文件。

参考（各家并不公布"保留多少 token"）：Claude Code 在窗口 85% 提示、95% 强制压缩，边界是**保留最近约
10 条消息**；Codex CLI 用 `model_auto_compact_token_limit`（默认按模型族给定）加
`tool_output_token_limit = 10000`；OpenHands 的 `LLMSummarizingCondenser` 以事件数计；Cline 直接把整段
历史换成摘要。

## 自测：为什么"到了阈值却没压缩"

自动压缩在**每一步开始前**（`agent/pre-step`）判定，要**同时**过三关：

1. **总量关**：`tokenMeter.measure(session).totalTokens >= 阈值`。这个 total **包含工具定义**，所以 UI
   上的「上下文已用」就是它；工具定义约 5K 是一层永远压不掉的**地板**。
2. **可压区间关**：保留尾巴必须停在系统提示之前。尾巴把整段对话吞完时，代码**静默返回**（不压缩、
   不报错）。
3. **摘要关**：摘要（含框架，约 800 token 起）必须**严格小于**被替换区间，否则放弃本次压缩，日志里
   是 `compaction/end` 带 `error: summary is not smaller than the shadowed content (… >= …)`。

想快速确认"会不会自己压缩"，用一个不太小的触发点 + 很小的尾巴：

    node scripts/set-ratio.mjs 0.01 --retain 0.0005   # 触发 10,000；尾巴仅 308 token
    # 重启 dsh web，在新会话里聊几轮，然后看下一步是否自动出现摘要/检查点

成功时服务端 stderr 会有 `compaction (pressure): shadowed N surface nodes (seqs …, ~M tokens)`；
也可以在会话日志里看 `compaction/start` / `compaction/end`。

## 维护：DSH 升级之后

    node scripts/check.mjs    # 上游 presets/standard.patch.yml 或 minimal.patch.yml 变了就非 0 退出
    node scripts/sync.mjs     # 按新上游重新生成 cordis.patch.yml
    node scripts/verify.mjs   # 断言「每个生成物 = 对应上游 + 恰好一处注入」
    git diff                  # 看上游新增/改动了哪些工具与提示段

打新 tag 之后，各设备把安装 spec 换成新 tag 重装并重启。用 github 安装时整个仓库都会放进
`~/.dsh/profiles/web/node_modules/dsh-compaction-tune/`，所以设备上没有仓库也能直接跑那里的脚本。

发版约定：`package.json` 的 `version` 与 tag 同名（例如 `0.5.0` ↔ `v0.5.0`），每次改脚本或生成物
就同步升一位。`sync.mjs` 是幂等的：连续跑两次，只有生成物真的变了才会动 `upstream.json` 的
`generatedAt`，所以发布前可以用「跑两次 + `git diff --stat` 为空」自检。

### `0.5.0` 追的是 DSH `0.2.1-rc.2`，并新增「高性能精简」

**必须跟的一处是 `persona`**：官方这一版改了 `standard` 预设十处，其中官方删掉了
`suffix: Your working directory is {{cwd}}.`。DSH 0.2.1 起注册的 prompt 变量只剩 `model` 和
`provider`，`{{cwd}}` 已经不是合法变量 —— 提示词组装时遇到未注册变量会直接抛
`unknown prompt variable "{{cwd}}"`，该预设的每次请求都会失败。工作目录改由
`@deepseek-ai/dsh-working-directory` 的 `working-directory:current` context 提供（`interpolate: false`）。
**所以自定义预设里不要再写 `{{cwd}}`。**

其余九处：新增 `time-context`、`tool-schedule`、`tool-plugin-market` 三行；删掉 `tool-subagent-codex`、
`tool-subagent-claude-code`、`tool-ralph` 三行；`tool-subagent`（spawn）与 `tool-subagent-fork` 删掉
`backgroundMode`（该选项在 0.2.1 已整个消失）；`plan-mode` 的提示段文本改写。这些都由 `sync.mjs`
自动带进来，不用手改生成物。

同一版 DSH 里，官方 `minimal` 预设也变了：**新增了 `tool-fs` 行**（`read: false, readImage: true,
write: false, edit: false` —— 上游自己就有逐工具开关了）和 **`compaction` 组**（`compaction-basic` +
`command-compact`，不带 `tool-result-pruner`）。

`0.5.0` 据此新增第二个预设 `high-performance-minimal`「高性能精简」：官方 `minimal` 的逐字副本 +
同样一处压缩注入。生成器现在同时读 `standard.patch.yml` 和 `minimal.patch.yml` 两个上游源，
`upstream.json` 的结构也从单个 `upstreamPath` 变成 `sources.standard` / `sources.minimal` 两份。

## 卸载

    dsh plugin --profile web remove dsh-compaction-tune

或在 GUI 的「插件」页移除，然后重启。移除后预设恢复为 `standard`（bundle 的 registry 覆写随之消失）。

## 已知限制

- **副本会冻结**：覆写预设等于冻结那份插件清单，上游新增的工具/提示段要等 `sync` 重新生成才会进来。
  `0.5.0` 已经把 0.2.1 新增的 `time-context`、`tool-schedule`、`tool-plugin-market` 带进来了；上游再变仍需 `sync`。
- **两个预设共用一套旋钮**：`HARNESS_COMPACTION_*` 改一处两张卡一起变。同一台机器只有一套压缩策略，
  预设只决定工具面。
- **「高性能精简」不裁工具结果**：与官方 `minimal` 一致，不挂 `tool-result-pruner`。超长工具输出会整段
  进摘要器，摘要更容易触发「summary is not smaller than the shadowed content」而放弃本次压缩。
- **改 `cordis.patch.yml` 要配合重启**：服务运行时改 profile patch（或安装 bundle）会让正在运行的会话
  掉光工具，重启即恢复。
- **preset id 是会话记录的东西**：换 id 后，用旧 id 建的会话恢复会失败。
- 本 bundle 会覆写 `agent-preset-registry` 的 `default` / `selectedDefault`；profile patch 在 bundle 层
  **之后**应用，所以 profile patch 里也写了这两项时，以 profile patch 为准。
- 不要装进不加载 `agent-preset-registry` 的 profile（例如 `headless`）：会每次启动打印补丁目标不存在的告警。
- 若以 `link:` 方式安装（指向本地目录），别删除或移动该目录。

## License

MIT，见 [LICENSE](LICENSE)。生成的 `cordis.patch.yml` 是 `@deepseek-ai/dsh-web-app` 所带 `standard`
与 `minimal` 预设声明的逐字副本，由 `scripts/sync.mjs` 从本机安装中生成。
