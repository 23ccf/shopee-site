/* 销售追踪 + 采购预测
 * 数据来源：source.json 指向的 catalog（与选品库同源）
 * 快照存储：localStorage（key = shopee_track_v1），不上传任何服务器
 *
 * 存储结构（紧凑，避免爆 localStorage）：
 * {
 *   dates: ["2026-09-08", "2026-09-09"],           // 有序
 *   items: { "<id>": { sold:[120,131], month:[100,105] } },  // 与 dates 同索引
 *   meta:  { "<id>": { name, price, url, shop } }            // 最近一次的商品静态信息
 * }
 */
(function () {
  "use strict";

  var LS_KEY = "shopee_track_v1";
  var INV_KEY = "shopee_inv_v1";   // 库存与成本：{ "<id>": {stock, cost} }
  var PO_KEY = "shopee_po_v1";     // 采购单默认参数（备货周期/安全天数等）
  var PREFS_KEY = "shopee_prefs_v1";   // 偏好设置：{ autoSnap: true }
  var PO_LOG_KEY = "shopee_po_log_v1"; // 采购入库历史：[{ ts, at, count, qty, amount, items }]
  var MAX_DAYS = 90;          // 最多保留 90 天快照
  var MAX_PO_LOG = 50;        // 入库历史最多保留 50 条
  var WARN_DAYS = 3;          // 连续 N 天零增长 → 滞销预警

  var state = {
    items: [],       // 当前 catalog
    snaps: null,     // 快照对象
    loaded: false,
    deltas: [],      // 最近一次计算的日增列表
    inv: {},         // 库存与成本表
    invPage: 0,      // 库存表当前页
    invQuery: "",    // 库存表搜索词
    fcRows: [],      // 最近一次补货建议
    fcSel: {},       // 采购单勾选：{ "<id>": true }
    prefs: { autoSnap: true },  // 偏好设置
    poLog: []        // 采购入库历史
  };

  /* ---------------- 工具 ---------------- */

  function $(id) { return document.getElementById(id); }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Number(n).toLocaleString("zh-TW");
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function soldOf(it) {
    var v = it.sold_total;
    if (v === null || v === undefined) v = it.total_sold;
    return Number(v) || 0;
  }

  function monthOf(it) { return Number(it.month_sold) || 0; }

  function itemUrl(it) {
    if (it.url) return it.url;
    var id = String(it.id || "");
    if (id.indexOf("_") > 0) {
      var p = id.split("_");
      return "https://shopee.tw/product/" + p[0] + "/" + p[1];
    }
    return "#";
  }

  /* ---------------- 字段归一化 ----------------
   * 线上 catalog 的 item 只有 shopid / itemid，**没有 id 和 url**；
   * 主站 app.js 有 normalizeCatalog() 会推导，本页也需要，否则
   * 全部商品会塌缩成同一个 id "undefined"。此处与 app.js 保持同一口径。 */
  function normPrice(v) {
    var n = Number(v) || 0;
    for (var i = 0; i < 2 && n > 1000000; i++) n = n / 100000;
    return n;
  }

  /* ★ 月销门槛（与首页 index.html 口径统一）：只保留「月销 ≥ 30」的商品进入网站。
     月销 < 30 直接过滤掉，不出现在任何页面（含快照 / 涨跌榜 / 滞销预警）。
     唯一例外：月销 = 0 代表「虾皮台站隐藏了月销文案」，若累计总销 ≥ 200（疑似真实爆款）仍保留。
     历史上本页没有这道过滤，导致首页只剩月销≥30、本页却把 400+ 件长尾全列出来 —— 两页数字对不上。 */
  var MIN_MONTH = 30;
  function passMonthGate(it) {
    var ms = Number(it.month_sold) || 0;
    var ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
    return ms >= MIN_MONTH || (ms === 0 && ts >= 200);
  }

  function normCatalog(doc) {
    var items = (doc && doc.items) || (Array.isArray(doc) ? doc : []);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it !== "object" || it._n) continue;
      var sid = it.shopid, iid = it.itemid;
      if (!it.id && sid != null && iid != null) it.id = String(sid) + "_" + String(iid);
      if (!it.url && sid != null && iid != null) {
        it.url = "https://shopee.tw/product/" + sid + "/" + iid;
      }
      var ms = Number(it.month_sold) || 0;
      var ts = Number(it.sold_total != null ? it.sold_total : it.total_sold) || 0;
      it.month_sold = ms;
      it.monthly_sold = ms;
      it.sold_total = ts;
      it.total_sold = ts;
      if (it.sold == null) it.sold = ms;
      if (it.week_sold == null) it.week_sold = ms > 0 ? Math.round(ms / 4.345) : 0;
      if (it.name == null) it.name = "";
      it.price = normPrice(it.price);
      if (it.shop == null) it.shop = it.shop_name || "";
      if (it.shop_name == null) it.shop_name = it.shop;
      if (!it.first_seen) it.first_seen = 0;
      if (!it.last_seen) it.last_seen = it.first_seen || 0;
      it._n = 1;
    }
    return items;
  }

  /* ---------------- 数据加载 ---------------- */

  // 单个 URL 尝试拉取（带超时）
  function tryFetch(url, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("超时")); }, ms || 8000);
      fetch(url, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (d) { clearTimeout(timer); resolve(d); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // 从 GitHub 仓库地址推导 jsDelivr CDN 地址（大陆可直连）
  function toJsDelivr(url) {
    var m = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/.exec(url || "");
    if (!m) return null;
    return "https://cdn.jsdelivr.net/gh/" + m[1] + "/" + m[2] + "@" + m[3] + "/" + m[4];
  }

  // 依次尝试多个数据源，任一成功即可
  function loadSource(cb) {
    fetch("data/source.json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        var urls = [];
        if (cfg.catalog_url) urls.push(cfg.catalog_url);
        var cdn = toJsDelivr(cfg.catalog_url);
        if (cdn) urls.push(cdn);
        if (cfg.gitee && cfg.gitee.owner && cfg.gitee.repo) {
          var g = cfg.gitee;
          urls.push("https://gitee.com/" + g.owner + "/" + g.repo +
                    "/raw/" + (g.branch || "master") + "/" + (g.catalogPath || "catalog.json"));
        }
        if (!urls.length) { cb(new Error("source.json 缺少 catalog_url")); return; }

        var i = 0;
        var errors = [];
        function next() {
          if (i >= urls.length) {
            cb(new Error("全部数据源均失败：" + errors.join(" / ")));
            return;
          }
          var u = urls[i++];
          tryFetch(u, 9000)
            .then(function (d) {
              var items = normCatalog(d).filter(passMonthGate);
              if (!items.length) throw new Error("数据为空");
              cb(null, items, u);
            })
            .catch(function (e) {
              errors.push(u.replace(/^https:\/\//, "") + " (" + e.message + ")");
              next();
            });
        }
        next();
      })
      .catch(cb);
  }

  /* ---------------- 快照读写 ---------------- */

  function loadSnaps() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.dates && o.items) return o;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return { dates: [], items: {}, meta: {} };
  }

  function saveSnaps(s) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      return true;
    } catch (e) {
      toast("存储空间不足，请先清空旧快照");
      return false;
    }
  }

  /* ---------------- 库存与成本 ---------------- */

  function loadInv() {
    try {
      var raw = localStorage.getItem(INV_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === "object") return o;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return {};
  }

  function saveInv() {
    try {
      localStorage.setItem(INV_KEY, JSON.stringify(state.inv));
      return true;
    } catch (e) {
      toast("库存数据保存失败（浏览器存储空间不足）");
      return false;
    }
  }

  // 取某商品的库存/成本，缺省为 0
  function invOf(id) {
    var r = state.inv[String(id)];
    if (!r) return { stock: 0, cost: 0, hasStock: false, hasCost: false };
    var stock = Number(r.stock) || 0;
    var cost = Number(r.cost) || 0;
    return {
      stock: stock, cost: cost,
      hasStock: r.stock !== undefined && r.stock !== null && r.stock !== "",
      hasCost: cost > 0
    };
  }

  function setInvField(id, field, val) {
    id = String(id);
    var v = (val === "" || val === null || val === undefined) ? null : Number(val);
    if (v !== null && (isNaN(v) || v < 0)) v = null;
    if (!state.inv[id]) state.inv[id] = {};
    state.inv[id][field] = v;
    // 两个字段都空 → 删掉，保持存储干净
    var r = state.inv[id];
    var e1 = r.stock !== undefined && r.stock !== null && r.stock !== "";
    var e2 = r.cost !== undefined && r.cost !== null && r.cost !== "";
    if (!e1 && !e2) delete state.inv[id];
  }

  /* ---------------- 偏好设置 ---------------- */

  function loadPrefs() {
    var def = { autoSnap: true };
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === "object") {
          if (typeof o.autoSnap === "boolean") def.autoSnap = o.autoSnap;
        }
      }
    } catch (e) { /* 忽略损坏数据，回落默认值 */ }
    return def;
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); }
    catch (e) { /* 偏好写不进去不影响主流程 */ }
  }

  /* ---------------- 采购入库历史 ---------------- */

  function loadPoLog() {
    try {
      var raw = localStorage.getItem(PO_LOG_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (Array.isArray(o)) return o;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return [];
  }

  function savePoLog() {
    try { localStorage.setItem(PO_LOG_KEY, JSON.stringify(state.poLog)); return true; }
    catch (e) { toast("入库历史保存失败（存储空间不足）"); return false; }
  }

  /* ---------------- CSV 导出 ---------------- */

  function csvCell(v) {
    var s = (v === null || v === undefined) ? "" : String(v);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCSV(filename, rows) {
    // 加 BOM，Excel 打开中文不乱码
    var text = "\ufeff" + rows.map(function (r) {
      return r.map(csvCell).join(",");
    }).join("\r\n");
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") + "-" +
      String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
  }

  function takeSnapshot(opts) {
    var silent = !!(opts && opts.silent);
    if (!state.items.length) { if (!silent) toast("还没有商品数据"); return false; }

    var s = state.snaps || loadSnaps();
    var tk = todayKey();
    var idx = s.dates.indexOf(tk);

    // 同一天重复记录 → 覆盖
    if (idx < 0) {
      s.dates.push(tk);
      idx = s.dates.length - 1;
      // 老商品补齐占位（之前没记录的填 null）
      Object.keys(s.items).forEach(function (id) {
        while (s.items[id].sold.length < s.dates.length) s.items[id].sold.push(null);
        while (s.items[id].month.length < s.dates.length) s.items[id].month.push(null);
        // price 序列为后加字段，老快照没有 → 初始化并补齐（供价格趋势图使用）
        if (!s.items[id].price) s.items[id].price = [];
        while (s.items[id].price.length < s.dates.length) s.items[id].price.push(null);
      });
    }

    state.items.forEach(function (it) {
      var id = String(it.id);
      if (!s.items[id]) s.items[id] = { sold: [], month: [], price: [] };
      if (!s.items[id].price) s.items[id].price = [];
      while (s.items[id].sold.length < idx) s.items[id].sold.push(null);
      while (s.items[id].month.length < idx) s.items[id].month.push(null);
      while (s.items[id].price.length < idx) s.items[id].price.push(null);
      s.items[id].sold[idx] = soldOf(it);
      s.items[id].month[idx] = monthOf(it);
      s.items[id].price[idx] = Number(it.price) || 0;   // 价格历史（供「选品洞察→价格趋势」使用）
      s.meta[id] = {
        name: it.name || "",
        price: it.price || 0,
        url: itemUrl(it),
        shop: it.shop || ""
      };
    });

    // 超出保留天数 → 丢弃最老的
    if (s.dates.length > MAX_DAYS) {
      var cut = s.dates.length - MAX_DAYS;
      s.dates = s.dates.slice(cut);
      Object.keys(s.items).forEach(function (id) {
        s.items[id].sold = s.items[id].sold.slice(cut);
        s.items[id].month = s.items[id].month.slice(cut);
        if (s.items[id].price) s.items[id].price = s.items[id].price.slice(cut);
      });
    }

    state.snaps = s;
    saveSnaps(s);
    if (silent) {
      // 提示文案统一交给 renderSnapInfo() 渲染，避免被 renderAll 覆盖
      state.autoRecOn = todayKey();
    } else {
      toast("已记录今日快照（" + state.items.length + " 件商品）");
    }
    renderAll();
    return true;
  }

  // 每天首次打开页面时自动记一次；同一天重复打开不重复写、不覆盖已有数据
  function autoSnapshot() {
    if (!state.prefs.autoSnap) return false;
    if (!state.items.length) return false;
    var s = state.snaps || loadSnaps();
    if (s.dates.indexOf(todayKey()) >= 0) return false;   // 今天已记过 → 幂等跳过
    return takeSnapshot({ silent: true });
  }

  /* ---------------- 计算 ---------------- */

  // 返回 [{id, name, price, url, prev, now, delta, daily, series}]
  function computeDeltas(baseIdx) {
    var s = state.snaps;
    if (!s || s.dates.length < 2) return [];

    var last = s.dates.length - 1;
    var prevIdx = last - baseIdx;
    if (prevIdx < 0) prevIdx = 0;

    var out = [];
    Object.keys(s.items).forEach(function (id) {
      var rec = s.items[id];
      var now = rec.sold[last];
      var prev = rec.sold[prevIdx];
      if (now === null || now === undefined) return;
      if (prev === null || prev === undefined) prev = now;

      // 有效的历史序列（去 null）
      var series = rec.sold.filter(function (v) { return v !== null && v !== undefined; });
      var span = Math.max(series.length - 1, 1);
      var daily = (series[series.length - 1] - series[0]) / span;

      var m = s.meta[id] || {};
      out.push({
        id: id,
        name: m.name || id,
        price: m.price || 0,
        url: m.url || "#",
        shop: m.shop || "",
        prev: prev,
        now: now,
        delta: now - prev,
        daily: daily,
        series: series
      });
    });

    out.sort(function (a, b) { return b.delta - a.delta; });
    return out;
  }

  // 连续零增长检测
  function findStagnant() {
    var s = state.snaps;
    if (!s || s.dates.length < WARN_DAYS) return [];

    var out = [];
    var n = s.dates.length;
    Object.keys(s.items).forEach(function (id) {
      var arr = s.items[id].sold;
      var need = Math.min(WARN_DAYS, n);
      var ok = true;
      for (var i = 0; i < need; i++) {
        var v = arr[n - 1 - i];
        var p = arr[n - 2 - i];
        if (v === null || v === undefined) { ok = false; break; }
        if (p === null || p === undefined) { ok = false; break; }
        if (v !== p) { ok = false; break; }
      }
      if (ok) {
        var m = s.meta[id] || {};
        out.push({
          id: id, name: m.name || id, price: m.price || 0,
          url: m.url || "#", now: arr[n - 1], month: (s.items[id].month[n - 1]) || 0
        });
      }
    });
    return out;
  }

  /* ---------------- 渲染 ---------------- */

  function sparkline(series, w, h) {
    if (!series || series.length < 2) return "";
    w = w || 64; h = h || 20;
    var min = Math.min.apply(null, series);
    var max = Math.max.apply(null, series);
    var span = (max - min) || 1;
    var pts = series.map(function (v, i) {
      var x = (i / (series.length - 1)) * (w - 2) + 1;
      var y = h - 1 - ((v - min) / span) * (h - 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var up = series[series.length - 1] >= series[0];
    var color = up ? "var(--brand)" : "var(--good)";
    return '<svg class="spark" width="' + w + '" height="' + h + '">' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color +
      '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function renderSnapInfo() {
    var s = state.snaps;
    var n = s && s.dates.length ? s.dates.length : 0;
    $("snapCount").textContent = n ? ("共 " + n + " 天记录") : "尚无记录";
    var msg = "";
    if (n) {
      msg = "最新记录：" + s.dates[s.dates.length - 1] +
            "　最早：" + s.dates[0];
      if (s.dates.indexOf(todayKey()) >= 0) {
        msg += "　✅ 今天已记录";
        if (state.autoRecOn === todayKey()) msg += "（本页自动记录）";
      } else {
        msg += "　⏳ 今天还没记录";
        if (state.prefs.autoSnap) msg += "，下次打开本页会自动记";
      }
    } else {
      msg = "点「记录今日快照」开始积累数据。建议每天固定时间记一次。";
      if (state.prefs.autoSnap) msg += "（已开启自动记录，下次打开即会自动记一次）";
    }
    $("snapMsg").innerHTML = esc(msg) +
      (state.srcMsg ? "<br><span style='font-size:12px'>" + esc(state.srcMsg) + "</span>" : "");

    // 对比基准下拉
    var sel = $("baseSel");
    var keep = sel.value;
    sel.innerHTML = "";
    for (var i = 1; i < Math.max(n, 2); i++) {
      var op = document.createElement("option");
      op.value = String(i);
      op.textContent = i === 1 ? "对比昨天" : ("对比 " + i + " 天前");
      sel.appendChild(op);
    }
    if (keep && parseInt(keep, 10) < sel.options.length) sel.value = keep;
  }

  function renderStats() {
    var d = state.deltas;
    var box = $("statBox");
    if (!d.length) {
      box.innerHTML = '<div class="stat"><div class="k">需要至少 2 天快照</div>' +
        '<div class="v">—</div><div class="sub">先记录两天数据</div></div>';
      return;
    }
    var totalDelta = 0, upCnt = 0, downCnt = 0, flatCnt = 0;
    d.forEach(function (x) {
      totalDelta += x.delta;
      if (x.delta > 0) upCnt++;
      else if (x.delta < 0) downCnt++;
      else flatCnt++;
    });
    var top = d[0];

    box.innerHTML =
      '<div class="stat"><div class="k">本期总增量</div>' +
        '<div class="v ' + (totalDelta > 0 ? "up" : totalDelta < 0 ? "down" : "") + '">' +
        (totalDelta > 0 ? "+" : "") + fmt(totalDelta) + '</div>' +
        '<div class="sub">全部商品合计</div></div>' +
      '<div class="stat"><div class="k">上涨商品</div>' +
        '<div class="v up">' + upCnt + '</div>' +
        '<div class="sub">有销量增长</div></div>' +
      '<div class="stat"><div class="k">停滞商品</div>' +
        '<div class="v flat">' + flatCnt + '</div>' +
        '<div class="sub">零增长</div></div>' +
      '<div class="stat"><div class="k">增长冠军</div>' +
        '<div class="v up" style="font-size:15px;line-height:1.4">' +
        esc(String(top.name).slice(0, 18)) + '</div>' +
        '<div class="sub">+ ' + fmt(top.delta) + ' 件</div></div>';
  }

  function renderRank() {
    var d = state.deltas;
    var box = $("rankBox");
    if (!d.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">📊</div>' +
        '需要 2 天以上快照才能计算涨跌</div>';
      return;
    }
    var show = d.slice(0, 60);
    var html = '<table><thead><tr>' +
      '<th style="width:34px">#</th><th>商品</th>' +
      '<th class="num">上期累计</th><th class="num">最新累计</th>' +
      '<th class="num">日增</th><th class="num">日均</th><th>走势</th>' +
      '</tr></thead><tbody>';
    show.forEach(function (x, i) {
      var cls = x.delta > 0 ? "up" : x.delta < 0 ? "down" : "flat";
      var sign = x.delta > 0 ? "+" : "";
      html += '<tr>' +
        '<td class="flat">' + (i + 1) + '</td>' +
        '<td class="pname"><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' +
          esc(x.name) + '</a></td>' +
        '<td class="num">' + fmt(x.prev) + '</td>' +
        '<td class="num">' + fmt(x.now) + '</td>' +
        '<td class="num ' + cls + '">' + sign + fmt(x.delta) + '</td>' +
        '<td class="num">' + (x.daily >= 0 ? "" : "") + x.daily.toFixed(1) + '</td>' +
        '<td>' + sparkline(x.series) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (d.length > show.length) {
      html += '<div style="margin-top:10px;font-size:12px;color:var(--muted)">' +
        '仅显示前 ' + show.length + ' 件（共 ' + d.length + ' 件）</div>';
    }
    box.innerHTML = html;
  }

  function renderWarn() {
    var list = findStagnant();
    var box = $("warnBox");
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">✅</div>' +
        '暂无滞销预警（需要 ' + WARN_DAYS + ' 天以上快照）</div>';
      return;
    }
    list.sort(function (a, b) { return b.month - a.month; });
    var html = '<table><thead><tr><th>商品</th>' +
      '<th class="num">月销</th><th class="num">累计销量</th><th>状态</th>' +
      '</tr></thead><tbody>';
    list.slice(0, 50).forEach(function (x) {
      html += '<tr>' +
        '<td class="pname"><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' +
          esc(x.name) + '</a></td>' +
        '<td class="num">' + fmt(x.month) + '</td>' +
        '<td class="num">' + fmt(x.now) + '</td>' +
        '<td><span class="warn-tag">连续 ' + WARN_DAYS + ' 天零增长</span></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  function renderAll() {
    renderSnapInfo();
    var sel = $("baseSel");
    var base = sel && sel.value ? parseInt(sel.value, 10) : 1;
    state.deltas = computeDeltas(base);
    renderStats();
    renderRank();
    renderWarn();
    renderInv();
  }

  /* ---------------- 库存与成本：渲染 ---------------- */

  // 汇总成库存表的数据源（catalog 优先，缺失时回退快照 meta）
  function invSource() {
    var seen = {};
    var list = [];
    (state.items || []).forEach(function (it) {
      var id = String(it.id);
      if (seen[id]) return;
      seen[id] = 1;
      list.push({
        id: id,
        name: it.name || id,
        price: Number(it.price) || 0,
        shop: (it.shop_name || it.shop || ""),
        url: itemUrl(it)
      });
    });
    var s = state.snaps;
    if (s && s.meta) {
      Object.keys(s.meta).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = 1;
        var m = s.meta[id];
        list.push({
          id: id, name: m.name || id, price: Number(m.price) || 0,
          shop: m.shop || "", url: m.url || "#"
        });
      });
    }
    return list;
  }

  function invFiltered() {
    var q = (state.invQuery || "").trim().toLowerCase();
    var mode = ($("invFilter") && $("invFilter").value) || "all";
    return invSource().filter(function (r) {
      if (q) {
        var hay = (r.name + " " + r.shop + " " + r.id).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (mode !== "all") {
        var iv = invOf(r.id);
        var filled = iv.hasStock || iv.hasCost;
        if (mode === "filled" && !filled) return false;
        if (mode === "empty" && filled) return false;
      }
      return true;
    });
  }

  function renderInv() {
    var box = $("invBox");
    if (!box) return;
    var all = invSource();
    if (!all.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">📦</div>' +
        '还没有商品数据，点上方「刷新数据」或稍后重试</div>';
      $("invCount").textContent = "";
      $("invPager").innerHTML = "";
      return;
    }

    var rows = invFiltered();
    var size = parseInt(($("invPageSize") && $("invPageSize").value) || "50", 10) || 50;
    var pages = Math.max(1, Math.ceil(rows.length / size));
    if (state.invPage >= pages) state.invPage = pages - 1;
    if (state.invPage < 0) state.invPage = 0;
    var start = state.invPage * size;
    var show = rows.slice(start, start + size);

    var filledCnt = 0;
    all.forEach(function (r) { var iv = invOf(r.id); if (iv.hasStock || iv.hasCost) filledCnt++; });

    $("invCount").textContent = "共 " + all.length + " 件商品　已填 " + filledCnt + " 件" +
      (rows.length !== all.length ? "　筛选后 " + rows.length + " 件" : "");

    if (!rows.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">🔍</div>没有匹配的商品</div>';
      $("invPager").innerHTML = "";
      return;
    }

    var html = '<table><thead><tr>' +
      '<th style="width:36px">#</th><th>商品</th>' +
      '<th class="num">售价</th>' +
      '<th class="num" style="width:110px">现有库存</th>' +
      '<th class="num" style="width:110px">进货成本</th>' +
      '<th class="num">单件毛利</th><th class="num">毛利率</th>' +
      '</tr></thead><tbody>';

    show.forEach(function (r, i) {
      var iv = invOf(r.id);
      var price = r.price || 0;
      var cost = iv.cost;
      var margin = (price > 0 && cost > 0) ? (price - cost) : null;
      var marginPct = (margin !== null && price > 0) ? (margin / price * 100) : null;
      var mCls = margin === null ? "flat" : (margin >= 0 ? "margin-pos" : "margin-neg");

      html += '<tr data-id="' + esc(r.id) + '" data-price="' + price + '">' +
        '<td class="flat">' + (start + i + 1) + '</td>' +
        '<td class="pname"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
          esc(r.name) + '</a>' +
          (r.shop ? '<div style="font-size:11px;color:var(--muted)">' + esc(r.shop) + '</div>' : '') +
        '</td>' +
        '<td class="num">NT$' + fmt(price) + '</td>' +
        '<td class="num"><input class="inv-input' + (iv.hasStock ? " inv-filled" : "") +
          '" type="number" min="0" step="1" data-id="' + esc(r.id) + '" data-field="stock"' +
          ' placeholder="0" value="' + (iv.hasStock ? iv.stock : "") + '"></td>' +
        '<td class="num"><input class="inv-input' + (iv.hasCost ? " inv-filled" : "") +
          '" type="number" min="0" step="0.01" data-id="' + esc(r.id) + '" data-field="cost"' +
          ' placeholder="0" value="' + (iv.hasCost ? iv.cost : "") + '"></td>' +
        '<td class="num margin-cell ' + mCls + '">' +
          (margin === null ? "—" : ("NT$" + fmt(Math.round(margin * 100) / 100))) + '</td>' +
        '<td class="num marginpct-cell ' + mCls + '">' +
          (marginPct === null ? "—" : (marginPct.toFixed(1) + "%")) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;

    renderPager(pages, rows.length, start, show.length);
  }

  function renderPager(pages, total, start, shown) {
    var el = $("invPager");
    if (!el) return;
    if (pages <= 1) { el.innerHTML = ""; return; }
    var p = state.invPage;
    var h = '<button data-p="prev"' + (p === 0 ? " disabled" : "") + '>‹ 上一页</button>';
    // 页码窗口
    var from = Math.max(0, p - 2), to = Math.min(pages - 1, from + 4);
    from = Math.max(0, Math.min(from, to - 4));
    if (from > 0) h += '<button data-p="0">1</button><span style="color:var(--muted)">…</span>';
    for (var i = from; i <= to; i++) {
      h += '<button data-p="' + i + '"' + (i === p ? ' class="on"' : "") + '>' + (i + 1) + '</button>';
    }
    if (to < pages - 1) h += '<span style="color:var(--muted)">…</span><button data-p="' + (pages - 1) + '">' + pages + '</button>';
    h += '<button data-p="next"' + (p >= pages - 1 ? " disabled" : "") + '>下一页 ›</button>';
    h += '<span style="color:var(--muted);font-size:12px;margin-left:8px">第 ' + (p + 1) + "/" + pages + ' 页</span>';
    el.innerHTML = h;
  }

  /* ---------------- 采购预测 ---------------- */

  function dailyOf(x) {
    // 优先用快照算的真实日均；不足则用月销推算
    if (x.series && x.series.length >= 2) {
      var v = (x.series[x.series.length - 1] - x.series[0]) / (x.series.length - 1);
      if (v > 0) return v;
    }
    return 0;
  }

  function calcForecast() {
    var lead = parseInt($("leadTime").value, 10) || 14;
    var safety = parseInt($("safetyDays").value, 10) || 0;
    var minQty = parseInt($("minQty").value, 10) || 0;

    var s = state.snaps;
    if (!s || !s.dates.length) {
      $("fcBox").innerHTML = '<div class="empty-hint"><div class="ico">📸</div>' +
        '请先记录至少一次快照</div>';
      $("fcStatBox").innerHTML = "";
      return;
    }

    var rows = [];
    var last = s.dates.length - 1;

    Object.keys(s.items).forEach(function (id) {
      var rec = s.items[id];
      var series = rec.sold.filter(function (v) { return v !== null && v !== undefined; });
      var m = s.meta[id] || {};

      var daily = 0;
      if (series.length >= 2) {
        daily = (series[series.length - 1] - series[0]) / (series.length - 1);
      } else {
        // 只有一天记录 → 用月销推算日均
        daily = (rec.month[last] || 0) / 30;
      }
      if (daily < 0) daily = 0;

      var iv = invOf(id);
      var stock = iv.stock;
      var price = Number(m.price) || 0;
      var cost = iv.cost;

      var need = daily * (lead + safety);
      var qty = Math.ceil(need - stock);
      if (qty < 0) qty = 0;

      var daysLeft = daily > 0 ? (stock / daily) : Infinity;

      // 采购额：优先成本价；未填成本则回退售价（会偏高，需标注）
      var unitCost = cost > 0 ? cost : price;
      var costMissing = !(cost > 0);
      var amount = qty * unitCost;

      // 单件毛利：售价 − 成本（仅当成本已知）
      var margin = cost > 0 ? (price - cost) : null;

      rows.push({
        id: id, name: m.name || id, price: price, url: m.url || "#",
        shop: m.shop || "",
        daily: daily, need: need, qty: qty,
        stock: stock, hasStock: iv.hasStock,
        cost: cost, unitCost: unitCost, costMissing: costMissing,
        daysLeft: daysLeft, amount: amount,
        margin: margin,
        marginPct: (margin !== null && price > 0) ? (margin / price * 100) : null,
        profit: margin !== null ? margin * qty : null
      });
    });

    rows = rows.filter(function (r) { return r.qty > minQty; });
    rows.sort(function (a, b) { return b.qty - a.qty; });
    state.fcRows = rows;

    // 勾选态只保留仍然存在的行
    var keep = {};
    rows.forEach(function (r) { if (state.fcSel[r.id]) keep[r.id] = true; });
    state.fcSel = keep;

    // 统计
    var totalQty = 0, totalAmt = 0, riskCnt = 0, totalProfit = 0, missingCost = 0;
    rows.forEach(function (r) {
      totalQty += r.qty;
      totalAmt += r.amount;
      if (r.daysLeft < lead) riskCnt++;
      if (r.profit !== null) totalProfit += r.profit;
      if (r.costMissing) missingCost++;
    });

    $("fcStatBox").innerHTML =
      '<div class="stat"><div class="k">建议补货商品</div>' +
        '<div class="v">' + rows.length + '</div><div class="sub">件</div></div>' +
      '<div class="stat"><div class="k">建议补货总量</div>' +
        '<div class="v">' + fmt(totalQty) + '</div><div class="sub">件</div></div>' +
      '<div class="stat"><div class="k">预估采购额</div>' +
        '<div class="v">NT$' + fmt(Math.round(totalAmt)) + '</div>' +
        '<div class="sub">' + (missingCost
          ? '其中 ' + missingCost + ' 件按售价估算'
          : '按进货成本计算') + '</div></div>' +
      '<div class="stat"><div class="k">售出后预计毛利</div>' +
        '<div class="v">NT$' + fmt(Math.round(totalProfit)) + '</div>' +
        '<div class="sub">仅统计已填成本的商品</div></div>' +
      '<div class="stat"><div class="k">断货风险</div>' +
        '<div class="v ' + (riskCnt ? "up" : "") + '">' + riskCnt + '</div>' +
        '<div class="sub">库存撑不到到货</div></div>';

    // 清单
    $("fcCount").textContent = "共 " + rows.length + " 件";
    if (!rows.length) {
      $("fcBox").innerHTML = '<div class="empty-hint"><div class="ico">✅</div>' +
        '没有需要补货的商品（或阈值设太高）</div>';
      updatePOCount();
      return;
    }

    var show = rows.slice(0, 100);
    var html = '<table><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" id="fcHeadChk"></th>' +
      '<th>商品</th>' +
      '<th class="num">日均销</th><th class="num">备货需求</th>' +
      '<th class="num">建议补货</th><th class="num">现有库存</th>' +
      '<th class="num">库存可撑</th>' +
      '<th class="num">进货成本</th><th class="num">采购金额</th>' +
      '<th class="num">单件毛利</th><th>风险</th></tr></thead><tbody>';
    show.forEach(function (r) {
      var risk = r.daysLeft < lead;
      var dl = isFinite(r.daysLeft) ? r.daysLeft.toFixed(0) + " 天" : "∞";
      var costCell = r.costMissing
        ? '<span class="flat" title="未填进货成本，按售价估算">未填</span>'
        : 'NT$' + fmt(r.cost);
      var mCls = r.margin === null ? "flat" : (r.margin >= 0 ? "margin-pos" : "margin-neg");
      var mCell = r.margin === null ? "—"
        : ('NT$' + fmt(Math.round(r.margin * 100) / 100) +
           ' <span style="font-size:11px;color:var(--muted)">(' +
           r.marginPct.toFixed(0) + '%)</span>');
      html += '<tr>' +
        '<td><input type="checkbox" class="fc-chk" data-id="' + esc(r.id) + '"' +
          (state.fcSel[r.id] ? " checked" : "") + '></td>' +
        '<td class="pname"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
          esc(r.name) + '</a></td>' +
        '<td class="num">' + r.daily.toFixed(1) + '</td>' +
        '<td class="num">' + r.need.toFixed(0) + '</td>' +
        '<td class="num up"><b>' + r.qty + '</b></td>' +
        '<td class="num">' + fmt(r.stock) + '</td>' +
        '<td class="num">' + dl + '</td>' +
        '<td class="num">' + costCell + '</td>' +
        '<td class="num">NT$' + fmt(Math.round(r.amount)) + '</td>' +
        '<td class="num ' + mCls + '">' + mCell + '</td>' +
        '<td>' + (risk ? '<span class="warn-tag">可能断货</span>'
                       : '<span class="ok-tag">安全</span>') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (rows.length > show.length) {
      html += '<div style="margin-top:10px;font-size:12px;color:var(--muted)">' +
        '仅显示前 ' + show.length + ' 件（共 ' + rows.length + ' 件）</div>';
    }
    $("fcBox").innerHTML = html;
    bindFCChk();
    updatePOCount();
    toast("已计算 " + rows.length + " 件商品的补货建议");
  }

  /* ---------------- 采购单 ---------------- */

  function bindFCChk() {
    Array.prototype.forEach.call(document.querySelectorAll(".fc-chk"), function (c) {
      c.addEventListener("change", function () {
        var id = c.getAttribute("data-id");
        if (c.checked) state.fcSel[id] = true; else delete state.fcSel[id];
        updatePOCount();
        syncHeadChk();
      });
    });
    syncHeadChk();
  }

  function syncHeadChk() {
    var head = $("fcHeadChk");
    if (!head) return;
    var all = document.querySelectorAll(".fc-chk");
    var on = document.querySelectorAll(".fc-chk:checked");
    head.checked = all.length > 0 && on.length === all.length;
    head.indeterminate = on.length > 0 && on.length < all.length;
  }

  function updatePOCount() {
    var el = $("poSelCnt");
    if (!el) return;
    var n = Object.keys(state.fcSel).length;
    el.textContent = n ? "(" + n + ")" : "";
  }

  function exportPO() {
    var picked = state.fcRows.filter(function (r) { return state.fcSel[r.id]; });
    if (!picked.length) { toast("请先勾选要采购的商品"); return; }
    var lead = parseInt($("leadTime").value, 10) || 14;
    var rows = [
      ["采购单（自动生成）", "", "", "", "", "", "", ""],
      ["生成时间", new Date().toLocaleString("zh-TW"), "", "", "", "", "", ""],
      ["备货周期(天)", lead, "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", ""],
      ["序号", "商品ID", "商品名称", "店铺", "采购数量", "进货单价(NT$)", "采购金额(NT$)", "备注"]
    ];
    var totalQty = 0, totalAmt = 0;
    picked.forEach(function (r, i) {
      totalQty += r.qty;
      totalAmt += r.amount;
      rows.push([
        i + 1, r.id, r.name, r.shop || "",
        r.qty, r.unitCost.toFixed(2), r.amount.toFixed(2),
        r.costMissing ? "⚠ 单价为售价估算" : ""
      ]);
    });
    rows.push(["", "", "", "合计", totalQty, "", totalAmt.toFixed(2), ""]);
    downloadCSV("采购单-" + stamp() + ".csv", rows);
    toast("已导出采购单（" + picked.length + " 项）");
  }

  function exportInv() {
    var list = invFiltered();
    if (!list.length) { toast("没有可导出的商品"); return; }
    var rows = [["商品ID", "商品名称", "店铺", "售价(NT$)", "现有库存", "进货成本(NT$)",
                 "单件毛利(NT$)", "毛利率", "商品链接"]];
    list.forEach(function (r) {
      var iv = invOf(r.id);
      var price = r.price || 0;
      var margin = (price > 0 && iv.cost > 0) ? (price - iv.cost) : null;
      rows.push([
        r.id, r.name, r.shop || "", price,
        iv.hasStock ? iv.stock : "", iv.hasCost ? iv.cost : "",
        margin === null ? "" : (Math.round(margin * 100) / 100),
        (margin !== null && price > 0) ? (margin / price * 100).toFixed(2) + "%" : "",
        r.url
      ]);
    });
    downloadCSV("库存成本表-" + stamp() + ".csv", rows);
    toast("已导出库存表（" + list.length + " 件）");
  }

  /* ---------------- 采购到货入库（回写库存） ---------------- */

  function receivePO() {
    var picked = state.fcRows.filter(function (r) { return state.fcSel[r.id]; });
    if (!picked.length) { toast("请先勾选要入库的商品"); return; }

    var totalQty = 0, totalAmt = 0, costWritten = 0;
    picked.forEach(function (r) { totalQty += r.qty; totalAmt += r.amount; });

    if (!confirm("确认这批采购已到货入库？\n\n" +
        "商品：" + picked.length + " 项\n" +
        "数量：" + totalQty + " 件\n" +
        "金额：NT$" + fmt(Math.round(totalAmt)) + "\n\n" +
        "入库后，这些数量会累加到各自的「现有库存」，补货建议会随之重算。")) return;

    picked.forEach(function (r) {
      var id = String(r.id);
      var iv = invOf(id);
      if (!state.inv[id]) state.inv[id] = {};
      state.inv[id].stock = (iv.stock || 0) + r.qty;
      // 只有拿到「真实成本」且用户还没填过成本时，才顺带把成本写进去
      // （按售价估算的 unitCost 是假的，不能污染成本字段）
      if (!iv.hasCost && !r.costMissing && r.unitCost > 0) {
        state.inv[id].cost = Math.round(r.unitCost * 100) / 100;
        costWritten++;
      }
    });
    saveInv();

    state.poLog.unshift({
      ts: Date.now(),
      at: new Date().toLocaleString("zh-TW"),
      count: picked.length,
      qty: totalQty,
      amount: Math.round(totalAmt * 100) / 100,
      items: picked.map(function (r) {
        return { id: r.id, name: r.name, qty: r.qty, cost: r.unitCost, missing: r.costMissing };
      })
    });
    if (state.poLog.length > MAX_PO_LOG) state.poLog = state.poLog.slice(0, MAX_PO_LOG);
    savePoLog();

    state.fcSel = {};     // 清空勾选，防止同一批货被回写两次
    calcForecast();       // 库存变了 → 重算补货建议
    renderPoLog();
    toast("已入库 " + picked.length + " 项 / " + totalQty + " 件" +
      (costWritten ? "，并写入 " + costWritten + " 条成本" : ""));
  }

  function renderPoLog() {
    var box = $("poLogBox");
    var cnt = $("poLogCnt");
    if (!box) return;
    var list = state.poLog;
    if (cnt) cnt.textContent = list.length ? "最近 " + list.length + " 批" : "";
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">📥</div>' +
        '还没有入库记录。勾选补货清单里的商品，点「到货入库」即可。</div>';
      return;
    }
    var html = '<table><thead><tr>' +
      '<th>入库时间</th><th class="num">项数</th><th class="num">数量</th>' +
      '<th class="num">金额</th><th>包含商品</th></tr></thead><tbody>';
    list.forEach(function (g) {
      var names = g.items.slice(0, 3).map(function (x) { return x.name; }).join("、");
      if (g.items.length > 3) names += " 等 " + g.items.length + " 项";
      html += '<tr>' +
        '<td>' + esc(g.at) + '</td>' +
        '<td class="num">' + g.count + '</td>' +
        '<td class="num up">' + fmt(g.qty) + '</td>' +
        '<td class="num">NT$' + fmt(Math.round(g.amount)) + '</td>' +
        '<td class="pname" title="' + esc(names) + '">' + esc(names) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  /* ---------------- 本机数据备份 / 还原 ---------------- */

  function backupMsg(html) {
    var el = $("backupMsg");
    if (el) el.innerHTML = html;
  }

  function exportBackup() {
    var s = state.snaps || loadSnaps();
    var data = {
      app: "shopee-erp",
      kind: "backup",
      schema: 1,
      exportedAt: new Date().toISOString(),
      counts: {
        snapDates: s.dates.length,
        items: Object.keys(s.items).length,
        inv: Object.keys(state.inv).length,
        poLog: state.poLog.length
      },
      track: s,
      inv: state.inv,
      prefs: state.prefs,
      poLog: state.poLog
    };
    var blob = new Blob([JSON.stringify(data, null, 2)],
      { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "虾皮ERP备份-" + stamp() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);

    backupMsg("✅ 已导出：" + s.dates.length + " 天快照 / " +
      Object.keys(s.items).length + " 件商品 / " +
      Object.keys(state.inv).length + " 条库存成本");
    toast("备份已导出");
  }

  function importBackup(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      var d;
      try { d = JSON.parse(String(fr.result)); }
      catch (e) {
        backupMsg("❌ 不是有效的 JSON 文件，请确认选的是本页导出的备份");
        toast("还原失败：文件格式错误");
        return;
      }
      if (!d || d.app !== "shopee-erp" || !d.track || !d.track.dates ||
          !d.track.items || !d.track.meta) {
        backupMsg("❌ 这不是本 ERP 的备份文件（缺少标识字段）");
        toast("还原失败：文件不匹配");
        return;
      }

      var dates = d.track.dates.length;
      var invN = d.inv ? Object.keys(d.inv).length : 0;
      var logN = Array.isArray(d.poLog) ? d.poLog.length : 0;
      if (!confirm("即将从备份还原：\n\n" +
          "快照：" + dates + " 天\n" +
          "库存成本：" + invN + " 条\n" +
          "入库记录：" + logN + " 批\n" +
          (d.exportedAt ? "\n备份时间：" + new Date(d.exportedAt).toLocaleString("zh-TW") : "") +
          "\n\n⚠️ 会覆盖当前本机的快照与库存数据，且不可撤销。")) return;

      try {
        localStorage.setItem(LS_KEY, JSON.stringify(d.track));
        localStorage.setItem(INV_KEY, JSON.stringify(d.inv || {}));
        localStorage.setItem(PO_LOG_KEY, JSON.stringify(Array.isArray(d.poLog) ? d.poLog : []));
        if (d.prefs && typeof d.prefs === "object") {
          localStorage.setItem(PREFS_KEY, JSON.stringify(d.prefs));
        }
      } catch (e) {
        backupMsg("❌ 写入失败：浏览器存储空间不足，原有数据未改动");
        toast("还原失败");
        return;
      }

      // 就地重载内存态并重绘，避免整页刷新再拉一次 catalog
      state.snaps = loadSnaps();
      state.inv = loadInv();
      state.prefs = loadPrefs();
      state.poLog = loadPoLog();
      state.invPage = 0;
      state.invQuery = "";
      state.fcSel = {};
      var se = $("invSearch"); if (se) se.value = "";
      var ac = $("autoSnap"); if (ac) ac.checked = !!state.prefs.autoSnap;

      renderAll();
      renderInv();
      renderPoLog();
      var fc = $("fcBox");
      if (fc) fc.innerHTML = '<div class="empty-hint"><div class="ico">🧮</div>' +
        '数据已更新，请重新点「计算补货建议」</div>';
      $("fcStatBox").innerHTML = "";
      $("fcCount").textContent = "";

      backupMsg("✅ 已还原：" + dates + " 天快照 / " + invN + " 条库存成本" +
        (logN ? " / " + logN + " 批入库记录" : ""));
      toast("备份已还原");
    };
    fr.onerror = function () {
      backupMsg("❌ 读取文件失败，请重试");
      toast("还原失败：无法读取文件");
    };
    fr.readAsText(file);
  }

  /* ---------------- 库存表交互 ---------------- */

  function onInvInput(e) {
    var inp = e.target;
    if (!inp || !inp.classList || !inp.classList.contains("inv-input")) return;
    var id = inp.getAttribute("data-id");
    var field = inp.getAttribute("data-field");
    setInvField(id, field, inp.value);
    saveInv();
    var v = inp.value === "" ? 0 : Number(inp.value);
    inp.classList.toggle("inv-filled", !isNaN(v) && v > 0);

    // 就地刷新本行毛利，避免整表重绘导致输入框失焦
    var tr = inp.parentNode;
    while (tr && tr.tagName !== "TR") tr = tr.parentNode;
    if (!tr) return;
    var price = Number(tr.getAttribute("data-price")) || 0;
    var costInp = tr.querySelector('[data-field="cost"]');
    var cost = costInp && costInp.value !== "" ? Number(costInp.value) : 0;
    if (isNaN(cost)) cost = 0;
    var margin = (price > 0 && cost > 0) ? (price - cost) : null;
    var cls = margin === null ? "flat" : (margin >= 0 ? "margin-pos" : "margin-neg");
    var mc = tr.querySelector(".margin-cell");
    var pc = tr.querySelector(".marginpct-cell");
    if (mc) {
      mc.className = "num margin-cell " + cls;
      mc.textContent = margin === null ? "—" : ("NT$" + fmt(Math.round(margin * 100) / 100));
    }
    if (pc) {
      pc.className = "num marginpct-cell " + cls;
      pc.textContent = (margin === null || price <= 0)
        ? "—" : ((margin / price * 100).toFixed(1) + "%");
    }
  }

  function onPagerClick(e) {
    var b = e.target;
    while (b && b.tagName !== "BUTTON") b = b.parentNode;
    if (!b || !b.getAttribute) return;
    var p = b.getAttribute("data-p");
    if (p === null) return;
    if (p === "prev") state.invPage -= 1;
    else if (p === "next") state.invPage += 1;
    else state.invPage = parseInt(p, 10) || 0;
    renderInv();
    var box = $("invBox");
    if (box && box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // 进阶区「采购与库存」改为默认收起的折叠块（非选品功能）。
    // 原来靠点击「采购预测」标签触发 renderInv()；现在改为展开折叠时再渲染，
    // 避免用户没展开就白算一遍库存表。
    var foldErp = $("tab-forecast");
    if (foldErp) {
      foldErp.addEventListener("toggle", function () {
        if (foldErp.open) renderInv();
      });
    }

    $("btnSnap").addEventListener("click", function () {
      if (!state.items.length) { loadSource(afterLoad); return; }
      takeSnapshot();
    });

    $("btnReload").addEventListener("click", function () {
      $("snapMsg").textContent = "正在加载商品数据…";
      loadSource(afterLoad);
    });

    $("btnClear").addEventListener("click", function () {
      if (!confirm("确定清空所有快照记录？此操作不可恢复。")) return;
      localStorage.removeItem(LS_KEY);
      state.snaps = loadSnaps();
      state.deltas = [];
      renderAll();
      $("fcBox").innerHTML = '<div class="empty-hint"><div class="ico">🧮</div>点上方「计算补货建议」开始</div>';
      $("fcStatBox").innerHTML = "";
      toast("快照已清空");
    });

    $("baseSel").addEventListener("change", renderAll);
    $("btnCalc").addEventListener("click", calcForecast);

    // ---- 库存与成本 ----
    var searchTimer = null;
    $("invSearch").addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      var v = e.target.value;
      searchTimer = setTimeout(function () {
        state.invQuery = v;
        state.invPage = 0;
        renderInv();
      }, 180);
    });
    $("invPageSize").addEventListener("change", function () {
      state.invPage = 0;
      renderInv();
    });
    $("invFilter").addEventListener("change", function () {
      state.invPage = 0;
      renderInv();
    });
    $("invBox").addEventListener("input", onInvInput);
    $("invPager").addEventListener("click", onPagerClick);
    $("btnInvExport").addEventListener("click", exportInv);

    // ---- 采购单 ----
    $("btnCheckAll").addEventListener("click", function () {
      state.fcRows.forEach(function (r) { state.fcSel[r.id] = true; });
      calcForecast();
    });
    $("btnUncheckAll").addEventListener("click", function () {
      state.fcSel = {};
      calcForecast();
    });
    $("btnPoExport").addEventListener("click", exportPO);
    $("btnPoReceive").addEventListener("click", receivePO);

    // ---- 偏好：自动记录 ----
    $("autoSnap").addEventListener("change", function (e) {
      state.prefs.autoSnap = !!e.target.checked;
      savePrefs();
      toast(state.prefs.autoSnap ? "已开启：每天首次打开自动记录" : "已关闭自动记录");
    });

    // ---- 备份 / 还原 ----
    $("btnBackup").addEventListener("click", exportBackup);
    $("btnRestore").addEventListener("click", function () { $("restoreFile").click(); });
    $("restoreFile").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      importBackup(f);
      e.target.value = "";   // 允许重复选同一个文件
    });

    // 表头全选
    document.addEventListener("change", function (e) {
      if (e.target && e.target.id === "fcHeadChk") {
        var on = e.target.checked;
        Array.prototype.forEach.call(document.querySelectorAll(".fc-chk"), function (c) {
          c.checked = on;
          var id = c.getAttribute("data-id");
          if (on) state.fcSel[id] = true; else delete state.fcSel[id];
        });
        updatePOCount();
      }
    });
  }

  function afterLoad(err, items, srcUrl) {
    if (err) {
      $("snapMsg").innerHTML = "⚠️ 商品数据加载失败：" + esc(err.message) +
        "<br><span style='font-size:12px'>请检查 data/source.json 的 catalog_url，或稍后重试。</span>";
      var box = $("invBox");
      if (box) box.innerHTML = '<div class="empty-hint"><div class="ico">⚠️</div>' +
        '商品数据加载失败，库存表暂不可用</div>';
      return;
    }
    state.items = normCatalog({ items: items || [] });
    state.loaded = true;
    state.snaps = loadSnaps();
    state.srcUrl = srcUrl || "";
    var host = (srcUrl || "").replace(/^https:\/\//, "").split("/")[0];
    // 数据源信息存起来，交给 renderSnapInfo() 统一渲染，
    // 否则会被随后的快照状态文案覆盖掉（这行是用户确认「有没有同步上」的关键信息）
    state.srcMsg = "已加载 " + state.items.length + " 件商品" +
      (host ? "（数据源：" + host + "）" : "");
    renderAll();
    autoSnapshot();     // 每天首次打开自动补一次快照（已在今天记过则跳过）
  }

  /* ---------------- 启动 ---------------- */

  state.snaps = loadSnaps();
  state.inv = loadInv();
  state.prefs = loadPrefs();
  state.poLog = loadPoLog();
  bind();
  var ac0 = $("autoSnap");
  if (ac0) ac0.checked = !!state.prefs.autoSnap;
  renderAll();
  renderPoLog();
  loadSource(afterLoad);
})();
