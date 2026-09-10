/* 虾皮台湾选品看板 — 前端逻辑（零依赖，纯原生 JS） */
(function () {
  "use strict";
  // 部署版本号：每次修复后部署都递增，并在 index.html 的 app.js 引用后加 ?v= 同号，
  // 强制浏览器放弃旧缓存（静态站点会长期缓存 app.js，否则用户测到的永远是旧逻辑）。
  // 排查问题时可在控制台执行 `console.log(window.__APP_VERSION)` 核对线上实际版本。
  const APP_VERSION = "20260910c"; window.__APP_VERSION = APP_VERSION;
  // 在顶栏显示版本号芯片（用户无需打开控制台就能确认是否加载到新代码，
  // 这是排查"改了没用/反复失败"假象的最直接方式）。
  try { document.getElementById('appVersionChip').textContent = 'v' + APP_VERSION; } catch (e) {}
  const state = {
    data: null,
    filter: "",
    sort: {},
    lastSyncTs: 0,     // 云端最后同步时间戳（秒），用于「今日录制」板块显示同步状态
    catalogAll: null,   // 完整商品库（data/catalog.json），用于行业大盘/店铺/榜单/收藏的客户端聚合
    fav: [],            // 收藏的商品 id 列表（localStorage）
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
    try { state.fav = JSON.parse(localStorage.getItem("shopee_fav") || "[]"); } catch (e) { state.fav = []; }
    loadCatalogAll().then(() => {
      wireLibrary();
      wireToday();
      wireMarket();
      wireRankings();
      wireShops();
      wireFav();
    });
    wireCalc();
    wireSync();
    wireRecorderStatus();
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

  // ---------- 概览卡片 ----------
  function renderCards() {
    const a = state.data.analysis;
    const cards = [
      { n: fmt(a.total_items), l: "采集商品数" },
      { n: a.blue_ocean.length, l: "蓝海关键词" },
      { n: a.soaring.length, l: "飙升商品(较前日)" },
      { n: a.best_band ? a.best_band.label : "-", l: "最佳价格带" },
      { n: a.best_category ? a.best_category.category : "-", l: "最热类目" },
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
        均销量: fmt(k.avg_sold),
        均价: money(k.avg_price),
        均评分: k.avg_rating,
        蓝海指数: "<b>" + k.blue_ocean + "</b>",
      })),
      ["rank", "关键词", "商品数", "均销量", "均价", "均评分", "蓝海指数"]
    );
  }

  // ---------- 热销 ----------
  function renderHot() {
    const rows = filterSort(state.data.analysis.hot, (it) => ({
      rank: 0,
      商品: `<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>`,
      关键词: `<span class="pill">${esc(it.keyword)}</span>`,
      价格: money(it.price),
      总销量: fmt(it.historical_sold),
      周销量: fmt(it.weekly_sold),
      月销量: fmt(it.monthly_sold),
      点赞: fmt(it.liked_count),
      评分: it.rating_star,
      产地: esc(it.shop_location || "-"),
      _raw: it,
    }));
    fillTable(
      "#tblHot",
      rows.map((r, i) => Object.assign({ rank: i + 1 }, r)),
      ["rank", "商品", "关键词", "价格", "总销量", "周销量", "月销量", "点赞", "评分", "产地"],
      rows
    );
  }

  // ---------- 飙升 ----------
  function renderSoar() {
    const rows = filterSort(state.data.analysis.soaring, (it) => ({
      rank: 0,
      商品: `<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>`,
      价格: money(it.price),
      总销量: fmt(it.historical_sold),
      周销量: fmt(it.weekly_sold),
      月销量: fmt(it.monthly_sold),
      增量: `<span class="up">+${fmt(it.sold_delta)}</span>`,
      关键词: `<span class="pill">${esc(it.keyword)}</span>`,
      _raw: it,
    }));
    fillTable(
      "#tblSoar",
      rows.map((r, i) => Object.assign({ rank: i + 1 }, r)),
      ["rank", "商品", "价格", "总销量", "周销量", "月销量", "增量", "关键词"],
      rows
    );
    if (!state.data.analysis.soaring.length) {
      $("#tblSoar tbody").innerHTML =
        '<tr><td colspan="8" style="color:#999">暂无前一日数据可对比（连续运行多日后出现）</td></tr>';
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
          today: "panel-today",
          market: "panel-market",
          rankings: "panel-rankings",
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

  function doLookup() {
    const input = $("#lookupInput").value.trim();
    const hint = $("#lookupHint");
    const res = $("#lookupResult");
    if (!input) {
      hint.textContent = "请粘贴商品链接，或输入 店铺ID 商品ID";
      return;
    }
    hint.textContent = "⏳ 正在抓取真实数据…";
    res.innerHTML = '<div class="loading">⏳ 抓取中…</div>';
    fetch("/api/product?url=" + encodeURIComponent(input))
      .then((r) => {
        if (r.ok) return r.json();
        return r.json().then((j) => Promise.reject(j)).catch(() => Promise.reject({ error: "HTTP " + r.status }));
      })
      .then((d) => {
        hint.textContent = "";
        renderProduct(d, "#lookupResult");
      })
      .catch((err) => {
        const msg = err && err.error ? err.error : "抓取失败";
        res.innerHTML =
          '<div class="loading">无法获取商品详情：' +
          esc(msg) +
          "。当前为静态部署 / 无后端时无法抓真实数据，请在有 server.py 后端的实例上查询。</div>";
        hint.textContent = "";
      });
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
      } else {
        loadCatalogFallback(els);
      }
    });

    const go = (resetPage) => { if (resetPage) L.page = 1; runLibSearch(); };
    els.btn.addEventListener("click", () => { L.q = els.search.value.trim(); go(true); });
    els.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { L.q = els.search.value.trim(); go(true); }
    });
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
    // 从 GitHub 历史 commit 恢复 catalog.json（解决扩展 today-only 过滤误删历史商品）
    const restoreBtn = $("#ghRestoreCatalog");
    if (restoreBtn) restoreBtn.addEventListener("click", async () => {
      const token = getGhToken();
      if (!token) { tm.textContent = "请先填写并保存 GitHub Token"; return; }
      if (!confirm("确定恢复 2026-09-02 07:06 的 335 件商品吗？\n这会覆盖 GitHub 上当前的 catalog.json（6 件）并清空 deleted.json，不可撤销。")) return;
      tm.textContent = "⏳ 正在读取历史版本…";
      try {
        const commit = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/commits/c3089ee", token);
        const treeSha = commit.commit.tree.sha;
        const tree = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/git/trees/" + treeSha + "?recursive=1", token);
        const entry = (tree.tree || []).find((e) => e.path === "catalog.json");
        if (!entry) throw new Error("历史版本中未找到 catalog.json");
        const blob = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/git/blobs/" + entry.sha, token);
        const content = blob.encoding === "base64" ? b64ToUtf8(blob.content) : blob.content;
        const doc = JSON.parse(content);
        doc.deleted = {}; // 清空内嵌删除标记
        // ★ 2026-09-03 关键修复：catalog_ts 必须用「当前时间」，不能沿用历史版本的旧时间戳。
        //   旧写法用历史 ts(1788332780)，而 GitHub 上被扩展误删后的「6 件版本」ts 更大(1788340969)，
        //   raceValid 按 catalog_ts 取最大 → 恢复后的 335 件反而被判为"陈旧"，网站继续显示 6 件。
        const catalogTs = Math.floor(Date.now() / 1000);
        doc.catalog_ts = catalogTs;
        const newCatalog = JSON.stringify(doc);

        tm.textContent = "⏳ 正在写回 catalog.json…";
        const cur = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/contents/catalog.json?ref=main", token);
        await ghApiJson("PUT", "https://api.github.com/repos/23ccf/shopee-sync/contents/catalog.json", token, {
          message: "site: restore " + doc.items.length + " items from history",
          content: utf8ToB64(newCatalog),
          sha: cur.sha,
          branch: "main",
        });

        tm.textContent = "⏳ 正在清空 deleted.json…";
        const delCur = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/contents/deleted.json?ref=main", token).catch(() => null);
        await ghApiJson("PUT", "https://api.github.com/repos/23ccf/shopee-sync/contents/deleted.json", token, {
          message: "site: clear deleted markers after restore",
          content: utf8ToB64("{}"),
          sha: delCur ? delCur.sha : undefined,
          branch: "main",
        });

        tm.textContent = "⏳ 正在更新 sync.json…";
        const syncCur = await ghApiJson("GET", "https://api.github.com/repos/23ccf/shopee-sync/contents/sync.json?ref=main", token);
        await ghApiJson("PUT", "https://api.github.com/repos/23ccf/shopee-sync/contents/sync.json", token, {
          message: "site: update sync after restore",
          content: utf8ToB64(JSON.stringify({
            sync_ts: catalogTs, catalog_ts: catalogTs, running: true, active: true,
            total_count: doc.items.length, updated_at: new Date().toISOString(),
          }, null, 2)),
          sha: syncCur.sha,
          branch: "main",
        });

        tm.textContent = "✓ 已恢复 " + doc.items.length + " 件商品，正在刷新视图…";
        // ★ 立即把恢复结果应用到当前页面 + 落本机缓存，不依赖可能滞后的 CDN，
        //   并用 DELETE_TS_KEY 作为新鲜度门槛，拒绝仍含旧 6 件数据的镜像副本。
        try {
          localStorage.setItem(DELETE_TS_KEY, String(catalogTs));
          localStorage.removeItem(DELSET_KEY);
          _serverDeleted = {};
          _loadedCatalogTs = catalogTs;
          _appliedSig = "";
          _libGridSig = "";
          state.catalogAll = null;
          state.lib.catalogFallback = null;
          state.lib._dataReady = false;
          state.lib.page = 1;
          applyCatalog(doc);
          saveCatalogCache(doc);
          refreshCurrentView();
        } catch (e) {}
        showToast("✓ 已恢复 " + doc.items.length + " 件商品，页面已刷新");
      } catch (e) {
        tm.textContent = "恢复失败：" + (e && e.message);
        console.error("[restore]", e);
      }
    });
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
    $("#libCount").textContent = `${fmt(L.total)} 件匹配${catTotal}`;
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
    if (state.lib.catalogFallback) {
      const it = state.lib.catalogFallback.find(
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
        <div class="p-card"><div class="n">${m(d.price)}${priceSanity(d.price) ? ' <span style="color:#c0392b;font-size:11px;font-weight:600;" title="价格疑似未正确换算，待复核">⚠</span>' : (d.price_repaired ? ' <span style="color:#2e7d32;font-size:11px;font-weight:600;" title="此价格已由系统自动校正">✓</span>' : "")}</div><div class="l">售价</div></div>
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
      })
      .catch(() => {});
  }

  function applyLibFilters(items, L) {
    let its = items.slice();
    const q = (L.q || "").trim().toLowerCase();
    if (q) its = its.filter((it) =>
      ((it.name || "") + " " + (it.shop || "") + " " + (it.brand || "") + " " + (it.cats || []).join(" "))
        .toLowerCase().includes(q));
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
      price_asc: (x) => x.price,
      price_desc: (x) => -x.price, rating: (x) => -(x.rating || 0),
      reviews: (x) => -x.reviews, liked: (x) => -x.liked, new: (x) => -(x.listed_at || 0),
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
    $("#libCount").textContent = `${fmt(L.total)} 件商品`;
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
    const cols = ["id", "name", "price", "main_sku", "sold_total", "month_sold", "week_sold",
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
        const on = isFav(it.id) ? "on" : "";
        const cats = (it.cats || []).map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
        return `<tr data-id="${esc(it.id)}" class="clickable">
          <td class="rk">${medal}</td>
          <td><span class="name" title="${esc(it.name)}">${esc(it.name)}</span></td>
          <td class="num">${cur}${fmt(Math.round(it.price))}</td>
          <td class="num">${metric}</td>
          <td>${esc(it.shop || "—")}</td>
          <td>${cats}</td>
          <td><button class="fav-btn ${on}" data-id="${esc(it.id)}" title="收藏">${on ? "❤" : "🤍"}</button></td>
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
        count: its.length, hot_count: hot_count,
        month_sold: month_sold, week_sold: week_sold,
        total_sold: its.reduce((a, b) => a + (b.sold_total || 0), 0),
        avg_price: avg(prices), weighted_avg_price: weighted_avg_price,
        avg_rating: avg(rated), trend_pct: trend_pct,
        main_cats: main_cats,
        top_product: (top && top.name) || "", top_id: (top && top.id) || "",
      };
    });
    return rows;
  }
  const SHOP_SORT = {
    month: (a, b) => b.month_sold - a.month_sold || b.total_sold - a.total_sold,
    sold: (a, b) => b.total_sold - a.total_sold,
    count: (a, b) => b.count - a.count,
    rating: (a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || b.count - a.count,
  };
  function wireShops() {
    const sortSel = $("#shopSort");
    const render = () => {
      const el = $("#tblShop tbody");
      if (!state.catalogAll) { el.innerHTML = '<tr><td colspan="8" style="color:#999">暂无可聚合数据。</td></tr>'; return; }
      let rows = computeShops(state.catalogAll.items);
      rows.sort(SHOP_SORT[sortSel.value] || SHOP_SORT.count);
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
        return `<tr data-shop="${esc(r.shopid)}" class="clickable">
          <td class="rk">${medal}</td>
          <td><b>${esc(r.name)}</b><br><small class="muted">${esc(r.city || "—")} · ${fmt(r.count)}件</small></td>
          <td class="num"><b>${fmtMonth(r.month_sold)}</b></td>
          <td class="num">${r.hot_count ? fmt(r.hot_count) : '<span class="muted">0</span>'}</td>
          <td class="num">${cur}${fmt(r.weighted_avg_price)}</td>
          <td class="num ${trendCls}">${trendStr}</td>
          <td>${cats_html || '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join("");
      $("#shopHint").textContent = `共 ${fmt(computeShops(state.catalogAll.items).length)} 个店铺（显示 TOP 50）`;
    };
    sortSel.addEventListener("change", render);
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
          <div class="pcard-name" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="pcard-price">${cur}${fmt(Math.round(it.price))}${priceSanity(it.price) ? FLAG_PRICE_WARN : (it.price_repaired ? FLAG_PRICE_FIXED : "")}</div>
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

  // ---------- 收藏 ----------
  function toggleFav(id) {
    const i = state.fav.indexOf(id);
    if (i >= 0) state.fav.splice(i, 1); else state.fav.push(id);
    try { localStorage.setItem("shopee_fav", JSON.stringify(state.fav)); } catch (e) {}
    refreshFavButtons();
    renderFav();
  }
  function refreshFavButtons() {
    $$(".fav-btn").forEach((b) => {
      const on = state.fav.includes(b.dataset.id);
      b.classList.toggle("on", on);
      b.textContent = on ? "❤" : "🤍";
    });
  }
  function isFav(id) { return state.fav.includes(id); }
  function wireFav() { renderFav(); }
  function renderFav() {
    const el = $("#favGrid");
    const empty = $("#favEmpty");
    if (!state.catalogAll) { el.innerHTML = '<div class="empty">暂无可用的商品库数据。</div>'; return; }
    const items = (state.catalogAll.items || []).filter((i) => state.fav.includes(i.id));
    if (!items.length) { el.innerHTML = ""; empty.style.display = "block"; return; }
    empty.style.display = "none";
    el.innerHTML = items.map((it) => pcardHtml(it)).join("");
  }
  function pcardHtml(it) {
    const cur = state.data ? state.data.currency : "NT$";
    const on = isFav(it.id) ? "on" : "";
    const cats = (it.cats || []).map((c) => `<span class="pill sm">${esc(c)}</span>`).join(" ");
    const img = it.img
      ? `<img class="pcard-img" src="${esc(thumbUrl(proxyImg(it.img)))}" referrerpolicy="no-referrer" loading="lazy" decoding="async" alt="" onerror="__imgFallback(this)">`
      : `<div class="pcard-img pcard-img-empty">📦</div>`;
    return `<div class="pcard" data-id="${esc(libItemId(it))}">
      ${LIB_CARD_MODE ? `<label class="pc-check-wrap" title="选择此商品"><input type="checkbox" class="pcard-check" data-id="${esc(libItemId(it))}" ${libSel.selected.has(libItemId(it)) ? "checked" : ""}></label>` : ""}
      <button class="fav-btn ${on}" data-id="${esc(it.id)}" title="收藏">${on ? "❤" : "🤍"}</button>
      ${img}
      <div class="pcard-body">
        <div class="pcard-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="pcard-price">${cur}${fmt(Math.round(it.price))}${priceSanity(it.price) ? FLAG_PRICE_WARN : (it.price_repaired ? FLAG_PRICE_FIXED : "")}</div>
        <div class="pcard-sku">主卖SKU：${esc(it.main_sku && it.main_sku.name ? it.main_sku.name : "—")}${it.main_sku && it.main_sku.price != null ? " · " + cur + fmt(Math.round(it.main_sku.price)) : ""}</div>
        <div class="pcard-meta">
          <span class="stars" title="评分 ${it.rating}">${starStr(it.rating)} <b>${it.rating}</b></span>
          <span class="muted" title="周/月/总销量">周${fmt(it.week_sold)} · 月${fmtMonth(it.month_sold)} · 总${fmt(it.sold_total)}</span>
          ${it.official ? '<span class="badge official">官方</span>' : ""}
        </div>
        <div class="pcard-shop">${esc(it.shop || "—")} · ${esc((it.loc || "").slice(0, 6))}</div>
        <div class="pcard-cats">${cats}</div>
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
    let items = (state.lib.catalogFallback || []).filter(
      (it) => dateStrUTC8(it.last_seen || it.first_seen) === today
    );
    const q = (T.q || "").trim().toLowerCase();
    if (q) items = items.filter((it) =>
      ((it.name || "") + " " + (it.shop || "") + " " + (it.brand || "") + " " + (it.cats || []).join(" "))
        .toLowerCase().includes(q));
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
    $("#todayCount").textContent =
      `今日（台北 ${today}）录制 ${fmt(total)} 件`
      + (q ? ` · 搜索「${T.q}」命中 ${items.length} 件` : "")
      + syncHint;
    if (!pageItems.length) {
      grid.innerHTML = '<div class="empty">今天还没有录制到商品。打开录制器，去虾皮买家端浏览 / 搜索，新商品会自动出现在这里。</div>';
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

  function applyCatalog(doc) {
    normalizeCatalog(doc);
    // 月销门槛（2026-08-26 收紧）：仅保留月销≥30 的商品，过滤掉低动销长尾。
    // 月销=0 代表「近30天月销量未知」（虾皮台站隐藏该文案 + item/get 被 403），
    // 若其总销量≥200（疑似真实爆款）则额外保留，避免漏掉好货；其余未知项直接过滤。
    const MIN_MONTH = 30;
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
    let items = (doc.items || []).filter((it) => {
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
    items = items.filter((it) => {
      // 店铺录制商品：用户主动录制，即便虾皮台站隐藏月/总销量也始终保留、必显示。
      if (it.keep_shop) return true;
      const ms = Number(it.month_sold) || 0;
      const ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
      return ms >= MIN_MONTH || (ms === 0 && ts >= 200);
    });
    items.sort((a, b) => (b.month_sold || 0) - (a.month_sold || 0) || (b.sold_total || b.total_sold || 0) - (a.sold_total || a.total_sold || 0));
    doc.items = items;
    doc.total = items.length;
    // ★ 2026-09-02 内容指纹：与上次已应用内容完全一致 → 不做状态变更、直接返回 false，
    //   由调用方跳过刷新。消除「deleted.json / 30s 轮询 / revalidate 拉到同一份数据后，
    //   仍把已渲染的商品网格整块重建 → 正常显示几秒后闪屏一下、像重新加载」的假象。
    //   指纹 = catalog_ts + 过滤后的商品 id 序列；本地删除集合 / 服务端删除变化时 id 序列必变，
    //   因此「删掉商品」这类真实变更仍会照常触发刷新，不会误判为无变化。
    const sig = (normTs(doc.catalog_ts) || 0) + ':' + items.map(libItemId).join(',');
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
    } else if (tab === "market") {
      wireMarket();
    } else if (tab === "rankings") {
      wireRankings();
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
