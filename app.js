/* 寶嚴菩薩戒分班系統 — 前台
   名單全部放在後端試算表，這個網頁本身不含任何個人資料。 */
(function () {
'use strict';

var BUILD = '20261018a';

/* ===================== 基礎 ===================== */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

/** 綁事件：元素不存在就安靜略過。HTML 與 JS 版本不同步時，少一個元素不該讓整支程式停掉。 */
function on(sel, ev, fn) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (el) el.addEventListener(ev, fn);
  else if (window.console) console.warn('找不到元素，略過綁定：' + sel);
  return el;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 密碼比對前先去掉前後空白（含全形）：手機鍵盤很容易多打一個 */
function cleanPw(s) { return String(s == null ? '' : s).replace(/^[\s　]+|[\s　]+$/g, ''); }

function toast(msg, bad) {
  var t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = ''; }, bad ? 4200 : 2300);
}

/* ===================== 狀態 ===================== */
var state = {
  settings: { title: '', classes: [] },
  people: [],        // 正規化後的戒子
  assigns: {},       // key -> {cls, note, at, by}（已存在後端的）
  pending: {},       // key -> {cls, note}（還沒存的）
  warn: { fmDup: [], personDup: [], bothVow: [], dataBad: [] },
  srcStat: [],
  srcInfo: '',
};
var pw = '';
var operator = '';
var role = 'admin';
var loadingPromise = null;
var printPick = '';
/** 目前在看哪一個戒別；空字串＝兩者都看。分班是給菩薩戒用的，所以預設菩薩戒。 */
var vowScope = '菩薩戒';

/** 目前作業範圍內的人（統計、看板、列印都以這個為準） */
function scoped() {
  if (!vowScope) return state.people;
  return state.people.filter(function (p) { return p.vow === vowScope; });
}
function scopeName() { return vowScope || '全部戒別'; }

function isGuest() { return role === 'guest'; }

function backendUrl() {
  var saved = (localStorage.getItem('psj_backend') || '').trim();
  if (saved) return saved;
  var cfg = ((window.CONFIG && window.CONFIG.backend) || '').trim();
  if (cfg) return cfg;
  // 本機測試：mock 後端跟網頁同一個 port
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return location.origin + '/exec';
  return '';
}

/* ===================== 後端 ===================== */
function api(action, payload, tries) {
  return rawApi(action, payload, tries).catch(function (e) {
    if (!e || e.code !== 'BAD_PASSWORD' || !$('#gate').hidden) throw e;
    return reauth().then(function (ok) {
      if (!ok) throw e;
      return rawApi(action, payload, tries);
    });
  });
}

function rawApi(action, payload, tries) {
  var url = backendUrl();
  if (!url) return Promise.reject(new Error('還沒設定後端網址（設定 → 後端網址）'));
  var body = Object.assign({ action: action, pw: pw, by: operator }, payload || {});
  tries = tries == null ? 4 : tries;

  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 25000) : null;

  return fetch(url, {
    method: 'POST',
    // 用 text/plain 送，避免瀏覽器先發 OPTIONS（Apps Script 不處理 preflight）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: ctrl ? ctrl.signal : undefined,
  })
    .then(function (r) { if (timer) clearTimeout(timer); return r.text(); })
    .then(function (txt) {
      var data;
      try { data = JSON.parse(txt); }
      catch (e) {
        // Google 偶爾回一頁 HTML 中繼頁，不是真的壞掉，重送就好
        var bad = new Error('連線被 Google 暫時擋下');
        bad.retryable = true;
        throw bad;
      }
      if (!data.ok) {
        var err = new Error(data.error || '操作失敗');
        err.code = data.code;
        throw err;
      }
      return data;
    })
    .catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') { e = new Error('連線逾時'); e.retryable = true; }
      var retryable = e.retryable || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      if (tries > 0 && retryable) {
        var waitMs = 700 * (5 - tries);
        return new Promise(function (res) { setTimeout(res, waitMs); })
          .then(function () { return rawApi(action, payload, tries - 1); });
      }
      if (retryable) e.message = '連不上系統（網路不穩或剛好在更新），等十秒再按一次';
      throw e;
    });
}

function reauth() {
  var v = window.prompt('密碼好像失效了，請再輸入一次：');
  if (v == null) return Promise.resolve(false);
  pw = cleanPw(v);
  return Promise.resolve(true);
}

/* ===================== 來源正規化 ===================== */
/* 四個分頁欄名各不相同，在這裡統一。後端只負責把原始列丟過來，正規化只有這一份。 */
var VOWS = ['菩薩戒', '三皈五戒'];

var SRC_DEFS = [
  { tab: '菩薩戒-線上', vow: '菩薩戒', kind: '線上',
    F: { seq: '流水號', name: '信眾姓名', fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '皈依師長', city: '縣市', note: '備註', active: '啟用', vows: ['增益戒'] } },
  { tab: '菩薩戒-紙本', vow: '菩薩戒', kind: '紙本',
    F: { seq: '流水號', name: '姓名', fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '推薦之分院/其他', city: '縣市', note: '寶', age: '年齡', job: '職業', vows: ['增益戒'] } },
  { tab: '三皈五戒-線上', vow: '三皈五戒', kind: '線上',
    F: { seq: '流水號', name: '信眾姓名', fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '', city: '', note: '備註', active: '啟用', vows: ['三皈依', '受五戒', '增益戒'] } },
  { tab: '三皈五戒-紙本', vow: '三皈五戒', kind: '紙本',
    F: { seq: '流水號', name: '姓名', fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '推薦之分院/其他', city: '', note: '寶', age: '年齡', job: '職業',
         vows: ['三皈依', '受五戒', '增益戒'] } },
];

/** 受戒項目欄是「✅ 是／❌ 否」，挑出有勾的，印成「皈依·五戒」這種短標 */
var VOW_SHORT = { '三皈依': '皈依', '受五戒': '五戒', '增益戒': '增益' };
function vowItems(header, row, names) {
  if (!names) return '';
  var out = [];
  names.forEach(function (n) {
    var v = pick(header, row, n);
    if (v && v.indexOf('是') >= 0 && v.indexOf('否') < 0) out.push(VOW_SHORT[n] || n);
  });
  return out.join('·');
}

function pick(header, row, colName) {
  if (!colName) return '';
  var i = header.indexOf(colName);
  return i < 0 ? '' : String(row[i] == null ? '' : row[i]).trim();
}

function parseDob(s) {
  var m = String(s || '').match(/(\d{4})\s*[\/\-年\.]\s*(\d{1,2})\s*[\/\-月\.]\s*(\d{1,2})/);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y: y, m: mo, d: d };
}

function ageOf(dob) {
  if (!dob) return null;
  var t = new Date();
  var a = t.getFullYear() - dob.y;
  var md = (t.getMonth() + 1) * 100 + t.getDate();
  if (md < dob.m * 100 + dob.d) a--;
  return a;
}

function digits(s) { return String(s || '').replace(/\D/g, '').replace(/^886/, '').replace(/^0+/, ''); }

function normalizeSource(src) {
  var people = [];
  state.srcStat = [];
  SRC_DEFS.forEach(function (def) {
    var blk = src[def.tab];
    if (!blk || !blk.header) { state.srcStat.push({ tab: def.tab, rows: 0, taken: 0, blank: 0, missing: true }); return; }
    var F = def.F;
    var header = blk.header;
    var taken = 0, blank = 0;
    (blk.rows || []).forEach(function (row, i) {
      var name = pick(header, row, F.name);
      // 紙本常常預留一堆只有流水號的空列，沒有姓名就不是真的報名者
      if (!name) { blank++; return; }
      taken++;
      var seq = pick(header, row, F.seq) || ('r' + (i + 1));
      var dobRaw = pick(header, row, F.dob);
      var dob = parseDob(dobRaw);
      var age = ageOf(dob);
      if (age == null && F.age) {
        var a = parseInt(pick(header, row, F.age), 10);
        if (!isNaN(a)) age = a;
      }
      var sex = pick(header, row, F.sex).toUpperCase();
      if (/男/.test(sex)) sex = 'M';
      if (/女/.test(sex)) sex = 'F';
      if (sex !== 'M' && sex !== 'F') sex = '';
      var activeRaw = F.active ? pick(header, row, F.active) : '';
      people.push({
        // key 一定要含戒別：菩薩戒 #1 與三皈五戒 #1 是不同的兩個人
        key: def.vow + '-' + def.kind + '-' + seq,
        vow: def.vow,
        src: def.kind,
        tab: def.tab,
        seq: seq,
        name: name,
        fm: pick(header, row, F.fm),
        sex: sex,
        dobRaw: dobRaw,
        dob: dob,
        age: age,
        phone: pick(header, row, F.phone),
        phoneKey: digits(pick(header, row, F.phone)),
        from: pick(header, row, F.from),
        city: pick(header, row, F.city),
        job: F.job ? pick(header, row, F.job) : '',
        items: vowItems(header, row, F.vows),
        note: pick(header, row, F.note),
        active: activeRaw ? /啟用/.test(activeRaw) : true,
      });
    });
    state.srcStat.push({ tab: def.tab, rows: (blk.rows || []).length, taken: taken, blank: blank });
  });
  return people;
}

/* ===================== 警示 ===================== */
/** 先把「同一個人」的多筆報名併成一群，再分辨兩種情形：
 *  · 同一個戒別裡出現兩筆 → 重複報名，要警示
 *  · 菩薩戒與三皈五戒各一筆 → 兩戒都受，是正常的，只標記不警示 */
function computeWarnings() {
  var people = state.people;
  var i, j;

  var byName = {};
  people.forEach(function (p) { (byName[p.name] = byName[p.name] || []).push(p); });
  var personDup = [];
  var bothVow = [];
  var clusterOf = {};             // key -> 群組代表 key
  people.forEach(function (p) { clusterOf[p.key] = p.key; });
  Object.keys(byName).forEach(function (n) {
    var g = byName[n];
    if (g.length < 2) return;
    for (i = 0; i < g.length; i++) for (j = i + 1; j < g.length; j++) {
      var a = g[i], b = g[j];
      var same = (a.fm && a.fm === b.fm) ||
                 (a.dobRaw && b.dobRaw && a.dobRaw === b.dobRaw) ||
                 (a.phoneKey && a.phoneKey === b.phoneKey);
      if (same) clusterOf[b.key] = clusterOf[a.key];
    }
    var groups = {};
    g.forEach(function (p) { (groups[clusterOf[p.key]] = groups[clusterOf[p.key]] || []).push(p); });
    Object.keys(groups).forEach(function (k) {
      var grp = groups[k];
      if (grp.length < 2) return;
      // 同一個戒別裡有兩筆以上，才是真的重複報名
      var perVow = {};
      grp.forEach(function (p) { (perVow[p.vow] = perVow[p.vow] || []).push(p); });
      Object.keys(perVow).forEach(function (v) { if (perVow[v].length > 1) personDup.push(perVow[v]); });
      if (Object.keys(perVow).length > 1) bothVow.push(grp);
    });
  });

  // 2) 法名重複：以「人」為單位，同一個人重複報名不算撞法名
  var byFm = {};
  people.forEach(function (p) {
    if (!p.fm) return;
    byFm[p.fm] = byFm[p.fm] || {};
    byFm[p.fm][clusterOf[p.key]] = byFm[p.fm][clusterOf[p.key]] || p;
  });
  var fmDup = [];
  Object.keys(byFm).forEach(function (fm) {
    var list = Object.keys(byFm[fm]).map(function (k) { return byFm[fm][k]; });
    if (list.length > 1) fmDup.push({ fm: fm, list: list });
  });
  fmDup.sort(function (a, b) { return a.fm.localeCompare(b.fm, 'zh-Hant'); });

  // 3) 資料待確認
  var dataBad = [];
  people.forEach(function (p) {
    var why = [];
    if (!p.fm) why.push('沒有法名');
    if (!p.sex) why.push('性別空白');
    if (p.age == null) why.push('生日看不懂');
    else if (p.age < 12 || p.age > 100) why.push('年齡 ' + p.age + ' 歲，請確認生日');
    if (why.length) dataBad.push({ p: p, why: why.join('、') });
  });

  // 標在每個人身上，畫面好畫
  var fmHit = {}, dupHit = {}, dataHit = {}, bothHit = {};
  fmDup.forEach(function (g) { g.list.forEach(function (p) { fmHit[p.fm] = 1; }); });
  personDup.forEach(function (g) { g.forEach(function (p) { dupHit[p.key] = 1; }); });
  bothVow.forEach(function (g) { g.forEach(function (p) { bothHit[p.key] = 1; }); });
  dataBad.forEach(function (d) { dataHit[d.p.key] = d.why; });
  people.forEach(function (p) {
    p.wFm = !!(p.fm && fmHit[p.fm]);
    p.wDup = !!dupHit[p.key];
    p.wBoth = !!bothHit[p.key];
    p.wData = dataHit[p.key] || '';
  });

  state.warn = { fmDup: fmDup, personDup: personDup, bothVow: bothVow, dataBad: dataBad };
}

/* ===================== 分班值 ===================== */
function clsOf(key) {
  if (key in state.pending) return state.pending[key].cls;
  return (state.assigns[key] && state.assigns[key].cls) || '';
}
function noteOf(key) {
  if (key in state.pending) return state.pending[key].note;
  return (state.assigns[key] && state.assigns[key].note) || '';
}
function headOf(key) {
  if (key in state.pending) return !!state.pending[key].head;
  return !!(state.assigns[key] && state.assigns[key].head);
}
function setPending(key, cls, note, head) {
  var a = state.assigns[key] || {};
  if (cls === (a.cls || '') && note === (a.note || '') && !!head === !!a.head) delete state.pending[key];
  else state.pending[key] = { cls: cls, note: note, head: !!head };
}
function setNote(key, note) { setPending(key, clsOf(key), note, headOf(key)); }

/** 換班就把班首身分拿掉：留著會變成新班有兩個班首，不如講清楚讓人重選 */
function setCls(key, cls) {
  var wasHead = headOf(key), from = clsOf(key);
  setPending(key, cls, noteOf(key), cls === from ? wasHead : false);
  return wasHead && cls !== from ? from : '';
}

/** 指定班首：同一個戒別的同一個班只能有一位，舊的自動取消 */
function setHead(key, on) {
  var me = byKey(key);
  if (!me) return;
  var cls = clsOf(key);
  if (on && (!cls || cls === EXCLUDE)) { toast('要先分到班，才能設班首', true); return; }
  if (on) {
    state.people.forEach(function (p) {
      if (p.key === key || p.vow !== me.vow || clsOf(p.key) !== cls) return;
      if (headOf(p.key)) setPending(p.key, clsOf(p.key), noteOf(p.key), false);
    });
  }
  setPending(key, cls, noteOf(key), on);
}

function byKey(key) {
  for (var i = 0; i < state.people.length; i++) if (state.people[i].key === key) return state.people[i];
  return null;
}

/** 某一班（限目前戒別）的班首是誰 */
function headOfClass(cls) {
  var list = scoped();
  for (var i = 0; i < list.length; i++) {
    if (clsOf(list[i].key) === cls && headOf(list[i].key)) return list[i];
  }
  return null;
}
function dirtyCount() { return Object.keys(state.pending).length; }

var EXCLUDE = '✕ 排除';

/* ===================== 載入 ===================== */
function load() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = api('load').then(function (d) {
    role = d.role || 'admin';
    state.settings = d.settings || { title: '', classes: [] };
    state.people = normalizeSource(d.source || {});
    state.assigns = {};
    (d.assigns || []).forEach(function (a) { if (a && a.key) state.assigns[a.key] = a; });
    computeWarnings();
    state.srcInfo = (state.srcStat || []).map(function (s) {
      if (s.missing) return s.tab + '：找不到這個分頁';
      return s.tab + ' ' + s.taken + ' 人' + (s.blank ? '（另有 ' + s.blank + ' 列沒填姓名，當成空白列略過）' : '');
    }).join('；') + '。合計 ' + state.people.length + ' 人。後端時間 ' + (d.serverTime || '');
    loadingPromise = null;
    return d;
  }).catch(function (e) { loadingPromise = null; throw e; });
  return loadingPromise;
}

/* ===================== 畫面 ===================== */
function allClasses() { return (state.settings.classes || []).slice(); }

/** 班別清單改過之後，可能還有人掛在舊班名下。那些班名也要顯示，不能讓人憑空消失。 */
function extraClasses() {
  var known = {};
  allClasses().forEach(function (c) { known[c] = 1; });
  known[EXCLUDE] = 1;
  var seen = {}, out = [];
  scoped().forEach(function (p) {
    var c = clsOf(p.key);
    if (c && !known[c] && !seen[c]) { seen[c] = 1; out.push(c); }
  });
  return out;
}

function countByClass() {
  var m = {};
  allClasses().concat([EXCLUDE]).forEach(function (c) { m[c] = { n: 0, M: 0, F: 0 }; });
  scoped().forEach(function (p) {
    var c = clsOf(p.key);
    if (!c) return;
    if (!m[c]) m[c] = { n: 0, M: 0, F: 0 };
    m[c].n++;
    if (p.sex === 'M') m[c].M++;
    if (p.sex === 'F') m[c].F++;
  });
  return m;
}

function renderStats() {
  var list = scoped();
  var total = list.length, done = 0, out = 0, male = 0, female = 0;
  list.forEach(function (p) {
    var c = clsOf(p.key);
    if (c === EXCLUDE) out++;
    else if (c) done++;
    if (p.sex === 'M') male++;
    if (p.sex === 'F') female++;
  });
  $('#stTotal').textContent = total;
  $('#lbTotal').textContent = scopeName() + ' 報名人數';
  $('#stDone').textContent = done;
  $('#stTodo').textContent = total - done - out;
  $('#stMale').textContent = male;
  $('#stFemale').textContent = female;
  $('#stOut').textContent = out;
  $('#stAll').textContent = state.people.length;
}

function renderBoard() {
  var cnt = countByClass();
  var cur = $('#fCls').value;
  function cellHtml(c, side) {
    var k = cnt[c] || { n: 0, M: 0, F: 0 };
    var h = c === EXCLUDE ? null : headOfClass(c);
    return '<button class="cell ' + side + (k.n ? '' : ' zero') + (cur === c ? ' on' : '') + '" data-cls="' + esc(c) + '">' +
      '<span class="cname">' + esc(c) + '</span>' +
      '<span class="cnum">' + k.n + '</span>' +
      '<span class="cmix">男 ' + k.M + '／女 ' + k.F + '</span>' +
      (k.n ? '<span class="chead' + (h ? '' : ' none') + '">' + (h ? '★ ' + esc(h.fm || h.name) : '未設班首') + '</span>' : '') +
      '</button>';
  }
  var east = [], west = [], other = [];
  allClasses().forEach(function (c) {
    if (/^東/.test(c)) east.push(cellHtml(c, 'east'));
    else if (/^西/.test(c)) west.push(cellHtml(c, 'west'));
    else other.push(cellHtml(c, 'plain'));
  });
  extraClasses().forEach(function (c) { other.push(cellHtml(c, 'plain')); });
  var todo = scoped().filter(function (p) { return !clsOf(p.key); }).length;
  other.push('<button class="cell plain' + (cur === '__none' ? ' on' : '') + '" data-cls="__none">' +
    '<span class="cname">未分班</span><span class="cnum">' + todo + '</span><span class="cmix">　</span></button>');
  other.push(cellHtml(EXCLUDE, 'plain'));
  $('#boardEast').innerHTML = east.join('');
  $('#boardWest').innerHTML = west.join('');
  $('#boardOther').innerHTML = other.join('');
}

var warnOpen = true;

function renderWarnings() {
  var w = state.warn;
  var box = $('#warnBox');
  var html = '';
  if (w.personDup.length) {
    html += '<h3>⚠ 同一個戒別裡疑似重複報名 ' + w.personDup.length + ' 組</h3><ul>';
    w.personDup.forEach(function (g) {
      html += '<li><span class="hit">' + esc(g[0].name) + '</span>（' + esc(g[0].vow) + '）<span class="sep">—</span> ' +
        g.map(function (p) { return esc(p.src + ' #' + p.seq + '（' + (p.fm || '無法名') + '）'); }).join(' ／ ') +
        '</li>';
    });
    html += '</ul>';
  }
  if (w.fmDup.length) {
    html += '<h3>⚠ 法名重複 ' + w.fmDup.length + ' 組（不同人用了同一個法名）</h3><ul>';
    w.fmDup.forEach(function (g) {
      html += '<li><span class="hit">' + esc(g.fm) + '</span> <span class="sep">—</span> ' +
        g.list.map(function (p) { return esc(p.name + '（' + p.vow + ' ' + p.src + ' #' + p.seq + '）'); }).join(' ／ ') +
        '</li>';
    });
    html += '</ul>';
  }
  if (w.bothVow.length) {
    html += '<h3>兩戒都受 ' + w.bothVow.length + ' 人（正常，不是重複報名）</h3><ul>';
    w.bothVow.slice(0, 20).forEach(function (g) {
      html += '<li><span class="hit">' + esc(g[0].name) + '</span>（' + esc(g[0].fm || '無法名') + '）<span class="sep">—</span> ' +
        g.map(function (p) { return esc(p.vow + ' ' + p.src + ' #' + p.seq); }).join(' ＋ ') + '</li>';
    });
    if (w.bothVow.length > 20) html += '<li class="sep">…還有 ' + (w.bothVow.length - 20) + ' 人</li>';
    html += '</ul>';
  }
  if (w.dataBad.length) {
    html += '<h3>資料待確認 ' + w.dataBad.length + ' 人</h3><ul>';
    w.dataBad.slice(0, 20).forEach(function (d) {
      html += '<li>' + esc(d.p.name + '（' + d.p.vow + ' ' + d.p.src + ' #' + d.p.seq + '）') + '：' + esc(d.why) + '</li>';
    });
    if (w.dataBad.length > 20) html += '<li class="sep">…還有 ' + (w.dataBad.length - 20) + ' 人</li>';
    html += '</ul>';
  }
  if (!html) { box.hidden = true; box.innerHTML = ''; return; }
  var sum = [];
  if (w.personDup.length) sum.push('疑似重複報名 ' + w.personDup.length + ' 組');
  if (w.fmDup.length) sum.push('法名重複 ' + w.fmDup.length + ' 組');
  if (w.bothVow.length) sum.push('兩戒都受 ' + w.bothVow.length + ' 人');
  if (w.dataBad.length) sum.push('資料待確認 ' + w.dataBad.length + ' 人');
  box.hidden = false;
  box.innerHTML = '<button id="warnToggle" class="warntoggle">⚠ ' + esc(sum.join('　·　')) +
    '<span class="caret">' + (warnOpen ? '收合 ▲' : '展開 ▼') + '</span></button>' +
    '<div class="warndetail"' + (warnOpen ? '' : ' hidden') + '>' + html + '</div>';
  on('#warnToggle', 'click', function () { warnOpen = !warnOpen; renderWarnings(); });
}

function visiblePeople() {
  var q = cleanPw($('#q').value).toLowerCase();
  var fSrc = $('#fSrc').value, fSex = $('#fSex').value, fCls = $('#fCls').value, fWarn = $('#fWarn').value;
  var list = scoped().filter(function (p) {
    if (fSrc && p.src !== fSrc) return false;
    if (fSex && p.sex !== fSex) return false;
    var c = clsOf(p.key);
    if (fCls === '__none') { if (c) return false; }
    else if (fCls && c !== fCls) return false;
    if (fWarn === 'fm' && !p.wFm) return false;
    if (fWarn === 'dup' && !p.wDup) return false;
    if (fWarn === 'both' && !p.wBoth) return false;
    if (fWarn === 'data' && !p.wData) return false;
    if (q) {
      var hay = (p.name + ' ' + p.fm + ' ' + p.phone + ' ' + p.from + ' ' + p.city + ' ' + p.note).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  var s = $('#sort').value;
  var coll = function (a, b) { return String(a).localeCompare(String(b), 'zh-Hant'); };
  list.sort(function (a, b) {
    if (s === 'age') return (a.age == null ? 999 : a.age) - (b.age == null ? 999 : b.age) || coll(a.name, b.name);
    if (s === 'ageD') return (b.age == null ? -1 : b.age) - (a.age == null ? -1 : a.age) || coll(a.name, b.name);
    if (s === 'fm') return coll(a.fm, b.fm);
    if (s === 'name') return coll(a.name, b.name);
    if (s === 'cls') {
      var ci = allClasses().concat([EXCLUDE]);
      var ia = ci.indexOf(clsOf(a.key)), ib = ci.indexOf(clsOf(b.key));
      if (ia < 0) ia = 99; if (ib < 0) ib = 99;
      return ia - ib || coll(a.name, b.name);
    }
    if (a.src !== b.src) return a.src === '線上' ? -1 : 1;
    return (parseInt(a.seq, 10) || 0) - (parseInt(b.seq, 10) || 0);
  });
  return list;
}

var checked = {};

/** 下拉的每個班別後面要帶當下人數；data-c 記著班名，之後只換文字不重畫整張表 */
function optHtml(value, base, cur, countKey) {
  return '<option value="' + esc(value) + '"' + (value === cur ? ' selected' : '') +
    ' data-c="' + esc(countKey == null ? value : countKey) + '" data-base="' + esc(base) + '">' +
    esc(base) + '</option>';
}

function clsSelectHtml(key, cur) {
  var opts = [optHtml('', '— 未分班 —', cur, '__none')];
  var list = allClasses();
  // 目前的班別若已不在清單裡（清單改過），還是要列出來，否則下拉會顯示成「未分班」騙人
  if (cur && cur !== EXCLUDE && list.indexOf(cur) < 0) list = list.concat([cur]);
  list.forEach(function (c) { opts.push(optHtml(c, c, cur)); });
  opts.push(optHtml(EXCLUDE, EXCLUDE, cur));
  return '<select class="clsSel" data-key="' + esc(key) + '"' + (isGuest() ? ' disabled' : '') + '>' + opts.join('') + '</select>';
}

/** 把所有班別下拉的文字換成「東1（4）」。只動文字，不重畫表格，游標與捲動位置都不會跑掉。 */
function refreshClassLabels() {
  var cnt = countByClass();
  var none = scoped().filter(function (p) { return !clsOf(p.key); }).length;
  $$('select.clsSel, #bulkCls, #fCls').forEach(function (sel) {
    Array.prototype.forEach.call(sel.options, function (o) {
      var c = o.getAttribute('data-c'), base = o.getAttribute('data-base');
      if (c == null || base == null) return;
      var n = c === '__none' ? none : (cnt[c] ? cnt[c].n : 0);
      o.textContent = base + '（' + n + '）';
    });
  });
}

function renderTable() {
  var list = visiblePeople();
  var rows = list.map(function (p, i) {
    var cur = clsOf(p.key);
    var badges = '';
    if (p.wDup) badges += '<span class="badge dup" title="同一個戒別裡出現兩筆，疑似重複報名">重複報名</span>';
    if (p.wFm) badges += '<span class="badge fm" title="有別人也用這個法名">法名重複</span>';
    if (p.wData) badges += '<span class="badge data" title="' + esc(p.wData) + '">待確認</span>';
    var vowCell = '<span class="badge vow' + (p.vow === '菩薩戒' ? ' ps' : ' sg') + '">' + esc(p.vow) + '</span>' +
      (p.items ? '<span class="items">' + esc(p.items) + '</span>' : '') +
      (p.wBoth ? '<span class="badge both" title="這個人菩薩戒與三皈五戒都有報名">兩戒都受</span>' : '');
    return '<tr class="' + (p.key in state.pending ? 'dirty ' : '') + (p.active ? '' : 'off') + '" data-key="' + esc(p.key) + '">' +
      '<td class="c-chk no-print"><input type="checkbox" class="rowChk" data-key="' + esc(p.key) + '"' + (checked[p.key] ? ' checked' : '') + '></td>' +
      '<td class="c-no">' + (i + 1) + '</td>' +
      '<td class="c-name">' + esc(p.name) + '</td>' +
      '<td class="c-fm">' + esc(p.fm || '—') + (p.wFm ? '<span class="badge fm">重</span>' : '') + '</td>' +
      '<td class="c-vow">' + vowCell + '</td>' +
      '<td class="c-sex">' + (p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '—') + '</td>' +
      '<td class="c-age">' + (p.age == null ? '—' : p.age) + '</td>' +
      '<td class="c-cls">' + clsSelectHtml(p.key, cur) + '</td>' +
      '<td class="c-head no-print"><button class="headBtn' + (headOf(p.key) ? ' on' : '') + '"' +
        ' data-key="' + esc(p.key) + '"' + (isGuest() ? ' disabled' : '') +
        ' title="' + (headOf(p.key) ? '取消班首' : '設為這一班的班首') + '">★</button></td>' +
      '<td class="c-pnote no-print"><input class="noteIn" type="text" autocomplete="off" placeholder="分班備註"' +
        ' data-key="' + esc(p.key) + '" value="' + esc(noteOf(p.key)) + '"' + (isGuest() ? ' disabled' : '') + '></td>' +
      '<td class="c-dob">' + esc(p.dobRaw || '—') + '</td>' +
      '<td class="c-src"><span class="badge src' + (p.src === '紙本' ? ' paper' : '') + '">' + esc(p.src) + ' #' + esc(p.seq) + '</span></td>' +
      '<td class="c-from">' + esc(p.from || '—') + '</td>' +
      '<td class="c-phone">' + esc(p.phone || '—') + '</td>' +
      '<td class="c-note">' + esc(p.note || '') + badges + '</td>' +
      '</tr>';
  }).join('');
  $('#tbody').innerHTML = rows;
  refreshClassLabels();
  $('#empty').hidden = list.length > 0;
  $('#chkAll').checked = list.length > 0 && list.every(function (p) { return checked[p.key]; });
  renderBulk();
}

function renderBulk() {
  var n = Object.keys(checked).filter(function (k) { return checked[k]; }).length;
  $('#bulkbar').hidden = n === 0 || isGuest();
  $('#bulkN').textContent = n;
}

function renderSave() {
  var n = dirtyCount();
  $('#btnSave').disabled = n === 0 || isGuest();
  $('#btnRevert').disabled = n === 0;
  $('#savebar').className = 'savebar no-print' + (n ? ' hot' : '');
  $('#saveHint').textContent = n ? ('有 ' + n + ' 筆變更還沒儲存') : '尚無未儲存的變更';
  $('#saveHint').className = n ? '' : 'muted';
}

function renderAll() {
  renderStats();
  renderBoard();
  renderWarnings();
  renderTable();
  renderSave();
  $('#appTitle').textContent = (window.CONFIG && window.CONFIG.title) || '菩薩戒分班系統';
  $('#appSub').textContent = state.settings.title || '';
  $('#whoami').textContent = (operator ? operator + '　' : '') + (isGuest() ? '（訪客・唯讀）' : '（工作人員）');
  $('#srcInfo').textContent = state.srcInfo || '—';
}

function fillClassSelects() {
  var cs = allClasses().concat(extraClasses());
  var keep = $('#fCls').value;
  $('#fCls').innerHTML = '<option value="">班別：全部</option>' + optHtml('__none', '未分班', '') +
    cs.map(function (c) { return optHtml(c, c, ''); }).join('') + optHtml(EXCLUDE, EXCLUDE, '');
  if (keep) $('#fCls').value = keep;
  $('#bulkCls').innerHTML = optHtml('', '— 未分班 —', '', '__none') +
    cs.map(function (c) { return optHtml(c, c, ''); }).join('') + optHtml(EXCLUDE, EXCLUDE, '');
  refreshClassLabels();
}

/* ===================== 儲存 ===================== */
function save() {
  var keys = Object.keys(state.pending);
  if (!keys.length) return Promise.resolve();
  var byKey = {};
  state.people.forEach(function (p) { byKey[p.key] = p; });
  var items = keys.map(function (k) {
    var p = byKey[k] || {};
    return { key: k, vow: p.vow || '', src: p.src || '', seq: p.seq || '', name: p.name || '', fm: p.fm || '',
             cls: state.pending[k].cls, head: !!state.pending[k].head, note: state.pending[k].note || '' };
  });
  $('#btnSave').disabled = true;
  $('#btnSave').textContent = '儲存中…';
  return api('saveAssign', { items: items }).then(function (d) {
    items.forEach(function (it) {
      if (!it.cls && !it.note) delete state.assigns[it.key];
      else state.assigns[it.key] = { key: it.key, vow: it.vow, src: it.src, seq: it.seq, name: it.name, fm: it.fm,
                                     cls: it.cls, head: it.head, note: it.note, at: d.at, by: operator };
    });
    state.pending = {};
    renderAll();
    toast('已儲存 ' + (d.saved || 0) + ' 筆' + (d.removed ? '，移除 ' + d.removed + ' 筆' : ''));
  }).catch(function (e) {
    toast(e.message || '儲存失敗', true);
    throw e;
  }).then(function () {
    $('#btnSave').textContent = '儲存分班';
    renderSave();
  }, function () {
    $('#btnSave').textContent = '儲存分班';
    renderSave();
  });
}

/* ===================== 列印 ===================== */
function assignedList() {
  var byCls = {};
  allClasses().forEach(function (c) { byCls[c] = []; });
  var none = [], out = [], extra = [];   // extra＝班別清單改過之後，掛在舊班名下的人，不能讓他們憑空消失
  scoped().forEach(function (p) {
    var c = clsOf(p.key);
    if (c === EXCLUDE) out.push(p);
    else if (!c) none.push(p);
    else {
      if (!(c in byCls)) { byCls[c] = []; extra.push(c); }
      byCls[c].push(p);
    }
  });
  // 班首排第一，其餘男眾在前、再依法名
  var sorter = function (a, b) {
    var ha = headOf(a.key) ? 0 : 1, hb = headOf(b.key) ? 0 : 1;
    return ha - hb ||
      (a.sex === b.sex ? 0 : a.sex === 'M' ? -1 : 1) ||
      String(a.fm).localeCompare(String(b.fm), 'zh-Hant');
  };
  Object.keys(byCls).forEach(function (c) { byCls[c].sort(sorter); });
  none.sort(sorter); out.sort(sorter);
  return { byCls: byCls, none: none, out: out, order: allClasses().concat(extra) };
}

function headLine() {
  var d = new Date();
  var stamp = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  return esc(state.settings.title || '菩薩戒') + '　' + esc(scopeName()) + '　分班表　列印日期 ' + stamp;
}

function rosterTable(list, opts) {
  var showPhone = opts && opts.phone, sign = opts && opts.sign;
  var ncol = 6 + (showPhone ? 1 : 0) + (sign ? 1 : 0) + 1;
  var h = '<table class="pr"><thead><tr><th class="ctr">座號</th><th>法名</th><th>姓名</th>' +
    '<th class="ctr">性別</th><th class="ctr">年齡</th><th>分院／皈依師長</th>' +
    (showPhone ? '<th>電話</th>' : '') + '<th>備註</th>' + (sign ? '<th class="sig">簽到</th>' : '') + '</tr></thead><tbody>';
  list.forEach(function (p, i) {
    h += '<tr' + (headOf(p.key) ? ' class="isHead"' : '') + '><td class="ctr">' + (i + 1) +
      (headOf(p.key) ? ' ★' : '') + '</td><td>' + esc(p.fm || '—') + '</td><td>' + esc(p.name) + '</td>' +
      '<td class="ctr">' + (p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '—') + '</td>' +
      '<td class="ctr">' + (p.age == null ? '—' : p.age) + '</td>' +
      '<td>' + esc(p.from || '') + '</td>' +
      (showPhone ? '<td>' + esc(p.phone || '') + '</td>' : '') +
      '<td>' + esc(noteOf(p.key) || '') + '</td>' + (sign ? '<td class="sig"></td>' : '') + '</tr>';
  });
  if (!list.length) h += '<tr><td colspan="' + ncol + '" class="ctr">（無）</td></tr>';
  return h + '</tbody></table>';
}

function buildPrint(kind) {
  var A = assignedList();
  var opts = { phone: $('#optPhone').checked, sign: $('#optSign').checked };
  var html = '';

  if (kind === 'board') {
    var east = A.order.filter(function (c) { return /^東/.test(c); });
    var west = A.order.filter(function (c) { return /^西/.test(c); });
    var others = A.order.filter(function (c) { return !/^[東西]/.test(c); });
    function grid(cs) {
      return '<div class="boardgrid">' + cs.map(function (c) {
        var l = A.byCls[c] || [];
        var hd = headOfClass(c);
        return '<div class="boardcol"><h3>' + esc(c) + '（' + l.length + '）</h3>' +
          '<p class="colhead">班首：' + (hd ? esc(hd.fm || hd.name) : '—') + '</p><ol>' +
          l.map(function (p) {
            return '<li>' + (headOf(p.key) ? '★' : '') + esc(p.fm || '—') + ' ' + esc(p.name) + '</li>';
          }).join('') + '</ol></div>';
      }).join('') + '</div>';
    }
    html = '<div class="sheet"><h2>分班總表</h2><p class="sheetsub">' + headLine() +
      '　已分班 ' + (scoped().length - A.none.length - A.out.length) + ' 人／未分班 ' + A.none.length + ' 人</p>' +
      (east.length ? grid(east) : '') + (west.length ? '<div style="height:8px"></div>' + grid(west) : '') +
      (others.length ? '<div style="height:8px"></div>' + grid(others) : '') +
      (A.none.length ? '<p class="sheetsub" style="margin-top:10px">未分班：' +
        A.none.map(function (p) { return esc(p.fm + ' ' + p.name); }).join('、') + '</p>' : '') +
      '</div>';
  } else if (kind === 'rosters') {
    var any = false;
    A.order.forEach(function (c) {
      var l = A.byCls[c] || [];
      if (!l.length) return;
      any = true;
      var m = l.filter(function (p) { return p.sex === 'M'; }).length;
      var hd = headOfClass(c);
      html += '<div class="sheet"><h2>' + esc(c) + '　戒子名冊</h2>' +
        '<p class="sheetsub">' + headLine() + '　本班 ' + l.length + ' 人（男 ' + m + '／女 ' + (l.length - m) + '）' +
        '　班首：' + (hd ? esc((hd.fm ? hd.fm + ' ' : '') + hd.name) : '＿＿＿＿＿') +
        '　導引法師：＿＿＿＿＿</p>' +
        rosterTable(l, opts) + '</div>';
    });
    if (!any) html = '<div class="sheet"><h2>各班名冊</h2><p class="sheetsub">目前還沒有人分到班。</p></div>';
  } else if (kind === 'todo') {
    html = '<div class="sheet"><h2>未分班名單</h2><p class="sheetsub">' + headLine() + '　共 ' + A.none.length + ' 人</p>' +
      rosterTable(A.none, { phone: opts.phone, sign: false }) + '</div>';
  } else if (kind === 'all') {
    var ci = A.order.concat([EXCLUDE]);
    var all = scoped().slice().sort(function (a, b) {
      var ia = ci.indexOf(clsOf(a.key)), ib = ci.indexOf(clsOf(b.key));
      if (ia < 0) ia = 99; if (ib < 0) ib = 99;
      // 同一班裡班首排最前面，跟各班名冊一致
      return ia - ib || (headOf(a.key) ? 0 : 1) - (headOf(b.key) ? 0 : 1) ||
        String(a.fm).localeCompare(String(b.fm), 'zh-Hant');
    });
    var h = '<table class="pr"><thead><tr><th class="ctr">#</th><th class="ctr">班別</th><th>法名</th><th>姓名</th>' +
      '<th class="ctr">戒別</th><th class="ctr">性別</th><th class="ctr">年齡</th><th class="ctr">來源</th><th>分院／皈依師長</th>' +
      (opts.phone ? '<th>電話</th>' : '') + '<th>備註</th></tr></thead><tbody>';
    all.forEach(function (p, i) {
      h += '<tr' + (headOf(p.key) ? ' class="isHead"' : '') + '><td class="ctr">' + (i + 1) + '</td>' +
        '<td class="ctr">' + esc(clsOf(p.key) || '未分班') + (headOf(p.key) ? ' ★班首' : '') + '</td>' +
        '<td>' + esc(p.fm || '—') + '</td><td>' + esc(p.name) + '</td>' +
        '<td class="ctr">' + esc(p.vow + (p.items ? '（' + p.items + '）' : '')) + '</td>' +
        '<td class="ctr">' + (p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '—') + '</td>' +
        '<td class="ctr">' + (p.age == null ? '—' : p.age) + '</td>' +
        '<td class="ctr">' + esc(p.src) + '</td><td>' + esc(p.from || '') + '</td>' +
        (opts.phone ? '<td>' + esc(p.phone || '') + '</td>' : '') +
        '<td>' + esc([noteOf(p.key), p.note, p.wBoth ? '兩戒都受' : '', p.wDup ? '疑似重複報名' : '', p.wFm ? '法名重複' : ''].filter(Boolean).join('；')) + '</td></tr>';
    });
    h += '</tbody></table>';
    html = '<div class="sheet"><h2>全體戒子名冊</h2><p class="sheetsub">' + headLine() + '　共 ' + all.length + ' 人</p>' + h + '</div>';
  }
  $('#printArea').innerHTML = html;
}

function csvDump() {
  var rows = [['班別', '座號', '班首', '法名', '姓名', '戒別', '受戒項目', '性別', '年齡', '生日', '來源', '流水號', '分院／皈依師長', '電話', '分班備註', '報名表備註', '警示']];
  var A = assignedList();
  A.order.forEach(function (c) {
    (A.byCls[c] || []).forEach(function (p, i) { rows.push(line(p, c, i + 1)); });
  });
  A.out.forEach(function (p, i) { rows.push(line(p, EXCLUDE, i + 1)); });
  A.none.forEach(function (p, i) { rows.push(line(p, '未分班', i + 1)); });
  function line(p, c, i) {
    return [c, i, headOf(p.key) ? '★ 班首' : '', p.fm, p.name, p.vow, p.items, p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '', p.age == null ? '' : p.age,
            p.dobRaw, p.src, p.seq, p.from, p.phone, noteOf(p.key), p.note,
            [p.wBoth ? '兩戒都受' : '', p.wDup ? '疑似重複報名' : '', p.wFm ? '法名重複' : '', p.wData].filter(Boolean).join('；')];
  }
  var csv = rows.map(function (r) {
    return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
  var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = scopeName() + '分班結果.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ===================== 事件 ===================== */
function bind() {
  on('#gateBtn', 'click', doLogin);
  on('#gatePw', 'keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  on('#gateBy', 'keydown', function (e) { if (e.key === 'Enter') $('#gatePw').focus(); });

  on('#btnLogout', 'click', function () {
    if (dirtyCount() && !confirm('還有 ' + dirtyCount() + ' 筆變更沒儲存，確定要登出嗎？')) return;
    pw = ''; state.pending = {}; checked = {};
    $('#app').hidden = true; $('#gate').hidden = false;
    $('#gatePw').value = ''; $('#gateMsg').textContent = '';
  });

  on('#btnReload', 'click', function () {
    if (dirtyCount() && !confirm('還有 ' + dirtyCount() + ' 筆變更沒儲存，重新整理會把它們丟掉，確定嗎？')) return;
    state.pending = {};
    $('#btnReload').disabled = true;
    load().then(function () { fillClassSelects(); renderAll(); toast('已重新載入'); })
      .catch(function (e) { toast(e.message || '載入失敗', true); })
      .then(function () { $('#btnReload').disabled = false; });
  });

  on('#vowPick', 'click', function (e) {
    var b = e.target.closest('.vowbtn');
    if (!b) return;
    vowScope = b.getAttribute('data-vow') || '';
    $$('.vowbtn').forEach(function (x) { x.classList.toggle('on', x === b); });
    checked = {};
    $('#fCls').value = '';
    fillClassSelects();
    renderAll();
    if (printPick) buildPrint(printPick);
  });

  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('.tab').forEach(function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      var v = t.getAttribute('data-view');
      $('#viewAssign').hidden = v !== 'assign';
      $('#viewPrint').hidden = v !== 'print';
      $('#viewSettings').hidden = v !== 'settings';
      if (v === 'settings') fillSettings();
    });
  });

  ['#q', '#fSrc', '#fSex', '#fCls', '#fWarn', '#sort'].forEach(function (s) {
    on(s, 'input', function () { renderTable(); renderBoard(); });
    on(s, 'change', function () { renderTable(); renderBoard(); });
  });
  on('#btnClearF', 'click', function () {
    $('#q').value = ''; $('#fSrc').value = ''; $('#fSex').value = '';
    $('#fCls').value = ''; $('#fWarn').value = ''; $('#sort').value = 'src';
    renderTable(); renderBoard();
  });

  // 班級看板點一下＝篩選那一班
  on('#boardEast', 'click', boardClick);
  on('#boardWest', 'click', boardClick);
  on('#boardOther', 'click', boardClick);
  function boardClick(e) {
    var b = e.target.closest('.cell');
    if (!b) return;
    var c = b.getAttribute('data-cls');
    $('#fCls').value = ($('#fCls').value === c) ? '' : c;
    renderTable(); renderBoard();
  }

  // 班別下拉
  on('#tbody', 'change', function (e) {
    var sel = e.target.closest('.clsSel');
    if (sel) {
      if (isGuest()) { toast('訪客只能查看', true); renderTable(); return; }
      var k = sel.getAttribute('data-key');
      var lostHead = setCls(k, sel.value);
      renderStats(); renderBoard(); renderSave(); refreshClassLabels();
      var tr = sel.closest('tr');
      if (tr) {
        tr.classList.toggle('dirty', k in state.pending);
        var hb = tr.querySelector('.headBtn');
        if (hb) hb.classList.toggle('on', headOf(k));
      }
      if (lostHead) {
        var who = byKey(k);
        toast((who ? who.name : '這位') + '原本是' + lostHead + '班首，換班後已取消，請重新指定');
      }
      return;
    }
    var ni = e.target.closest('.noteIn');
    if (ni) {
      if (isGuest()) { toast('訪客只能查看', true); renderTable(); return; }
      var k = ni.getAttribute('data-key');
      setNote(k, ni.value.trim());
      renderSave();
      var row = ni.closest('tr');
      if (row) row.classList.toggle('dirty', k in state.pending);
      return;
    }
    var chk = e.target.closest('.rowChk');
    if (chk) {
      checked[chk.getAttribute('data-key')] = chk.checked;
      renderBulk();
      var list = visiblePeople();
      $('#chkAll').checked = list.length > 0 && list.every(function (p) { return checked[p.key]; });
    }
  });

  // 班首：同班只能一位，所以按下去要整張表重畫（舊的那位要跟著變回來）
  on('#tbody', 'click', function (e) {
    var b = e.target.closest('.headBtn');
    if (!b) return;
    if (isGuest()) { toast('訪客只能查看', true); return; }
    var k = b.getAttribute('data-key');
    setHead(k, !headOf(k));
    renderTable(); renderBoard(); renderSave();
  });

  on('#chkAll', 'change', function () {
    var want = $('#chkAll').checked;
    visiblePeople().forEach(function (p) { checked[p.key] = want; });
    renderTable();
  });

  on('#btnBulk', 'click', function () {
    var c = $('#bulkCls').value;
    var keys = Object.keys(checked).filter(function (k) { return checked[k]; });
    if (!keys.length) return;
    keys.forEach(function (k) { setCls(k, c); });
    checked = {};
    renderAll();
    toast('已把 ' + keys.length + ' 人指定到「' + (c || '未分班') + '」，記得按儲存');
  });
  on('#btnBulkClear', 'click', function () { checked = {}; renderTable(); });

  on('#btnSave', 'click', function () { save(); });
  on('#btnRevert', 'click', function () {
    if (!dirtyCount()) return;
    if (!confirm('把還沒儲存的 ' + dirtyCount() + ' 筆變更丟掉？')) return;
    state.pending = {}; renderAll(); toast('已還原');
  });

  $$('.pick').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.pick').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      printPick = b.getAttribute('data-print');
      $('#btnDoPrint').disabled = false;
      buildPrint(printPick);
    });
  });
  on('#optPhone', 'change', function () { if (printPick) buildPrint(printPick); });
  on('#optSign', 'change', function () { if (printPick) buildPrint(printPick); });
  on('#btnDoPrint', 'click', function () {
    if (!printPick) return;
    buildPrint(printPick);
    setTimeout(function () { window.print(); }, 80);
  });
  on('#btnCsv', 'click', csvDump);

  on('#btnSaveSet', 'click', function () {
    if (isGuest()) { toast('訪客只能查看', true); return; }
    var patch = {
      '戒會名稱': $('#setTitle').value.trim(),
      '班別清單': $('#setClasses').value.trim(),
    };
    if ($('#setPw').value.trim()) patch['密碼'] = $('#setPw').value.trim();
    api('saveSettings', { settings: patch }).then(function () {
      if (patch['密碼']) pw = cleanPw(patch['密碼']);
      return load();
    }).then(function () { fillClassSelects(); renderAll(); fillSettings(); toast('設定已儲存'); })
      .catch(function (e) { toast(e.message || '儲存失敗', true); });
  });

  function saveGuest(patch, okMsg) {
    api('saveSettings', { settings: patch })
      .then(function () { return load(); })
      .then(function () { fillSettings(); renderAll(); toast(okMsg); })
      .catch(function (e) { toast(e.message || '儲存失敗', true); });
  }

  on('#btnSaveGuest', 'click', function () {
    if (isGuest()) { toast('訪客只能查看', true); return; }
    var patch = { '訪客開放到': $('#setGuestUntil').value.trim() };
    if ($('#setGuestPw').value.trim()) patch['訪客密碼'] = $('#setGuestPw').value.trim();
    saveGuest(patch, patch['訪客開放到'] ? '訪客設定已儲存' : '訪客已關閉');
  });

  on('#btnCloseGuest', 'click', function () {
    if (isGuest()) { toast('訪客只能查看', true); return; }
    if (!confirm('立刻關閉訪客帳號？\n\n關閉後訪客密碼就登不進來了，工作人員後台不受影響。\n日後有新活動，把「訪客開放到」填上新日期就會重新開放。')) return;
    saveGuest({ '訪客開放到': '' }, '訪客已關閉');
  });

  on('#btnSaveBackend', 'click', function () {
    var v = $('#setBackend').value.trim();
    if (v) localStorage.setItem('psj_backend', v); else localStorage.removeItem('psj_backend');
    toast('已記住，重新整理後生效');
  });
  on('#btnPing', 'click', function () {
    $('#pingMsg').textContent = '測試中…';
    rawApi('ping', {}, 1).then(function (d) { $('#pingMsg').textContent = '通了，後端時間 ' + (d.time || ''); })
      .catch(function (e) { $('#pingMsg').textContent = '連不上：' + (e.message || ''); });
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirtyCount()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function fillSettings() {
  $('#setTitle').value = state.settings.title || '';
  $('#setClasses').value = (state.settings.classes || []).join(',');
  $('#setPw').value = '';
  $('#setGuestPw').value = '';
  $('#setGuestUntil').value = state.settings.guestUntil || '';
  $('#setBackend').value = (localStorage.getItem('psj_backend') || '').trim();
  $('#srcInfo').textContent = state.srcInfo || '—';

  var g = $('#guestState');
  if (state.settings.guestOpen) {
    g.className = 'gueststate on';
    g.textContent = '訪客帳號開放中，到 ' + (state.settings.guestUntil || '—') + ' 為止（含當天）。' +
      (state.settings.today ? '今天是 ' + state.settings.today + '。' : '') +
      '過了這天不必做任何事，訪客密碼會自動失效，後台不受影響。';
  } else {
    g.className = 'gueststate off';
    g.textContent = '訪客帳號目前關閉中。' + (state.settings.guestWhy ? '（' + state.settings.guestWhy + '）' : '') +
      ' 要重新開放，把下面的日期填成新的活動結束日再儲存即可。';
  }

  // 訪客只能看：設定欄位一律唯讀
  var ro = isGuest();
  ['#setTitle', '#setClasses', '#setPw', '#setGuestPw', '#setGuestUntil'].forEach(function (s) {
    var el = $(s); if (el) el.disabled = ro;
  });
  ['#btnSaveSet', '#btnSaveGuest', '#btnCloseGuest'].forEach(function (s) {
    var el = $(s); if (el) el.disabled = ro;
  });
}

function doLogin() {
  var btn = $('#gateBtn');
  if (btn.disabled) return;
  operator = cleanPw($('#gateBy').value);
  pw = cleanPw($('#gatePw').value);
  if (!pw) { $('#gateMsg').textContent = '請輸入密碼'; return; }
  btn.disabled = true;
  btn.textContent = '載入中…';
  $('#gateMsg').textContent = '';
  // 注意：load() 成功後才進畫面；enter() 自己的錯不要被當成密碼錯
  load().then(function () {
    try {
      fillClassSelects();
      $('#gate').hidden = true;
      $('#app').hidden = false;
      renderAll();
    } catch (err) {
      $('#gateMsg').textContent = '畫面出錯：' + (err.message || err);
      $('#gate').hidden = false;
      $('#app').hidden = true;
      if (window.console) console.error(err);
    }
  }).catch(function (e) {
    pw = '';
    $('#gatePw').value = '';
    $('#gateMsg').textContent = e.message || '登入失敗';
  }).then(function () {
    btn.disabled = false;
    btn.textContent = '進入系統';
  });
}

/* ===================== 啟動 ===================== */
function boot() {
  if (window.CONFIG) {
    if (window.CONFIG.title) { document.title = window.CONFIG.title + ' · 寶嚴山寶嚴禪寺'; $('.gate-title').textContent = window.CONFIG.title; }
    if (window.CONFIG.subtitle) $('#gateSub').textContent = window.CONFIG.subtitle;
  }
  bind();
  if (window.console) console.log('菩薩戒分班系統 build ' + BUILD + '，後端 ' + (backendUrl() || '（未設定）'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
