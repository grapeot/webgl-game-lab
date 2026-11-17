# 测试与验证规范（Test Plan）：webgl-game-lab

## 1. 测试分层原则

`webgl-game-lab` 涉及浏览器 CDP 通信、Unity IL2CPP WebGL 线性内存解析以及付费对局边界。测试分为 Node 合成 IL2CPP 堆、Python CDP 控制面、人工对局实测三层。下列条目是覆盖目标；已经执行的范围以 `working.md` 为准。

**硬性约束**：自动化测试与 CI 环境绝不连接真实游戏域名，不依赖外部网络，也不包含任何真实账号凭证或游戏原始资产。

```bash
# 环境准备与依赖安装
uv venv && source .venv/bin/activate && uv pip install -e '.[dev]'

# 运行离线自动化测试套件
pytest
```

## 2. 第一层：Node 合成 IL2CPP 堆测试（离线确定性验证）

Node 20+ 环境仅用于构造可控的合成 `wasm32` 线性内存（`ArrayBuffer` / `HEAPU32` / `HEAPF32` / `HEAPF64`），在无浏览器、无真实游戏 WASM 的条件下验证核心探针逻辑：

1. **类与字段动态发现**：
   - 在合成堆中布置模拟的 `Moe.Ski.SkiSoloGame` 类型元数据与 `FieldInfo` 偏移表。
   - 验证 `discover` 能准确解析 `roundDuration`（`float32`）、`elapsedSeconds`（`float64`）、`seed`、`map`、`runtimePoints` 与 `runtimeTangents` 的偏移，不依赖固定内存地址。
2. **死亡旧实例过滤与歧义阻断**：
   - 构造同时包含已销毁实例（`native = 0`）与当前存活实例（`native != 0`）的合成堆，验证探针能忽略旧实例并唯一绑定活动实例。
   - 构造新场次局号重置为 `1` 的场景，验证探针依靠 `native` 与状态合理性而非局号递增识别新局。
   - 构造存在两个 `native != 0` 活动实例或 0 个活动实例的歧义场景，验证 `hold` / `release` 立即拒绝修改并返回明确错误码。
3. **锁时与平顺释放状态机**：
   - 模拟时间推进（`elapsedSeconds` 递增），验证 `hold` 激活期间 `roundDuration` 同步顺延，计算得出的剩余时间保持恒定，且实例切换后自动解除锁时。
   - 验证 `release` 触发后，`roundDuration` 固定为释放时刻的截止值，后续推进中剩余时间从当前值线性递减，不会跳回初始 `180` 秒导致瞬时归零。
4. **障碍预计算哈希一致性**：
   - 输入已知的 `seed`、`map` 与 `startX`，验证 32 位无符号哈希 `imul` 管线输出的障碍横坐标（`spacing` 三档 `44/38/42`、`jitter` 模数 `25/19/23`、首障碍 `offset = 55`）以及树类别（`map1` mod 4、`map2` mod 3、其余 mod 5 余 0 为树）与参考实现逐项一致。

## 3. 第二层：Python CDP 脱敏选 Target 与错误处理测试

通过本地 Mock CDP 服务或合成响应，测试 Python CLI（`webgl-lab`）的控制面行为与隐私保护边界：

1. **Target 发现与匹配策略**：
    - 验证 `webgl-lab targets`、`--match game.example.com`、`--target <id>` 以及环境变量 `WEBGL_CDP_URL` / `WEBGL_TARGET_MATCH` 的优先级与解析正确性。
   - 当匹配到 0 个或多个标签页且未显式指定 `--target` 时，CLI 应返回结构化 JSON 错误提示，不随机连接标签页。
2. **输出脱敏与网络元数据过滤**：
   - 验证 `install --network` 及 `export --out .local/run.json` 输出的数据结构仅包含数值测量、时间戳与命令枚举。
   - 注入模拟的 Cookie、Authorization Header、URL 查询 Token、玩家昵称与 UID，断言导出 JSON 中相关敏感字段已被彻底剥离或拦截。
3. **只读默认与异常恢复**：
   - 验证未调用 `hold` 时，`inspect`、`discover`、`install`、`status`、`map` 不向合成堆写入任何计时字段。
   - 验证 CDP 连接断开、目标页面刷新或符号混淆不支持时，CLI 返回非零退出码与清晰诊断 JSON。

## 4. 第三层：人工付费对局实测验收清单（Manual Live Verification）

当需要在真实浏览器环境中对游戏进行实测时，必须由用户本人在自备浏览器（如 `http://127.0.0.1:9222`）完成登录与开局操作。Agent 与操作者按以下清单核验：

1. **开局前静态准备**：在消耗入场资格前，用 `targets` 与 `preflight` 确认连通性和元数据。元数据可用时 `install` 可等待实例；不可用时如实记录未就绪。不用付费重开局代替脚本调试。
2. **存活实例唯一性确认**：开局后执行 `status`，核对返回的实例满足 `native != 0`、`roundDuration` 初始为 `180` 秒（`float32`）、`elapsedSeconds`（`float64`）随时间递增。
3. **锁时双重验证（Fresh 读数 + UI）**：
   - 执行 `hold` 后，间隔数秒采集两次以上 `status` 样本。
    - 只有当两次样本的 `result.state.x` 与 `result.state.elapsed` 增长、`result.state.remaining` 基本恒定，且 UI 同步停留在同一数值时，才判定锁时生效；不能仅凭命令返回 `ok` 就宣称锁住。
4. **释放与跨局解除验证**：
   - 执行 `release` 后再次连续采样，确认剩余时间从锁定值继续下降（如从 `59` 秒降至 `53` 秒）。
   - 本局结束或重开新局后，确认上一局的 `hold` 状态已自动解除，不会跨局自动锁定。
5. **服务端结算观察记录**：如实记录对局结束时的客户端画面（例如是否出现等待结算界面）与最终结果，独立验证服务端是否接受该局分数，不在报告中把客户端锁时等同于服务端结算通过。
