# dsh-compaction-tune

一个只做一件事的 DSH 补丁型 bundle：给 `standard` 预设做一份「压缩阈值可调」的副本
（Loader 行 `preset-standard-tuned`、preset id `standard-tuned`），并把它设为该 profile 的默认预设。

- 默认阈值 **0.4**：adapter 声明 contextWindow 的 40%。对 `opencode-go/deepseek-v4.1-flash`
  （1,000,000 / maxTokens 384,000）就是 **400,000 token 触发**，压缩后保留约 98,560 token。
- 阈值与保留比例用环境变量随时改，**不需要重新安装**；改完重启 dsh 生效。
- 想确认「到底会不会自己压缩」：把阈值调到 `0.001`（约 1,000 token），发一两轮就能看到自动压缩。
- 原来的 `standard` 预设保持原样，可随时切回对照。

## 为什么是「副本 + 环境变量」

DSH 的补丁机制里 `config` 是整体替换、从不深合并，而预设的插件清单躺在
`preset-standard.config.plugins` 里（不是可 patch 的 `group` 行），所以任何覆写都必须重述整份声明
—— 这也正是 DSH 自己的配置编辑器保存时的写法。既然必须冻结一份清单，就把唯一需要反复调整的
值改成 `!!js` 表达式从环境变量读取。

表达式还会派生保留比例 `min(0.16, threshold / 2)`：`compaction-basic` 在**插件激活时**就断言
`retainRatio < thresholdRatio`，用默认的 0.16 配 0.001 会让整个预设挂不上（启动直接失败）。

## 安装

本机（仓库已在磁盘上，`link:` 安装，改仓库文件即可重载）：

    plugin_manager install_bundle   target=/data3/zsy/dsh-compaction-tune

其它设备（先推 GitHub 并打 tag）：

    plugin_manager install_bundle   target=github:<user>/dsh-compaction-tune#v0.1.0

`install_bundle` 会 `pnpm add` 并把 bundle 追加到 `dsh.profile.bundles` 末尾，补丁层因此压在
`dsh-web-app` 之上。补丁是热重载的：已存在的会话保留旧 revision，**新会话**才用新预设。

> **装完请重启一次 `dsh web`。** 热重载足以让新会话拿到新预设，但实测「安装 bundle + 改
> profile patch」这套组合热重载之后，正在运行的会话会掉光工具（工具面板为空，任何调用都返回
> `unknown tool`），重启即恢复。直接重启比事后排查便宜得多。

## 分发给其它设备

**采用「`standard` 与 `standard-tuned` 两个预设都保留」的形式**：bundle 只 *新增* 一个预设行，
从不改动 `preset-standard`，所以原版随时可用、可对照。

一次性三步，之后不需要再配置：

```bash
# ① 任意一台有仓库的机器上推送（仓库已 commit + tag v0.1.0，只差 remote）
cd /data3/zsy/dsh-compaction-tune
git remote add origin git@github.com:<you>/dsh-compaction-tune.git
git push -u origin main --tags

# ② 每台设备安装（pin tag；profile 的 pnpm-lock.yaml 会记住解析到的 commit）
plugin_manager install_bundle  target=github:<you>/dsh-compaction-tune#v0.1.0
# 等价 CLI：dsh plugin --profile web add github:<you>/dsh-compaction-tune#v0.1.0

# ③ 重启一次 dsh web
```

**阈值不需要在每台设备上设置**：bundle 的默认就是 `0.4`（`retain = min(0.16, 0.4/2) = 0.16`）。
环境变量只是临时试验用的旋钮，`.env` 里写 `0.4` 与不写等价。

**唯一需要对齐的是「默认选中哪个预设」**：

- profile patch 里的 `agent-preset-registry` 行（`default` / `selectedDefault`）在 bundle 层
  **之后**应用，所以它优先。生效值 = `selectedDefault ?? default`。
- 全新设备（profile patch 里没有这一行）→ bundle 的覆写生效 → 默认就是 `standard-tuned`。
- 已有设备如果把 `selectedDefault` 选成了 `standard` → 默认是 `standard`，`standard-tuned`
  仍留在选择器里可选（本机就是这个状态）。
- 想让多台设备完全一致，就在每台设备的选择器里选一次想要的预设（GUI 会把选择写回 profile patch），
  或把 profile patch 里那一行同步过去。

升级 dsh 之后（唯一持续的负担）：

```bash
node scripts/check.mjs     # 上游 presets/standard.patch.yml 漂移就非 0 退出
node scripts/sync.mjs      # 重新生成 cordis.patch.yml
git diff                   # 看上游新增/改动了哪些工具与提示段
git tag v0.1.1 && git push --tags
# 各设备把 spec 换成 ...#v0.1.1 重装 + 重启
```

设备上没有仓库也能查漂移：github 安装会把整个仓库放进
`~/.dsh/profiles/web/node_modules/dsh-compaction-tune/`，直接跑

    node ~/.dsh/profiles/web/node_modules/dsh-compaction-tune/scripts/check.mjs

## 新增模型需要做什么

**bundle 侧零操作。** 压缩阈值不是按模型列表配置的：`compaction-basic` 在运行时用会话实际路由到的
provider/model 去问适配器要 `contextWindow`，然后算
`threshold = floor(min(contextWindow × ratio, contextWindow − 会话maxTokens − 65536))`。
所以任何 provider、任何模型都自动覆盖，不需要写进本 bundle，也不需要重启（改的是 llm 配置）。

唯一的前提是**适配器配置里声明 `contextWindow`**：

- 声明了 → 该路由自动享受同一套比例；
- 没声明 → `compaction-basic` 对该路由抛 `TargetPressureConfigError`（pre-step 处理器兜住，
  只打一条告警，不中断对话）。

建议**同时声明 `maxTokens`**：它决定预留的完成额度，也就是决定 `contextWindow − maxTokens − 65536`
这个封顶会不会把触发点压得比比例项更低；不声明就只能靠会话请求头/适配器默认值，数值不确定。

`scripts/set-ratio.mjs --show` 和 `scripts/verify.mjs` 末尾打印的表格会**读取你 profile 的
`cordis.patch.yml` 并列出所有 provider 的所有模型**（`--profile <name>`、`--home <path>` 可覆盖），
所以它是覆盖范围的诊断，而不是需要维护的清单。两类会显式提示：

- `maxTokens not declared` → 该行只能给出比例项上界（`trigger <= …`）；
- `declares no contextWindow` → 该路由在运行时会被压缩拒绝，需要去 llm 配置里补上。

表格里的数字**只是推算/显示**：真正判定用的数字由 `compaction-basic` 在运行时用会话测量值与
适配器声明计算，与这里的表无关。若将来要给个别路由**不同的比例**，需要扩展 bundle 表达式使用
`compaction-basic` 的 `modelPolicies`（目前只给一个全局比例）。

## 调阈值

推荐写进 `$DSH_HOME/.env`（boot 时灌进 `process.env`），然后重启 dsh：

    cd /data3/zsy/dsh-compaction-tune
    node scripts/set-ratio.mjs 0.001                  # 阈值 0.001，保留比例自动派生 0.0005
    node scripts/set-ratio.mjs 0.001 --retain 0.0005  # 两个值都显式给
    node scripts/set-ratio.mjs --show                 # 只看当前值，并列出该 profile 所有 provider 的所有模型
    node scripts/set-ratio.mjs --unset                # 恢复 bundle 默认 0.4 / 0.16

`--show` 的模型清单来自 profile 自己的 `cordis.patch.yml`（`--profile <name>` / `--home <path>` /
`--install <dsh 包目录>` 可覆盖）；它只是诊断显示，不参与运行时判定 —— 新增模型不需要改这里，
详见「新增模型需要做什么」。

也可以直接用启动环境变量（优先级高于 `.env`，无需改文件）：

    HARNESS_COMPACTION_THRESHOLD_RATIO=0.001 dsh web

| 变量 | 默认 | 含义 |
|---|---|---|
| `HARNESS_COMPACTION_THRESHOLD_RATIO`（别名 `DSH_COMPACTION_THRESHOLD_RATIO`） | `0.4` | 触发比：`threshold = floor(min(contextWindow × ratio, contextWindow − maxTokens − 65536))`，当会话 token 估算 ≥ threshold 时在 `agent/pre-step` 自动压缩 |
| `HARNESS_COMPACTION_RETAIN_RATIO`（别名同上） | `min(0.16, threshold / 2)` | 压缩后逐字保留的最近尾巴占 `contextWindow − maxTokens` 的比例 |

注意：`.env` 里**不能**用 `DSH_*` 名字 —— DSH 把该前缀视为 bootstrap-only，会让启动直接报错；
所以 `.env` 用 `HARNESS_*`，`DSH_*` 只作为命令行导出的别名（bundle 两个都读，`HARNESS_*` 优先）。

## 自测：为什么"上下文到了阈值"却没压缩

自动压缩在**每一步开始前**（`agent/pre-step`）判定，且要**同时**过两关：

1. **总量关**：`tokenMeter.measure(session).totalTokens >= threshold`。这个 total **包含工具定义**
   （`estimateToolsTokens(header) + surface`），所以 UI 上「上下文已用」的数字就是它。工具定义约
   5K —— 这是一层**永远压不掉的地板**。
2. **可压缩关**：保留的尾巴必须停在系统提示之前（`selectCompactableRange`）。尾巴 =
   `retainRatio × (contextWindow − maxTokens)` 个 token，逐字保留；系统提示所在的 surface 节点
   永不参与压缩。

只过第一关、不过第二关时，代码**静默返回**（不压缩、不报错、不写日志）。这正是「10.9K 了却没动静」
的成因：阈值 10,000 是被 5.2K 工具定义顶过去的，而当时的对话只有约 3K，小于尾巴
（0.005 × 616,000 = 3,080）——尾巴把整段对话吞完了，没有可压的区间。

**推荐配方（阈值留在工具地板之上，只把尾巴调小）**

1. `node scripts/set-ratio.mjs 0.01 --retain 0.0005`   # 触发 10,000；尾巴仅 308 token
2. 重启 `dsh web`
3. 在新会话里聊几轮（让「上下文已用」超过 10,000）
4. 下一步开始时应当**未经 `/compact`** 自动压缩：transcript 出现摘要/检查点、上下文用量回落；
   服务端 stderr 出现 `compaction (pressure): shadowed N surface nodes …`
5. 试完 `node scripts/set-ratio.mjs --unset` 再重启

这样两关都过，而且压缩后总量（工具 5.2K + 系统 1.4K + 摘要 + 尾巴）会落回阈值以下，只压一次就安静。
反过来，把阈值压到工具地板（约 5–6K）以下，对话压无可压之后每步都会打印
`compaction still above threshold after N attempts` 告警（被 pre-step 处理器兜住，不会中断对话，
但很吵）。或者干脆让对话长大（让「对话消息」超过尾巴），再保持 `0.01`。

### 第三关：摘要必须比被替换的内容小

**触发成功不等于压缩成功。** 选定区间后摘要由模型生成，然后有一个硬性检查：摘要（含框架）的
估算 token 必须**严格小于**被替换区间的 token，否则整个压缩被放弃：

```
compaction/start  {…}
compaction/end    {error: "summary is not smaller than the shadowed content (780 estimated framed tokens >= 136)"}
                                   ↑ 摘要                 ↑ 被替换区间
```

（[dsh-compaction-basic:600–601](/data3/zsy/node-v24.18.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js#L600-L601)；失败只会打一条
`step compaction failed: …; continuing the turn` 告警，对话继续，**surface 不变**。）

所以尾巴调小并不是越小越好：尾巴太小 → 可压区间也小 → 摘要（框架开销约 800 token 起）比它还大 →
被拒绝。要看到一次**成功**的压缩，可压区间要明显大于摘要——让「对话消息」长到几 K 之后再压，或者
就等正常比例在真实会话里跑到 40 万（那时可压约 30 万，摘要几千，非常划算）。

你可以在自己的会话日志里核对这三关：`compaction/start` / `compaction/end`（`error` 字段）、
以及成功时的 `compaction (pressure): shadowed N surface nodes (seqs …, ~M tokens)`。

## 校验与升级

    node scripts/verify.mjs   # 生成物 == 生成器输出；等于上游 preset + 恰好一个注入属性；
                              # 上游 dump/parse 往返无损；表达式对一张 env 表逐一求值，
                              # 非法值必须抛错；最后打印各模型触发/保留 token 数
    node scripts/check.mjs    # 上游 presets/standard.patch.yml 是否漂移（升级 dsh 后跑）
    node scripts/sync.mjs     # 重新生成 cordis.patch.yml 与 upstream.json

DSH 升级后的流程：`check` 报警 → `sync` 重新生成 → `git diff` 看上游到底改了什么 → 打新 tag →
各设备把 spec 指向新 tag 重装。**冻结的代价**：这份副本不会自动获得上游新增的工具/提示段。

要改表达式本身，请改 `scripts/lib.mjs` 里的 `EXPRESSION` 常量再 `sync`；`verify` 会逐字比对
文件中的表达式与常量，手改生成物会被判失败。

## 卸载

    plugin_manager remove_bundle    target=dsh-compaction-tune

或手工把名字从 `dsh.profile.bundles` 移除，并恢复 profile patch 里 `agent-preset-registry`
的 `default` / `selectedDefault`。

## 注意

- 该 bundle 会覆写 `agent-preset-registry` 的 `default` / `selectedDefault`。profile patch 在
  bundle 层之后应用，所以 **profile patch 里若也写了这两项，以 profile patch 为准**；删掉 profile
  patch 里那两行则回落到 bundle 的选择。
- 选择器语义：**生效默认值是 `selectedDefault ?? default`**（`selectedDefault` 优先）。GUI 里切
  预设时，registry 会把两个字段一起写回 profile patch 的 `agent-preset-registry` 行 —— `default`
  取当时的继承值（装了本 bundle 就是 `standard-tuned`），`selectedDefault` 是你刚选的那个。因此
  `default: standard-tuned` + `selectedDefault: standard` 是正常状态：生效的是 `standard`，
  `standard-tuned` 仍留在选择器里可选，bundle 此刻完全惰性。
- `dsh --dump-config` 只原样打印 `!!js` 表达式，不显示求值结果；要看生效值靠行为/日志，或用
  `node scripts/set-ratio.mjs --show` 的推算表。
- 本机是 `link:` 安装：**别删、别移动仓库目录**，否则 profile 里这条 bundle 解析失败。
- 不要装进不加载 `dsh-agent-preset-registry` 的 profile（例如 `headless`）：补丁找不到目标行，
  每次启动都会打印一条告警，且该预设不会被使用。
