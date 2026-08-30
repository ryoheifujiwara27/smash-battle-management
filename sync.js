/* =========================================================
   SMASH RECORD - クラウド同期レイヤー（Supabase）
   ---------------------------------------------------------
   設計方針: ローカルファースト
     ・localStorage を常に正とみなして即座に UI を更新する
     ・ログインしている場合のみ、バックグラウンドで Supabase と同期する
     ・未設定・未ログイン・オフラインのいずれでもアプリは通常どおり動く

   競合解決: レコード単位の last-write-wins
     updatedAt（クライアント打刻）が新しい方を採用する。削除は物理削除
     ではなく deleted フラグで表現し、他端末に削除が伝わるようにする。
   ========================================================= */
var SmashSync = (function () {
  'use strict';

  var TABLE = 'battles';
  var PUSH_CHUNK = 200;
  var DEBOUNCE_MS = 1500;

  var client = null;
  var session = null;
  var hooks = null;              /* { getLocal, setLocal, onChange } */
  var status = 'disabled';       /* disabled | signed-out | syncing | synced | offline | error */
  var detail = '';
  var syncing = false;
  var pendingSync = false;
  var debounceTimer = null;

  /* ---------- レコード変換 ---------- */

  function toRow(b, userId) {
    return {
      user_id: userId,
      id: b.id,
      date: b.date,
      my_char: b.myChar,
      opp_char: b.oppChar,
      result: b.result,
      memo: typeof b.memo === 'string' ? b.memo : '',
      deleted: !!b.deleted,
      updated_at: b.updatedAt || b.date
    };
  }

  function fromRow(r) {
    return {
      id: r.id,
      date: r.date,
      myChar: r.my_char,
      oppChar: r.opp_char,
      result: r.result,
      memo: typeof r.memo === 'string' ? r.memo : '',
      deleted: !!r.deleted,
      updatedAt: r.updated_at || r.date
    };
  }

  function stamp(b) {
    /* 旧データ（updatedAt を持たない）は date を初期値として扱う */
    return Date.parse(b.updatedAt || b.date) || 0;
  }

  /* ---------- マージ（純粋関数・テスト対象） ----------
     戻り値 merged はローカルに書き戻す全レコード、
     toPush はサーバーへ送るべきレコード。                     */
  function mergeRecords(local, remote) {
    var byId = {};
    var order = [];
    var i, b, cur;

    for (i = 0; i < local.length; i++) {
      b = local[i];
      if (!b || !b.id) continue;
      if (!byId[b.id]) order.push(b.id);
      byId[b.id] = { local: b, remote: null };
    }
    for (i = 0; i < remote.length; i++) {
      b = remote[i];
      if (!b || !b.id) continue;
      if (!byId[b.id]) { byId[b.id] = { local: null, remote: null }; order.push(b.id); }
      byId[b.id].remote = b;
    }

    var merged = [];
    var toPush = [];
    for (i = 0; i < order.length; i++) {
      cur = byId[order[i]];
      if (cur.local && !cur.remote) {
        merged.push(cur.local);
        toPush.push(cur.local);            /* サーバーにまだ無い */
      } else if (!cur.local && cur.remote) {
        merged.push(cur.remote);           /* 他端末で追加された */
      } else if (stamp(cur.local) > stamp(cur.remote)) {
        merged.push(cur.local);
        toPush.push(cur.local);            /* ローカルが新しい */
      } else {
        merged.push(cur.remote);           /* 同着はリモート優先で収束させる */
      }
    }

    merged.sort(function (a, b2) { return Date.parse(b2.date) - Date.parse(a.date); });
    return { merged: merged, toPush: toPush };
  }

  /* ---------- 状態通知 ---------- */

  function setStatus(next, msg) {
    status = next;
    detail = msg || '';
    if (hooks && hooks.onChange) hooks.onChange(state());
  }

  function state() {
    return {
      configured: !!client,
      status: status,
      detail: detail,
      email: session && session.user ? session.user.email : ''
    };
  }

  /* ---------- 同期本体 ---------- */

  function runSync() {
    if (!client || !session) return Promise.resolve();
    if (syncing) { pendingSync = true; return Promise.resolve(); }
    syncing = true;
    setStatus('syncing');

    var userId = session.user.id;
    var local = hooks.getLocal();

    return client.from(TABLE).select('*')
      .then(function (res) {
        if (res.error) throw res.error;
        var remote = (res.data || []).map(fromRow);
        var result = mergeRecords(local, remote);
        hooks.setLocal(result.merged);
        return pushAll(result.toPush, userId);
      })
      .then(function () {
        setStatus('synced');
      })
      .catch(function (err) {
        var offline = (typeof navigator !== 'undefined' && navigator.onLine === false) ||
          /fetch|network|Failed to fetch/i.test(String(err && err.message));
        setStatus(offline ? 'offline' : 'error', String((err && err.message) || err));
      })
      .then(function () {
        syncing = false;
        if (pendingSync) { pendingSync = false; return runSync(); }
      });
  }

  function pushAll(rows, userId) {
    if (!rows.length) return Promise.resolve();
    var chunks = [];
    for (var i = 0; i < rows.length; i += PUSH_CHUNK) {
      chunks.push(rows.slice(i, i + PUSH_CHUNK).map(function (b) { return toRow(b, userId); }));
    }
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return client.from(TABLE).upsert(chunk, { onConflict: 'user_id,id' })
          .then(function (res) { if (res.error) throw res.error; });
      });
    }, Promise.resolve());
  }

  function scheduleSync() {
    if (!client || !session) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { debounceTimer = null; runSync(); }, DEBOUNCE_MS);
  }

  /* ---------- 認証 ---------- */

  function signIn(email) {
    if (!client) return Promise.reject(new Error('クラウド同期が設定されていません'));
    return client.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.href.split('#')[0] }
    }).then(function (res) {
      if (res.error) throw res.error;
      return true;
    });
  }

  function verifyCode(email, code) {
    if (!client) return Promise.reject(new Error('クラウド同期が設定されていません'));
    return client.auth.verifyOtp({ email: email, token: code, type: 'email' })
      .then(function (res) {
        if (res.error) throw res.error;
        return true;
      });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut().then(function () { return true; });
  }

  /* ---------- 初期化 ---------- */

  function init(opts) {
    hooks = opts;

    var cfg = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG : null;
    if (!cfg || !cfg.url || !cfg.anonKey) {
      setStatus('disabled', '接続設定が未入力です');
      return state();
    }
    if (typeof supabase === 'undefined' || !supabase.createClient) {
      setStatus('disabled', 'Supabase ライブラリを読み込めませんでした');
      return state();
    }

    client = supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    client.auth.onAuthStateChange(function (_event, s) {
      session = s;
      if (session) { setStatus('syncing'); runSync(); }
      else setStatus('signed-out');
    });

    client.auth.getSession().then(function (res) {
      session = (res.data && res.data.session) || null;
      if (session) runSync(); else setStatus('signed-out');
    });

    window.addEventListener('online', function () { if (session) runSync(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && session) runSync();
    });

    setStatus('signed-out');
    return state();
  }

  return {
    init: init,
    state: state,
    signIn: signIn,
    verifyCode: verifyCode,
    signOut: signOut,
    syncNow: runSync,
    notifyLocalChange: scheduleSync,
    /* テスト用に公開 */
    _mergeRecords: mergeRecords
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SmashSync;
