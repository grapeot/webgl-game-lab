# 技术设计文档（RFC）：Unity IL2CPP WebGL 运行时适配器与安全契约

## 1. 架构概览

`webgl-game-lab` 采用「本地 CDP 连接层 + 页面内轻量运行时探针 + Python CLI JSON 控制面」三层架构。工具本身不托管浏览器生命周期，也不内置任何游戏专有资产或硬编码指针，所有符号解析均在用户已打开的目标页面内存中动态完成。

```
+-----------------------+       CDP (HTTP / WebSocket)       +-----------------------------------+
|  Python CLI           | <--------------------------------> | 用户自备浏览器 (127.0.0.1:9222)   |
|  `webgl-lab`          |   --cdp / --match / --target       | 目标页面: game.example.com        |
+-----------------------+                                    +-----------------------------------+
           |                                                                   |
           v                                                                   v
+-----------------------+                                    +-----------------------------------+
| 本地脱敏产物 (.local/)|                                    | Unity IL2CPP wasm32 HEAP          |
| - run.json            |                                    | - TypeInfo / FieldInfo 动态解析   |
| - game.wasm (按需)    |                                    | - Moe.Ski.SkiSoloGame 存活实例    |
+-----------------------+                                    +-----------------------------------+
```

## 2. 运行时环境与 CLI 接口契约

- **运行环境**：Python 3.11+（主 CLI 与 CDP 通信），Node 20+（仅用于离线合成 IL2CPP 堆测试，不参与线上连接）。
- **安装方式**：
  ```bash
  uv venv && source .venv/bin/activate && uv pip install -e '.[dev]'
  ```
- **连接配置**：
  - 环境变量：`WEBGL_CDP_URL`（默认回环示例 `http://127.0.0.1:9222`）、`WEBGL_TARGET_MATCH`（如 `game.example.com`）。
  - CLI 参数：`--cdp <url>`、`--match <substring>`、`--target <target_id>`。
- **稳定子命令**：
  ```bash
  webgl-lab targets
   webgl-lab --match game.example.com inspect
   webgl-lab --match game.example.com preflight
  webgl-lab --match game.example.com discover
  webgl-lab --match game.example.com install [--network]
  webgl-lab --match game.example.com status
  webgl-lab --match game.example.com map
  webgl-lab --match game.example.com hold
  webgl-lab --match game.example.com release
  webgl-lab --match game.example.com stop
  webgl-lab --match game.example.com export --out .local/run.json
  webgl-lab --match game.example.com wasm-export --out .local/game.wasm
  ```
- **输出规范**：所有子命令向标准输出打印结构化 JSON；轨迹导出与字节码导出默认存放在 `.local/` 下。

## 3. IL2CPP 内存发现与存活实例判定

### 3.1 动态类与字段解析（`discover`）
Unity IL2CPP WebGL 将托管对象分配在 `wasm32` 线性内存（`HEAP8` / `HEAPU32` / `HEAPF32` / `HEAPF64`）中。由于每次构建或重加载后内存基址都会变动，`webgl-lab` 不使用固定指针，而是在未混淆的运行时元数据中检索命名空间 `Moe.Ski` 下的 `SkiSoloGame` 类描述结构，并遍历其 `FieldInfo` 表获取各字段的字节偏移量。若目标游戏开启了符号混淆或更换为不兼容的 Unity 版本，解析器会直接报告不支持并终止后续操作。

`preflight` 只要求类型元数据可用，不要求活动实例。`install` 可进入未绑定的观察状态；`discover` / `status` 仍要求唯一存活实例。所读字段必须满足预期类型、非 static/literal、宽度与对齐正确且不重叠，不能把同名静态变量误当实例成员写入。

### 3.2 存活实例过滤与唯一性不变量
在多次重开局或跨场次运行后，线性内存中会同时残留已结束对局的托管对象。单靠对象头类名匹配或托管指针非 0 无法判断该对象是否代表当前活动局。适配器强制执行以下过滤条件：
1. **底层指针校验**：托管对象关联的 `native` 指针必须非 0（`native = 0` 代表底层 C++ 对象已销毁）。
2. **字段合理性校验**：检查初始化标志位、单局基础时长（如默认 `roundDuration = 180.0`，`float32`）、已进行时间（`elapsedSeconds`，`float64`）及角色坐标范围。
3. **局号重置防坑**：新建场次会将局号重置为 `1`，因此不能把局号递增或变化当作实例切换的唯一依据，每次操作前都必须重新扫描并确认当前活动实例。
4. **唯一性门禁**：只有当筛选出唯一存活实例时，才允许执行 `hold` 或 `release`。若检测到 0 个或多个疑似存活实例，工具立即禁用写入并报错，绝不盲猜目标对象。

## 4. 倒计时控制机制（`hold` / `release` / `stop`）

### 4.1 为什么不采用全局暂停
若直接暂停 Unity 主循环、`Time.timeScale` 或 `requestAnimationFrame`，角色物理运动与位置更新会一并停滞，无法达到「保持滑行同时固定剩余时间」的实验目的。

### 4.2 `roundDuration` 调节与平顺释放
在 `Moe.Ski.SkiSoloGame` 中，单局时长 `roundDuration` 存储为 `float32`（默认 180 秒），已用时间 `elapsedSeconds` 存储为 `float64`，游戏内部 getter 通过两者差值计算剩余秒数（已实测将 `roundDuration` 临时改为 `360` 时，内部 getter 立即返回剩余 `180` 秒，验证后还原）。

- **`hold`（锁时）**：探针每 200ms 根据当前唯一存活实例的 `elapsedSeconds` 动态顺延 `roundDuration`，使剩余时间保持在触发时刻附近。当该实例 `native` 归零、更换新实例或已用时间发生重置时，锁时自动解除，不延续到下一局。约 59 秒的真实对局证据来自手工原型；重构 CLI 的同类状态变化通过合成堆回归验证。
- **`release`（释放）**：若在 `elapsedSeconds` 已超过 180 秒时直接将 `roundDuration` 恢复为初始值 `180`，差值会瞬间归零并导致对局立即结束。实现仅清除锁时状态，保留最近写入的截止线，不再顺延，倒计时从现值继续递减。原型实测释放后从 `59` 秒降至 `53` 秒；重构 CLI 的活动局端到端验证尚未执行。
- **`stop`（停止）**：卸载采样定时器并同步执行 `release` 逻辑。

## 5. 赛道几何与障碍确定性预测（`map`）

### 5.1 赛道采样点
通过读取存活实例中的 `runtimePoints` 与 `runtimeTangents` 数组，可获取当前局完整赛道曲线。在已核实的匿名实测样本中，`runtimePoints` 包含 `352` 个采样点，终点横坐标为 `7000`。地形点阵通常在对局初始化阶段一次性生成。

### 5.2 障碍生成哈希算法
当前已验证版本使用 3 套参数模板（对应 `spacing` 三档 `44` / `38` / `42`，`jitter` 模数三档 `25` / `19` / `23`），首障碍偏移固定为 `offset = 55`。对第 $i$ 个障碍（从 0 开始），其横坐标与树类别由 32 位无符号整数（unsigned 32-bit）哈希决定：

```javascript
// h 全程按 32 位无符号整数 (>>> 0) 处理
let h = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) >>> 0;
h = Math.imul((h >>> 13) ^ h, 1274126177) >>> 0;
h = ((h >>> 16) ^ h) >>> 0;

const x = startX + 55 + i * spacing + (h % jitter);
```

树类别判定规则：
- `map == 1`：`h % 4 === 0` 为树
- `map == 2`：`h % 3 === 0` 为树
- 其余地图模板：`h % 5 === 0` 为树

**边界说明**：「3 套模板」并不意味着每局地图完全随机不可测；只要从当前存活实例读出 `seed` 与 `map`，就可按本版本公式预测障碍位置与类别。跨场次这些值可能改变或重复，每局都必须重新读取；公式仍需在游戏更新后重新核实。

## 6. 踩坑记录与设计护栏

1. **外层加载器不等于核心逻辑**：`inspect` 读到的顶层 JS 与 HTML 脚本只是加载外壳。所有关于计时、物理和地图的判断必须通过 WASM 函数反编译、IL2CPP 元数据与运行态数值三方互证。
2. **局部反编译控制开销**：目标运行时 WASM 体积约 `42MB`。离线验证具体逻辑时，只针对目标函数索引提取并反编译对应函数体，禁止将整包反编译为巨型文本文件。
3. **DOM 边界优先于固定截图裁剪**：游戏内悬浮面板移动会导致固定像素裁剪坐标失效，UI 核验应结合实例内存读数与 DOM 元素实时边界。
4. **服务端结算未知性**：修改本地 `roundDuration` 只能延长客户端运行时间。尚未取得服务端接受该成绩的证据，结算状态为待独立验证。
5. **隐私与网络脱敏**：`--network` 为显式 opt-in，仅统计消息频率、字节数与命令枚举，丢弃原始 payload、Cookie、Token 与玩家标识。
