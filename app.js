/* =========================================================
   SMASH RECORD - スマブラSP 戦績トラッカー
   ---------------------------------------------------------
   データはまず localStorage に保存されます（ローカルファースト）。
   クラウド同期を設定してログインした場合のみ、sync.js が
   バックグラウンドで Supabase と双方向同期します。
   未設定・未ログイン時の挙動は従来と完全に同じです。
   ========================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'smash-record/battles/v1';
  var PREF_KEY = 'smash-record/prefs/v1';
  var TOMB_KEY = 'smash-record/tombstones/v1';
  var GSP_KEY = 'smash-record/gsp/v1';
  var GSP_TOMB_KEY = 'smash-record/gsp-tombstones/v1';
  var ALL = '__ALL__';

  /* battles は「表示対象の記録」だけを保持する（従来どおりの形式）。
     削除された記録は tombstones に墓標として残す。物理削除にすると
     同期時に他端末から復活してしまうため。 */
  var battles = [];
  var tombstones = [];

  /* 世界戦闘力の日別記録。1日・1ファイターにつき 1 件で、
     同じ日の同じキャラを再入力すると上書きになる。 */
  var gspRecords = [];
  var gspTombs = [];
  var prefs = { myChar: '', oppChar: '' };
  /* 選択状態（キャラ名を保持。ALL は「すべて」） */
  var picks = { myChar: '', oppChar: '', historyFilter: ALL, statsMyChar: ALL, gspChar: '' };

  /* グラフに表示するファイター。空なら記録のある全ファイターを表示する。 */
  var gspShown = {};

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
      return data.filter(isValidBattle).map(normalizeBattle);
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

  function loadTombstones() {
    try {
      var raw = localStorage.getItem(TOMB_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data.filter(function (b) { return b && b.id; }) : [];
    } catch (e) { return []; }
  }

  function saveTombstones() {
    try { localStorage.setItem(TOMB_KEY, JSON.stringify(tombstones)); } catch (e) { /* noop */ }
  }

  /* 旧バージョンで作られた記録には id / updatedAt が無いことがあるため補う。
     updatedAt が無い場合は date を初期値とみなす（同期の競合解決に使う）。 */
  function normalizeBattle(b) {
    if (!b.id) b.id = createId();
    if (!b.updatedAt) b.updatedAt = b.date || new Date().toISOString();
    return b;
  }

  /* ---------- 世界戦闘力 ---------- */

  /* id を日付とファイターから決定的に作る。こうすると別の端末で同じ日の
     同じキャラを記録しても id が一致し、行が重複せず上書きになる。 */
  function gspId(date, fighter) { return 'g:' + date + ':' + fighter; }

  function isValidGsp(g) {
    return g && typeof g === 'object' &&
      typeof g.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.date) &&
      typeof g.fighter === 'string' && g.fighter !== '' &&
      typeof g.value === 'number' && isFinite(g.value) && g.value >= 0;
  }

  function loadGsp(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter(function (g) { return g && g.id; });
    } catch (e) { return []; }
  }

  function saveGsp() {
    try {
      localStorage.setItem(GSP_KEY, JSON.stringify(gspRecords));
      localStorage.setItem(GSP_TOMB_KEY, JSON.stringify(gspTombs));
      return true;
    } catch (e) {
      showToast('保存に失敗しました（ストレージの空き容量をご確認ください）');
      return false;
    }
  }

  function getAllGsp() { return gspRecords.concat(gspTombs); }

  function applyMergedGsp(merged) {
    var active = [], dead = [];
    for (var i = 0; i < merged.length; i++) {
      if (merged[i].deleted) dead.push(merged[i]);
      else if (isValidGsp(merged[i])) active.push(merged[i]);
    }
    gspRecords = active;
    gspTombs = dead;
    saveGsp();
    renderAll();
  }

  /* 日付順（古い順）に並べ替えた、指定ファイターの記録を返す */
  function gspSeries(fighter) {
    return gspRecords
      .filter(function (g) { return g.fighter === fighter; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  /* 記録のあるファイターを、記録数の多い順に返す */
  function gspFighters() {
    var count = {};
    for (var i = 0; i < gspRecords.length; i++) {
      count[gspRecords[i].fighter] = (count[gspRecords[i].fighter] || 0) + 1;
    }
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a]; });
  }

  /* ---------- 同期レイヤーとの受け渡し ---------- */

  /* 同期に渡すのは「表示中 + 墓標」の全レコード */
  function getAllRecords() {
    return battles.concat(tombstones);
  }

  /* 同期結果を受け取り、表示対象と墓標に振り分けて保存する */
  function applyMerged(merged) {
    var active = [], dead = [];
    for (var i = 0; i < merged.length; i++) {
      if (merged[i].deleted) dead.push(merged[i]);
      else if (isValidBattle(merged[i])) active.push(merged[i]);
    }
    battles = active;
    tombstones = dead;
    saveBattles();
    saveTombstones();
    renderAll();
  }

  function touch(b) {
    b.updatedAt = new Date().toISOString();
    return b;
  }

  /* 記録を墓標へ移す（論理削除） */
  function entomb(b) {
    tombstones.push({
      id: b.id, date: b.date, myChar: b.myChar, oppChar: b.oppChar,
      result: b.result, memo: b.memo, deleted: true,
      updatedAt: new Date().toISOString()
    });
  }

  function syncSoon() {
    if (typeof SmashSync !== 'undefined') SmashSync.notifyLocalChange();
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
      targetId === 'gspChar' ? '記録するファイターを選択' :
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
    else if (targetId === 'gspChar') renderGspList();
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


  /* ---------- 世界戦闘力: 一覧 ---------- */

  function formatGsp(v) { return v.toLocaleString('ja-JP'); }

  /* 軸ラベル用。1250万 のように万単位で短く表す */
  function formatGspShort(v) {
    if (v >= 10000) {
      var man = v / 10000;
      return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + '万';
    }
    return String(Math.round(v));
  }

  function renderGspList() {
    renderPickerButton('gspChar');
    var list = $('gspList');
    var card = $('gspRecentCard');
    if (!list || !card) return;

    var recent = gspRecords.slice()
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; })
      .slice(0, 8);

    card.hidden = recent.length === 0;
    list.innerHTML = '';

    for (var i = 0; i < recent.length; i++) {
      var g = recent[i];
      var li = document.createElement('li');
      li.className = 'gsp-row';

      li.appendChild(buildIcon(g.fighter, 'sm'));

      var main = document.createElement('div');
      main.className = 'gsp-row__main';

      var top = document.createElement('div');
      top.className = 'gsp-row__top';
      var nm = document.createElement('span');
      nm.className = 'gsp-row__name';
      nm.textContent = g.fighter;
      var dt = document.createElement('span');
      dt.className = 'gsp-row__date';
      dt.textContent = g.date;
      top.appendChild(nm);
      top.appendChild(dt);

      var val = document.createElement('div');
      val.className = 'gsp-row__value';
      val.textContent = formatGsp(g.value);

      /* 同じファイターの 1 つ前の記録との差を出す */
      var series = gspSeries(g.fighter);
      var idx = -1;
      for (var k = 0; k < series.length; k++) if (series[k].id === g.id) { idx = k; break; }
      if (idx > 0) {
        var diff = g.value - series[idx - 1].value;
        if (diff !== 0) {
          var d = document.createElement('span');
          d.className = 'gsp-row__diff ' + (diff > 0 ? 'is-up' : 'is-down');
          d.textContent = (diff > 0 ? '+' : '−') + formatGsp(Math.abs(diff));
          val.appendChild(d);
        }
      }

      main.appendChild(top);
      main.appendChild(val);
      li.appendChild(main);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'gsp-row__delete';
      del.dataset.id = g.id;
      del.setAttribute('aria-label', g.date + ' の ' + g.fighter + ' の記録を削除');
      del.textContent = '×';
      li.appendChild(del);

      list.appendChild(li);
    }
  }

  /* ---------- 世界戦闘力: 折れ線グラフ ---------- */

  /* ダーク背景(#171b28)で検証済みのカテゴリ配色。
     全ペアで色覚多様性の分離 ΔE 8.6 以上・コントラスト 3:1 以上を満たす。
     系列が 6 を超えたら色を使い回さず、表示するファイターを選ばせる。 */
  var GSP_COLORS = ['#0059ff', '#e10061', '#00a0ae', '#ac8700', '#007a00', '#c000bc'];
  var GSP_MAX_SERIES = GSP_COLORS.length;

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    return el;
  }

  var chartState = { series: [], box: null };

  /* 軸の目盛りを切りのよい値に丸める。1268万 のような半端な目盛りは
     読み取れないため、1・2・2.5・5 の刻みに寄せる。 */
  function niceScale(min, max, count) {
    var span = (max - min) || Math.abs(max) || 1;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    return {
      min: Math.floor(min / step) * step,
      max: Math.ceil(max / step) * step,
      step: step
    };
  }

  /* 表示対象のファイター。未選択なら記録数の多い順に既定値を決める */
  function activeGspFighters() {
    var all = gspFighters();
    var chosen = all.filter(function (f) { return gspShown[f]; });
    if (chosen.length) return chosen.slice(0, GSP_MAX_SERIES);
    return all.slice(0, GSP_MAX_SERIES);
  }

  function renderGspChart() {
    var host = $('gspChart');
    var legend = $('gspLegend');
    var empty = $('gspEmpty');
    if (!host || !legend || !empty) return;

    var all = gspFighters();
    host.innerHTML = '';
    legend.innerHTML = '';

    if (all.length === 0) {
      empty.hidden = false;
      host.hidden = true;
      legend.hidden = true;
      return;
    }
    empty.hidden = true;
    host.hidden = false;
    legend.hidden = false;

    var shown = activeGspFighters();

    /* 凡例。色だけに頼らないよう、名前と記録数を必ず併記する。
       クリックで表示/非表示を切り替えられる。 */
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      var on = shown.indexOf(f) >= 0;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'legend__chip' + (on ? ' is-on' : '');
      chip.dataset.fighter = f;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');

      var sw = document.createElement('span');
      sw.className = 'legend__swatch';
      sw.style.background = on ? GSP_COLORS[shown.indexOf(f)] : 'transparent';
      chip.appendChild(sw);

      var tx = document.createElement('span');
      tx.textContent = f;
      chip.appendChild(tx);

      legend.appendChild(chip);
    }

    /* 系列を組み立てる */
    var series = [];
    for (var s = 0; s < shown.length; s++) {
      var pts = gspSeries(shown[s]);
      if (pts.length) series.push({ fighter: shown[s], color: GSP_COLORS[s], points: pts });
    }
    if (!series.length) return;

    drawChart(host, series);
    chartState.series = series;
  }

  function drawChart(host, series) {
    var W = Math.max(280, host.clientWidth || 320);
    var H = 260;

    /* 系列名を線の終端に直接書く（4 系列以下のとき）。必要な右余白は
       ラベルの実際の長さから見積もる。決め打ちだと長い名前で見切れる。
       余白が広くなりすぎて描画領域を圧迫する場合は直接ラベルをやめ、
       凡例だけで識別させる。 */
    var LABEL_MAX = 5;
    var CHAR_W = 11;          /* 11px の日本語 1 文字ぶんの目安 */
    var labelOf = function (name) {
      return name.length > LABEL_MAX ? name.slice(0, LABEL_MAX) + '…' : name;
    };
    var direct = series.length <= 4;
    var labelW = 0;
    if (direct) {
      for (var li = 0; li < series.length; li++) {
        labelW = Math.max(labelW, labelOf(series[li].fighter).length * CHAR_W);
      }
      /* 点からの離れ 9px + ラベル + 右端の余白 4px */
      var need = 9 + labelW + 4;
      if (need > W * 0.34) direct = false; else labelW = need;
    }
    var PAD = { l: 54, r: direct ? labelW : 14, t: 14, b: 28 };

    var xs = [], ys = [];
    for (var i = 0; i < series.length; i++)
      for (var j = 0; j < series[i].points.length; j++) {
        xs.push(Date.parse(series[i].points[j].date));
        ys.push(series[i].points[j].value);
      }
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
    if (xMax === xMin) { xMin -= 86400000; xMax += 86400000; }
    /* 値域が狭いと線が潰れるので、上下に 8% の余白を持たせてから
       目盛りを切りのよい値に丸める */
    var span = (yMax - yMin) || Math.max(1, yMax * 0.02);
    var sc = niceScale(Math.max(0, yMin - span * 0.08), yMax + span * 0.08, 4);
    yMin = sc.min; yMax = sc.max;

    var px = function (t) { return PAD.l + (t - xMin) / (xMax - xMin) * (W - PAD.l - PAD.r); };
    var py = function (v) { return PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b); };

    var root = svg('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      role: 'img', 'aria-label': '世界戦闘力の推移。' +
        series.map(function (s) { return s.fighter + ' ' + s.points.length + '件'; }).join('、')
    });

    /* 目盛りとグリッド。主役は線なので、罫線は背景に沈める */
    for (var v = yMin; v <= yMax + sc.step * 0.001; v += sc.step) {
      var y = py(v);
      root.appendChild(svg('line', {
        x1: PAD.l, y1: y, x2: W - PAD.r, y2: y,
        stroke: 'var(--line)', 'stroke-width': 1, opacity: 0.55
      }));
      var lab = svg('text', {
        x: PAD.l - 8, y: y + 4, 'text-anchor': 'end',
        fill: 'var(--text-dim)', 'font-size': 11
      });
      lab.textContent = formatGspShort(v);
      root.appendChild(lab);
    }

    /* 横軸は最初と最後の日付だけ（間を詰め込むと読めない） */
    [[xMin, 'start', PAD.l], [xMax, 'end', W - PAD.r]].forEach(function (t) {
      var lab = svg('text', {
        x: t[2], y: H - 8, 'text-anchor': t[1],
        fill: 'var(--text-dim)', 'font-size': 11
      });
      var d = new Date(t[0]);
      lab.textContent = (d.getMonth() + 1) + '/' + d.getDate();
      root.appendChild(lab);
    });

    /* 折れ線とデータ点 */
    for (var s2 = 0; s2 < series.length; s2++) {
      var ser = series[s2];
      var d = '';
      for (var p = 0; p < ser.points.length; p++) {
        var X = px(Date.parse(ser.points[p].date)), Y = py(ser.points[p].value);
        d += (p ? 'L' : 'M') + X.toFixed(1) + ' ' + Y.toFixed(1);
      }
      if (ser.points.length > 1) {
        root.appendChild(svg('path', {
          d: d, fill: 'none', stroke: ser.color, 'stroke-width': 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }));
      }
      for (var p2 = 0; p2 < ser.points.length; p2++) {
        /* 点が重なっても分かるよう、背景色のリングを回す */
        root.appendChild(svg('circle', {
          cx: px(Date.parse(ser.points[p2].date)), cy: py(ser.points[p2].value),
          r: 4, fill: ser.color, stroke: 'var(--surface)', 'stroke-width': 2
        }));
      }
      if (direct) {
        var last = ser.points[ser.points.length - 1];
        var t = svg('text', {
          x: px(Date.parse(last.date)) + 9, y: py(last.value) + 4,
          fill: 'var(--text-dim)', 'font-size': 11, 'font-weight': 700
        });
        t.textContent = labelOf(ser.fighter);
        root.appendChild(t);
      }
    }

    /* ホバー/タップで日付を合わせ、その日の各系列の値を出す */
    var cross = svg('line', {
      y1: PAD.t, y2: H - PAD.b, stroke: 'var(--text-dim)',
      'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0
    });
    root.appendChild(cross);
    var hit = svg('rect', {
      x: PAD.l, y: PAD.t, width: Math.max(1, W - PAD.l - PAD.r),
      height: H - PAD.t - PAD.b, fill: 'transparent'
    });
    root.appendChild(hit);
    host.appendChild(root);

    var tip = document.createElement('div');
    tip.className = 'chart__tip';
    tip.hidden = true;
    host.appendChild(tip);

    function moveTo(clientX) {
      var box = root.getBoundingClientRect();
      var x = clientX - box.left;
      var t = xMin + (x - PAD.l) / (W - PAD.l - PAD.r) * (xMax - xMin);
      /* 一番近い日付にスナップする */
      var bestDate = null, bestD = Infinity;
      for (var i = 0; i < series.length; i++)
        for (var j = 0; j < series[i].points.length; j++) {
          var dd = Math.abs(Date.parse(series[i].points[j].date) - t);
          if (dd < bestD) { bestD = dd; bestDate = series[i].points[j].date; }
        }
      if (!bestDate) return;
      var sx = px(Date.parse(bestDate));
      cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
      cross.setAttribute('opacity', 1);

      var rows = ['<b>' + bestDate + '</b>'];
      for (var s = 0; s < series.length; s++) {
        var hitPt = null;
        for (var k = 0; k < series[s].points.length; k++)
          if (series[s].points[k].date === bestDate) { hitPt = series[s].points[k]; break; }
        if (!hitPt) continue;
        rows.push('<span class="chart__dot" style="background:' + series[s].color + '"></span>' +
          series[s].fighter + ' ' + formatGsp(hitPt.value));
      }
      tip.innerHTML = rows.join('<br>');
      tip.hidden = false;
      /* 端で見切れないように寄せる */
      var tw = tip.offsetWidth || 140;
      tip.style.left = Math.min(Math.max(4, sx - tw / 2), W - tw - 4) + 'px';
    }

    root.addEventListener('pointermove', function (e) { moveTo(e.clientX); });
    root.addEventListener('pointerdown', function (e) { moveTo(e.clientX); });
    root.addEventListener('pointerleave', function () {
      cross.setAttribute('opacity', 0); tip.hidden = true;
    });
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
    renderGspList();
    renderGspChart();
    renderHeaderSync();
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
      memo: $('memo').value.trim(),
      deleted: false,
      updatedAt: new Date().toISOString()
    };

    battles.unshift(battle);
    if (!saveBattles()) { battles.shift(); return; }
    syncSoon();

    prefs.myChar = myChar;
    prefs.oppChar = oppChar;
    savePrefs();

    $('memo').value = '';
    renderAll();
    showToast(battle.result === 'win' ? '勝利を記録しました！' : '敗北を記録しました');
  }

  /* 数値は「12,500,000」「1250万」のような入力も受け付ける */
  function parseGspValue(raw) {
    var t = String(raw).replace(/[,\s]/g, '').replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    var m = t.match(/^(\d+(?:\.\d+)?)万$/);
    if (m) return Math.round(parseFloat(m[1]) * 10000);
    if (!/^\d+$/.test(t)) return NaN;
    return parseInt(t, 10);
  }

  function handleGspSubmit(e) {
    e.preventDefault();
    var date = $('gspDate').value;
    var fighter = picks.gspChar;
    var value = parseGspValue($('gspValue').value);

    if (!date) { showToast('日付を選択してください'); return; }
    if (!fighter) { showToast('ファイターを選択してください'); return; }
    if (isNaN(value) || value < 0) { showToast('世界戦闘力を数字で入力してください'); return; }

    var id = gspId(date, fighter);
    var rec = {
      id: id, date: date, fighter: fighter, value: value,
      deleted: false, updatedAt: new Date().toISOString()
    };

    /* 同じ日・同じキャラは上書きする */
    var replaced = false;
    for (var i = 0; i < gspRecords.length; i++) {
      if (gspRecords[i].id === id) { gspRecords[i] = rec; replaced = true; break; }
    }
    if (!replaced) gspRecords.push(rec);
    /* 過去に削除していた場合、墓標を取り除かないと同期で削除が復活する */
    gspTombs = gspTombs.filter(function (g) { return g.id !== id; });

    if (!saveGsp()) return;
    syncSoon();
    $('gspValue').value = '';
    renderAll();
    showToast(replaced ? '世界戦闘力を更新しました' : '世界戦闘力を記録しました');
  }

  function handleGspDeleteClick(e) {
    var btn = e.target.closest('.gsp-row__delete');
    if (!btn) return;
    var id = btn.dataset.id;
    var target = null;
    for (var i = 0; i < gspRecords.length; i++) if (gspRecords[i].id === id) { target = gspRecords[i]; break; }
    if (!target) return;
    if (!window.confirm(target.date + ' の ' + target.fighter + ' の記録を削除しますか？')) return;

    gspTombs.push({
      id: target.id, date: target.date, fighter: target.fighter,
      value: target.value, deleted: true, updatedAt: new Date().toISOString()
    });
    gspRecords = gspRecords.filter(function (g) { return g.id !== id; });
    saveGsp();
    syncSoon();
    renderAll();
    showToast('記録を削除しました');
  }

  function handleDeleteClick(e) {
    var btn = e.target.closest('.match__delete');
    if (!btn) return;
    var id = btn.dataset.id;
    var target = null;
    for (var i = 0; i < battles.length; i++) if (battles[i].id === id) { target = battles[i]; break; }
    if (!target) return;
    if (!window.confirm(target.myChar + ' vs ' + target.oppChar + ' の記録を削除しますか？')) return;

    entomb(target);
    battles = battles.filter(function (b) { return b.id !== id; });
    saveBattles();
    saveTombstones();
    syncSoon();
    renderAll();
    showToast('記録を削除しました');
  }

  function handleClearAll() {
    if (battles.length === 0) { showToast('削除するデータがありません'); return; }
    if (!window.confirm('すべての対戦記録（' + battles.length + '件）を削除します。この操作は取り消せません。')) return;
    for (var i = 0; i < battles.length; i++) entomb(battles[i]);
    battles = [];
    saveBattles();
    saveTombstones();
    syncSoon();
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
            memo: typeof b.memo === 'string' ? b.memo : '',
            deleted: false,
            updatedAt: b.updatedAt || b.date || new Date().toISOString()
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
        syncSoon();
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

    /* 非表示のパネルは幅が 0 になり、グラフが既定幅のまま描かれてしまう。
       表示に切り替わった時点で実際の幅を測って描き直す。 */
    if (name === 'stats') renderGspChart();
  }

  /* ---------- 音声入力 ---------- */

  var voiceOpen = false;

  function setVoiceStatus(text, listening) {
    $('voiceStatus').textContent = text;
    $('voiceSheet').classList.toggle('is-listening', !!listening);
  }

  function openVoice() {
    voiceOpen = true;
    $('voiceHeard').textContent = '';
    setVoiceStatus('マイクの準備をしています…', false);
    $('voiceSheet').hidden = false;
    document.body.classList.add('is-locked');

    SmashVoice.start({
      onInterim: function (text) {
        setVoiceStatus('聞き取り中…', true);
        $('voiceHeard').textContent = text;
      },
      onError: function (kind) {
        closeVoice();
        if (kind === 'not-allowed' || kind === 'service-not-allowed') {
          showToast('マイクの使用が許可されていません。ブラウザの設定をご確認ください');
        } else if (kind === 'no-speech') {
          showToast('聞き取れませんでした。もう一度お試しください');
        } else if (kind === 'network') {
          showToast('音声認識にはネット接続が必要です');
        } else {
          showToast('音声入力を開始できませんでした');
        }
      },
      onEnd: function (finalText) {
        if (!voiceOpen) return;   /* 利用者が「やめる」を押していた */
        closeVoice();
        applyVoice(finalText);
      }
    });
  }

  function closeVoice() {
    voiceOpen = false;
    SmashVoice.stop();
    $('voiceSheet').hidden = true;
    $('voiceSheet').classList.remove('is-listening');
    document.body.classList.remove('is-locked');
  }

  /* 認識結果をフォームに埋める。自動保存はしない。
     音声認識は必ず誤るため、目視で確認してから保存する前提。 */
  function applyVoice(text) {
    if (!text) { showToast('聞き取れませんでした。もう一度お試しください'); return; }

    var names = [];
    for (var i = 0; i < FIGHTERS.length; i++) names.push(FIGHTERS[i].name);
    var g = SmashVoice.parse(text, names);

    if (!g.oppChar && !g.myChar) {
      showToast('「' + text + '」からキャラを聞き取れませんでした');
      return;
    }

    var filled = [];
    if (g.myChar) { picks.myChar = g.myChar; renderPickerButton('myChar'); filled.push('自分: ' + g.myChar); }
    if (g.oppChar) { picks.oppChar = g.oppChar; renderPickerButton('oppChar'); filled.push('相手: ' + g.oppChar); }
    if (g.result) {
      $(g.result === 'win' ? 'resWin' : 'resLose').checked = true;
      filled.push(g.result === 'win' ? 'WIN' : 'LOSE');
    }

    switchTab('record');
    showToast(filled.join(' / ') + (g.result ? '' : '（勝敗は聞き取れませんでした）'));

    /* 足りない項目に注意を向ける */
    if (!g.result) $('resWin').focus();
  }

  function initVoice() {
    var btn = $('voiceBtn');
    if (!btn) return;
    /* 非対応ブラウザ（Firefox など）では押せないボタンを置かない */
    if (typeof SmashVoice === 'undefined' || !SmashVoice.isSupported()) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.addEventListener('click', openVoice);
    $('voiceStopBtn').addEventListener('click', closeVoice);
    var closers = $('voiceSheet').querySelectorAll('[data-voice-close]');
    for (var i = 0; i < closers.length; i++) closers[i].addEventListener('click', closeVoice);
  }

  /* ---------- クラウド同期 UI ---------- */

  var STATUS_LABEL = {
    disabled:   { text: '未設定',   cls: 'is-off' },
    'signed-out': { text: '未ログイン', cls: 'is-off' },
    syncing:    { text: '同期中…',  cls: 'is-busy' },
    synced:     { text: '同期済み', cls: 'is-ok' },
    offline:    { text: 'オフライン', cls: 'is-warn' },
    error:      { text: 'エラー',   cls: 'is-bad' }
  };

  /* メール送信後、コード入力欄に切り替えるためのフラグ */
  var awaitingCode = false;
  var pendingEmail = '';

  /* 直近の同期状態。記録の増減でヘッダーの「未同期 N件」を更新するため、
     onChange を待たずに再描画できるよう保持しておく。 */
  var syncState = { configured: false, status: 'disabled', detail: '', email: '' };

  /* ヘッダーのステータスチップ。未ログインのままローカルに記録が溜まっている
     状態は「気づかないうちに失う」事故に直結するため、中立表示ではなく
     警告として件数付きで出す。 */
  function renderHeaderSync() {
    var el = $('headerSync');
    if (!el) return;

    if (!syncState.configured) { el.hidden = true; return; }
    el.hidden = false;

    var cls = '', text = '', label = '';
    if (syncState.email) {
      if (syncState.status === 'syncing')      { cls = 'is-busy'; text = '同期中';   label = '同期中です'; }
      else if (syncState.status === 'offline') { cls = 'is-warn'; text = 'オフライン'; label = 'オフラインです。接続が戻り次第、自動で同期されます'; }
      else if (syncState.status === 'error')   { cls = 'is-bad';  text = '同期エラー'; label = '同期に失敗しました'; }
      else                                     { cls = 'is-ok';   text = '同期済み';  label = 'クラウドと同期されています'; }
    } else if (battles.length > 0) {
      cls = 'is-warn';
      /* 桁数が増えるとヘッダーのレイアウトが崩れるため上限を設ける */
      text = '未同期 ' + (battles.length > 99 ? '99+' : battles.length) + '件';
      label = battles.length + '件がこの端末にしか保存されていません。ログインするとクラウドに保存されます';
    } else {
      text = '未ログイン';
      label = 'ログインするとクラウドに保存されます';
    }

    el.className = 'hsync' + (cls ? ' ' + cls : '');
    $('headerSyncText').textContent = text;
    el.setAttribute('aria-label', label);
    el.title = label;
  }

  /* ヘッダーから同期カードへ誘導する */
  function goToSyncCard() {
    switchTab('history');
    var card = $('syncCard');
    if (!card) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(function () {
      card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      card.classList.add('is-flash');
      setTimeout(function () { card.classList.remove('is-flash'); }, 1200);
    }, 0);
  }

  function renderAccount(st) {
    syncState = st;
    renderHeaderSync();
    var badge = $('syncStatus');
    var meta = STATUS_LABEL[st.status] || STATUS_LABEL.disabled;
    badge.textContent = meta.text;
    badge.className = 'sync__status ' + meta.cls;

    var signedIn = !!st.email;
    var configured = st.configured;

    $('syncSignIn').hidden = !configured || signedIn || awaitingCode;
    $('syncVerify').hidden = !configured || signedIn || !awaitingCode;
    $('syncAccount').hidden = !signedIn;

    var note = $('storageNote');
    if (note) {
      note.textContent = signedIn
        ? 'データはクラウドに保存され、ログイン中の端末すべてで共有されます。'
        : 'データはこの端末のブラウザ (localStorage) にのみ保存されます。';
    }

    if (!configured) {
      $('syncDesc').textContent =
        'この端末のブラウザにのみ保存されています。別の端末から見たり、サイトデータを削除しても復元できるようにするには、クラウド同期の設定が必要です（README.md を参照）。';
    } else if (signedIn) {
      $('syncEmailLabel').textContent = st.email;
      $('syncDesc').textContent = st.status === 'error'
        ? '同期に失敗しました: ' + st.detail
        : 'ログイン中の端末すべてで対戦記録が共有されます。';
    } else if (awaitingCode) {
      $('syncDesc').textContent =
        pendingEmail + ' にメールを送りました。メール内のリンクを開くか、記載の6桁コードを入力してください。';
    } else {
      $('syncDesc').textContent =
        'ログインすると対戦記録がクラウドに保存され、別の端末からも同じデータを見られるようになります。';
    }
  }

  function handleGoogleSignIn() {
    var btn = $('syncGoogleBtn');
    btn.disabled = true;
    /* 成功時はページごと Google へ遷移するので、ここに戻ってこない。
       失敗したときだけボタンを復帰させる。 */
    SmashSync.signInWithGoogle().catch(function (err) {
      btn.disabled = false;
      showToast('Google ログインを開始できませんでした: ' + (err.message || err));
    });
  }

  function handleSendCode() {
    var email = $('syncEmail').value.trim();
    if (!email || email.indexOf('@') < 0) { showToast('メールアドレスを入力してください'); return; }
    $('syncSendBtn').disabled = true;
    SmashSync.signIn(email).then(function () {
      pendingEmail = email;
      awaitingCode = true;
      renderAccount(SmashSync.state());
      showToast('確認メールを送りました');
    }).catch(function (err) {
      showToast('送信に失敗しました: ' + (err.message || err));
    }).then(function () {
      $('syncSendBtn').disabled = false;
    });
  }

  function handleVerifyCode() {
    var code = $('syncCode').value.trim();
    if (!code) { showToast('コードを入力してください'); return; }
    $('syncVerifyBtn').disabled = true;
    SmashSync.verifyCode(pendingEmail, code).then(function () {
      awaitingCode = false;
      $('syncCode').value = '';
      showToast('ログインしました');
    }).catch(function (err) {
      showToast('ログインに失敗しました: ' + (err.message || err));
    }).then(function () {
      $('syncVerifyBtn').disabled = false;
    });
  }

  function handleSignOut() {
    if (!window.confirm('ログアウトします。この端末のデータは残りますが、以後は同期されません。')) return;
    SmashSync.signOut().then(function () {
      awaitingCode = false;
      showToast('ログアウトしました');
    });
  }

  function initSync() {
    if (typeof SmashSync === 'undefined') return;

    $('headerSync').addEventListener('click', goToSyncCard);
    $('syncGoogleBtn').addEventListener('click', handleGoogleSignIn);

    /* Google へ遷移したあとブラウザの「戻る」で復帰すると、bfcache が
       disabled 状態ごと DOM を復元してボタンを押せなくなる。復帰時に必ず戻す。 */
    window.addEventListener('pageshow', function () {
      $('syncGoogleBtn').disabled = false;
    });
    $('syncSendBtn').addEventListener('click', handleSendCode);
    $('syncVerifyBtn').addEventListener('click', handleVerifyCode);
    $('syncCancelBtn').addEventListener('click', function () {
      awaitingCode = false;
      renderAccount(SmashSync.state());
    });
    $('syncNowBtn').addEventListener('click', function () {
      SmashSync.syncNow();
      showToast('同期しています…');
    });
    $('syncOutBtn').addEventListener('click', handleSignOut);

    var st = SmashSync.init({
      collections: [
        {
          table: 'battles',
          getLocal: getAllRecords,
          setLocal: applyMerged,
          toRow: function (b, userId) {
            return {
              user_id: userId, id: b.id, date: b.date,
              my_char: b.myChar, opp_char: b.oppChar, result: b.result,
              memo: typeof b.memo === 'string' ? b.memo : '',
              deleted: !!b.deleted, updated_at: b.updatedAt || b.date
            };
          },
          fromRow: function (r) {
            return {
              id: r.id, date: r.date, myChar: r.my_char, oppChar: r.opp_char,
              result: r.result, memo: typeof r.memo === 'string' ? r.memo : '',
              deleted: !!r.deleted, updatedAt: r.updated_at || r.date
            };
          }
        },
        {
          table: 'gsp_records',
          getLocal: getAllGsp,
          setLocal: applyMergedGsp,
          toRow: function (g, userId) {
            return {
              user_id: userId, id: g.id, date: g.date, fighter: g.fighter,
              value: g.value, deleted: !!g.deleted, updated_at: g.updatedAt || g.date
            };
          },
          fromRow: function (r) {
            /* bigint は環境によって文字列で返るため数値に揃える */
            return {
              id: r.id, date: r.date, fighter: r.fighter, value: Number(r.value),
              deleted: !!r.deleted, updatedAt: r.updated_at || r.date
            };
          }
        }
      ],
      onChange: function (next) {
        if (next.email) awaitingCode = false;
        renderAccount(next);
      }
    });
    renderAccount(st);
  }

  /* ---------- 初期化 ---------- */

  function init() {
    battles = loadBattles();
    tombstones = loadTombstones();
    gspRecords = loadGsp(GSP_KEY).filter(isValidGsp);
    gspTombs = loadGsp(GSP_TOMB_KEY);
    loadPrefs();

    picks.gspChar = FIGHTER_BY_NAME[prefs.myChar] ? prefs.myChar : FIGHTERS[0].name;
    picks.myChar = FIGHTER_BY_NAME[prefs.myChar] ? prefs.myChar : FIGHTERS[0].name;
    picks.oppChar = FIGHTER_BY_NAME[prefs.oppChar] ? prefs.oppChar : FIGHTERS[0].name;

    $('battleForm').addEventListener('submit', handleSubmit);
    document.addEventListener('click', handleDeleteClick);
    $('statsSort').addEventListener('change', renderStats);
    $('gspForm').addEventListener('submit', handleGspSubmit);
    $('gspList').addEventListener('click', handleGspDeleteClick);

    /* 凡例のチップで系列の表示/非表示を切り替える */
    $('gspLegend').addEventListener('click', function (e) {
      var chip = e.target.closest('.legend__chip');
      if (!chip) return;
      var f = chip.dataset.fighter;
      if (gspShown[f]) delete gspShown[f];
      else {
        var on = Object.keys(gspShown).length;
        if (!on) {
          /* 未選択（既定表示）の状態から触ったときは、いまの既定を選択状態にしてから外す */
          var cur = activeGspFighters();
          for (var i = 0; i < cur.length; i++) gspShown[cur[i]] = true;
          if (gspShown[f]) delete gspShown[f]; else gspShown[f] = true;
        } else if (on >= GSP_MAX_SERIES) {
          showToast('同時に表示できるのは ' + GSP_MAX_SERIES + ' 体までです');
          return;
        } else {
          gspShown[f] = true;
        }
      }
      renderGspChart();
    });

    /* 画面幅が変わるとグラフの座標が合わなくなるため描き直す */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderGspChart, 150);
    });
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
      if (e.key === 'Escape' && !$('voiceSheet').hidden) { closeVoice(); return; }
      if (e.key === 'Escape' && !$('picker').hidden) closePicker();
    });

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) { switchTab(e.currentTarget.dataset.tab); });
    }

    renderAll();

    /* 日付は既定で今日にしておく（毎回選ぶ手間を省く） */
    var now = new Date();
    var p2 = function (n) { return n < 10 ? '0' + n : String(n); };
    $('gspDate').value = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());

    initVoice();
    initSync();

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
