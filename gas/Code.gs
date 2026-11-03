/* =========================================================
 * さわの夕ごはん — Google Apps Script（スプレッドシートに紐づけて使う）
 *
 * ルール
 *   - 🍚みんなで食べる／🍱1人で家で食べる／🍔外食。何もしなければ「みんなで食べる」
 *   - ❓まだわからない はしめきりまでだけ選べる。しめきりで「みんなで食べる」として確定する
 *   - しめきりは2日前の16:00。過ぎてからの変更も受け付けるが、通知に ⚠️ を付けて数える
 *   - 当日の朝、玄関のタブレットで押してダメ押し確認。10時までに無ければ親に通知
 *
 * データはシート「log」に追記だけする（その日の最後の行が今の状態）
 * 通知先の ntfy トピックはスクリプト プロパティ NTFY_TOPIC に入れる（リポジトリには書かない）
 * ========================================================= */

const TZ = 'Asia/Tokyo';
const DAYS_AHEAD = 14;     // スマホに出す日数
const LEAD_DAYS = 2;       // しめきり：2日前の
const DEADLINE_HOUR = 16;  //           16:00
const CONFIRM_BY_HOUR = 10; // 当日朝の確認がこの時刻までに無ければ親に通知
const DEFAULT_STATUS = 'together';
const STATUS = {
  together: { icon: '🍚', label: 'みんなで食べる' },
  alone: { icon: '🍱', label: '1人で家で食べる' },
  out: { icon: '🍔', label: '外食' },
  unknown: { icon: '❓', label: 'まだわからない', beforeDeadlineOnly: true },
};
// しめきりを過ぎた「まだわからない」は、何もしなかったときと同じ扱いにする
const effective = (status, late) => (late && STATUS[status]?.beforeDeadlineOnly ? DEFAULT_STATUS : status);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- 日付の計算（日本時間。ここは node でも動く） ----------
const pad2 = (n) => String(n).padStart(2, '0');
function addDaysStr(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ymdJst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const hourJst = (ms) => new Date(ms + 9 * 3600e3).getUTCHours();
const deadlineMs = (ymd) => Date.parse(`${addDaysStr(ymd, -LEAD_DAYS)}T${pad2(DEADLINE_HOUR)}:00:00+09:00`);
const isLate = (ymd, ms) => ms >= deadlineMs(ymd);
function dayLabel(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}(${DOW[new Date(ymd + 'T00:00:00Z').getUTCDay()]})`;
}

// log: [{ date, status, at, late, kind: 'set'|'confirm', src }]（古い順）
function summarize(log, ms) {
  const cur = {};
  const confirmed = {};
  for (const e of log) {
    if (e.kind === 'confirm') confirmed[e.date] = e.at;
    else cur[e.date] = e.status;
  }
  const today = ymdJst(ms);
  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const date = addDaysStr(today, i);
    const late = isLate(date, ms);
    const raw = cur[date] || DEFAULT_STATUS;
    days.push({
      date,
      label: dayLabel(date),
      status: effective(raw, late),
      undecided: raw !== effective(raw, late), // 「まだわからない」のまましめきりを過ぎた
      late,
      deadline: deadlineMs(date),
      confirmedAt: confirmed[date] || null,
    });
  }
  const month = today.slice(0, 7);
  const lateCount = log.filter((e) => e.kind === 'set' && e.late && ymdJst(e.at).slice(0, 7) === month).length;
  return { now: ms, days, lateCount, statuses: STATUS };
}

// 1回の操作で何を記録・通知するか。prev と同じ status は、当日の確認（confirm=true）なら確認として、それ以外は何もしない
function decide(log, date, status, ms, confirm) {
  if (!STATUS[status]) throw new Error('status が不正: ' + status);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date が不正: ' + date);
  if (date < ymdJst(ms)) throw new Error('過ぎた日は変えられません');
  const late = isLate(date, ms);
  if (late && STATUS[status].beforeDeadlineOnly) throw new Error('しめきりを過ぎたので「まだわからない」は選べません');
  const prev = effective([...log].reverse().find((e) => e.date === date && e.kind === 'set')?.status ?? DEFAULT_STATUS, late);
  const s = STATUS[status];
  if (prev === status) {
    if (!confirm) return null;
    return { rows: [{ date, status, at: ms, late: false, kind: 'confirm' }], text: `✅ さわ 今日の夕ごはん：${s.icon}${s.label}（朝の確認）`, high: false };
  }
  const when = date === ymdJst(ms) ? '今日' : dayLabel(date);
  const rows = [{ date, status, at: ms, late, kind: 'set' }];
  if (confirm) rows.push({ date, status, at: ms, late: false, kind: 'confirm' }); // 朝にタブレットで変えた＝確認もした
  return {
    rows,
    text: `${late ? '⚠️ しめきり後 ' : ''}${s.icon} さわ ${when}の夕ごはん：${STATUS[prev].label} → ${s.label}`,
    high: late,
  };
}

// ---------- スプレッドシート ----------
const HEADER = ['date', 'status', 'at', 'late', 'kind', 'src', '時刻'];
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('log');
  if (!sh) {
    sh = ss.insertSheet('log');
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sh.getRange('A:A').setNumberFormat('@'); // 日付文字列が Date に化けないように
    sh.setFrozenRows(1);
  }
  return sh;
}

function readLog_() {
  const sh = sheet_();
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 5).getValues().map(([date, status, at, late, kind]) => ({
    date: date instanceof Date ? Utilities.formatDate(date, TZ, 'yyyy-MM-dd') : String(date),
    status: String(status),
    at: Number(at),
    late: late === true,
    kind: String(kind || 'set'),
  }));
}

function notify_(text, high) {
  const topic = PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC');
  if (!topic) return;
  const url = /^https?:\/\//.test(topic) ? topic : 'https://ntfy.sh/' + encodeURIComponent(topic);
  const headers = {};
  if (high) headers.Priority = 'high';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/plain; charset=utf-8',
    payload: text,
    headers,
    muteHttpExceptions: true,
  });
}

function apply_(date, status, confirm, src) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const log = readLog_();
    const ms = Date.now();
    const d = decide(log, date, status, ms, confirm);
    if (d) {
      for (const r of d.rows) {
        sheet_().appendRow([r.date, r.status, r.at, r.late, r.kind, src, Utilities.formatDate(new Date(ms), TZ, 'yyyy/MM/dd HH:mm')]);
        log.push(r);
      }
      notify_(d.text, d.high);
    }
    return summarize(log, ms);
  } finally {
    lock.releaseLock();
  }
}

// ---------- 入口 ----------
// スマホ：URL をそのまま開くと選ぶ画面。?api=list は玄関のタブレットが読む JSON
function doGet(e) {
  if (e && e.parameter && e.parameter.api === 'list') {
    return json_(summarize(readLog_(), Date.now()));
  }
  return HtmlService.createHtmlOutputFromFile('page')
    .setTitle('さわの夕ごはん')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 玄関のタブレットから：本文は JSON {date, status, confirm}（text/plain で送る＝プリフライトなし）
function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    return json_(apply_(b.date, b.status, !!b.confirm, 'tablet'));
  } catch (err) {
    return json_({ error: String(err.message || err) });
  }
}

const json_ = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

// スマホの画面（page.html）から google.script.run で呼ぶ
function getState() { return summarize(readLog_(), Date.now()); }
function setDinner(date, status) { return apply_(date, status, false, 'phone'); }

// ---------- 毎日の自動実行 ----------
// 16時台：2日後の分が確定したことを親に知らせる
function onDeadline() {
  const ms = Date.now();
  const day = summarize(readLog_(), ms).days.find((d) => d.date === addDaysStr(ymdJst(ms), LEAD_DAYS));
  if (!day) return;
  const s = STATUS[day.status];
  notify_(`📋 しめきり：さわ ${day.label}の夕ごはん → ${s.icon}${s.label}${day.undecided ? '（まだわからない のまま → みんなで食べる で確定）' : ''}`, day.undecided);
}

// 10時台：今日の朝の確認が無ければ親に知らせる（状態は変えない）
function onMorningCheck() {
  const ms = Date.now();
  const day = summarize(readLog_(), ms).days[0];
  if (day.confirmedAt) return;
  const s = STATUS[day.status];
  notify_(`❔ さわ 今日の夕ごはん：朝の確認なし（${s.icon}${s.label} のまま）`, false);
}

// 最初に1回だけ手で実行する：シートを作り、毎日の自動実行を登録し直す
function setup() {
  sheet_();
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('onDeadline').timeBased().atHour(DEADLINE_HOUR).nearMinute(5).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('onMorningCheck').timeBased().atHour(CONFIRM_BY_HOUR).nearMinute(5).everyDays(1).inTimezone(TZ).create();
  if (!PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC')) {
    Logger.log('スクリプト プロパティに NTFY_TOPIC を入れてください');
  }
}

if (typeof module !== 'undefined') module.exports = { summarize, decide, deadlineMs, ymdJst, addDaysStr, hourJst };
