# 虾皮台湾选品库（网站）

纯前端静态站。从 GitHub 仓库读取选品数据，按月销 / 价格 / 店铺筛选排序，无需后端、无需登录。

**在线体验**：https://23ccf.github.io/shopee-site/

---

## 它是什么

和 [shopee-ext](../shopee-ext)（Chrome 扩展）配合使用：

```
逛虾皮 → 扩展自动录制 → 推到 GitHub 选品库 → 本网站读取展示
```

你也可以把它当成「任意 GitHub 商品数据的查看器」——只要改一下数据源配置，就能看别人的选品库。

---

## 5 分钟部署（三种方式任选）

### 方式一：直接用现有的

访问上面的在线地址即可，数据来自 `23ccf/shopee-sync`。

### 方式二：Fork 后部署到自己账号

1. Fork 本仓库
2. 编辑 `data/source.json`，把 `catalog_url` 改成你自己的数据仓库地址
3. 用任意静态托管部署：
   - **Vercel**：导入仓库，一路 Next 即可
   - **Netlify**：拖 `index.html` 所在目录进去
   - **GitHub Pages**：Settings → Pages → 选 `main` 分支根目录
   - **Cloudflare Pages**：连接仓库，构建命令留空

### 方式三：本地打开

```bash
# 起个静态服务器（因为要 fetch 本地 json，不能用 file:// 直接打开）
python -m http.server 8080
# 浏览器访问 http://localhost:8080
```

---

## 配置数据源

编辑 `data/source.json`：

```json
{
  "catalog_url": "https://raw.githubusercontent.com/你的用户名/你的仓库/main/catalog.json",
  "sync_url": "https://raw.githubusercontent.com/你的用户名/你的仓库/main/sync.json",
  "catalog_path": "catalog.json",
  "gitee": {
    "owner": "你的用户名",
    "repo": "你的仓库",
    "branch": "master",
    "catalogPath": "catalog.json",
    "syncPath": "sync.json"
  }
}
```

> `gitee` 是可选的中国大陆加速镜像。不用就整段删掉。

---

## 功能

网站分三页，顶部导航可互相跳转：

### 📦 选品库（`index.html`）

| 功能 | 说明 |
|---|---|
| **网格浏览** | 缩略图卡片，一次加载上百件不卡 |
| **搜索** | 商品名 / 店铺 / SKU 模糊匹配 |
| **筛选** | 价格区间、月销区间、店铺、分类 |
| **排序** | 月销、总销、价格、上架时间 |
| **详情弹窗** | 大图 + 完整字段 + 跳转原商品页 |
| **删除** | 勾选后删除，写入 `deleted.json`，扩展同步时不会再录回来 |
| **今日新增** | 按 `last_seen` 过滤今天录到的商品 |

### 📈 销售追踪 · 采购预测（`sales.html`）

**销售追踪**

| 功能 | 说明 |
|---|---|
| **每日快照** | 打开页面当天自动记一次（可关），也可手动补记/刷新；同一天重复打开不会重复写 |
| **涨跌榜** | 对比昨天 / N 天前，按日增销量排序，带走势迷你图 |
| **滞销预警** | 连续 3 天零增长的商品自动列出 |

**采购预测**（真正的采购闭环）

| 功能 | 说明 |
|---|---|
| **库存与成本** | 按商品录入「现有库存」和「进货成本」，改完自动保存，支持搜索 / 筛选 / 分页 |
| **补货建议** | `补货量 = 日均销量 × (备货周期 + 安全库存天数) − 该商品现有库存` |
| **毛利核算** | 单件毛利 = 售价 − 成本，毛利率随填随算 |
| **采购单导出** | 勾选商品 → 导出 CSV（含 SKU / 数量 / 单价 / 金额 / 合计），Excel 直接打开 |
| **库存表导出** | 一键导出全部商品的库存 + 成本 + 毛利 CSV |
| **到货入库** | 勾选商品 → 把采购数量累加进各自的现有库存，补货建议随即重算；入库后自动清空勾选，同一批货不会写两次 |
| **入库记录** | 保留最近 50 批入库（时间 / 项数 / 数量 / 金额 / 明细） |
| **数据备份还原** | 快照 + 库存成本 + 入库记录 + 设置 一键导出 JSON，可还原（校验格式 + 二次确认） |

> ⚠️ **务必先在「库存与成本」里填进货成本**。没填时采购额会退化为按售价估算（明显偏高），页面会显式标注「按售价估算」。

### 🧭 选品洞察（`insight.html`）

| 功能 | 说明 |
|---|---|
| **选品打分** | 月销 × 价格 × 评分综合打分，S/A/B/C 分档 |
| **跨店比价** | 同一商品在不同店铺的价格排序 |
| **价格趋势** | 结合销售追踪的快照，画价格历史折线 |

---

## 文件结构

```
├── index.html        # 选品库入口
├── app.js            # 选品库逻辑（渲染/筛选/同步）
├── sales.html        # 销售追踪 + 采购预测
├── sales.js          # 每日快照 / 涨跌榜 / 滞销预警 / 库存成本 / 补货建议 / 采购单
├── insight.html      # 选品洞察
├── insight.js        # 选品打分 / 跨店比价 / 价格趋势
├── style.css         # 共用样式
├── auth.js           # 可选：自建后端登录（默认不启用）
├── vercel.json       # Vercel 一键部署配置
├── netlify.toml      # Netlify 一键部署配置
└── data/
    └── source.json   # 数据源配置（这个要进版本库）
```

> `data/catalog.json` 等运行时数据在 `.gitignore` 里，不入库——商品数据放在独立的数据仓库。

### 本机数据（不上传）

| localStorage 键 | 内容 |
|---|---|
| `shopee_track_v1` | 每日销量快照（最多 90 天） |
| `shopee_inv_v1` | 各商品的库存与进货成本 |
| `shopee_prefs_v1` | 偏好设置（自动记录开关） |
| `shopee_po_log_v1` | 采购入库历史（最多 50 批） |

都在你本机浏览器里，清缓存会丢；重要数据请用页面上的「导出 CSV」留档。

---

## 字段归一化（改代码必读）

线上 `catalog.json` 的 item **只有 `shopid` / `itemid`，没有 `id` 和 `url`**。

`app.js` 的 `normalizeCatalog()`、`sales.js` / `insight.js` 的 `normCatalog()` 都负责推导：

```js
it.id  = shopid + "_" + itemid          // 如 914264966_27655129421
it.url = "https://shopee.tw/product/" + shopid + "/" + itemid
```

**漏掉这一步，全部商品会塌缩成同一个 id `"undefined"`**（快照只剩 1 条、链接变 `#`）。
新增任何读取 catalog 的页面时，务必先归一化。

---

## 数据字段口径

网站严格遵循扩展的采集口径，改代码前请先看 [shopee-ext/RECORDING.md](https://github.com/23ccf/shopee-ext/blob/main/RECORDING.md)：

- **month_sold** — 近 30 天销量（权威源：详情接口 `item/get`）
- **week_sold** — `round(month_sold / 4.345)`
- **sold_total** — 累计总销量（列表/店铺页字段）
- **price** — 直接显示原值（见 `normalizePrice`，仅对 >1000000 的做 ÷100000）
- **price_max** — 多规格商品的最高价。仅当 `price_max > price` 才成立，页面显示为「NT$100–200」；缺失或相等按单一价格处理
- **last_seen** — 秒级时间戳，用于「今日新增」
- **first_seen** — 首次录入时间

---

## 月销门槛（哪些商品能进入网站）

**规则：月销 ≥ 30 的商品才展示；月销 < 30 的直接过滤掉。**

- 门槛值存在 `localStorage.shopee_gate_v1`，默认 `30`。
- 筛选栏「月销门槛」可切换：`只留月销≥30`（默认）/ `只留月销≥100` / `全部（含月销未知）`。
- 唯一例外：月销 `0` 代表「虾皮台站隐藏了月销文案」，若累计总销 ≥ 200（疑似真实爆款）仍保留。
- 被过滤掉的数量会写在商品库标题旁（如「已按「月销≥30」隐藏 323 件低动销」），不会静默吞数据。
- ⚠️ 实现要点：`applyCatalog()` 必须先把原始列表存进 `doc._rawItems` 再过滤。
  `doc.items` 会被就地覆盖成过滤结果，不另存一份的话，门槛调松时被过滤的商品**无法恢复**。
- 三个页面（`index.html` / `sales.html` / `insight.html`）用同一口径，
  分别在 `app.js applyCatalog()`、`sales.js passMonthGate()`、`insight.js passMonthGate()` 中实现，
  **改一处必须同步另两处**。

---

## 店铺排行口径

店铺分析（首页「🏪 店铺」）默认按 **「月销>30 的商品数」从大到小** 排序，可切换：

| 排序项 | 含义 |
|---|---|
| 月销>30 商品数（默认） | 该店在本选品库中月销 > 30 的商品条数，衡量「有多少款值得跟进」 |
| 店铺总销量 | 该店在录商品的累计销量（`sold_total`）之和 |
| 月销量合计 | 该店在录商品的月销之和 |
| 在录商品数 | 该店在本库的商品总条数 |
| 月销>100 商品数 | 更严的高动销筛选 |

---

## 采购/库存（不属于选品功能）

`sales.html` 底部的 **采购预测 / 库存与成本 / 补货建议 / 采购单导出 / 到货入库 / 入库记录**
属于卖家后台（ERP）范畴，**与选品无关**，已折叠进默认收起的 `<details>` 区块
（`id="tab-forecast"`，标题写明「不属于选品范围」）。

- 代码保留、功能可用，展开即可使用，但不再占一级入口。
- 若将来彻底不用，可直接删除该 `<details>` 块；注意同步清理 `sales.js` 中的
  `calcForecast / exportPO / receivePO / renderPoLog / renderInv` 等函数与 localStorage 键
  `shopee_inv_v1`、`shopee_po_log_v1`。

---

## 跨境卫士用户注意

如果你用跨境卫士浏览器，本网站默认就是**可用的 GitHub 模式**。

⚠️ **不要启用 `auth.js` 的自建后端模式** —— 跨境卫士的代理不识别自建后端域名，请求会无限挂起导致页面卡死。详见后端仓库的 [MIGRATION.md](https://github.com/23ccf/shopee-backend/blob/main/MIGRATION.md)。

---

## 相关仓库

| 仓库 | 作用 |
|---|---|
| [shopee-ext](https://github.com/23ccf/shopee-ext) | Chrome 扩展，负责录制数据 |
| 本仓库 | 网站，负责展示数据 |
| [shopee-backend](https://github.com/23ccf/shopee-backend) | 可选自建后端（账号隔离） |

---

## 许可证

MIT
