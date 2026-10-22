/**
 * Zwift Workout Timer → intervals.icu → Garmin Connect bridge
 *
 * Google Apps Script web app. The timer page sends a workout here; this script
 * writes it to your intervals.icu calendar as a planned workout (power in watts,
 * computed from the FTP the timer sends). intervals.icu then syncs planned
 * workouts to Garmin Connect, and from there to your Edge.
 *
 * Script Properties (Project Settings → Script Properties):
 *   ICU_API_KEY   intervals.icu → Settings → Developer Settings → API Key
 *   BRIDGE_TOKEN  run makeToken() once; the timer page sends it with every request
 */

const ICU = 'https://intervals.icu/api/v1/athlete/0';

/* ---------------- web entry points ---------------- */

function doGet() {
  return ContentService.createTextOutput('Zwift Workout Timer -> intervals.icu bridge is running.');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.token !== prop_('BRIDGE_TOKEN')) return json_({ ok: false, error: 'トークンが違います' });

    if (body.action === 'status') {
      const me = icu_('get', '');
      return json_({ ok: true, athlete: me.name || me.id || 'OK', icuFtp: ftpOf_(me) });
    }
    if (body.action !== 'push') return json_({ ok: false, error: 'unknown action' });

    const ftp = Number(body.ftp);
    if (!(ftp > 50)) throw new Error('FTPが不正です');
    const text = toIcuText_(body.workout, ftp);
    if (body.dryRun) return json_({ ok: true, dryRun: true, text: text });

    const ev = icu_('post', '/events', {
      category: 'WORKOUT',
      type: 'Ride',
      start_date_local: (body.date || today_()) + 'T00:00:00',
      name: String(body.workout.name).slice(0, 80),
      description: text
    });
    return json_({ ok: true, eventId: ev.id, lines: text.split('\n').filter(l => l.startsWith('-')).length });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------- intervals.icu API ---------------- */

function icu_(method, path, body) {
  const key = prop_('ICU_API_KEY');
  if (!key) throw new Error('ICU_API_KEY が未設定です');
  const res = UrlFetchApp.fetch(ICU + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode('API_KEY:' + key) },
    payload: body ? JSON.stringify(body) : null
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code === 401 || code === 403) throw new Error('intervals.icuのAPIキーが正しくありません（' + code + '）');
  if (code < 200 || code >= 300) throw new Error('intervals.icu ' + code + ': ' + text.slice(0, 400));
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

function ftpOf_(me) {
  try {
    const s = (me.sportSettings || []).find(x => (x.types || []).indexOf('Ride') >= 0);
    return s ? s.ftp : null;
  } catch (e) { return null; }
}

/* ---------------- workout → intervals.icu text ----------------
 * Timer step: [seconds, startPct, endPct, cadence, absWatts?]  (pct null = free ride)
 * Output uses absolute watts so the targets match the FTP set in the timer.
 */
function toIcuText_(w, ftp) {
  if (!w || !w.steps || !w.steps.length) throw new Error('ワークアウトが空です');
  const raw = w.steps;
  const watts = (st, v) => st[4] ? v : Math.round(ftp * v / 100);
  const dur = s => {
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + 'h' : '') + (m ? m + 'm' : '') + (x ? x + 's' : '') || '0s';
  };
  const line = st => {
    let t = '- ' + dur(st[0]);
    if (st[1] == null) t += ' freeride';
    else {
      const a = watts(st, st[1]), b = watts(st, st[2]);
      t += a === b ? ' ' + a + 'w' : ' ramp ' + a + '-' + b + 'w';
    }
    if (st[3]) t += ' ' + st[3] + 'rpm';
    return t;
  };

  const key = st => JSON.stringify(st);
  const blocks = [];
  let i = 0;
  while (i < raw.length) {
    let best = { n: 1, k: 1 };
    for (let k = 1; k <= 4 && i + k <= raw.length; k++) {
      let n = 1;
      while (i + (n + 1) * k <= raw.length && raw.slice(i + n * k, i + (n + 1) * k).every((x, j) => key(x) === key(raw[i + j]))) n++;
      if (n > 1 && n * k > best.n * best.k) best = { n: n, k: k };
    }
    if (best.n > 1) blocks.push({ rep: best.n, lines: raw.slice(i, i + best.k).map(line) });
    else {
      const last = blocks[blocks.length - 1];
      if (last && !last.rep) last.lines.push(line(raw[i])); else blocks.push({ rep: 0, lines: [line(raw[i])] });
    }
    i += best.n * best.k;
  }
  const out = ['Zwift Workout Timer / FTP ' + ftp + 'W', ''];
  blocks.forEach(b => {
    if (b.rep) out.push(b.rep + 'x');
    b.lines.forEach(l => out.push(l));
    out.push('');
  });
  return out.join('\n').trim();
}

/* ---------------- helpers ---------------- */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

/* エディタの関数メニューで makeToken を選んで「実行」→ 実行ログに表示されたトークンをタイマーに入力 */
function makeToken() {
  const t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('BRIDGE_TOKEN', t);
  Logger.log('BRIDGE_TOKEN = ' + t);
}

/* APIキーの確認用：関数メニューで testIcu を選んで「実行」→ 実行ログに選手名とFTPが出ればOK */
function testIcu() {
  const me = icu_('get', '');
  Logger.log('intervals.icu: ' + (me.name || me.id) + ' / FTP ' + ftpOf_(me));
}

/* iPhoneでの入力を省くための「設定リンク」を作る。
 * 先にウェブアプリとしてデプロイしてから、関数メニューで setupLink を選んで「実行」。
 * 実行ログのリンクを iPhone に送り（メモやLINEで自分宛てに）、Bluefy のアドレス欄に貼って開くと設定が入ります。 */
function setupLink() {
  const u = ScriptApp.getService().getUrl();
  const t = prop_('BRIDGE_TOKEN');
  if (!u) throw new Error('先にウェブアプリとしてデプロイしてください');
  if (!t) throw new Error('先に makeToken を実行してください');
  const b = Utilities.base64EncodeWebSafe(JSON.stringify({ u: u, t: t })).replace(/=+$/, '');
  Logger.log('設定リンク: https://makenaipon-cloud.github.io/sst-timer/#setup=' + b);
}
