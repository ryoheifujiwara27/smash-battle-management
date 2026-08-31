/* =========================================================
   SMASH RECORD - 音声入力
   ---------------------------------------------------------
   ブラウザ標準の Web Speech API で発話を受け取り、
   「マリオでリンクに勝った」のような一文から
   自分のキャラ / 相手のキャラ / 勝敗を取り出します。

   認識結果は必ずフォームに埋めるだけで、自動保存はしません。
   音声認識は必ず誤るため、目視確認を挟む前提の設計です。
   ========================================================= */
var SmashVoice = (function () {
  'use strict';

  /* ---------- 文字列の正規化 ----------
     カタカナ→ひらがな、長音・記号・空白の除去。
     「ピカチュー」と「ピカチュウ」のような揺れを吸収する。 */
  function normalize(s) {
    return String(s)
      .normalize('NFKC')
      .replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); })
      .replace(/[ー・\s.,、。！!？?]/g, '')
      .toLowerCase();
  }

  /* レーベンシュタイン距離。誤認識を許容して照合するために使う。 */
  function lev(a, b) {
    var m = a.length, n = b.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  /* 文中からファイター名を位置つきで拾う。
     完全一致を優先し、無ければ同じ長さの窓を滑らせて最小距離を見る。 */
  function findFighters(text, fighters) {
    var t = normalize(text);
    var hits = [], i, f, key, idx, best, bp, d, tol, win;

    for (i = 0; i < fighters.length; i++) {
      f = fighters[i];
      key = normalize(f);
      /* 同じ名前が複数回出ることがある（「ドクターマリオでマリオに勝った」の
         2 つ目のマリオなど）。最初の 1 件で打ち切らず全ての位置を拾う。 */
      idx = t.indexOf(key);
      var exact = false;
      while (idx >= 0) {
        hits.push({ name: f, pos: idx, len: key.length, dist: 0 });
        exact = true;
        idx = t.indexOf(key, idx + 1);
      }
      if (exact) continue;
      /* 短い名前を距離で拾うと誤爆が多いので、3 文字以上に限る */
      if (key.length < 3) continue;
      best = Infinity; bp = -1;
      for (win = 0; win + key.length <= t.length; win++) {
        d = lev(t.substr(win, key.length), key);
        if (d < best) { best = d; bp = win; }
      }
      tol = key.length <= 4 ? 1 : Math.floor(key.length / 4);
      if (best <= tol) hits.push({ name: f, pos: bp, len: key.length, dist: best });
    }

    /* 重なりを解消。距離が小さく、長い名前を優先する
       （「リンク」と「こどもリンク」なら後者を採る）。 */
    hits.sort(function (a, b) { return a.dist - b.dist || b.len - a.len; });
    var kept = [];
    for (i = 0; i < hits.length; i++) {
      var h = hits[i], overlap = false;
      for (var k = 0; k < kept.length; k++) {
        if (h.pos < kept[k].pos + kept[k].len && kept[k].pos < h.pos + h.len) { overlap = true; break; }
      }
      if (!overlap) kept.push(h);
    }
    return kept.sort(function (a, b) { return a.pos - b.pos; });
  }

  /* 一文を解析する。
     戻り値の myChar が null なら「自キャラの指定なし」を意味し、
     呼び出し側が現在の選択を維持する。 */
  function parse(text, fighters) {
    var t = normalize(text);
    var f = findFighters(text, fighters);
    var my = null, opp = null, i, after;

    /* 勝敗語はキャラ名の中から拾ってはいけない。
       「ピカチュウ」には「かち」が、名前によっては他の語も含まれるため、
       先に見つけたキャラ名の範囲を伏せてから探す。 */
    var masked = t.split('');
    for (i = 0; i < f.length; i++) {
      for (var m = f[i].pos; m < f[i].pos + f[i].len && m < masked.length; m++) masked[m] = '\u0000';
    }
    var rest = masked.join('');

    var result = null;
    if (/勝|かっ|かち|うぃん/.test(rest) || /win/i.test(text)) result = 'win';
    if (/負|まけ|敗|ろー[すず]/.test(rest) || /lose/i.test(text)) result = 'lose';

    if (f.length >= 2) {
      /* 「〜で」= 自分 / 「〜に」「〜と」= 相手 の助詞で役割を決める */
      for (i = 0; i < f.length; i++) {
        after = t.slice(f[i].pos + f[i].len, f[i].pos + f[i].len + 1);
        if (after === 'で' && !my) my = f[i].name;
        else if ((after === 'に' || after === 'と') && !opp) opp = f[i].name;
      }
      /* 助詞が無ければ「先に言った方が自分」とみなす */
      if (!my && !opp) { my = f[0].name; opp = f[1].name; }
      else if (!my) { for (i = 0; i < f.length; i++) if (f[i].name !== opp) { my = f[i].name; break; } }
      else if (!opp) { for (i = 0; i < f.length; i++) if (f[i].name !== my) { opp = f[i].name; break; } }
    } else if (f.length === 1) {
      /* 1 体だけなら相手とみなす（自キャラ省略の形） */
      opp = f[0].name;
    }

    return {
      myChar: my, oppChar: opp, result: result,
      matched: f.map(function (h) { return h.name; })
    };
  }

  /* ---------- 音声認識 ---------- */

  function Recognizer() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isSupported() { return !!Recognizer(); }

  var rec = null;

  function start(handlers) {
    var Ctor = Recognizer();
    if (!Ctor) { handlers.onError('unsupported'); return; }
    stop();

    rec = new Ctor();
    rec.lang = 'ja-JP';
    rec.interimResults = true;   /* 認識途中の文字を出して、聞こえている手応えを返す */
    rec.continuous = false;      /* 一文を話し終えたら自動で止まる */
    rec.maxAlternatives = 1;

    var finalText = '';
    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      handlers.onInterim(finalText + interim);
    };
    rec.onerror = function (e) { handlers.onError(e.error || 'error'); };
    rec.onend = function () { rec = null; handlers.onEnd(finalText.trim()); };

    try { rec.start(); }
    catch (err) { rec = null; handlers.onError('start-failed'); }
  }

  function stop() {
    if (!rec) return;
    try { rec.stop(); } catch (e) { /* 既に停止している */ }
    rec = null;
  }

  return {
    isSupported: isSupported,
    start: start,
    stop: stop,
    parse: parse,
    _normalize: normalize
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SmashVoice;
