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
  var MAX_DAYS = 90;          // 最多保留 90 天快照
  var WARN_DAYS = 3;          // 连续 N 天零增长 → 滞销预警

  var state = {
    items: [],       // 当前 catalog
    snaps: null,     // 快照对象
    loaded: false,
    deltas: []       // 最近一次计算的日增列表
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

  /* ---------------- 数据加载 ---------------- */

  function loadSource(cb) {
    fetch("data/source.json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        var url = cfg.catalog_url;
        if (!url) { cb(new Error("source.json 缺少 catalog_url")); return; }
        fetch(url, { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var items = d.items || (Array.isArray(d) ? d : []);
            cb(null, items);
          })
          .catch(cb);
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

  function takeSnapshot() {
    if (!state.items.length) { toast("还没有商品数据"); return; }

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
      });
    }

    state.items.forEach(function (it) {
      var id = String(it.id);
      if (!s.items[id]) s.items[id] = { sold: [], month: [] };
      while (s.items[id].sold.length < idx) s.items[id].sold.push(null);
      while (s.items[id].month.length < idx) s.items[id].month.push(null);
      s.items[id].sold[idx] = soldOf(it);
      s.items[id].month[idx] = monthOf(it);
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
      });
    }

    state.snaps = s;
    saveSnaps(s);
    toast("已记录今日快照（" + state.items.length + " 件商品）");
    renderAll();
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
      } else {
        msg += "　⏳ 今天还没记录";
      }
    } else {
      msg = "点「记录今日快照」开始积累数据。建议每天固定时间记一次。";
    }
    $("snapMsg").textContent = msg;

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
    var stock = parseInt($("stockNow").value, 10) || 0;
    var minQty = parseInt($("minQty").value, 10) || 0;

    var s = state.snaps;
    if (!s || !s.dates.length) {
      $("fcBox").innerHTML = '<div class="empty-hint"><div class="ico">📸</div>' +
        '请先记录至少一次快照</div>';
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

      var need = daily * (lead + safety);
      var qty = Math.ceil(need - stock);
      if (qty < 0) qty = 0;

      var daysLeft = daily > 0 ? (stock / daily) : Infinity;

      rows.push({
        id: id, name: m.name || id, price: m.price || 0, url: m.url || "#",
        daily: daily, need: need, qty: qty,
        stock: stock,
        daysLeft: daysLeft,
        amount: qty * (m.price || 0)
      });
    });

    rows = rows.filter(function (r) { return r.qty > minQty; });
    rows.sort(function (a, b) { return b.qty - a.qty; });

    // 统计
    var totalQty = 0, totalAmt = 0, riskCnt = 0;
    rows.forEach(function (r) {
      totalQty += r.qty;
      totalAmt += r.amount;
      if (r.daysLeft < lead) riskCnt++;
    });

    $("fcStatBox").innerHTML =
      '<div class="stat"><div class="k">建议补货商品</div>' +
        '<div class="v">' + rows.length + '</div><div class="sub">件</div></div>' +
      '<div class="stat"><div class="k">建议补货总量</div>' +
        '<div class="v">' + fmt(totalQty) + '</div><div class="sub">件</div></div>' +
      '<div class="stat"><div class="k">预估采购额</div>' +
        '<div class="v">NT$' + fmt(Math.round(totalAmt)) + '</div>' +
        '<div class="sub">按当前单价估算</div></div>' +
      '<div class="stat"><div class="k">断货风险</div>' +
        '<div class="v ' + (riskCnt ? "up" : "") + '">' + riskCnt + '</div>' +
        '<div class="sub">库存撑不到到货</div></div>';

    // 清单
    $("fcCount").textContent = "共 " + rows.length + " 件";
    if (!rows.length) {
      $("fcBox").innerHTML = '<div class="empty-hint"><div class="ico">✅</div>' +
        '没有需要补货的商品（或阈值设太高）</div>';
      return;
    }

    var show = rows.slice(0, 80);
    var html = '<table><thead><tr><th>商品</th>' +
      '<th class="num">日均销</th><th class="num">备货需求</th>' +
      '<th class="num">建议补货</th><th class="num">库存可撑</th>' +
      '<th class="num">预估金额</th><th>风险</th></tr></thead><tbody>';
    show.forEach(function (r) {
      var risk = r.daysLeft < lead;
      var dl = isFinite(r.daysLeft) ? r.daysLeft.toFixed(0) + " 天" : "∞";
      html += '<tr>' +
        '<td class="pname"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
          esc(r.name) + '</a></td>' +
        '<td class="num">' + r.daily.toFixed(1) + '</td>' +
        '<td class="num">' + r.need.toFixed(0) + '</td>' +
        '<td class="num up"><b>' + r.qty + '</b></td>' +
        '<td class="num">' + dl + '</td>' +
        '<td class="num">NT$' + fmt(Math.round(r.amount)) + '</td>' +
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
    toast("已计算 " + rows.length + " 件商品的补货建议");
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // Tab 切换
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) {
          x.classList.remove("active");
        });
        b.classList.add("active");
        var t = b.getAttribute("data-tab");
        $("tab-track").classList.toggle("hidden", t !== "track");
        $("tab-forecast").classList.toggle("hidden", t !== "forecast");
      });
    });

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
  }

  function afterLoad(err, items) {
    if (err) {
      $("snapMsg").textContent = "⚠️ 商品数据加载失败：" + err.message;
      return;
    }
    state.items = items || [];
    state.loaded = true;
    state.snaps = loadSnaps();
    $("snapMsg").textContent = "已加载 " + state.items.length + " 件商品";
    renderAll();
  }

  /* ---------------- 启动 ---------------- */

  state.snaps = loadSnaps();
  bind();
  renderAll();
  loadSource(afterLoad);
})();
