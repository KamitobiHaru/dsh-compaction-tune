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

## 调阈值

推荐写进 `$DSH_HOME/.env`（boot 时灌进 `process.env`），然后重启 dsh：

    cd /data3/zsy/dsh-compaction-tune
    node scripts/set-ratio.mjs 0.001                  # 阈值 0.001，保留比例自动派生 0.0005
    node scripts/set-ratio.mjs 0.001 --retain 0.0005  # 两个值都显式给
    node scripts/set-ratio.mjs --show                 # 只看当前值与推算出的触发 token 数
    node scripts/set-ratio.mjs --unset                # 恢复 bundle 默认 0.4 / 0.16

也可以直接用启动环境变量（优先级高于 `.env`，无需改文件）：

    HARNESS_COMPACTION_THRESHOLD_RATIO=0.001 dsh web

| 变量 | 默认 | 含义 |
|---|---|---|
| `HARNESS_COMPACTION_THRESHOLD_RATIO`（别名 `DSH_COMPACTION_THRESHOLD_RATIO`） | `0.4` | 触发比：`threshold = floor(min(contextWindow × ratio, contextWindow − maxTokens − 65536))`，当会话 token 估算 ≥ threshold 时在 `agent/pre-step` 自动压缩 |
| `HARNESS_COMPACTION_RETAIN_RATIO`（别名同上） | `min(0.16, threshold / 2)` | 压缩后逐字保留的最近尾巴占 `contextWindow − maxTokens` 的比例 |

注意：`.env` 里**不能**用 `DSH_*` 名字 —— DSH 把该前缀视为 bootstrap-only，会让启动直接报错；
所以 `.env` 用 `HARNESS_*`，`DSH_*` 只作为命令行导出的别名（bundle 两个都读，`HARNESS_*` 优先）。

## 0.001 自测配方

1. `node scripts/set-ratio.mjs 0.001`
2. 重启 `dsh web`
3. 开一个**新**会话，发一两轮（累计要超过 1,000 token，并且存在可压缩的历史节点 —— 只有单个大
   `system` 消息时 `selectCompactableRange` 返回 `null`，会静默不压缩）
4. 下一步开始时应该未经 `/compact` 就自动压缩：transcript 出现摘要/检查点、token 数回落；
   服务端 stderr 会出现 `compaction (pressure): shadowed N surface nodes …`
5. 试完 `node scripts/set-ratio.mjs --unset` 再重启

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
