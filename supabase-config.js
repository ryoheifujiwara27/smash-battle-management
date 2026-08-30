/* =========================================================
   SMASH RECORD - クラウド同期の接続設定
   ---------------------------------------------------------
   Supabase プロジェクトの URL と anon key をここに設定すると、
   クラウド同期（別端末での共有・サイトデータ削除からの復元）が
   有効になります。空のままなら従来どおり端末内 localStorage のみで
   動作し、アプリの挙動は一切変わりません。

   anon key はブラウザに配布される前提の公開鍵です。リポジトリに
   コミットして問題ありません。実際のデータ保護は Supabase 側の
   Row Level Security（supabase/schema.sql）が行います。
   ※ service_role key は絶対にここに書かないでください。

   設定手順は README.md の「クラウド同期のセットアップ」を参照。
   ========================================================= */
var SUPABASE_CONFIG = {
  url: '',
  anonKey: ''
};

/* ローカルでの試用や、フォークして鍵を変えたい場合のための上書き口。
   ブラウザの devtools で以下を実行すると、この端末だけ設定を差し替えられます。
     localStorage.setItem('smash-record/supabase/v1',
       JSON.stringify({ url: '...', anonKey: '...' }))                       */
(function () {
  try {
    var raw = localStorage.getItem('smash-record/supabase/v1');
    if (!raw) return;
    var o = JSON.parse(raw);
    if (o && typeof o.url === 'string' && typeof o.anonKey === 'string') {
      SUPABASE_CONFIG.url = o.url;
      SUPABASE_CONFIG.anonKey = o.anonKey;
    }
  } catch (e) { /* 破損時は既定値のまま */ }
})();
