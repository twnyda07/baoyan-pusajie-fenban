/* 寶嚴菩薩戒分班系統 — 前台
   名單全部放在後端試算表，這個網頁本身不含任何個人資料。 */
(function () {
'use strict';

var BUILD = '20261018g';

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
  rev: 0,              // 後端版本號，用來發現別人改過東西
  online: [],          // 目前還有誰在線上
  conflicts: [],       // 上次儲存時因他人同時修改而沒套用的
  guides: {},          // 班別 -> {cls, who, at, by}（已存在後端的引禮師指派）
  pendingGuides: {},   // 班別 -> {who, baseAt}（還沒存的）
  guideConflicts: [],  // 引禮師那邊因他人同時修改而沒套用的
  rebound: [],         // 來源名單順序變動後，自動跟回正確的人的分班
  lostAssigns: [],     // 分班存著、但來源名單已經找不到這個人
};
var pw = '';
var operator = '';
var role = 'admin';
var loadingPromise = null;
var printPick = '';
/** 目前在看哪一個戒別；空字串＝兩者都看。分班是給菩薩戒用的，所以預設菩薩戒。 */
var vowScope = '菩薩戒';

/** 後端已經比我新的版本號（0＝沒有）。有值就代表別人改過東西了。 */
var newerRev = 0;
var pollTimer = null;

/** 每 15 秒問一次「版本號變了沒」。只問一個數字，不重讀名單，所以很輕。
 *  發現別人改過只會跳橫幅請使用者自己按，絕不自動覆蓋他沒存的工作。 */
function checkRev() {
  if ($('#gate') && !$('#gate').hidden) return;   // 還沒登入
  if (!pw) return;
  return rawApi('rev', {}, 0).then(function (d) {
    state.online = d.online || [];
    renderWho();
    // 用 typeof 判斷，不要用 truthy：rev 是 0 的時候會被當成「沒有版本」而讓提醒整場失效
    if (typeof d.rev === 'number' && d.rev !== state.rev) { newerRev = d.rev; renderNotice(); }
  }).catch(function () { /* 輪詢失敗不要吵使用者，下一輪再說 */ });
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(function () {
    if (document.hidden) return;                  // 分頁在背景就別浪費
    checkRev();
  }, 15000);
  // 切回這個分頁時立刻對一次，不要讓人盯著過期畫面等下一輪
  if (!startPolling._vis) {
    startPolling._vis = true;
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && pollTimer) checkRev();
    });
  }
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

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
  /* 本機測試一律走同 port 的 mock，而且必須排在 CONFIG.backend 前面。
     原本順序是 CONFIG 先，但 CONFIG.backend 永遠有值，所以這條是死碼——
     在 localhost 開起來按「儲存」會直接寫進線上正式試算表。 */
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return location.origin + '/exec';
  var cfg = ((window.CONFIG && window.CONFIG.backend) || '').trim();
  if (cfg) return cfg;
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

  // Apps Script 本身可以跑到 6 分鐘，但 Google 的路由偶爾會慢到 30～60 秒。
  // 原本客戶端 25 秒就 abort，等於在 Google 還在回的時候自己把線掐掉，
  // 四次重試每次都被掐，使用者就是「等很久還是進不去」。放寬到 90 秒。
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 90000) : null;

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
      // 別人正在存檔而拿不到鎖 → 等一下自己重試，不要把這種事丟給使用者
      if (e && e.code === 'BUSY') e.retryable = true;
      var retryable = e.retryable || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      if (tries > 0 && retryable) {
        // 退避拉長：Google 慢的時候馬上重打只會一起塞住
        var waitMs = 1500 * (5 - tries);
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

/* 線上報名表的「信眾姓名」是報名帳號的擁有人，「登記姓名」才是真正要受戒的人。
   兩欄不一定一樣（例如太太用自己的帳號幫先生報名）。
   所以 name 一律先取「登記姓名」，沒有那一欄或那一格空白時才退回「信眾姓名」，
   帳號擁有人另外收在 account，畫面與列印會標出來，方便聯絡。
   這樣寫的好處：哪天寺方在菩薩戒-線上也加上「登記姓名」欄，不必改程式就會自動生效。 */
var SRC_DEFS = [
  { tab: '菩薩戒-線上', vow: '菩薩戒', kind: '線上',
    F: { seq: '流水號', name: '登記姓名', nameAlt: '信眾姓名', account: '信眾姓名',
         fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '皈依師長', city: '縣市', note: '備註', active: '啟用', vows: ['增益戒'] } },
  { tab: '菩薩戒-紙本', vow: '菩薩戒', kind: '紙本',
    F: { seq: '流水號', name: '姓名', fm: '法名', sex: '性別', dob: '生日', phone: '電話',
         from: '推薦之分院/其他', city: '縣市', note: '寶', age: '年齡', job: '職業', vows: ['增益戒'] } },
  { tab: '三皈五戒-線上', vow: '三皈五戒', kind: '線上',
    F: { seq: '流水號', name: '登記姓名', nameAlt: '信眾姓名', account: '信眾姓名',
         fm: '法名', sex: '性別', dob: '生日', phone: '電話',
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
      // 受戒的是「登記姓名」那個人；沒有這一欄（或空白）才退回「信眾姓名」
      var name = pick(header, row, F.name) || pick(header, row, F.nameAlt);
      // 紙本常常預留一堆只有流水號的空列，沒有姓名就不是真的報名者
      if (!name) { blank++; return; }
      taken++;
      // 報名帳號的擁有人，跟受戒者不同人時才記下來（聯絡時用得到）
      var acct = pick(header, row, F.account);
      if (acct === name) acct = '';
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
        account: acct,
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
/* ---------- 讓分班跟著「人」走，而不是跟著流水號走 ----------

   報名名單會增刪列，那是正常作業。但流水號是「位置編號」，一有增刪就整批位移，
   而分班原本用「戒別-來源-流水號」當 key，於是別人改名單就會讓班別滑到別人身上。

   分班表裡本來就存了當初的「姓名」，那份才是真正的意圖。
   所以每次載入都重新對應一次：姓名（加法名輔助）對得上誰，這筆分班就是誰的。
   同名同法名有兩個人時不猜，維持原樣並標示出來讓人決定。                     */
function rebindAssigns(raw) {
  var byKey = {};
  state.people.forEach(function (p) { byKey[p.key] = p; });

  // 以「戒別｜姓名｜法名」建索引；法名空白的另外用「戒別｜姓名」兜底
  var idx = {}, idxLoose = {};
  function push(m, k, p) { (m[k] = m[k] || []).push(p); }
  state.people.forEach(function (p) {
    push(idx, p.vow + '|' + p.name + '|' + (p.fm || ''), p);
    push(idxLoose, p.vow + '|' + p.name, p);
  });

  state.rawAssigns = raw;
  var out = {}, rebound = [], lost = [], locked = {};

  /* 第一輪：key 指到的人就是當初存的人 —— 這是「現在正確、不容懷疑」的那些，
     包含使用者剛剛才重新排好的。先全部鎖住，後面任何重新對應都不准蓋掉它們。 */
  Object.keys(raw).forEach(function (k) {
    var a = raw[k], here = byKey[k];
    if (here && here.name === a.name) { out[k] = a; locked[k] = 1; }
  });

  /* 第二輪：剩下的才是位移或失聯的。只能填進「沒被鎖住」的位子。 */
  Object.keys(raw).forEach(function (k) {
    if (locked[k]) return;
    var a = raw[k];

    var hit = idx[(a.vow || '') + '|' + (a.name || '') + '|' + (a.fm || '')] || [];
    if (hit.length !== 1) hit = idxLoose[(a.vow || '') + '|' + (a.name || '')] || [];
    if (hit.length === 1) {
      var p = hit[0];
      if (locked[p.key]) {
        // 這個人已經有一筆「現在正確」的分班（通常就是使用者剛重新排的）。
        // 舊的這筆是殘留，絕對不可以蓋過去。
        lost.push({ key: k, name: a.name, fm: a.fm, cls: a.cls, vow: a.vow,
                    reason: '這個人已有較新的分班（' + (out[p.key].cls || '未分班') + '），這筆是舊殘留' });
        return;
      }
      var prev = out[p.key];
      if (prev && String(prev.at || '') >= String(a.at || '')) {
        lost.push({ key: k, name: a.name, fm: a.fm, cls: a.cls, vow: a.vow, reason: '同一人有多筆舊資料，保留較新的那筆' });
        return;
      }
      out[p.key] = { key: p.key, vow: p.vow, src: p.src, seq: p.seq, name: p.name, fm: p.fm,
                     cls: a.cls, head: a.head, note: a.note, at: a.at, by: a.by, _from: k };
      rebound = rebound.filter(function (r) { return r.to !== p.key; });
      rebound.push({ from: k, to: p.key, name: a.name, cls: a.cls });
      return;
    }
    lost.push({ key: k, name: a.name, fm: a.fm, cls: a.cls, vow: a.vow,
                reason: hit.length > 1 ? '同名多人，不敢自行判斷' : '來源名單已查無此人' });
  });

  state.rebound = rebound;
  state.lostAssigns = lost;
  return out;
}

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
  if (cls === (a.cls || '') && note === (a.note || '') && !!head === !!a.head) { delete state.pending[key]; return; }
  // baseAt 在「開始改這一筆」的當下就定下來，之後不管 state.assigns 因為別的原因被刷新
  // （例如存完設定會順便重新載入），都不可以偷偷換掉，否則衝突偵測會失效、變成靜默覆蓋別人。
  var baseAt = (key in state.pending) ? state.pending[key].baseAt : (a.at || '');
  state.pending[key] = { cls: cls, note: note, head: !!head, baseAt: baseAt };
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
/* ---------- 引禮師：一個班一位，key 就是班別 ---------- */

/** 這一班目前的引禮師（含還沒儲存的） */
function guideOf(cls) {
  if (cls in state.pendingGuides) return state.pendingGuides[cls].who;
  var g = state.guides[cls];
  return g ? (g.who || '') : '';
}

/** 指派／取消。baseAt 在「開始改這一班」當下就定下來，之後不管 state.guides
    因為別的原因被刷新，都不會被偷換掉——跟分班那邊同一條規矩。 */
function setGuide(cls, who) {
  who = String(who || '').trim();
  var g = state.guides[cls];
  var cur = g ? (g.who || '') : '';
  if (who === cur) { delete state.pendingGuides[cls]; return; }
  var baseAt = (cls in state.pendingGuides) ? state.pendingGuides[cls].baseAt : (g ? (g.at || '') : '');
  state.pendingGuides[cls] = { who: who, baseAt: baseAt };
}

/** 這位法師已經被排到哪一班（避免一人被排兩班） */
function classOfGuide(who) {
  if (!who) return '';
  var hit = '';
  allClasses().concat(extraClasses()).forEach(function (c) {
    if (!hit && guideOf(c) === who) hit = c;
  });
  return hit;
}

function guideRoster() { return (state.settings.guides || []).slice(); }

/* ---------- 男眾保留班別 ---------- */
/** 哪些班只保留給男眾（來自設定，預設東1–東4）。東西的意義是使用者指定的，不是推定的。 */
function maleOnlyClasses() { return (state.settings.maleOnly || []).slice(); }
function isMaleOnly(cls) { return cls && maleOnlyClasses().indexOf(cls) >= 0; }

/** 這個人被排進男眾保留班、但不是男眾 → 回傳提示字；沒問題回空字串。
    性別空白也要報，因為那代表「不知道」，不可以當成沒事。 */
function maleOnlyIssue(p) {
  var c = clsOf(p.key);
  if (!isMaleOnly(c)) return '';
  if (p.sex === 'M') return '';
  return c + ' 保留男眾，這位是' + (p.sex === 'F' ? '女眾' : '性別未填');
}
function guideDirtyCount() { return Object.keys(state.pendingGuides).length; }

function dirtyCount() { return Object.keys(state.pending).length; }

/* 分班與引禮師是兩份待存清單。所有「要不要攔住使用者」的判斷都必須兩份一起看，
   只看其中一份就會把另一份靜默丟掉，或讓它殘留到下一個登入的人畫面上。 */
function allDirty() { return dirtyCount() + guideDirtyCount() + welcomeDirty(); }
function dirtyLabel() {
  var n = dirtyCount(), g = guideDirtyCount();
  var w = welcomeDirty();
  return [n ? n + ' 筆分班' : '', g ? g + ' 班引禮師' : '', w ? '出班迎請名單' : ''].filter(Boolean).join('、');
}

var EXCLUDE = '✕ 排除';

/* ===================== 載入 ===================== */
function load(fresh) {
  // 要最新的就不能搭別人的便車，否則「重新整理」可能拿到剛好在飛的那個快取版本
  if (loadingPromise && !fresh) return loadingPromise;
  loadingPromise = api('load', fresh ? { fresh: true } : {}).then(function (d) {
    role = d.role || 'admin';
    state.settings = d.settings || { title: '', classes: [] };
    state.people = normalizeSource(d.source || {});
    state.assigns = {};
    (d.assigns || []).forEach(function (a) { if (a && a.key) state.assigns[a.key] = a; });
    state.assigns = rebindAssigns(state.assigns);
    state.guides = {};
    (d.guides || []).forEach(function (g) { if (g && g.key) state.guides[g.key] = g; });
    state.rev = d.rev || 0;
    state.online = d.online || [];
    state.conflicts = [];
    state.guideConflicts = [];
    computeWarnings();
    state.srcInfo = (state.srcStat || []).map(function (s) {
      if (s.missing) return s.tab + '：找不到這個分頁';
      return s.tab + ' ' + s.taken + ' 人' + (s.blank ? '（另有 ' + s.blank + ' 列沒填姓名，當成空白列略過）' : '');
    }).join('；') + '。合計 ' + state.people.length + ' 人。' +
      '後端時間 ' + (d.serverTime || '') +
      (d.took != null ? '（讀取 ' + (d.took / 1000).toFixed(1) + ' 秒' + (d.cached ? '，用快取' : '，直接讀試算表') + '）' : '');
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
      (c === EXCLUDE ? '' : (function () {
        var g = guideOf(c);
        return '<span class="cguide' + (g ? '' : ' none') + '">' + (g ? '引 ' + esc(g) : '未排引禮師') + '</span>';
      })()) +
      (isMaleOnly(c) ? (function () {
        var bad = scoped().filter(function (p) { return clsOf(p.key) === c && p.sex !== 'M'; }).length;
        return '<span class="cmale' + (bad ? ' bad' : '') + '">' +
          (bad ? '⚠ 男眾班有 ' + bad + ' 位非男眾' : '男眾班') + '</span>';
      })() : '') +
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

/* 警示明細預設展開；但手機螢幕小，明細會把名單推到很下面，
   所以窄螢幕預設收合——摘要那條橫條仍然一直顯示，警示不會被藏起來。 */
var warnOpen = !(window.matchMedia && window.matchMedia('(max-width:820px)').matches);

function renderWarnings() {
  var w = state.warn;
  var box = $('#warnBox');
  var html = '';
  // 排錯班放最前面：這是當下就會造成現場出錯的事，比資料品質問題急
  var moBad = scoped().filter(function (p) { return maleOnlyIssue(p); });
  if (moBad.length) {
    html += '<h3>⚠ 有 ' + moBad.length + ' 位被排進男眾保留班（' + esc(maleOnlyClasses().join('、')) + '）</h3><ul>';
    moBad.forEach(function (p) {
      html += '<li><span class="hit">' + esc(p.name) + '</span>（' + esc(p.fm || '無法名') + '）<span class="sep">—</span> ' +
        esc(clsOf(p.key)) + '，' + (p.sex === 'F' ? '女眾' : '性別未填') + '</li>';
    });
    html += '</ul>';
  }
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
  if (moBad.length) sum.push('排進男眾班 ' + moBad.length + ' 位');
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
    if (fWarn === 'male' && !maleOnlyIssue(p)) return false;
    if (fWarn === 'data' && !p.wData) return false;
    if (q) {
      // 搜尋也要吃得到報名帳號：信眾只記得自己帳號的名字時找得到人
      var hay = (p.name + ' ' + p.account + ' ' + p.fm + ' ' + p.phone + ' ' + p.from + ' ' + p.city + ' ' + p.note).toLowerCase();
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
    var mo = maleOnlyIssue(p);
    if (mo) badges += '<span class="badge male" title="' + esc(mo) + '">排錯班</span>';
    if (p.wDup) badges += '<span class="badge dup" title="同一個戒別裡出現兩筆，疑似重複報名">重複報名</span>';
    if (p.wFm) badges += '<span class="badge fm" title="有別人也用這個法名">法名重複</span>';
    if (p.wData) badges += '<span class="badge data" title="' + esc(p.wData) + '">待確認</span>';
    var vowCell = '<span class="badge vow' + (p.vow === '菩薩戒' ? ' ps' : ' sg') + '">' + esc(p.vow) + '</span>' +
      (p.items ? '<span class="items">' + esc(p.items) + '</span>' : '') +
      (p.wBoth ? '<span class="badge both" title="這個人菩薩戒與三皈五戒都有報名">兩戒都受</span>' : '');
    return '<tr class="' + (p.key in state.pending ? 'dirty ' : '') + (p.active ? '' : 'off') + '" data-key="' + esc(p.key) + '">' +
      '<td class="c-chk no-print"><input type="checkbox" class="rowChk" data-key="' + esc(p.key) + '"' + (checked[p.key] ? ' checked' : '') + '></td>' +
      '<td class="c-no">' + (i + 1) + '</td>' +
      '<td class="c-name">' + esc(p.name) +
        (p.account ? '<span class="acct" title="報名帳號的擁有人，不是受戒者">帳號：' + esc(p.account) + '</span>' : '') + '</td>' +
      '<td class="c-fm" data-label="法名">' + esc(p.fm || '—') + (p.wFm ? '<span class="badge fm">重</span>' : '') + '</td>' +
      '<td class="c-vow" data-label="戒別">' + vowCell + '</td>' +
      '<td class="c-sex" data-label="性別">' + (p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '—') + '</td>' +
      '<td class="c-age" data-label="年齡" data-known="' + (p.age == null ? '0' : '1') + '">' + (p.age == null ? '—' : p.age) + '</td>' +
      '<td class="c-cls" data-label="班別">' + clsSelectHtml(p.key, cur) + '</td>' +
      '<td class="c-head no-print" data-label="班首"><button class="headBtn' + (headOf(p.key) ? ' on' : '') + '"' +
        ' data-key="' + esc(p.key) + '"' + (isGuest() ? ' disabled' : '') +
        ' title="' + (headOf(p.key) ? '取消班首' : '設為這一班的班首') + '">★</button></td>' +
      '<td class="c-pnote no-print" data-label="分班備註"><input class="noteIn" type="text" autocomplete="off" placeholder="分班備註"' +
        ' data-key="' + esc(p.key) + '" value="' + esc(noteOf(p.key)) + '"' + (isGuest() ? ' disabled' : '') + '></td>' +
      '<td class="c-dob" data-label="生日">' + esc(p.dobRaw || '—') + '</td>' +
      '<td class="c-src" data-label="來源"><span class="badge src' + (p.src === '紙本' ? ' paper' : '') + '">' + esc(p.src) + ' #' + esc(p.seq) + '</span></td>' +
      '<td class="c-from" data-label="分院／皈依師長">' + esc(p.from || '—') + '</td>' +
      '<td class="c-phone" data-label="電話">' + esc(p.phone || '—') + '</td>' +
      '<td class="c-note" data-label="備註">' + esc(p.note || '') + badges + '</td>' +
      '</tr>';
  }).join('');
  $('#tbody').innerHTML = rows;
  refreshClassLabels();
  $('#empty').hidden = list.length > 0;
  $('#chkAll').checked = list.length > 0 && list.every(function (p) { return checked[p.key]; });
  renderBulk();
}

/** 引禮師指派面板：14 班一列一個下拉。已被排走的法師會標出在哪一班，避免一人排兩班。 */
var guideOpen = false;
function renderGuides() {
  var box = $('#guidebox');
  if (!box) return;
  var classes = allClasses().concat(extraClasses());
  var roster = guideRoster();
  var done = classes.filter(function (c) { return guideOf(c); }).length;

  $('#guideSummary').textContent = '已排 ' + done + '／' + classes.length + ' 班' +
    (guideDirtyCount() ? '　有 ' + guideDirtyCount() + ' 班未儲存' : '');
  $('#guideCaret').textContent = guideOpen ? '收合 ▲' : '展開 ▼';
  var body = $('#guideBody');
  body.hidden = !guideOpen;
  if (!guideOpen) return;

  if (!roster.length) {
    body.innerHTML = '<p class="muted small">還沒有引禮師名單。請到「設定 → 引禮師名單」填入，用逗號分隔。</p>';
    return;
  }
  var cnt = countByClass();
  // 先建「法師 → 已排哪一班」對照表。原本在選項迴圈裡呼叫 classOfGuide()，
  // 每次都重掃一遍全部報名資料，14 班 × 33 位要掃四百多次。
  var whoAt = {};
  classes.forEach(function (c) { var w = guideOf(c); if (w && !(w in whoAt)) whoAt[w] = c; });
  body.innerHTML = '<div class="guidegrid">' + classes.map(function (c) {
    var cur = guideOf(c);
    var n = (cnt[c] || {}).n || 0;
    /* 名單被改短時，已經指派出去的人要補回選項，否則下拉會顯示成「未排」騙人，
       但看板與列印仍然照印他——跟班別下拉同一道保險。 */
    var list = roster.slice();
    if (cur && list.indexOf(cur) < 0) list = list.concat([cur]);
    var opts = '<option value="">— 未排 —</option>' + list.map(function (w) {
      var at = whoAt[w] || '';
      var busy = at && at !== c;
      var gone = roster.indexOf(w) < 0;
      return '<option value="' + esc(w) + '"' + (w === cur ? ' selected' : '') +
        '>' + esc(w) + (gone ? '（已不在名單）' : '') + (busy ? '（已排 ' + esc(at) + '）' : '') + '</option>';
    }).join('');
    return '<label class="guiderow' + (c in state.pendingGuides ? ' dirty' : '') + '">' +
      '<span class="gcls">' + esc(c) + '<span class="gnum">' + n + ' 人</span></span>' +
      '<select class="guideSel" data-cls="' + esc(c) + '"' + (isGuest() ? ' disabled' : '') + '>' + opts + '</select>' +
      '</label>';
  }).join('') + '</div>' +
  (isGuest()
    ? '<p class="muted small">訪客只能查看，不能修改引禮師。</p>'
    : '<p class="muted small">一位法師排兩班時，選單會標出他已經在哪一班，但系統不會替您擋下來。改完記得按右下角「儲存分班」。</p>');
}

/* ---------- 出班迎請 ---------- */
/* 人數不固定，男女各一份，可以自由增減。還沒儲存的放在 pendingWelcome，
   跟分班一樣「不按儲存就不會進資料庫」，也跟著「還原未存變更」一起丟掉。 */
var pendingWelcome = null;   // null＝沒有未存變更；否則 {M:[], F:[]}

function welcomeList() {
  if (pendingWelcome) return pendingWelcome;
  return { M: (state.settings.welcomeM || []).slice(), F: (state.settings.welcomeF || []).slice() };
}
function welcomeDirty() {
  if (!pendingWelcome) return 0;
  var a = pendingWelcome, b = { M: state.settings.welcomeM || [], F: state.settings.welcomeF || [] };
  return (a.M.join(',') !== b.M.join(',') || a.F.join(',') !== b.F.join(',')) ? 1 : 0;
}
function setWelcome(next) {
  pendingWelcome = next;
  if (!welcomeDirty()) pendingWelcome = null;
}

function renderWelcome() {
  var box = $('#welcomeBody');
  if (!box) return;
  var w = welcomeList();
  var ro = isGuest();
  function col(sexKey, title, cls) {
    var arr = w[sexKey];
    return '<div class="wcol"><h3 class="' + cls + '">' + title + '　<span class="muted small">' + arr.length + ' 位</span></h3>' +
      '<ol class="wlist">' + arr.map(function (n, i) {
        return '<li><span class="wn">' + (i + 1) + '</span>' +
          '<input class="wIn" type="text" data-s="' + sexKey + '" data-i="' + i + '" value="' + esc(n) + '"' +
          (ro ? ' disabled' : '') + '>' +
          (ro ? '' :
            '<button class="wup" data-s="' + sexKey + '" data-i="' + i + '" title="往上">↑</button>' +
            '<button class="wdel" data-s="' + sexKey + '" data-i="' + i + '" title="刪掉這一位">✕</button>') +
          '</li>';
      }).join('') + '</ol>' +
      (ro ? '' : '<button class="btn wadd" data-s="' + sexKey + '">＋ 新增一位</button>') +
      '</div>';
  }
  box.innerHTML = '<div class="wgrid">' + col('M', '男眾', 'e') + col('F', '女眾', 'w') + '</div>' +
    '<p class="muted small">共 ' + (w.M.length + w.F.length) + ' 位。' +
    (ro ? '訪客只能查看。' : '改完按右下角「儲存分班」一起存。空白的名字儲存時會自動略過。') + '</p>';
}

function renderBulk() {
  var n = Object.keys(checked).filter(function (k) { return checked[k]; }).length;
  $('#bulkbar').hidden = n === 0 || isGuest();
  if ($('#btnSelAll')) $('#btnSelAll').hidden = isGuest();   // 訪客本來就不能批次指定
  $('#bulkN').textContent = n;
}

function renderSave() {
  var n = dirtyCount(), g = guideDirtyCount(), wv = welcomeDirty(), tot = n + g + wv;
  $('#btnSave').disabled = tot === 0 || isGuest();
  $('#btnRevert').disabled = tot === 0;
  $('#savebar').className = 'savebar no-print' + (tot ? ' hot' : '');
  $('#saveHint').textContent = tot
    ? ([n ? '有 ' + n + ' 筆分班' : '', g ? g + ' 班引禮師' : '', wv ? '出班迎請名單' : '']
         .filter(Boolean).join('、') + ' 還沒儲存')
    : '尚無未儲存的變更';
  $('#saveHint').className = tot ? '' : 'muted';
}

/** 上方那條通知：別人改過了、或剛剛有幾筆沒套用 */
function renderNotice() {
  var box = $('#notice');
  if (!box) return;
  var html = '';

  if (state.conflicts.length) {
    html += '<div class="nrow bad"><b>有 ' + state.conflicts.length + ' 位在您編輯時被別人改過，您的修改沒有覆蓋過去：</b><ul>' +
      state.conflicts.slice(0, 8).map(function (c) {
        return '<li>' + esc(c.name || c.key) + '：' +
          esc(c.theirBy || '別人') + ' 已改成「' + esc(c.theirCls || '未分班') + '」' +
          (c.myCls ? '，您想改成「' + esc(c.myCls) + '」' : '') + '</li>';
      }).join('') +
      (state.conflicts.length > 8 ? '<li>…還有 ' + (state.conflicts.length - 8) + ' 位</li>' : '') +
      '</ul><span class="muted small">這幾筆還留在您的待存清單裡。確認要用您的版本就再按一次「儲存分班」，要用對方的就按「還原未存變更」。</span></div>';
  }

  if (state.rebound.length || state.lostAssigns.length) {
    html += '<div class="nrow bad"><b>報名名單的順序變動過，系統已經自動把分班跟回原本的人。</b><ul>';
    if (state.rebound.length) {
      html += '<li><b>' + state.rebound.length + ' 筆</b>已自動跟回正確的人：' +
        esc(state.rebound.slice(0, 6).map(function (r) { return r.name + '→' + (r.cls || '未分班'); }).join('、')) +
        (state.rebound.length > 6 ? ' …等' : '') + '</li>';
    }
    if (state.lostAssigns.length) {
      html += '<li><b>' + state.lostAssigns.length + ' 筆</b>找不到對應的人，<b>沒有套用到任何人身上</b>：' +
        esc(state.lostAssigns.slice(0, 6).map(function (r) { return r.name + '（' + r.reason + '）'; }).join('、')) +
        (state.lostAssigns.length > 6 ? ' …等' : '') + '</li>';
    }
    html += '</ul><span class="muted small">畫面上顯示的已經是修正後的結果。' +
      (state.rebound.length && !isGuest()
        ? '按右邊的鈕把修正寫回系統，之後就不會再跑掉。'
        : '') + '</span>' +
      (state.rebound.length && !isGuest()
        ? ' <button id="btnFixBind" class="btn">把修正寫回系統（' + state.rebound.length + ' 筆）</button>'
        : '') +
      '</div>';
  }

  if (state.guideConflicts.length) {
    html += '<div class="nrow bad"><b>有 ' + state.guideConflicts.length +
      ' 班的引禮師在您編輯時被別人改過，您的指派沒有覆蓋過去：</b><ul>' +
      state.guideConflicts.slice(0, 8).map(function (c) {
        return '<li>' + esc(c.cls || c.key) + '：' +
          esc(c.theirBy || '別人') + ' 已改成「' + esc(c.theirWho || '未排') + '」' +
          (c.myWho ? '，您想改成「' + esc(c.myWho) + '」' : '，您想取消') + '</li>';
      }).join('') +
      (state.guideConflicts.length > 8 ? '<li>…還有 ' + (state.guideConflicts.length - 8) + ' 班</li>' : '') +
      '</ul><span class="muted small">畫面與列印目前顯示的是「您的版本」。確定要用自己的就再按一次「儲存分班」，' +
      '要聽對方的就按「還原未存變更」。</span></div>';
  }

  if (newerRev) {
    html += '<div class="nrow"><b>其他人剛更新了分班資料。</b>' +
      '<button id="btnTakeNew" class="btn">載入最新</button>' +
      '<span class="muted small">' + (allDirty() ? '您有 ' + dirtyLabel() + '還沒儲存，建議先儲存再載入。' : '') + '</span></div>';
  }

  box.innerHTML = html;
  box.hidden = !html;
  on('#btnFixBind', 'click', function () {
    if (isGuest() || !state.rebound.length) return;
    if (!confirm('把 ' + state.rebound.length + ' 筆分班寫回到正確的人身上？\n' +
                 '（班別內容不變，只是改成跟著人走）')) return;

    /* 分兩階段，而且順序不可以顛倒。
       純位移時「舊 key」往往同時是別人的「新 key」，若先刪再寫，
       後端依序處理到寫入時那一列已經不在，baseAt 對不上就整批失敗——
       但刪除已經生效，人就不見了。所以：
         第一階段：把最終狀態全部寫進去（完全不刪，失敗也不會掉資料）
         第二階段：確認零衝突，才清掉沒人用到的舊列                      */
    var finalKeys = {};
    Object.keys(state.assigns).forEach(function (k) { finalKeys[k] = 1; });
    var writes = Object.keys(state.assigns).map(function (k) {
      var a = state.assigns[k], raw = state.rawAssigns[k];
      return { key: k, vow: a.vow, src: a.src, seq: a.seq, name: a.name, fm: a.fm,
               cls: a.cls, head: !!a.head, note: a.note || '',
               baseAt: raw ? (raw.at || '') : '' };
    });
    var stale = Object.keys(state.rawAssigns).filter(function (k) { return !finalKeys[k]; });

    var btn = $('#btnFixBind');
    if (btn) { btn.disabled = true; btn.textContent = '寫回中…'; }
    api('saveAssign', { items: writes }).then(function (d) {
      var c = (d.conflicts || []).length;
      if (c) {
        // 有衝突就停在這裡，一列都不刪，資料完整保留
        toast('有 ' + c + ' 筆剛被別人改過，為了安全沒有繼續，也沒有刪除任何資料。請重新整理後再試一次。', true);
        return load(true).then(function () { fillClassSelects(); renderAll(); });
      }
      if (!stale.length) {
        toast('已寫回 ' + (d.saved || 0) + ' 筆，分班現在跟著人走了');
        return load(true).then(function () { newerRev = 0; fillClassSelects(); renderAll(); });
      }
      var dels = stale.map(function (k) {
        var o = state.rawAssigns[k];
        return { key: k, vow: o.vow, src: o.src, seq: o.seq, name: o.name, fm: o.fm,
                 cls: '', head: false, note: '', baseAt: o.at || '' };
      });
      return api('saveAssign', { items: dels }).then(function (d2) {
        toast('已寫回 ' + (d.saved || 0) + ' 筆，清掉 ' + (d2.removed || 0) + ' 筆沒人用到的舊列');
        return load(true).then(function () { newerRev = 0; fillClassSelects(); renderAll(); });
      });
    }).catch(function (e) {
      toast(e.message || '寫回失敗，沒有刪除任何資料', true);
      var b = $('#btnFixBind'); if (b) { b.disabled = false; b.textContent = '把修正寫回系統'; }
    });
  });

  on('#btnTakeNew', 'click', function () {
    if (allDirty() && !confirm('您還有 ' + dirtyLabel() + '沒儲存，載入最新會把它們丟掉。確定嗎？\n（想保留就先按取消，去按「儲存分班」）')) return;
    state.pending = {}; state.pendingGuides = {};
    load(true).then(function () { fillClassSelects(); newerRev = 0; renderAll(); toast('已載入最新'); })
      .catch(function (e) { toast(e.message || '載入失敗', true); });
  });
}

/** 右上角顯示還有誰在線上 */
function renderWho() {
  var el = $('#online');
  if (!el) return;
  var list = (state.online || []).filter(function (o) { return o.who; });
  if (!list.length) { el.textContent = ''; el.title = ''; return; }
  el.textContent = '　同時在線：' + list.slice(0, 3).map(function (o) { return o.who; }).join('、') +
    (list.length > 3 ? ' 等 ' + list.length + ' 人' : '');
  el.title = list.map(function (o) { return o.who + '（' + o.ago + ' 秒前）'; }).join('\n');
}

function renderAll() {
  renderNotice();
  renderWho();
  renderStats();
  renderBoard();
  renderGuides();
  renderWelcome();
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
/** 出班迎請存檔。空白名字自動略過，不會存進去。 */
function saveWelcome() {
  if (!welcomeDirty()) return Promise.resolve(null);
  var w = welcomeList();
  var clean = function (a) { return a.map(function (x) { return String(x || '').trim(); }).filter(Boolean); };
  var M = clean(w.M), F = clean(w.F);
  return api('saveSettings', { settings: { '出班迎請-男': M.join(','), '出班迎請-女': F.join(',') } })
    .then(function (d) {
      state.settings.welcomeM = M; state.settings.welcomeF = F;
      pendingWelcome = null;
      return d;
    });
}

/** 引禮師存檔。跟分班一樣只送改過的那幾班，衝突不覆蓋。 */
function saveGuides() {
  var keys = Object.keys(state.pendingGuides);
  if (!keys.length) return Promise.resolve(null);
  var items = keys.map(function (c) {
    return { key: c, cls: c, vow: vowScope || '', who: state.pendingGuides[c].who,
             baseAt: state.pendingGuides[c].baseAt || '' };
  });
  return api('saveGuides', { items: items }).then(function (d) {
    /* 逾時／中繼頁會自動重送，而第一次其實已經寫進試算表了。
       重送回來的「衝突」其實是自己剛寫的那一版，不可以報給使用者看——
       分班那邊早就有這段判定，引禮師漏掉會變成「14 班全被別人改過」的假警報。 */
    var myWho = {};
    items.forEach(function (it) { myWho[it.key] = String(it.who || ''); });
    var clash = {};
    (d.conflicts || []).forEach(function (c) {
      var mine =
        (String(c.theirBy || '') === String(operator) &&
         String(c.theirWho || '') === String(myWho[c.key] || '')) ||
        // 取消指派的回音：那一列已經被我刪掉，所以對方欄位全空
        (!c.theirAt && !c.theirWho && !String(myWho[c.key] || ''));
      if (mine) return;
      clash[c.key] = 1;
      // 下次再按儲存要以「對方現在的時間戳」為基準，否則永遠卡在衝突
      if (state.pendingGuides[c.key]) state.pendingGuides[c.key].baseAt = c.theirAt || '';
    });
    state.guideConflicts = (d.conflicts || []).filter(function (c) { return clash[c.key]; });
    keys.forEach(function (c) {
      if (clash[c]) return;
      // 存檔途中使用者又改了這一班 → 新值要留著當未存，不可以跟著被清掉
      var still = state.pendingGuides[c];
      if (still && String(still.who || '') !== String(myWho[c] || '')) return;
      delete state.pendingGuides[c];
    });
    // 回音那幾班其實已經寫進去了，後續的 toast 與「要不要關橫幅」都要用過濾後的清單
    return Object.assign({}, d, { conflicts: state.guideConflicts });
  });
}

function save() {
  var keys = Object.keys(state.pending);
  // 只改了引禮師或出班迎請：一樣要鎖按鈕（擋連點）、一樣要接錯誤（失敗不可以無聲）
  if (!keys.length) {
    if (!guideDirtyCount() && welcomeDirty()) {
      $('#btnSave').disabled = true; $('#btnSave').textContent = '儲存中…';
      return saveWelcome().then(function () {
        toast('已儲存出班迎請名單');
        return load(true).then(function () { newerRev = 0; renderAll(); });
      }).catch(function (e) {
        toast(e.message || '出班迎請儲存失敗', true); throw e;
      }).then(function () { $('#btnSave').textContent = '儲存分班'; renderSave(); },
              function () { $('#btnSave').textContent = '儲存分班'; renderSave(); });
    }
    if (!guideDirtyCount()) return Promise.resolve();
    $('#btnSave').disabled = true;
    $('#btnSave').textContent = '儲存中…';
    return saveWelcome().then(function () { return saveGuides(); }).then(function (d) {
      if (!d) return;
      var conflicts = d.conflicts || [];
      var cleanG = !conflicts.length;
      var msg = d.saved ? ('已儲存 ' + d.saved + ' 班引禮師') : '引禮師沒有變更';
      if (conflicts.length) msg += '，' + conflicts.length + ' 班因他人同時修改未套用';
      toast(msg, conflicts.length > 0);
      // load() 會把衝突清單歸零，但這份是「剛剛沒套用」的結果，要留著讓橫幅講出來
      return load(true).then(function () {
        state.guideConflicts = conflicts;
        if (cleanG) newerRev = 0;
        renderAll();
      });
    }).catch(function (e) {
      toast(e.message || '引禮師儲存失敗', true);
      throw e;
    }).then(function () {
      $('#btnSave').textContent = '儲存分班'; renderSave();
    }, function () {
      $('#btnSave').textContent = '儲存分班'; renderSave();
    });
  }
  var byKey = {};
  state.people.forEach(function (p) { byKey[p.key] = p; });
  var items = keys.map(function (k) {
    var p = byKey[k] || {};
    return { key: k, vow: p.vow || '', src: p.src || '', seq: p.seq || '', name: p.name || '', fm: p.fm || '',
             cls: state.pending[k].cls, head: !!state.pending[k].head, note: state.pending[k].note || '',
             // 我開始改這一筆時看到的更新時間；後端拿去比對，不一樣就不蓋掉別人的
             baseAt: state.pending[k].baseAt || '' };
  });
  $('#btnSave').disabled = true;
  $('#btnSave').textContent = '儲存中…';
  return api('saveAssign', { items: items }).then(function (d) {
    var clash = {};
    (d.conflicts || []).forEach(function (c) {
      // 逾時自動重送時，第一次其實已經寫進去了：回來的「衝突」其實是我自己剛存的那一版。
      // 內容一樣又是自己存的，就不要嚇使用者。
      var mine = String(c.theirBy || '') === String(operator) &&
                 String(c.theirCls || '') === String(c.myCls || '');
      if (!mine) clash[c.key] = c;
    });

    items.forEach(function (it) {
      if (clash[it.key]) {
        // 這一筆沒套用：把別人的現況收進來當新的基準，使用者的修改原樣留著不丟
        var c = clash[it.key];
        if (c.theirCls || c.theirNote) {
          state.assigns[it.key] = { key: it.key, vow: it.vow, src: it.src, seq: it.seq, name: it.name, fm: it.fm,
                                    cls: c.theirCls, head: c.theirHead, note: c.theirNote, at: c.theirAt, by: c.theirBy };
        } else {
          delete state.assigns[it.key];
        }
        // 基準換成對方的現況：使用者確認後再按一次儲存，就是明確地用自己的版本覆蓋
        if (state.pending[it.key]) state.pending[it.key].baseAt = c.theirAt || '';
        return;
      }
      if (!it.cls && !it.note) delete state.assigns[it.key];
      else state.assigns[it.key] = { key: it.key, vow: it.vow, src: it.src, seq: it.seq, name: it.name, fm: it.fm,
                                     cls: it.cls, head: it.head, note: it.note, at: d.at, by: operator };
    });

    // 只清掉「這次真的送出去的」那幾筆；存檔途中使用者又改的不可以跟著被刪掉
    keys.forEach(function (k) { if (!clash[k]) delete state.pending[k]; });
    state.conflicts = Object.keys(clash).map(function (k) { return clash[k]; });

    /* 版本號不可以照單全收。
       伺服器回的 rev 可能已經含了別人在我載入之後做的修改，而回應裡只帶回「跟我撞到的那幾筆」，
       別人改過、我沒碰到的那些人並沒有回來。這時若把 state.rev 追平，
       「有人更新了」的橫幅就會被永久關掉，畫面停在舊資料卻再也不提醒。
       只有在「這次就只有我寫了一次、而且沒有任何衝突」時才算真的追上。 */
    if (typeof d.rev === 'number') {
      if (!state.conflicts.length && d.rev === state.rev + 1) { state.rev = d.rev; newerRev = 0; }
      else { newerRev = d.rev; }
    }
    // 分班與引禮師是兩次寫入，各自都會讓後端 rev +1。
    // 若等一下還要寫引禮師，這裡就不能先把 rev 追平，否則會把別人的更新提醒吃掉。
    if (guideDirtyCount()) { newerRev = typeof d.rev === 'number' ? d.rev : newerRev; }
    renderAll();

    var adj = (d.adjusted || []).filter(function (a) { return a && a.key; });
    if (state.conflicts.length) {
      toast('已儲存 ' + (d.saved || 0) + ' 筆；有 ' + state.conflicts.length + ' 位剛被別人改過，沒有覆蓋過去', true);
    } else if (adj.length) {
      toast('已儲存 ' + (d.saved || 0) + ' 筆；同班原本的班首（' +
        adj.map(function (a) { return a.name; }).join('、') + '）已自動卸任');
    } else {
      toast('已儲存 ' + (d.saved || 0) + ' 筆' + (d.removed ? '，移除 ' + d.removed + ' 筆' : ''));
    }
  }).then(function () {
    // 分班寫完才寫引禮師，兩者都走各自的衝突偵測
    if (!guideDirtyCount() && !welcomeDirty()) return;
    return saveWelcome().then(function () { return saveGuides(); }).then(function (g) {
      if (!g) return load(true).then(function () { renderAll(); });
      if (!g) return;
      if ((g.conflicts || []).length) {
        toast('引禮師有 ' + g.conflicts.length + ' 班剛被別人改過，沒有覆蓋過去', true);
      } else if (g.saved || g.removed) {
        toast('引禮師已儲存 ' + (g.saved || 0) + ' 班' + (g.removed ? '，取消 ' + g.removed + ' 班' : ''));
      }
      // 分班與引禮師是兩次寫入，rev 會 +2，追平邏輯只認 +1，所以這裡直接重讀最新。
      // 重讀之後畫面就是最新的，橫幅要關掉——但只有在兩邊都沒有衝突時才關，
      // 有衝突代表確實有人動過同一筆，那面橫幅要留著提醒。
      var clean = !state.conflicts.length && !(g.conflicts || []).length;
      // load() 會把 state.conflicts 與 guideConflicts 都歸零（「載入最新」那條路徑本來就該清），
      // 但這兩份是「這次儲存沒套用」的結果，洗掉的話連分班原本會亮的橫幅都會不見。
      var keepA = state.conflicts, keepG = g.conflicts || [];
      return load(true).then(function () {
        state.conflicts = keepA; state.guideConflicts = keepG;
        if (clean) newerRev = 0;
        renderAll();
      });
    });
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
          '<p class="colhead">班首：' + (hd ? esc(hd.fm || hd.name) : '—') + '</p>' +
          '<p class="colhead">引禮師：' + (guideOf(c) ? esc(guideOf(c)) : '—') + '</p><ol>' +
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
        '　引禮師：' + (guideOf(c) ? esc(guideOf(c)) : '＿＿＿＿＿') + '</p>' +
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
        '<td>' + esc([noteOf(p.key), p.account ? '報名帳號：' + p.account : '', p.note,
          p.wBoth ? '兩戒都受' : '', p.wDup ? '疑似重複報名' : '', p.wFm ? '法名重複' : ''].filter(Boolean).join('；')) + '</td></tr>';
    });
    h += '</tbody></table>';
    html = '<div class="sheet"><h2>全體戒子名冊</h2><p class="sheetsub">' + headLine() + '　共 ' + all.length + ' 人</p>' + h + '</div>';
  }
  $('#printArea').innerHTML = html;
}

function csvDump() {
  var rows = [['班別', '座號', '班首', '法名', '姓名', '報名帳號（非受戒者）', '戒別', '受戒項目', '性別', '年齡', '生日', '來源', '流水號', '分院／皈依師長', '電話', '分班備註', '報名表備註', '警示']];
  var A = assignedList();
  A.order.forEach(function (c) {
    (A.byCls[c] || []).forEach(function (p, i) { rows.push(line(p, c, i + 1)); });
  });
  A.out.forEach(function (p, i) { rows.push(line(p, EXCLUDE, i + 1)); });
  A.none.forEach(function (p, i) { rows.push(line(p, '未分班', i + 1)); });
  function line(p, c, i) {
    return [c, i, headOf(p.key) ? '★ 班首' : '', p.fm, p.name, p.account, p.vow, p.items, p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '', p.age == null ? '' : p.age,
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
    if (allDirty() && !confirm('還有 ' + dirtyLabel() + '沒儲存，確定要登出嗎？')) return;
    pw = ''; state.pending = {}; state.pendingGuides = {}; pendingWelcome = null; checked = {};
    state.conflicts = []; state.guideConflicts = []; newerRev = 0; stopPolling();
    $('#app').hidden = true; $('#gate').hidden = false;
    $('#gatePw').value = ''; $('#gateMsg').textContent = '';
  });

  on('#btnReload', 'click', function () {
    if (allDirty() && !confirm('還有 ' + dirtyLabel() + '沒儲存，重新整理會把它們丟掉，確定嗎？')) return;
    state.pending = {}; state.pendingGuides = {};
    $('#btnReload').disabled = true;
    // 重新整理一定要拿最新的，跳過後端快取
    load(true).then(function () { fillClassSelects(); newerRev = 0; renderAll(); toast('已重新載入'); })
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
      $('#viewNotice').hidden = v !== 'notice';
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
      var who = state.people.filter(function (x) { return x.key === k; })[0];
      if (who) {
        var mo = maleOnlyIssue(who);
        if (mo) toast('⚠ ' + who.name + '：' + mo, true);
        /* 這個 handler 刻意不呼叫 renderTable（整張重畫會讓游標與捲動位置跑掉），
           所以紅標要自己補上這一列，否則要等下次重畫才看得到。 */
        var row = sel.closest('tr');
        var note = row && row.querySelector('.c-note');
        if (note) {
          var old = note.querySelector('.badge.male');
          if (old) old.parentNode.removeChild(old);
          if (mo) {
            var b = document.createElement('span');
            b.className = 'badge male'; b.title = mo; b.textContent = '排錯班';
            note.appendChild(b);
          }
        }
      }
      renderStats(); renderBoard(); renderSave(); refreshClassLabels(); renderGuides(); renderWarnings();
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

  /* 手機版的全選。桌機是用表頭那個勾選框，但手機把表頭收起來了（卡片版面沒有表頭），
     所以另外給一顆按鈕走同一套邏輯。按一次全選，再按一次全部取消。
     注意不能放進 #bulkbar——那條在還沒勾任何人時是隱藏的，等於永遠按不到。 */
  on('#btnSelAll', 'click', function () {
    if (isGuest()) return;
    var list = visiblePeople();
    var allOn = list.length > 0 && list.every(function (p) { return checked[p.key]; });
    list.forEach(function (p) { checked[p.key] = !allOn; });
    renderTable();
  });

  on('#btnBulk', 'click', function () {
    var c = $('#bulkCls').value;
    var keys = Object.keys(checked).filter(function (k) { return checked[k]; });
    if (!keys.length) return;
    keys.forEach(function (k) { setCls(k, c); });
    var bad = state.people.filter(function (x) { return keys.indexOf(x.key) >= 0 && maleOnlyIssue(x); });
    checked = {};
    renderAll();
    toast('已把 ' + keys.length + ' 人指定到「' + (c || '未分班') + '」，記得按儲存' +
      (bad.length ? '；⚠ 其中 ' + bad.length + ' 位不是男眾' : ''), bad.length > 0);
  });
  on('#btnBulkClear', 'click', function () { checked = {}; renderTable(); });

  on('#welcomeBody', 'input', function (e) {
    var el = e.target.closest('.wIn'); if (!el || isGuest()) return;
    var w = welcomeList();
    w[el.getAttribute('data-s')][+el.getAttribute('data-i')] = el.value;
    setWelcome(w); renderSave();
  });
  on('#welcomeBody', 'click', function (e) {
    if (isGuest()) return;
    var w = welcomeList(), t;
    if ((t = e.target.closest('.wadd'))) {
      w[t.getAttribute('data-s')].push('');
      setWelcome(w); renderWelcome(); renderSave();
      var ins = $$('#welcomeBody .wIn[data-s="' + t.getAttribute('data-s') + '"]');
      if (ins.length) ins[ins.length - 1].focus();
      return;
    }
    if ((t = e.target.closest('.wdel'))) {
      var sx = t.getAttribute('data-s'), ix = +t.getAttribute('data-i');
      var nm = w[sx][ix];
      if (nm && !confirm('刪掉「' + nm + '」？')) return;
      w[sx].splice(ix, 1); setWelcome(w); renderWelcome(); renderSave(); return;
    }
    if ((t = e.target.closest('.wup'))) {
      var s2 = t.getAttribute('data-s'), i2 = +t.getAttribute('data-i');
      if (i2 <= 0) return;
      var tmp = w[s2][i2 - 1]; w[s2][i2 - 1] = w[s2][i2]; w[s2][i2] = tmp;
      setWelcome(w); renderWelcome(); renderSave(); return;
    }
  });

  on('#guideToggle', 'click', function () { guideOpen = !guideOpen; renderGuides(); });
  on('#guideBody', 'change', function (e) {
    var sel = e.target.closest('select.guideSel');
    if (!sel || isGuest()) return;
    setGuide(sel.getAttribute('data-cls'), sel.value);
    renderGuides(); renderBoard(); renderSave();
  });

  on('#btnSave', 'click', function () { save(); });
  on('#btnRevert', 'click', function () {
    var tot = dirtyCount() + guideDirtyCount();
    if (!tot) return;
    if (!confirm('把還沒儲存的 ' + tot + ' 筆變更丟掉？（含分班與引禮師）')) return;
    state.pending = {}; state.pendingGuides = {}; pendingWelcome = null;
    state.conflicts = []; state.guideConflicts = [];
    renderAll(); toast('已還原');
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
      '引禮師名單': $('#setGuides').value.trim(),
      '男眾保留班別': $('#setMaleOnly').value.trim(),
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
    if (!allDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function fillSettings() {
  $('#setTitle').value = state.settings.title || '';
  $('#setClasses').value = (state.settings.classes || []).join(',');
  $('#setGuides').value = (state.settings.guides || []).join(',');
  $('#setMaleOnly').value = (state.settings.maleOnly || []).join(',');
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
  ['#setTitle', '#setClasses', '#setGuides', '#setMaleOnly', '#setPw', '#setGuestPw', '#setGuestUntil'].forEach(function (s) {
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
  // 跑秒數給使用者看，不然畫面像當掉；Apps Script 第一次叫醒本來就要幾秒
  var t0 = Date.now();
  // 少一個元素不該讓登入掛掉——跟本檔 on() 的原則一致
  function setHint(txt) { var h = $('#gateHint'); if (h) h.textContent = txt; }
  clearInterval(doLogin._t);
  doLogin._t = setInterval(function () {
    var s = Math.round((Date.now() - t0) / 1000);
    setHint('正在向試算表拿名單…已等 ' + s + ' 秒' +
      (s >= 12 ? '（第一次叫醒後端比較久，請再等一下）' : ''));
  }, 500);
  function stopTimer() { clearInterval(doLogin._t); setHint(''); }
  // 注意：load() 成功後才進畫面；enter() 自己的錯不要被當成密碼錯
  load().then(function () {
    try {
      fillClassSelects();
      $('#gate').hidden = true;
      $('#app').hidden = false;
      renderAll();
      startPolling();
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
    stopTimer();
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
