# AeroFlow Sky

**全球高空急流 · 跨洋航线"借风"推演器**

同一个机型、同一条航线，为什么向东飞只要 5 小时 22 分，向西飞却要 6 小时 32 分？
这个工具用 NOAA GFS 的真实高空风场把答案画出来。

---

## 它做什么

| 能力 | 实现 |
| --- | --- |
| 高空急流粒子流 | 512² 粒子在 GPU 上 ping-pong 平流，经纬空间累积拖尾后贴回球面 |
| 借风 vs 大圆 | 沿大圆展开横向走廊做动态规划，用真实风场求地速积分最小化总时间 |
| 顺逆风反差 | 同一航线双向求解，直接给出地速、时长与差值 |
| 晴空湍流预警 | Ellrod TI1 = 水平变形 × 垂直风切变，烘焙进数据通道 |
| 大圆沙盒 | 任选两点、拖动高度层，实时重算三条路线 |
| 实时航班 | ADS-B 经 Cloudflare Pages Function 代理；不可用时明确标注为风场模拟 |
| **机场网络图层** | 520 个机场单次 draw call 渲染，42 个枢纽带琥珀光晕，随缩放自适应点径 |
| **航班详情面板** | 点选任意航班查看机型、遥测，并用当前风场重解风三角（真空速 vs 地速对比） |
| **大圆测距工具** | 两点测距，同时给出大圆、恒向线、初始方位、最大纬度偏移 |
| **恒向线对照** | 完整 Mercator 恒向线实现，作为「为什么不走等角航线」的量化反例 |

## 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:5183
```

`public/data/` 里已包含一次烘焙好的数据（2026-10-31 06Z GFS 周期），
所以**不联网也能直接跑**。

## 重新烘焙数据

气象数据每 6 小时更新一次。要换成最新预报：

```bash
# 1. GFS 高空风场（需要 numpy / xarray / cfgrib / eccodes）
pip install numpy xarray cfgrib eccodes
python scripts/bake_wind.py --hours 0,6,12,24,36 --levels 200,250,300

# 2. 机场、航线与海岸线
node scripts/bake_data.mjs
```

第一条命令会连 NOAA NOMADS，下载 0.25° 的 U/V/温度子集，
算出 CAT 指数，降采样后写成 `public/data/wind-*.bin`（约 3.5 MB）。

## 架构

```
scripts/bake_wind.py       GRIB2 → AFLW float16 二进制（含 Ellrod CAT）
scripts/bake_data.mjs      OpenFlights + Natural Earth → 精简 JSON
src/core/atmos.ts          风三角、ISA 大气、Mach、机型档案
src/core/geo.ts            大圆、slerp、切平面基
src/data/windField.ts      AFLW 解析 + 三线性采样（时间 × 层次 × 空间）
src/sim/routeEngine.ts     大圆 / 借风 DP / 恒向线 + 湍流分段
src/render/JetParticles.ts GPU 粒子：状态纹理 + 拖尾缓冲 + 球面合成
src/render/globe.ts        显式等距圆柱 UV 球体、大气辉光、星空
src/ui/                    React 面板层（不含任何 three.js 对象）
functions/api/flights.ts   ADS-B 代理（带边缘缓存）
```

### 数据正确性保障

航路推演的数学层有一套**独立于 UI 的回归测试**（`tests/dataQuality.test.ts`，46 项）。
每一条都对应一个曾经真实存在、且旧测试没抓到的缺陷——这些 bug 都不报错、
不崩溃，只是安静地给出一个"看起来合理"的错误数字：

| 曾存在的缺陷 | 后果 | 现在的不变量 |
| --- | --- | --- |
| 恒向线用大圆初始方位角推进 | JFK–LHR 报 7560 km（真值 5758），双向不等 | Mercator 方位角 + 解析长度，双向严格相等 |
| 航路积分先累加再 push | 首点距离 115 km（应为 0），时长偏低 2–3% | `points[0].distance === 0`，时长与逐段重算一致 |
| 侧风超过真空速被 clamp 掩盖 | 返回假地速 50 m/s 而非报不可行 | `infeasible` 显式置位，DP 跳过该航段 |
| 大圆 `extraDistance` 基准传 0 | 显示「绕飞 +5540 km」 | 大圆自身 extraDistance 恒为 0 |
| DP 偶数偏移无零偏移列 | 可行解集不含大圆，凭空"优化" | 强制奇数；走廊=0 时精确等于大圆 |
| 一阶平滑惩罚按每站收费 | 有效绕飞也被否决，DP 退化回大圆 | 只罚方向反转（持续绕飞免费，锯齿重罚） |
| CAT 阈值在 6 处用 6 个数 | 同一航段两个面板给出 29% 与 35% | 单一 `CAT_LEVELS` 常量表 + 距离加权 |
| `clamp(NaN)` 原样返回 NaN | NaN 静默传播到地速/时长 | `clamp` 收束 NaN；采样入口拒绝非有限坐标 |
| NaN 湍流被判为 `severe` | 未知数据被渲染成"最危险" | 只对 NaN 归零，±Infinity 仍判 severe |

### 几个关键设计决定

**为什么自建球体几何**：three.js 的 `SphereGeometry` 的 u 轴是 `lon = 180 − 360u`，
与等距圆柱贴图常用的 `u = (lon+180)/360` 正好镜像。本项目的风场纹理、拖尾缓冲、
海岸线遮罩共用一套经纬索引，任何一处偷偷翻转都会造成层间错位，所以直接构造
自洽的 UV。

**为什么拖尾存在经纬空间而不是屏幕空间**：拖尾长度就与帧率解耦了，
144 Hz 和 30 Hz 看到的是同样长度的流线；而且跨 180° 经线和极区压缩都不会产生接缝。

**为什么 DP 结果不优于大圆时回退到大圆**：DP 在 34 个站点 × 19 条横向候选上做离散搜索，
而大圆是 48 段稠密折线，两者对风的采样点不同，DP 可能"慢几秒"。这在物理上没有意义
（大圆本身就在 DP 的可行解集合里），所以加了一条硬约束：借风航线永不慢于大圆。

**为什么实时航班可以是"模拟"**：OpenSky 与 adsb.lol 的响应都不带 CORS 头，
纯静态托管下浏览器无法直连。代理不可用时，前端用**真实风场 + 真实机场对**
现场合成航班，并在 UI 上明确标注"风场模拟"——绝不用假数据冒充实时。

## 数据来源与许可

| 数据 | 来源 | 许可 |
| --- | --- | --- |
| 高空风场 / 温度 | NOAA NCEP GFS 0.25°，经 NOMADS filter 子集 | 美国联邦政府作品，公有领域 |
| 机场与航线 | [OpenFlights](https://openflights.org/data.html) airports.dat / routes.dat | ODbL |
| 海岸线 | [Natural Earth](https://www.naturalearthdata.com/) 1:50m land | 公有领域 |
| 实时航班（可选） | OpenSky Network / adsb.lol | 见各自条款 |

## 部署

静态托管即可（Cloudflare Pages 推荐）：

```bash
npm run build
# 把 dist/ 与 functions/ 一起交给 Cloudflare Pages
```

若要启用真实航班，在 Pages 项目里配置环境变量：

| 变量 | 说明 |
| --- | --- |
| `OPENSKY_CLIENT_ID` | OpenSky OAuth2 客户端 ID（可选，用于提高限额） |
| `OPENSKY_CLIENT_SECRET` | 对应密钥 |

未配置时会回退到免密钥的 adsb.lol；两者都失败则前端降级为模拟数据。

## 测试

```bash
npm test          # 98 项：手性、大圆、恒向线、风三角、采样、DP、CAT、性能
npm run typecheck
npm run build
```

测试使用 `public/data/` 中的真实烘焙数据，不是 mock。三个测试文件分工：

- `coordinateHandedness.test.ts`（13 项）—— 坐标系手性：东在右、北在上、切平面基正交
- `routeEngine.test.ts`（33 项）—— 推演逻辑：航线合理性、双向对比、合成急流绕飞
- `dataQuality.test.ts`（46 项）—— 数据正确性：上表每一条缺陷的回归保护

## 已知限制

- **只有 3 个气压层**（200 / 250 / 300 hPa ≈ FL387 / FL340 / FL300）。
  层间是线性插值，不是真实的连续廓线。加层需要改 `bake_wind.py --levels` 并重新烘焙。
- **垂直切变用标准大气高度近似**，没有逐格点的位势高度场。Ellrod TI1 因此是
  相对指数，不是绝对湍流强度。
- **推演是稳态优化**：一条航线用同一个预报时刻的风。真实航班会随飞行推进
  不断更新风场，Meteo 路由实际是四维的。
- **不含爬升/下降段**：所有点都在巡航高度上。爬升剖面只用于图表观感。
- **ADS-B 无 CORS**：必须部署 `functions/api/flights.ts` 代理才能拿到真实航班。
- 在无头/被遮挡的浏览器窗格里 Chromium 会把 `requestAnimationFrame` 节流到近零帧，
  自动化验收时需用 `window.__aeroStep(n)` 手动推进。

## 调试钩子

```js
window.__aeroState()      // { running, frames, hasJet, levelPos, camera }
window.__aeroStep(120)    // 同步推进 120 帧并渲染（用于回归与截图）
```
