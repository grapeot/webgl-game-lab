# AGENTS.md - 项目维护与协作约束

## 1. 项目定位

`webgl-game-lab` 是面向 Unity IL2CPP WebGL（`wasm32`）运行时的观测与受控计时实验工具库，包含命令行入口 `webgl-lab` 与单个根 Agent Skill [`skills/webgl-game-lab/SKILL.md`](skills/webgl-game-lab/SKILL.md)。当前版本专门适配类名与字段名未混淆的 `Moe.Ski.SkiSoloGame` 运行时，不作为通用游戏的万能修改器。

## 2. 仓库卫生与版本控制硬约束

1. **只提交原创工具与合成测试**：版本库仅收录本项目的 Python/JS 源码、基于 Node VM 的合成 IL2CPP 堆测试、Mock CDP 测试以及脱敏技术文档。
2. **严禁入库外部资产与会话数据**：从浏览器导出的运行时 WASM 字节码（`.wasm`）、游戏贴图、音频、真实页面截图、录屏、原始网络抓包以及运行轨迹日志一律存放在 `.local/` 下，严禁提交进 Git。
3. **严禁出现私有与敏感信息**：文档、代码、测试 fixture 与 commit 消息中不得包含个人本机绝对路径、真实账号、房间号、真实生产域名、Cookie、登录 Token、玩家昵称或 UID。文档与测试统一使用 `game.example.com` 与标准回环示例 `http://127.0.0.1:9222`。
4. **单一根 Skill 架构**：公开的技能入口只有 [`skills/webgl-game-lab/SKILL.md`](skills/webgl-game-lab/SKILL.md)，专项运行时细节放在相对路径 [`skills/webgl-game-lab/references/ski-runtime.md`](skills/webgl-game-lab/references/ski-runtime.md) 中按需加载，不拆分多个并列根 Skill，也不在脚本中自动写入用户全局配置。
5. **分支与审阅要求**：Git 默认分支为 `master`。任何代码、契约或文档变更必须通过离线测试套件验证，并经过独立审阅（Fresh Mind Review）后方可合入。

## 3. 开发环境与测试命令

- **Python**：3.11+
- **Node.js**：20+（仅用于离线合成 IL2CPP 堆测试）

```bash
# 创建虚拟环境并安装开发依赖
uv venv && source .venv/bin/activate && uv pip install -e '.[dev]'

# 运行离线自动化测试（绝不连接真实外部游戏服务器）
pytest
```

## 4. 操作与运行时安全边界

1. **零消费权限**：Agent 与 `webgl-lab` 均无权启动或关闭用户浏览器，无权自动开局、充值、购买道具、修改分数、领取奖励、发送弹幕或提交结算成绩。涉及付费入场的游戏时，必须在开局前准备好采集与验证逻辑，不得用付费重开局代替调试。
2. **存活实例唯一性门禁**：HEAP 中常残留已销毁的旧实例（`native = 0`），且新场次会将局号重置为 `1`。执行任何状态读取或 `hold` / `release` 操作前，必须验证当前存在唯一存活实例（`native != 0` 且初始化、时长、坐标字段合理）；遇到多实例或零实例歧义时立即终止修改。
3. **锁时验证标准**：`hold` 只修改当前存活实例的 `roundDuration`，不暂停 Unity 全局运动；实例销毁或换局时自动解除。验证锁时必须同时依据连续两次以上 fresh 采样（`position` 与 `elapsedSeconds` 增长而剩余时间恒定）以及页面 UI 读数，禁止仅凭命令返回成功就宣告锁定。
4. **局部反编译控制成本**：面对约 42MB 的运行时 WASM，离线核验逻辑时只提取并反编译目标函数体，禁止全量反编译成巨型文本文件。

## 5. 文档导航

- 需求与边界定义：[docs/prd.md](docs/prd.md)
- 架构与算法设计：[docs/rfc.md](docs/rfc.md)
- 测试分层与验收清单：[docs/test.md](docs/test.md)
- 当前重构与实测记录：[docs/working.md](docs/working.md)
- 根 Skill 入口：[skills/webgl-game-lab/SKILL.md](skills/webgl-game-lab/SKILL.md)
- SkiSoloGame 运行时参考：[skills/webgl-game-lab/references/ski-runtime.md](skills/webgl-game-lab/references/ski-runtime.md)
