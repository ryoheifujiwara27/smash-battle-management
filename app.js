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
  /* 選択状態（キャラ名を保持。ALL は「すべて」） */
  var picks = { myChar: '', oppChar: '', historyFilter: ALL, statsMyChar: ALL };

  /* 画像アイコンが利用可能かどうか。起動時に 1 枚だけ試験読み込みして判定し、
     失敗した場合はシリーズカラーのフォールバックアバターのみを使用します。 */
  var iconsAvailable = false;

  var FIGHTER_BY_NAME = {};
  for (var fi = 0; fi < FIGHTERS.length; fi++) FIGHTER_BY_NAME[FIGHTERS[fi].name] = FIGHTERS[fi];

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

  /* ---------- キャラアイコン ---------- */

  function fighterOf(name) { return FIGHTER_BY_NAME[name] || null; }

  function iconUrl(fighter) {
    if (!ICON_BASE || !fighter) return '';
    return ICON_BASE.replace('{slug}', fighter.slug);
  }

  /* 名前の先頭 1 文字（フォールバックアバター用）。
     「Mr.ゲーム&ウォッチ」「Wii Fit トレーナー」などは記号を避けて頭文字を選ぶ。 */
  function initialOf(name) {
    var cleaned = name.replace(/^(Mr\.|Mii\s*)/, '');
    return (cleaned.trim() || name).charAt(0);
  }

  /**
   * キャラアイコン要素を生成する。
   * 常にシリーズカラーのアバター（頭文字入り）を土台として描画し、
   * 画像が読み込めた場合のみその上に重ねて表示する。
   * 画像の読み込みに失敗すれば土台のアバターがそのまま残る。
   */
  function buildIcon(name, size) {
    var fighter = fighterOf(name);
    var series = fighter && SERIES[fighter.series];
    var colors = series ? series.colors : ['#3a3f52', '#5a6076'];

    var el = document.createElement('span');
    el.className = 'ficon' + (size ? ' ficon--' + size : '');
    el.style.background = 'linear-gradient(135deg, ' + colors[0] + ', ' + colors[1] + ')';
    el.setAttribute('aria-hidden', 'true');

    var initial = document.createElement('span');
    initial.className = 'ficon__initial';
    initial.textContent = initialOf(name);
    el.appendChild(initial);

    var url = iconsAvailable ? iconUrl(fighter) : '';
    if (url) {
      var img = document.createElement('img');
      img.className = 'ficon__img';
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      /* 読み込み失敗時は画像を取り除き、下地のアバターを見せる */
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
      });
      el.appendChild(img);
    }
    return el;
  }

  /** 「すべて」を表す汎用アイコン */
  function buildAllIcon(size) {
    var el = document.createElement('span');
    el.className = 'ficon ficon--all' + (size ? ' ficon--' + size : '');
    el.setAttribute('aria-hidden', 'true');
    var initial = document.createElement('span');
    initial.className = 'ficon__initial';
    initial.textContent = '全';
    el.appendChild(initial);
    return el;
  }

  /** 画像アイコンが使えるかを 1 枚だけ試験読み込みして判定する */
  function probeIcons(done) {
    var first = FIGHTERS[0];
    var url = iconUrl(first);
    if (!url) { done(false); return; }
    var probe = new Image();
    var settled = false;
    var finish = function (ok) {
      if (settled) return;
      settled = true;
      done(ok);
    };
    probe.onload = function () { finish(probe.naturalWidth > 0); };
    probe.onerror = function () { finish(false); };
    setTimeout(function () { finish(false); }, 5000);
    probe.src = url;
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

  /* ---------- キャラクター選択ピッカー ---------- */

  var pickerState = { targetId: null, includeAll: false, onPick: null, lastFocus: null };

  function pickerLabel(targetId) {
    var value = picks[targetId];
    return value === ALL || !value ? null : value;
  }

  /** 選択ボタンの見た目を更新 */
  function renderPickerButton(targetId) {
    var btn = $(targetId);
    if (!btn) return;
    var value = picks[targetId];
    btn.innerHTML = '';

    var isAll = (value === ALL || !value);
    btn.appendChild(isAll ? buildAllIcon('sm') : buildIcon(value, 'sm'));

    var label = document.createElement('span');
    label.className = 'picker-btn__label';
    label.textContent = isAll
      ? (targetId === 'historyFilter' ? 'すべての相手' : 'すべての自キャラ')
      : value;
    btn.appendChild(label);

    var caret = document.createElement('span');
    caret.className = 'picker-btn__caret';
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(caret);
  }

  function buildFighterTile(name, isAllTile, selected) {
    var tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile' + (selected ? ' is-selected' : '');
    tile.dataset.value = isAllTile ? ALL : name;

    tile.appendChild(isAllTile ? buildAllIcon() : buildIcon(name));

    var label = document.createElement('span');
    label.className = 'tile__name';
    label.textContent = isAllTile ? 'すべて' : name;
    tile.appendChild(label);
    return tile;
  }

  function renderPickerGrid(query) {
    var grid = $('pickerGrid');
    var current = picks[pickerState.targetId];
    var q = (query || '').trim().toLowerCase();

    var list = FIGHTERS.filter(function (f) {
      if (!q) return true;
      var series = SERIES[f.series];
      return f.name.toLowerCase().indexOf(q) >= 0 ||
        f.slug.indexOf(q) >= 0 ||
        (series && series.label.toLowerCase().indexOf(q) >= 0);
    });

    grid.innerHTML = '';
    var frag = document.createDocumentFragment();
    if (pickerState.includeAll && !q) {
      frag.appendChild(buildFighterTile(null, true, current === ALL));
    }
    for (var i = 0; i < list.length; i++) {
      frag.appendChild(buildFighterTile(list[i].name, false, current === list[i].name));
    }
    grid.appendChild(frag);
    $('pickerEmpty').hidden = list.length > 0;
  }

  function openPicker(targetId) {
    var btn = $(targetId);
    pickerState.targetId = targetId;
    pickerState.includeAll = (targetId === 'historyFilter' || targetId === 'statsMyChar');
    pickerState.lastFocus = btn;

    $('pickerTitle').textContent =
      targetId === 'myChar' ? '自分のキャラを選択' :
      targetId === 'oppChar' ? '相手のキャラを選択' :
      targetId === 'historyFilter' ? '相手キャラで絞り込み' : '自分のキャラで絞り込み';

    $('pickerSearch').value = '';
    renderPickerGrid('');
    $('picker').hidden = false;
    document.body.classList.add('is-locked');

    var selected = $('pickerGrid').querySelector('.tile.is-selected');
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'center' });
  }

  function closePicker() {
    $('picker').hidden = true;
    document.body.classList.remove('is-locked');
    if (pickerState.lastFocus) pickerState.lastFocus.focus();
    pickerState.targetId = null;
  }

  function handleTileClick(e) {
    var tile = e.target.closest('.tile');
    if (!tile || !pickerState.targetId) return;
    var targetId = pickerState.targetId;
    picks[targetId] = tile.dataset.value;
    renderPickerButton(targetId);
    closePicker();

    if (targetId === 'historyFilter') renderHistory();
    else if (targetId === 'statsMyChar') renderStats();
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
    mine.appendChild(buildIcon(battle.myChar, 'sm'));
    var mineName = document.createElement('span');
    mineName.textContent = battle.myChar;
    mine.appendChild(mineName);

    var sep = document.createElement('span');
    sep.className = 'match__sep';
    sep.textContent = 'VS';

    var opp = document.createElement('span');
    opp.className = 'match__char';
    opp.appendChild(buildIcon(battle.oppChar, 'sm'));
    var oppName = document.createElement('span');
    oppName.textContent = battle.oppChar;
    opp.appendChild(oppName);

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
    var filter = picks.historyFilter;
    var list = (filter && filter !== ALL)
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

  /* ---------- 描画: 分析 ---------- */

  function buildRankItem(row, index) {
    var li = document.createElement('li');
    li.className = 'rank';

    var no = document.createElement('span');
    no.className = 'rank__no';
    no.textContent = index + 1;

    var icon = buildIcon(row.name);

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
    li.appendChild(icon);
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
    var myFilter = picks.statsMyChar;
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
    renderPickerButton('myChar');
    renderPickerButton('oppChar');
    renderPickerButton('historyFilter');
    renderPickerButton('statsMyChar');
    renderHistory();
    renderStats();
  }

  /* ---------- イベント ---------- */

  function handleSubmit(e) {
    e.preventDefault();
    var myChar = picks.myChar;
    var oppChar = picks.oppChar;
    var resultEl = document.querySelector('input[name="result"]:checked');
    if (!myChar || !oppChar || !resultEl) { showToast('キャラクターを選択してください'); return; }

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

    picks.myChar = FIGHTER_BY_NAME[prefs.myChar] ? prefs.myChar : FIGHTERS[0].name;
    picks.oppChar = FIGHTER_BY_NAME[prefs.oppChar] ? prefs.oppChar : FIGHTERS[0].name;

    $('battleForm').addEventListener('submit', handleSubmit);
    document.addEventListener('click', handleDeleteClick);
    $('statsSort').addEventListener('change', renderStats);
    $('clearAllBtn').addEventListener('click', handleClearAll);
    $('exportBtn').addEventListener('click', handleExport);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', handleImportFile);

    var pickerBtns = document.querySelectorAll('[data-picker="fighter"]');
    for (var p = 0; p < pickerBtns.length; p++) {
      pickerBtns[p].addEventListener('click', function (e) { openPicker(e.currentTarget.id); });
    }
    $('pickerGrid').addEventListener('click', handleTileClick);
    $('pickerSearch').addEventListener('input', function (e) { renderPickerGrid(e.target.value); });
    var closers = $('picker').querySelectorAll('[data-close]');
    for (var c = 0; c < closers.length; c++) closers[c].addEventListener('click', closePicker);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('picker').hidden) closePicker();
    });

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) { switchTab(e.currentTarget.dataset.tab); });
    }

    renderAll();

    /* 画像アイコンが使える環境なら、判定後にアイコン付きで描き直す */
    probeIcons(function (ok) {
      if (!ok) return;
      iconsAvailable = true;
      renderAll();
      if (!$('picker').hidden) renderPickerGrid($('pickerSearch').value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
