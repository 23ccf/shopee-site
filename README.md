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

| 功能 | 说明 |
|---|---|
| **网格浏览** | 缩略图卡片，一次加载上百件不卡 |
| **搜索** | 商品名 / 店铺 / SKU 模糊匹配 |
| **筛选** | 价格区间、月销区间、店铺、分类 |
| **排序** | 月销、总销、价格、上架时间 |
| **详情弹窗** | 大图 + 完整字段 + 跳转原商品页 |
| **删除** | 勾选后删除，写入 `deleted.json`，扩展同步时不会再录回来 |
| **今日新增** | 按 `last_seen` 过滤今天录到的商品 |

---

## 文件结构

```
├── index.html        # 单页入口
├── app.js            # 全部逻辑（渲染/筛选/同步）
├── style.css         # 样式
├── auth.js           # 可选：自建后端登录（默认不启用）
└── data/
    └── source.json   # 数据源配置（这个要进版本库）
```

> `data/catalog.json` 等运行时数据在 `.gitignore` 里，不入库——商品数据放在独立的数据仓库。

---

## 数据字段口径

网站严格遵循扩展的采集口径，改代码前请先看 [shopee-ext/RECORDING.md](https://github.com/23ccf/shopee-ext/blob/main/RECORDING.md)：

- **month_sold** — 近 30 天销量（权威源：详情接口 `item/get`）
- **week_sold** — `round(month_sold / 4.345)`
- **sold_total** — 累计总销量（列表/店铺页字段）
- **price** — 直接显示原值（见 `normalizePrice`，仅对 >1000000 的做 ÷100000）
- **last_seen** — 秒级时间戳，用于「今日新增」
- **first_seen** — 首次录入时间

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
