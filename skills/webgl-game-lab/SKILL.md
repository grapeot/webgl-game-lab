---
name: webgl-game-lab
description: 面向 Unity IL2CPP WebGL（wasm32）游戏的运行时观测、滑雪关卡地图分析与单局倒计时实验技能。当用户需要通过本地 CDP 浏览器对 Unity WebGL 游戏执行存活实例发现、赛道与障碍预计算、只读轨迹采集或受控锁时实验时加载。
---

# WebGL Game Lab Skill

本技能赋能 Agent 使用 `webgl-lab` CLI 对用户已登录的本地 CDP 浏览器中的 Unity IL2CPP WebGL 游戏进行内存级观测与受控计时实验。当前适配未混淆的 `Moe.Ski.SkiSoloGame`。原型有真实对局证据，重构 CLI 的验证范围见 [../../docs/working.md](../../docs/working.md)；专项内存布局、哈希公式见 [references/ski-runtime.md](references/ski-runtime.md)。

## 1. 适用条件与能力边界

- **触发场景**：用户要求观测 Unity WebGL 游戏运行态、分析滑雪关卡地形与障碍规律、导出脱敏运行轨迹，或在单局内执行倒计时锁定与平顺释放实验。
- **核心边界**：
  - 仅支持类名与字段名未经混淆的 `Moe.Ski.SkiSoloGame`（`wasm32`），不支持任意 Unity 版本，也不是通杀所有游戏的万能外挂。
  - 用户自备并手动登录 CDP 浏览器（示例 `http://127.0.0.1:9222`，目标域名示例 `game.example.com`）。Agent 不启动或关闭浏览器，不触碰账号凭证，不自动开局、充值、买道具、改分数、领奖励、发弹幕或提交成绩。
   - 涉及付费对局时，先做 `targets` / `preflight`，可用时安装等待中的只读采集器，不用付费重跑代替调试。元数据尚未加载时如实报告未就绪，不承诺已能锁时。

## 2. 关键依赖顺序

在不把操作写成僵硬流水线的前提下，必须遵守以下先后依赖关系：

1. **先区分外层加载器与核心逻辑**：`inspect` 看到的顶层 JS 和脚本标签只是 WebGL 加载器外壳，不能据此宣称已读懂游戏核心逻辑；核心规则必须以 IL2CPP 元数据、WASM 函数体与运行态状态互证为准。
2. **先确认唯一存活实例，再修改**：`preflight` 只检查元数据，`install` 可以等待实例。进入对局后通过 `discover` / `status` 确认唯一存活实例（`native != 0`）；歧义或未进入活动局时不能执行 `hold`。页面刷新会移除探针，必须重装。
3. **锁时后走 `release` 平顺恢复**：需要恢复倒计时时使用 `release`（或 `stop`），将截止线固定在当前剩余秒数；绝不直接把 `roundDuration` 改回初始 180 秒，以免超时状态下瞬间触发结束。

## 3. 可验证验收标准（Verification Criteria）

执行任何观测或计时操作后，Agent 必须按以下客观标准验收，不得只凭命令返回成功即下结论：

- **唯一存活实例验收**：确认绑定对象的 `native != 0`、初始化完成、`roundDuration`（`float32`，默认 180 秒）与 `elapsedSeconds`（`float64`）数值合理。注意旧局销毁后对象仍留在 HEAP 中（但 `native = 0`），且新开场次会将局号重置为 `1`，不能用局号变化作为唯一绑定依据。
- **锁时（`hold`）验收**：必须在两个不同时间点采集 fresh `status` 样本，确认 `result.state.x` 与 `result.state.elapsed` 持续增长，而 `result.state.remaining` 基本保持恒定（200ms 采样允许约 0.4 秒波动），并结合页面 UI 倒计时核对。原型实测约 59 秒，不是每次调用的预期值。实例更换或销毁时锁时自动解除，不跨局延续。
- **释放（`release`）验收**：执行 `release` 后再次间隔采样，确认 `remaining` 从锁定值开始继续递减（如实测从 59 秒降至 53 秒）。
- **地图确定性声明边界**：赛道 `runtimePoints` / `runtimeTangents` 与障碍序列预计算（详见 [references/ski-runtime.md](references/ski-runtime.md)）严格绑定当前存活实例的 `seed`、`map` 模板编号及当前已验证的游戏版本。跨场次必须重读 `seed` 与 `map`，不得向用户外推「全局所有场次固定不随机」或声称适用于其他游戏。
- **服务端结算独立验收**：客户端修改 `roundDuration` 并不保证服务器接受该局成绩。若未完成服务端结算核验，必须明确标注「服务端是否认可待独立验证」。

交付至少包含：两次 `result.state.binding`（pointer/native）、采样间隔、`x/elapsed/remaining` 的差值、UI 是否核验、release 后倒计时趋势，以及 `server_settlement: "unverified"` 或可核对的结算证据。导出路径指向本地 `.local/`；探针安装成功或 `hold` 返回 `ok` 不能替代上述验收。字段 `elapsed` 对应游戏的 `elapsedSeconds`，`duration` 对应 `roundDuration`。

## 4. 已知陷阱与资源护栏

1. **全局暂停不是锁倒计时**：冻结 Unity 主循环会让角色滑行与物理更新一并停止；锁倒计时必须只调整 `roundDuration`。
2. **面板移动导致静态截图裁剪失效**：游戏内 UI 面板位移会让固定坐标截图裁剪错位，应优先读取实例内存状态并结合 DOM 边界定位。
3. **大体积 WASM 局部反编译**：通过 `wasm-export --out .local/game.wasm` 导出的字节码约 42MB（且仅代表运行时字节码而非原始 C# 源码）。离线分析时只提取并反编译目标函数体，严禁将整个模块反编译成巨型文本文件。
4. **产物与网络脱敏**：所有导出产物默认写入 `.local/`（如 `export --out .local/run.json`）。`install --network` 仅在需要时显式开启，只记录数值测量与命令类别，不采集或输出原始请求/响应、Cookie、Token、昵称或 UID。

## 5. 命令速查与深入参考

- 连接配置：环境变量 `WEBGL_CDP_URL` / `WEBGL_TARGET_MATCH`，或参数 `--cdp` / `--match` / `--target`。
- 核心命令：`webgl-lab targets` | `inspect` | `preflight` | `discover` | `install [--network]` | `status` | `map` | `hold` | `release` | `stop` | `export --out .local/run.json` | `wasm-export --out .local/game.wasm`。
- `Moe.Ski.SkiSoloGame` 字段规格、存活判据、赛道参数与 32 位无符号障碍哈希算法详见：[references/ski-runtime.md](references/ski-runtime.md)。
