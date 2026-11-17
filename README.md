# webgl-game-lab

`webgl-game-lab` 是一套面向 Unity IL2CPP WebGL（`wasm32`）游戏的运行时观测与计时实验工具，提供命令行工具 `webgl-lab` 与配套 AI Agent Skill。它通过连接用户本地已登录的 Chrome DevTools Protocol（CDP）浏览器，在内存中动态解析未混淆的 IL2CPP 类与字段，完成存活实例状态读取、赛道几何与障碍预测，以及单局倒计时锁定实验。

开源协议：MIT
项目地址：https://github.com/grapeot/webgl-game-lab

## 用途与真实边界

`webgl-game-lab` **不是通用所有游戏的万能外挂**，使用时需明确以下技术边界：

- **特定运行时适配**：当前适配包含未混淆类名与字段名的 Unity IL2CPP WebGL `Moe.Ski.SkiSoloGame` 运行时，不支持任意 Unity 版本或混淆构建。计时机制经过手工原型真实对局验证；本 CLI 已通过离线回归、真实页面预检及无存活实例拒绝测试，尚未额外消耗对局验证重构后的完整流程。游戏更新后须重新预检。
- **手工登录与自备浏览器**：工具只连接用户已经手动打开并完成登录的 CDP 浏览器实例（例如 `http://127.0.0.1:9222`），不会代为启动或关闭浏览器，不会保存账号凭证，也不会自动创建付费对局。
- **默认只读与单局显式控制**：`inspect`、`discover`、`install`、`status`、`map` 均为只读操作。只有用户显式执行 `hold` 时，工具才会调整当前唯一存活实例的 `roundDuration`；当该局实例销毁或重开新局时，锁时自动解除，不会延伸到下一局。工具不提供自动开局、充值、买道具、改分数、领奖励、发弹幕或向服务器提交成绩的功能。
- **服务端结算需独立验证**：客户端锁定倒计时仅改变本地剩余时间计算，不代表服务端认可修改后的对局时长或成绩。本项目没有服务端结算通过的证据。

## 环境要求与安装

- **Python**：3.11+
- **Node.js**：20+（仅用于运行离线合成 IL2CPP 堆测试，日常使用 CLI 连接浏览器时不需要）

在项目根目录创建虚拟环境并安装：

```bash
uv venv && source .venv/bin/activate && uv pip install -e '.[dev]'
```

## 快速上手

### 1. 准备浏览器会话
在本地启动带有远程调试端口的 Chromium / Chrome 浏览器（示例端口 `9222`），手动登录并打开目标游戏页面（以下用 `game.example.com` 作为示例域名）。

可通过环境变量或命令行参数指定连接目标：
- `WEBGL_CDP_URL` 或 `--cdp`：CDP 地址，如 `http://127.0.0.1:9222`
- `WEBGL_TARGET_MATCH` 或 `--match`：匹配页面 URL 子串，如 `game.example.com`
- `--target`：显式指定 CDP Target ID

### 2. 常用命令契约

所有命令均向标准输出返回 JSON，本地导出文件默认保存在 `.local/` 目录：

```bash
# 1. 列出当前浏览器中的可用标签页
webgl-lab targets

# 2. 只读检查顶层 JS 对象、Unity 实例与脚本清单（外层加载器检查）
webgl-lab --match game.example.com inspect

# 3. 在 IL2CPP HEAP 中动态解析 Moe.Ski.SkiSoloGame 类、字段偏移与当前存活实例
webgl-lab --match game.example.com preflight
webgl-lab --match game.example.com discover

# 4. 安装只读运行采集器（可选 --network 采集脱敏数值与命令种类元数据）
webgl-lab --match game.example.com install
webgl-lab --match game.example.com install --network

# 5. 读取当前唯一存活实例的实时计时与坐标状态
webgl-lab --match game.example.com status

# 6. 读取赛道 runtimePoints / runtimeTangents 并根据当前 seed 与 map 预测障碍
webgl-lab --match game.example.com map

# 7. 锁定当前存活实例的倒计时（保持物理运动，仅顺延 roundDuration）
webgl-lab --match game.example.com hold

# 8. 固定当前截止时间，让倒计时从当前剩余秒数平顺恢复递减
webgl-lab --match game.example.com release

# 9. 停止采集器并同步释放倒计时
webgl-lab --match game.example.com stop

# 10. 导出脱敏后的结构化运行轨迹
webgl-lab --match game.example.com export --out .local/run.json

# 11. 按需导出当前浏览器已加载的运行时 WASM 字节码供离线分析
webgl-lab --match game.example.com wasm-export --out .local/game.wasm
```

`preflight` 不要求活动实例，只检查已加载的元数据。`install` 可在无活动实例时进入观察等待；`hold` 始终要求唯一存活且正在运行的实例。若游戏尚未加载所需元数据，预检会报告不支持，而不是声称准备完成。网络观察只覆盖安装之后的 `fetch`，以及首次发送后开始监听的 WebSocket，不包含 XHR 和历史流量。导出文件仍应保留在本地；网络元数据可能包含目标站点的域名。

也可以使用 `--target <target_id>` 精确指定标签页，例如：

```bash
webgl-lab --cdp http://127.0.0.1:9222 --target <target_id> status
```

## 为 AI Agent 安装 Skill

如果你使用 Claude Code、Codex、Cursor 或 OpenCode 等 AI 编程助手，可以直接把本仓库链接 `https://github.com/grapeot/webgl-game-lab` 交给你的 Agent，让它完成安装与接入。

- **唯一公开根 Skill**：[`skills/webgl-game-lab/SKILL.md`](skills/webgl-game-lab/SKILL.md)（按需引用 [`skills/webgl-game-lab/references/ski-runtime.md`](skills/webgl-game-lab/references/ski-runtime.md)）。
- **接入方式**：负责安装的 Agent 应先读取当前工作区的 `AGENTS.md` / `CLAUDE.md` 及目录路由文件，按工作区自身的约定将根 Skill 加入发现链（若有技能索引 `INDEX.md` 则更新索引条目，若无则写入简短路由指针）。
- **不绑定特定打包格式，不污染全局配置**：本仓库不强制绑定某一家客户端的私有插件封装格式，也不会在安装时自动修改用户的全局家目录配置。

## 相关文档

- [产品需求文档（PRD）](docs/prd.md)
- [技术设计文档（RFC）](docs/rfc.md)
- [测试与验证规范（Test Plan）](docs/test.md)
- [工作进展与验证记录（Working Log）](docs/working.md)
