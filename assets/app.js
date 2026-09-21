/* 剪枝 · 应用主逻辑
 * 原则：只做文字检查，从不改写用户文本。
 * 任何替换都只发生在用户亲自点击某一条建议之后。
 */
(function () {
  "use strict";
  var D = window.JZ;

  /* ───────────── 工具 ───────────── */
  var CJK = /[\u4e00-\u9fa5]/;
  var LATIN = /[A-Za-z0-9]/;

  function isCJK(ch) { return CJK.test(ch); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function timeText(ts) {
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return "今天 " + hh + ":" + mm;
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天 " + hh + ":" + mm;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  /* ───────────── 集合构建 ───────────── */
  var SET = {
    lex: new Set(D.LEXICON),
    stop: new Set(D.STOPWORDS),
    surnames: new Set(D.SURNAMES),
    charWords: new Set(D.CHAR_WORDS),
    func: new Set(),
    generic: new Set(D.GENERIC_VERBS)
  };
  "的 地 得 了 着 过 吗 呢 吧 啊 呀 哦 嗯 唉 哎 是 在 有 和 与 及 或 也 就 都 很 还 又 而 但 却 只 才 更 最 太 把 被 给 让 使 对 从 向 往 于 因 为 以 之 其 此 该 各 每 某 些 个 位 这 那 哪 谁 什 么 怎 你 我 他 她 它 们 又 再 还 便 就 却 才 则 乃 且 若 而 者 乎 矣 焉 哉"
    .split(" ").filter(Boolean).forEach(function (c) { SET.func.add(c); });

  var NICKNAME_BLACKLIST = new Set(("小声 大声 大门 大街 大方 大概 大约 大惊 大笑 大雾 小气 小心 小车 小路 小巷 小院 小院 老屋 老街 老树 老家 老人 老天 老手 小儿 小看 小睡 " +
    "一来 一切 一样 一直 一起 一边 一定 一般 一时").split(" ").filter(Boolean));

  var DIALOG_VERBS = ["说", "道", "问", "答", "笑", "喊", "叫", "叹", "皱眉", "点头", "摇头", "开口", "应声", "沉默", "回头", "转身", "看着", "看了", "想了", "停了", "愣", "站起", "坐下", "走近", "走过"];

  /* ───────────── 词法分析 ───────────── */
  function matchDictAt(text, i) {
    var maxLen = Math.min(4, text.length - i);
    for (var len = maxLen; len >= 1; len--) {
      var cand = text.substr(i, len);
      if (SET.lex.has(cand)) return cand;
    }
    return null;
  }

  /* 人名 / 昵称占用的位置：这些整块不能被切开，否则会切出「荒的脸」这种碎片 */
  function buildProtectedSpans(text, nameList) {
    var spans = [];
    nameList.forEach(function (n) {
      if (!n || n.length < 2) return;
      var i = -1;
      while ((i = text.indexOf(n, i + 1)) !== -1) spans.push({ s: i, e: i + n.length });
    });
    spans.sort(function (a, b) { return a.s - b.s || (b.e - b.s) - (a.e - a.s); });
    var out = [], last = -1;
    spans.forEach(function (sp) {
      if (sp.s >= last) { out.push(sp); last = sp.e; }
    });
    return out;
  }
  function inSpans(spans, pos) {
    return spans.some(function (sp) { return pos >= sp.s && pos < sp.e; });
  }
  function spanStartAt(spans, pos) {
    return spans.some(function (sp) { return sp.s === pos; });
  }

  /* 粗切分：人名块 / 词典词 / 未知内容片段 / 拉丁数字 / 标点 */
  function coarseTokenize(text, spans) {
    var prot = spans || [];
    var out = [], i = 0, n = text.length;
    while (i < n) {
      var hit = prot.filter(function (sp) { return sp.s === i; })[0];
      if (hit) {
        out.push({ w: text.slice(hit.s, hit.e), s: hit.s, e: hit.e, kind: "name" });
        i = hit.e;
        continue;
      }
      var ch = text[i];
      if (isCJK(ch)) {
        if (SET.func.has(ch)) { out.push({ w: ch, s: i, e: i + 1, kind: "func" }); i++; continue; }
        var m = matchDictAt(text, i);
        if (m) { out.push({ w: m, s: i, e: i + m.length, kind: "dict" }); i += m.length; continue; }
        var j = i;
        while (j < n && isCJK(text[j]) && !SET.func.has(text[j]) && !matchDictAt(text, j) && !spanStartAt(prot, j)) j++;
        if (j === i) j = i + 1;
        out.push({ w: text.slice(i, j), s: i, e: j, kind: "run" });
        i = j;
      } else if (LATIN.test(ch)) {
        var k = i;
        while (k < n && LATIN.test(text[k])) k++;
        out.push({ w: text.slice(i, k), s: i, e: k, kind: "latin" });
        i = k;
      } else {
        out.push({ w: ch, s: i, e: i + 1, kind: "punct" });
        i++;
      }
    }
    return out;
  }

  /* 从未知片段里挖 2-4 字候选词 */
  function mineNgrams(tokens, cand) {
    tokens.forEach(function (t) {
      if (t.kind !== "run") return;
      var run = t.w;
      for (var len = 2; len <= Math.min(4, run.length); len++) {
        for (var i = 0; i + len <= run.length; i++) {
          var g = run.slice(i, i + len);
          if (SET.stop.has(g) || NICKNAME_BLACKLIST.has(g)) continue;
          if (SET.func.has(g[0]) || SET.func.has(g[g.length - 1])) continue;
          var rec = cand.get(g);
          if (!rec) { rec = { w: g, count: 0, pos: [] }; cand.set(g, rec); }
          rec.count++;
          rec.pos.push(t.s + i);
        }
      }
    });
  }

  /* 过滤掉被更长同类候选覆盖的碎片 */
  function pruneNgrams(cand) {
    var keep = [];
    var arr = Array.from(cand.values());
    arr.sort(function (a, b) { return b.w.length - a.w.length || b.count - a.count; });
    var accepted = [];
    arr.forEach(function (c) {
      var superseded = accepted.some(function (a) {
        return a.w.indexOf(c.w) >= 0 && a.count >= Math.max(2, c.count * 0.6);
      });
      if (!superseded) { accepted.push(c); keep.push(c); }
    });
    return keep;
  }

  /* 昵称识别：小X / 老X / 阿X / X儿 / 叠字 */
  function findNicknames(text) {
    var found = new Set();
    var re = /(?:^|[^\u4e00-\u9fa5])((?:小|老|阿|大)[\u4e00-\u9fa5]|[\u4e00-\u9fa5]儿|([\u4e00-\u9fa5])\2)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var w = m[1];
      if (SET.lex.has(w) || SET.stop.has(w) || SET.func.has(w) || NICKNAME_BLACKLIST.has(w)) continue;
      if (/^(.)\1$/.test(w) && SET.func.has(w[0])) continue;
      found.add(w);
    }
    return found;
  }

  /* 人名识别：姓氏+1~2 字 / 对话动词前的两字词 */
  function findNames(text) {
    var score = new Map();
    var occ = new Map();
    function bump(w, n) { score.set(w, (score.get(w) || 0) + n); }
    function touch(w) { occ.set(w, (occ.get(w) || 0) + 1); }
    var i, len, w;
    for (i = 0; i < text.length; i++) {
      if (!isCJK(text[i])) continue;
      /* A. 姓氏模式 */
      if (SET.surnames.has(text[i])) {
        for (len = 1; len <= 2; len++) {
          if (i + 1 + len > text.length) continue;
          w = text.substr(i, 1 + len);
          if (!CJK.test(w[w.length - 1]) || SET.func.has(w[w.length - 1])) continue;
          if (SET.stop.has(w)) continue;
          /* 「别这样」「于是」「不能」这类：姓 + 常用字，直接排除 */
          if (SET.func.has(w[1]) || SET.stop.has(w.slice(1))) continue;
          if (matchDictAt(text, i) === w) continue; /* 本身就是词，如"照顾" */
          touch(w);
          var after = text.substr(i + 1 + len, 2);
          var ctx = DIALOG_VERBS.some(function (v) { return after.indexOf(v) === 0; });
          bump(w, ctx ? 2 : 0);
        }
      }
      /* B. 对话动词前的两字/三字词 */
      for (len = 2; len <= 3; len++) {
        if (i + len + 1 > text.length) continue;
        w = text.substr(i, len);
        if (!/^[\u4e00-\u9fa5]+$/.test(w)) continue;
        if (SET.func.has(w[0]) || SET.func.has(w[w.length - 1])) continue;
        if (SET.lex.has(w) || SET.stop.has(w)) continue;
        var nxt = text.slice(i + len, i + len + 2);
        if (DIALOG_VERBS.some(function (v) { return nxt.indexOf(v) === 0; })) { touch(w); bump(w, 2); }
      }
    }
    var names = new Set();
    score.forEach(function (v, k) {
      var n = occ.get(k) || 0;
      /* 重复出现 3 次以上，或出现两次且至少一次带对话动作，才算人名 */
      if (k.length >= 2 && (n >= 3 || (n >= 2 && v >= 2))) names.add(k);
    });
    return names;
  }

  /* ───────────── 正文体检 ───────────── */
  var IMAGERY_SET = new Set(D.IMAGERY);
  var ROUTINE_WORD_SET = new Set(D.ROUTINE_WORDS);
  var ROUTINE_KEYS = Object.keys(D.ROUTINE_PHRASES).sort(function (a, b) { return b.length - a.length; });
  var ACTION_CUES = new Set(D.ACTION_CUES);
  var CJK_ONLY = /^[\u4e00-\u9fa5]+$/;

  function uniq(arr) {
    return arr.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  }
  function countOcc(text, sub) {
    var c = 0, i = -1;
    while ((i = text.indexOf(sub, i + 1)) !== -1) c++;
    return c;
  }
  function paragraphsOf(text) {
    return text.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function hasActionCue(g) {
    for (var i = 0; i < g.length; i++) if (ACTION_CUES.has(g[i])) return true;
    return false;
  }

  /* 常态化表述 = 人工短语表命中 + 文中反复出现的动作/神态片段（3-6 字） */
  function findRoutine(text, nameList, spans) {
    var prot = spans || [];
    var hits = new Map();
    ROUTINE_KEYS.forEach(function (p) {
      var c = countOcc(text, p);
      if (c >= 2) hits.set(p, { w: p, count: c, curated: true });
    });
    var cand = new Map();
    for (var len = 3; len <= 6; len++) {
      for (var i = 0; i + len <= text.length; i++) {
        var g = text.substr(i, len);
        if (!CJK_ONLY.test(g)) continue;
        if (SET.func.has(g[0]) || SET.func.has(g[g.length - 1])) continue;
        if (/[的地得了着过吗呢吧啊]/.test(g)) continue;     /* 片段里夹虚词，说明切碎了 */
        if (inSpans(prot, i) || inSpans(prot, i + len - 1)) continue;  /* 不跨人名 */
        if (!hasActionCue(g)) continue;
        cand.set(g, (cand.get(g) || 0) + 1);
      }
    }
    var arr = [];
    cand.forEach(function (c, w) { if (c >= 3) arr.push({ w: w, count: c }); });
    arr.sort(function (a, b) { return b.w.length - a.w.length || b.count - a.count; });
    var accepted = [];
    arr.forEach(function (x) {
      if (hits.has(x.w)) return;
      if (ROUTINE_KEYS.some(function (p) { return p.indexOf(x.w) >= 0; })) return;
      if (nameList.some(function (n) { return x.w.indexOf(n) >= 0; })) return;
      if (accepted.some(function (a) { return a.w.indexOf(x.w) >= 0; })) return;
      accepted.push(x);
      hits.set(x.w, { w: x.w, count: x.count, curated: false });
    });
    var out = [];
    hits.forEach(function (h) {
      h.kind = "routine";
      h.suggestions = D.ROUTINE_PHRASES[h.w] || null;
      h.reason = h.curated ? "常见的常态化表述" : "文中反复出现的同一表达";
      out.push(h);
    });
    out.sort(function (a, b) { return b.count - a.count || b.w.length - a.w.length; });
    return out;
  }

  function analyze(text, settings) {
    /* 先认人名 / 昵称，再切词：人名整块保护，绝不切碎 */
    var names = settings.filterNames ? findNames(text) : new Set();
    var nicknames = settings.filterNames ? findNicknames(text) : new Set();
    var nameList = uniq(Array.from(names).concat(Array.from(nicknames)));
    var spans = settings.filterNames ? buildProtectedSpans(text, nameList) : [];

    var tokens = coarseTokenize(text, spans);
    var cand = new Map();
    mineNgrams(tokens, cand);

    var counts = new Map(); /* w -> {count, kind} */
    function add(w, kind) {
      if (SET.stop.has(w) || SET.func.has(w)) return;
      if (w.length < 1) return;
      if (w.length === 1 && !SET.charWords.has(w)) return;
      var r = counts.get(w);
      if (!r) { r = { w: w, count: 0, kind: kind }; counts.set(w, r); }
      r.count++;
    }

    tokens.forEach(function (t) {
      if (t.kind === "dict") add(t.w, "lexicon");
      /* 英文（Peter、Sherlock…）一律不统计、不高亮 */
    });
    pruneNgrams(cand).forEach(function (c) {
      var r = counts.get(c.w);
      if (!r) { r = { w: c.w, count: 0, kind: "mined" }; counts.set(c.w, r); }
      r.count += c.count;
    });
    SET.charWords.forEach(function (cw) {
      var hits = 0, idx = -1;
      while ((idx = text.indexOf(cw, idx + 1)) !== -1) {
        if (!inSpans(spans, idx)) hits++;          /* 人名里的字不算 */
      }
      if (hits > 0) {
        var r = counts.get(cw);
        if (!r) { r = { w: cw, count: 0, kind: "char" }; counts.set(cw, r); }
        r.count = Math.max(r.count, hits);
      }
    });

    var list = Array.from(counts.values()).filter(function (r) {
      return !(names.has(r.w) || nicknames.has(r.w));
    });

    /* 关键意象豁免：雪、月、雨、灯这类是场景骨架，密集出现也不构成疲劳 */
    var imagery = [];
    list = list.filter(function (r) {
      if (IMAGERY_SET.has(r.w)) { imagery.push(r); return false; }
      return true;
    });

    var totalTokens = list.reduce(function (a, r) { return a + r.count; }, 0) || 1;
    list.forEach(function (r) {
      r.density = r.count / totalTokens;
      r.routineWord = ROUTINE_WORD_SET.has(r.w);
      r.suggestions = D.SYNONYMS[r.w] || null;
    });
    list.sort(function (a, b) { return b.count - a.count || b.w.length - a.w.length; });

    /* 双阈值：占比（与篇幅无关）+ 硬次数（长篇里的死循环词） */
    var densityCut = settings.sensitivity === "low" ? 0.026 : settings.sensitivity === "high" ? 0.012 : 0.018;
    var hardCount = clamp(Math.round(text.length / 300), 5, 20);
    var words = list.filter(function (r) {
      if (r.routineWord && r.count >= 2) return true;
      if (r.count >= 3 && r.density >= densityCut) return true;
      return r.count >= hardCount;
    }).slice(0, 12);
    words.forEach(function (r) { r.kind = r.routineWord ? "routine" : "word"; });

    var routine = findRoutine(text, nameList, spans).slice(0, 12);
    /* 常态副词排在前面，其他词排在后面 */
    var adverbs = words.filter(function (r) { return r.routineWord; });
    var plainWords = words.filter(function (r) { return !r.routineWord; });

    /* 已被常态化表述覆盖的碎词不再单独列一次（皱眉 / 垂下 / 眼 …） */
    plainWords = plainWords.filter(function (r) {
      return !routine.some(function (h) { return h.w.length > r.w.length && h.w.indexOf(r.w) >= 0; });
    });

    /* 正文里要标出的东西：常态副词 → 常态化表述 → 高频实词；同一串不重复出现 */
    var seen = new Set();
    var flagged = adverbs.concat(routine).concat(plainWords).filter(function (h) {
      if (seen.has(h.w)) return false;
      seen.add(h.w);
      return true;
    });

    var paras = paragraphsOf(text);
    imagery.forEach(function (r) {
      r.density = r.count / totalTokens;
      r.paraCount = paras.filter(function (p) { return p.indexOf(r.w) >= 0; }).length;
    });
    imagery.sort(function (a, b) { return b.count - a.count || b.w.length - a.w.length; });

    return {
      chars: text.length,
      tokens: list,
      flagged: flagged,
      adverbs: adverbs,
      routine: routine,
      words: plainWords,
      imagery: imagery,
      names: Array.from(names),
      nicknames: Array.from(nicknames),
      totalTokens: totalTokens,
      densityCut: densityCut,
      hardCount: hardCount
    };
  }

  function queryTokens(query) {
    var toks = coarseTokenize(query).filter(function (t) { return t.kind === "dict"; }).map(function (t) { return t.w; });
    var cand = new Map();
    mineNgrams(coarseTokenize(query), cand);
    pruneNgrams(cand).forEach(function (c) { toks.push(c.w); });
    Array.from(SET.charWords).forEach(function (c) { if (query.indexOf(c) >= 0) toks.push(c); });
    var seen = new Set();
    return toks.filter(function (w) {
      if (SET.stop.has(w) || SET.func.has(w) || seen.has(w)) return false;
      seen.add(w); return true;
    });
  }

  /* ───────────── 意象拆解 ─────────────
     不抽象成情绪概念：你写「雪夜」，就拆成「雪」+「夜」两个意象，
     直接去找同时写了这两个意象的作品与句子。 */
  var IMAGERY_ATOMS = new Set(D.IMAGERY);
  /* 这些字太泛，不单独当意象（避免「雨天」被拆成「雨」+「天」） */
  var GENERIC_ATOMS = new Set("天 光 影 色 声 气 地 处 里".split(" "));

  function extractUnits(query) {
    var raw = queryTokens(query);
    var units = [];
    var bonus = [];
    function push(u) { if (u && units.indexOf(u) < 0) units.push(u); }
    function pushBonus(u) { if (u && bonus.indexOf(u) < 0) bonus.push(u); }
    raw.forEach(function (w) {
      if (w.length === 1) { if (IMAGERY_ATOMS.has(w) && !GENERIC_ATOMS.has(w)) push(w); return; }
      var atoms = [];
      for (var i = 0; i < w.length; i++) {
        if (IMAGERY_ATOMS.has(w[i]) && !GENERIC_ATOMS.has(w[i])) atoms.push(w[i]);
      }
      /* 「雪夜」→ 雪、夜；「灯火」→ 灯、火；整词本身作为加分项保留 */
      if (atoms.length >= 1 && atoms.length >= w.length - 1) { atoms.forEach(push); pushBonus(w); }
      else push(w);
    });
    /* 逐字再补一遍意象字：分词会把「灯火」切成「灯」+「火」，别漏掉 */
    for (var k = 0; k < query.length; k++) {
      if (IMAGERY_ATOMS.has(query[k]) && !GENERIC_ATOMS.has(query[k])) push(query[k]);
    }
    /* 两字连写的整词优先：「雪夜」「月色」「雨夜」，先按整词找，再拆开找 */
    query.split(/[^\u4e00-\u9fa5]+/).filter(Boolean).forEach(function (seg) {
      for (var i = 0; i + 2 <= seg.length; i++) {
        var w = seg.substr(i, 2);
        if (SET.stop.has(w) || SET.func.has(w) || units.indexOf(w) >= 0) continue;
        if (/[的地得了着过吗呢吧啊]/.test(w)) continue;   /* 「荒的」这种碎片不要 */
        var a1 = IMAGERY_ATOMS.has(w[0]) && !GENERIC_ATOMS.has(w[0]);
        var a2 = IMAGERY_ATOMS.has(w[1]) && !GENERIC_ATOMS.has(w[1]);
        if (a1 || a2) pushBonus(w);
      }
    });
    /* 全是泛字时（例如只写「天」），就按原样找 */
    if (!units.length) {
      for (var m = 0; m < query.length; m++) if (IMAGERY_ATOMS.has(query[m])) push(query[m]);
      raw.forEach(function (w) { if (w.length > 1) push(w); });
    }
    /* 有实义的单字（恨 / 爱 / 等 / 泪 / 血 / 手 …）：不当作必须同句出现的硬条件，
       它们只参与「恨海情天」矢量，并在命中时加分 */
    var mood = [];
    raw.forEach(function (w) {
      if (w.length === 1 && SET.charWords.has(w) && units.indexOf(w) < 0 && mood.indexOf(w) < 0) mood.push(w);
    });
    /* 去掉被更长单元包含的单字（「等」←「等待」） */
    var cleaned = units.filter(function (u) {
        if (u.length > 1) return true;
        return !units.some(function (o) { return o.length > 1 && o.indexOf(u) >= 0; });
    });
    /* 再去掉被更长单元包含的碎片（「战舰」←「星际战舰」） */
    cleaned = cleaned.filter(function (u) {
      return !cleaned.some(function (o) { return o.length > u.length && o.indexOf(u) >= 0; });
    });
    /* 兜底：整段都没被认出来（比如只写了一个「橙」），就把这一段里有实义的字直接拿来搜 */
    if (!cleaned.length) {
      query.split(/[^\u4e00-\u9fa5]+/).filter(Boolean).forEach(function (seg) {
        var got = false;
        for (var i = 0; i < seg.length; i++) if (units.indexOf(seg[i]) >= 0) got = true;
        if (got) return;
        for (var k = 0; k < seg.length; k++) {
          var ch = seg[k];
          if (SET.stop.has(ch) || SET.func.has(ch)) continue;
          if (mood.indexOf(ch) >= 0) continue;
          push(ch);
        }
      });
    }
    /* 兜底补进来的字要并回结果（之前算过的 cleaned 里没有它们） */
    if (!cleaned.length && units.length) cleaned = units.slice();
    /* 只写了情绪字、没有任何意象词时，就按这些字直接找 */
    if (!cleaned.length && mood.length) { cleaned = mood.slice(); mood = []; }
    return { units: cleaned, bonus: bonus, mood: mood };
  }

  var SCENE_INDEX = null;
  function sceneIndex() {
    if (SCENE_INDEX) return SCENE_INDEX;
    SCENE_INDEX = {};
    Object.keys(D.WORKS).forEach(function (g) {
      SCENE_INDEX[g] = D.WORKS[g].map(function (work) {
        var scenes = D.SCENES[work[0]] || [];
        scenes = D.SCENES[g + "@" + work[0]] || scenes;
        return {
          work: work,
          lines: scenes.map(function (s) {
            return { x: s[0], quote: !!s[1], tags: s[2].split("|") };
          })
        };
      });
    });
    return SCENE_INDEX;
  }

  /* 意象同族：雪 ↔ 雪色/霜雪/柳絮/梨花；橙 ↔ 橘/柑/橙黄…… */
  var FAMILY = D.IMAGERY_FAMILY || {};
  function familyTerm(line, u) {
    var list = FAMILY[u];
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (line.x.indexOf(f) >= 0) return f;
      if (line.tags.some(function (t) { return t.indexOf(f) >= 0; })) return f;
    }
    return null;
  }
  /* ── 场景：换个说法写同一件事，也算命中 ── */
  var SCENE_LIB = D.SCENE_LIB || {};
  var SCENE_KEYS = Object.keys(SCENE_LIB);
  var SCENE_DESC = {};
  var SCENE_CORE = {};
  SCENE_KEYS.forEach(function (k) {
    SCENE_DESC[k] = SCENE_LIB[k].split(" ").filter(Boolean);
    /* 场景名里的元素：风雪夜归 → 风 / 雪 / 夜 / 归 / 风雪 / 雪夜 / 夜归 */
    var core = [];
    for (var i = 0; i < k.length; i++) {
      if (core.indexOf(k[i]) < 0) core.push(k[i]);
      if (i + 2 <= k.length && core.indexOf(k.substr(i, 2)) < 0) core.push(k.substr(i, 2));
    }
    SCENE_CORE[k] = core;
  });
  var UNIT_SCENE_CACHE = {};

  /* 这一句写的是哪些场景：至少命中两个场景特征词才算 */
  function lineSceneSet(line) {
    if (line._scenes) return line._scenes;
    var hay = line.x + "|" + line.tags.join("|");
    var out = [];
    SCENE_KEYS.forEach(function (name) {
      /* 句子里至少要有一个场景名里的元素，否则不算这个场景 */
      if (!SCENE_CORE[name].some(function (c) { return hay.indexOf(c) >= 0; })) return;
      var desc = SCENE_DESC[name], hits = 0;
      for (var i = 0; i < desc.length; i++) if (hay.indexOf(desc[i]) >= 0) hits++;
      if (hits >= 2) out.push(name);
    });
    line._scenes = out;
    return out;
  }
  /* 一个词属于哪些场景（连同它的同族说法一起算） */
  function scenesOfUnit(u) {
    if (UNIT_SCENE_CACHE[u]) return UNIT_SCENE_CACHE[u];
    var forms = [u].concat(FAMILY[u] || []);
    var out = [];
    SCENE_KEYS.forEach(function (name) {
      var desc = SCENE_DESC[name];
      if (desc.some(function (d) {
        return forms.some(function (f) { return d === f || d.indexOf(f) >= 0; });
      })) out.push(name);
    });
    UNIT_SCENE_CACHE[u] = out;
    return out;
  }
  function sceneMatch(line, u) {
    var scenes = scenesOfUnit(u);
    if (!scenes.length) return null;
    var here = lineSceneSet(line);
    for (var i = 0; i < here.length; i++) if (scenes.indexOf(here[i]) >= 0) return here[i];
    return null;
  }

  /* 句子命中：字面出现 / 这一句标注过 / 写了同族说法 / 写的是同一个场景 */
  function matchUnit(line, u) {
    if (line.x.indexOf(u) >= 0) return { how: "text" };
    if (line.tags.some(function (t) { return t === u || t.indexOf(u) >= 0; })) return { how: "tag" };
    var f = familyTerm(line, u);
    if (f) return { how: "family", term: f };
    var sc = sceneMatch(line, u);
    if (sc) return { how: "scene", scene: sc };
    var ai = aiTerm(line);
    if (ai) return { how: "ai", term: ai };
    return null;
  }
  function lineHas(line, u) { return !!matchUnit(line, u); }

  /* ── 联网扩词（可选）：AI 只负责把你的词扩成意象/场景词，句子仍然来自本地库 ── */
  var aiWords = [];
  function aiTerm(line) {
    for (var i = 0; i < aiWords.length; i++) {
      var w = aiWords[i];
      if (line.x.indexOf(w) >= 0) return w;
      if (line.tags.some(function (t) { return t.indexOf(w) >= 0; })) return w;
    }
    return null;
  }
  function expandQuery(query) {
    var s = state.settings;
    var base = (s.aiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
    var body = {
      model: s.aiModel || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "你是中文文学检索助手。把用户给的词或句子拆成**具体的意象词与场景词**（例如“雪夜”→雪、夜、霜、柴门、犬吠、夜归人、行路）。只输出 JSON，格式 {\"words\":[\"词\"]}，最多 12 个，每个不超过 6 个字。不要输出情绪概念（如冷寂、悲伤），不要解释。" },
        { role: "user", content: query }
      ]
    };
    return fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (s.aiKey || "") },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      var txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      var m = txt.match(/\{[\s\S]*\}/);
      var obj = m ? JSON.parse(m[0]) : {};
      var list = (obj && obj.words) || [];
      return list.filter(function (w) { return typeof w === "string" && w.trim(); })
        .map(function (w) { return w.trim(); }).slice(0, 12);
    });
  }

  /* ── 「恨海情天」矢量：爱意 / 恨意 / 纠缠，三个轴 ── */
  /* 爱的一边 */
  var LOVE_CUES = "情 爱 恋 痴 眷 依 怜 疼 念 思 思念 相思 想念 誓 愿 温柔 相守 婚 约 吻 怀 拥 携 白头 长情 深情 心 眉 眼 甜 柔 亲 盼 暖 温 惜 挂 宠";
  /* 恨的一边 */
  var HATE_CUES = "恨 怨 仇 怒 冷 负 背叛 撕 争 报复 复仇 心死 断 碎 痛 苦 冤 冰 刀 血 决裂 绝情 罚 罪 欺 骗 忍 泪 哭 悲 酸 涩";
  /* 纠缠：等、别、离、重逢、错过、记住与忘掉 */
  var TANGLE_CUES = "等 等待 待 归 别 离别 别离 离 重逢 误 错 错过 信 回信 约 轮回 纠缠 宿 命 命运 两 相对 相望 彼此 之间 名字 走远 送 守 舍 怕 瞒 呼唤 目送 记 忘 旧 忆 见 一眼";
  /* 人和情绪在场：话没说到爱恨，但句子里有人 */
  var SOFT_CUES = "你 我 他 她 谁 心 眼 眉 手 肩 笑 泪 看 望 沉默 说 话 声 脸 唇 目光 眼神";
  function splitCues(s) { return s.split(" ").filter(Boolean); }
  var LOVE = splitCues(LOVE_CUES), HATE = splitCues(HATE_CUES), TANGLE = splitCues(TANGLE_CUES), SOFT = splitCues(SOFT_CUES);
  function axisScore(text, cues, full) {
    var hits = 0;
    cues.forEach(function (c) { if (text.indexOf(c) >= 0) hits++; });
    return Math.min(1, hits / full);
  }
  function relationOf(text) {
    return {
      love: axisScore(text, LOVE, 1.5),
      hate: axisScore(text, HATE, 1.5),
      tangle: axisScore(text, TANGLE, 2),
      soft: axisScore(text, SOFT, 1)
    };
  }
  function relationScore(r) {
    var core = 0.30 * r.love + 0.30 * r.hate + 0.40 * r.tangle;
    /* 沾边就算 30%：哪怕只是句子里有人、有情绪 */
    var touched = core > 0 || r.soft > 0;
    return touched ? Math.max(0.3, core) : 0;
  }
  function relationMatch(q, w) {
    if (!q) return relationScore(w);          /* 你没给情绪词，就按文本本身的纠缠度排 */
    var d = (Math.abs(q.love - w.love) + Math.abs(q.hate - w.hate) + Math.abs(q.tangle - w.tangle)) / 3;
    return clamp(1 - d * 0.8, 0, 1);
  }
  function relationLabel(r) {
    var tags = [];
    if (r.love >= 0.34) tags.push("爱意");
    if (r.hate >= 0.34) tags.push("恨意");
    if (r.tangle >= 0.34) tags.push("纠缠");
    return tags;
  }
  /* 和「恨海情天」关系太淡的句子，默认不展示 */
  var REL_THRESHOLD = 0.3;

  /* 排序分区：外国文学 → 现当代 → 中国古代 */
  var COUNTRY_RE = /英国|法国|俄国|俄罗斯|美国|德国|奥地利|爱尔兰|挪威|丹麦|意大利|西班牙|古希腊|希腊|哥伦比亚|智利|阿根廷|日本|波兰|捷克|葡萄牙|瑞典|印度|波斯|阿拉伯|古罗马|罗马/;
  var ANCIENT_RE = /先秦|战国|春秋|汉代|东汉|西汉|魏晋|东晋|南朝|北朝|隋|唐代|五代|北宋|南宋|元代|元末|明代|明末|清代/;
  function workRegion(work) {
    var era = work[2] || "";
    if (COUNTRY_RE.test(era)) return 0;          /* 外国文学 */
    if (/近代|现代|当代/.test(era)) return 1;    /* 现当代 */
    if (ANCIENT_RE.test(era)) return 2;          /* 中国古代 */
    return 1;
  }
  function regionName(w) {
    return w === 0 ? "外国文学" : w === 1 ? "现当代" : "中国古代";
  }

  /* 命中的词在句子里挨得越近，越接近「雪夜」这种合写 */
  function proximity(text, hits) {
    if (hits.length <= 1) return true;
    var spans = [];
    hits.forEach(function (h) {
      var i = text.indexOf(h);
      if (i >= 0) spans.push([i, i + h.length]);
    });
    if (spans.length < hits.length) return 0;
    var lo = Math.min.apply(null, spans.map(function (s) { return s[0]; }));
    var hi = Math.max.apply(null, spans.map(function (s) { return s[1]; }));
    var gap = hi - lo;
    if (gap <= 3) return 1;
    if (gap <= 7) return 0.7;
    if (gap <= 14) return 0.35;
    return 0;
  }

  function searchScenes(genre, query) {
    var ex = extractUnits(query);
    var units = ex.units, wholeWords = ex.bonus, moodChars = ex.mood || [];
    if (!units.length) return { units: [], bonus: [], items: [], missing: [] };
    var index = sceneIndex()[genre] || [];
    /* 稀有度：越少作品写过的词，命中它越说明问题（「旧照片」比「夜」更有分量） */
    var weight = {};
    units.forEach(function (u) {
      var n = 0;
      index.forEach(function (rec) {
        if (rec.lines.some(function (l) { return lineHas(l, u); })) n++;
      });
      weight[u] = 1 / (1 + n / 8);
    });
    var totalWeight = units.reduce(function (a, u) { return a + weight[u]; }, 0) || 1;
    var queryRelation = relationOf(query);
    var queryHasMood = relationLabel(queryRelation).length > 0;
    var strict = [], loose = [];

    /* 只在同一句里算共现：雪在前面、夜在很远处，不算「雪夜」 */
    index.forEach(function (rec) {
      var best = null;
      rec.lines.forEach(function (line) {
        var howMap = {};
        var hits = units.filter(function (u) {
          var m = matchUnit(line, u);
          if (m) { howMap[u] = m; return true; }
          return false;
        });
        if (!hits.length) return;
        var inText = hits.filter(function (u) { return line.x.indexOf(u) >= 0; });
        var wholeHit = wholeWords.filter(function (w) { return line.x.indexOf(w) >= 0; });
        var near = inText.length ? proximity(line.x, inText) : 0;
        var covered = hits.length === units.length;
        var tagged = hits.length - inText.length;
        /* ① 整词连写 ② 两个词挨着 ③ 同句但离得远 ④ 只命中一部分 ⑤ 同场景 ⑥ AI 扩词命中 */
        var noLiteral = hits.length > 0 && inText.length === 0;
        var sceneOnly = noLiteral && hits.every(function (u) { return howMap[u] && howMap[u].how === "scene"; });
        var aiOnly = noLiteral && hits.every(function (u) { return howMap[u] && howMap[u].how === "ai"; });
        var tier = wholeHit.length ? 1
          : aiOnly ? 6
          : sceneOnly ? 5
          : (covered && tagged === 0 && near >= 0.7 ? 2 : (covered ? 3 : 4));
        var rank = (covered ? 10 : 0) - (tier - 1) * 2 + hits.length;
        if (!best || rank > best.rank) {
          best = { line: line, hits: hits, inText: inText, whole: wholeHit, near: near, covered: covered, tagged: tagged, tier: tier, rank: rank, how: howMap };
        }
      });
      if (!best) return;
      var lineWeighted = best.inText.reduce(function (a, u) { return a + weight[u]; }, 0) +
        (best.hits.length - best.inText.length) * 0.5 *
          (best.hits.reduce(function (a, u) { return a + weight[u]; }, 0) / Math.max(1, best.hits.length)) +
        best.whole.length * 0.5 +
        Math.min(0.25, moodChars.filter(function (c) { return best.line.x.indexOf(c) >= 0; }).length * 0.12);
      var imagery = Math.min(1, lineWeighted / totalWeight);
      /* 「恨海情天」：这一句在爱与恨之间缠得多深，以及和你写的词像不像 */
      var rel = relationOf(best.line.x + "|" + best.line.tags.join("|"));
      var relMatch = relationMatch(queryHasMood ? queryRelation : null, rel);
      var s01 = 0.78 * imagery + 0.22 * relMatch;
      var item = {
        work: rec.work,
        line: best.line,
        hits: best.hits,
        inText: best.inText,
        how: best.how,
        whole: best.whole,
        tier: best.tier,
        tagCount: best.tagged,
        covered: best.covered,
        near: best.near,
        missing: units.filter(function (u) { return best.hits.indexOf(u) < 0; }),
        relation: rel,
        relMatch: relMatch,
        region: workRegion(rec.work),
        relScore: relationScore(rel),
        relOK: relationScore(rel) >= REL_THRESHOLD,
        s01: s01,
        score: clamp(Math.round(50 + 50 * clamp(s01, 0, 1)), 50, 100)
      };
      (best.covered ? strict : loose).push(item);
    });
    /* 排序：和「恨海情天」最相关的排前面 → 同区里外国文学 → 现当代 → 古代 → 命中档次 → 关联度 */
    function byRelation(a, b) {
      return (b.relOK - a.relOK) || (b.relScore - a.relScore) ||
        a.region - b.region || a.tier - b.tier || b.s01 - a.s01;
    }
    strict.sort(byRelation);
    loose.sort(byRelation);
    var missing = units.filter(function (u) {
      return !index.some(function (rec) {
        return rec.lines.some(function (l) { return lineHas(l, u); });
      });
    });
    return {
      units: units,
      bonus: wholeWords,
      strict: strict,
      loose: loose,
      items: strict.concat(loose),
      missing: missing,
      queryRelation: queryRelation,
      queryHasMood: queryHasMood,
      moodChars: moodChars,
      threshold: REL_THRESHOLD
    };
  }

  /* 把命中意象在句子里标出来 */
  function highlightLine(text, hits) {
    var taken = new Uint8Array(text.length);
    var segs = [];
    hits.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (h) {
      var i = -1;
      while ((i = text.indexOf(h, i + 1)) !== -1) {
        var free = true;
        for (var k = i; k < i + h.length; k++) if (taken[k]) { free = false; break; }
        if (!free) continue;
        for (var j = i; j < i + h.length; j++) taken[j] = 1;
        segs.push({ s: i, e: i + h.length });
      }
    });
    segs.sort(function (a, b) { return a.s - b.s; });
    var html = "", cur = 0;
    segs.forEach(function (g) {
      html += esc(text.slice(cur, g.s)) + '<mark class="qmark">' + esc(text.slice(g.s, g.e)) + "</mark>";
      cur = g.e;
    });
    return html + esc(text.slice(cur));
  }

  /* ───────────── 状态 ───────────── */
  var LS = { settings: "jianzhi.settings.v1", history: "jianzhi.history.v1", seen: "jianzhi.seen.v1" };
  var DEFAULT_SETTINGS = {
    suggest: false, sensitivity: "mid", filterNames: true, tooltipDelay: 618, searchSort: "mood",
    aiExpand: false, aiBase: "https://api.openai.com/v1", aiModel: "gpt-4o-mini", aiKey: ""
  };

  var state = {
    settings: load(LS.settings, DEFAULT_SETTINGS),
    history: load(LS.history, []),
    genre: null,
    lastSearch: null,
    doc: { original: null, current: "", analysis: null, applied: [], undo: [], dirty: false },
    view: "edit" /* edit | render */
  };
  function load(k, def) {
    var raw = null;
    try { raw = localStorage.getItem(k); } catch (e) { return def; }
    if (raw == null) return def;
    try {
      var v = JSON.parse(raw);
      /* 数组不能被 Object.assign 合并，否则会退化成普通对象 */
      if (Array.isArray(def)) return Array.isArray(v) ? v : def;
      return v && typeof v === "object" ? Object.assign({}, def, v) : def;
    } catch (e) { return def; }
  }
  function saveSettings() { try { localStorage.setItem(LS.settings, JSON.stringify(state.settings)); } catch (e) {} }
  function saveHistory() { try { localStorage.setItem(LS.history, JSON.stringify(state.history.slice(0, 80))); } catch (e) {} }

  function pushHistory(entry) {
    entry.id = "h" + Date.now() + Math.random().toString(36).slice(2, 6);
    entry.ts = Date.now();
    state.history.unshift(entry);
    if (state.history.length > 80) state.history.length = 80;
    saveHistory();
    renderHistory();
  }

  /* ───────────── 历史列表 ───────────── */
  function renderHistory() {
    var box = $("#historyList");
    box.innerHTML = "";
    if (!state.history.length) {
      box.appendChild(el("li", "history-empty", "<span>还没有记录。</span><small>检索风格或检查正文后，这里会按时间从晚到早自动归档。</small>"));
      return;
    }
    state.history.forEach(function (h) {
      var li = el("li", "history-item" + (h.kind === "search" ? " is-search" : ""));
      li.dataset.id = h.id;
      var tag = h.kind === "search" ? ("检索 · " + h.genre) : "正文检查";
      li.innerHTML =
        '<div class="hi-top"><span class="hi-tag">' + esc(tag) + "</span><span class=\"hi-time\">" + timeText(h.ts) + "</span></div>" +
        '<div class="hi-sum">' + esc(h.summary) + "</div>" +
        (h.excerpt ? '<div class="hi-ex">' + esc(h.excerpt) + "</div>" : "");
      li.addEventListener("click", function () { restoreHistory(h); });
      box.appendChild(li);
    });
  }

  function restoreHistory(h) {
    if (h.kind === "search") {
      openSearch(h.genre);
      $("#queryInput").value = h.query || "";
      runSearch(h.query || "", true);
    } else {
      state.doc.original = h.original != null ? h.original : h.text;
      state.doc.current = h.text;
      state.doc.undo = [];
      state.doc.applied = [];
      $("#docInput").value = h.text;
      updateCount();
      doAnalyze(true);
      switchBottomTab("render");
    }
    toast("已恢复这条记录");
  }

  /* ───────────── 顶部：四个入口 ───────────── */
  function buildGenreGrid() {
    var grid = $("#genreGrid");
    grid.innerHTML = "";
    var order = [["小说", 1], ["散文", 2], ["戏剧", 3], ["诗歌", 4]];
    order.forEach(function (pair) {
      var g = pair[0], lvl = pair[1];
      var card = el("button", "genre-card lvl" + lvl);
      card.type = "button";
      card.title = D.GENRE_META[g].hint;
      card.innerHTML =
        '<span class="gc-top"><span class="gc-icon">' + genreIcon(g) + "</span>" +
        '<span class="gc-name">' + g + "</span></span>" +
        '<span class="gc-desc">' + esc(D.GENRE_META[g].desc) + "</span>";
      card.addEventListener("click", function () { openSearch(g); });
      grid.appendChild(card);
    });
  }

  function genreIcon(g) {
    var common = 'viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
    if (g === "小说") return '<svg ' + common + '><path d="M5 7.5c3.6-1.5 7.3-1.5 11 0v17c-3.7-1.5-7.4-1.5-11 0z"/><path d="M27 7.5c-3.6-1.5-7.3-1.5-11 0v17c3.7-1.5 7.4-1.5 11 0z"/><path d="M9 12h4M19 12h4M9 16h4"/></svg>';
    if (g === "散文") return '<svg ' + common + '><path d="M6 25c6-.5 8-3 8-9V7"/><path d="M14 7c6 0 12 2.5 12 8 0 3.4-2.6 5.2-5.6 5.2-2.4 0-4.2-1.5-4.2-3.5 0-1.8 1.3-3 3-3"/><path d="M6 25h9"/></svg>';
    if (g === "戏剧") return '<svg ' + common + '><path d="M8 6h16v10c0 4.4-3.6 8-8 8s-8-3.6-8-8z"/><path d="M12 11.5c1.4 1.2 2.8 1.2 4 0M19.2 11.5c-1.4 1.2-2.8 1.2-4 0"/><path d="M16 24v3M12 27h8"/></svg>';
    return '<svg ' + common + '><path d="M16 4v22"/><path d="M16 9c0-3 2.5-4.5 5-4.5 0 3-2 5-5 5z"/><path d="M16 9c0-3-2.5-4.5-5-4.5 0 3 2 5 5 5z"/><path d="M16 16c0-3 2.5-4.5 5-4.5 0 3-2 5-5 5z"/><path d="M16 16c0-3-2.5-4.5-5-4.5 0 3 2 5 5 5z"/></svg>';
  }

  function openSearch(genre) {
    state.genre = genre;
    $("#genreGrid").hidden = true;
    $("#introBlock").hidden = true;
    $("#searchView").hidden = false;
    $all(".genre-tab").forEach(function (t) { t.classList.toggle("on", t.dataset.g === genre); });
    $("#searchPlaceholder").textContent = "";
    $("#queryInput").placeholder = "在「" + genre + "」里找写过同样意象的句子 · " + D.GENRE_META[genre].hint;
    $("#results").innerHTML = '<div class="results-hint">写下你正在想的词或句子，再点右侧的「检索」。<br><small>剪枝会把它拆成具体的意象，直接去找同时写了这些意象的作品，并把那一句摆出来。<br>例：雪夜 → 雪 + 夜；旧信、蝉鸣、不肯说出口的告别</small></div>';
    $("#queryInput").focus();
  }

  function closeSearch() {
    $("#searchView").hidden = true;
    $("#genreGrid").hidden = false;
    $("#introBlock").hidden = false;
    state.genre = null;
    state.lastSearch = null;
  }

  function buildTabs() {
    var box = $("#genreTabs");
    box.innerHTML = "";
    ["小说", "散文", "戏剧", "诗歌"].forEach(function (g) {
      var b = el("button", "genre-tab", g);
      b.type = "button";
      b.dataset.g = g;
      b.addEventListener("click", function () {
        state.genre = g;
        $all(".genre-tab").forEach(function (t) { t.classList.toggle("on", t.dataset.g === g); });
        $("#searchPlaceholder").textContent = "";
        $("#queryInput").placeholder = "在「" + g + "」里找写过同样意象的句子 · " + D.GENRE_META[g].hint;
        if ($("#queryInput").value.trim()) runSearch($("#queryInput").value, true);
      });
      box.appendChild(b);
    });
  }

  /* ───────────── 检索 ───────────── */
  function runSearch(query, resetBatch) {
    var q = (query || "").trim();
    if (q.length < 1) { toast("先写下你想到的词或句子"); return; }
    aiWords = [];
    state.aiUsed = [];
    state.aiError = "";
    if (state.settings.aiExpand) {
      if (!state.settings.aiKey) {
        toast("联网扩词已打开，但设置里还没填 API Key——先用本地词库检索");
      } else {
        var btn = $("#searchBtn");
        btn.disabled = true;
        btn.textContent = "扩词中…";
        expandQuery(q).then(function (words) {
          aiWords = (words || []).filter(function (w) { return w.length <= 6; });
          state.aiUsed = aiWords.slice(0);
        }).catch(function (err) {
          state.aiError = String((err && err.message) || err);
          toast("联网扩词失败（" + state.aiError + "），已改用本地词库");
        }).then(function () {
          btn.disabled = false;
          btn.textContent = "检索";
          doSearch(q, resetBatch);
        });
        return;
      }
    }
    doSearch(q, resetBatch);
  }

  function doSearch(q, resetBatch) {
    var res = searchScenes(state.genre, q);
    state.lastSearch = { query: q, genre: state.genre, res: res, batch: resetBatch ? 0 : (state.lastSearch && state.lastSearch.genre === state.genre && state.lastSearch.query === q ? state.lastSearch.batch : 0) };
    renderResults();
    if (resetBatch) {
      pushHistory({
        kind: "search",
        genre: state.genre,
        query: q,
        summary: state.genre + " · 检索「" + q.slice(0, 18) + (q.length > 18 ? "…" : "") + "」",
        excerpt: res.items.length
          ? "拆出意象 " + res.units.join("、") + " · 首条《" + res.items[0].work[0] + "》"
          : "这些词没有在作品句库里同时出现"
      });
    }
  }

  function renderResults() {
    var s = state.lastSearch;
    if (!s) return;
    var box = $("#results");
    box.innerHTML = "";
    var strict = s.res.strict || [];
    var loose = s.res.loose || [];

    /* 从你写的话里拆出来的意象 + 「恨海情天」矢量 */
    var tagbar = el("div", "tagbar");
    tagbar.innerHTML = "从你写的词里拆出：" +
      s.res.units.slice(0, 8).map(function (u) { return '<i class="ptag">' + esc(u) + "</i>"; }).join("") +
      ((s.res.moodChars && s.res.moodChars.length)
        ? '<span class="tagbar-note">情绪线索（不要求同句出现，只影响情感矢量）：</span>' +
          s.res.moodChars.map(function (u) { return '<i class="ptag mood-soft">' + esc(u) + "</i>"; }).join("")
        : "") +
      '<span class="tagbar-note">只找同一句里同时写了这些意象的作品</span>' +
      (s.res.queryHasMood
        ? '<div class="tagbar-note love-line">与「恨海情天」的关系（你写的词）：' +
          relationChips(s.res.queryRelation) + "</div>"
        : "") +
      ((state.aiUsed && state.aiUsed.length)
        ? '<div class="tagbar-note love-line">AI 扩词（联网，只发了你写的这几个字）：' +
          state.aiUsed.map(function (w) { return '<i class="ptag ai-tag">' + esc(w) + "</i>"; }).join("") + "</div>"
        : "") +
      (state.aiError
        ? '<div class="tagbar-note love-line">联网扩词没成功（' + esc(state.aiError) + "），这次是本地词库的结果。</div>"
        : "");
    box.appendChild(tagbar);

    if (!strict.length && !loose.length) {
      var none = el("div", "no-result");
      none.innerHTML = "<b>没有找到同时写到这些意象的句子。</b>" +
        (s.res.missing.length ? "<p>句库里还没有：" + s.res.missing.map(function (u) { return "「" + esc(u) + "」"; }).join("") + "。</p>" : "") +
        "<p>可以少给一个词，或换一个更具体的意象再试——剪枝只按你真的写下的词去找。</p>";
      box.appendChild(none);
      return;
    }

    /* 全部条目：先按「恨海情天」相关度排，沾边不够的也照样列，只是排在下面 */
    var ordered = strict.concat(loose);
    var byMood = function (a, b) {
      return (b.relOK - a.relOK) || (b.relScore - a.relScore) ||
        a.region - b.region || a.tier - b.tier || b.s01 - a.s01;
    };
    var byMatch = function (a, b) {
      return a.tier - b.tier || a.region - b.region ||
        (b.relOK - a.relOK) || (b.relScore - a.relScore) || b.s01 - a.s01;
    };
    var sortMode = state.settings.searchSort === "match" ? "match" : "mood";
    ordered.sort(sortMode === "match" ? byMatch : byMood);
    var relOkCount = ordered.filter(function (r) { return r.relOK; }).length;
    var total = ordered.length;

    var head = el("div", "results-head");
    head.innerHTML =
      "<span>「" + esc(s.query.slice(0, 18)) + (s.query.length > 18 ? "…" : "") + "」相关句子 " + total + " 条 · 其中与爱恨纠缠最相关的 " + relOkCount + " 条</span>" +
      '<span class="rh-meta"><button class="sort-btn' + (sortMode === "mood" ? " on" : "") + '" data-sort="mood" type="button">情天优先</button>' +
      '<button class="sort-btn' + (sortMode === "match" ? " on" : "") + '" data-sort="match" type="button">命中优先</button></span>';
    box.appendChild(head);
    head.querySelectorAll(".sort-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        state.settings.searchSort = b.dataset.sort;
        saveSettings();
        renderResults();
      });
    });

    var start = total > 10 ? (s.batch * 10) % total : 0;
    var shown = [];
    for (var i = 0; i < Math.min(10, total); i++) shown.push(ordered[(start + i) % total]);

    var lowSepShown = false;
    var list = el("ol", "result-list");
    shown.forEach(function (r, idx) {
      if (!r.relOK && !lowSepShown) {
        lowSepShown = true;
        list.appendChild(el("li", "result-sep as-li",
          "<b>以下与爱恨纠缠关系不大</b><span>意象对得上，按相关度排在后面，供你参考</span>"));
      }
      list.appendChild(resultNode(r, idx));
    });
    box.appendChild(list);

    box.scrollTop = 0;
    $("#refreshBtn").classList.remove("pulse");
    void $("#refreshBtn").offsetWidth;
    $("#refreshBtn").classList.add("pulse");
  }

  function relationChips(r) {
    var out = [];
    if (r.love >= 0.3) out.push('<i class="ptag mood">爱意 ' + Math.round(r.love * 100) + "%</i>");
    if (r.hate >= 0.3) out.push('<i class="ptag mood">恨意 ' + Math.round(r.hate * 100) + "%</i>");
    if (r.tangle >= 0.3) out.push('<i class="ptag mood">纠缠 ' + Math.round(r.tangle * 100) + "%</i>");
    return out.join("") || '<i class="ptag mood soft">未识别到爱恨词</i>';
  }

  function resultNode(r, idx) {
    {
      var li = el("li", "result-item");
      var inTextSet = r.inText || [];
      var allInText = r.hits.every(function (h) { return inTextSet.indexOf(h) >= 0; });
      var lead = r.tier === 5 ? "这句没写这个词，但写的是同一个场景："
        : (allInText ? "这句里同时有：" : "这一段里同时写着：");
      var unitLine = lead + r.hits.map(function (h) {
        var how = (r.how && r.how[h]) ? r.how[h].how : (inTextSet.indexOf(h) >= 0 ? "text" : "tag");
        if (how === "scene") {
          return '<i class="hit scene">' + esc(h) + "·同场景（" + esc((r.how[h].scene || "")) + "）</i>";
        }
        if (how === "ai") {
          return '<i class="hit ai">' + esc(h) + "·AI扩词（" + esc((r.how[h].term || "")) + "）</i>";
        }
        if (how === "family") {
          return '<i class="hit family">' + esc(h) + "·同族（" + esc((r.how[h].term || "")) + "）</i>";
        }
        return '<i class="hit' + (how === "text" ? "" : " tagged") + '">' + esc(h) + (how === "text" ? "" : "·标注") + "</i>";
      }).join("") +
        (r.missing.length ? '<span class="ri-miss">（这句里没有：' + esc(r.missing.join("、")) + "）</span>" : "");
      var nearText = r.tier === 1 ? "整词连写"
        : r.tier === 2 ? "两词紧邻"
        : r.tier === 3 ? (r.tagCount ? "同句共现 · 含场景标注" : "同句但相距较远")
        : r.tier === 4 ? "只命中一部分"
        : r.tier === 5 ? "相关场景"
        : "AI 扩词命中";
      li.innerHTML =
        '<span class="ri-rank">' + String(idx + 1).padStart(2, "0") + "</span>" +
        '<div class="ri-main">' +
        '<div class="ri-title"><b>《' + esc(r.work[0]) + "》</b><span>" + esc(r.work[1]) + " · " + esc(r.work[2]) + "</span>" +
        '<i class="ri-kind">' + (r.line.quote ? "原文" : "场景概述") + "</i>" +
        '<i class="ri-kind ghost">' + nearText + "</i></div>" +
        '<blockquote class="ri-line">' + highlightLine(r.line.x, r.hits) + "</blockquote>" +
        '<div class="ri-why">' + unitLine +
        '<span class="ri-mood">情天 ' + Math.round(r.relScore * 100) + "%" +
        (relationLabel(r.relation).length ? " · " + relationLabel(r.relation).join("·") : "") + "</span></div>" +
        "</div>" +
        '<div class="ri-score"><span class="ring" style="--p:' + r.score + '"><i>' + r.score + "%</i></span></div>";
      return li;
    }
  }

  function refreshBatch() {
    if (!state.lastSearch) { toast("先做一次检索，再换一组"); return; }
    var total = state.lastSearch.res.items.length;
    state.lastSearch.batch = (state.lastSearch.batch + 1) % Math.max(1, Math.ceil(total / 10));
    renderResults();
    pushHistory({
      kind: "search",
      genre: state.lastSearch.genre,
      query: state.lastSearch.query,
      summary: state.lastSearch.genre + " · 换一组「" + state.lastSearch.query.slice(0, 14) + "」",
      excerpt: "第 " + (state.lastSearch.batch + 1) + " 组结果"
    });
  }

  /* ───────────── 底部：正文检查 ───────────── */
  function updateCount() {
    var n = $("#docInput").value.length;
    var el2 = $("#charCount");
    el2.textContent = n.toLocaleString("zh-CN") + " / 20,000";
    el2.classList.toggle("warn", n > 18000);
    el2.classList.toggle("over", n > 20000);
  }

  function switchBottomTab(which) {
    state.view = which;
    $all(".btab").forEach(function (t) { t.classList.toggle("on", t.dataset.view === which); });
    $("#docInput").hidden = which !== "edit";
    $("#docRender").hidden = which !== "render";
    $("#sendBtn").hidden = which !== "edit";
    $("#clearDoc").hidden = which !== "edit";
  }

  /* 清空文本框：带确认，绝不静默丢字 */
  function clearDoc() {
    var text = $("#docInput").value;
    if (!text.trim()) { toast("文本框已经是空的"); return; }
    var msg = state.doc.analysis
      ? "清空文本框？\n\n这段正文已经检查过，仍然可以从左边的历史记录里找回。"
      : "清空文本框？\n\n这段内容还没有点过检查，清空后无法找回。";
    if (!confirm(msg)) return;
    $("#docInput").value = "";
    state.doc.original = null;
    state.doc.current = "";
    state.doc.analysis = null;
    state.doc.applied = [];
    state.doc.undo = [];
    state.doc.dirty = false;
    navState.word = null;
    navState.index = 0;
    $("#analysis").hidden = true;
    $("#analysis").innerHTML = "";
    $("#docRender").innerHTML = "";
    $("#staleWarn").hidden = true;
    updateCount();
    switchBottomTab("edit");
    $("#docInput").focus();
    toast("文本框已清空");
  }

  function doAnalyze(silent) {
    var text = $("#docInput").value;
    if (!text.trim()) { toast("还没有正文可以检查"); return; }
    if (state.doc.original == null || state.doc.current !== text) {
      state.doc.original = text;
      state.doc.undo = [];
      state.doc.applied = [];
    }
    state.doc.current = text;
    var a = analyze(text, state.settings);
    state.doc.analysis = a;
    state.doc.dirty = false;
    renderAnalysis();
    renderDoc();
    switchBottomTab("render");
    if (!silent) {
      var top = a.adverbs.concat(a.routine).slice(0, 2).map(function (r) { return r.w; }).join("、");
      var topWord = a.words.slice(0, 3).map(function (r) { return r.w; }).join("、");
      pushHistory({
        kind: "check",
        genre: null,
        text: text,
        original: state.doc.original,
        summary: "正文检查 · " + text.length + " 字 · " + (top || topWord || "未发现可替换处"),
        excerpt: a.flagged.length
          ? ("可替换处 " + countOccurrences(text, a.flagged) + " 个" +
             (a.imagery.filter(function (f) { return f.count >= 2; }).length ? " · 关键意象 " + a.imagery.filter(function (f) { return f.count >= 2; }).length + " 个未标记" : ""))
          : "暂未发现审美疲劳点"
      });
    }
  }

  function countOccurrences(text, flagged) {
    var taken = new Uint8Array(text.length), total = 0;
    flagged.slice().sort(function (a, b) { return b.w.length - a.w.length; }).forEach(function (f) {
      var idx = -1;
      while ((idx = text.indexOf(f.w, idx + 1)) !== -1) {
        var free = true;
        for (var i = idx; i < idx + f.w.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (var j = idx; j < idx + f.w.length; j++) taken[j] = 1;
        total++;
      }
    });
    return total;
  }

  function renderAnalysis() {
    var a = state.doc.analysis;
    var panel = $("#analysis");
    if (!a) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = "";
    panel.scrollTop = 0;

    function pickChip(item, html, extra) {
      var chip = el("span", "flag-chip pickable" + (extra ? " " + extra : ""), html);
      chip.dataset.w = item.w;
      chip.title = "点击定位「" + item.w + "」在正文里的位置";
      return chip;
    }

    var head = el("div", "ana-head");
    head.innerHTML =
      "<h3>正文体检</h3><p>" + a.chars.toLocaleString("zh-CN") + " 字 · 实词 " + a.totalTokens + " 处 · 高频判定线：占比 ≥" +
      (a.densityCut * 100).toFixed(1) + "% 或 ≥" + a.hardCount + " 次</p>";
    panel.appendChild(head);

    /* 1. 常态副词：最先看这一类 */
    var ab = el("div", "ana-block");
    ab.appendChild(el("h4", null, "需要注意 · 常态副词"));
    if (!a.adverbs.length) {
      ab.appendChild(el("div", "ana-empty", "没有反复出现的常态副词。"));
    } else {
      var ac = el("div", "flag-chips");
      a.adverbs.forEach(function (f) {
        ac.appendChild(pickChip(f, f.w + " · " + f.count + " 次"));
      });
      ab.appendChild(ac);
    }
    panel.appendChild(ab);

    /* 2. 常态化表述 */
    var rb = el("div", "ana-block");
    rb.appendChild(el("h4", null, "需要注意 · 常态化表述"));
    if (!a.routine.length) {
      rb.appendChild(el("div", "ana-empty", "没有发现反复出现的固定表达。"));
    } else {
      var rc = el("div", "flag-chips");
      a.routine.forEach(function (f) {
        rc.appendChild(pickChip(f, "⭕ " + f.w + '<i>' + f.count + " 次</i>" + (f.suggestions ? "" : '<b class="noc">无对应建议</b>')));
      });
      rb.appendChild(rc);
      rb.appendChild(el("p", "ana-note", "「皱了皱眉」「垂下眼眸」「深吸一口气」这一类，是读者最容易滑过去、也最容易读腻的地方——它们重复的是同一个动作姿势，而不是场景。剪枝会在正文里标出它们，并给出方向不同的其他说法。"));
    }
    panel.appendChild(rb);

    /* 3. 高频实词 */
    var wb = el("div", "ana-block");
    wb.appendChild(el("h4", null, "需要注意 · 反复出现的实词"));
    if (!a.words.length) {
      wb.appendChild(el("div", "ana-empty", "没有实词越过判定线，节奏是匀的。"));
    } else {
      var max = Math.max.apply(null, a.words.map(function (r) { return r.count; }));
      a.words.slice(0, 10).forEach(function (t) {
        var row = el("div", "ana-row fatigue");
        row.classList.add("pickable");
        row.dataset.w = t.w;
        row.innerHTML =
          '<span class="ar-w">' + esc(t.w) + "</span>" +
          '<span class="ar-bar"><i style="width:' + Math.round(t.count / max * 100) + '%"></i></span>' +
          '<span class="ar-n">' + t.count + " 次</span>";
        wb.appendChild(row);
      });
    }
    panel.appendChild(wb);

    /* 4. 关键意象 */
    var ib = el("div", "ana-block");
    ib.appendChild(el("h4", null, "本文关键意象 · 不标记"));
    var shownImagery = a.imagery.filter(function (f) { return f.count >= 2; }).slice(0, 10);
    if (!shownImagery.length) {
      ib.appendChild(el("div", "ana-empty", "没有识别到场景型意象。"));
    } else {
      var ic = el("div", "flag-chips calm");
      shownImagery.forEach(function (f) {
        ic.appendChild(pickChip(f, esc(f.w) + '<i>' + f.count + " 次 · " + f.paraCount + " 段</i>", "calm"));
      });
      ib.appendChild(ic);
      ib.appendChild(el("p", "ana-note", "雪、月、夜色、灯光这类词是文章的场景骨架，也是情绪本身。它们分散在多个段落里反复出现属于风格，不构成疲劳，所以剪枝不会标记它们，也不会给你「换个说法」的建议。"));
    }
    panel.appendChild(ib);

    panel.appendChild(el("p", "ana-note tips", "点一下上面的词，正文会跳到它第 1 次出现的位置；再点一下，跳到第 2 次，依次往下。"));
    var dis = el("div", "ana-disclaimer", "剪枝只提示可能读腻的地方，不替你写句子。");
    panel.appendChild(dis);
  }

  /* ───────────── 正文高亮渲染 ───────────── */
  /* ── 点击面板里的词 → 依次跳到它在正文中的第 1、2、3……次出现 ── */
  var navState = { word: null, index: 0 };
  function occurrencesOf(text, w) {
    var out = [], i = -1;
    if (!w) return out;
    while ((i = text.indexOf(w, i + 1)) !== -1) out.push(i);
    return out;
  }
  function gotoOccurrence(word) {
    var text = state.doc.current || "";
    var occ = occurrencesOf(text, word);
    if (!occ.length) { toast("正文里没有找到「" + word + "」"); return; }
    navState.index = navState.word === word ? (navState.index + 1) % occ.length : 0;
    navState.word = word;
    var pos = occ[navState.index];
    var label = "「" + word + "」第 " + (navState.index + 1) + " / " + occ.length + " 次出现";
    /* 左侧同步高亮：切到高亮视图，把这处标出来 */
    if (state.view !== "render") switchBottomTab("render");
    renderDoc();
    scrollToNav(label);
  }

  /* 把当前定位到的词在正文里全部标出来，当前这一处最醒目 */
  function applyNavMarks(root) {
    if (!navState.word) return;
    var pre = root.querySelector(".doc-text") || root.querySelector(".plain-text");
    if (!pre) return;
    var text = state.doc.current || "";
    var occ = occurrencesOf(text, navState.word);
    if (!occ.length) return;
    var nodes = [], walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null), node, acc = 0;
    while ((node = walker.nextNode())) { nodes.push({ node: node, start: acc }); acc += node.nodeValue.length; }
    var active = occ[navState.index];
    for (var i = occ.length - 1; i >= 0; i--) {
      var s = occ[i], e = s + navState.word.length, host = null;
      for (var k = 0; k < nodes.length; k++) {
        var nd = nodes[k];
        if (s >= nd.start && e <= nd.start + nd.node.nodeValue.length) { host = nd; break; }
      }
      if (!host) continue;
      var range = document.createRange();
      range.setStart(host.node, s - host.start);
      range.setEnd(host.node, e - host.start);
      var span = document.createElement("span");
      span.className = "nav-hit" + (s === active ? " cur" : "");
      try { range.surroundContents(span); } catch (err) {}
    }
  }
  function scrollToNav(label) {
    var anchor = document.querySelector("#docRender .nav-hit.cur") ||
                 document.querySelector("#docRender .nav-hit");
    if (!anchor) { toast(label); return; }
    anchor.scrollIntoView({ block: "center", behavior: "smooth" });
    anchor.classList.add("flash");
    setTimeout(function () { anchor.classList.remove("flash"); }, 1700);
    toast(label);
  }

  function buildSegments(text, flagged) {
    var taken = new Uint8Array(text.length);
    var segs = [];
    flagged.slice().sort(function (a, b) { return b.w.length - a.w.length; }).forEach(function (f) {
      var idx = -1;
      while ((idx = text.indexOf(f.w, idx + 1)) !== -1) {
        var free = true;
        for (var i = idx; i < idx + f.w.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (var j = idx; j < idx + f.w.length; j++) taken[j] = 1;
        segs.push({ s: idx, e: idx + f.w.length, w: f.w, count: f.count });
      }
    });
    segs.sort(function (a, b) { return a.s - b.s; });
    return segs;
  }

  function renderDoc() {
    var box = $("#docRender");
    var text = state.doc.current || "";
    var a = state.doc.analysis;
    if (!a) { box.innerHTML = ""; return; }
    if (!state.settings.suggest) {
      box.innerHTML =
        '<div class="lock-note"><b>替换建议未开启</b><p>剪枝不会主动改动你的正文。开启后才显示可替换词与建议。</p>' +
        '<button class="btn primary" id="lockOpen">去设置里开启</button>' +
        '<button class="btn tiny" id="clearDoc2">清空</button></div>' +
        '<pre class="plain-text">' + esc(text) + "</pre>";
      var b = $("#lockOpen");
      if (b) b.addEventListener("click", function () { openSettings(true); });
      var q2 = $("#clearDoc2");
      if (q2) q2.addEventListener("click", clearDoc);
      applyNavMarks(box);
      return;
    }
    var segs = buildSegments(text, a.flagged);
    var html = "", cursor = 0;
    segs.forEach(function (sg) {
      html += esc(text.slice(cursor, sg.s));
      html += '<mark class="hl" data-s="' + sg.s + '" data-e="' + sg.e + '" data-w="' + esc(sg.w) + '">' + esc(sg.w) + "</mark>";
      cursor = sg.e;
    });
    html += esc(text.slice(cursor));
    box.innerHTML =
      '<div class="render-bar"><span>浅绿处 = 可替换词（共 ' + segs.length + ' 处），鼠标停留 0.618 秒看建议</span>' +
      '<span class="render-actions">' +
      (state.doc.applied.length ? '<button class="btn tiny" id="undoBtn">撤销上次替换</button>' : "") +
      '<button class="btn tiny" id="restoreBtn">还原原文</button>' +
      '<button class="btn tiny" id="copyBtn">复制正文</button>' +
      '<button class="btn tiny" id="clearDoc2">清空</button>' +
      "</span></div>" +
      '<pre class="doc-text">' + html + "</pre>";
    var u = $("#undoBtn"); if (u) u.addEventListener("click", undoReplace);
    var r = $("#restoreBtn"); if (r) r.addEventListener("click", restoreOriginal);
    var q = $("#clearDoc2"); if (q) q.addEventListener("click", clearDoc);
    var c = $("#copyBtn"); if (c) c.addEventListener("click", function () {
      navigator.clipboard.writeText(state.doc.current).then(function () { toast("已复制当前正文（你的原文，未改动）"); }, function () { toast("复制失败，请手动选择文本"); });
    });
    applyNavMarks(box);
  }

  function restoreOriginal() {
    if (state.doc.original == null) return;
    if (state.doc.current === state.doc.original) { toast("当前就是你的原文"); return; }
    state.doc.undo.push(state.doc.current);
    state.doc.current = state.doc.original;
    $("#docInput").value = state.doc.original;
    updateCount();
    state.doc.analysis = analyze(state.doc.original, state.settings);
    state.doc.applied = [];
    renderAnalysis(); renderDoc();
    toast("已还原为你最初粘贴的原文");
  }

  function undoReplace() {
    if (!state.doc.undo.length) return;
    state.doc.current = state.doc.undo.pop();
    state.doc.applied.pop();
    $("#docInput").value = state.doc.current;
    updateCount();
    state.doc.analysis = analyze(state.doc.current, state.settings);
    renderAnalysis(); renderDoc();
    toast("已撤销上一次替换");
  }

  function applyReplace(s, e, from, to) {
    if (!state.settings.suggest) { openSettings(true); return; }
    var text = state.doc.current;
    if (text.slice(s, e) !== from) { toast("文本已变动，请重新检查后再替换"); return; }
    state.doc.undo.push(text);
    if (state.doc.undo.length > 60) state.doc.undo.shift();
    var next = text.slice(0, s) + to + text.slice(e);
    state.doc.current = next;
    state.doc.applied.push({ from: from, to: to, at: s });
    $("#docInput").value = next;
    updateCount();
    state.doc.analysis = analyze(next, state.settings);
    renderAnalysis(); renderDoc();
    toast("已替换 1 处：「" + from + "」→「" + to + "」（可撤销）");
  }

  /* ───────────── 悬浮建议 ───────────── */
  var tipTimer = null, tipEl = null, hideTimer = null;
  function ensureTip() {
    if (!tipEl) {
      tipEl = el("div", "repl-tip");
      /* 鼠标移进提示条时不要收起来，否则建议按钮根本点不到 */
      tipEl.addEventListener("mouseenter", function () {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      });
      tipEl.addEventListener("mouseleave", function () { scheduleHide(120); });
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function scheduleHide(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (tipEl) tipEl.classList.remove("show");
    }, ms);
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (tipEl) tipEl.classList.remove("show");
  }
  function bindHover() {
    var box = $("#docRender");
    box.addEventListener("mouseover", function (ev) {
      var m = ev.target.closest ? ev.target.closest("mark.hl") : null;
      if (!m) return;
      hideTip();
      var delay = state.settings.tooltipDelay || 618;
      tipTimer = setTimeout(function () { showTip(m); }, delay);
    });
    box.addEventListener("mouseout", function (ev) {
      var m = ev.target.closest ? ev.target.closest("mark.hl") : null;
      if (!m) return;
      scheduleHide(280); /* 留一点时间把鼠标移到建议上 */
    });
    document.addEventListener("scroll", hideTip, true);
  }
  function showTip(m) {
    var w = m.dataset.w;
    var s = +m.dataset.s, e = +m.dataset.e;
    var a = state.doc.analysis || { flagged: [] };
    var rec = a.flagged.filter(function (f) { return f.w === w; })[0] || { count: 1, kind: "word" };
    var sugg = rec.suggestions || D.SYNONYMS[w] || D.ROUTINE_PHRASES[w] || null;
    var tip = ensureTip();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    var label = rec.kind === "routine" ? "常态化表述" : "高频实词";
    var html = '<div class="tip-head"><b>' + esc(w) + '</b><span class="tip-kind">' + label + " · " + rec.count + " 次</span></div>";
    if (rec.reason) html += '<div class="tip-why">' + esc(rec.reason) + "</div>";
    if (sugg) {
      html += '<div class="tip-sub">可以换成</div><div class="tip-opts">' +
        sugg.map(function (x) { return '<button class="tip-opt" data-to="' + esc(x) + '">' + esc(x) + "</button>"; }).join("") + "</div>";
    } else {
      html += '<div class="tip-sub">词表里暂无对应建议</div><div class="tip-none">这个位置可考虑换成更具体的动作或物件。</div>';
    }
    html += '<div class="tip-foot">' + D.TOOLTIP_NOTE + '</div>';
    tip.innerHTML = html;
    tip.querySelectorAll(".tip-opt").forEach(function (b) {
      b.addEventListener("click", function (ev2) {
        ev2.stopPropagation();
        hideTip();
        applyReplace(s, e, w, b.dataset.to);
      });
    });
    var r = m.getBoundingClientRect();
    tip.classList.add("show");
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = clamp(r.left + r.width / 2 - tw / 2, 12, window.innerWidth - tw - 12);
    var top = r.top - th - 10;
    if (top < 8) top = r.bottom + 10;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  /* ───────────── 设置 ───────────── */
  function openSettings(fromLock) {
    $("#settingsModal").hidden = false;
    syncSettingsUI();
    $("#settingsModal").dataset.fromLock = fromLock ? "1" : "";
  }
  function closeSettings() { $("#settingsModal").hidden = true; }
  function syncSettingsUI() {
    $("#setSuggest").checked = !!state.settings.suggest;
    $("#setNames").checked = !!state.settings.filterNames;
    $("#setAI").checked = !!state.settings.aiExpand;
    $("#aiBase").value = state.settings.aiBase || "";
    $("#aiModel").value = state.settings.aiModel || "";
    $("#aiKey").value = state.settings.aiKey || "";
    $all(".seg-btn").forEach(function (b) { b.classList.toggle("on", b.dataset.v === state.settings.sensitivity); });
  }
  function bindSettings() {
    $("#setSuggest").addEventListener("change", function () {
      state.settings.suggest = this.checked; saveSettings();
      toast(this.checked ? "替换建议已开启：只提示，不改写" : "替换建议已关闭：剪枝不会标出任何替换词");
      renderDoc();
    });
    $("#setNames").addEventListener("change", function () {
      state.settings.filterNames = this.checked; saveSettings(); reanalyzeIfReady();
    });
    $("#setAI").addEventListener("change", function () {
      state.settings.aiExpand = this.checked; saveSettings();
      toast(this.checked ? "联网扩词已开启：只发送你输入的关键词，不发送正文" : "联网扩词已关闭：检索不联网");
    });
    ["aiBase", "aiModel", "aiKey"].forEach(function (id) {
      $("#" + id).addEventListener("change", function () {
        state.settings[id] = this.value.trim();
        saveSettings();
        toast("已保存到本机浏览器");
      });
    });
    $all(".seg-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        state.settings.sensitivity = b.dataset.v; saveSettings(); syncSettingsUI(); reanalyzeIfReady();
      });
    });
    $("#settingsClose").addEventListener("click", closeSettings);
    $("#clearHistory").addEventListener("click", function () {
      if (!state.history.length) return;
      if (confirm("清空全部输入历史？此操作不可恢复。")) {
        state.history = []; saveHistory(); renderHistory(); toast("历史已清空");
      }
    });
    $("#resetSettings").addEventListener("click", function () {
      state.settings = Object.assign({}, DEFAULT_SETTINGS);
      saveSettings(); syncSettingsUI(); renderDoc(); toast("设置已恢复默认");
    });
  }
  function reanalyzeIfReady() {
    if (state.doc.analysis && state.doc.current) {
      state.doc.analysis = analyze(state.doc.current, state.settings);
      renderAnalysis(); renderDoc();
    }
  }

  /* ───────────── 首次引导 ───────────── */
  var introSteps = [
    {
      t: "欢迎来到剪枝",
      b: "<p>剪枝是一片叶子，也是一次修剪。写下的东西不必完美，读起来不累就够了。</p>" +
        "<p>这里的四片叶子（小说 / 散文 / 戏剧 / 诗歌）只做一件事：<b>照着你写下的词去找句子</b>。你写「雪夜」，它就拆成「雪」和「夜」，然后去文学史里找同时写了雪与夜的那一句，把它摆在你面前——不经过任何抽象概念。</p>"
    },
    {
      t: "关键词替换，是一道可关的门",
      b: "<p>粘贴正文后，剪枝只盯一件事：<b>你会不会读腻</b>。它先找出反复出现的常态化表述（「皱了皱眉」「垂下眼眸」「深吸一口气」这一类），再找出越过线的高频实词，用浅绿色标在正文里。鼠标停在上面 <b>0.618 秒</b>，会浮出几个方向不同的说法。</p>" +
        "<p>反过来，它<b>不标</b>三类东西：雪、月、夜色这类本文关键意象；人名、昵称、你、我、他这类称呼与代词；以及的、地、得、了、吗、呢这类虚词。</p>" +
        "<p><b>替换建议默认关闭。</b>是否开启由你在设置里决定；即使开启，也只有你亲手点下某一个词，那一处才会改变，随时可以撤销或还原原文。</p>"
    },
    {
      t: "这里不是代写工具",
      b: "<p>剪枝只做文字检查：找重复、标位置、给方向。它不替你写句子，也不会替你决定故事怎么走，更不会擅自改动你的一个字。</p>" +
        "<p>灵感是你的，剪枝只帮你剪掉挡光的那几片叶子。</p>"
    }
  ];
  var introIdx = 0;
  function renderIntro() {
    var s = introSteps[introIdx];
    $("#introBody").innerHTML = "<h3>" + s.t + "</h3>" + s.b;
    $("#introDots").innerHTML = introSteps.map(function (_, i) { return '<i class="' + (i === introIdx ? "on" : "") + '"></i>'; }).join("");
    $("#introNext").textContent = introIdx === introSteps.length - 1 ? "我明白了，开始使用" : "下一步";
  }
  function showIntro() { introIdx = 0; renderIntro(); $("#introModal").hidden = false; }
  function closeIntro() {
    $("#introModal").hidden = true;
    try { localStorage.setItem(LS.seen, "1"); } catch (e) {}
  }

  /* ───────────── 提示条 ───────────── */
  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ───────────── 事件绑定 ───────────── */
  function bind() {
    $("#backToCards").addEventListener("click", closeSearch);
    $("#searchBtn").addEventListener("click", function () { runSearch($("#queryInput").value, true); });
    $("#zoomBtn").addEventListener("click", function () {
      var main = document.querySelector(".main");
      var on = main.classList.toggle("zoom-search");
      this.textContent = on ? "还原版面" : "放大检索区";
    });
    $("#queryInput").addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(this.value, true); });
    $("#refreshBtn").addEventListener("click", refreshBatch);
    $("#settingsBtn").addEventListener("click", function () { openSettings(false); });
    $("#helpBtn").addEventListener("click", showIntro);

    $("#sendBtn").addEventListener("click", function () { doAnalyze(false); });
    $("#clearDoc").addEventListener("click", clearDoc);
    $("#analysis").addEventListener("click", function (ev) {
      var t = ev.target.closest ? ev.target.closest(".pickable") : null;
      if (!t || !t.dataset.w) return;
      gotoOccurrence(t.dataset.w);
    });
    $("#docInput").addEventListener("input", function () {
      updateCount();
      if (state.doc.analysis) state.doc.dirty = true;
      var w = $("#staleWarn");
      if (w) w.hidden = !state.doc.dirty;
    });
    $("#docInput").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      /* 中文输入法正在选词时的回车不算发送 */
      if (e.isComposing || e.keyCode === 229) return;
      /* Shift+Enter 留作换行，方便自己分段 */
      if (e.shiftKey) return;
      /* Enter 直接发送，效果和点右下角 ↑ 完全一样 */
      e.preventDefault();
      doAnalyze(false);
    });
    /* 粘贴上限：绝不静默裁剪，超出就整段拒绝 */
    $("#docInput").addEventListener("paste", function (e) {
      var pasted = (e.clipboardData || window.clipboardData).getData("text") || "";
      if (!pasted) return;
      var ta = e.target;
      var selLen = ta.selectionEnd - ta.selectionStart;
      var after = ta.value.length - selLen + pasted.length;
      if (pasted.length > 20000 || after > 20000) {
        e.preventDefault();
        toast("单次最多 20000 字符：本次 " + pasted.length.toLocaleString("zh-CN") + " 字符，粘贴后为 " + after.toLocaleString("zh-CN") + "。为不改动你的文本，已取消本次粘贴。");
      }
    });
    $all(".btab").forEach(function (t) {
      t.addEventListener("click", function () {
        if (t.dataset.view === "render" && !state.doc.analysis) { toast("先点发送按钮检查一次正文"); return; }
        switchBottomTab(t.dataset.view);
      });
    });
    $("#introNext").addEventListener("click", function () {
      if (introIdx < introSteps.length - 1) { introIdx++; renderIntro(); } else closeIntro();
    });
    $("#introSkip").addEventListener("click", closeIntro);
    $all(".modal-mask").forEach(function (m) {
      m.addEventListener("click", function (e) { if (e.target === m) m.hidden = true; });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeSettings(); if (!$("#introModal").hidden) closeIntro(); hideTip(); }
    });
    window.addEventListener("resize", hideTip);
    window.addEventListener("scroll", hideTip);
  }

  /* ───────────── 启动 ───────────── */
  function init() {
    buildGenreGrid();
    buildTabs();
    bind();
    bindHover();
    bindSettings();
    renderHistory();
    updateCount();
    switchBottomTab("edit");
    var seen = false;
    try { seen = localStorage.getItem(LS.seen) === "1"; } catch (e) {}
    if (!seen) showIntro();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
