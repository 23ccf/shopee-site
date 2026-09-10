/* 选品洞察：综合打分 / 跨店比价 / 价格趋势
 * 数据来源：source.json 指向的 catalog（与选品库同源）+ 本机快照 localStorage
 * 快照复用销售追踪的 key（shopee_track_v1），价格序列字段为 items[id].price[]
 * 所有数据只在本机处理，不上传任何服务器
 */
(function () {
  "use strict";

  var LS_KEY = "shopee_track_v1";
  var MAX_DAYS = 90;

  var state = {
    items: [],
    snaps: null,
    scored: [],
    groups: [],
    pickedId: null
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
  function priceOf(it) { return Number(it.price) || 0; }

  function itemUrl(it) {
    if (it.url) return it.url;
    var id = String(it.id || "");
    if (id.indexOf("_") > 0) {
      var p = id.split("_");
      return "https://shopee.tw/product/" + p[0] + "/" + p[1];
    }
    return "#";
  }

  function shopOf(it) { return it.shop || it.shop_name || "—"; }

  /* ---------------- 字段归一化 ----------------
   * 线上 catalog 的 item 只有 shopid / itemid，**没有 id 和 url**。
   * 不归一化会让全部商品塌缩成 id "undefined"。口径与主站 app.js 保持一致。 */
  function normPrice(v) {
    var n = Number(v) || 0;
    for (var i = 0; i < 2 && n > 1000000; i++) n = n / 100000;
    return n;
  }

  /* ★ 月销门槛（与首页 index.html 口径统一）：只对「月销 ≥ 30」的商品做打分 / 比价 / 趋势。
     月销 < 30 的低动销长尾不再参与分析，避免把一堆零销量商品算进排行榜。
     唯一例外：月销 = 0（虾皮隐藏文案）但累计总销 ≥ 200（疑似真实爆款）仍纳入。 */
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
      if (it.rating == null) it.rating = 0;
      if (it.reviews == null) it.reviews = 0;
      it._n = 1;
    }
    return items;
  }

  /* ---------------- 数据加载（多源回退） ---------------- */

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

  function toJsDelivr(url) {
    var m = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/.exec(url || "");
    if (!m) return null;
    return "https://cdn.jsdelivr.net/gh/" + m[1] + "/" + m[2] + "@" + m[3] + "/" + m[4];
  }

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

        var i = 0, errors = [];
        function next() {
          if (i >= urls.length) { cb(new Error("全部数据源均失败：" + errors.join(" / "))); return; }
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
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); return true; }
    catch (e) { toast("存储空间不足，请先清理旧快照"); return false; }
  }

  // 只写价格（不影响销售追踪的 sold/month 序列，缺失处补 null）
  function recordPriceToday(silent) {
    if (!state.items.length) return false;
    var s = state.snaps || loadSnaps();
    var tk = todayKey();
    var idx = s.dates.indexOf(tk);

    if (idx < 0) {
      s.dates.push(tk);
      idx = s.dates.length - 1;
      Object.keys(s.items).forEach(function (id) {
        while (s.items[id].sold.length < s.dates.length) s.items[id].sold.push(null);
        while (s.items[id].month.length < s.dates.length) s.items[id].month.push(null);
        if (s.items[id].price) {
          while (s.items[id].price.length < s.dates.length) s.items[id].price.push(null);
        }
      });
    }

    var changed = false;
    state.items.forEach(function (it) {
      var id = String(it.id);
      if (!s.items[id]) s.items[id] = { sold: [], month: [], price: [] };
      if (!s.items[id].price) s.items[id].price = [];
      while (s.items[id].price.length < idx) s.items[id].price.push(null);
      var p = priceOf(it);
      if (p > 0 && s.items[id].price[idx] !== p) { s.items[id].price[idx] = p; changed = true; }
      s.meta[id] = {
        name: s.meta[id] && s.meta[id].name ? s.meta[id].name : (it.name || ""),
        price: p || (s.meta[id] && s.meta[id].price) || 0,
        url: itemUrl(it),
        shop: shopOf(it)
      };
    });

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
    if (!silent) toast(changed ? "已记录今日价格" : "今日价格已记录（无变化）");
    return changed;
  }

  /* ---------------- 选品打分 ---------------- */

  function logNorm(v, max) {
    v = Math.max(0, v || 0);
    if (v <= 0) return 0;
    return Math.min(100, (Math.log10(1 + v) / Math.log10(1 + Math.max(max, 1))) * 100);
  }

  // 近期日均 / 月均日均 → 增长系数（无快照时返回 null 表示中性）
  function growthRatio(id) {
    var s = state.snaps;
    if (!s || !s.items[id] || !s.items[id].sold) return null;
    var arr = s.items[id].sold.filter(function (v) { return v !== null && v !== undefined; });
    if (arr.length < 2) return null;
    var daily = (arr[arr.length - 1] - arr[0]) / (arr.length - 1);
    var mArr = (s.items[id].month || []).filter(function (v) { return v !== null && v !== undefined; });
    var monthDaily = mArr.length ? (mArr[mArr.length - 1] / 30) : 0;
    if (monthDaily <= 0) return null;
    return daily / monthDaily;
  }

  function computeScores() {
    var items = state.items;
    if (!items.length) return [];

    // 先做一次同款聚类，供「竞争度」使用（阈值固定 0.6，避免与比价页互相影响）
    var simMap = buildSimMap(0.6);

    var w = {
      sold: parseInt($("w1").value, 10) || 0,
      grow: parseInt($("w2").value, 10) || 0,
      rep: parseInt($("w3").value, 10) || 0,
      price: parseInt($("w4").value, 10) || 0,
      comp: parseInt($("w5").value, 10) || 0
    };
    var wSum = w.sold + w.grow + w.rep + w.price + w.comp;
    if (wSum <= 0) { w = { sold: 35, grow: 25, rep: 20, price: 10, comp: 10 }; wSum = 100; }

    // rating / reviews 从未被采集 → 口碑分恒为 0，20% 的权重等于白给，
    // 你拖动「口碑权重」滑块会完全看不到变化。检测到时把这部分权重并入销量，
    // 并在统计条上写明，不假装算过了。
    state.noRepData = !state.items.some(function (it) {
      return (Number(it.rating) || 0) > 0 || (Number(it.reviews) || 0) > 0;
    });
    if (state.noRepData && w.rep > 0) { w.sold += w.rep; w.rep = 0; }

    var sweet = Number($("sweetPrice").value) || 399;

    var maxMonth = 1, maxRev = 1, maxSold = 1;
    items.forEach(function (it) {
      maxMonth = Math.max(maxMonth, monthOf(it));
      maxRev = Math.max(maxRev, Number(it.reviews) || 0);
      maxSold = Math.max(maxSold, soldOf(it));
    });

    var out = items.map(function (it) {
      var id = String(it.id);
      var p = priceOf(it);
      var month = monthOf(it);
      var rating = Number(it.rating) || 0;
      var reviews = Number(it.reviews) || 0;

      // 1) 月销分
      var sSold = logNorm(month, maxMonth);

      // 2) 增长分：ratio 1.0 → 50 分，2.0 → 100，0 → 0；无数据 → 50
      var g = growthRatio(id);
      var sGrow = (g === null) ? 50 : Math.max(0, Math.min(100, g * 50));

      // 3) 口碑分
      var sRep = (rating / 5) * 60 + logNorm(reviews, maxRev) * 0.4;
      sRep = Math.max(0, Math.min(100, sRep));

      // 4) 价格带分：越接近甜区越高（对数距离衰减）
      var sPrice = 0;
      if (p > 0) {
        var dist = Math.abs(Math.log(p / sweet));       // 0 表示正好在甜区
        sPrice = Math.max(0, 100 - dist * 55);
      }

      // 5) 竞争度分：同款越少越好
      var peer = (simMap[id] || []).length;              // 含自己
      var sComp = Math.max(0, 100 - (peer - 1) * 12);

      var total = (sSold * w.sold + sGrow * w.grow + sRep * w.rep +
                   sPrice * w.price + sComp * w.comp) / wSum;

      return {
        id: id, name: it.name || id, price: p, month: month, sold: soldOf(it),
        rating: rating, reviews: reviews, shop: shopOf(it), loc: it.loc || "",
        url: itemUrl(it), img: it.img || "",
        grow: g, peers: peer,
        parts: { sold: sSold, grow: sGrow, rep: sRep, price: sPrice, comp: sComp },
        score: Math.round(total * 10) / 10
      };
    });

    out.sort(function (a, b) { return b.score - a.score; });
    out.forEach(function (x) {
      x.grade = x.score >= 85 ? "S" : x.score >= 70 ? "A" : x.score >= 55 ? "B" : "C";
    });
    return out;
  }

  function renderScores() {
    var box = $("scoreBox");
    var g = $("gradeFilter").value;
    var pMin = Number($("pMin").value) || 0;
    var pMax = Number($("pMax").value) || Infinity;
    var mMin = Number($("mMin").value) || 0;

    var list = state.scored.filter(function (x) {
      if (g && x.grade !== g) return false;
      if (x.price < pMin || x.price > pMax) return false;
      if (x.month < mMin) return false;
      return true;
    });

    // 统计（基于全量）
    var c = { S: 0, A: 0, B: 0, C: 0 };
    state.scored.forEach(function (x) { c[x.grade]++; });
    var avg = state.scored.length
      ? state.scored.reduce(function (a, x) { return a + x.score; }, 0) / state.scored.length : 0;
    var top = state.scored[0];

    $("scoreStatBox").innerHTML =
      '<div class="stat"><div class="k">参评商品</div><div class="v">' +
        fmt(state.scored.length) + '</div><div class="sub">件</div></div>' +
      '<div class="stat"><div class="k">平均分</div><div class="v">' +
        avg.toFixed(1) + '</div><div class="sub">满分 100</div></div>' +
      '<div class="stat"><div class="k">S + A 档</div><div class="v up">' +
        (c.S + c.A) + '</div><div class="sub">S ' + c.S + ' / A ' + c.A + '</div></div>' +
      '<div class="stat"><div class="k">B / C 档</div><div class="v flat">' +
        (c.B + c.C) + '</div><div class="sub">B ' + c.B + ' / C ' + c.C + '</div></div>' +
      (state.noRepData ? '<div class="stat"><div class="k">口碑权重</div><div class="v flat">已并入销量</div><div class="sub">未采集评分数据</div></div>' : '') +
      '<div class="stat"><div class="k">最高分商品</div>' +
        '<div class="v up" style="font-size:15px;line-height:1.4">' +
        esc(String(top ? top.name : "—").slice(0, 16)) + '</div>' +
        '<div class="sub">' + (top ? top.score + " 分 · " + top.grade + " 档" : "—") + '</div></div>';

    $("scoreCount").textContent = "共 " + list.length + " 件";
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">🔎</div>没有符合条件的商品</div>';
      return;
    }

    var show = list.slice(0, 100);
    var html = '<table><thead><tr>' +
      '<th style="width:40px">档</th><th style="width:110px">综合分</th><th>商品</th>' +
      '<th class="num">月销</th><th class="num">累计</th>' +
      '<th class="num">评分</th><th class="num">评价</th>' +
      '<th class="num">价格</th><th class="num">同款数</th><th class="num">增长</th>' +
      '</tr></thead><tbody>';
    show.forEach(function (x) {
      var gt = x.grow === null ? '<span class="flat">—</span>'
        : (x.grow >= 1 ? '<span class="up">×' + x.grow.toFixed(2) + '</span>'
                       : '<span class="down">×' + x.grow.toFixed(2) + '</span>');
      var pct = Math.max(0, Math.min(100, x.score));
      html += '<tr>' +
        '<td><span class="grade g-' + x.grade + '">' + x.grade + '</span></td>' +
        '<td><span class="scorebar"><i style="width:' + pct + '%"></i></span>' +
          '<b>' + x.score.toFixed(1) + '</b></td>' +
        '<td class="pname"><a href="' + esc(x.url) + '" target="_blank" rel="noopener" ' +
          'title="' + esc(x.name) + '">' + esc(x.name) + '</a>' +
          (x.shop && x.shop !== "—" ? '<div style="font-size:11px;color:var(--muted)">' +
            esc(x.shop) + '</div>' : '') + '</td>' +
        '<td class="num">' + fmt(x.month) + '</td>' +
        '<td class="num flat">' + fmt(x.sold) + '</td>' +
        '<td class="num">' + (x.rating ? x.rating.toFixed(1) : "—") + '</td>' +
        '<td class="num flat">' + fmt(x.reviews) + '</td>' +
        '<td class="num">NT$' + fmt(x.price) + '</td>' +
        '<td class="num ' + (x.peers > 3 ? "down" : "") + '">' + x.peers + '</td>' +
        '<td class="num">' + gt + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    if (list.length > show.length) {
      html += '<div style="margin-top:10px;font-size:12px;color:var(--muted)">' +
        '仅显示前 ' + show.length + ' 件（共 ' + list.length + ' 件）</div>';
    }
    box.innerHTML = html;
  }

  /* ---------------- 跨店比较（同款聚类） ---------------- */

  // 名称 → 词碎片集合（中文 2-gram + 英文单词 + 数字串）
  var STOP = /^(尺寸|現貨|现货|新品|包郵|包邮|免運|免运|台灣|台湾|台|正品|官方|旗艦|旗舰|店|優質|优质|熱賣|热卖|限量|促銷|促销|組合|组合|款|個|个|件|組|组|入|商品|快速出貨|快速出货|現貨供應)$/;

  function tokenize(name) {
    var s = String(name || "").toLowerCase();
    s = s.replace(/[()（）\[\]【】{}<>《》"'“”‘’·・,，。.!！?？:：;；\-_/\\|~～*#@&+%]/g, " ");
    var set = {};
    // 英文/数字单词
    var words = s.match(/[a-z0-9]{2,}/g) || [];
    words.forEach(function (w) { if (!STOP.test(w)) set[w] = 1; });
    // 中文：去空格后取 2-gram
    var han = s.replace(/[a-z0-9 ]/g, "");
    for (var i = 0; i + 2 <= han.length; i++) {
      var g = han.substr(i, 2);
      if (!STOP.test(g)) set[g] = 1;
    }
    return set;
  }

  // 建立「同款映射」：id → [同组 id 数组]（倒排索引减少比较次数）
  function buildSimMap(threshold) {
    var items = state.items;
    var toks = items.map(function (it) { return tokenize(it.name); });
    var keys = [];
    toks.forEach(function (t) { keys.push(Object.keys(t)); });

    // 倒排：term → item 下标
    var inv = {};
    keys.forEach(function (ks, i) {
      ks.forEach(function (k) { (inv[k] = inv[k] || []).push(i); });
    });

    var n = items.length;
    var parent = new Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    // 只在共享 term 的候选对之间比较
    var seen = {};
    for (var t in inv) {
      var arr = inv[t];
      if (arr.length < 2 || arr.length > 120) continue;   // 跳过过于常见的词
      for (var a = 0; a < arr.length; a++) {
        for (var b = a + 1; b < arr.length; b++) {
          var ia = arr[a], ib = arr[b];
          if (ia > ib) { var tmp = ia; ia = ib; ib = tmp; }
          var pk = ia + ":" + ib;
          if (seen[pk]) continue;
          seen[pk] = 1;
          var ka = keys[ia], kb = keys[ib];
          var inter = 0;
          for (var q = 0; q < ka.length; q++) if (toks[ib][ka[q]]) inter++;
          var uni = ka.length + kb.length - inter;
          if (!uni) continue;
          if (inter / uni >= threshold) union(ia, ib);
        }
      }
    }

    var buckets = {};
    for (var i2 = 0; i2 < n; i2++) {
      var r = find(i2);
      (buckets[r] = buckets[r] || []).push(i2);
    }
    var map = {};
    for (var r2 in buckets) {
      var ids = buckets[r2].map(function (i3) { return String(items[i3].id); });
      ids.forEach(function (id) { map[id] = ids; });
    }
    return map;
  }

  function runCompare() {
    var th = (parseInt($("simTh").value, 10) || 55) / 100;
    var minShops = parseInt($("minShops").value, 10) || 2;

    var map = buildSimMap(th);
    var done = {};
    var groups = [];
    Object.keys(map).forEach(function (id) {
      var ids = map[id];
      if (ids.length < 2) return;
      var key = ids.slice().sort().join("|");
      if (done[key]) return;
      done[key] = 1;

      var byId = {};
      state.items.forEach(function (it) { byId[String(it.id)] = it; });
      var list = ids.map(function (x) { return byId[x]; })
                    .filter(function (it) { return !!it && priceOf(it) > 0; });
      if (list.length < 2) return;

      // 同一店铺重复上架算多家店没意义 → 按店铺去重，保留最低价
      var byShop = {};
      list.forEach(function (it) {
        var k = shopOf(it) + "|" + (String(it.id).split("_")[0] || "");
        if (!byShop[k] || priceOf(it) < priceOf(byShop[k])) byShop[k] = it;
      });
      var shops = Object.keys(byShop).map(function (k) { return byShop[k]; });
      if (shops.length < minShops) return;

      shops.sort(function (a, b) { return priceOf(a) - priceOf(b); });
      var lo = priceOf(shops[0]), hi = priceOf(shops[shops.length - 1]);
      var totalMonth = shops.reduce(function (a, it) { return a + monthOf(it); }, 0);

      groups.push({
        name: shops[0].name || "",
        shops: shops.map(function (it) {
          return {
            id: String(it.id), name: it.name || "", shop: shopOf(it),
            price: priceOf(it), month: monthOf(it), sold: soldOf(it),
            rating: Number(it.rating) || 0, loc: it.loc || "", url: itemUrl(it)
          };
        }),
        lo: lo, hi: hi, spread: hi - lo,
        rate: lo > 0 ? (hi - lo) / lo : 0,
        totalMonth: totalMonth
      });
    });

    var sortBy = $("cmpSort").value;
    groups.sort(function (a, b) {
      if (sortBy === "rate") return b.rate - a.rate;
      if (sortBy === "shops") return b.shops.length - a.shops.length;
      if (sortBy === "sold") return b.totalMonth - a.totalMonth;
      return b.spread - a.spread;
    });

    state.groups = groups;
    renderCompare();
  }

  function renderCompare() {
    var g = state.groups;
    var box = $("cmpBox");

    var totalSpread = g.reduce(function (a, x) { return a + x.spread; }, 0);
    var maxRate = g.length ? Math.max.apply(null, g.map(function (x) { return x.rate; })) : 0;
    var shopSet = {};
    g.forEach(function (x) { x.shops.forEach(function (s) { shopSet[s.shop] = 1; }); });

    $("cmpStatBox").innerHTML =
      '<div class="stat"><div class="k">同款分组</div><div class="v">' + fmt(g.length) +
        '</div><div class="sub">组</div></div>' +
      '<div class="stat"><div class="k">涉及店铺</div><div class="v">' +
        fmt(Object.keys(shopSet).length) + '</div><div class="sub">家</div></div>' +
      '<div class="stat"><div class="k">累计价差</div><div class="v">NT$' +
        fmt(Math.round(totalSpread)) + '</div><div class="sub">各组最低↔最高合计</div></div>' +
      '<div class="stat"><div class="k">最大溢价率</div><div class="v up">' +
        (maxRate * 100).toFixed(0) + '%</div><div class="sub">最高价 vs 最低价</div></div>';

    $("cmpCount").textContent = "共 " + g.length + " 组";
    if (!g.length) {
      box.innerHTML = '<div class="empty-hint"><div class="ico">🤷</div>' +
        '没有识别到同款商品，可把相似度阈值调低一些</div>';
      return;
    }

    var show = g.slice(0, 30);
    var html = "";
    show.forEach(function (grp, gi) {
      html += '<div class="group">' +
        '<div class="group-hd">' +
          '<span class="gname">' + (gi + 1) + '. ' + esc(String(grp.name).slice(0, 46)) + '</span>' +
          '<span class="ok-tag">' + grp.shops.length + ' 家店</span>' +
          '<span>最低 <b>NT$' + fmt(grp.lo) + '</b></span>' +
          '<span>最高 <b>NT$' + fmt(grp.hi) + '</b></span>' +
          '<span class="up">价差 NT$' + fmt(Math.round(grp.spread)) +
            '（+' + (grp.rate * 100).toFixed(0) + '%）</span>' +
          '<span class="flat">合计月销 ' + fmt(grp.totalMonth) + '</span>' +
        '</div><div class="group-bd"><table><thead><tr>' +
          '<th style="width:34px"></th><th>店铺 / 商品</th>' +
          '<th class="num">价格</th><th class="num">溢价</th>' +
          '<th class="num">月销</th><th class="num">评分</th><th>产地</th>' +
          '</tr></thead><tbody>';
      grp.shops.forEach(function (s, si) {
        var isBest = si === 0;
        var diff = s.price - grp.lo;
        var pct = grp.lo > 0 ? (diff / grp.lo) * 100 : 0;
        html += '<tr class="' + (isBest ? "best" : "") + '">' +
          '<td>' + (isBest ? '<span class="low-tag">最低</span>' : '') + '</td>' +
          '<td class="pname"><a href="' + esc(s.url) + '" target="_blank" rel="noopener" ' +
            'title="' + esc(s.name) + '">' + esc(String(s.shop).slice(0, 30)) + '</a>' +
            '<div style="font-size:11px;color:var(--muted)">' +
              esc(String(s.name).slice(0, 34)) + '</div></td>' +
          '<td class="num"><b>NT$' + fmt(s.price) + '</b></td>' +
          '<td class="num ' + (diff > 0 ? "up" : "flat") + '">' +
            (diff > 0 ? "+" + fmt(Math.round(diff)) + " (+" + pct.toFixed(0) + "%)" : "基准") + '</td>' +
          '<td class="num">' + fmt(s.month) + '</td>' +
          '<td class="num">' + (s.rating ? s.rating.toFixed(1) : "—") + '</td>' +
          '<td class="flat">' + esc(s.loc) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div></div>';
    });
    if (g.length > show.length) {
      html += '<div style="font-size:12px;color:var(--muted)">仅显示前 ' +
        show.length + ' 组（共 ' + g.length + ' 组）</div>';
    }
    box.innerHTML = html;
  }

  /* ---------------- 价格趋势 ---------------- */

  function fillPickList() {
    var dl = $("pList");
    var opts = state.items.slice()
      .sort(function (a, b) { return monthOf(b) - monthOf(a); })
      .slice(0, 300)
      .map(function (it) {
        return '<option value="' + esc(String(it.id)) + '">' +
          esc(String(it.name || it.id).slice(0, 50)) + ' · NT$' + fmt(priceOf(it)) + '</option>';
      });
    dl.innerHTML = opts.join("");
  }

  function pricesOf(id) {
    var s = state.snaps;
    if (!s || !s.items[id] || !s.items[id].price) return [];
    return s.items[id].price.map(function (v, i) {
      return { date: s.dates[i] || "", price: v };
    }).filter(function (x) { return x.price !== null && x.price !== undefined && x.price > 0; });
  }

  function lineChart(series, w, h) {
    if (series.length < 1) return "";
    w = w || 900; h = h || 260;
    var padL = 58, padR = 18, padT = 18, padB = 34;
    var vals = series.map(function (x) { return x.price; });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    if (max === min) { min = min * 0.9; max = max * 1.1; }
    var pad = (max - min) * 0.12;
    min = Math.max(0, min - pad); max = max + pad;

    var iw = w - padL - padR, ih = h - padT - padB;
    var n = series.length;
    function X(i) { return padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function Y(v) { return padT + ih - ((v - min) / (max - min)) * ih; }

    var g = "";
    // 横向网格 + Y 轴刻度
    for (var k = 0; k <= 4; k++) {
      var yy = padT + (ih * k) / 4;
      var vv = max - ((max - min) * k) / 4;
      g += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (w - padR) +
           '" y2="' + yy.toFixed(1) + '" stroke="#eef1f5" stroke-width="1"/>' +
           '<text x="' + (padL - 8) + '" y="' + (yy + 4).toFixed(1) +
           '" text-anchor="end" font-size="11" fill="#9aa5b1">NT$' +
           Math.round(vv).toLocaleString("zh-TW") + '</text>';
    }
    // 面积
    var pts = series.map(function (x, i) { return X(i).toFixed(1) + "," + Y(x.price).toFixed(1); });
    var area = 'M' + X(0).toFixed(1) + ',' + (padT + ih) + ' L' + pts.join(" L") +
               ' L' + X(n - 1).toFixed(1) + ',' + (padT + ih) + ' Z';
    var up = n > 1 ? (series[n - 1].price >= series[0].price) : true;
    var color = up ? "#ee4d2d" : "#22a06b";

    var dots = "";
    var lbl = "";
    series.forEach(function (x, i) {
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(x.price).toFixed(1) +
              '" r="3.2" fill="#fff" stroke="' + color + '" stroke-width="2"/>';
      var step = Math.ceil(n / 8);
      if (i % step === 0 || i === n - 1) {
        lbl += '<text x="' + X(i).toFixed(1) + '" y="' + (h - 12) +
               '" text-anchor="middle" font-size="10" fill="#9aa5b1">' +
               String(x.date).slice(5) + '</text>';
      }
    });

    return '<svg width="' + w + '" height="' + h + '" style="max-width:100%">' +
      '<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.22"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.02"/>' +
      '</linearGradient></defs>' + g +
      '<path d="' + area + '" fill="url(#pg)"/>' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color +
      '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + lbl + '</svg>';
  }

  function renderPrice() {
    var id = state.pickedId;
    if (!id) return;
    var s = state.snaps;
    var meta = (s && s.meta && s.meta[id]) || {};
    var series = pricesOf(id);

    $("pxStatBox").innerHTML =
      '<div class="stat"><div class="k">当前价格</div><div class="v">NT$' +
        fmt(meta.price || (series.length ? series[series.length - 1].price : 0)) +
        '</div><div class="sub">' + esc(String(meta.shop || "").slice(0, 18)) + '</div></div>' +
      '<div class="stat"><div class="k">记录天数</div><div class="v">' + series.length +
        '</div><div class="sub">天</div></div>' +
      '<div class="stat"><div class="k">期间最低</div><div class="v down">NT$' +
        fmt(series.length ? Math.min.apply(null, series.map(function (x) { return x.price; })) : 0) +
        '</div><div class="sub">历史低点</div></div>' +
      '<div class="stat"><div class="k">期间最高</div><div class="v up">NT$' +
        fmt(series.length ? Math.max.apply(null, series.map(function (x) { return x.price; })) : 0) +
        '</div><div class="sub">历史高点</div></div>' +
      '<div class="stat"><div class="k">累计变动</div><div class="v ' +
        (series.length > 1 ? (series[series.length - 1].price >= series[0].price ? "up" : "down") : "") +
        '">' + (series.length > 1
          ? ((series[series.length - 1].price >= series[0].price ? "+" : "") +
             Math.round(series[series.length - 1].price - series[0].price))
          : "—") + '</div><div class="sub">相对首次记录</div></div>';

    if (series.length < 2) {
      $("pxChart").innerHTML = '<div class="empty-hint"><div class="ico">📈</div>' +
        '只有 ' + series.length + ' 条价格记录，至少需要 2 天才能画曲线<br>' +
        '<span style="font-size:12px">明天再打开本页即可自动积累</span></div>';
    } else {
      $("pxChart").innerHTML = lineChart(series);
    }

    if (!series.length) {
      $("pxTable").innerHTML = '<div class="empty-hint"><div class="ico">📋</div>暂无价格记录</div>';
      return;
    }
    var html = '<table><thead><tr><th>日期</th><th class="num">价格</th>' +
      '<th class="num">较前次</th><th>走势</th></tr></thead><tbody>';
    for (var i = series.length - 1; i >= 0; i--) {
      var cur = series[i].price;
      var prev = i > 0 ? series[i - 1].price : null;
      var d = prev === null ? null : cur - prev;
      var cls = d === null ? "flat" : d > 0 ? "up" : d < 0 ? "down" : "flat";
      html += '<tr><td>' + esc(series[i].date) + '</td>' +
        '<td class="num"><b>NT$' + fmt(cur) + '</b></td>' +
        '<td class="num ' + cls + '">' + (d === null ? "—"
          : (d > 0 ? "+" : "") + fmt(Math.round(d))) + '</td>' +
        '<td class="' + cls + '">' + (d === null ? "首次记录"
          : d > 0 ? "↑ 涨价" : d < 0 ? "↓ 降价" : "— 持平") + '</td></tr>';
    }
    html += '</tbody></table>';
    $("pxTable").innerHTML = html;
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) {
          x.classList.remove("active");
        });
        b.classList.add("active");
        var t = b.getAttribute("data-tab");
        $("tab-score").classList.toggle("hidden", t !== "score");
        $("tab-compare").classList.toggle("hidden", t !== "compare");
        $("tab-price").classList.toggle("hidden", t !== "price");
      });
    });

    // 权重滑块数字联动
    [["w1", "w1v"], ["w2", "w2v"], ["w3", "w3v"], ["w4", "w4v"], ["w5", "w5v"]]
      .forEach(function (p) {
        $(p[0]).addEventListener("input", function () { $(p[1]).textContent = this.value; });
      });
    $("simTh").addEventListener("input", function () {
      $("simv").textContent = (this.value / 100).toFixed(2);
    });

    $("btnScore").addEventListener("click", function () {
      if (!state.items.length) { loadSource(afterLoad); return; }
      state.scored = computeScores();
      renderScores();
      toast("已重新计算 " + state.scored.length + " 件商品");
    });
    ["gradeFilter", "pMin", "pMax", "mMin"].forEach(function (id) {
      $(id).addEventListener("change", renderScores);
    });

    $("btnCompare").addEventListener("click", function () {
      if (!state.items.length) { loadSource(afterLoad); return; }
      $("cmpBox").innerHTML = '<div class="empty-hint">正在识别同款…</div>';
      setTimeout(function () {
        runCompare();
        toast("识别到 " + state.groups.length + " 组同款商品");
      }, 30);
    });

    $("btnPick").addEventListener("click", function () {
      var v = String($("pSearch").value || "").trim();
      if (!v) { toast("请输入或选择一件商品"); return; }
      // 支持直接粘 id，也支持名称匹配
      var id = v.indexOf(" ") > 0 || v.indexOf("_") > 0 ? v.split(" ")[0].split("_").slice(0, 2).join("_") : v;
      if (!state.items.some(function (it) { return String(it.id) === id; })) {
        var hit = state.items.filter(function (it) {
          return String(it.name || "").indexOf(v) >= 0;
        })[0];
        if (!hit) { toast("没找到这件商品"); return; }
        id = String(hit.id);
      }
      state.pickedId = id;
      renderPrice();
    });

    $("btnSnapPrice").addEventListener("click", function () {
      if (!state.items.length) { loadSource(afterLoad); return; }
      recordPriceToday(false);
      if (state.pickedId) renderPrice();
      updatePriceMsg();
    });
  }

  function updatePriceMsg() {
    var s = state.snaps;
    var n = s && s.dates ? s.dates.length : 0;
    var has = 0;
    if (s && s.items) {
      Object.keys(s.items).forEach(function (id) {
        if ((s.items[id].price || []).some(function (v) { return v > 0; })) has++;
      });
    }
    $("priceMsg").textContent = n
      ? ("已积累 " + n + " 天记录，其中 " + has + " 件商品有价格历史。" +
         (s.dates.indexOf(todayKey()) >= 0 ? "今天已记录。" : "今天还没记录，点右侧按钮补记。"))
      : "还没有任何记录，点「记录今日价格」开始积累。";
  }

  function afterLoad(err, items, srcUrl) {
    if (err) {
      $("scoreBox").innerHTML = '<div class="empty-hint"><div class="ico">⚠️</div>' +
        '商品数据加载失败：' + esc(err.message) + '</div>';
      return;
    }
    state.items = normCatalog({ items: items || [] });
    state.snaps = loadSnaps();

    // 自动补记今日价格（每天首次打开即积累，无需手工操作）
    recordPriceToday(true);

    fillPickList();
    updatePriceMsg();

    state.scored = computeScores();
    renderScores();

    if (state.items.length && !state.pickedId) {
      var best = state.items.slice().sort(function (a, b) { return monthOf(b) - monthOf(a); })[0];
      state.pickedId = String(best.id);
      $("pSearch").value = String(best.name || best.id).slice(0, 40);
      renderPrice();
    }
  }

  /* ---------------- 启动 ---------------- */

  state.snaps = loadSnaps();
  bind();
  loadSource(afterLoad);
})();
