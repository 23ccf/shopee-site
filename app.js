/* 虾皮台湾选品看板 — 前端逻辑（零依赖，纯原生 JS） */
(function () {
  "use strict";
  // 部署版本号：每次修复后部署都递增，并在 index.html 的 app.js 引用后加 ?v= 同号，
  // 强制浏览器放弃旧缓存（静态站点会长期缓存 app.js，否则用户测到的永远是旧逻辑）。
  // 排查问题时可在控制台执行 `console.log(window.__APP_VERSION)` 核对线上实际版本。
  const APP_VERSION = "20260910i"; window.__APP_VERSION = APP_VERSION;
  // 在顶栏显示版本号芯片（用户无需打开控制台就能确认是否加载到新代码，
  // 这是排查"改了没用/反复失败"假象的最直接方式）。
  try { document.getElementById('appVersionChip').textContent = 'v' + APP_VERSION; } catch (e) {}
  const state = {
    data: null,
    filter: "",
    sort: {},
    lastSyncTs: 0,     // 云端最后同步时间戳（秒），用于「今日录制」板块显示同步状态
    catalogAll: null,   // 完整商品库（data/catalog.json），用于行业大盘/店铺/榜单/收藏的客户端聚合
    fav: {},            // 收藏：{ id: { g:分组, n:备注, t:收藏时间(秒) } }（2026-09-10 起为对象，旧数组自动迁移）
    favGroups: [],      // 用户自定义分组名
    favFilter: "",      // 收藏面板当前分组筛选（"" = 全部）
    cardCfg: null,      // 卡片显示字段配置（localStorage 缓存）
    kws: [],            // 关注关键词：[{ w, t, hist:{ 'YYYY-MM-DD': n } }]
    lib: {
      q: "", cat: "", loc: "", sort: "month",
      min_price: null, max_price: null, min_sold: 0, min_month: 0, min_rating: 0,
      page: 1, size: 48, total: 0, pages: 1, items: [],
      cats: [], locs: [], catalogFallback: null, offline: false,
      _dataReady: false,   // 首次拿到有效商品数据后置 true：此后不再允许把网格降级成「加载中」
    },
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString("zh-Hant"));
  // 月销格式化：月销=0 表示「近30天月销量未知」（虾皮台站已隐藏该文案 + item/get 被 403），
  // 显示为「未知」而非 0，避免用户误以为仍是抓取失败。
  const fmtMonth = (n) => (Number(n) > 0 ? Number(n).toLocaleString("zh-Hant") : "未知");
  // 虾皮 price 字段常见单位为 1e-5（原币 * 100000）。若数据库里仍残留 raw 价格，显示前再归一化一次。
  function normalizePrice(v) {
    if (v == null) return 0;
    let n = (typeof v === "number") ? v : parseFloat(String(v).replace(/,/g, ""));
    if (isNaN(n)) return 0;
    for (let i = 0; i < 2 && n > 1000000; i++) n = n / 100000;
    return n;
  }
  const money = (n) => (state.data ? state.data.currency + fmt(Math.round(normalizePrice(n))) : fmt(Math.round(normalizePrice(n))));
  // 图片代理：虾皮 CDN 已迁移到 img.susercontent.com，旧 cf.shopee.tw 经常失效。
  // 这里统一把相对路径 / cf 旧地址转成新 CDN，并让 <img referrerpolicy="no-referrer"> 绕过防盗链。
  const proxyImg = (url, w) => {
    if (!url) return "";
    // 相对路径补成完整 susercontent 地址
    if (!url.startsWith("http") && !url.startsWith("//")) {
      url = "https://down-tw.img.susercontent.com/file/" + url;
    }
    // 旧 cf.shopee.tw 地址重写为新 CDN
    if (url.indexOf("cf.shopee.tw/file/") >= 0) {
      url = url.replace("cf.shopee.tw/file/", "down-tw.img.susercontent.com/file/");
    }
    return url;
  };

  // ★ 2026-09-03 性能：商品网格一页要加载 48 张图，这是首屏最大的流量开销。
  //   实测虾皮 CDN（down-tw.img.susercontent.com）：
  //     原图        800×800  235 KB
  //     `_tn` 缩略图 320×320   56 KB   ← 省 76%
  //   卡片实际只显示约 200×170px，320px 绰绰有余。
  //   单页图片流量 48×235KB≈11.5MB → 48×56KB≈2.7MB。
  //   详情弹窗只显示一张图，仍用原图保证清晰（见 renderLibDetail / renderProduct）。
  const thumbUrl = (url) => {
    if (!url) return "";
    // 只给虾皮 file-id 形式的 URL 加后缀（`/file/tw-11134201-xxxx`），其它原样返回
    if (url.indexOf("down-tw.img.susercontent.com/file/") < 0) return url;
    if (/_tn$/i.test(url)) return url;                    // 已经是缩略图
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return url; // 非 file-id 形式，不加后缀
    return url + "_tn";
  };

  // 图片加载失败时的多级回退：主 CDN → 旧 cf 镜像 → 带尺寸后缀镜像 → 占位图。
  // 避免单域名 403 / file id 失效时破图长期停留。
  const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 200%22%3E%3Crect fill=%22%23f0f0f0%22 width=%22200%22 height=%22200%22/%3E%3Ctext x=%22100%22 y=%22115%22 font-size=%2272%22 text-anchor=%22middle%22 fill=%22%23ccc%22%3E%f0%9f%93%a6%3C/text%3E%3C/svg%3E";
  window.__imgFallback = function (el) {
    const src = el.getAttribute("src") || "";
    const m = src.match(/file\/([^?\"' ]+)/);
    // ★ 2026-09-03：缩略图 URL 带 `_tn` 后缀，取 id 时必须先剥掉，
    //   否则候选链会把 `_tn_SS400_` 之类的畸形地址拼出来。
    //   剥掉后回退链自然变成：缩略图 → 原图 → cf 镜像 → _SS400_ → 占位图。
    const id = m ? m[1].replace(/_tn$/i, "") : "";
    let i = parseInt(el.dataset.fbi || "0", 10);
    const cands = id ? [
      "https://down-tw.img.susercontent.com/file/" + id,
      "https://cf.shopee.tw/file/" + id,
      "https://down-tw.img.susercontent.com/file/" + id + "._SS400_"
    ] : [];
    i++;
    if (i < cands.length && cands[i] !== src) {
      el.dataset.fbi = String(i);
      el.src = cands[i];
    } else {
      el.onerror = null;
      el.src = IMG_PLACEHOLDER;
    }
  };

  // 价格合理性阈值（NT$）：超过即视为「疑似单位换算错误」，渲染时打角标。
  // 本目录商品均为小百货（洞洞鞋/保温杯/杯刷等），正常售价 < 1500；阈值设 1500 兼顾防误伤。
  const PRICE_SANITY_MAX = 1500;
  const priceSanity = (p) => (p == null ? false : Number(p) > PRICE_SANITY_MAX);
  const FLAG_PRICE_WARN = ' <span style="color:#c0392b;font-size:11px;font-weight:600;white-space:nowrap;" title="价格疑似未正确换算，待复核">⚠ 价格待校验</span>';
  const FLAG_PRICE_FIXED = ' <span style="color:#2e7d32;font-size:11px;font-weight:600;white-space:nowrap;" title="此价格已由系统按单位换算规则自动校正">✓ 价格已校正</span>';

  // ---------- 加载 ----------
  // 即使 analysis.json 失败也尽量 boot，避免整页白屏 / 「网站打不开」
  function bootWith(d) {
    state.data = d;
    boot();
  }
  const DEFAULT_ANALYSIS = {
    site_name: "虾皮台湾", mode: "live", date: "",
    note: "analysis.json 加载失败，已使用默认配置",
  };
  fetch("data/analysis.json?_=" + Math.random().toString(36).slice(2))
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((d) => bootWith(d))
    .catch((e) => {
      console.warn("[boot] analysis.json 加载失败，使用默认配置:", e.message);
      bootWith(DEFAULT_ANALYSIS);
    });

  function boot() {
    const d = state.data;
    $("#app").style.display = "block";
    $("#subtitle").textContent =
      (d.site_name || "虾皮台湾") + " · 实时选品看板";
    // 日期优先跟随 catalog.json 的最新时间（避免 analysis.json 旧日期误导）
    setDataDate(d.date);
    const badge = $("#modeBadge");
    badge.textContent = d.mode === "live" ? "LIVE" : d.mode === "kjws" ? "真实" : "DEMO";
    badge.className = "badge " + (d.mode === "live" ? "live" : "demo");

    // 首页直奔商品库：先加载 catalog，再展示
    wireTabs();
    wireProductModal();
    wireLookup();
    state.fav = loadFav();
    state.favGroups = loadFavGroups();
    state.kws = loadKws();
    loadCatalogAll().then(() => {
      wireLibrary();
      wireToday();
      wireShops();
      wireFav();
      wireGate();
      refreshAnalysisViews();
    });
    wireCalc();
    wireSync();
    wireRecorderStatus();
    wireCardFields();
    wireKws();
    renderKw();
  }

  // 日期显示：优先用 catalog 的 generated_at（最新生成时间），否则用 captured_at/catalog_ts，最后 fallback
  function setDataDate(fallback) {
    const dd = $("#dataDate");
    if (!dd) return;
    const doc = state.catalogAll;
    let ts = null;
    if (doc) {
      // generated_at 是构建/同步时的最新时间，最可靠
      if (doc.generated_at) {
        const d = safeDate(doc.generated_at);
        if (d) ts = Math.floor(d.getTime() / 1000);
      }
      if (!ts && doc.catalog_ts) ts = normTs(doc.catalog_ts); // 归一化：源里可能残留毫秒值
      if (!ts && doc.captured_at) {
        const d = safeDate(doc.captured_at);
        if (d) ts = Math.floor(d.getTime() / 1000);
      }
    }
    if (ts) {
      dd.textContent = dateStrUTC8(ts);
      dd.title = "catalog 更新时间: " + fmtLocalTime(ts);
    } else if (fallback) {
      dd.textContent = fallback;
    }
  }

  // ---------- 简繁归一化（2026-09-10）----------
  // 台湾虾皮的商品名全是繁体，而你是大陆打字节奏。搜简体「运动鞋」匹配不到繁体「運動鞋」，
  // 会直接搜出 0 条、误以为没货 —— 这是台湾市场选品的刚需。
  // 这里不做完整繁简转换（那要几万字表、体积太大），只覆盖电商品类高频字，
  // 两侧都归一到简体再比对，因此「繁体查简体」「简体查繁体」双向都通。
  const T2S_PAIRS = ("萬万 與与 從从 這这 還还 為为 將将 對对 應应 開开 關关 間间 時时 "
    + "樣样 種种 隻只 裡里 點点 壓压 縮缩 輕轻 鬆松 軟软 層层 數数 幾几 實实 際际 標标 "
    + "準准 話话 語语 說说 謝谢 讓让 給给 總总 計计 據据 顯显 號号 經经 過过 邊边 麼么 個个 "
    + "們们 來来 後后 並并 體体 國国 學学 會会 員员 產产 業业 專专 廠厂 內内 運运 動动 "
    + "電电 機机 褲裤 襪袜 飾饰 網网 涼凉 碼码 顏颜 紅红 綠绿 藍蓝 黃黄 長长 寬宽 舊旧 "
    + "熱热 賣卖 優优 質质 組组 雙双 條条 張张 臺台 灣湾 進进 貨货 費费 銷销 現现 價价 "
    + "錢钱 幣币 選选 購购 買买 訂订 單单 發发 廚厨 衛卫 燈灯 傘伞 襯衬 絨绒 裝装 納纳 "
    + "環环 膠胶 鋼钢 鐵铁 鋁铝 鏡镜 錶表 鐘钟 線线 纜缆 頭头 鍵键 盤盘 螢荧 櫃柜 盤盘 "
    + "鍋锅 爐炉 紙纸 濕湿 潔洁 劑剂 髮发 嬰婴 車车 輪轮 載载 轉转 啞哑 鈴铃 繩绳 舉举 "
    + "護护 殼壳 貼贴 塵尘 傢家 俱具 寢寝 飾饰 擺摆 掛挂 收收 納纳 整整 理理 儲储 藏藏 "
    + "夾夹 扣扣 黏粘 膠胶 綁绑 帶带 包包 裝装 護护 膚肤 化化 妝妆 保保 養养 氣气 涼凉 減减 溫温 濕湿 乾干 淨净 緊紧 厚厚 薄薄 軟软 硬硬 濃浓 淡淡 純纯");
  const T2S_MAP = (function () {
    const m = Object.create(null);
    T2S_PAIRS.split(/\s+/).forEach(function (p) {
      if (p && p.length >= 2) m[p.charAt(0)] = p.charAt(1);
    });
    return m;
  })();
  function normSearch(s) {
    let out = "";
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) {
      const c = str.charAt(i);
      out += (T2S_MAP[c] || c);
    }
    return out.toLowerCase();
  }

  // ---------- 客户端重算分析数据（2026-09-10）----------
  // data/analysis.json 停留在 2026-08-08 的空骨架（total_items=0，hot/soaring/bands/
  // categories/keywords/blue_ocean 全是空数组），而且没有任何程序会去生成它。
  // 与其让 5 个板块永远空着，不如直接用已采集的真实商品现算。
  // 铁律：只依赖真实采集到的字段（price / month_sold / sold_total / name / shop / last_seen）。
  // rating / cats / loc / reviews / liked 从未采集 —— 用它们算出来的东西是假的，一律不算。
  const BAND_DEFS = [
    { label: "NT$0–100", min: 0, max: 100 },
    { label: "NT$100–300", min: 100, max: 300 },
    { label: "NT$300–500", min: 300, max: 500 },
    { label: "NT$500–1000", min: 500, max: 1000 },
    { label: "NT$1000+", min: 1000, max: Infinity },
  ];
  function hasPrice(it) { return Number(it && it.price) > 0; }

  function readTrack() {
    try { return JSON.parse(localStorage.getItem("shopee_track_v1") || "null"); } catch (e) { return null; }
  }
  function avgNum(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  function computeBands(items) {
    return BAND_DEFS.map(function (d) {
      const its = items.filter(function (it) {
        return hasPrice(it) && it.price >= d.min && it.price < d.max;
      });
      return {
        label: d.label,
        count: its.length,
        avg_sold: Math.round(avgNum(its.map(function (i) { return Number(i.month_sold) || 0; })) * 10) / 10,
        avg_price: Math.round(avgNum(its.filter(hasPrice).map(function (i) { return Number(i.price); }))),
      };
    }).filter(function (b) { return b.count > 0; });
  }

  function computeHot(items) {
    return items.slice().sort(function (a, b) {
      return (Number(b.sold_total) || 0) - (Number(a.sold_total) || 0);
    }).slice(0, 50).map(function (it) {
      return {
        name: it.name || "（未采集到名称）",
        shop: it.shop || "—",
        price: Number(it.price) || 0,
        historical_sold: Number(it.sold_total) || 0,
        weekly_sold: Number(it.week_sold) || 0,
        monthly_sold: Number(it.month_sold) || 0,
        last_seen: it.last_seen || it.first_seen || 0,
        _raw: it,
      };
    });
  }

  // 飙升 = 本地每日快照里「最近两次记录的销量差」。快照存在浏览器本机
  // （sales.html 的自动记录会写），换电脑/清缓存就没有 —— 所以没有快照时必须说清楚，
  // 不能伪造一个增量出来。
  function computeSoaring(items) {
    const t = readTrack();
    if (!t || !t.items) return [];
    const out = [];
    items.forEach(function (it) {
      const rec = t.items[libItemId(it)];
      if (!rec || !rec.sold) return;
      const arr = rec.sold;
      const n = arr.length;
      if (n < 2) return;
      const last = arr[n - 1], prev = arr[n - 2];
      if (last == null || prev == null) return;
      const delta = Number(last) - Number(prev);
      if (!(delta > 0)) return;
      out.push({
        name: it.name || "（未采集到名称）",
        shop: it.shop || "—",
        price: Number(it.price) || 0,
        historical_sold: Number(it.sold_total) || 0,
        weekly_sold: Number(it.week_sold) || 0,
        monthly_sold: Number(it.month_sold) || 0,
        sold_delta: delta,
        _raw: it,
      });
    });
    out.sort(function (a, b) { return b.sold_delta - a.sold_delta; });
    return out.slice(0, 50);
  }

  // 蓝海词 = 你关注的每个词，算「需求 ÷ 供给」：
  //   需求 = 该词命中商品的平均月销（用 log 压缩，避免单个爆款把指数拉爆）
  //   供给 = 该词命中的商品条数（在售竞品多不多）
  // 需求高、竞品少 → 指数高，值得切入。数据来自真实在录商品 + 你自己的关注词。
  function computeBlueOcean(items) {
    const kws = state.kws || [];
    const rows = [];
    kws.forEach(function (k) {
      const w = String((k && k.w) || "").trim();
      if (!w) return;
      const its = items.filter(function (it) { return libMatch(it, w); });
      if (!its.length) return;
      const avg_sold = avgNum(its.map(function (i) { return Number(i.month_sold) || 0; }));
      const avg_price = avgNum(its.filter(hasPrice).map(function (i) { return Number(i.price); }));
      const demand = Math.log(1 + avg_sold);
      const supply = Math.log(1 + its.length);
      const blue = Math.round((demand / (demand + supply)) * 1000) / 10;
      rows.push({
        keyword: w,
        items: its.length,
        avg_sold: Math.round(avg_sold),
        avg_price: Math.round(avg_price),
        blue_ocean: blue,
      });
    });
    rows.sort(function (a, b) { return b.blue_ocean - a.blue_ocean; });
    return rows;
  }

  function rebuildAnalysis(items) {
    if (!state.data) return;
    // analysis.json 加载失败 / 结构不全时补一个空壳，不能让整页崩掉
    if (!state.data.analysis) state.data.analysis = {
      total_items: 0, hot: [], soaring: [], bands: [], categories: [],
      keywords: [], blue_ocean: [], best_band: null, best_category: null,
    };
    const pool = items || [];
    const a = state.data.analysis;
    a.total_items = pool.length;
    a.bands = computeBands(pool);
    a.hot = computeHot(pool);
    a.soaring = computeSoaring(pool);
    a.blue_ocean = computeBlueOcean(pool);
    // 类目（cats）从未被采集 → 不做任何「类目榜」，留空由页面显式说明
    a.categories = [];
    a.best_category = null;
    // 最佳价格带：在样本量够（≥3 件）的档位里挑平均月销最高的
    const cands = a.bands.filter(function (b) { return b.count >= 3; });
    const pick = cands.length ? cands : a.bands;
    a.best_band = pick.length
      ? pick.slice().sort(function (x, y) { return y.avg_sold - x.avg_sold; })[0]
      : null;
  }

  // ---------- 概览卡片 ----------
  // 分析类板块统一刷新：数据一变（首次加载 / 月销门槛调整）就必须重算，
  // 否则「价格带」还停在上一次门槛下的结果，和商品库对不上。
  function refreshAnalysisViews() {
    if (!state.catalogAll || !state.catalogAll.items) return;
    rebuildAnalysis(state.catalogAll.items);
    renderCards();
    renderBlue();
    renderBand();
    renderHot();
    renderSoar();
  }

  function renderCards() {
    const a = state.data.analysis;
    const cards = [
      { n: fmt(a.total_items), l: "采集商品数" },
      { n: a.blue_ocean.length, l: "蓝海关键词" },
      { n: a.soaring.length, l: "飙升商品(较前日)" },
      { n: a.best_band ? a.best_band.label : "-", l: "最佳价格带" },
      { n: a.best_band ? fmt(a.best_band.avg_sold) : "-", l: "该带均月销" },
    ];
    $("#cards").innerHTML = cards
      .map((c) => `<div class="card"><div class="n">${c.n}</div><div class="l">${c.l}</div></div>`)
      .join("");
  }

  // ---------- 蓝海关键词 ----------
  function renderBlue() {
    const rows = state.data.analysis.blue_ocean;
    fillTable(
      "#tblBlue",
      rows.map((k, i) => ({
        rank: i + 1,
        关键词: esc(k.keyword),
        商品数: fmt(k.items),
        均月销: fmt(k.avg_sold),
        均价: money(k.avg_price),
        蓝海指数: "<b>" + k.blue_ocean + "</b>",
      })),
      ["rank", "关键词", "商品数", "均月销", "均价", "蓝海指数"]
    );
    if (!rows.length) {
      $("#tblBlue tbody").innerHTML =
        '<tr><td colspan="6" style="color:#999">还没有蓝海词。到「全部商品」搜一个词（比如 洞洞鞋），'
        + '点搜索框右侧的「+ 关注」，这里就会算出它的供需比。</td></tr>';
    }
  }

  // ---------- 热销 ----------
  function renderHot() {
    const rows = filterSort(state.data.analysis.hot, (it) => ({
      rank: 0,
      商品: `<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>`,
      价格: hasPrice(it) ? money(it.price) : '<span class="muted">未采集</span>',
      总销量: fmt(it.historical_sold),
      月销量: fmt(it.monthly_sold),
      店铺: esc(it.shop || "—"),
      _raw: it._raw || it,
    }));
    fillTable(
      "#tblHot",
      rows.map((r, i) => Object.assign({ rank: i + 1 }, r)),
      ["rank", "商品", "价格", "总销量", "月销量", "店铺"],
      rows
    );
    if (!state.data.analysis.hot.length) {
      $("#tblHot tbody").innerHTML =
        '<tr><td colspan="6" style="color:#999">暂无商品数据。</td></tr>';
    }
  }

  // ---------- 飙升 ----------
  function renderSoar() {
    const rows = filterSort(state.data.analysis.soaring, (it) => ({
      rank: 0,
      商品: `<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>`,
      价格: hasPrice(it) ? money(it.price) : '<span class="muted">未采集</span>',
      总销量: fmt(it.historical_sold),
      月销量: fmt(it.monthly_sold),
      增量: `<span class="up">+${fmt(it.sold_delta)}</span>`,
      店铺: esc(it.shop || "—"),
      _raw: it._raw || it,
    }));
    fillTable(
      "#tblSoar",
      rows.map((r, i) => Object.assign({ rank: i + 1 }, r)),
      ["rank", "商品", "价格", "总销量", "月销量", "增量", "店铺"],
      rows
    );
    if (!state.data.analysis.soaring.length) {
      $("#tblSoar tbody").innerHTML =
        '<tr><td colspan="7" style="color:#999">还没有可比对的快照。'
        + '打开「销售追踪」页并开启自动记录，连续记录 2 天以上，这里就会出现销量在涨的商品'
        + '（快照只存在本机浏览器，换电脑或清缓存会丢失）。</td></tr>';
    }
  }

  // ---------- 价格带 / 类目 图表 ----------
  function barChart(elId, data, valKey, labelKey, unit, cls) {
    const max = Math.max.apply(null, data.map((d) => d[valKey]).concat([1]));
    $(elId).className = "chart " + (cls || "");
    $(elId).innerHTML = data
      .map((d) => {
        const w = Math.round((d[valKey] / max) * 100);
        return `<div class="bar-row"><div class="bar-label" title="${esc(d[labelKey])}">${esc(
          d[labelKey]
        )}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="bar-val">${fmt(
          d[valKey]
        )}${unit}</div></div>`;
      })
      .join("");
  }
  function renderBand() {
    const b = state.data.analysis.bands;
    barChart("#bandChart", b, "avg_sold", "label", " 件", "");
    $("#tblBand tbody").innerHTML = b
      .map(
        (x) =>
          `<tr><td>${esc(x.label)}</td><td class="num">${fmt(x.count)}</td><td class="num">${fmt(
            x.avg_sold
          )}</td><td class="num">${money(x.avg_price)}</td></tr>`
      )
      .join("");
  }
  function renderCat() {
    if (!$("#catChart")) return;   // 类目分布面板已移除（cats 从未采集）
    const c = state.data.analysis.categories;
    barChart("#catChart", c, "total_sold", "category", " 件", "cat");
    $("#tblCat tbody").innerHTML = c
      .map(
        (x) =>
          `<tr><td>${esc(x.category)}</td><td class="num">${fmt(x.count)}</td><td class="num">${fmt(
            x.total_sold
          )}</td></tr>`
      )
      .join("");
  }

  // ---------- 通用表格填充 ----------
  function fillTable(sel, rows, cols, rowData) {
    const tb = $(sel + " tbody");
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="' + cols.length + '" style="color:#999">无数据</td></tr>';
      return;
    }
    tb.innerHTML = rows
      .map((r, i) => {
        const rd = rowData && rowData[i];
        const attr =
          rd && rd._raw && rd._raw.itemid != null
            ? ` data-itemid="${rd._raw.itemid}" data-shopid="${rd._raw.shopid}" class="clickable"`
            : "";
        return (
          "<tr" + attr + ">" +
          cols.map((c) => `<td class="${c === "rank" ? "" : "num"}">${r[c]}</td>`).join("") +
          "</tr>"
        );
      })
      .join("");
  }

  // ---------- 搜索 + 排序 ----------
  function filterSort(arr, mapper) {
    let rows = arr.map(mapper);
    if (state.filter) {
      const f = state.filter.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r._raw &&
            ((r._raw.name && r._raw.name.toLowerCase().includes(f)) ||
              (r._raw.keyword && r._raw.keyword.toLowerCase().includes(f)))) ||
          false
      );
    }
    return rows;
  }

  function wireSearch() {
    const inp = $("#search");
    inp.addEventListener("input", () => {
      state.filter = inp.value.trim();
      renderHot();
      renderSoar();
      $("#searchHint").textContent = state.filter
        ? "已过滤热销/飙升商品（含「" + state.filter + "」）"
        : "";
    });
  }

  function wireSort() {
    $$("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const tbl = th.closest("table").id;
        const k = th.dataset.k;
        const cur = state.sort[tbl] || {};
        const dir = cur.k === k && cur.dir === "asc" ? "desc" : "asc";
        state.sort[tbl] = { k, dir };
        $$("#" + tbl + " th.sortable").forEach((t) => t.classList.remove("asc", "desc"));
        th.classList.add(dir);
        applySort(tbl, k, dir);
      });
    });
  }

  function applySort(tbl, k, dir) {
    const sign = dir === "asc" ? 1 : -1;
    const cmp = (a, b) => {
      let va = a[k],
        vb = b[k];
      if (va == null) va = "";
      if (vb == null) vb = "";
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
      return String(va).localeCompare(String(vb), "zh-Hant") * sign;
    };
    if (tbl === "tblBlue") state.data.analysis.blue_ocean.sort(cmp), renderBlue();
    if (tbl === "tblHot") state.data.analysis.hot.sort(cmp), renderHot();
    if (tbl === "tblSoar") state.data.analysis.soaring.sort(cmp), renderSoar();
  }

  // ---------- 标签页 ----------
  function wireTabs() {
    $$("#tabs .tab-btn").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$("#tabs .tab-btn").forEach((t) => t.classList.remove("on"));
        tab.classList.add("on");
        const map = {
          library: "panel-library",
          lookup: "panel-lookup",
          hot: "panel-hot",
          soaring: "panel-soaring",
          band: "panel-band",
          blue: "panel-blue",
          shops: "panel-shops",
          fav: "panel-fav",
          calc: "panel-calc",
        };
        $$(".panel").forEach((p) => p.classList.add("hidden"));
        const target = $("#" + map[tab.dataset.tab]);
        if (target) target.classList.remove("hidden");
      });
    });
  }

  // ---------- 单品详情弹窗（总销量/周销量/月销量 + 各 SKU 售价）----------
  function wireProductModal() {
    const modal = $("#modal");
    $("#modalClose").addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
    // 委托点击：收藏按钮 / 商品行 / 店铺行 / 商品卡片
    document.addEventListener("click", (e) => {
      const fb = e.target.closest(".fav-btn");
      if (fb) { e.stopPropagation(); toggleFav(fb.dataset.id); return; }
      const tr = e.target.closest("tr.clickable");
      if (tr) {
        if (tr.dataset.shop) return openShop(tr.dataset.shop);
        if (tr.dataset.itemid != null) return openProduct(tr.dataset.itemid, tr.dataset.shopid);
        if (tr.dataset.id) return openLibItem(tr.dataset.id);
        return;
      }
      // 「查商品」命中本地库后的「查看完整详情」按钮
      const lk = e.target.closest("#lkOpen");
      if (lk && lk.dataset.id) return openLibItem(lk.dataset.id);
      // 「去重录」是个真链接，不能顺手把详情弹窗也打开（否则点了就跳页面 + 弹窗，双份打扰）
      if (e.target.closest(".pcard-recheck")) return;
      const card = e.target.closest(".pcard");
      if (card && card.dataset.id && !e.target.closest(".pcard-check")) return openLibItem(card.dataset.id);
    });
  }

  function openProduct(itemid, shopid) {
    const modal = $("#modal");
    const body = $("#modalBody");
    modal.classList.remove("hidden");
    body.innerHTML = '<div class="loading">⏳ 正在抓取商品详情（含各 SKU 售价）…</div>';
    // 优先走后端实时接口；静态部署无后端时回退到预生成的 products.json
    fetch(`/api/product/${encodeURIComponent(itemid)}?shopid=${encodeURIComponent(shopid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no backend"))))
      .then((d) => renderProduct(d))
      .catch(() => {
        fetch("data/products.json")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no cache"))))
          .then((cache) => {
            const key = itemid + "_" + shopid;
            if (cache[key]) renderProduct(cache[key]);
            else
              (body.innerHTML =
                '<div class="loading">该商品详情需后端实时抓取。当前为静态部署，仅 TOP 商品含缓存；请在有 server.py 后端的实例上查看完整 SKU 详情。</div>');
          })
          .catch(() => {
            body.innerHTML = '<div class="loading">无法获取商品详情。</div>';
          });
      });
  }

  // ---------- 查商品（直接输入链接/ID 抓真实数据）----------
  function wireLookup() {
    const btn = $("#lookupBtn");
    const inp = $("#lookupInput");
    const go = () => doLookup();
    btn.addEventListener("click", go);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }

  // ---------- 查商品（粘贴链接 → 先查本地库，再考虑后端）----------
  // 为什么重写：原先这里直接 fetch("/api/product?url=...")，而线上是 GitHub Pages **静态部署、没有后端**，
  // 于是每次查询必然 404 报错 —— 是个假功能（比空板块更糟：它会骗用户以为是网络问题）。
  // 现在改成「本地优先」：用户库里已有 400+ 件录制数据，粘一个链接首先要回答的是
  // 「这件我录过没有、数据多新」，这个用本地数据 0 网络就能瞬间回答；
  // 只有库里确实没有时，才去问后端（有 self-host 后端时仍可用），并且最终一定给出可走的路而不是报错。
  function parseShopeeRef(s) {
    const t = String(s || "").trim();
    if (!t) return null;
    let m = t.match(/i\.(\d{4,})\.(\d{4,})/);          // …-i.<shopid>.<itemid>（虾皮最常见的 slug 形式）
    if (m) return { shopid: m[1], itemid: m[2] };
    m = t.match(/\/product\/(\d{4,})\/(\d{4,})/);       // /product/<shopid>/<itemid>
    if (m) return { shopid: m[1], itemid: m[2] };
    m = t.match(/^(\d{4,})[\s/,_-]+(\d{4,})$/);         // 裸「店铺ID 商品ID」
    if (m) return { shopid: m[1], itemid: m[2] };
    return null;
  }
  function refUrl(r) { return "https://shopee.tw/product/" + r.shopid + "/" + r.itemid; }
  // 切到选品库并按关键词搜（用于「你输入的像是名字」时给出出路）
  function gotoLibSearch(q) {
    const tab = $('#tabs .tab-btn[data-tab="library"]');
    if (tab) tab.click();
    const inp = $("#libSearch");
    if (inp) inp.value = q;
    const btn = $("#libBtn");
    if (btn) btn.click();
  }
  // 命中本地库的卡片：把「录过没有 / 多新 / 被门槛藏了没有」一次说清
  function lookupHitHtml(it) {
    const id = libItemId(it);
    const ts = normTs(it.last_seen || it.first_seen);
    const shown = ((state.data && state.data.items) || []).some((x) => libItemId(x) === id);
    const ms = Number(it.month_sold) || 0;
    const gateNote = shown ? "" : `<div class="lk-note">⚠️ 它没出现在商品库列表里，是因为月销 ${fmt(ms)} 低于当前门槛
      （数据仍在库里，去 <b>sales</b> 页把门槛调成「不过滤」就能看到）。</div>`;
    return `<div class="lk-hit">
      <div class="lk-line">✅ 这件商品的录制数据在你的选品库里
        <span class="pcard-fresh lv-${freshLevel(ts)}">${fmtAgo(ts) || "时间未知"}</span>
        <span class="muted">最后采集 ${fmtStamp(ts)}</span></div>
      ${gateNote}
      <div class="lib-grid lk-grid">${pcardHtml(it)}</div>
      <div class="lk-acts">
        <button class="btn" id="lkOpen" data-id="${esc(id)}">查看完整详情</button>
      </div>
    </div>`;
  }
  // 库里没有 → 不要报错，给一条真能走的路
  function lookupMissHtml(ref) {
    const url = refUrl(ref);
    return `<div class="lk-hit lk-miss">
      <div class="lk-line">🔍 这件商品还没进你的选品库</div>
      <div class="lk-note">静态部署没有后端，抓不了实时数据 —— 但它也不需要「抓」：
        <b>打开原商品页逛一下，录制器就会把它录进来</b>（月销 ≥ 30 才会进列表）。</div>
      <div class="lk-acts">
        <a class="btn-lk" href="${esc(url)}" target="_blank" rel="noopener noreferrer">↗ 打开虾皮原商品页去录制</a>
        <span class="muted">店铺 ${esc(ref.shopid)} · 商品 ${esc(ref.itemid)}</span>
      </div>
    </div>`;
  }
  function doLookup() {
    const raw = $("#lookupInput").value.trim();
    const hint = $("#lookupHint");
    const res = $("#lookupResult");
    if (!raw) { hint.textContent = "请粘贴商品链接，或输入 店铺ID 商品ID"; res.innerHTML = ""; return; }
    const ref = parseShopeeRef(raw);
    if (!ref) {
      // 不是链接 → 别摆一个报错，直接带着这个词去选品库搜
      hint.innerHTML = '没识别出商品 ID。若你想按名字找，'
        + '<a href="#" id="lookupToLib" style="color:var(--brand);font-weight:700">点这里去选品库搜「'
        + esc(raw.slice(0, 24)) + '」</a>。';
      res.innerHTML = '<div class="loading">也可以粘贴形如 '
        + '<code>https://shopee.tw/xxx-i.123456789.987654321</code> 的链接，或「123456789 987654321」。</div>';
      const a = $("#lookupToLib");
      if (a) a.addEventListener("click", (e) => { e.preventDefault(); gotoLibSearch(raw); });
      return;
    }
    // ① 本地优先：在**全量库**里找，0 网络。
    //    注意必须用 _rawItems：applyCatalog 会就地把 doc.items 覆盖成「过门槛后」的列表，
    //    只看 items 的话，被月销门槛判低的商品会被误判成「没录过」—— 数据其实一直在。
    const all = (state.catalogAll && (state.catalogAll._rawItems || state.catalogAll.items))
      || (state.data && state.data.items) || [];
    const id = ref.shopid + "_" + ref.itemid;
    const hit = all.find((it) => libItemId(it) === id);
    if (hit) { hint.textContent = ""; res.innerHTML = lookupHitHtml(hit); return; }
    // ② 库里没有 → 有后端时问后端，没有后端就给出「去录制」的出路
    hint.textContent = "⏳ 选品库里没有，正在尝试后端实时抓取…";
    res.innerHTML = '<div class="loading">⏳ 抓取中…</div>';
    fetch("/api/product?url=" + encodeURIComponent(raw))
      .then((r) => {
        if (r.ok) return r.json();
        return r.json().then((j) => Promise.reject(j)).catch(() => Promise.reject({ error: "HTTP " + r.status }));
      })
      .then((d) => { hint.textContent = ""; renderProduct(d, "#lookupResult"); })
      .catch(() => { hint.textContent = ""; res.innerHTML = lookupMissHtml(ref); });
  }

  function renderProduct(d, target) {
    const container = target || "#modalBody";
    const cur = d.currency || "NT$";
    const m = (n) => (n == null ? "—" : cur + Number(n).toLocaleString("zh-Hant"));
    const f = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-Hant"));
    const badge = d.mode === "live" ? "LIVE" : "DEMO";
    const warn = d.warning ? `<div class="p-warn">⚠️ ${esc(d.warning)}</div>` : "";
    const img = d.image
      ? `<img class="p-img" src="${esc(proxyImg(d.image, 640))}" referrerpolicy="no-referrer" loading="lazy" decoding="async" alt="" onerror="__imgFallback(this)">`
      : `<div class="p-img p-img-empty">📦</div>`;
    const skus = (d.skus && d.skus.length)
      ? d.skus
          .map(
            (s) =>
              `<tr><td>${esc(s.name)}</td><td class="num">${m(s.price)}</td>` +
              `<td class="num">${f(s.stock)}</td><td class="num">${f(s.sold)}</td></tr>`
          )
          .join("")
      : '<tr><td colspan="4" style="color:#999">该商品无多规格 / 未返回 SKU</td></tr>';
    const tiers = (d.tiers && d.tiers.length)
      ? d.tiers.map((t) => `<span class="pill">${esc(t.name)}: ${esc((t.options || []).join(" / "))}</span>`).join(" ")
      : "";
    $(container).innerHTML = `
      <div class="p-head">
        ${img}
        <div class="p-meta">
          <div class="p-name">${esc(d.name)} <span class="badge ${d.mode}">${badge}</span></div>
          <div class="p-sub">${esc(d.shop_location || "未知产地")}${d.is_official_shop ? " · 官方旗舰" : ""} · 评分 ${d.rating_star}（${f(d.rating_count)} 评价）</div>
          <a class="p-link" href="${esc(d.url)}" target="_blank" rel="noopener">在虾皮查看 ↗</a>
        </div>
      </div>
      ${warn}
      <div class="p-cards">
        <div class="p-card"><div class="n">${f(d.historical_sold)}</div><div class="l">总销量</div></div>
        <div class="p-card"><div class="n">${f(d.weekly_sold)}</div><div class="l">周销量</div></div>
        <div class="p-card"><div class="n">${fmtMonth(d.month_sold)}</div><div class="l">月销量</div></div>
        <div class="p-card"><div class="n">${m(d.price_min)}${d.price_max && d.price_max !== d.price_min ? " ~ " + m(d.price_max) : ""}</div><div class="l">售价区间</div></div>
      </div>
      ${tiers ? `<div class="p-tiers">${tiers}</div>` : ""}
      <h3 class="p-h3">各 SKU 售价 / 库存 / 销量</h3>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>规格</th><th class="num">售价</th><th class="num">库存</th><th class="num">销量</th></tr></thead>
          <tbody>${skus}</tbody>
        </table>
      </div>
      <div class="p-desc">${esc((d.description || "").slice(0, 300))}</div>
    `;
  }

  // =======================================================================
  // 商品库（可搜索真实商品）
  // =======================================================================
  function starStr(r) {
    const n = Math.max(0, Math.min(5, Math.round(Number(r) || 0)));
    return "★".repeat(n) + "☆".repeat(5 - n);
  }

  // ===== 选品库 批量操作：勾选 / 永久删除（落到 GitHub 源）/ 导出 =====
  // 删除为「真删除」：选中商品从 GitHub 源 catalog.json 中移除（走 Git Data API，
  // 支持 >1MB 大文件），不再做任何本机隐藏。删除后刷新仍生效；若录制器日后重新
  // 录制到该商品，会再次合并进源，网站自动重现（doSync 只推送 pending，不回灌历史）。
  const libSel = { selected: new Set() };
  let LIB_CARD_MODE = false; // 仅选品库网格渲染卡片勾选框，收藏/店铺分析网格不加
  let FORCE_FAV = false;     // 收藏面板强制显示收藏按钮（避免用户关了按钮后无法取消收藏）
  const LS_GH_TOKEN = "shopee_gh_token_v1"; // 网站写 GitHub 用的 token（与录制器共用同一个 PAT 即可）
  function libItemId(it) {
    // 显示时 normalizeCatalog 已把 id 算成 shopid_itemid；源原始 items 无 id，按同规则兜底
    if (it.id) return String(it.id);
    if (it.shopid != null && it.itemid != null) return String(it.shopid) + "_" + String(it.itemid);
    return String(it.id);
  }
  // ★★ 时间戳单位归一化（2026-08-31 关键修复，删除复活的真因）★★
  // 历史混用两种单位：录制器 doSync 写 Date.now()/1000（秒，10 位），
  // 而旧版 deleteFromCatalog 写 Date.now()（毫秒，13 位）→ 源里残留毫秒值。
  // 后果：一份「删除前」的陈旧 CDN 副本带着毫秒级 catalog_ts，因数值远大于任何秒级值，
  //   会通过 validate 被误判为最新 → pruneDelSet 见到其中的已删商品 → 误判「已重新录制」
  //   → 把它从删除集合移除 → 刷新后商品复活（且新数据因秒级偏小被永久拒绝）。
  // 统一折算为「秒」后再比较，单位错配即不复存在。
  function normTs(ts) {
    let n = Number(ts);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 1e11) n = Math.floor(n / 1000); // 毫秒 → 秒
    return Math.floor(n);
  }

  // ---------- 数据新鲜度（2026-09-10 新增）----------
  // 为什么要有：录制数据可能停留在两周前（线上最早 8/26）。不标注的话，
  // 用户会把陈旧月销当成今天的市场情况，选品判断直接跑偏。
  // 口径：用 last_seen（最后采集时间，秒）——每次录到都会刷新，正好等于「这条数据的新鲜度」。
  function fmtAgo(ts) {
    const t = normTs(ts);
    if (!t) return "";
    const d = Math.floor(Date.now() / 1000) - t;
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + "分钟前";
    if (d < 86400) return Math.floor(d / 3600) + "小时前";
    const days = Math.floor(d / 86400);
    if (days < 30) return days + "天前";
    return Math.floor(days / 30) + "个月前";
  }
  // 分级：1 天内 fresh｜1~7 天 aging｜7 天以上 stale（越旧越刺眼）
  function freshLevel(ts) {
    const t = normTs(ts);
    if (!t) return "unknown";
    const d = Math.floor(Date.now() / 1000) - t;
    if (d < 86400) return "fresh";
    if (d < 7 * 86400) return "aging";
    return "stale";
  }
  // 完整时间（本地时区），用于悬浮提示
  function fmtStamp(ts) {
    const t = normTs(ts);
    if (!t) return "未知";
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function freshBadgeHtml(it) {
    if (!cardCfg().fresh) return "";
    const ts = it.last_seen || it.first_seen;
    const txt = fmtAgo(ts);
    if (!txt) return "";
    return `<span class="pcard-fresh lv-${freshLevel(ts)}" title="最后采集：${fmtStamp(ts)}">${txt}</span>`;
  }
  // 陈旧数据的「出路」。
  // 为什么要有：新鲜度角标 >7 天转红，但那是**提醒**不是**动作**——用户看到红色之后无事可做，
  // 只能干瞪眼。这里给陈旧商品一个零风控入口：打开虾皮原商品页，录制器被动录到就会刷新这条数据。
  // 刻意只做「开一个页面」：不主动发请求、不批量翻页、不后台轮询，避免触发虾皮风控。
  function recheckHtml(it) {
    if (!cardCfg().fresh) return "";
    const ts = normTs(it.last_seen || it.first_seen);
    if (!ts) return "";
    if (freshLevel(ts) !== "stale") return "";           // 只有 >7 天且标红的商品才给入口
    const url = String(it.url || "");
    if (!/^https:\/\/shopee\.tw\/product\/\d+\/\d+/.test(url)) return "";
    const days = Math.floor((Date.now() / 1000 - ts) / 86400);
    return `<a class="pcard-recheck" href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
      + ` title="打开虾皮原商品页，录制器会自动刷新这条数据">↻ 已 ${days} 天，去重录</a>`;
  }

  // ---------- 卡片显示字段（2026-09-10 新增）----------
  // 用户口径：卡片只留自己关心的数字（图 / 名 / 价格区间 / 月销 / 总销量），
  // 关掉其余字段后卡片变矮 → 一屏看更多商品，这才是「一眼看懂」的前提。
  // 主图与名称是卡片身份，恒显示不可关。默认全开，保证不改动用户现有观感。
  const CARD_FIELD_KEY = "shopee_cardfields_v1";
  function cardFieldDefs() {
    return [
      { k: "price", label: "价格 / 价格区间" },
      { k: "sku", label: "主卖 SKU" },
      { k: "rating", label: "评分" },
      { k: "sales", label: "周 / 月 / 总销量" },
      { k: "official", label: "官方标" },
      { k: "shop", label: "店铺名" },
      { k: "loc", label: "地区" },
      { k: "cats", label: "品类标签" },
      { k: "fresh", label: "数据新鲜度" },
      { k: "fav", label: "收藏按钮" },
    ];
  }
  function loadCardCfg() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(CARD_FIELD_KEY) || "null"); } catch (e) { raw = null; }
    const cfg = {};
    cardFieldDefs().forEach((f) => {
      cfg[f.k] = (raw && typeof raw === "object" && (f.k in raw)) ? !!raw[f.k] : true;
    });
    return cfg;
  }
  function saveCardCfg(cfg) {
    try { localStorage.setItem(CARD_FIELD_KEY, JSON.stringify(cfg)); } catch (e) {}
    if (state) state.cardCfg = cfg;
  }
  function cardCfg() {
    if (!state.cardCfg) state.cardCfg = loadCardCfg();
    return state.cardCfg;
  }

  function libRerender() {
    // 本地过滤渲染统一入口：有本地数据就走本地，没有也由 clientLibSearch 给出空态/加载态。
    clientLibSearch();
  }
  // GitHub 写 token：优先用网站设置页填写的，回退到 source.json 的 api_token
  function getGhToken() {
    try { const t = localStorage.getItem(LS_GH_TOKEN); if (t) return t; } catch (e) {}
    return _source.api_token || "";
  }
  // UTF-8 字符串 -> base64（中文安全）
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  // 通用 GitHub JSON 请求（支持 method/body），非 2xx 抛错
  async function ghApiJson(method, url, token, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const headers = { Accept: "application/vnd.github+json", Authorization: "Bearer " + token };
    if (body) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: "no-store" });
    } finally { clearTimeout(timer); }
    const text = await r.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!r.ok) { const msg = (data && (data.message || JSON.stringify(data))) || ("HTTP " + r.status); throw new Error(msg); }
    return data;
  }
  // 永久删除：把选中 id 从源 catalog 移除。
  // ★ 2026-09-09：优先走后端（响应 < 100ms + 跨设备 + 多用户隔离），
  //   后端未配置（无 token / requireAuth 未开启）时回退原 GitHub 流程。
  async function deleteFromCatalog(ids) {
    if (window.ShopeeAuth && window.ShopeeAuth.isLoggedIn && window.ShopeeAuth.isLoggedIn()) {
      return await deleteFromBackend(ids);
    }
    return await deleteFromGithubLegacy(ids);
  }
  async function deleteFromBackend(ids) {
    try {
      const r = await window.ShopeeAuth.apiDelete('/api/catalog/items', { ids: Array.from(ids) });
      if (!r.ok) return { ok: false, error: r.error || '后端删除失败' };
      return { ok: true, removed: r.removed, ts: r.ts };
    } catch (e) {
      return { ok: false, error: '后端不可达：' + (e.message || e) };
    }
  }
  async function deleteFromGithubLegacy(ids) {
    const token = getGhToken();
    if (!token) return { ok: false, error: "未配置 GitHub Token（点「⚙ GitHub Token」填写）" };
    const tk = token;
    _source.api_token = tk; // 让随后的 fetchCatalogViaApi 也用该 token 读，避免未认证限流
    const { owner, repo, branch } = parseRepoInfo();
    const path = _source.catalog_path || "catalog.json";
    const api = "https://api.github.com/repos/" + owner + "/" + repo;
    const idSet = new Set(ids);
    // 1) 拉当前 catalog（实时，无 CDN 缓存）
    let doc;
    // 限时 12s：内部 fetchJsonTimeout 最坏要等 20s(tree)+35s(blob)，慢网络会让删除按钮
    // 长时间无响应。这里主动截断，超时即判定读取失败（本地删除集合已先行落盘，删除仍然生效）。
    try {
      doc = await Promise.race([
        fetchCatalogViaApi(0),
        new Promise((_, rej) => setTimeout(() => rej(new Error("读取 GitHub 源超时(12s)")), 12000)),
      ]);
    } catch (e) { return { ok: false, error: "拉取源数据失败：" + (e.message || e) }; }
    const before = (doc.items || []).length;
    doc.items = (doc.items || []).filter((it) => !idSet.has(libItemId(it)));
    const removed = before - doc.items.length;
    if (removed === 0) return { ok: true, removed: 0 };
    // ★ 单位统一为「秒」：录制器全局用 Date.now()/1000，删除若用毫秒会让 DELETE_TS_KEY
    //   门槛变成极大值，既可能误拦正常新数据，又会让「重新录制后该商品应再现」失效。
    // 秒级且严格递增：源里可能残留毫秒值，先归一化再 +1，确保删除后时间戳一定比旧值大，
    // 使陈旧 CDN 副本（时间戳偏小）被 validate 正确拒绝，不会触发 pruneDelSet 误解除。
    const ts = Math.max(normTs(doc.catalog_ts) + 1, Math.floor(Date.now() / 1000));
    doc.catalog_ts = ts; // 标记新鲜，避免 Gitee / CDN 缓存让已删商品回显
    // ★★ 服务端权威删除标记（2026-09-01）：把被删 id 直接写进 catalog.json 的 deleted 字段。
    //   格式 { "<shopid_itemid>": <删除时间戳秒> }。
    //   为什么需要：跨境卫士等隐私浏览器可能退出即清空 localStorage，导致纯本地删除集合失效
    //   （表现为"删了刷新又全部回来"）。写进 GitHub 源后，删除与浏览器无关：换浏览器/清缓存/换电脑都有效。
    //   重新录制可覆盖：若商品被重新录制，其 last_seen 会大于删除时间戳 → 重新显示（见 applyCatalog）。
    try {
      const delMap = (doc.deleted && typeof doc.deleted === 'object' && !Array.isArray(doc.deleted)) ? doc.deleted : {};
      idSet.forEach((id) => { delMap[id] = ts; });
      doc.deleted = delMap;
    } catch (e) {}
    // 同步修正 total：否则 catalog.total 与实际 items 数量不符，
    // 顶栏「录制中 · N件」与页面「N 件商品」会对不上（用户反馈数量不一致）。
    doc.total = (doc.items || []).length;
    // ★ 双保险：把删除标记同步写入独立小文件 deleted.json。
    //   catalog.json 体积大（>120KB），慢网络下网站可能拿到「删除前」的陈旧副本（不含 deleted 字段）；
    //   deleted.json 只有几 KB，经 api.github.com 拉取快且可靠，可作为独立的权威删除源兜底。
    try { await writeDeletedMap(doc.deleted, tk); } catch (e) {}
    const newContent = JSON.stringify(doc);
    // ★ 速度优化：优先 GitHub Contents API（单 PUT 即可完成 blob+tree+commit+ref，
    //   仅需 ~2 次请求），远快于 Git Data API 的 6 次串行。内容 >1MB 时回退 Git Data API。
    try {
      const cur = await ghApiJson("GET", api + "/contents/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(branch), tk);
      const sha = cur.sha;
      await ghApiJson("PUT", api + "/contents/" + encodeURIComponent(path), tk, {
        message: "site: delete " + removed + " items",
        content: utf8ToB64(newContent),
        sha: sha,
        branch: branch,
      });
      return { ok: true, removed, ts };
    } catch (e) {
      const msg = e.message || "";
      if (/413|payload too large|request entity too large|content length|exceeds/i.test(msg)) {
        // 大文件回退 Git Data API
        const r = await deleteViaGitData(api, branch, path, newContent, removed, tk);
        if (r.ok) r.ts = ts;
        return r;
      }
      if (/409/.test(msg)) {
        // 并发冲突（sha 过期）：重新取 sha 再试一次
        try {
          const cur2 = await ghApiJson("GET", api + "/contents/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(branch), tk);
          await ghApiJson("PUT", api + "/contents/" + encodeURIComponent(path), tk, {
            message: "site: delete " + removed + " items",
            content: utf8ToB64(newContent),
            sha: cur2.sha,
            branch: branch,
          });
          return { ok: true, removed, ts };
        } catch (e2) { return { ok: false, error: e2.message || String(e2) }; }
      }
      return { ok: false, error: msg };
    }
  }
  // Git Data API 回退路径（用于 Contents API 因 >1MB 失败的大 catalog）
  async function deleteViaGitData(api, branch, path, newContent, removed, tk) {
    try {
      const ref = await ghApiJson("GET", api + "/git/refs/heads/" + encodeURIComponent(branch), tk);
      const commitSha = ref.object.sha;
      const commit = await ghApiJson("GET", api + "/git/commits/" + commitSha, tk);
      const baseTreeSha = commit.tree.sha;
      const blob = await ghApiJson("POST", api + "/git/blobs", tk, { content: utf8ToB64(newContent), encoding: "base64" });
      const tree = await ghApiJson("POST", api + "/git/trees", tk, { base_tree: baseTreeSha, tree: [{ path: path, mode: "100644", type: "blob", sha: blob.sha }] });
      const newCommit = await ghApiJson("POST", api + "/git/commits", tk, { message: "site: delete " + removed + " items", tree: tree.sha, parents: [commitSha] });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await ghApiJson("PATCH", api + "/git/refs/heads/" + encodeURIComponent(branch), tk, { sha: newCommit.sha, force: false });
          return { ok: true, removed };
        } catch (e) {
          if (attempt === 0 && /422/.test(e.message)) {
            const r2 = await ghApiJson("GET", api + "/git/refs/heads/" + encodeURIComponent(branch), tk);
            const c2 = await ghApiJson("GET", api + "/git/commits/" + r2.object.sha, tk);
            const b2 = await ghApiJson("POST", api + "/git/blobs", tk, { content: utf8ToB64(newContent), encoding: "base64" });
            const t2 = await ghApiJson("POST", api + "/git/trees", tk, { base_tree: c2.tree.sha, tree: [{ path: path, mode: "100644", type: "blob", sha: b2.sha }] });
            const cm2 = await ghApiJson("POST", api + "/git/commits", tk, { message: "site: delete " + removed + " items", tree: t2.sha, parents: [r2.object.sha] });
            newCommit.sha = cm2.sha;
            continue;
          }
          return { ok: false, error: "更新引用失败：" + e.message };
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  // 把删除标记写入独立小文件 deleted.json（供网站优先校验，避免大 catalog 陈旧副本导致复活）
  async function writeDeletedMap(delMap, tk) {
    try {
      const { owner, repo, branch } = parseRepoInfo();
      const api = "https://api.github.com/repos/" + owner + "/" + repo;
      const path = "deleted.json";
      let sha = null;
      try {
        const cur = await ghApiJson("GET", api + "/contents/" + path + "?ref=" + encodeURIComponent(branch), tk);
        sha = cur && cur.sha ? cur.sha : null;
      } catch (e) { sha = null; }
      const body = {
        message: "site: update deleted markers (" + Object.keys(delMap || {}).length + ")",
        content: utf8ToB64(JSON.stringify(delMap || {})),
        branch: branch,
      };
      if (sha) body.sha = sha;
      await ghApiJson("PUT", api + "/contents/" + path, tk, body);
      console.log("[site] deleted.json 已更新，标记数:", Object.keys(delMap || {}).length);
    } catch (e) {
      console.log("[site] deleted.json 写入失败(不影响主流程):", e && e.message);
    }
  }
  // 读取 deleted.json（小文件，走 Git Data API 无 CDN 缓存，慢网络也比大 catalog 可靠）
  let _serverDeleted = {};
  // 拉取 GitHub 上的独立删除标记 deleted.json（服务端权威删除源）。
  // 2026-09-02：① 全程后台执行（不再阻塞首屏）；② 收紧超时并增加 raw 直链并行兜底——
  //   GitHub Git Data API 权威但大陆慢，raw.githubusercontent.com CDN 快但可能滞后几分钟，
  //   两路并行谁先成功用谁（本站删除有本地 DELSET 即时兜底，raw 短暂滞后无实质影响）。
  async function fetchServerDeleted() {
    const collect = (d) => {
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const cur = _serverDeleted && typeof _serverDeleted === 'object' ? _serverDeleted : {};
        let changed = false;
        const m = Object.assign({}, cur);
        for (const k in d) { if (!(k in m) || Number(d[k]) > Number(m[k])) { m[k] = d[k]; changed = true; } }
        if (changed) _serverDeleted = m;
      }
    };
    const apiTry = async () => {
      const { owner, repo, branch } = parseRepoInfo();
      const token = getGhToken() || _source.api_token || '';
      const headers = { 'Accept': 'application/vnd.github+json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      const tree = await fetchJsonTimeout(`${base}/git/trees/${branch}?recursive=1`, 8000, headers);
      const entry = (tree.tree || []).find((e) => e.path === 'deleted.json');
      if (!entry) return null;
      const blob = await fetchJsonTimeout(`${base}/git/blobs/${entry.sha}`, 8000, headers);
      const content = blob.encoding === 'base64' ? b64ToUtf8(blob.content) : blob.content;
      return JSON.parse(content);
    };
    const rawTry = async () => {
      const { owner, repo, branch } = parseRepoInfo();
      return fetchJsonTimeout(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/deleted.json?_=${Date.now()}`, 8000)
        .catch(() => null);
    };
    try {
      const results = await Promise.allSettled([apiTry(), rawTry()]);
      results.forEach((r) => { if (r.status === 'fulfilled' && r.value) collect(r.value); });
    } catch (e) { /* 读不到就保持空，不影响主流程 */ }
  }

  function updateSelAllState() {
    const boxes = $$(".pcard-check", $("#libGrid"));
    const sa = $("#libSelectAll");
    if (!sa) return;
    if (!boxes.length) { sa.checked = false; sa.indeterminate = false; return; }
    const checked = boxes.filter((b) => b.checked).length;
    sa.checked = checked === boxes.length;
    sa.indeterminate = checked > 0 && checked < boxes.length;
  }
  function onLibSelectAll(e) {
    const boxes = $$(".pcard-check", $("#libGrid"));
    boxes.forEach((b) => { b.checked = e.target.checked; if (b.checked) libSel.selected.add(b.dataset.id); else libSel.selected.delete(b.dataset.id); });
  }
  async function onLibDeleteSelected() {
    if (!libSel.selected.size) { $("#libHint").textContent = "请先勾选要删除的商品（点卡片左上角方框）。"; return; }
    const ids = [...libSel.selected];
    const idSet = new Set(ids);
    // ★★ 2026-09-01 关键修复：把「本地删除集合 + 删除时间戳」的持久化放在最前面、
    //   在任何网络请求之前同步执行。旧写法放在 await deleteFromCatalog() 之后，
    //   而该函数的第一步就是 fetchCatalogViaApi（慢网络可达 20~55 秒）；用户等不及或中途刷新时，
    //   这段落盘代码根本没机会执行 → 删除集合为空 → 刷新后商品"全部回来"。
    //   现在点击即落盘，之后即便网络失败/超时/用户立刻刷新，删除也一定生效。
    try {
      localStorage.setItem(DELETE_TS_KEY, String(Math.floor(Date.now() / 1000)));
      const s0 = loadDelSet();
      ids.forEach((id) => s0.add(id));
      saveDelSet(s0);
    } catch (e) {}
    // 同步把已删商品从本机 catalog 缓存中剔除，保证缓存层也不会把它们带回来
    try {
      const cc = loadCatalogCache();
      if (cc && cc.doc && Array.isArray(cc.doc.items)) {
        const beforeLen = cc.doc.items.length;
        cc.doc.items = cc.doc.items.filter((it) => !idSet.has(libItemId(it)));
        cc.doc.total = cc.doc.items.length;
        if (cc.doc.items.length !== beforeLen) saveCatalogCache(cc.doc);
      }
    } catch (e) {}
    // 记录删除前的总数：删除后网格会被后面的商品「补位填满」，若不看总数容易误以为没删掉。
    const totalBefore = (state.catalogAll && state.catalogAll.items ? state.catalogAll.items.length
      : (state.lib.catalogFallback || []).length);
    // 乐观更新：先从本地视图移除，按钮秒响应（不再等 6 次网络请求）
    if (state.lib.catalogFallback) state.lib.catalogFallback = state.lib.catalogFallback.filter((it) => !idSet.has(libItemId(it)));
    if (state.catalogAll && state.catalogAll.items) {
      state.catalogAll.items = state.catalogAll.items.filter((it) => !idSet.has(libItemId(it)));
      if (typeof state.catalogAll.total === "number") state.catalogAll.total = Math.max(0, state.catalogAll.total - ids.length);
    }
    libSel.selected.clear();
    updateSelAllState();
    // 删除后若当前已无商品，直接回到第 1 页，避免空列表保留旧分页
    if (!(state.lib.catalogFallback && state.lib.catalogFallback.length)) state.lib.page = 1;
    libRerender();
    $("#libHint").textContent = "正在从 GitHub 源永久删除 " + ids.length + " 件…";
    const r = await deleteFromCatalog(ids);
    // ★ 渲染级 + 新鲜度保险：无论真实 GitHub 删除是否成功（未填 Token 时 GitHub 写会失败），
    //   都持久化「本地删除集合」与「删除时间戳」。这样即便刷新时落到仍含该商品的 Gitee 陈旧镜像，
    //   渲染过滤也会隐藏它，杜绝「删除后刷新又回来」。真删除成功时 GitHub 源也一并移除（重新录制才再现）。
    //   这一层完全在网站本机 localStorage，不触碰录制器，因此不会影响录制。
    try {
      const delTs = (r && r.ok && r.ts) ? r.ts : Math.floor(Date.now() / 1000);
      localStorage.setItem(DELETE_TS_KEY, String(delTs));
      const s = loadDelSet();
      ids.forEach((id) => s.add(id));
      saveDelSet(s);
    } catch (e) {}
    if (r && r.ok) {
      const totalAfter = (state.catalogAll && state.catalogAll.items ? state.catalogAll.items.length
        : (state.lib.catalogFallback || []).length);
      $("#libHint").textContent = r.removed > 0
        ? "✅ 已永久删除 " + r.removed + " 件：商品总数 " + totalBefore + " → " + totalAfter
          + "（已从 GitHub 源移除，刷新不会回来；页面会被后面商品补位填满，属正常）。"
        : "所选商品在源中已不存在，无需删除。";
    } else {
      // 真实删除失败：必须在本站填写 GitHub PAT 才能写源。扩展在跨境卫士，无法桥接。
      $("#libHint").textContent = "已从本机隐藏 " + ids.length + " 件（刷新不再显示；重新录制会再次出现）。"
        + (r && r.error ? " 网站写入失败：" + r.error + "（请到「⚙ GitHub Token」填写具写权限的 PAT。）" : "");
    }
  }
  function onLibExportClean() {
    const all = state.lib.catalogFallback || [];
    const doc = { items: all, generated_at: Date.now(), total: all.length, note: "从网站导出的全部录制商品" };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shopee_catalog_export.json";
    a.click();
    $("#libHint").textContent = "已导出 " + all.length + " 件为 JSON（shopee_catalog_export.json）。";
  }

  function wireLibrary() {
    const L = state.lib;
    const els = {
      search: $("#libSearch"), btn: $("#libBtn"), cat: $("#libCat"),
      loc: $("#libLoc"), sort: $("#libSort"), price: $("#libPrice"),
      minSold: $("#libMinSold"), minRating: $("#libMinRating"), minMonth: $("#libMinMonth"),
      hint: $("#libHint"), count: $("#libCount"), grid: $("#libGrid"), pager: $("#libPager"),
    };
    // 品类 / 地区下拉：静态部署无后端时直接走本地 catalog.json（免掉一次 404 往返）。
    // probeBackend() 只发一次请求并缓存结论，成功则用后端数据，失败则本地构建。
    probeBackend().then((f) => {
      if (f) {
        L.cats = f.categories || [];
        L.locs = f.locations || [];
        els.cat.innerHTML =
          '<option value="">全部</option>' +
          L.cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.count})</option>`).join("");
        els.loc.innerHTML =
          '<option value="">全部</option>' +
          L.locs.map((l) => `<option value="${l.name}">${esc(l.name)} (${l.count})</option>`).join("");
        syncFilterOptions(els.cat); syncFilterOptions(els.loc);
      } else {
        loadCatalogFallback(els);
      }
    });

    const go = (resetPage) => { if (resetPage) L.page = 1; runLibSearch(); };
    els.btn.addEventListener("click", () => { L.q = els.search.value.trim(); go(true); });
    els.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { L.q = els.search.value.trim(); go(true); }
    });
    // 输入过程中同步刷新关注词看板：让「+ 关注『当前词』」即时出现（网格仍等回车/点按钮才重绘）
    if (els.search && !els.search.__kwInput) {
      els.search.__kwInput = true;
      els.search.addEventListener("input", debounce(() => { renderKw(); }, 250));
    }
    els.cat.addEventListener("change", () => { L.cat = els.cat.value; go(true); });
    els.loc.addEventListener("change", () => { L.loc = els.loc.value; go(true); });
    els.sort.addEventListener("change", () => { L.sort = els.sort.value; go(false); });
    els.price.addEventListener("change", () => {
      const v = els.price.value;
      if (v) { const a = v.split("-").map(Number); L.min_price = a[0]; L.max_price = a[1]; }
      else { L.min_price = null; L.max_price = null; }
      go(true);
    });
    els.minSold.addEventListener("change", () => { L.min_sold = parseInt(els.minSold.value) || 0; go(true); });
    els.minMonth.addEventListener("change", () => { L.min_month = parseInt(els.minMonth.value) || 0; go(true); });
    els.minRating.addEventListener("change", () => { L.min_rating = parseFloat(els.minRating.value) || 0; go(true); });

    els.pager.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-page]");
      if (!b || b.disabled) return;
      const p = parseInt(b.dataset.page, 10);
      if (p >= 1 && p <= L.pages) { L.page = p; runLibSearch(); }
    });
    // 卡片点击（打开详情 / 收藏）统一由 document 委托处理，见 wireProductModal
    $("#libExport").addEventListener("click", exportLibCsv);

    // ===== 选品库 批量操作接线（勾选 / 永久删除 / 导出）=====
    const selAll = $("#libSelectAll");
    if (selAll) selAll.addEventListener("change", onLibSelectAll);
    $("#libDelSel").addEventListener("click", onLibDeleteSelected);
    $("#libExportClean").addEventListener("click", onLibExportClean);
    // GitHub Token 设置（用于「删除选中」写回源数据）
    const tb = $("#ghTokenBtn"), tp = $("#ghTokenPanel"), ti = $("#ghTokenInput"), ts = $("#ghTokenSave"), tc = $("#ghTokenClose"), tm = $("#ghTokenMsg");
    if (tb) tb.addEventListener("click", () => {
      try { ti.value = localStorage.getItem(LS_GH_TOKEN) || _source.api_token || ""; } catch (e) {}
      tp.classList.remove("hidden"); tm.textContent = "";
    });
    if (tc) tc.addEventListener("click", () => tp.classList.add("hidden"));
    const tc2 = $("#ghTokenClose2"); if (tc2) tc2.addEventListener("click", () => tp.classList.add("hidden"));
    if (ts) ts.addEventListener("click", () => {
      const v = (ti.value || "").trim();
      try { if (v) localStorage.setItem(LS_GH_TOKEN, v); else localStorage.removeItem(LS_GH_TOKEN); } catch (e) {}
      tm.textContent = v ? "✓ 已保存（刷新页面后仍生效）" : "已清空，将改用 source.json 的 api_token";
      setTimeout(() => tp.classList.add("hidden"), 900);
    });
    // 清空本地删除记录：解决历史删除记录过多导致商品全部消失的显示问题
    const clearDelBtn = $("#ghClearDel");
    if (clearDelBtn) clearDelBtn.addEventListener("click", () => {
      try {
        localStorage.removeItem(DELETE_TS_KEY);
        localStorage.removeItem(DELSET_KEY);
        tm.textContent = "✓ 已清空本地删除记录，正在重新加载商品…";
        // 重新从本地快照/缓存加载，删除过滤失效后商品会重新显示
        state.catalogAll = null;
        state.lib.catalogFallback = null;
        state.lib._dataReady = false;
        _appliedSig = "";
        _libGridSig = "";
        _loadedCatalogTs = 0;
        loadCatalogAll().then(() => { refreshCurrentView(); showToast("已清空本地删除记录并重新加载"); });
      } catch (e) { tm.textContent = "清空失败：" + (e && e.message); }
    });
    // ★ 2026-09-10 移除：原「从历史 commit(c3089ee, 2026-09-02) 恢复 335 件商品」按钮。
    //   该按钮会把 GitHub 上的 catalog.json 覆盖成两周前的 335 件旧快照，而线上当前已有 491 件
    //   —— 误点一次即永久丢失较新录制数据，且不可撤销。它诞生的背景（today-only 过滤误删历史商品）
    //   早已修复，属于该清理的历史遗留。若将来真需要回滚数据，请走 GitHub 的历史版本，不要在站点上放这种按钮。
    // （已无扩展桥接：跨境卫士无法打开本网站，扩展不能代写 GitHub）
    // 卡片勾选框用事件委托（卡片每次重渲染都会重建 DOM）
    $("#libGrid").addEventListener("change", (e) => {
      const cb = e.target.closest(".pcard-check");
      if (!cb) return;
      if (cb.checked) libSel.selected.add(cb.dataset.id); else libSel.selected.delete(cb.dataset.id);
      updateSelAllState();
    });

    runLibSearch(); // 初始加载
  }

  // ★ 2026-09-03 性能：后端探测只做一次。
  //   本站是 CloudStudio 静态部署，根本没有 /api/* 后端：实测 /api/categories 与
  //   /api/search 都是 404（各约 0.25s）。旧代码每点一次搜索/筛选/排序/翻页，
  //   都先发一次注定失败的请求、等它失败后才回落本地过滤 → 每个按键都白等一遭网络往返，
  //   用户主观感受就是"所有按键都很卡"。
  //   现在开机探测一次：失败即标记 _apiProbe=0（无后端），此后所有搜索直接走本地，零等待；
  //   将来若接上真后端，探测成功会自动走 API，无需改代码。
  let _apiProbe = -1;   // -1=未探测  0=无后端（静态部署）  1=有后端
  let _apiCats = null;  // 探测成功时缓存 /api/categories 的返回
  let _apiProbeP = null;// 探测进行中的 Promise：并发调用复用它，避免同时发出多次探测
  function probeBackend() {
    if (_apiProbe === 0) return Promise.resolve(null);
    if (_apiProbe === 1) return Promise.resolve(_apiCats);
    if (_apiProbeP) return _apiProbeP;
    _apiProbeP = (() => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      return fetch("/api/categories", { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((f) => {
          clearTimeout(timer);
          if (!f || !f.categories) throw new Error("bad payload");
          _apiProbe = 1; _apiCats = f; return f;
        })
        .catch(() => { clearTimeout(timer); _apiProbe = 0; return null; });
    })();
    return _apiProbeP;
  }

  // 简易防抖：避免每敲一个字就重建整页卡片（48 张图重建 → 输入明显掉帧）
  function debounce(fn, ms) {
    let t = null;
    return function () { const a = arguments, s = this; clearTimeout(t); t = setTimeout(() => fn.apply(s, a), ms); };
  }

  function runLibSearch() {
    const L = state.lib;
    // 本地还没有数据 → 直接本地渲染（会给出空态/加载态）
    if (!(state.lib.catalogFallback && state.lib.catalogFallback.length)) {
      clientLibSearch();
      return;
    }
    // 已确认无后端（静态部署）→ 直接本地过滤渲染，一个网络请求都不发
    if (_apiProbe === 0) {
      clientLibSearch();
      return;
    }
    // 探测还没回来（首次调用）→ 等结论再行动。静态部署下探测约 0.25s 就返回 0，
    // 之后所有交互都走本地；这样连第一次「注定 404 的 /api/search」都省掉了。
    if (_apiProbe === -1) {
      probeBackend().then(() => runLibSearch());
      return;
    }
    // 尝试 API 搜索，失败直接走本地（并把结果记下来，后续不再重复试）
    const p = new URLSearchParams({
      q: L.q, cat: L.cat, loc: L.loc, sort: L.sort, page: L.page, size: L.size,
    });
    if (L.min_price != null) p.set("min_price", L.min_price);
    if (L.max_price != null) p.set("max_price", L.max_price);
    if (L.min_sold) p.set("min_sold", L.min_sold);
    if (L.min_month) p.set("min_month", L.min_month);
    if (L.min_rating) p.set("min_rating", L.min_rating);
    $("#libHint").textContent = "⏳ 搜索中…";
    // 1.5 秒超时（原 3s）：静态站点要么秒回 404，要么返回 HTML，1.5s 足够判定
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    fetch("/api/search?" + p.toString(), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((r) => {
        clearTimeout(timer);
        if (!r || !r.items) throw new Error("bad");
        L.offline = false;
        renderLib(r);
      })
      .catch(() => { clearTimeout(timer); _apiProbe = 0; clientLibSearch(); });
  }

  function renderLib(r) {
    const L = state.lib;
    L.total = r.total || 0;
    L.pages = r.pages || 1;
    L.items = r.items || [];
    if (L.items.length) state.lib._dataReady = true;
    const catTotal = r.catalog_total ? `（商品库共 ${fmt(r.catalog_total)} 件）` : "";
    const _tv = normTs(state.catalogAll && state.catalogAll.catalog_ts);
    $("#libCount").textContent = `${fmt(L.total)} 件匹配${catTotal}` + (_tv ? ` · 数据版本 ${fmtAgo(_tv)}` : "");
    $("#libHint").textContent = "";
    renderLibGrid(L.items);
    renderLibPager();
  }

  function renderLibGrid(items) {
    const grid = $("#libGrid");
    LIB_CARD_MODE = true;
    if (!items || !items.length) {
      grid.innerHTML = '<div class="empty">没有符合条件的商品，试试放宽筛选或换个关键词。</div>';
      LIB_CARD_MODE = false;
      updateSelAllState();
      return;
    }
    grid.innerHTML = items.map((it) => pcardHtml(it)).join("");
    LIB_CARD_MODE = false;
    updateSelAllState();
  }

  function renderLibPager() {
    const L = state.lib;
    const pager = $("#libPager");
    if (L.pages <= 1) { pager.innerHTML = ""; return; }
    let h = `<button data-page="${Math.max(1, L.page - 1)}" ${L.page <= 1 ? "disabled" : ""}>‹ 上一页</button>`;
    const start = Math.max(1, L.page - 3), end = Math.min(L.pages, L.page + 3);
    if (start > 1) h += `<button data-page="1">1</button>${start > 2 ? "<span>…</span>" : ""}`;
    for (let pg = start; pg <= end; pg++)
      h += `<button data-page="${pg}" class="${pg === L.page ? "cur" : ""}">${pg}</button>`;
    if (end < L.pages) h += `${end < L.pages - 1 ? "<span>…</span>" : ""}<button data-page="${L.pages}">${L.pages}</button>`;
    h += `<button data-page="${Math.min(L.pages, L.page + 1)}" ${L.page >= L.pages ? "disabled" : ""}>下一页 ›</button>`;
    pager.innerHTML = h;
  }

  function openLibItem(id) {
    const modal = $("#modal");
    const body = $("#modalBody");
    modal.classList.remove("hidden");
    body.innerHTML = '<div class="loading">⏳ 加载商品详情…</div>';
    // ★ 2026-09-03 性能：静态部署无 /api/item（实测 404），已知无后端时直接走本地，
    //   省掉「先等一个注定失败的请求」再回落的那 0.25s + 一次弹窗内容二次重绘。
    if (_apiProbe === 0) { openLibItemLocal(id, body); return; }
    fetch("/api/item/" + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => renderLibDetail(d))
      .catch(() => openLibItemLocal(id, body));
  }
  function openLibItemLocal(id, body) {
    body = body || $("#modalBody");
    // 先在「当前可见列表」里找，再退到「全量库」找。
    // 为什么必须退到全量库：catalogFallback 是**月销门槛过滤后**的列表，被判低的商品数据其实还在
    // catalogAll._rawItems 里。少了这一层，「查商品」里命中一件月销<30 的商品，点详情会报「找不到」—— 数据在，说没了。
    const pools = [state.lib.catalogFallback, state.catalogAll && (state.catalogAll._rawItems || state.catalogAll.items)];
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      if (!pool) continue;
      const it = pool.find(
        (x) => x.id === id || String(x.itemid) === String(id) || libItemId(x) === id
      );
      if (it) return renderLibDetail(it);
    }
    body.innerHTML = '<div class="loading">无法加载详情（需要 server.py 后端，或未在本地缓存中找到）。</div>';
  }

  function renderLibDetail(d) {
    const cur = state.data ? state.data.currency : "NT$";
    const m = (n) => (n == null ? "—" : cur + Number(n).toLocaleString("zh-Hant"));
    const f = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-Hant"));
    const img = d.img
      ? `<img class="p-img" src="${esc(proxyImg(d.img, 640))}" referrerpolicy="no-referrer" loading="lazy" decoding="async" alt="" onerror="__imgFallback(this)">`
      : `<div class="p-img p-img-empty">📦</div>`;
    const cats = (d.cats || []).map((c) => `<span class="pill">${esc(c)}</span>`).join(" ");
    const tiers = (d.tiers && d.tiers.length)
      ? d.tiers.map((t) =>
          `<div class="tier"><b>${esc(t.name)}</b>：${esc((t.options || []).join(" / "))}</div>`
        ).join("")
      : "";
    $("#modalBody").innerHTML = `
      <div class="p-head">
        ${img}
        <div class="p-meta">
          <div class="p-name">${esc(d.name)} ${d.official ? '<span class="badge official">官方</span>' : ""}</div>
          <div class="p-sub">${esc(d.loc || "未知产地")} · 店铺：${esc(d.shop || "—")}${d.brand ? " · 品牌：" + esc(d.brand) : ""}</div>
          <a class="p-link" href="${esc(d.url || "#")}" target="_blank" rel="noopener">在虾皮查看 ↗</a>
        </div>
      </div>
      <div class="p-cards">
        <div class="p-card"><div class="n">${m(d.price)}${(d.price_max && d.price_max > d.price) ? '<span class="pr-sep">–</span>' + m(d.price_max) : ''}${priceSanity(d.price) ? ' <span style="color:#c0392b;font-size:11px;font-weight:600;" title="价格疑似未正确换算，待复核">⚠</span>' : (d.price_repaired ? ' <span style="color:#2e7d32;font-size:11px;font-weight:600;" title="此价格已由系统自动校正">✓</span>' : "")}</div><div class="l">${(d.price_max && d.price_max > d.price) ? '价格区间' : '售价'}</div></div>
        <div class="p-card"><div class="n">${d.main_sku && d.main_sku.price != null ? m(d.main_sku.price) : "—"}</div><div class="l">主卖SKU价</div></div>
        <div class="p-card"><div class="n">${f(d.total_sold)}</div><div class="l">链接总销量</div></div>
        <div class="p-card"><div class="n">${fmtMonth(d.month_sold)}</div><div class="l">月销量</div></div>
        <div class="p-card"><div class="n">${f(d.week_sold)}</div><div class="l">周销量</div></div>
        <div class="p-card"><div class="n">${starStr(d.rating)} ${d.rating}</div><div class="l">评分（${f(d.reviews)} 评价）</div></div>
        <div class="p-card"><div class="n">${f(d.liked)}</div><div class="l">点赞</div></div>
      </div>
      ${d.main_sku && d.main_sku.name ? `<div class="p-tiers"><span class="pill">主卖SKU：${esc(d.main_sku.name)}</span></div>` : ""}
      ${cats ? `<div class="p-tiers">${cats}</div>` : ""}
      ${tiers ? `<h3 class="p-h3">商品规格</h3><div class="tiers-list">${tiers}</div>` : ""}
    `;
  }

  // 静态部署无后端时的回退：加载本地 catalog.json 做前端过滤
  function loadCatalogFallback(els) {
    fetch("data/catalog.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((doc) => {
        // ★ 2026-09-03：只在本地还没有数据时才用快照填充。
        //   旧写法无条件覆盖 state.lib.catalogFallback = doc.items，而 applyCatalog 已经把
        //   删除过滤后的权威数据放进去 → 下拉框构建（异步）会把它覆盖成原始快照，
        //   导致已删商品「复活」，且需要再渲染一次。
        const raw = doc.items || [];
        const src = (state.lib.catalogFallback && state.lib.catalogFallback.length)
          ? state.lib.catalogFallback : raw;
        state.lib.catalogFallback = src;
        if (raw.length) state.lib._dataReady = true;
        const cats = {}, locs = {};
        src.forEach((it) => {
          (it.cats || []).forEach((c) => (cats[c] = (cats[c] || 0) + 1));
          const mt = (it.loc || "").match(/^(.{2,3}?[市縣])/);
          const l = mt ? mt[1] : it.loc;
          if (l) locs[l] = (locs[l] || 0) + 1;
        });
        els.cat.innerHTML = '<option value="">全部</option>' +
          Object.keys(cats).map((c) => `<option value="${esc(c)}">${esc(c)} (${cats[c]})</option>`).join("");
        els.loc.innerHTML = '<option value="">全部</option>' +
          Object.keys(locs).map((l) => `<option value="${esc(l)}">${esc(l)} (${locs[l]})</option>`).join("");
        syncFilterOptions(els.cat); syncFilterOptions(els.loc);
      })
      .catch(() => {});
  }

  // cats / loc 从未被采集 → 下拉永远只有「全部」。与其摆一个点了没反应的控件，
  // 不如隐藏；将来录制器真采到类目了会自动出现。
  function syncFilterOptions(sel) {
    if (!sel) return;
    const lb = sel.closest("label");
    if (!lb) return;
    lb.style.display = sel.options.length > 1 ? "" : "none";
  }

  function applyLibFilters(items, L) {
    let its = items.slice();
    // ★ 命中口径必须只有一处：统一走 libMatch（含简繁归一）。
    //   这里原先内联了一份不带简繁转换的匹配，导致「看板支持简繁、商品库不支持」的割裂。
    const q = (L.q || "").trim();
    if (q) its = its.filter((it) => libMatch(it, q));
    if (L.cat) its = its.filter((it) => (it.cats || []).includes(L.cat));
    if (L.loc) its = its.filter((it) => (it.loc || "").startsWith(L.loc));
    if (L.min_price != null) its = its.filter((it) => it.price >= L.min_price);
    if (L.max_price != null) its = its.filter((it) => it.price <= L.max_price);
    if (L.min_sold) its = its.filter((it) => (it.sold_total || 0) >= L.min_sold);
    if (L.min_month) its = its.filter((it) => (it.month_sold || 0) >= L.min_month);
    if (L.min_rating) its = its.filter((it) => (it.rating || 0) >= L.min_rating);
    const map = {
      sold: (x) => -x.sold_total, sold30: (x) => -x.sold, total_sold: (x) => -x.sold_total,
      month: (x) => -(x.month_sold || 0), week: (x) => -(x.week_sold || 0),
      // rating / reviews / liked / listed_at 从未采集，对应的排序项是死控件，已移除。
      // 价格缺失（=0）一律排最后，不能让它霸占「价格低→高」的前几十名。
      price_asc: (x) => (Number(x.price) > 0 ? x.price : Infinity),
      price_desc: (x) => (Number(x.price) > 0 ? -x.price : -Infinity),
    };
    const keyFn = map[L.sort] || map.sold;
    its.sort((a, b) => keyFn(a) - keyFn(b));
    return its;
  }

  // 网格渲染指纹（见 clientLibSearch 内的去重逻辑）；数据被替换时必须清空才会重新渲染。
  let _libGridSig = "";

  function clientLibSearch() {
    const L = state.lib;
    let items = state.lib.catalogFallback || [];
    if (!items.length) {
      _libGridSig = "";   // 空态也要重置指纹，否则下次有数据时会被误判为「没变」而跳过渲染
      // ★ 2026-09-02：数据一旦成功展示过（_dataReady=true），就绝不再把网格降级回「加载中」占位，
      //   避免后台某次源异常返回空列表时，已正常显示的页面突然闪成"商品正在加载中"并卡住。
      // ★ 2026-09-02b：空列表时也要同步清空计数和分页，否则删除全部商品后会残留旧的"328 件 / 7 页"。
      L.total = 0;
      L.pages = 1;
      L.page = 1;
      $("#libCount").textContent = "0 件商品";
      $("#libPager").innerHTML = "";
      if (state.lib._dataReady) {
        $("#libHint").textContent = "";
        $("#libGrid").innerHTML = '<div class="empty">暂无商品数据（可能全部被删除，或源数据暂不可用）。<br>如需恢复，可到「⚙ GitHub Token」面板下方点「清空本地删除记录」。</div>';
      } else {
        $("#libHint").textContent = "⏳ 正在加载商品数据…";
        $("#libGrid").innerHTML = '<div class="loading">正在加载商品数据…</div>';
      }
      return;
    }
    state.lib._dataReady = true; // 有数据可展示 → 后续任何异常空列表都不再降级成「加载中」
    const all = applyLibFilters(items, L);
    L.total = all.length;
    L.pages = Math.max(1, Math.ceil(all.length / L.size));
    // 页码越界保护：删除/过滤后当前页可能超出总页数，自动回到最后一页
    if (L.page > L.pages) L.page = L.pages || 1;
    const pageItems = all.slice((L.page - 1) * L.size, L.page * L.size);
    // ★ 2026-09-03 性能：网格渲染指纹去重。
    //   旧写法每次调用都无脑重写 #libGrid.innerHTML → 48 张卡片被销毁重建，
    //   视口内的商品图要重新解码（甚至重新请求）→ 翻页/排序/勾选/心跳刷新都会「闪一下 + 卡一下」。
    //   签名 = 筛选条件 + 页码 + 本页商品 id 序列 + 选中态 + 数据版本；
    //   完全一致说明画面本来就长这样，直接跳过重建。
    const selSig = libSel && libSel.selected ? Array.from(libSel.selected).sort().join(",") : "";
    const sig = [L.q, L.cat, L.loc, L.sort, L.min_price, L.max_price, L.min_sold, L.min_month,
      L.min_rating, L.page, L.size, L.total, items.length, _loadedCatalogTs, selSig,
      pageItems.map(libItemId).join(",")].join("|");
    if (sig === _libGridSig && $("#libGrid").children.length) return;
    _libGridSig = sig;
    const _hid = state.lib.hiddenByGate || 0;
    const _ver = fmtAgo(_loadedCatalogTs);
    $("#libCount").textContent = `${fmt(L.total)} 件商品` +
      (_hid ? ` · 已按「月销≥${state.lib.gateUsed}」隐藏 ${fmt(_hid)} 件低动销` : "") +
      (_ver ? ` · 数据版本 ${_ver}` : "");
    if (_loadedCatalogTs) $("#libCount").title = "整站数据版本：" + fmtStamp(_loadedCatalogTs)
      + "（云端约每 3–5 分钟刷新一次；单件的新鲜度见卡片左上角）";
    $("#libHint").textContent = "共 " + fmt(items.length) + " 件录制商品 · 支持搜索/筛选/排序";
    renderLibGrid(pageItems);
    renderLibPager();
  }

  function csvCell(v) {
    const s = String(v == null ? "" : (Array.isArray(v) ? v.join("|") : v));
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportLibCsv() {
    const L = state.lib;
    const p = new URLSearchParams({
      q: L.q, cat: L.cat, loc: L.loc, sort: L.sort, page: 1, size: 5000,
    });
    if (L.min_price != null) p.set("min_price", L.min_price);
    if (L.max_price != null) p.set("max_price", L.max_price);
    if (L.min_sold) p.set("min_sold", L.min_sold);
    if (L.min_month) p.set("min_month", L.min_month);
    if (L.min_rating) p.set("min_rating", L.min_rating);
    const cols = ["id", "name", "price", "price_max", "main_sku", "sold_total", "month_sold", "week_sold",
      "sold", "rating", "reviews", "liked", "stock", "shop", "loc", "brand", "url", "cats"];
    const build = (items) => {
      const rows = items.map((it) => cols.map((c) => {
        if (c === "main_sku") return csvCell(it.main_sku && it.main_sku.name ? it.main_sku.name : "");
        return csvCell(it[c]);
      }).join(",")).join("\n");
      const blob = new Blob(["﻿" + cols.join(",") + "\n" + rows], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "shopee_catalog.csv";
      a.click();
      $("#libHint").textContent = "已导出 " + items.length + " 条为 CSV";
    };
    // ★ 2026-09-03 性能：静态部署无 /api/search，直接本地导出，不必先等一次 404。
    if (_apiProbe === 0 || !(state.lib.catalogFallback && state.lib.catalogFallback.length)) {
      build(applyLibFilters(state.lib.catalogFallback || [], L));
      return;
    }
    fetch("/api/search?" + p.toString())
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((r) => build(r.items || []))
      .catch(() => build(applyLibFilters(state.lib.catalogFallback || [], L)));
  }

  // =======================================================================
  // 行业大盘 / 榜单 / 店铺分析 / 收藏 / 定价计算器（客户端聚合 catalog.json）
  // =======================================================================
  // 生成 Gitee 镜像 raw 直链（国内可直连，真正实时）。gitee 块来自 source.json。
  function giteeRawUrl(kind) {
    const g = _source.gitee;
    if (!g || !g.owner || !g.repo) return null;
    const branch = g.branch || 'master';
    const file = kind === 'sync' ? (g.syncPath || 'sync.json') : (g.catalogPath || 'catalog.json');
    return `https://gitee.com/${g.owner}/${g.repo}/raw/${branch}/${file}`;
  }

  // GitHub raw → jsDelivr CDN（国内可直连）。通用分支写法：
  // raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
  //   ↓
  // cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}
  // 旧写法只 replace("/main/")，分支不是 main 时会生成 jsDelivr 无法解析的地址（静默 404），
  // 等于少了一个可用源，故改为通用正则。
  function toJsDelivr(raw) {
    if (!raw || raw.indexOf("raw.githubusercontent.com") < 0) return null;
    const m = raw.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
    if (!m) return null;
    return "https://cdn.jsdelivr.net/gh/" + m[1] + "/" + m[2] + "@" + m[3] + "/" + m[4];
  }

  function catalogSourceUrls() {
    const urls = [];
    const gitee = giteeRawUrl('catalog');
    if (gitee) urls.push(gitee);   // ★ Gitee 镜像（国内可达，真正实时）放最前
    const raw = _source.catalog_url || "data/catalog.json";
    if (raw.indexOf("raw.githubusercontent.com") >= 0) {
      urls.push(raw);                                                     // GitHub raw（CDN 缓存约 5 分钟）
      const jsd = toJsDelivr(raw);
      if (jsd) urls.push(jsd);                                            // jsDelivr（国内快，但缓存久）
      urls.push(raw.replace("raw.githubusercontent.com/", "ghproxy.net/https://raw.githubusercontent.com/"));   // 镜像兜底
    } else if (raw && raw.indexOf("http") === 0) {
      urls.push(raw);
    }
    urls.push("data/catalog.json"); // 本地打包快照，最后兜底
    return urls;
  }

  function syncSourceUrls() {
    const urls = [];
    const gitee = giteeRawUrl('sync');
    if (gitee) urls.push(gitee);   // ★ Gitee 镜像优先
    const raw = _source.sync_url || "data/sync.json";
    if (raw.indexOf("raw.githubusercontent.com") >= 0) {
      urls.push(raw);
      const jsd = toJsDelivr(raw);
      if (jsd) urls.push(jsd);
      urls.push(raw.replace("raw.githubusercontent.com/", "ghproxy.net/https://raw.githubusercontent.com/"));
    } else if (raw && raw.indexOf("http") === 0) {
      urls.push(raw);
    }
    urls.push("data/sync.json"); // 本地打包快照兜底
    return urls;
  }

  // 带超时的 JSON 拉取。**必须有超时**：raw.githubusercontent.com 拉 catalog.json
  // 经常 10s+ 甚至 SSL 挂死，没有超时会把整条链路拖死 → 页面长时间白屏。
  function fetchJsonTimeout(url, timeoutMs, extraHeaders) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
    const headers = Object.assign({ Accept: "application/json" }, extraHeaders || {});
    return fetch(url, { signal: ctrl.signal, headers: headers, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .finally(() => clearTimeout(timer));
  }

  // 缓存穿透：加随机参数
  function bust(u) {
    const sep = u.indexOf("?") >= 0 ? "&" : "?";
    return u + sep + "_=" + Math.random().toString(36).slice(2) + "&t=" + Date.now();
  }

  // 并行竞速：所有源同时发起，收集所有「通过 validate」的源，最终取 catalog_ts 最大（最新）者；
  // 并列时取 items 最多者（最全）。相比「谁先返回谁赢」，这能避免被「快速但陈旧的镜像」
  // 抢先定胜负——陈旧镜像 catalog_ts 与已加载相等、会判为「已是最新」却不含刚录的新商品。
  // 首个有效源到达后给 1.5s 宽限期，让更新鲜的源（如 GitHub API）有机会抵达；所有源都返回则立即定胜负。
  // 整体 9s 兜底超时防挂死。allowFallback=false 时：没有任何源通过 validate 则坚决 reject
  // （已删商品场景下，stale 镜像 catalog_ts 偏旧被 validate 拒绝，不兜底 → 不「复活」）。
  function raceValid(makers, validate, allowFallback) {
    if (allowFallback === undefined) allowFallback = true;
    return new Promise((resolve, reject) => {
      const valid = [];
      let fallbackDoc = null;
      let left = makers.length;
      if (!left) return reject(new Error("no sources"));
      let done = false;
      let grace = null;
      const pick = () => {
        if (done) return;
        done = true;
        if (grace) { clearTimeout(grace); grace = null; }
        if (valid.length) {
          // 选 catalog_ts 最大者（最新），并列取 items 最多者（最全）。
          // ★ 防御：raceValid 也被 fetchFirst 用于拉 sync.json，而 sync.json 根本没有 items 字段，
          //   直接读 b.items.length 会抛「Cannot read properties of undefined」→ 整个心跳轮询挂掉、页面停旧数据。
          valid.sort((a, b) =>
            normTs(b.catalog_ts) - normTs(a.catalog_ts) ||
            ((b.items && b.items.length) || 0) - ((a.items && a.items.length) || 0));
          const best = valid[0];
          const tsMin = normTs(localStorage.getItem(DELETE_TS_KEY));
          if (tsMin > 0 && normTs(best.catalog_ts) >= tsMin) { try { pruneDelSet(best); } catch (e) {} }
          resolve(best);
        } else if (allowFallback && fallbackDoc) {
          resolve(fallbackDoc);
        } else {
          reject(new Error("all sources failed"));
        }
      };
      const onValid = (v) => {
        valid.push(v);
        if (left === 0) { pick(); return; }            // 所有源已回 → 立即定胜负
        if (!grace) grace = setTimeout(pick, 700);      // 否则给 0.7s 让更新鲜的源抵达
      };
      makers.forEach((mk) => {
        let p;
        try { p = mk(); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(
          (v) => {
            if (done) return;
            if (v && validate(v)) onValid(v);
            else if (v && Array.isArray(v.items) && !fallbackDoc) { fallbackDoc = v; if (left === 0) pick(); }
            if (--left === 0) pick();
          },
          () => { if (!done && --left === 0) pick(); }
        );
      });
      setTimeout(() => { if (!done) pick(); }, 5500); // 整体兜底，防某源永不返回导致挂死
    });
  }

  // 兼容旧调用：并行竞速拉取（用于 sync.json 等小文件）
  function fetchFirst(urls, minCatalogTs) {
    const validate = (doc) => !!doc && (!minCatalogTs || normTs(doc.catalog_ts) >= minCatalogTs);
    return raceValid(
      urls.map((u) => () => fetchJsonTimeout(bust(u), u.indexOf("http") === 0 ? 4500 : 2500)),
      validate
    );
  }

  // 解析 source.json 的 catalog_url，得到 owner/repo/branch
  function parseRepoInfo() {
    const m = (_source.catalog_url || '').match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\//);
    if (m) return { owner: m[1], repo: m[2], branch: m[3] };
    return { owner: '23ccf', repo: 'shopee-sync', branch: 'main' };
  }

  // 通过 GitHub Git Data API（api.github.com/git/...）实时拉取 catalog.json，
  // 完全绕过 raw.githubusercontent.com 的 CDN 缓存（catalog.json 已 >1MB，raw CDN 缓存数分钟）。
  // 未认证可访问 public repo（60 次/小时限额）；在 source.json 配置 api_token（只读）可提高限额。
  // base64 -> UTF-8 字符串（修正中文乱码：atob 只能产出 Latin-1 二进制串，
  // 直接 JSON.parse 会把多字节 UTF-8 当成独立 UTF-16 码元 → 乱码）
  function b64ToUtf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  // 通过 Git Data API 拉取（无 CDN 缓存，永远实时）。
  // 只需 2 次请求：tree 可直接用「分支名」定位，省掉 git/ref + git/commits 两次往返
  // （实测 3.35s → 1.68s，快一半）。
  async function fetchCatalogViaApi(minCatalogTs) {
    const { owner, repo, branch } = parseRepoInfo();
    // 关键修复：读取必须带「⚙ GitHub Token」面板填的 PAT。私有库不带 token 会 404/401，
    // 导致网站永远读不到录制器写入的数据 → 回退空快照 → 显示「已是最新/无商品」。
    const token = getGhToken() || _source.api_token || '';
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const tree = await fetchJsonTimeout(`${base}/git/trees/${branch}?recursive=1`, 9000, headers);
    const cpath = _source.catalog_path || 'catalog.json';
    const entry = (tree.tree || []).find((e) => e.path === cpath);
    if (!entry) throw new Error('catalog not found in tree');
    const blobUrl = `${base}/git/blobs/${entry.sha}`;
    // 优先用 raw media type 取原始内容：体积比 base64 JSON 包装小一半
    // （实测 gzip 后 80KB vs 158KB），且免掉 base64 解码。失败再降级 base64。
    let doc = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const txt = await fetch(blobUrl, {
        signal: ctrl.signal,
        headers: Object.assign({}, headers, { Accept: 'application/vnd.github.raw' }),
        cache: 'no-store',
      }).then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
        .finally(() => clearTimeout(timer));
      doc = JSON.parse(txt);
    } catch (e) {
      const blob = await fetchJsonTimeout(blobUrl, 12000, headers);
      const content = blob.encoding === 'base64' ? b64ToUtf8(blob.content) : blob.content;
      doc = JSON.parse(content);
    }
    if (minCatalogTs && normTs(doc.catalog_ts) < minCatalogTs) throw new Error('api catalog older than required');
    return doc;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 统一拉取：Git Data API（实时）与所有 CDN 源**同时并行竞速**，谁先给出满足
  // minCatalogTs 的数据就用谁。旧写法是「API 失败→再串行试 raw→jsDelivr→…」，
  // 任一慢源都会累加等待（最坏 30s+ 白屏）；并行后总耗时 ≈ 最快源的耗时（约 1s）。
  // 删除成功后写入 localStorage 的时间戳：强制后续刷新只接受「比它更新」的源，
  // 从而拒绝仍含被删商品的 Gitee / CDN 缓存副本（它们不随 GitHub 删除即时更新）。
  const DELETE_TS_KEY = "shopee_delete_ts";
  // 本地删除集合（渲染级保险）：记录「已从 GitHub 源真删」的商品 id。
  // 作用：即使首屏本地快照 / 某次 stale 镜像读取仍含这些商品，渲染时也过滤掉，杜绝「复活」。
  // 它不是黑名单、无「恢复」入口；当某商品被重新录制进 GitHub（出现在新鲜源中）时，
  // pruneDelSet 会自动把它从本集合移除 → 重新显示。与真删 GitHub 源互补，不冲突。
  const DELSET_KEY = "shopee_deleted_ids";
  // ★ 2026-09-01 缓存层：raw.githubusercontent.com 近期被截断为 32 KiB（CDN 缓存问题），
  //   加上 api.github.com 在大陆网络常超时，网站经常拿不到新鲜数据。本机 localStorage 缓存
  //   记录「最后一次成功拉到的 catalog」，即便所有远端源都坏，仍能展示上次成功的数据；
  //   删除仍由 DELSET_KEY 渲染过滤兜底，删除持久不依赖远端。
  const CATALOG_CACHE_KEY = "shopee_catalog_cache";
  function saveCatalogCache(doc) {
    try { localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ ts: normTs(doc.catalog_ts) || Math.floor(Date.now()/1000), doc: doc })); } catch (e) {}
  }
  function loadCatalogCache() {
    try {
      const raw = localStorage.getItem(CATALOG_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return (o && o.doc && Array.isArray(o.doc.items)) ? o : null;
    } catch (e) { return null; }
  }
  function loadDelSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DELSET_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function saveDelSet(s) {
    try { localStorage.setItem(DELSET_KEY, JSON.stringify([...s])); } catch (e) {}
  }
  // 新鲜源已包含的商品 → 视为「仍活着 / 已重新录制」→ 从删除集合中移除（不再屏蔽）。
  function pruneDelSet(doc) {
    if (!doc || !Array.isArray(doc.items)) return;
    const live = new Set(doc.items.map(libItemId));
    const s = loadDelSet();
    // ★ 2026-09-03：服务端删除名单里仍存在的 id，一律不解除本机的删除屏蔽。
    //   旧逻辑只要「商品出现在新鲜源里」就把它从删除集合移除（原意是支持"重新录制"），
    //   但录制器会把用户在店铺页再次浏览到的已删商品重新推回 catalog.json，
    //   于是这些商品被判定为"已重新录制"→ 解除屏蔽 → 复活。
    //   删除是最终决定；恢复走「清空本地删除记录」（会清空 deleted.json，标记自然消失）。
    const srvDel = (_serverDeleted && typeof _serverDeleted === 'object') ? _serverDeleted : {};
    let changed = false;
    for (const id of [...s]) {
      if (!live.has(id)) continue;
      if (srvDel[id]) continue;
      s.delete(id); changed = true;
    }
    if (changed) saveDelSet(s);
  }
  async function fetchLatestCatalog(minCatalogTs) {
    // 合并「上次删除时间戳」作为最低新鲜度门槛：删除后该值 > 0，stale 镜像的 catalog_ts 偏旧
    // 会被 validate 拒绝，只剩 GitHub API 通过 → 删除持久生效。
    const minTs = Math.max(normTs(minCatalogTs), normTs(localStorage.getItem(DELETE_TS_KEY)));
    const validate = (doc) =>
      !!(doc && Array.isArray(doc.items) && normTs(doc.catalog_ts) >= minTs);

    // 自诊断：记录每次同步各源的真实结果，失败时一眼定位根因（控制台 window.__syncDiag 可取）。
    const _diag = (window.__syncDiag = {
      t: Date.now(),
      minTs: minTs,
      tokenFilled: !!getGhToken(),
      gh: null,
      mirrors: [],
      winner: null,
      error: null,
    });

    // ★ 2026-09-02 并行化提速：GitHub Git Data API（权威实时、无 CDN 缓存）与
    //   Gitee / CDN / 本地快照镜像**一次性全部并发发起**。
    //   旧写法「先串行等 GitHub API（15s 超时）→ 失败才竞速镜像」在慢网络最坏要
    //   15s+9s=24s；并行后总耗时 ≈ 最快有效源（网络正常约 1-3s）。
    //   正确性不受影响：raceValid 收集所有通过 validate 的源后取 catalog_ts 最大
    //   （最新）者定胜负，不会被「快速但陈旧的镜像」抢先；删除场景由 minTs 门槛
    //   （DELETE_TS）拒绝 stale 镜像 + applyCatalog 渲染级 delSet/srvDel 双保险兜底。
    const makers = [];
    // maker 1：GitHub Git Data API（权威源，永远实时）。限时由 raceValid 整体兜底控制。
    makers.push(() => fetchCatalogViaApi(minTs)
      .then((doc) => {
        _diag.gh = { ok: !!(doc && validate(doc)), count: doc ? (doc.items || []).length : 0, ts: doc ? (doc.catalog_ts || 0) : 0 };
        if (doc && validate(doc)) {
          const tsMin = normTs(localStorage.getItem(DELETE_TS_KEY));
          if (tsMin > 0 && normTs(doc.catalog_ts) >= tsMin) { try { pruneDelSet(doc); } catch (e) {} }
        }
        return doc;
      })
      .catch((err) => { _diag.gh = { ok: false, error: String((err && err.message) || err) }; throw err; }));
    // maker 2..n：Gitee / CDN 镜像 / 本地快照（已删商品由 DELSET 渲染过滤，镜像稍旧也不「复活」）。
    catalogSourceUrls().forEach((u) => {
      makers.push(() =>
        fetchJsonTimeout(bust(u), u.indexOf("http") === 0 ? 5000 : 2500)
          .then((d) => { _diag.mirrors.push({ url: u, ok: !!validate(d), count: d ? (d.items || []).length : 0, ts: d ? (d.catalog_ts || 0) : 0 }); return d; })
          .catch((err) => { _diag.mirrors.push({ url: u, ok: false, error: String((err && err.message) || err) }); throw err; })
      );
    });
    try {
      const doc = await raceValid(makers, validate, true);
      _diag.winner = "raced(github+mirrors)";
      saveCatalogCache(doc);       // 缓存成功数据 → 远端全坏时本机兜底
      return doc;
    } catch (e) {
      _diag.error = "all sources failed: " + String((e && e.message) || e);
      throw e;
    }
  }

  // 带重试的拉取：服务器已有更新但 CDN 未刷新时等待重试。
  // Git Data API 无缓存，通常首次就能拿到最新，故把等待从 12s×4 缩短为 5s×3。
  async function fetchLatestCatalogWithRetry(serverTs, maxAttempts) {
    maxAttempts = maxAttempts || 3;
    let lastDoc = null;
    for (let i = 0; i < maxAttempts; i++) {
      const minTs = Math.max(_loadedCatalogTs, serverTs || 0);
      let doc = null;
      try { doc = await fetchLatestCatalog(minTs); } catch (e) { doc = null; }
      if (doc && doc.items && normTs(doc.catalog_ts) >= minTs) return doc;
      lastDoc = doc || lastDoc;
      if (i < maxAttempts - 1) await sleep(5000);
    }
    if (lastDoc && lastDoc.items) return lastDoc;
    throw new Error("all sources failed after retries");
  }

  // 后台静默校验线上是否有更新（不阻塞首屏渲染）
  let _revalidating = false;
  function revalidateCatalog(minTs) {
    if (_revalidating) return;
    _revalidating = true;
    // minTs + 1：要求严格比当前更新才替换，避免把同一份数据重复渲染
    fetchLatestCatalog((minTs || 0) + 1)
      .then((doc) => {
        if (doc && Array.isArray(doc.items) && normTs(doc.catalog_ts) > (minTs || 0)) {
          const changed = applyCatalog(doc);
          _loadedCatalogTs = normTs(doc.catalog_ts);
          if (changed) {
            refreshCurrentView();
            try { showToast("☁ 已更新到最新商品（" + doc.items.length + " 件）"); } catch (_) {}
          }
        }
      })
      .catch(() => {})
      .finally(() => { _revalidating = false; });
  }

  async function loadCatalogAll() {
    if (state.catalogAll) return Promise.resolve(state.catalogAll);

    // ★ 2026-09-09：优先从后端拉取（账号登录模式）。
    //   已登录且后端可用 → 直接渲染后端数据，彻底绕过 GitHub/本地快照，避免首屏多源竞争和隐私泄露。
    //   后端失败或未登录 → 原样回退到旧逻辑（本地 catalog.json + GitHub + Gitee 竞速）。
    if (window.ShopeeAuth && window.ShopeeAuth.isLoggedIn && window.ShopeeAuth.isLoggedIn()) {
      try {
        const r = await window.ShopeeAuth.apiGet('/api/catalog/items');
        if (r && r.ok && Array.isArray(r.items)) {
          // 后端删除名单：同步注入 _serverDeleted，确保渲染层立即隐藏已删商品
          const delRes = await window.ShopeeAuth.apiGet('/api/catalog/deleted');
          if (delRes && delRes.ok && delRes.deleted && typeof delRes.deleted === 'object') {
            const oldDel = (_serverDeleted && typeof _serverDeleted === 'object') ? _serverDeleted : {};
            const merged = Object.assign({}, oldDel);
            let changed = false;
            for (const k in delRes.deleted) { merged[k] = delRes.deleted[k]; changed = true; }
            if (changed) _serverDeleted = merged;
          }
          const doc = {
            generated_at: new Date().toISOString(),
            catalog_ts: Number(r.server_ts) || Math.floor(Date.now() / 1000),
            source: 'backend',
            total: r.count,
            items: r.items,
          };
          applyCatalog(doc);
          _loadedCatalogTs = doc.catalog_ts;
          // state.catalogAll 与 state.lib.catalogFallback 已由 applyCatalog 设置
          return doc;
        }
      } catch (e) {
        console.error('[SR] 后端 catalog 拉取失败，回退旧逻辑:', e.message);
        // 不 return，继续走旧逻辑兜底
      }
    }

    // ★ 2026-09-02i：首屏即合并本地打包的 deleted.json（随每次部署更新），
    //   避免「先按无 deleted 标记渲染出 300+ 件 → 几秒后后台拉完 GitHub deleted.json
    //   骤减到 6 件甚至 0 件」的闪屏/突变。GitHub 远端 deleted.json 仍后台刷新作为补偿。
    try {
      const localDel = await fetchJsonTimeout("data/deleted.json", 2000).catch(() => null);
      if (localDel && typeof localDel === 'object' && !Array.isArray(localDel)) {
        const cur = (_serverDeleted && typeof _serverDeleted === 'object') ? _serverDeleted : {};
        const m = Object.assign({}, cur);
        let changed = false;
        for (const k in localDel) { if (!(k in m) || Number(localDel[k]) > Number(m[k])) { m[k] = localDel[k]; changed = true; } }
        if (changed) _serverDeleted = m;
      }
    } catch (e) {}
    // ★ 2026-09-02 提速：GitHub deleted.json 的拉取**不再阻塞首屏**。
    //   旧写法把它放进 Promise.all，GitHub API 在慢网络可超时 15s → 首屏 wiring 被一起拖住，
    //   页面长时间白屏（这是「加载非常慢」的最大元凶之一）。
    //   现在改为后台异步拉取；本站删除本就由本地 DELSET 渲染过滤即时生效（不依赖远端），
    //   deleted.json 只是「跨浏览器/换电脑」的保险——晚到后对当前已渲染数据补一次过滤即可。
    fetchServerDeleted().catch(() => {}).then(() => {
      try {
        const srvDel = (_serverDeleted && typeof _serverDeleted === 'object') ? _serverDeleted : {};
        const doc = state.catalogAll;
        if (Object.keys(srvDel).length && doc) {
          // ★ 2026-09-02：仅在过滤结果确有变化时才重建视图。
          //   旧写法无条件 applyCatalog + refreshCurrentView —— deleted.json 每次首载都会返回，
          //   等于每进一次页面 ~8 秒后就整块重渲染一次（商品图全部重新加载）→ 闪屏假象。
          const before = (state.lib.catalogFallback || []).length;
          const changed = applyCatalog(doc);
          const after = (state.lib.catalogFallback || []).length;
          if (changed) {
            refreshCurrentView();
            // 若服务端删除导致商品数大幅减少，给出明确提示，避免用户以为系统故障。
            if (before > 0 && after < before && (after === 0 || after / before < 0.3)) {
              showToast(`ℹ 已按 GitHub 删除记录隐藏 ${before - after} 件商品（剩余 ${after} 件）。如想恢复，请清空删除记录。`);
            }
          }
        }
      } catch (e) {}
    });
    // ★ 2026-09-01：先尝试本机 localStorage 里"最后一次成功拉到的 catalog"，
    //   raw.githubusercontent.com 近期被截断 32 KiB，api.github.com 又常超时，
    //   远端全部坏时本机缓存兜底。revalidateCatalog 仍会异步尝试远端拿更新。
    const cached = loadCatalogCache();
    if (cached && cached.doc && Array.isArray(cached.doc.items) && cached.doc.items.length) {
      applyCatalog(cached.doc);
      _loadedCatalogTs = normTs(cached.doc.catalog_ts);
    }
    // source.json 与本地 catalog.json 是两个互不依赖的本地文件 → 并行读取，
    // 不再串行等待（旧写法 source→local→线上 三段串行，白白多等两个 RTT）。
    // ★ 只等这两个本地文件（<0.5s），wire 快速完成 → 秒开；不掺入任何远端请求。
    const pSource = fetchJsonTimeout("data/source.json", 4000).catch(() => null);
    const pLocal = fetchJsonTimeout(bust("data/catalog.json"), 4000).catch(() => null);
    return Promise.all([pSource, pLocal])
      .then(([d, localDoc]) => {
        if (d && d.catalog_url) _source.catalog_url = d.catalog_url;
        if (d && d.sync_url) _source.sync_url = d.sync_url;
        if (d && d.catalog_path) _source.catalog_path = d.catalog_path;
        if (d && d.api_token) _source.api_token = d.api_token;
        if (d && d.gitee) _source.gitee = d.gitee;   // Gitee 镜像源（仅作兜底）
        // 用网站设置页填写的 PAT 认证 GitHub API 读取，避免未认证 60 次/小时限流导致
        // 刷新时被迫退回 stale 的 Gitee / CDN 缓存（已删商品回显）。
        const _gt = getGhToken();
        if (_gt) _source.api_token = _gt;
        return localDoc;
      })
      .then((localDoc) => {
        // ★ 2026-09-02 修正：在「本机缓存」与「data/catalog.json 打包快照」之间选**较新**的一份先渲染。
        //   旧写法只要本机有缓存就永远用缓存（可能比本次部署的快照旧），导致
        //   每页先渲染旧数据 → revalidateCatalog ~9s 后拉到新的 → 又整块重渲染一次（闪屏）。
        //   现在谁 catalog_ts 新就用谁，尽量让「第一次看到的」就是最新的本地数据。
        const localOk = localDoc && Array.isArray(localDoc.items) && localDoc.items.length;
        const useCached = cached && (!localOk || normTs(cached.doc.catalog_ts) >= normTs(localDoc.catalog_ts));
        if (useCached) {
          applyCatalog(cached.doc);
          _loadedCatalogTs = normTs(cached.doc.catalog_ts);
          revalidateCatalog(_loadedCatalogTs);
          return cached.doc;
        }
        // data/catalog.json 打包快照已随每次部署更新到「接近最新」（GitHub 最新数据），
        // 因此无缓存/缓存偏旧时**直接立即渲染本地快照** → 秒开且尽量新；随后后台核对远端。
        if (localOk) {
          applyCatalog(localDoc);
          _loadedCatalogTs = normTs(localDoc.catalog_ts) || 0;
          revalidateCatalog(_loadedCatalogTs);
          return localDoc;
        }
        // 本地数据全部缺失（极端情况）：纯等远端，靠 raceValid 整体兜底。
        _loadedCatalogTs = 0;
        revalidateCatalog(0);
        return localDoc;
      });
  }
  function cityOf(loc) {
    const m = (loc || "").match(/^(.{2,3}?[市縣])/);
    return m ? m[1] : (loc || "");
  }
  function avg(xs) {
    const v = xs.filter((x) => x != null && !isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  }

  // ---------- 行业大盘 ----------
  function computeMarket(items) {
    const byCat = {};
    items.forEach((it) => (it.cats || []).forEach((c) => { (byCat[c] = byCat[c] || []).push(it); }));
    const rows = Object.keys(byCat).map((cat) => {
      const its = byCat[cat];
      const sold = its.map((i) => i.sold_total || 0);
      const prices = its.map((i) => i.price).filter((p) => p > 0);
      const rated = its.map((i) => i.rating).filter((r) => r > 0);
      const liked = its.map((i) => i.liked || 0);
      const shops = new Set(its.map((i) => i.shopid)).size || 1;
      const total_sold = sold.reduce((a, b) => a + b, 0);
      const avg_sold = total_sold / its.length;
      return {
        category: cat, count: its.length, shops,
        avg_price: avg(prices), min_price: prices.length ? Math.min.apply(null, prices) : 0,
        max_price: prices.length ? Math.max.apply(null, prices) : 0,
        total_sold, avg_sold, avg_rating: avg(rated), avg_liked: avg(liked),
        competition: its.length / shops,
      };
    });
    const maxDemand = Math.max.apply(null, rows.map((r) => r.avg_sold).concat([1]));
    rows.forEach((r) => {
      const demand = r.avg_sold / maxDemand;
      const comp = 1 / (1 + r.competition);
      const quality = Math.min(r.avg_rating / 5, 1);
      r.blue_ocean = Math.round((demand * 0.5 + comp * 0.35 + quality * 0.15) * 1000) / 10;
    });
    rows.sort((a, b) => b.blue_ocean - a.blue_ocean);
    return rows;
  }
  function wireMarket() {
    const el = $("#mktCards");
    if (!el) return;
    if (!state.catalogAll) { el.innerHTML = '<div class="empty">暂无可聚合的商品库数据（请先运行采集或刷新页面）。</div>'; return; }
    const rows = computeMarket(state.catalogAll.items || []);
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无品类数据。</div>'; return; }
    const cur = state.data ? state.data.currency : "NT$";
    el.innerHTML = rows.map((r) => {
      const boCls = r.blue_ocean >= 70 ? "bo-hi" : r.blue_ocean >= 45 ? "bo-mid" : "bo-lo";
      return `<div class="mkt-card">
        <div class="mkt-top"><span class="mkt-cat">${esc(r.category)}</span>
          <span class="bo ${boCls}">蓝海 ${r.blue_ocean}</span></div>
        <div class="mkt-grid">
          <div><div class="mn">${fmt(r.count)}</div><div class="ml">商品数</div></div>
          <div><div class="mn">${fmt(r.shops)}</div><div class="ml">店铺数</div></div>
          <div><div class="mn">${cur}${fmt(Math.round(r.avg_price))}</div><div class="ml">均价</div></div>
          <div><div class="mn">${fmt(r.total_sold)}</div><div class="ml">总销量</div></div>
          <div><div class="mn">${r.avg_rating ? r.avg_rating.toFixed(2) : "-"}</div><div class="ml">均评分</div></div>
          <div><div class="mn">${r.competition.toFixed(1)}</div><div class="ml">竞争度</div></div>
        </div>
        <div class="mkt-foot">价格区间 ${cur}${fmt(Math.round(r.min_price))} ~ ${fmt(Math.round(r.max_price))} · 均点赞 ${fmt(Math.round(r.avg_liked))}</div>
      </div>`;
    }).join("");
  }

  // ---------- 榜单 ----------
  function computeRankings(items, kind) {
    let its = (items || []).slice();
    if (kind === "rating") its = its.filter((i) => (i.reviews || 0) >= 3);
    if (kind === "new") its = its.filter((i) => (i.listed_at || 0) > 0);
    const map = {
      hot: (a, b) => (b.sold_total || 0) - (a.sold_total || 0),
      popular: (a, b) => (b.liked || 0) - (a.liked || 0),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0),
      new: (a, b) => (b.listed_at || 0) - (a.listed_at || 0),
    };
    its.sort(map[kind] || map.hot);
    return its.slice(0, 50);
  }
  const RANK_METRIC = { hot: "销量", popular: "人气", rating: "评分", new: "上架" };
  function wireRankings() {
    const seg = $("#rankSeg");
    if (!seg) return;
    const hdr = $("#rankMetricHdr");
    const render = (kind) => {
      hdr.textContent = RANK_METRIC[kind];
      const el = $("#tblRank tbody");
      if (!state.catalogAll) { el.innerHTML = '<tr><td colspan="7" style="color:#999">暂无可聚合数据。</td></tr>'; return; }
      const rows = computeRankings(state.catalogAll.items, kind);
      if (!rows.length) { el.innerHTML = '<tr><td colspan="7" style="color:#999">无数据。</td></tr>'; return; }
      const cur = state.data ? state.data.currency : "NT$";
      el.innerHTML = rows.map((it, i) => {
        const metric = kind === "hot" ? fmt(it.sold_total)
          : kind === "popular" ? fmt(it.liked)
          : kind === "rating" ? (it.rating + " ★")
          : (it.listed_at ? dateStrUTC8(it.listed_at) : "-");
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1);
        const on = isFav(libItemId(it)) ? "on" : "";
        const cats = (it.cats || []).map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
        return `<tr data-id="${esc(it.id)}" class="clickable">
          <td class="rk">${medal}</td>
          <td><span class="name" title="${esc(it.name)}">${esc(it.name)}</span></td>
          <td class="num">${cur}${fmt(Math.round(it.price))}</td>
          <td class="num">${metric}</td>
          <td>${esc(it.shop || "—")}</td>
          <td>${cats}</td>
          <td><button class="fav-btn ${on}" data-id="${esc(libItemId(it))}" title="收藏">${on ? "❤" : "🤍"}</button></td>
        </tr>`;
      }).join("");
    };
    seg.addEventListener("click", (e) => {
      const b = e.target.closest(".seg-btn"); if (!b) return;
      $$(".seg-btn", seg).forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      render(b.dataset.kind);
    });
    render("hot");
  }

  // ---------- 店铺分析 ----------
  function computeShops(items) {
    const byShop = {};
    items.forEach((it) => { const s = it.shopid; (byShop[s] = byShop[s] || []).push(it); });
    const rows = Object.keys(byShop).map((sid) => {
      const its = byShop[sid];
      const prices = its.map((i) => i.price).filter((p) => p > 0);
      const rated = its.map((i) => i.rating).filter((r) => r > 0);
      const month_sold = its.reduce((a, b) => a + (b.month_sold || 0), 0);
      const week_sold = its.reduce((a, b) => a + (b.week_sold || 0), 0);
      // 月销加权平均单价（用月销量作为权重，避免低价赠品拉低均值）
      let w_sum = 0, w_price = 0;
      its.forEach((it) => { const m = it.month_sold || 0; w_sum += m; w_price += m * (it.price || 0); });
      const weighted_avg_price = w_sum > 0 ? Math.round(w_price / w_sum) : avg(prices);
      // 月销>100的商品数
      const hot_count = its.filter((it) => (it.month_sold || 0) >= 100).length;
      // ★ 月销>30 的商品数（用户要求的店铺排序口径）：该店在本选品库里
      //   「月销 > 30」的商品条数，用来衡量这家店有多少款值得跟进。
      const hot30 = its.filter((it) => (it.month_sold || 0) > 30).length;
      // 店铺总销量 = 该店在录商品的累计销量（sold_total）之和
      const shop_total_sold = its.reduce((a, b) => a + (b.sold_total || b.total_sold || 0), 0);
      // 涨跌趋势：周销×4.3 vs 月销，估算环比变化
      const est_month_from_wk = Math.round(week_sold * 4.3);
      const trend_pct = est_month_from_wk > 0
        ? Math.round((month_sold - est_month_from_wk) / est_month_from_wk * 100)
        : 0;
      // 主卖品类
      const catCount = {};
      its.forEach((it) => (it.cats || []).forEach((c) => { catCount[c] = (catCount[c] || 0) + 1; }));
      const main_cats = Object.entries(catCount)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
      const top = its.slice().sort((a, b) => (b.month_sold || 0) - (a.month_sold || 0))[0];
      return {
        shopid: sid, name: its[0].shop || ("店铺" + sid),
        city: cityOf(its[0].loc),
        count: its.length, hot_count: hot_count, hot30: hot30,
        month_sold: month_sold, week_sold: week_sold,
        total_sold: shop_total_sold,
        avg_price: avg(prices), weighted_avg_price: weighted_avg_price,
        avg_rating: avg(rated), trend_pct: trend_pct,
        main_cats: main_cats,
        top_product: (top && top.name) || "", top_id: (top && top.id) || "",
      };
    });
    return rows;
  }
  const SHOP_SORT = {
    // ★ 默认：按「月销>30 的商品数量」从大到小（用户明确要求）；
    //   数量相同再比店铺总销量、再看月销合计，保证排序稳定不抖动。
    hot30: (a, b) => (b.hot30 || 0) - (a.hot30 || 0) || b.total_sold - a.total_sold || b.month_sold - a.month_sold,
    month: (a, b) => b.month_sold - a.month_sold || b.total_sold - a.total_sold,
    sold: (a, b) => b.total_sold - a.total_sold,
    count: (a, b) => b.count - a.count,
    hot100: (a, b) => b.hot_count - a.hot_count || b.total_sold - a.total_sold,
    rating: (a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || b.count - a.count,
  };
  function wireShops() {
    const sortSel = $("#shopSort");
    const render = () => {
      const el = $("#tblShop tbody");
      if (!state.catalogAll) { el.innerHTML = '<tr><td colspan="8" style="color:#999">暂无可聚合数据。</td></tr>'; return; }
      let rows = computeShops(state.catalogAll.items);
      rows.sort(SHOP_SORT[sortSel.value] || SHOP_SORT.hot30);
      rows = rows.slice(0, 50);
      if (!rows.length) { el.innerHTML = '<tr><td colspan="8" style="color:#999">无店铺数据。</td></tr>'; return; }
      const cur = state.data ? state.data.currency : "NT$";
      el.innerHTML = rows.map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1);
        const cats_html = (r.main_cats || []).map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
        // 涨跌趋势显示
        const trendCls = r.trend_pct > 10 ? "pos" : r.trend_pct < -10 ? "neg" : "muted";
        const trendArrow = r.trend_pct > 0 ? "↑" : r.trend_pct < 0 ? "↓" : "→";
        const trendStr = `${trendArrow} ${Math.abs(r.trend_pct)}%`;
        // 月销>30 的商品数：按此列降序即为店铺排名依据
        const h30 = r.hot30 || 0;
        const h30Html = h30
          ? `<b>${fmt(h30)}</b><br><small class="muted">占 ${Math.round(h30 / Math.max(1, r.count) * 100)}%</small>`
          : '<span class="muted">0</span>';
        return `<tr data-shop="${esc(r.shopid)}" class="clickable">
          <td class="rk">${medal}</td>
          <td><b>${esc(r.name)}</b><br><small class="muted">${esc(r.city || "—")} · 共${fmt(r.count)}件</small></td>
          <td class="num">${h30Html}</td>
          <td class="num"><b>${fmt(r.total_sold)}</b></td>
          <td class="num">${fmtMonth(r.month_sold)}</td>
          <td class="num">${cur}${fmt(r.weighted_avg_price)}</td>
          <td class="num ${trendCls}">${trendStr}</td>
          <td>${cats_html || '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join("");
      const allShops = computeShops(state.catalogAll.items);
      const h30Total = allShops.reduce((a, b) => a + (b.hot30 || 0), 0);
      const gateMsg = (state.lib.gateUsed > 0)
        ? `已按「月销≥${state.lib.gateUsed}」规则展示；全库月销>30 的商品共 ${fmt(h30Total)} 件`
        : `未设月销门槛（含月销未知商品）；全库月销>30 的商品共 ${fmt(h30Total)} 件`;
      $("#shopHint").textContent = `共 ${fmt(allShops.length)} 个店铺（显示 TOP 50）· ${gateMsg}`;
    };
    // ★ 防重复绑定：wireShops 会被 refreshCurrentView 反复调用（切标签/门槛变更），
    //   每次 addEventListener 都会叠加一个 render，切几次标签就会重算几遍。只绑一次。
    if (!sortSel.__srBound) {
      sortSel.__srBound = true;
      sortSel.addEventListener("change", render);
    }
    render();
  }
  function openShop(shopid) {
    if (!state.catalogAll) return;
    const its = (state.catalogAll.items || []).filter((i) => String(i.shopid) === String(shopid));
    if (!its.length) return;
    const prices = its.map((i) => i.price).filter((p) => p > 0);
    const rated = its.map((i) => i.rating).filter((r) => r > 0);
    const total = its.reduce((a, b) => a + (b.sold_total || 0), 0);
    const month = its.reduce((a, b) => a + (b.month_sold || 0), 0);
    const cur = state.data ? state.data.currency : "NT$";
    // 主卖品类
    const catCount = {};
    its.forEach((it) => (it.cats || []).forEach((c) => { catCount[c] = (catCount[c] || 0) + 1; }));
    const mainCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
    const catsHtml = mainCats.map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
    const grid = its.slice().sort((a, b) => (b.month_sold || 0) - (a.month_sold || 0))
      .map((it) => `<div class="pcard" data-id="${esc(it.id)}">
        ${it.img ? `<img class="pcard-img" src="${esc(thumbUrl(proxyImg(it.img)))}" referrerpolicy="no-referrer" loading="lazy" decoding="async" alt="" onerror="__imgFallback(this)">` : `<div class="pcard-img pcard-img-empty">📦</div>`}
        <div class="pcard-body">
          <div class="pcard-name" title="${esc(it.name)}">${esc(it.name || "（未采集到名称）")}</div>
          <div class="pcard-price">${priceHtml(it)}</div>
          <div class="pcard-meta"><span class="stars">${starStr(it.rating)}</span><span class="muted">月${fmtMonth(it.month_sold)} · 总${fmt(it.sold_total)}</span></div>
        </div></div>`).join("");
    $("#modalBody").innerHTML = `<div class="p-head"><div class="p-meta">
        <div class="p-name">${esc(its[0].shop || "店铺")} <span class="badge">店铺分析</span></div>
        <div class="p-sub">${esc(cityOf(its[0].loc) || "未知城市")} · 商品 ${fmt(its.length)} 件 · 月销 ${fmt(month)} · 总销 ${fmt(total)} · 均价 ${cur}${fmt(Math.round(avg(prices)))}</div>
        <div class="p-sub">主卖品类：${catsHtml || '<span class="muted">暂无</span>'}</div>
      </div></div>
      <h3 class="p-h3">该店全部商品（${fmt(its.length)}，按月销排序）</h3>
      <div class="lib-grid">${grid}</div>`;
    $("#modal").classList.remove("hidden");
  }

  // ---------- 关注关键词看板（2026-09-10 新增）----------
  // 存：shopee_kw_v1 = [{ w:"洞洞鞋", t:加入时间, hist:{ "YYYY-MM-DD": 命中件数 } }]
  // 价值有两层：① 点一下即筛选，省掉每天重复打字；
  //            ② 每天记一次命中件数 → 直接看出「这个词的市场在涨还是在跌」，这是选品判断的输入。
  const KW_KEY = "shopee_kw_v1";
  const KW_HIST_DAYS = 30;
  const KW_MAX = 20;
  // 关键词命中的口径必须与商品库搜索完全一致，否则「看板数字」和「点进去看到的件数」会对不上
  function libMatch(it, q) {
    const s = normSearch(String(q == null ? "" : q).trim());
    if (!s) return true;
    return normSearch(
      (it.name || "") + " " + (it.shop || "") + " " + (it.brand || "") + " " + (it.cats || []).join(" ")
    ).includes(s);
  }
  function kwDayList(n) {
    const out = [];
    const base = new Date(todayStrUTC8() + "T00:00:00Z").getTime();
    for (let i = 0; i < n; i++) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
    return out;
  }
  function loadKws() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KW_KEY) || "null"); } catch (e) { raw = null; }
    const keep = {};
    kwDayList(KW_HIST_DAYS).forEach((d) => { keep[d] = 1; });
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((x) => {
      const w = String((x && x.w) || "").trim();
      if (!w || w.length > 30) return;
      const hist = {};
      const src = (x && x.hist && typeof x.hist === "object") ? x.hist : {};
      Object.keys(src).forEach((d) => {
        const n = Number(src[d]);
        if (keep[d] && isFinite(n) && n >= 0) hist[d] = n;   // 顺手丢掉超出 30 天的历史，避免无限增长
      });
      out.push({ w: w, t: normTs(x && x.t) || 0, hist: hist });
    });
    return out;
  }
  function saveKws() {
    try { localStorage.setItem(KW_KEY, JSON.stringify(state.kws || [])); } catch (e) {}
  }
  function kwIndexOf(w) {
    const s = String(w == null ? "" : w).trim();
    return (state.kws || []).findIndex((k) => k.w === s);
  }
  function kwAdd(w) {
    const s = String(w == null ? "" : w).trim();
    if (!s) { showToast("先在搜索框输入一个词，再点关注"); return false; }
    if (s.length > 30) { showToast("关键词太长（最多 30 字）"); return false; }
    if (kwIndexOf(s) >= 0) { showToast("「" + s + "」已经在关注列表里了"); return false; }
    if ((state.kws || []).length >= KW_MAX) { showToast("关注词最多 " + KW_MAX + " 个，先取消几个吧"); return false; }
    state.kws.push({ w: s, t: Math.floor(Date.now() / 1000), hist: {} });
    saveKws();
    refreshKwStats();
    renderKw();
    showToast("已关注「" + s + "」，每天会自动记下它的商品数变化");
    return true;
  }
  function kwRemove(w) {
    const i = kwIndexOf(w);
    if (i < 0) return;
    const name = state.kws[i].w;
    state.kws.splice(i, 1);
    saveKws();
    renderKw();
    showToast("已取消关注「" + name + "」");
  }
  // 某关键词当前命中多少件（口径同商品库搜索）
  function kwCountOf(w) {
    const items = (state.catalogAll && state.catalogAll.items) || [];
    if (!items.length) return null;
    let n = 0;
    for (let i = 0; i < items.length; i++) if (libMatch(items[i], w)) n++;
    return n;
  }
  // 每天都给关注词记一次命中数：同一天内以最后一次为准（幂等），不写脏数据
  function refreshKwStats() {
    const kws = state.kws || [];
    if (!kws.length || !state.catalogAll) return;
    const d = todayStrUTC8();
    let dirty = false;
    kws.forEach((k) => {
      const n = kwCountOf(k.w);
      if (n == null) return;
      if (k.hist[d] !== n) { k.hist[d] = n; dirty = true; }
    });
    if (dirty) saveKws();
  }
  function kwPrevDay(k) {
    const today = todayStrUTC8();
    const ds = Object.keys(k.hist || {}).filter((x) => x < today).sort();
    if (!ds.length) return null;
    const d = ds[ds.length - 1];
    return { d: d, n: k.hist[d] };
  }
  function renderKw() {
    const bar = $("#kwBar");
    if (!bar) return;
    const kws = state.kws || [];
    // 以搜索框实时内容为准：用户刚敲完还没回车时，「+ 关注」也应立刻出现
    const _box = $("#libSearch");
    const cur = String(((_box && _box.value) || state.lib.q || "")).trim();
    const parts = ['<span class="kw-lab">关注词</span>'];
    if (!kws.length) {
      parts.push('<span class="kw-empty">还没有关注词。搜一个词后点右侧「+ 关注」，即可一键筛选，并看到它每天的商品数涨跌。</span>');
    }
    kws.forEach((k) => {
      const on = !!cur && cur.toLowerCase() === k.w.toLowerCase();
      const n = kwCountOf(k.w);
      const prev = kwPrevDay(k);
      let delta = "";
      if (n != null && prev && prev.n != null) {
        const diff = n - prev.n;
        const cls = diff > 0 ? "up" : (diff < 0 ? "down" : "flat");
        const sign = diff > 0 ? "\u2191" : (diff < 0 ? "\u2193" : "");
        delta = '<span class="kw-delta ' + cls + '" title="对比 ' + prev.d + '：' + prev.n + ' 件 \u2192 今天 ' + n + ' 件">'
          + sign + Math.abs(diff) + '</span>';
      }
      parts.push('<span class="kw-chip' + (on ? " on" : "") + '" data-w="' + esc(k.w) + '" title="点击筛选「' + esc(k.w) + '」">'
        + esc(k.w)
        + '<span class="kw-num">' + (n == null ? "\u2014" : fmt(n)) + '</span>'
        + delta
        + '<span class="kw-x" data-del="' + esc(k.w) + '" title="取消关注">\u00d7</span>'
        + '</span>');
    });
    if (cur && kwIndexOf(cur) < 0) {
      parts.push('<button class="kw-add" id="kwAdd">+ 关注「' + esc(cur) + '」</button>');
    }
    bar.innerHTML = parts.join("");
  }
  function wireKws() {
    const bar = $("#kwBar");
    if (!bar || bar.__kwBound) return;
    bar.__kwBound = true;
    bar.addEventListener("click", (e) => {
      const del = e.target.closest(".kw-x");
      if (del) { e.preventDefault(); e.stopPropagation(); kwRemove(del.getAttribute("data-del")); return; }
      // 以搜索框当前值取词：用户常常是「刚敲完就直接点关注」，此时 state.lib.q 还是旧的
      if (e.target.closest("#kwAdd")) {
        const _b = $("#libSearch");
        kwAdd(String(((_b && _b.value) || state.lib.q || "")).trim());
        return;
      }
      const chip = e.target.closest(".kw-chip");
      if (!chip) return;
      const w = chip.getAttribute("data-w") || "";
      const box = $("#libSearch");
      if (box) box.value = w;
      state.lib.q = w;
      state.lib.page = 1;
      _libGridSig = "";
      libRerender();
      renderKw();
    });
  }

  // ---------- 卡片显示字段面板（2026-09-10 新增）----------
  function wireCardFields() {
    const btn = $("#cardFieldBtn");
    const panel = $("#cardFieldPanel");
    if (!btn || !panel) return;
    const grid = $("#cardFieldGrid");
    function paint() {
      const cfg = cardCfg();
      const rows = ['<label class="cf-item locked" title="卡片的身份信息，不可关闭"><input type="checkbox" checked disabled> 主图 + 商品名</label>'];
      cardFieldDefs().forEach((f) => {
        rows.push('<label class="cf-item"><input type="checkbox" data-k="' + f.k + '"' + (cfg[f.k] ? " checked" : "") + "> " + f.label + "</label>");
      });
      grid.innerHTML = rows.join("");
    }
    const close = () => panel.classList.add("hidden");
    if (!btn.__cfBound) {
      btn.__cfBound = true;
      btn.addEventListener("click", () => { paint(); panel.classList.remove("hidden"); });
    }
    const c1 = $("#cardFieldClose");
    if (c1 && !c1.__cfBound) { c1.__cfBound = true; c1.addEventListener("click", close); }
    const c2 = $("#cardFieldClose2");
    if (c2 && !c2.__cfBound) { c2.__cfBound = true; c2.addEventListener("click", close); }
    const rs = $("#cardFieldReset");
    if (rs && !rs.__cfBound) {
      rs.__cfBound = true;
      rs.addEventListener("click", () => {
        const cfg = {};
        cardFieldDefs().forEach((f) => { cfg[f.k] = true; });
        saveCardCfg(cfg);
        paint();
        repaintAllCards();
        showToast("已恢复默认：卡片显示全部字段");
      });
    }
    if (grid && !grid.__cfGridBound) {
      grid.__cfGridBound = true;
      grid.addEventListener("change", (e) => {
        const cb = e.target.closest("input[data-k]");
        if (!cb) return;
        const cfg = cardCfg();
        cfg[cb.getAttribute("data-k")] = cb.checked;
        saveCardCfg(cfg);
        repaintAllCards();
      });
    }
  }
  // 字段配置变了 → 清掉网格指纹强制重建。指纹里没有这份配置，
  // 不清的话 libRerender 会认为「画面没变」而跳过重绘，用户会觉得「点了没反应」。
  function repaintAllCards() {
    _libGridSig = "";
    libRerender();
    renderFav();
  }

  // ---------- 收藏（2026-09-10 升级：分组 + 备注 + 导出选品清单）----------
  // 存储：新键 shopee_fav_v2 = { id: { g:分组, n:备注, t:收藏时间(秒) } }
  //   旧键 shopee_fav（纯 id 数组）**只读不改**，仅作迁移源 —— 万一新版有问题，
  //   回滚旧代码仍能读到完整收藏，不存在「迁移把数据改丢」的可能。
  const FAV_KEY = "shopee_fav_v2";
  const FAV_LEGACY_KEY = "shopee_fav";
  const FAV_GROUP_KEY = "shopee_fav_groups_v1";
  const FAV_PRESET_GROUPS = ["重点", "待观察", "竞品参考"];

  function favNorm(id) { return String(id == null ? "" : id); }
  function favSave() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.fav)); } catch (e) {}
  }
  function favSaveGroups() {
    try { localStorage.setItem(FAV_GROUP_KEY, JSON.stringify(state.favGroups)); } catch (e) {}
  }
  // 读取收藏：优先新格式；没有新格式时从旧数组迁移一次（旧键保持原样不动）
  function loadFav() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(FAV_KEY) || "null"); } catch (e) { raw = null; }
    const obj = {};
    if (raw && !Array.isArray(raw) && typeof raw === "object") {
      Object.keys(raw).forEach((k) => {
        if (!k) return;
        const v = raw[k];
        obj[k] = (v && typeof v === "object")
          ? { g: String(v.g || ""), n: String(v.n || ""), t: normTs(v.t) || 0 }
          : { g: "", n: "", t: 0 };  // 容错：值不是对象也不丢这条收藏
      });
      return obj;
    }
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(FAV_LEGACY_KEY) || "[]"); } catch (e) { legacy = []; }
    if (Array.isArray(legacy) && legacy.length) {
      const now = Math.floor(Date.now() / 1000);
      legacy.forEach((id) => { const s = favNorm(id); if (s) obj[s] = { g: "", n: "", t: now }; });
      try { localStorage.setItem(FAV_KEY, JSON.stringify(obj)); } catch (e) {}
      console.log("[fav] 已从旧格式迁移 " + Object.keys(obj).length + " 件收藏（旧键 shopee_fav 保持原样）");
    }
    return obj;
  }
  function loadFavGroups() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(FAV_GROUP_KEY) || "null"); } catch (e) { g = null; }
    const out = [];
    const seen = {};
    const push = (x) => {
      const s = String(x == null ? "" : x).trim();
      if (!s || s.length > 20 || seen[s]) return;
      seen[s] = 1; out.push(s);
    };
    (Array.isArray(g) ? g : []).forEach(push);
    // 收藏数据里出现过的分组也补进来，避免「分组名只存在于数据里、筛选栏却看不到」
    Object.keys(state.fav || {}).forEach((k) => push(state.fav[k] && state.fav[k].g));
    return out;
  }
  function favList() { return Object.keys(state.fav || {}); }
  function favCount() { return favList().length; }
  function isFav(id) { return !!state.fav[favNorm(id)]; }
  function favAdd(id) {
    const k = favNorm(id);
    if (!k) return;
    if (!state.fav[k]) {
      // 正处在某个分组筛选下时收藏 → 直接归入该分组，符合直觉
      const g = (state.favFilter && state.favFilter !== "__none") ? state.favFilter : "";
      state.fav[k] = { g: g, n: "", t: Math.floor(Date.now() / 1000) };
    }
    favSave();
  }
  function favRemove(id) { delete state.fav[favNorm(id)]; favSave(); }
  // 所有可选分组（预设 + 自定义 + 数据里出现过的）
  function favGroupOptions() {
    const out = [];
    const seen = {};
    const push = (x) => {
      const s = String(x == null ? "" : x).trim();
      if (!s || s.length > 20 || seen[s]) return;
      seen[s] = 1; out.push(s);
    };
    FAV_PRESET_GROUPS.forEach(push);
    (state.favGroups || []).forEach(push);
    Object.keys(state.fav || {}).forEach((k) => push(state.fav[k] && state.fav[k].g));
    return out;
  }
  function toggleFav(id) {
    if (isFav(id)) favRemove(id); else favAdd(id);
    refreshFavButtons();
    renderFav();
  }
  function refreshFavButtons() {
    $$(".fav-btn").forEach((b) => {
      const on = isFav(b.dataset.id);
      b.classList.toggle("on", on);
      b.textContent = on ? "❤" : "🤍";
      b.title = on ? "取消收藏" : "收藏";
    });
  }
  function wireFav() {
    const bar = $("#favBar");
    if (bar && !bar.__favBound) {
      bar.__favBound = true;
      bar.addEventListener("click", (e) => {
        const chip = e.target.closest(".fav-chip");
        if (!chip) return;
        if (chip.id === "favNewGroup") {
          const name = String(window.prompt("新建分组名称（最多 20 字）", "") || "").trim();
          if (!name) return;
          if (name.length > 20) { showToast("分组名最多 20 个字"); return; }
          if (!state.favGroups.includes(name)) { state.favGroups.push(name); favSaveGroups(); }
          state.favFilter = name;
          renderFav();
          showToast("已新建分组「" + name + "」，此刻收藏会自动归入");
          return;
        }
        state.favFilter = chip.dataset.g || "";
        renderFav();
      });
    }
    const grid = $("#favGrid");
    if (grid && !grid.__favBound) {
      grid.__favBound = true;
      const commit = (t) => {
        const id = t.dataset ? t.dataset.id : null;
        if (!id || !state.fav[id]) return false;
        if (t.classList.contains("fav-g")) state.fav[id].g = t.value;
        else if (t.classList.contains("fav-note")) state.fav[id].n = String(t.value || "").slice(0, 120);
        else return false;
        favSave();
        return true;
      };
      // change 在「改完切走焦点」时触发，足够覆盖分组下拉与备注输入
      grid.addEventListener("change", (e) => {
        const t = e.target;
        if (!t || !t.classList || !t.dataset || !t.dataset.id) return;
        if (!commit(t)) return;
        if (t.classList.contains("fav-g")) { renderFav(); showToast(t.value ? "已移到「" + t.value + "」" : "已移到未分组"); }
        else showToast("备注已保存");
      });
    }
    const ex = $("#favExport");
    if (ex && !ex.__favBound) { ex.__favBound = true; ex.addEventListener("click", exportFavCsv); }
    renderFav();
  }
  function renderFav() {
    const el = $("#favGrid");
    const empty = $("#favEmpty");
    const bar = $("#favBar");
    if (!el || !empty) return;
    if (!state.catalogAll) { el.innerHTML = '<div class="empty">暂无可用的商品库数据。</div>'; return; }
    const ids = favList();
    const visible = {};
    (state.catalogAll.items || []).forEach((i) => { visible[libItemId(i)] = i; });
    const anyItem = {};
    (state.catalogAll._rawItems || []).forEach((i) => { anyItem[libItemId(i)] = i; });
    const rows = ids.map((id) => ({
      id: id, it: visible[id] || null, raw: anyItem[id] || null,
      info: state.fav[id] || { g: "", n: "", t: 0 },
    }));
    const hiddenByGate = rows.filter((r) => !r.it && r.raw).length;

    if (bar) {
      const cnt = {};
      rows.forEach((r) => { const g = r.info.g || ""; cnt[g] = (cnt[g] || 0) + 1; });
      const parts = [`<button class="fav-chip${state.favFilter === "" ? " on" : ""}" data-g="">全部 ${fmt(rows.length)}</button>`];
      if (cnt[""]) parts.push(`<button class="fav-chip${state.favFilter === "__none" ? " on" : ""}" data-g="__none">未分组 ${fmt(cnt[""])}</button>`);
      favGroupOptions().forEach((g) => {
        if (!cnt[g]) return;
        parts.push(`<button class="fav-chip${state.favFilter === g ? " on" : ""}" data-g="${esc(g)}">${esc(g)} ${fmt(cnt[g])}</button>`);
      });
      parts.push(`<button class="fav-chip" id="favNewGroup" title="新建一个分组，之后收藏的商品可归入其中">+ 新建分组</button>`);
      bar.innerHTML = parts.join("");
    }

    const f = state.favFilter;
    const pick = rows.filter((r) => {
      if (!f) return true;
      const g = r.info.g || "";
      return f === "__none" ? !g : g === f;
    });
    const items = pick.filter((r) => r.it).map((r) => r.it);
    const gateNote = hiddenByGate
      ? `另有 <b>${fmt(hiddenByGate)} 件收藏因月销低于 ${state.lib.gateUsed} 被门槛隐藏</b>。把筛选栏「月销门槛」切成「全部」即可看到。`
      : "";

    if (!items.length) {
      el.innerHTML = "";
      empty.style.display = "block";
      let msg;
      if (!rows.length) msg = "还没有收藏。在「商品库」点卡片上的 🤍 即可收藏，之后可在这里分组、写备注、导出选品清单。";
      else if (f) msg = "该分组下没有可显示的商品。";
      else msg = "收藏的商品当前都不在商品库中（可能已被删除）。";
      empty.innerHTML = gateNote ? msg + " " + gateNote : msg;
      return;
    }
    empty.style.display = hiddenByGate ? "block" : "none";
    if (hiddenByGate) empty.innerHTML = gateNote;

    FORCE_FAV = true;
    try {
      const gopts = favGroupOptions();
      el.innerHTML = items.map((it) => {
        const id = libItemId(it);
        const info = state.fav[id] || {};
        const curG = info.g || "";
        const opts = [`<option value=""${curG ? "" : " selected"}>未分组</option>`]
          .concat(gopts.map((g) => `<option value="${esc(g)}"${curG === g ? " selected" : ""}>${esc(g)}</option>`))
          .join("");
        const extra = `<div class="fav-mgr">
          <select class="fav-g" data-id="${esc(id)}" title="把这个商品归到哪个分组">${opts}</select>
          <input class="fav-note" data-id="${esc(id)}" type="text" maxlength="120" value="${esc(info.n || "")}" placeholder="备注：为什么收藏它？">
          <div class="fav-when">收藏于 ${info.t ? fmtStamp(info.t) : "较早"}</div>
        </div>`;
        return pcardHtml(it, extra);
      }).join("");
    } finally { FORCE_FAV = false; }
    refreshFavButtons();
  }
  // 导出选品清单：收藏连同分组、备注一起导出，直接能拿去比价 / 找货
  function exportFavCsv() {
    const ids = favList();
    if (!ids.length) { showToast("还没有收藏，先收藏几件商品吧"); return; }
    const visible = {}, anyItem = {};
    ((state.catalogAll && state.catalogAll.items) || []).forEach((i) => { visible[libItemId(i)] = i; });
    ((state.catalogAll && state.catalogAll._rawItems) || []).forEach((i) => { anyItem[libItemId(i)] = i; });
    const head = ["商品名", "价格(NT$)", "价格上限(NT$)", "月销", "周销", "累计销量", "评分", "店铺", "地区", "商品链接", "分组", "备注", "收藏时间"];
    const out = [head.map(csvCell).join(",")];
    ids.forEach((id) => {
      const it = visible[id] || anyItem[id];
      const seg = String(id).split("_");
      const shopid = (it && it.shopid != null) ? it.shopid : seg[0];
      const itemid = (it && it.itemid != null) ? it.itemid : seg[1];
      const info = state.fav[id] || {};
      out.push([
        it ? (it.name || "") : "（已不在录制库中）",
        (it && it.price != null) ? String(Math.round(it.price)) : "",
        (it && it.price_max && it.price_max > it.price) ? String(Math.round(it.price_max)) : "",
        (it && it.month_sold != null) ? String(it.month_sold) : "",
        (it && it.week_sold != null) ? String(it.week_sold) : "",
        (it && it.sold_total != null) ? String(it.sold_total) : "",
        (it && it.rating) ? String(it.rating) : "",
        it ? (it.shop || "") : "",
        it ? (it.loc || "") : "",
        "https://shopee.tw/product/" + shopid + "/" + itemid,
        info.g || "", info.n || "",
        info.t ? fmtStamp(info.t) : "",
      ].map(csvCell).join(","));
    });
    const blob = new Blob(["\ufeff" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "虾皮选品清单-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    showToast("已导出选品清单：" + ids.length + " 件（含分组与备注）");
  }

  // 价格展示：多规格商品显示区间「NT$100–200」，普通商品显示单一价格。
  // 数据来源：录制器的 price（下限）/ price_max（上限），后者缺失就不显示区间。
  function priceHtml(it) {
    const cur = state.data ? state.data.currency : "NT$";
    const lo = Math.round(Number(it.price) || 0);
    const hi = Math.round(Number(it.price_max) || 0);
    // 74/491 件商品没采到价格，被归一化成了 0。显示成 NT$0 是错的（会被当成真售价，
    // 还会把「价格低→高」排序的前几十名全占掉），这里显式说明。
    if (!(lo > 0)) return '<span class="muted">价格未采集</span>';
    const warn = priceSanity(it.price) ? FLAG_PRICE_WARN : (it.price_repaired ? FLAG_PRICE_FIXED : "");
    if (hi > lo && lo > 0) return `${cur}${fmt(lo)}<span class="pr-sep">–</span>${fmt(hi)}${warn}`;
    return `${cur}${fmt(lo)}${warn}`;
  }

  function pcardHtml(it, extraHtml) {
    const cur = state.data ? state.data.currency : "NT$";
    const cfg = cardCfg();
    const on = isFav(libItemId(it)) ? "on" : "";
    const cats = (it.cats || []).map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
    const img = it.img
      ? `<img class="pcard-img" src="${esc(thumbUrl(proxyImg(it.img)))}" referrerpolicy="no-referrer" loading="lazy" decoding="async" alt="" onerror="__imgFallback(this)">`
      : `<div class="pcard-img pcard-img-empty">📦</div>`;
    const meta = [];
    // rating 从未被采集 → 恒为 0。摆一排「★ 0」是纯噪音，有真实评分才显示。
    if (cfg.rating && Number(it.rating) > 0) meta.push(`<span class="stars" title="评分 ${it.rating}">${starStr(it.rating)} <b>${it.rating}</b></span>`);
    if (cfg.sales) meta.push(`<span class="muted" title="周/月/总销量">周${fmt(it.week_sold)} · 月${fmtMonth(it.month_sold)} · 总${fmt(it.sold_total)}</span>`);
    if (cfg.official && it.official) meta.push('<span class="badge official">官方</span>');
    const where = [cfg.shop ? esc(it.shop || "—") : "", cfg.loc ? esc((it.loc || "").slice(0, 6)) : ""].filter(Boolean).join(" · ");
    return `<div class="pcard" data-id="${esc(libItemId(it))}">
      ${LIB_CARD_MODE ? `<label class="pc-check-wrap" title="选择此商品"><input type="checkbox" class="pcard-check" data-id="${esc(libItemId(it))}" ${libSel.selected.has(libItemId(it)) ? "checked" : ""}></label>` : ""}
      ${(cfg.fav || FORCE_FAV) ? `<button class="fav-btn ${on}" data-id="${esc(libItemId(it))}" title="${on ? "取消收藏" : "收藏"}">${on ? "❤" : "🤍"}</button>` : ""}
      ${img}
      ${freshBadgeHtml(it)}
      <div class="pcard-body">
        <div class="pcard-name" title="${esc(it.name)}">${esc(it.name || "（未采集到名称）")}</div>
        ${cfg.price ? `<div class="pcard-price">${priceHtml(it)}</div>` : ""}
        ${(cfg.sku && it.main_sku && it.main_sku.name) ? `<div class="pcard-sku">主卖SKU：${esc(it.main_sku.name)}${it.main_sku.price != null ? " · " + cur + fmt(Math.round(it.main_sku.price)) : ""}</div>` : ""}
        ${meta.length ? `<div class="pcard-meta">${meta.join("")}</div>` : ""}
        ${where ? `<div class="pcard-shop">${where}</div>` : ""}
        ${cfg.cats && cats ? `<div class="pcard-cats">${cats}</div>` : ""}
        ${recheckHtml(it)}
        ${extraHtml || ""}
      </div>
    </div>`;
  }

  // ---------- 今日录制采集（按台北时间判定「当天」，按当月销量降序）----------
  const todayState = { page: 1, size: 48, sort: "month", q: "" };

  // 安全地把时间戳转成 Date（兼容 Unix 秒、毫秒、ISO 字符串）
  // 返回有效 Date 或 null，绝不抛异常
  function safeDate(ts) {
    if (ts == null) return null;
    try {
      let n;
      if (typeof ts === 'number') {
        n = ts;
      } else if (typeof ts === 'string') {
        const s = ts.trim();
        // 纯数字字符串 -> 按秒解析
        if (/^\d+$/.test(s)) {
          n = parseInt(s, 10);
        } else if (/^\d{4}-/.test(s)) {
          // ISO 字符串：解析为 UTC 时间
          const d = new Date(s);
          return isNaN(d) ? null : d;
        } else {
          const d = new Date(s);
          return isNaN(d) ? null : d;
        }
      } else {
        return null;
      }
      if (!isFinite(n) || n <= 0) return null;
      // 小于 1e10 视为秒，否则视为毫秒
      const ms = n < 1e10 ? Math.floor(n) * 1000 : Math.floor(n);
      const d = new Date(ms);
      return isNaN(d) ? null : d;
    } catch (e) {
      return null;
    }
  }

  // 把 Unix 时间戳/ISO 字符串换算成「台北时间(UTC+8)」的日期串 YYYY-MM-DD
  function dateStrUTC8(ts) {
    const d = safeDate(ts);
    if (!d) return "";
    try {
      const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
      return utc8.toISOString().slice(0, 10);
    } catch (e) {
      return "";
    }
  }

  function todayStrUTC8() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  // 格式化本地时间显示（用于 sync 心跳、最后同步等），失败返回 "-"
  function fmtLocalTime(ts) {
    const d = safeDate(ts);
    if (!d) return "-";
    try { return d.toLocaleString("zh-Hant"); } catch (e) { return "-"; }
  }

  function wireToday() {
    const T = todayState;
    const search = $("#todaySearch");
    const sort = $("#todaySort");
    // ★ 2026-09-03 性能：输入防抖 300ms。旧写法每敲一个字就重建整页卡片
    //   （48 张图重新解码/请求）→ 输入框明显掉帧、打字发涩。
    if (search) search.addEventListener("input", debounce(() => { T.q = search.value.trim(); T.page = 1; renderToday(); }, 300));
    if (sort) sort.addEventListener("change", () => { T.sort = sort.value; T.page = 1; renderToday(); });
    const pager = $("#todayPager");
    if (pager) pager.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-page]");
      if (!b || b.disabled) return;
      T.page = parseInt(b.dataset.page) || 1;
      renderToday();
    });
  }

  function renderToday() {
    const T = todayState;
    const today = todayStrUTC8();
    const isToday = (it) => dateStrUTC8(it.last_seen || it.first_seen) === today;
    // ★ 2026-09-10：门槛会把它挡掉，但「今日录制」是**录制反馈**，不是选品库。
    //   若只显示过门槛后的件数，用户录了 10 件却只看到 2 件，会以为录制器坏了。
    //   所以这里同时算出「今天实际录了多少」，把被门槛隐藏的数量明说。
    const rawAll = (state.catalogAll && state.catalogAll._rawItems)
      || state.lib.catalogFallback || [];
    const rawTodayN = rawAll.filter(isToday).length;
    let items = (state.lib.catalogFallback || []).filter(isToday);
    const passedTodayN = items.length;                 // 过门槛后的今日件数（搜索前）
    const q = (T.q || "").trim();
    if (q) items = items.filter((it) => libMatch(it, q));
    const map = {
      month: (x) => -(x.month_sold || x.sold_total || 0),
      last: (x) => -(x.last_seen || x.first_seen || 0),
      first: (x) => (x.last_seen || x.first_seen || 0),
      sold: (x) => -(x.sold_total || x.month_sold || 0),
      week: (x) => -(x.week_sold || 0),
      price_asc: (x) => x.price,
      price_desc: (x) => -x.price,
      rating: (x) => -(x.rating || 0),
      reviews: (x) => -x.reviews,
      liked: (x) => -x.liked,
    };
    const kf = map[T.sort] || map.month;
    items.sort((a, b) => kf(a) - kf(b));

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / T.size));
    T.page = Math.min(Math.max(1, T.page), pages);
    const pageItems = items.slice((T.page - 1) * T.size, T.page * T.size);

    const grid = $("#todayGrid");
    if (!grid) return;
    const syncHint = state.lastSyncTs
      ? ` · 最后同步 ${fmtLocalTime(state.lastSyncTs)}（云端约每 3–5 分钟刷新一次）`
      : "";
    const hiddenToday = Math.max(0, rawTodayN - passedTodayN);
    $("#todayCount").textContent =
      `今日（台北 ${today}）录制 ${fmt(total)} 件`
      + (hiddenToday ? ` · 另有 ${fmt(hiddenToday)} 件月销低于 ${state.lib.gateUsed} 未进网站` : "")
      + (q ? ` · 搜索「${T.q}」命中 ${items.length} 件` : "")
      + syncHint;
    if (!pageItems.length) {
      grid.innerHTML = hiddenToday
        ? '<div class="empty">今天录到的商品月销都低于门槛，按规则没有进入网站。<br>'
          + '想看看它们：把上方筛选栏的「月销门槛」切成「全部」即可显示，或到「商品库」查看。</div>'
        : '<div class="empty">今天还没有录制到商品。打开录制器，去虾皮买家端浏览 / 搜索，新商品会自动出现在这里。</div>';
    } else {
      grid.innerHTML = pageItems.map((it) => pcardHtml(it)).join("");
    }
    renderTodayPager(pages);
  }

  function renderTodayPager(pages) {
    const T = todayState;
    const pager = $("#todayPager");
    if (!pager) return;
    if (pages <= 1) { pager.innerHTML = ""; return; }
    let h = `<button data-page="${Math.max(1, T.page - 1)}" ${T.page <= 1 ? "disabled" : ""}>‹ 上一页</button>`;
    const start = Math.max(1, T.page - 3), end = Math.min(pages, T.page + 3);
    if (start > 1) h += `<button data-page="1">1</button>${start > 2 ? "<span>…</span>" : ""}`;
    for (let pg = start; pg <= end; pg++)
      h += `<button data-page="${pg}" class="${pg === T.page ? "cur" : ""}">${pg}</button>`;
    if (end < pages) h += `${end < pages - 1 ? "<span>…</span>" : ""}<button data-page="${pages}">${pages}</button>`;
    h += `<button data-page="${Math.min(pages, T.page + 1)}" ${T.page >= pages ? "disabled" : ""}>下一页 ›</button>`;
    pager.innerHTML = h;
  }

  // ---------- 定价计算器 ----------
  function wireCalc() {
    const ids = ["cCost", "cWeight", "cShipKg", "cPack", "cRate", "cMargin", "cOther"];
    const calc = () => {
      const cost = +$("#cCost").value || 0;
      const weight = +$("#cWeight").value || 0;
      const shipKg = +$("#cShipKg").value || 0;
      const pack = +$("#cPack").value || 0;
      const rate = (+$("#cRate").value || 0) / 100;
      const margin = (+$("#cMargin").value || 0) / 100;
      const other = (+$("#cOther").value || 0) / 100;
      const ship = weight * shipKg;
      const base = cost + ship + pack;
      const denom = 1 - rate - other - margin;
      const price = denom > 0 ? base / denom : 0;
      const feeComm = price * rate, feeOther = price * other;
      const profit = price - base - feeComm - feeOther;
      const cur = state.data ? state.data.currency : "NT$";
      const m = (n) => cur + fmt(Math.round(n));
      const cls = profit >= 0 ? "pos" : "neg";
      $("#calcOut").innerHTML = `
        <div class="calc-row"><span>单件成本+物流+打包</span><b>${m(base)}</b></div>
        <div class="calc-row"><span>平台佣金 (${$("#cRate").value}%)</span><b>${m(feeComm)}</b></div>
        <div class="calc-row"><span>其他费率 (${$("#cOther").value}%)</span><b>${m(feeOther)}</b></div>
        <div class="calc-row big"><span>建议售价</span><b class="pos">${price ? m(price) : "—"}</b></div>
        <div class="calc-row big"><span>单件利润</span><b class="${cls}">${price ? m(profit) : "—"}</b></div>
        <div class="calc-row"><span>实际利润率</span><b class="${cls}">${price ? (profit / price * 100).toFixed(1) + "%" : "—"}</b></div>
        ${denom <= 0 ? '<div class="calc-warn">⚠️ 费率+利润率合计已超过 100%，无法定价，请下调佣金/其他费率或目标利润率。</div>' : ""}
      `;
    };
    ids.forEach((id) => $("#" + id).addEventListener("input", calc));
    calc();
  }

  // ---------- 录制状态（通过sync blob时间戳判断） ----------
  let _recStatusTs = 0;
  // ★ 2026-09-03 性能优化：录制状态徽章与同步轮询都会拉 sync.json，
  //   两处独立轮询（15s + 30s）意味着网络请求翻倍，慢网下会明显卡顿。
  //   这里做 10 秒内的请求共享：多个调用方复用同一个 in-flight Promise，
  //   把实际请求次数减少一半以上。
  let _syncShared = { at: 0, promise: null };
  function fetchSyncShared() {
    const now = Date.now();
    if (_syncShared.promise && (now - _syncShared.at) < 10000) return _syncShared.promise;
    _syncShared = { at: now, promise: fetchFirst(syncSourceUrls(), 0) };
    return _syncShared.promise;
  }
  function wireRecorderStatus() {
    const badge = $("#recBadge");
    if (!badge) return;
    const tick = () => {
      // ★ 2026-09-03 性能：页面切到后台时不轮询。后台标签页的定时器仍在跑，
      //   会持续占用带宽/连接池，用户切回前台点按钮时反而更慢。
      if (document.hidden) return;
      if (!_source.sync_url) {
        badge.textContent = "○ 同步待机";
        badge.className = "badge rec-off";
        badge.title = "等待同步连接...";
        return;
      }
      fetchSyncShared()
        .then((d) => {
          const ts = d.sync_ts || 0;
          const now = Math.floor(Date.now() / 1000);
          const age = now - ts;
          const alive = age < 600; // 10 分钟内有更新=在线（容忍网络抖动）
          const cls = alive ? "rec-on" : "rec-off";
          let txt;
          if (alive) {
            txt = "● 录制中" + (d.total_count ? " · " + d.total_count + "件" : "");
          } else {
            txt = age < 1800 ? "○ 同步待机" : "○ 录制停止";
          }
          badge.textContent = txt;
          badge.className = "badge " + cls;
          badge.title = "最后心跳: " + fmtLocalTime(ts);
        })
        .catch(() => {
          badge.textContent = "○ 同步待机";
          badge.className = "badge rec-off";
        });
    };
    // 先拿到 GitHub 地址（小巧的 source.json）
    fetch("data/source.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (d && d.sync_url) _source.sync_url = d.sync_url; })
      .catch(() => {});
    tick();
    // 15s → 45s：与 startSyncPoll 同频，且通过 fetchSyncShared 共享请求，避免重复拉取。
    // 页面隐藏时 tick 直接返回，回到前台后由 visibilitychange 补一次。
    setInterval(tick, 45000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  // ---------- 实时数据同步（GitHub 永久存储轮询） ----------
  let _source = { catalog_url: "data/catalog.json", sync_url: "" };
  let _lastSyncTs = 0;
  let _loadedCatalogTs = 0;
  // ★ 2026-09-02 内容指纹：记录「上一次真正应用/渲染的数据」= catalog_ts + 商品 id 序列。
  //   后台刷新（deleted.json 拉取、revalidate、30s 轮询、手动同步）若拉到的是同一份数据，
  //   applyCatalog 将直接返回 false → 跳过重建 DOM。修复「数据没变、页面却被整块重渲染，
  //   所有商品图重新从慢速 CDN 加载 → 正常显示几秒后闪一下/像重新加载」的问题。
  let _appliedSig = null;
  function wireSync() {
    // 手动「立即同步」按钮：强制绕过缓存重新拉取 GitHub 最新 catalog
    const msb = document.getElementById("manualSyncBtn");
    if (msb) {
      msb.addEventListener("click", async () => {
        if (msb.disabled) return;
        const old = msb.textContent;
        msb.disabled = true;
        msb.textContent = "同步中…";
        msb.classList.add("syncing");
        const prevTs = _loadedCatalogTs;
        const prevCount = (state.lib.catalogFallback || []).length;
        try {
          // 同步：优先 GitHub Git Data API（录制器权威写入源，永远实时、无 CDN 缓存），
          // 超时(8s)才退 Gitee / CDN 镜像兜底。已删商品由本地删除集合在渲染时过滤，不会复活。
          // 按钮上限 13 秒：给「GitHub 读取(≤8s) + 镜像兜底」留余量；所有源都失败才回退本地快照。
          const withTimeout = (p, ms) =>
            Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("13 秒超时")), ms))]);
          const doc = await withTimeout(fetchLatestCatalog(_loadedCatalogTs), 13000);
          const newCount = (doc.items || []).length;
          const changed = applyCatalog(doc);
          _loadedCatalogTs = normTs(doc.catalog_ts);
          if (changed) refreshCurrentView();
          // 同步 badge
          const sb = $("#syncBadge");
          if (sb) {
            sb.textContent = "☁ 已同步 " + newCount + " 件";
            sb.className = "badge sync-on";
            sb.title = "最后同步: " + new Date().toLocaleString("zh-Hant");
          }
          const dg = window.__syncDiag || {};
          if (dg.winner === "mirror") {
            // GitHub 权威源没拿到（多半是没填 token / 私有库无权限）→ 用的是可能陈旧的镜像
            showToast("⚠️ 用了镜像源（GitHub 读取失败），请确认「⚙ GitHub Token」已填且库可读");
          } else if (normTs(doc.catalog_ts) > prevTs) {
            const added = Math.max(0, newCount - prevCount);
            showToast(added > 0 ? "☁ 已同步 " + added + " 件新商品（GitHub）" : "☁ 已拉取最新商品（GitHub）");
          } else {
            showToast("☁ 已是最新（无更新）");
          }
          // 后台再跑一次实时 API，确保抓到录制器「刚推送」的极新数据
          revalidateCatalog(_loadedCatalogTs);
        } catch (e) {
          // 3s 内无源返回：尝试本地兜底，避免误报失败
          try {
            const localDoc = await fetch("data/catalog.json?_=" + Math.random().toString(36).slice(2))
              .then((r) => (r.ok ? r.json() : null)).catch(() => null);
            if (localDoc && localDoc.items && localDoc.items.length) {
              const changed = applyCatalog(localDoc);
              _loadedCatalogTs = normTs(localDoc.catalog_ts);
              if (changed) {
                refreshCurrentView();
                showToast("☁ 线上源超时，已用本地缓存（可能不是最新）");
              }
            } else {
              const dg = window.__syncDiag || {};
              const why = dg.gh ? ("GitHub:" + (dg.gh.error || (dg.gh.ok ? "ok但无满足门槛数据" : "no-data"))) : "GitHub:未尝试";
              showToast("同步失败：" + why + "；请确认「⚙ GitHub Token」已填");
              console.error("[syncDiag]", dg);
            }
          } catch (_) {
            showToast("同步失败：" + e.message);
          }
        } finally {
          msb.disabled = false;
          msb.textContent = old;
          msb.classList.remove("syncing");
        }
      });
    }
    // 从 data/source.json 读取 GitHub 永久地址
    fetch("data/source.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (d && d.sync_url) {
          _source.catalog_url = d.catalog_url || _source.catalog_url;
          _source.sync_url = d.sync_url;
          if (d.catalog_path) _source.catalog_path = d.catalog_path;
          if (d.api_token) _source.api_token = d.api_token;
          startSyncPoll();
        } else if (d && d.catalog_url) {
          _source.catalog_url = d.catalog_url;
          if (d.catalog_path) _source.catalog_path = d.catalog_path;
          if (d.api_token) _source.api_token = d.api_token;
        }
      })
      .catch(() => {});
  }
  function startSyncPoll() {
    const tick = () => {
      if (!_source.sync_url) return;
      // ★ 2026-09-03 性能：后台标签页不轮询（省带宽/连接池，前台操作才跟手）
      if (document.hidden) return;
      fetchSyncShared()
        .then((d) => {
          if (!d) return;
          const ts = d.sync_ts || 0;
          if (ts > _lastSyncTs) {
            const isFirst = _lastSyncTs === 0;
            _lastSyncTs = ts;
            state.lastSyncTs = ts;   // 暴露给「今日录制」板块显示同步状态
            const total = d.total_count || (state.lib.catalogFallback || []).length;
            // 同步 badge
            const sb = $("#syncBadge");
            if (sb) {
              sb.textContent = "☁ 已同步 " + total + " 件";
              sb.className = "badge sync-on";
              sb.title = "最后同步: " + fmtLocalTime(ts);
            }
            // catalog 有更新则重新拉取全量并刷新视图
            const catTs = normTs(d.catalog_ts);
            if (catTs > _loadedCatalogTs) {
              reloadCatalog(catTs).then((ok) => {
                if (ok && !isFirst) {
                  refreshCurrentView();
                  showToast("☁ 已更新 " + total + " 件商品");
                }
              });
            } else if (!isFirst) {
              // ★ 2026-09-02：sync_ts 心跳推进但 catalog_ts 未变时，**不再无条件整块重渲当前视图**
              //   （旧写法在录制器在线时每 30s 把商品网格重建一次、全部图片重拉 → 周期闪屏）。
              //   「今日录制」依赖 lastSyncTs 显示同步时间 → 只轻量重渲它；商品库仅在尚无数据时兜底补渲。
              const tabBtn = $(".tab-btn.on");
              const tab = tabBtn ? tabBtn.dataset.tab : "";
              if (tab === "today") {
                renderToday();
              } else if ((tab === "library" || !tab) &&
                         !(state.lib.catalogFallback && state.lib.catalogFallback.length)) {
                clientLibSearch();
              }
            }
          }
        })
        .catch(() => {
          const sb = $("#syncBadge");
          if (sb && _lastSyncTs === 0) {
            sb.textContent = "☁ 同步待机";
            sb.className = "badge sync-off";
          }
        });
    };
    tick();
    // 30s → 45s；页面隐藏时 tick 直接返回，回到前台后由 visibilitychange 立刻补一次。
    setInterval(tick, 45000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  // 把一份 catalog 文档应用到内存状态（供手动同步 / 轮询 / 本地兜底复用）
  // 精简版 catalog 的字段补齐。
  // 为削减传输体积（426KB → 235KB，-45%），catalog.json 省略了两类字段：
  //   1) 可派生字段：id / url / sold / total_sold / week_sold / listed_at
  //   2) 零值与空值字段：price=0、shop=""、cats=[] 之类一律不写
  // 这里在数据入口一次性补回，让后续所有视图代码拿到的对象结构与旧版完全一致
  // （视图层零改动、零回归；不做补齐会出现 NaN / undefined）。
  const _WEEK_DIV = 4.345;
  function normalizeCatalog(doc) {
    const items = (doc && doc.items) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it._n) continue; // 已补齐过，避免重复遍历
      const sid = it.shopid, iid = it.itemid;
      if (!it.id && sid != null && iid != null) it.id = sid + "_" + iid;
      if (!it.url && sid != null && iid != null) it.url = "https://shopee.tw/product/" + sid + "/" + iid;
      const ms = Number(it.month_sold) || 0;
      const ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
      it.month_sold = ms;
      it.monthly_sold = ms;            // 补齐别名：详情弹窗/热销/飙升表读的是 monthly_sold
      it.sold_total = ts;
      it.total_sold = ts;
      if (it.sold == null) it.sold = ms;                     // sold 口径 = 月销量
      if (it.week_sold == null) it.week_sold = ms > 0 ? Math.round(ms / _WEEK_DIV) : 0;
      if (!it.first_seen) it.first_seen = 0;
      if (!it.last_seen) it.last_seen = it.first_seen || 0;
      if (!it.listed_at) it.listed_at = it.first_seen || 0;
      if (it.img == null) it.img = "";       // 无主图 → 空串（视图走占位图分支）
      if (it.name == null) it.name = "";
      if (it.price == null) it.price = 0;
      if (it.rating == null) it.rating = 0;
      // 价格区间上限：只有严格高于现价的才认（脏数据/等于现价一律清掉，卡片按单一价格显示）
      if (it.price_max != null) {
        const _mx = Number(it.price_max);
        if (!isFinite(_mx) || _mx <= Number(it.price) || _mx >= 1000000) it.price_max = undefined;
        else it.price_max = _mx;
      }
      if (it.reviews == null) it.reviews = 0;
      if (it.liked == null) it.liked = 0;
      if (it.stock == null) it.stock = 0;
      if (it.shop == null) it.shop = "";
      if (it.loc == null) it.loc = "";
      if (it.brand == null) it.brand = "";
      if (it.discount == null) it.discount = "";
      if (it.official == null) it.official = false;
      if (!it.cats) it.cats = [];
      if (!it.tiers) it.tiers = [];
      if (!it.main_sku) it.main_sku = { name: null, price: it.price };
      it._n = 1;
    }
    return doc;
  }

  // ---------- 月销门槛（默认 30：月销<30 不进入网站） ----------
  // 注：常量写在函数体内是刻意的 —— __sim.js 会从 app.js 里「按函数名抽取源码」单独 eval，
  //     若依赖模块级 const，抽出来的函数会因变量未定义而崩（曾踩过）。
  function getGate() {
    var KEY = "shopee_gate_v1", DEF = 30;
    try {
      var v = localStorage.getItem(KEY);
      if (v == null || v === "") return DEF;
      var n = Number(v);
      return isFinite(n) && n >= 0 ? n : DEF;
    } catch (e) { return DEF; }
  }
  function setGate(v) {
    try { localStorage.setItem("shopee_gate_v1", String(v)); } catch (e) {}
  }
  // 门槛变更 → 强制重新应用 catalog（绕过内容指纹去重）并刷新当前视图
  function wireGate() {
    const sel = $("#libMinGate");
    if (!sel) return;
    const g = String(getGate());
    // 存的值若不在下拉选项里（历史遗留），回落到默认，避免下拉显示空白
    const has = Array.prototype.some.call(sel.options, (o) => o.value === g);
    sel.value = has ? g : "30";
    if (!has) setGate(30);
    if (sel.__srBound) return;
    sel.__srBound = true;
    sel.addEventListener("change", () => {
      const v = Number(sel.value) || 0;
      setGate(v);
      _appliedSig = "";
      if (state.catalogAll && state.catalogAll._rawItems) {
        applyCatalog(state.catalogAll);
        refreshAnalysisViews();
      }
      refreshCurrentView();
      showToast(v ? "月销门槛已改为 ≥" + v + "，低动销商品已隐藏" : "月销门槛已关闭，显示全部商品");
    });
  }

  function applyCatalog(doc) {
    normalizeCatalog(doc);
    // ★ 保留全量原始列表：applyCatalog 会就地覆盖 doc.items 为「过滤后的结果」，
    //   若不另存一份，放宽「月销门槛」时被过滤掉的商品已从 doc.items 消失、无法恢复。
    if (!doc._rawItems) doc._rawItems = (doc.items || []).slice();
    const _srcItems = doc._rawItems;
    // ★ 月销门槛（2026-09-10 用户重申并落实）：只保留「月销 ≥ 30」的商品进入网站。
    //   此前该项被 `if (it.keep_shop) return true;` 无条件放行，导致店铺录制来的
    //   月销 0~29 的长尾商品照样显示（线上 491 件里有 326 件月销<30）——
    //   等于规则没生效。现改为：门槛对所有商品一视同仁，店铺录制商品同样受限。
    //   唯一例外：月销=0 代表「虾皮台站隐藏了月销文案」，若其累计总销 ≥ 200
    //   （疑似真实爆款）仍保留，避免因数据源缺失漏掉好货。
    //   门槛可通过筛选栏「月销门槛」下拉调整（30 / 100 / 全部），默认 30。
    const MIN_MONTH = getGate();
    // 渲染级保险：过滤「已从 GitHub 源真删」的商品（即使本数据来自 stale 镜像 / 本地快照也一并隐藏）。
    // ★ 服务端删除标记 doc.deleted = { id: 删除时间戳秒 }：与浏览器 localStorage 无关，
    //   换浏览器/清缓存/换电脑后删除依然生效；仅当商品被「重新录制」（last_seen 晚于删除时间）才恢复显示。
    const delSet = loadDelSet();
    // 合并两个服务端删除源：① deleted.json（独立小文件，最可靠）② catalog 内嵌的 deleted 字段
    const srvDel = (() => {
      const a = (_serverDeleted && typeof _serverDeleted === 'object') ? _serverDeleted : {};
      const b = (doc.deleted && typeof doc.deleted === 'object' && !Array.isArray(doc.deleted)) ? doc.deleted : {};
      if (!Object.keys(b).length) return Object.keys(a).length ? a : null;
      if (!Object.keys(a).length) return b;
      const m = Object.assign({}, a);
      for (const k in b) { if (!(k in m) || Number(b[k]) > Number(m[k])) m[k] = b[k]; }
      return m;
    })();
    let items = _srcItems.filter((it) => {
      const id = libItemId(it);
      if (delSet.has(id)) return false;                       // ① 本地删除集合（本机生效）
      // ★ 2026-09-03：服务端删除标记改为「无条件隐藏」，不再比较 last_seen 与删除时间的先后。
      //   旧逻辑「last_seen 晚于删除时间就当作用户重新录的新品」正是商品复活的元凶：
      //   用户在网站删完商品 → 再去跨境卫士逛同一家店铺 → 录制器重新录到该商品、
      //   last_seen 刷新到当前时间 → 被判为"新品"重新显示。
      //   线上实测：48 条删除记录里有 6 件因此复活（last_seen 比删除时间晚 851~853 秒）。
      //   删除是最终决定；要恢复请点「清空本地删除记录」（会清空 deleted.json）。
      if (srvDel && srvDel[id]) return false;                 // ② 服务端删除标记（跨浏览器生效）
      return true;
    });
    let _hiddenByGate = 0;
    items = items.filter((it) => {
      if (MIN_MONTH <= 0) return true;                        // 用户选择「全部」→ 不过滤
      const ms = Number(it.month_sold) || 0;
      const ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
      if (ms >= MIN_MONTH) return true;                       // 月销达标
      // 月销未知（虾皮隐藏文案）但累计总销够大 → 视为疑似爆款保留
      if (ms === 0 && ts >= 200) return true;
      _hiddenByGate++;
      return false;
    });
    state.lib.hiddenByGate = _hiddenByGate;
    state.lib.gateUsed = MIN_MONTH;
    items.sort((a, b) => (b.month_sold || 0) - (a.month_sold || 0) || (b.sold_total || b.total_sold || 0) - (a.sold_total || a.total_sold || 0));
    doc.items = items;
    doc.total = items.length;
    // ★ 2026-09-02 内容指纹：与上次已应用内容完全一致 → 不做状态变更、直接返回 false，
    //   由调用方跳过刷新。消除「deleted.json / 30s 轮询 / revalidate 拉到同一份数据后，
    //   仍把已渲染的商品网格整块重建 → 正常显示几秒后闪屏一下、像重新加载」的假象。
    //   指纹 = catalog_ts + 过滤后的商品 id 序列；本地删除集合 / 服务端删除变化时 id 序列必变，
    //   因此「删掉商品」这类真实变更仍会照常触发刷新，不会误判为无变化。
    const sig = (normTs(doc.catalog_ts) || 0) + ':' + MIN_MONTH + ':' + items.map(libItemId).join(',');
    if (_appliedSig === sig) return false;
    _appliedSig = sig;
    _libGridSig = "";   // 数据已变更 → 强制网格重建（指纹去重不能挡住真实更新）
    state.catalogAll = doc;
    state.lib.catalogFallback = items;
    if (items.length) state.lib._dataReady = true;
    setDataDate(state.data ? state.data.date : "");
    // 重算分类/地区 facets
    const cats = {}, locs = {};
    items.forEach((it) => {
      (it.cats || []).forEach((c) => cats[c] = (cats[c] || 0) + 1);
      if (it.loc) { const ci = cityOf(it.loc); locs[ci] = (locs[ci] || 0) + 1; }
    });
    state.lib.cats = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
    state.lib.locs = Object.keys(locs).sort((a, b) => locs[b] - locs[a]);
    // 数据到位后：给关注词记一次今日命中数（同一天幂等），并刷新看板
    try { refreshKwStats(); renderKw(); } catch (e) {}
    return true;
  }

  function reloadCatalog(catTs) {
    // 优先 Git Data API 实时拉取（绕过 raw CDN 缓存）；否则用当前已加载的 catalog_ts 作为下限
    const minTs = normTs(catTs) || _loadedCatalogTs || 0;
    return fetchLatestCatalog(minTs)
      .then((doc) => {
        const prevTs = _loadedCatalogTs;
        const changed = applyCatalog(doc);
        _loadedCatalogTs = normTs(doc.catalog_ts) || normTs(catTs);
        // true 表示确实发生了「内容或时间戳」的更新，调用方才重建视图（避免同数据重复渲染闪屏）
        return changed || normTs(doc.catalog_ts) > prevTs;
      })
      .catch(() => false);
  }

  function refreshCurrentView() {
    // 根据当前激活的 tab 刷新对应视图
    const active = $(".tab-btn.on");
    if (!active) return;
    const tab = active.dataset.tab;
    if (tab === "library") {
      clientLibSearch();
    } else if (tab === "today") {
      renderToday();
    } else if (tab === "hot") {
      renderHot();
    } else if (tab === "soaring") {
      renderSoar();
    } else if (tab === "band") {
      renderBand();
    } else if (tab === "blue") {
      renderBlue();
    } else if (tab === "shops") {
      wireShops();
    } else if (tab === "fav") {
      wireFav();
    }
  }

  function showToast(msg) {
    let t = $("#toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 4000);
  }
})();
