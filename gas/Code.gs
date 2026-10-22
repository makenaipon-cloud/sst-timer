/**
 * Zwift Workout Timer → Garmin Connect (Training API) bridge
 *
 * Google Apps Script web app that
 *   1. runs the Garmin OAuth2 PKCE sign-in once and keeps the tokens in Script Properties
 *   2. receives a workout from the timer page, converts it to a Garmin structured workout
 *      (power targets in watts from the FTP sent by the page), creates it and schedules it
 *      for the chosen date so it syncs to the Edge.
 *
 * Script Properties to set (Project Settings → Script Properties):
 *   GARMIN_CLIENT_ID      Consumer key from the Garmin Developer Portal
 *   GARMIN_CLIENT_SECRET  Consumer secret
 *   BRIDGE_TOKEN          Any long random string. The timer page sends it with every request.
 *
 * The Garmin app's redirect URL must be exactly this web app's /exec URL.
 */

const AUTH_URL  = 'https://connect.garmin.com/oauth2Confirm';
const TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const API       = 'https://apis.garmin.com/training-api';

/* ---------------- web entry points ---------------- */

function doGet(e) {
  const p = e.parameter || {};
  if (p.code && p.state) return finishAuth_(p.code, p.state);
  if (p.action === 'auth') return startAuth_(p.token);
  if (p.action === 'status') return json_({ ok: true, connected: !!props_().getProperty('REFRESH_TOKEN') });
  return html_('<p>Zwift Workout Timer ↔ Garmin bridge is running.</p>' +
               '<p>Garminとの連携: <code>?action=auth&amp;token=（BRIDGE_TOKEN）</code> を付けて開いてください。</p>');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.token !== props_().getProperty('BRIDGE_TOKEN')) return json_({ ok: false, error: 'トークンが違います' });
    if (body.action === 'status') return json_({ ok: true, connected: !!props_().getProperty('REFRESH_TOKEN') });
    if (body.action !== 'push') return json_({ ok: false, error: 'unknown action' });

    const payload = buildWorkout_(body.workout, Number(body.ftp));
    if (body.dryRun) return json_({ ok: true, dryRun: true, payload: payload });

    const created = api_('post', '/workout', payload);
    const workoutId = created.workoutId || created.id;
    let scheduled = null;
    if (body.date && workoutId) scheduled = api_('post', '/schedule', { workoutId: workoutId, date: body.date });
    return json_({ ok: true, workoutId: workoutId, scheduled: scheduled, steps: countSteps_(payload.steps) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------- OAuth2 PKCE ---------------- */

function startAuth_(token) {
  if (token !== props_().getProperty('BRIDGE_TOKEN')) return html_('<p>トークンが違います。</p>');
  const verifier = b64url_(Utilities.getUuid() + Utilities.getUuid()); // 96 chars (PKCE allows 43–128)
  const challenge = b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier, Utilities.Charset.US_ASCII));
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('pkce_' + state, verifier, 900);
  const url = AUTH_URL + '?' + qs_({
    client_id: props_().getProperty('GARMIN_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: ScriptApp.getService().getUrl(),
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return html_('<p><a href="' + url + '" target="_top" style="font-size:20px">Garminにログインして連携する</a></p>');
}

function finishAuth_(code, state) {
  const verifier = CacheService.getScriptCache().get('pkce_' + state);
  if (!verifier) return html_('<p>連携の有効期限が切れました。もう一度最初からやり直してください。</p>');
  const res = UrlFetchApp.fetch(TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'authorization_code',
      redirect_uri: ScriptApp.getService().getUrl(),
      code: code, state: state, code_verifier: verifier,
      client_id: props_().getProperty('GARMIN_CLIENT_ID'),
      client_secret: props_().getProperty('GARMIN_CLIENT_SECRET')
    }
  });
  if (res.getResponseCode() !== 200) return html_('<p>トークン取得に失敗しました: ' + res.getContentText() + '</p>');
  saveTokens_(JSON.parse(res.getContentText()));
  return html_('<p>Garminと連携しました。このタブは閉じて大丈夫です。</p>');
}

function accessToken_() {
  const p = props_();
  const exp = Number(p.getProperty('ACCESS_EXPIRES') || 0);
  if (p.getProperty('ACCESS_TOKEN') && Date.now() < exp - 300000) return p.getProperty('ACCESS_TOKEN');
  const refresh = p.getProperty('REFRESH_TOKEN');
  if (!refresh) throw new Error('Garminと未連携です。?action=auth で連携してください。');
  const res = UrlFetchApp.fetch(TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'refresh_token', refresh_token: refresh,
      client_id: p.getProperty('GARMIN_CLIENT_ID'),
      client_secret: p.getProperty('GARMIN_CLIENT_SECRET')
    }
  });
  if (res.getResponseCode() !== 200) throw new Error('トークン更新に失敗: ' + res.getContentText());
  const t = JSON.parse(res.getContentText());
  saveTokens_(t);
  return t.access_token;
}

function saveTokens_(t) {
  const p = props_();
  p.setProperty('ACCESS_TOKEN', t.access_token);
  p.setProperty('ACCESS_EXPIRES', String(Date.now() + (Number(t.expires_in) || 3600) * 1000));
  if (t.refresh_token) p.setProperty('REFRESH_TOKEN', t.refresh_token);
}

function api_(method, path, body) {
  const res = UrlFetchApp.fetch(API + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken_() },
    payload: body ? JSON.stringify(body) : null
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('Garmin API ' + path + ' ' + code + ': ' + text.slice(0, 500));
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

/* ---------------- workout conversion ----------------
 * Timer step: [seconds, startPct, endPct, cadence, absWatts?]  (pct null = free ride)
 */
function buildWorkout_(w, ftp) {
  if (!w || !w.steps || !w.steps.length) throw new Error('ワークアウトが空です');
  if (!(ftp > 50)) throw new Error('FTPが不正です');
  const raw = w.steps;
  const toW = (st, v) => st[4] ? v : Math.round(ftp * v / 100);

  const leaf = (st, i) => {
    const s = {
      type: 'WorkoutStep',
      intensity: intensity_(st, i, raw.length),
      durationType: 'TIME',
      durationValue: st[0],
      targetType: 'OPEN'
    };
    if (st[1] != null) {
      const a = toW(st, st[1]), b = toW(st, st[2]);
      s.targetType = 'POWER';
      if (a === b) { s.targetValueLow = Math.round(a * 0.97); s.targetValueHigh = Math.round(a * 1.03); }
      else { s.targetValueLow = Math.min(a, b); s.targetValueHigh = Math.max(a, b); }
      s.description = a === b ? (a + 'W') : (a + '→' + b + 'W');
    }
    if (st[3]) { s.secondaryTargetType = 'CADENCE'; s.secondaryTargetValueLow = st[3] - 3; s.secondaryTargetValueHigh = st[3] + 3; }
    return s;
  };

  // collapse consecutive identical blocks (1–4 steps) into repeat steps
  const key = st => JSON.stringify(st);
  const steps = [];
  let i = 0;
  while (i < raw.length) {
    let best = { n: 1, k: 1 };
    for (let k = 1; k <= 4 && i + k <= raw.length; k++) {
      let n = 1;
      while (i + (n + 1) * k <= raw.length && raw.slice(i + n * k, i + (n + 1) * k).every((x, j) => key(x) === key(raw[i + j]))) n++;
      if (n > 1 && n * k > best.n * best.k) best = { n: n, k: k };
    }
    if (best.n > 1) {
      steps.push({
        type: 'WorkoutRepeatStep', repeatType: 'REPEAT_UNTIL_STEPS_CMPLT', repeatValue: best.n,
        steps: raw.slice(i, i + best.k).map((st, j) => leaf(st, i + j))
      });
    } else steps.push(leaf(raw[i], i));
    i += best.n * best.k;
  }
  // number the steps depth-first
  let order = 1;
  const number = arr => arr.forEach(s => { s.stepOrder = order++; if (s.steps) number(s.steps); });
  number(steps);

  return {
    workoutName: String(w.name).slice(0, 80),
    description: ('Zwift Workout Timer / FTP ' + ftp + 'W').slice(0, 512),
    sport: 'CYCLING',
    estimatedDurationInSecs: raw.reduce((a, s) => a + s[0], 0),
    steps: steps
  };
}

function intensity_(st, i, n) {
  if (st[1] == null) return 'ACTIVE';
  if (i === 0 && st[2] > st[1]) return 'WARMUP';
  if (i === n - 1 && st[2] < st[1]) return 'COOLDOWN';
  const p = st[4] ? 0 : Math.max(st[1], st[2]);
  if (!st[4] && p < 60) return 'RECOVERY';
  return 'INTERVAL';
}

function countSteps_(steps) { return steps.reduce((a, s) => a + (s.steps ? countSteps_(s.steps) + 1 : 1), 0); }

/* ---------------- helpers ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function html_(s) { return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:sans-serif;padding:16px;line-height:1.7">' + s + '</div>'); }
function qs_(o) { return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }
function b64url_(x) {
  const bytes = typeof x === 'string' ? Utilities.newBlob(x).getBytes() : x;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
