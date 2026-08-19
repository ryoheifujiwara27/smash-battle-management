/* =========================================================
   SMASH RECORD - スマブラSP 戦績トラッカー
   データはすべて localStorage に保存されます。
   ========================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'smash-record/battles/v1';
  var PREF_KEY = 'smash-record/prefs/v1';
  var ALL = '__ALL__';

  var battles = [];
  var prefs = { myChar: '', oppChar: '' };

  /* ---------- ストレージ ---------- */

  function loadBattles() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter(isValidBattle);
    } catch (e) {
      console.error('保存データの読み込みに失敗しました', e);
      return [];
    }
  }

  function saveBattles() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(battles));
      return true;
    } catch (e) {
      console.error('保存に失敗しました', e);
      showToast('保存に失敗しました（ストレージの空き容量をご確認ください）');
      return false;
    }
  }

  function isValidBattle(b) {
    return b && typeof b === 'object' &&
      typeof b.myChar === 'string' && b.myChar !== '' &&
      typeof b.oppChar === 'string' && b.oppChar !== '' &&
      (b.result === 'win' || b.result === 'lose');
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          prefs.myChar = typeof p.myChar === 'string' ? p.myChar : '';
          prefs.oppChar = typeof p.oppChar === 'string' ? p.oppChar : '';
        }
      }
    } catch (e) { /* 破損時は初期値のまま */ }
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* noop */ }
  }

  /* ---------- ユーティリティ ---------- */

  function $(id) { return document.getElementById(id); }

  function createId() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function winRate(wins, total) {
    if (!total) return 0;
    return Math.round((wins / total) * 1000) / 10;
  }

  function rateClass(rate) {
    if (rate >= 60) return 'is-good';
    if (rate >= 40) return 'is-even';
    return 'is-bad';
  }

  var toastTimer = null;
  function showToast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 2400);
  }

  /* ---------- セレクトボックス生成 ---------- */

  function fillFighterSelect(select, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();
    if (opts.allLabel) {
      var head = document.createElement('option');
      head.value = ALL;
      head.textContent = opts.allLabel;
      frag.appendChild(head);
    }
    var list = opts.source || FIGHTERS;
    for (var i = 0; i < list.length; i++) {
      var op = document.createElement('option');
      op.value = list[i];
      op.textContent = list[i];
      frag.appendChild(op);
    }
    select.innerHTML = '';
    select.appendChild(frag);
  }

  /* ---------- 集計 ---------- */

  function aggregate(list, keyName) {
    var map = {};
    for (var i = 0; i < list.length; i++) {
      var key = list[i][keyName];
      if (!map[key]) map[key] = { name: key, total: 0, win: 0, lose: 0 };
      map[key].total++;
      if (list[i].result === 'win') map[key].win++; else map[key].lose++;
    }
    var rows = [];
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        map[k].rate = winRate(map[k].win, map[k].total);
        rows.push(map[k]);
      }
    }
    return rows;
  }

  function sortRows(rows, mode) {
    var sorted = rows.slice();
    sorted.sort(function (a, b) {
      if (mode === 'count') return b.total - a.total || b.rate - a.rate;
      if (mode === 'win') return b.win - a.win || b.rate - a.rate;
      if (mode === 'worst') return a.rate - b.rate || b.total - a.total;
      return b.rate - a.rate || b.total - a.total; // 'rate'
    });
    return sorted;
  }

  /* ---------- 描画: 対戦カード ---------- */

  function buildMatchItem(battle) {
    var li = document.createElement('li');
    li.className = 'match match--' + battle.result;

    var main = document.createElement('div');
    main.className = 'match__main';

    var head = document.createElement('div');
    head.className = 'match__head';

    var tag = document.createElement('span');
    tag.className = 'match__result';
    tag.textContent = battle.result === 'win' ? 'WIN' : 'LOSE';
    head.appendChild(tag);

    var time = document.createElement('span');
    time.className = 'match__date';
    time.textContent = formatDate(battle.date);
    head.appendChild(time);

    var vs = document.createElement('div');
    vs.className = 'match__vs';
    var mine = document.createElement('span');
    mine.className = 'match__char match__char--mine';
    mine.textContent = battle.myChar;
    var sep = document.createElement('span');
    sep.className = 'match__sep';
    sep.textContent = 'VS';
    var opp = document.createElement('span');
    opp.className = 'match__char';
    opp.textContent = battle.oppChar;
    vs.appendChild(mine); vs.appendChild(sep); vs.appendChild(opp);

    main.appendChild(head);
    main.appendChild(vs);

    if (battle.memo) {
      var memo = document.createElement('p');
      memo.className = 'match__memo';
      memo.textContent = battle.memo;
      main.appendChild(memo);
    }

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'match__delete';
    del.setAttribute('aria-label', 'この記録を削除');
    del.dataset.id = battle.id;
    del.textContent = '×';

    li.appendChild(main);
    li.appendChild(del);
    return li;
  }

  function renderMatchList(ul, list) {
    ul.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) frag.appendChild(buildMatchItem(list[i]));
    ul.appendChild(frag);
  }

  /* ---------- 描画: サマリー ---------- */

  function renderSummary() {
    var total = battles.length;
    var win = 0;
    for (var i = 0; i < total; i++) if (battles[i].result === 'win') win++;
    $('sumTotal').textContent = total;
    $('sumWin').textContent = win;
    $('sumLose').textContent = total - win;
    $('sumRate').textContent = total ? winRate(win, total).toFixed(1) + '%' : '-';
  }

  /* ---------- 描画: 履歴 ---------- */

  function renderHistory() {
    var filter = $('historyFilter').value;
    var list = filter && filter !== ALL
      ? battles.filter(function (b) { return b.oppChar === filter; })
      : battles;

    $('historyCount').textContent = list.length;
    renderMatchList($('historyList'), list);
    $('historyEmpty').hidden = list.length > 0;
    if (list.length === 0 && battles.length > 0) {
      $('historyEmpty').textContent = 'この条件に一致する記録はありません。';
    } else {
      $('historyEmpty').innerHTML = 'まだ対戦記録がありません。<br>「記録」タブから追加してください。';
    }

    var recent = battles.slice(0, 3);
    $('recentCard').hidden = recent.length === 0;
    renderMatchList($('recentList'), recent);
  }

  function renderHistoryFilter() {
    var sel = $('historyFilter');
    var current = sel.value;
    var used = [];
    var seen = {};
    for (var i = 0; i < battles.length; i++) {
      if (!seen[battles[i].oppChar]) { seen[battles[i].oppChar] = true; used.push(battles[i].oppChar); }
    }
    used.sort(function (a, b) { return FIGHTERS.indexOf(a) - FIGHTERS.indexOf(b); });
    fillFighterSelect(sel, { allLabel: 'すべての相手', source: used });
    sel.value = (current && seen[current]) ? current : ALL;
  }

  function renderStatsMyCharFilter() {
    var sel = $('statsMyChar');
    var current = sel.value;
    var used = [];
    var seen = {};
    for (var i = 0; i < battles.length; i++) {
      if (!seen[battles[i].myChar]) { seen[battles[i].myChar] = true; used.push(battles[i].myChar); }
    }
    used.sort(function (a, b) { return FIGHTERS.indexOf(a) - FIGHTERS.indexOf(b); });
    fillFighterSelect(sel, { allLabel: 'すべての自キャラ', source: used });
    sel.value = (current && seen[current]) ? current : ALL;
  }

  /* ---------- 描画: 分析 ---------- */

  function buildRankItem(row, index) {
    var li = document.createElement('li');
    li.className = 'rank';

    var no = document.createElement('span');
    no.className = 'rank__no';
    no.textContent = index + 1;

    var body = document.createElement('div');
    body.className = 'rank__body';

    var top = document.createElement('div');
    top.className = 'rank__top';
    var name = document.createElement('span');
    name.className = 'rank__name';
    name.textContent = row.name;
    var rate = document.createElement('span');
    rate.className = 'rank__rate ' + rateClass(row.rate);
    rate.textContent = row.rate.toFixed(1) + '%';
    top.appendChild(name); top.appendChild(rate);

    var bar = document.createElement('div');
    bar.className = 'bar';
    var fill = document.createElement('span');
    fill.className = 'bar__fill ' + rateClass(row.rate);
    fill.style.width = row.rate + '%';
    bar.appendChild(fill);

    var meta = document.createElement('div');
    meta.className = 'rank__meta';
    meta.textContent = row.total + '戦 ' + row.win + '勝 ' + row.lose + '敗';

    body.appendChild(top);
    body.appendChild(bar);
    body.appendChild(meta);

    li.appendChild(no);
    li.appendChild(body);
    return li;
  }

  function renderRankList(ol, rows) {
    ol.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) frag.appendChild(buildRankItem(rows[i], i));
    ol.appendChild(frag);
  }

  function renderStats() {
    var myFilter = $('statsMyChar').value;
    var target = (myFilter && myFilter !== ALL)
      ? battles.filter(function (b) { return b.myChar === myFilter; })
      : battles;

    var sortMode = $('statsSort').value;
    var rows = sortRows(aggregate(target, 'oppChar'), sortMode);
    // 「苦手順」では上位＝苦手な相手なので、メダル表示は行わない
    $('rankList').classList.toggle('rank-list--plain', sortMode === 'worst');
    renderRankList($('rankList'), rows);
    $('statsEmpty').hidden = rows.length > 0;

    var myRows = sortRows(aggregate(battles, 'myChar'), 'count');
    renderRankList($('myRankList'), myRows);
    $('myStatsEmpty').hidden = myRows.length > 0;
  }

  /* ---------- 全体再描画 ---------- */

  function renderAll() {
    renderSummary();
    renderHistoryFilter();
    renderStatsMyCharFilter();
    renderHistory();
    renderStats();
  }

  /* ---------- イベント ---------- */

  function handleSubmit(e) {
    e.preventDefault();
    var myChar = $('myChar').value;
    var oppChar = $('oppChar').value;
    var resultEl = document.querySelector('input[name="result"]:checked');
    if (!myChar || !oppChar || !resultEl) return;

    var battle = {
      id: createId(),
      date: new Date().toISOString(),
      myChar: myChar,
      oppChar: oppChar,
      result: resultEl.value,
      memo: $('memo').value.trim()
    };

    battles.unshift(battle);
    if (!saveBattles()) { battles.shift(); return; }

    prefs.myChar = myChar;
    prefs.oppChar = oppChar;
    savePrefs();

    $('memo').value = '';
    renderAll();
    showToast(battle.result === 'win' ? '勝利を記録しました！' : '敗北を記録しました');
  }

  function handleDeleteClick(e) {
    var btn = e.target.closest('.match__delete');
    if (!btn) return;
    var id = btn.dataset.id;
    var target = null;
    for (var i = 0; i < battles.length; i++) if (battles[i].id === id) { target = battles[i]; break; }
    if (!target) return;
    if (!window.confirm(target.myChar + ' vs ' + target.oppChar + ' の記録を削除しますか？')) return;

    battles = battles.filter(function (b) { return b.id !== id; });
    saveBattles();
    renderAll();
    showToast('記録を削除しました');
  }

  function handleClearAll() {
    if (battles.length === 0) { showToast('削除するデータがありません'); return; }
    if (!window.confirm('すべての対戦記録（' + battles.length + '件）を削除します。この操作は取り消せません。')) return;
    battles = [];
    saveBattles();
    renderAll();
    showToast('全データを削除しました');
  }

  function handleExport() {
    if (battles.length === 0) { showToast('書き出すデータがありません'); return; }
    var blob = new Blob([JSON.stringify(battles, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'smash-record-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function handleImportFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        if (!Array.isArray(data)) throw new Error('形式が不正です');
        var valid = data.filter(isValidBattle).map(function (b) {
          return {
            id: b.id || createId(),
            date: b.date || new Date().toISOString(),
            myChar: b.myChar,
            oppChar: b.oppChar,
            result: b.result,
            memo: typeof b.memo === 'string' ? b.memo : ''
          };
        });
        if (valid.length === 0) { showToast('読み込める記録がありませんでした'); return; }
        if (!window.confirm(valid.length + '件を現在のデータに追加します。よろしいですか？')) return;

        var existing = {};
        for (var i = 0; i < battles.length; i++) existing[battles[i].id] = true;
        var added = valid.filter(function (b) { return !existing[b.id]; });
        battles = battles.concat(added);
        battles.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
        saveBattles();
        renderAll();
        showToast(added.length + '件を読み込みました');
      } catch (err) {
        showToast('JSONの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function switchTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].dataset.tab === name);
    }
    var panels = document.querySelectorAll('.panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('is-active', panels[j].dataset.panel === name);
    }
    window.scrollTo(0, 0);
  }

  /* ---------- 初期化 ---------- */

  function init() {
    battles = loadBattles();
    loadPrefs();

    fillFighterSelect($('myChar'));
    fillFighterSelect($('oppChar'));
    $('myChar').value = prefs.myChar && FIGHTERS.indexOf(prefs.myChar) >= 0 ? prefs.myChar : FIGHTERS[0];
    $('oppChar').value = prefs.oppChar && FIGHTERS.indexOf(prefs.oppChar) >= 0 ? prefs.oppChar : FIGHTERS[0];

    $('battleForm').addEventListener('submit', handleSubmit);
    document.addEventListener('click', handleDeleteClick);
    $('historyFilter').addEventListener('change', renderHistory);
    $('statsSort').addEventListener('change', renderStats);
    $('statsMyChar').addEventListener('change', renderStats);
    $('clearAllBtn').addEventListener('click', handleClearAll);
    $('exportBtn').addEventListener('click', handleExport);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', handleImportFile);

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) { switchTab(e.currentTarget.dataset.tab); });
    }

    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
