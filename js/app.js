/* =========================================================
 * Door Dashboard — app.js
 * 玄関ドア内側 Android タブレット (Fully Kiosk Browser) 用
 * バックエンドなし / GitHub Pages 静的ホスト前提
 * ========================================================= */
(() => {
  'use strict';

  // ---------- 設定（URLパラメータで上書き可） ----------
  const params = new URLSearchParams(location.search);
  const CONFIG = {
    // 天気（Open-Meteo / APIキー不要）。既定は厚木市付近
    lat: parseFloat(params.get('lat') ?? '35.4428'),
    lon: parseFloat(params.get('lon') ?? '139.3625'),
    locationName: params.get('loc') ?? '厚木',
    tasksUrl: 'data/tasks.json',
    tasksRefreshMin: 10,      // tasks.json 再取得間隔（Git push の反映）
    weatherRefreshMin: 30,
    upcomingWindowH: 3,       // 「このあと」に出す先読み時間
    deadlineSoonMin: 30,      // 締切まで何分で強調するか
    rainAlertPop: 50,         // 降水確率(%)がこれ以上で傘アラート
    nightStart: 23,           // 夜間減光 開始時刻
    nightEnd: 5,              //           終了時刻
    dayBrightness: 180,       // Fully: 0-255
    nightBrightness: 20,
    batteryWarnLevel: 20,     // これ以下＆未充電で赤バナー
    focusTimeoutSec: 90,      // ズーム表示から全員表示に戻るまで（無操作秒）
    faceCooldownSec: 20,      // 顔スキャンを連続で走らせない間隔
    longPressMs: 2000,        // 時計の長押しで設定を開く
    todoStartHour: 5,         // 単発TODOの既定表示開始
    todoEndHour: 23,          //            既定表示終了
    prevEveningHour: 17,      // prev_evening=true の単発TODOを前日何時から出すか
    burnInShiftPx: 6,         // 焼き付き防止の移動量
    dailyReloadHour: 3,       // 毎日この時刻にページ再読込（メモリリーク対策）
  };

  // デバッグ用：?now=2026-11-02T07:30 で時刻を固定オフセット
  const timeOffset = params.get('now') ? new Date(params.get('now')).getTime() - Date.now() : 0;
  const now = () => new Date(Date.now() + timeOffset);

  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  // ---------- 状態 ----------
  let data = { members: [], routines: [], todos: [], categories: {}, tag_styles: {} };
  let dataLoadedAt = null;
  let dataError = false;
  let weather = null;
  let lastRenderKey = '';
  let focusMember = null;     // ズーム中の子の id（null = 全員）
  let focusTimer = null;
  let lastFaceScan = 0;
  const faceEnabled = () => { try { return localStorage.getItem('dd:face-enabled') === '1'; } catch { return false; } };

  // ---------- Fully Kiosk 連携 ----------
  const Fully = {
    available: typeof window.fully !== 'undefined',
    call(fn, ...args) {
      try { if (this.available && typeof fully[fn] === 'function') return fully[fn](...args); }
      catch (e) { console.warn('[Fully]', fn, e); }
      return undefined;
    },
    init() {
      if (!this.available) return;
      // 画面ONやモーション検知時に即再描画（時計ずれ・天気の古さを解消）
      this.call('bind', 'screenOn', 'window.DD && window.DD.wake()');
      this.call('bind', 'onMotion', 'window.DD && window.DD.wake()');
      this.call('bind', 'onBatteryLevelChanged', 'window.DD && window.DD.refresh()');
      this.call('bind', 'pluggedAC', 'window.DD && window.DD.refresh()');
      this.call('bind', 'unplugged', 'window.DD && window.DD.refresh()');
    },
    setBrightness(v) { this.call('setScreenBrightness', v); },
    screenOff() { this.call('turnScreenOff'); },
    battery() { return this.call('getBatteryLevel'); },
    plugged() { return this.call('isPlugged'); },
  };

  // ---------- ローカル保存（チェック状態） ----------
  const store = {
    key: (date) => `dd:done:${date}`,
    get(date) {
      try { return JSON.parse(localStorage.getItem(this.key(date)) || '{}'); } catch { return {}; }
    },
    set(date, obj) {
      try { localStorage.setItem(this.key(date), JSON.stringify(obj)); } catch {}
    },
    prune(keepDays = 7) {
      try {
        const limit = ymd(addDays(now(), -keepDays));
        Object.keys(localStorage)
          .filter((k) => k.startsWith('dd:done:') && k.slice(8) < limit)
          .forEach((k) => localStorage.removeItem(k));
      } catch {}
    },
  };

  // ---------- タスク判定 ----------
  /**
   * routine が時刻 t にアクティブか判定。
   * start_hour > end_hour の場合は日付またぎ（例 19→2）。
   * end_hour は含まない。days はその枠が「始まった日」の曜日で判定。
   * @returns {null | {occDate: string, endsAt: Date}}
   */
  function occurrence(r, t) {
    const h = t.getHours();
    const s = r.start_hour, e = r.end_hour;
    const days = r.days ?? [0, 1, 2, 3, 4, 5, 6];
    let startDay = null;
    if (s < e) {
      if (h >= s && h < e) startDay = t;
    } else if (s > e) {
      if (h >= s) startDay = t;
      else if (h < e) startDay = addDays(t, -1);
    }
    if (!startDay || !days.includes(startDay.getDay())) return null;
    const end = new Date(startDay);
    end.setHours(e, 0, 0, 0);
    if (s > e) end.setDate(end.getDate() + 1);
    return { occDate: ymd(startDay), endsAt: end };
  }

  // routine.members: ["all"] または member id の配列。未指定は全員。
  function assignees(r) {
    const all = (data.members ?? []).map((m) => m.id);
    const m = r.members;
    if (!m || m.includes('all')) return all;
    return m.filter((id) => all.includes(id));
  }

  /**
   * 単発TODO（日付指定）の表示枠。
   * prev_evening=true なら前日 prevEveningHour から「明日：」付きで表示する。
   */
  function todoWindow(td) {
    const [y, mo, d] = td.date.split('-').map(Number);
    const start = new Date(y, mo - 1, d, td.start_hour ?? CONFIG.todoStartHour);
    const end = new Date(y, mo - 1, d, td.end_hour ?? CONFIG.todoEndHour);
    const early = td.prev_evening ? new Date(y, mo - 1, d - 1, CONFIG.prevEveningHour) : null;
    return { start, end, early };
  }

  function todoOccurrence(td, t) {
    if (!td.date) return null;
    const { start, end, early } = todoWindow(td);
    if (t >= start && t < end) return { occDate: td.date, endsAt: end };
    if (early && t >= early && t < start) return { occDate: td.date, endsAt: start, prefix: '明日：' };
    return null;
  }

  function activeTasks(t, memberId) {
    const mine = (r) => assignees(r).includes(memberId);
    const routines = data.routines.filter(mine).map((r) => ({ r, occ: occurrence(r, t) }));
    const todos = (data.todos ?? []).filter(mine).map((r) => ({ r, occ: todoOccurrence(r, t) }));
    return [...todos, ...routines]
      .filter((x) => x.occ)
      .sort((a, b) => a.occ.endsAt - b.occ.endsAt);
  }

  // その日の外出予定（習い事など）。days（毎週）か date（その日だけ）で指定
  function todaysOutings(t, memberId) {
    const today = ymd(t);
    return (data.outings ?? [])
      .filter((o) => assignees(o).includes(memberId))
      .filter((o) => (o.date ? o.date === today : (o.days ?? []).includes(t.getDay())))
      .filter((o) => !(o.except ?? []).includes(today))
      .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  }

  function upcomingTasks(t) {
    const out = [];
    const limit = t.getTime() + CONFIG.upcomingWindowH * 3600e3;
    for (const r of data.routines) {
      for (let i = 0; i <= 1; i++) {
        const day = addDays(t, i);
        const st = new Date(day); st.setHours(r.start_hour, 0, 0, 0);
        if (st > t && st.getTime() <= limit && (r.days ?? [0,1,2,3,4,5,6]).includes(st.getDay())) {
          out.push({ r, at: st });
        }
      }
    }
    for (const td of data.todos ?? []) {
      if (!td.date) continue;
      const { start, early } = todoWindow(td);
      const at = early && early > t ? early : start;
      if (at > t && at.getTime() <= limit) out.push({ r: td, at });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // ---------- 描画 ----------
  function renderClock(t) {
    $('clock').textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const d = t.getDay();
    const cls = d === 0 ? 'dow-sun' : d === 6 ? 'dow-sat' : '';
    $('date').innerHTML = `${t.getMonth() + 1}月${t.getDate()}日 <span class="${cls}">(${DOW[d]})</span>`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const doneKey = (memberId, taskId) => `${memberId}:${taskId}`;

  function renderColumn(member, t) {
    const list = activeTasks(t, member.id);
    const col = el('section', 'col');
    col.dataset.member = member.id;
    col.style.setProperty('--c', member.color || 'var(--info)');
    if (focusMember) col.classList.add(focusMember === member.id ? 'focused' : 'collapsed');

    const outs = todaysOutings(t, member.id);
    if (outs.length) {
      const ob = el('div', 'col-outings');
      for (const o of outs) {
        const chip = el('span', 'outing');
        if (o.time) chip.append(el('span', 'outing-time', o.time));
        chip.append(document.createTextNode(`${o.icon ?? '🚪'} ${o.titles?.[member.id] ?? o.title}`));
        ob.append(chip);
      }
      col.append(ob);
    }

    const head = el('div', 'col-head');
    head.append(el('span', 'col-icon', member.icon ?? '🙂'), el('span', 'col-name', member.name));
    const prog = el('span', 'progress-text');
    head.append(prog);
    col.append(head);

    const bar = el('div', 'progress');
    const fill = el('div', 'progress-bar');
    bar.append(fill);
    col.append(bar);

    if (!list.length) {
      const e = el('div', 'empty');
      e.append(el('div', 'empty-icon', '✨'), el('div', null, 'いまはなし'));
      col.append(e);
      return col;
    }

    const ul = el('ul', 'task-list');
    let done = 0;
    const cache = {};
    for (const { r, occ } of list) {
      const map = (cache[occ.occDate] ??= store.get(occ.occDate));
      const isDone = !!map[doneKey(member.id, r.id)];
      if (isDone) done++;

      const li = el('li', 'task' + (isDone ? ' done' : ''));
      li.dataset.member = member.id;
      li.dataset.id = r.id;
      li.dataset.occ = occ.occDate;
      li.append(el('div', 'check', '✓'));

      const body = el('div', 'task-body');
      // titles.<memberId> があればその子向けの表記（kid3 は小2までの漢字）
      body.append(el('div', 'task-title', (occ.prefix ?? '') + (r.titles?.[member.id] ?? r.title)));
      const meta = el('div', 'task-meta');
      const minsLeft = Math.round((occ.endsAt - t) / 60000);
      meta.append(el('span', 'deadline' + (!isDone && minsLeft <= CONFIG.deadlineSoonMin ? ' soon' : ''),
        minsLeft <= 60 ? `あと${minsLeft}分` : `〜${pad(occ.endsAt.getHours())}:00`));
      body.append(meta);
      li.append(body);
      ul.append(li);
    }
    col.append(ul);

    prog.textContent = `${done}/${list.length}`;
    fill.style.width = `${(done / list.length) * 100}%`;
    col.classList.toggle('complete', done === list.length);
    return col;
  }

  /**
   * 溢れた列だけ段階的に詰める：
   *  fit-1 … 締切行を隠す（締切が近いものは残す）
   *  fit-2 … さらに文字と余白を小さく
   *  fit-3 … もう一段小さく
   *  fit-4 … 名前・外出予定の行を詰める
   *  fit-5 … やることを2列に並べる
   */
  function autoFit() {
    document.querySelectorAll('.col').forEach((col) => {
      const list = col.querySelector('.task-list');
      if (!list) return;
      const levels = ['fit-1', 'fit-2', 'fit-3', 'fit-4', 'fit-5'];
      col.classList.remove(...levels);
      for (const cls of levels) {
        if (list.scrollHeight <= list.clientHeight + 2) break;
        col.classList.add(cls);
      }
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(autoFit));

  function renderTasks(t) {
    const members = data.members ?? [];
    const cols = $('columns');
    if (focusMember && !members.some((m) => m.id === focusMember)) focusMember = null;
    cols.style.gridTemplateColumns = focusMember
      ? members.map((m) => (m.id === focusMember ? '1fr' : 'clamp(90px, 9vw, 140px)')).join(' ')
      : `repeat(${Math.max(members.length, 1)}, 1fr)`;
    cols.classList.toggle('focusing', !!focusMember);
    cols.replaceChildren(...members.map((m) => renderColumn(m, t)));
    requestAnimationFrame(autoFit);

    // 見出し：いま有効なカテゴリ名
    const cats = [...new Set(data.routines.filter((r) => occurrence(r, t)).map((r) => r.category))];
    const c = cats.length === 1 ? data.categories?.[cats[0]] : null;
    $('now-title').textContent = c ? `${c.icon ?? ''} ${c.label}`.trim() : 'いまやること';

    // このあと（担当者アイコン付き）
    const up = upcomingTasks(t);
    $('next-panel').hidden = up.length === 0;
    const nl = $('next-list');
    nl.replaceChildren();
    const byId = Object.fromEntries(members.map((m) => [m.id, m]));
    for (const { r, at } of up.slice(0, 6)) {
      const li = el('li');
      const who = assignees(r).length === members.length ? '' :
        assignees(r).map((id) => byId[id]?.icon ?? '').join('');
      li.append(el('span', 'at', `${pad(at.getHours())}:00`), document.createTextNode(r.title));
      if (who) li.append(el('span', 'who', who));
      nl.append(li);
    }
  }

  function renderAlerts(t) {
    const box = $('alerts');
    box.replaceChildren();
    const add = (type, icon, text) => {
      const d = el('div', 'alert ' + type);
      d.append(el('span', null, icon), el('span', null, text));
      box.append(d);
    };

    const h = t.getHours();

    // バッテリー低下（Fully のみ）
    if (Fully.available) {
      const lv = Number(Fully.battery());
      if (Number.isFinite(lv) && lv <= CONFIG.batteryWarnLevel && !Fully.plugged()) {
        add('danger pulse', '⚠️', `バッテリー低下 (${lv}%) - 要充電`);
      }
    }

    // ゴミ出しバッジ：当日・その朝（タスクの時間帯）のみ
    const trashNow = data.routines.filter((r) =>
      (r.tags ?? []).includes('ゴミ') && r.category === 'morning' && occurrence(r, t));
    if (trashNow.length) {
      add('warn pulse', '🗑️', `今日は ${trashNow.map((r) => r.title.replace(/出し$/, '')).join('・')} の日！`);
    }

    // 傘アラート（朝〜夕方）
    if (weather && h >= 5 && h < 18 && weather.popAhead >= CONFIG.rainAlertPop) {
      add('info', '☂️', `傘を持って！ 降水確率 ${weather.popAhead}%`);
    }

    // 夜：明日のゴミ予告
    if (h >= 19) {
      const tm = addDays(t, 1);
      const trash = data.routines.filter((r) =>
        (r.tags ?? []).includes('ゴミ') && (r.days ?? []).includes(tm.getDay()));
      if (trash.length) add('warn', '🗑️', `明日は ${trash.map((r) => r.title.replace(/出し$/, '')).join('・')}`);
    }

    if (dataError) add('danger', '⚠️', 'タスクデータを読み込めません（前回のデータを表示中）');
  }

  function renderWeather() {
    if (!weather) return;
    $('wx-icon').textContent = weather.icon;
    $('wx-temp').textContent = `${Math.round(weather.temp)}°`;
    $('wx-sub').innerHTML =
      `${CONFIG.locationName} <span class="hi">${Math.round(weather.max)}°</span> / ` +
      `<span class="lo">${Math.round(weather.min)}°</span> ☔${weather.popAhead}%`;
  }

  function renderDevice() {
    const parts = [];
    if (Fully.available) {
      const b = Fully.battery();
      if (b != null) parts.push(`🔋${b}%${Fully.plugged() ? '⚡' : ''}`);
    }
    $('status-device').textContent = parts.join(' ');
    $('status-data').textContent = dataLoadedAt
      ? `データ更新 ${pad(dataLoadedAt.getHours())}:${pad(dataLoadedAt.getMinutes())}`
      : 'データ: --';
  }

  function render(force = false) {
    const t = now();
    renderClock(t);
    // タスクは分が変わった時 or 強制時のみ再構築（チラつき防止）
    const key = `${ymd(t)} ${t.getHours()}:${t.getMinutes()} ${dataLoadedAt?.getTime()}`;
    if (force || key !== lastRenderKey) {
      lastRenderKey = key;
      renderTasks(t);
      renderAlerts(t);
      renderDevice();
      applyNightMode(t);
    }
  }

  // ---------- 夜間減光 ----------
  let nightState = null;
  function applyNightMode(t) {
    const h = t.getHours();
    const { nightStart: s, nightEnd: e } = CONFIG;
    const isNight = s > e ? (h >= s || h < e) : (h >= s && h < e);
    if (isNight === nightState) return;
    nightState = isNight;
    document.body.classList.toggle('dim', isNight && !Fully.available);
    Fully.setBrightness(isNight ? CONFIG.nightBrightness : CONFIG.dayBrightness);
  }

  // ---------- データ取得 ----------
  async function loadTasks() {
    try {
      const res = await fetch(`${CONFIG.tasksUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      if (!Array.isArray(json.routines)) throw new Error('invalid schema');
      json.todos ??= [];
      data = json;
      dataLoadedAt = now();
      dataError = false;
      try { localStorage.setItem('dd:tasks-cache', JSON.stringify(json)); } catch {}
    } catch (e) {
      console.warn('[tasks]', e);
      dataError = true;
      if (!data.routines.length) {
        try { const c = JSON.parse(localStorage.getItem('dd:tasks-cache')); if (c) data = c; } catch {}
      }
    }
    render(true);
  }

  // WMO weather code → 絵文字
  function wmoIcon(code, isDay) {
    if (code === 0) return isDay ? '☀️' : '🌙';
    if (code <= 2) return isDay ? '🌤️' : '☁️';
    if (code === 3) return '☁️';
    if (code <= 48) return '🌫️';
    if (code <= 57) return '🌦️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '🌨️';
    if (code <= 82) return '🌧️';
    if (code <= 86) return '🌨️';
    return '⛈️';
  }

  async function loadWeather() {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}`
      + '&current=temperature_2m,weather_code,is_day'
      + '&daily=temperature_2m_max,temperature_2m_min'
      + '&hourly=precipitation_probability'
      + '&timezone=Asia%2FTokyo&forecast_days=2';
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      // 現在から12時間以内の最大降水確率
      const nowMs = now().getTime();
      let popAhead = 0;
      j.hourly.time.forEach((ts, i) => {
        const ms = new Date(ts + ':00+09:00').getTime();
        if (ms >= nowMs - 3600e3 && ms <= nowMs + 12 * 3600e3) {
          popAhead = Math.max(popAhead, j.hourly.precipitation_probability[i] ?? 0);
        }
      });
      weather = {
        temp: j.current.temperature_2m,
        icon: wmoIcon(j.current.weather_code, j.current.is_day),
        max: j.daily.temperature_2m_max[0],
        min: j.daily.temperature_2m_min[0],
        popAhead,
      };
      renderWeather();
      render(true);
    } catch (e) {
      console.warn('[weather]', e);
      if (!weather) $('wx-sub').textContent = '天気を取得できません';
    }
  }

  // ---------- エラー表示（実機で原因を追えるよう、画面下に出す） ----------
  function showError(where, e) {
    const t = new Date();
    const msg = `⚠️ ${where}: ${e?.message ?? e} (${pad(t.getHours())}:${pad(t.getMinutes())})`;
    console.error('[DD]', where, e);
    const box = $('status-error');
    if (box) box.textContent = msg;
  }
  window.addEventListener('error', (ev) => showError('error', ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => showError('promise', ev.reason));

  // ---------- 操作 ----------
  // 触れた瞬間に枠を光らせる（タップがページに届いているかが目で分かる）
  $('columns').addEventListener('pointerdown', (ev) => {
    const li = ev.target.closest('.task');
    if (li) li.classList.add('pressed');
  });
  ['pointerup', 'pointercancel'].forEach((type) => $('columns').addEventListener(type, () => {
    setTimeout(() => document.querySelectorAll('.task.pressed').forEach((x) => x.classList.remove('pressed')), 150);
  }));

  $('columns').addEventListener('click', (ev) => {
    const col = ev.target.closest('.col');
    if (!col) return;
    // 畳まれた列 or 列の見出しをタップ → その子にズーム（ズーム中の見出しなら解除）
    if (col.classList.contains('collapsed')) return setFocus(col.dataset.member);
    if (ev.target.closest('.col-head')) {
      return setFocus(focusMember === col.dataset.member ? null : col.dataset.member);
    }
    const li = ev.target.closest('.task');
    if (!li) return;
    const { member, id, occ } = li.dataset;
    const m = store.get(occ);
    const k = doneKey(member, id);
    if (m[k]) delete m[k]; else m[k] = Date.now();
    store.set(occ, m);
    // 先にその行だけ見た目を切り替える（描き直しが失敗・遅延しても反応が見える）
    li.classList.toggle('done', !!m[k]);
    try {
      const finished = m[k] ? completedList(member, now()) : null;
      if (focusMember) armFocusTimer();
      render(true);
      if (finished) {
        celebrate(member);
        maybeNotifyComplete(member, finished);
      }
    } catch (e) {
      showError('check', e);
    }
  });

  // ---------- 完了通知（ntfy） ----------
  // 宛先トピックは公開リポジトリに置かず、このタブレットの localStorage にだけ持つ
  const notifyTopic = () => { try { return localStorage.getItem('dd:ntfy-topic') || ''; } catch { return ''; } };

  async function sendNotify(text) {
    const topic = notifyTopic().trim();
    if (!topic) return false;
    const url = /^https?:\/\//.test(topic) ? topic : `https://ntfy.sh/${encodeURIComponent(topic)}`;
    // カスタムヘッダを付けない＝プリフライト不要の単純リクエスト
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url, { method: 'POST', body: text });
        if (res.ok) return true;
      } catch (e) {
        console.warn('[notify]', e);
      }
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
    return false;
  }

  function completedList(memberId, t) {
    const list = activeTasks(t, memberId);
    const allDone = list.length > 0
      && list.every(({ r, occ }) => !!store.get(occ.occDate)[doneKey(memberId, r.id)]);
    return allDone ? list : null;
  }

  function maybeNotifyComplete(memberId, list) {
    const t = now();
    // 同じ日・同じ顔ぶれのリストでは1回だけ（外して付け直しても再送しない）
    const today = ymd(t);
    const sig = `${memberId}|${list.map(({ r }) => r.id).sort().join(',')}`;
    let sent;
    try { sent = JSON.parse(localStorage.getItem('dd:notified') || '{}'); } catch { sent = {}; }
    if (sent.date !== today) sent = { date: today, keys: [] };
    if (sent.keys.includes(sig)) return;
    sent.keys.push(sig);
    try { localStorage.setItem('dd:notified', JSON.stringify(sent)); } catch {}

    const m = (data.members ?? []).find((x) => x.id === memberId);
    const cats = [...new Set(list.map(({ r }) => data.categories?.[r.category]?.label).filter(Boolean))];
    sendNotify(`🎉 ${m?.icon ?? ''}${m?.name ?? memberId}：${cats.join('・') || 'やること'} ぜんぶ完了（${list.length}こ） ${pad(t.getHours())}:${pad(t.getMinutes())}`);
  }

  // ---------- 全部できた！エフェクト ----------
  const CONFETTI_COLORS = ['#fde047', '#f472b6', '#22d3ee', '#a3e635', '#fb923c', '#ffffff'];
  function celebrate(memberId) {
    const m = (data.members ?? []).find((x) => x.id === memberId);
    const col = document.querySelector(`.col[data-member="${memberId}"]`);
    const rect = col?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const layer = el('div', 'celebrate');
    layer.style.setProperty('--c', m?.color || 'var(--amber)');

    // 紙吹雪：列の上部から打ち上げて、重力で落とす
    const colors = [m?.color, ...CONFETTI_COLORS].filter(Boolean);
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height * 0.3;
    for (let i = 0; i < 90; i++) {
      const p = el('i', 'confetti');
      p.style.background = colors[i % colors.length];
      p.style.left = `${ox}px`;
      p.style.top = `${oy}px`;
      if (i % 3 === 0) p.style.borderRadius = '50%';
      layer.append(p);
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
      const v = (0.35 + Math.random() * 0.55) * Math.min(innerWidth, innerHeight);
      const dx = Math.cos(ang) * v;
      const dy = Math.sin(ang) * v;
      const fall = innerHeight * (0.6 + Math.random() * 0.5);
      const rot = (Math.random() - 0.5) * 1440;
      p.animate([
        { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${rot / 2}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx * 1.3}px), calc(-50% + ${dy + fall}px)) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: 2200 + Math.random() * 1000, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' });
    }

    const msg = el('div', 'celebrate-msg');
    msg.append(el('div', 'celebrate-big', '🎉 ぜんぶできた！'), el('div', 'celebrate-name', `${m?.icon ?? ''} ${m?.name ?? ''}`));
    layer.append(msg);
    document.body.append(layer);
    col?.classList.add('just-done');
    setTimeout(() => layer.remove(), 3400);
    setTimeout(() => document.querySelector(`.col[data-member="${memberId}"]`)?.classList.remove('just-done'), 1800);
  }

  // ---------- ズーム ----------
  function setFocus(memberId) {
    focusMember = memberId;
    if (memberId) armFocusTimer(); else clearTimeout(focusTimer);
    render(true);
  }
  function armFocusTimer() {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => setFocus(null), CONFIG.focusTimeoutSec * 1000);
  }

  // ---------- トースト ----------
  let toastTimer = null;
  function toast(text, color, ms = 2200) {
    const t = $('toast');
    t.textContent = text;
    t.style.setProperty('--c', color || 'var(--amber)');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- 顔認識 ----------
  function greeting(t) {
    const h = t.getHours();
    if (h >= 4 && h < 11) return 'おはよう';
    if (h >= 14 && h < 20) return 'おかえり';
    return 'こんばんは';
  }

  async function runFaceScan({ manual = false } = {}) {
    if (!window.FaceID || !FaceID.supported || !faceEnabled() || FaceID.isScanning()) return;
    if (!manual && Date.now() - lastFaceScan < CONFIG.faceCooldownSec * 1000) return;
    if (!$('settings').hidden) return;
    lastFaceScan = Date.now();
    const members = data.members ?? [];
    const box = $('face-scan');
    const msg = $('face-scan-msg');
    box.hidden = false;
    msg.textContent = '👀 顔を見せてね';
    try {
      const res = await FaceID.identify($('face-video'), members.map((m) => m.id), (st) => {
        if (st === 'loading') msg.textContent = '⏳ じゅんび中…';
        if (st === 'scanning') msg.textContent = '👀 顔を見せてね';
        if (st === 'unsure') msg.textContent = '🤔 もうすこし近くで';
      });
      box.hidden = true;
      if (res) {
        const m = members.find((x) => x.id === res.id);
        setFocus(res.id);
        toast(`${m.icon ?? ''} ${m.name}、${greeting(now())}！`, m.color);
      } else if (manual) {
        toast('わからなかった… 自分のアイコンをタップしてね', null, 3000);
      }
    } catch (e) {
      console.warn('[face]', e);
      box.hidden = true;
      if (manual) toast('カメラが使えません', 'var(--danger)', 3000);
    }
  }

  $('face-btn').addEventListener('click', () => runFaceScan({ manual: true }));

  // ---------- 設定（時計の長押し） ----------
  let pressTimer = null;
  const clockEl = document.querySelector('.clock-block');
  const cancelPress = () => clearTimeout(pressTimer);
  clockEl.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(openSettings, CONFIG.longPressMs);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => clockEl.addEventListener(e, cancelPress));
  clockEl.addEventListener('contextmenu', (e) => e.preventDefault());

  function applyFaceUI() {
    const on = faceEnabled() && window.FaceID && FaceID.supported;
    $('face-btn').hidden = !on;
    document.body.classList.toggle('face-on', !!on);
  }

  function renderEnrollList() {
    const list = $('enroll-list');
    list.replaceChildren();
    for (const m of data.members ?? []) {
      const row = el('div', 'enroll-item');
      row.style.setProperty('--c', m.color || 'var(--info)');
      const n = window.FaceID ? FaceID.sampleCount(m.id) : 0;
      row.append(
        el('span', 'who', `${m.icon ?? ''} ${m.name}`),
        el('span', 'cnt', n ? `登録 ${n}枚分` : '未登録'),
      );
      const add = el('button', 'btn primary', n ? '追加で登録' : '登録');
      add.addEventListener('click', () => doEnroll(m));
      const del = el('button', 'btn', '消去');
      del.disabled = !n;
      del.addEventListener('click', () => { FaceID.clear(m.id); renderEnrollList(); });
      row.append(add, del);
      list.append(row);
    }
  }

  async function doEnroll(m) {
    const stage = $('enroll-stage');
    const msg = $('enroll-msg');
    stage.hidden = false;
    document.querySelectorAll('#settings .btn').forEach((b) => (b.disabled = true));
    msg.textContent = '⏳ じゅんび中…';
    try {
      const n = await FaceID.enroll(m.id, $('enroll-video'), (text, i, total) => {
        msg.textContent = `${m.name}：${text}（${i}/${total}）`;
      });
      msg.textContent = `✅ ${m.name} を ${n}枚分 登録しました`;
    } catch (e) {
      msg.textContent = `⚠️ ${e.message || e}`;
    }
    document.querySelectorAll('#settings .btn').forEach((b) => (b.disabled = false));
    renderEnrollList();
    setTimeout(() => { stage.hidden = true; }, 2500);
  }

  function openSettings() {
    $('face-enabled').checked = faceEnabled();
    $('ntfy-topic').value = notifyTopic();
    $('ntfy-msg').textContent = '';
    renderEnrollList();
    $('settings').hidden = false;
  }
  $('settings-close').addEventListener('click', () => {
    $('settings').hidden = true;
    $('enroll-stage').hidden = true;
  });
  $('face-enabled').addEventListener('change', (e) => {
    try { localStorage.setItem('dd:face-enabled', e.target.checked ? '1' : '0'); } catch {}
    applyFaceUI();
    if (e.target.checked) FaceID.preload().catch((err) => console.warn('[face]', err));
  });
  $('face-test').addEventListener('click', async () => {
    $('settings').hidden = true;
    await runFaceScan({ manual: true });
  });
  $('ntfy-topic').addEventListener('change', (e) => {
    try { localStorage.setItem('dd:ntfy-topic', e.target.value.trim()); } catch {}
  });
  $('ntfy-test').addEventListener('click', async () => {
    try { localStorage.setItem('dd:ntfy-topic', $('ntfy-topic').value.trim()); } catch {}
    $('ntfy-msg').textContent = '⏳ 送信中…';
    const ok = await sendNotify(`🔔 玄関ダッシュボードからのテスト通知 ${pad(now().getHours())}:${pad(now().getMinutes())}`);
    $('ntfy-msg').textContent = ok ? '✅ 送信しました' : '⚠️ 送れませんでした（トピック名・ネット接続を確認）';
  });
  $('face-clear-all').addEventListener('click', () => { FaceID.clearAll(); renderEnrollList(); });

  $('screen-off').addEventListener('click', () => {
    if (Fully.available) Fully.screenOff();
    else document.body.classList.toggle('dim'); // ブラウザでの確認用
  });

  // ---------- 焼き付き防止 ----------
  function burnInShift() {
    const p = CONFIG.burnInShiftPx;
    const x = Math.round((Math.random() * 2 - 1) * p);
    const y = Math.round((Math.random() * 2 - 1) * p);
    $('shift').style.transform = `translate(${x}px, ${y}px)`;
  }

  // ---------- 起動 ----------
  let lastDay = ymd(now());
  function tick() {
    const t = now();
    render();
    // 日付が変わったら古いチェック状態を掃除
    if (ymd(t) !== lastDay) { lastDay = ymd(t); store.prune(); }
    // 毎日決まった時刻にリロード（長時間稼働対策）
    if (t.getHours() === CONFIG.dailyReloadHour && t.getMinutes() === 0 && t.getSeconds() < 2
        && performance.now() > 120e3) {
      location.reload();
    }
  }

  window.DD = {
    wake() { loadWeather(); render(true); runFaceScan(); },
    renderDevice,
    refresh() { render(true); },
    reload: loadTasks,
    config: CONFIG,
    focus: setFocus,
    scan: () => runFaceScan({ manual: true }),
  };

  Fully.init();
  store.prune();
  applyFaceUI();
  // 顔認識が有効なら、最初のスキャンが速くなるよう裏でモデルを読み込む
  if (faceEnabled() && window.FaceID) {
    setTimeout(() => FaceID.preload().catch((e) => console.warn('[face]', e)), 3000);
  }
  render(true);
  loadTasks();
  loadWeather();
  setInterval(tick, 1000);
  setInterval(loadTasks, CONFIG.tasksRefreshMin * 60e3);
  setInterval(loadWeather, CONFIG.weatherRefreshMin * 60e3);
  setInterval(burnInShift, 60e3);
  // オフライン復帰時に再取得
  window.addEventListener('online', () => { loadTasks(); loadWeather(); });
})();
