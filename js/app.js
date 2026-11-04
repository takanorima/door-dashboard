/* =========================================================
 * Door Dashboard — app.js
 * 玄関ドア内側 Android タブレット (Fully Kiosk Browser) 用
 * バックエンドなし / GitHub Pages 静的ホスト前提
 * ========================================================= */
(() => {
  'use strict';

  // ---------- 設定（URLパラメータで上書き可） ----------
  const params = new URLSearchParams(location.search);
  // デプロイ時に commit の短いハッシュが入る（ローカルでは dev）。画面右下に出す
  const BUILD = document.querySelector('meta[name="build"]')?.content || 'dev';

  const CONFIG = {
    // 天気（Open-Meteo / APIキー不要）。既定は厚木市付近
    lat: parseFloat(params.get('lat') ?? '35.4428'),
    lon: parseFloat(params.get('lon') ?? '139.3625'),
    locationName: params.get('loc') ?? '厚木',
    tasksUrl: 'data/tasks.json',
    tasksRefreshMin: 10,      // tasks.json 再取得間隔（Git push の反映）
    weatherRefreshMin: 30,
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
    dinnerMember: 'kid1',     // 夕ごはんの予定（gas/）を出す子
    dinnerRefreshMin: 5,
    dinnerAskStart: 5,        // 当日朝の確認ボタンを出す時間帯
    dinnerAskEnd: 10,
  };

  // デバッグ用：?now=2026-11-02T07:30 で時刻を固定オフセット
  const timeOffset = params.get('now') ? new Date(params.get('now')).getTime() - Date.now() : 0;
  const now = () => new Date(Date.now() + timeOffset);
  // 試し表示：?ui=next を付けたときだけ新しい見た目にする（本番の画面を変えずに実機で確かめるため）
  const UI_NEXT = params.get('ui') === 'next';
  if (UI_NEXT) document.documentElement.classList.add('ui-next');
  // スマホ用：?kid=kid1（または ?kid=さわ）でその子の列だけを見る。チェックは玄関のタブレットだけ（端末間で共有できないため）
  const KID_VIEW = params.get('kid');
  if (KID_VIEW) document.documentElement.classList.add('phone');

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
  let dinner = null; // gas/ の Apps Script が返す夕ごはんの予定（今日から14日分）
  let lastTouch = 0; // 最後に画面を触った時刻
  // 試し表示：区切り（おきたら等）ごとの完了。終わった直後は少し見せてから1行にたたむ
  const groupJustDone = {}; // `${member}|${category}` → 完了した時刻
  const groupOpen = new Set(); // たたんだ区切りを開いているもの
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
      this.call('bind', 'screenOn', 'window.DD && window.DD.screenOn()');
      this.call('bind', 'screenOff', 'window.DD && window.DD.log("画面OFF")');
      // onMotion は人が動くたびに何度も来るので、間引いてから起こす（DD.motion）
      this.call('bind', 'onMotion', 'window.DD && window.DD.motion()');
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

  /**
   * 積み残し：時間帯が終わっても、categories[].carry_until 時までは「やっていないもの」だけ出し続ける
   * （おきたら → でかけるまえ の間、かえったら → ねるまで の間）。
   */
  function carryOccurrence(r, t, memberId) {
    const until = data.categories?.[r.category]?.carry_until;
    const h = t.getHours();
    if (until == null || r.start_hour >= r.end_hour || h < r.end_hour || h >= until) return null;
    if (!(r.days ?? [0, 1, 2, 3, 4, 5, 6]).includes(t.getDay())) return null;
    const occDate = ymd(t);
    const v = store.get(occDate)[doneKey(memberId, r.id)];
    // 済んだものは消す。ただし今チェックしたものは、触っている最中に消えると押し間違えるので、
    // 最後に触ってから30秒は残す（前に済ませたものまで戻ってこないよう、チェックから2分以内に限る）
    const recent = typeof v === 'number' && Date.now() - v < 120e3 && Date.now() - lastTouch < 30e3;
    if (v && !recent) return null;
    const end = new Date(t);
    end.setHours(until, 0, 0, 0);
    return { occDate, endsAt: end, carry: true };
  }

  function activeTasks(t, memberId) {
    const mine = (r) => assignees(r).includes(memberId);
    const routines = data.routines.filter(mine)
      .map((r) => ({ r, occ: occurrence(r, t) ?? carryOccurrence(r, t, memberId) }));
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
    let list = activeTasks(t, member.id);
    // 試し表示：時間帯（おきたら／でかけるまえ／かえったら／ねるまで）ごとにまとめ、2つ以上あれば小見出しを付ける
    const catOrder = Object.keys(data.categories ?? {});
    const catIdx = (r) => catOrder.indexOf(r.category); // 単発TODO（category なし）は -1 で先頭
    const grouped = UI_NEXT && new Set(list.map(({ r }) => r.category)).size > 1;
    if (grouped) list = [...list].sort((a, b) => catIdx(a.r) - catIdx(b.r));
    const col = el('section', 'col');
    col.dataset.member = member.id;
    col.style.setProperty('--c', member.color || 'var(--info)');
    if (focusMember) col.classList.add(focusMember === member.id ? 'focused' : 'collapsed');

    const outs = todaysOutings(t, member.id);
    const dn = member.id === CONFIG.dinnerMember ? dinnerToday(t) : null;
    if (outs.length || dn) {
      const ob = el('div', 'col-outings');
      for (const o of outs) {
        const chip = el('span', 'outing');
        if (o.time) chip.append(el('span', 'outing-time', o.time));
        chip.append(document.createTextNode(`${o.icon ?? '🚪'} ${o.titles?.[member.id] ?? o.title}`));
        ob.append(chip);
      }
      if (dn) {
        const s = dinner.statuses[dn.status];
        ob.append(el('span', 'outing dinner-chip', `${s.icon} ${s.label}`));
      }
      col.append(ob);
    }
    if (dn && !dn.confirmedAt && t.getHours() >= CONFIG.dinnerAskStart && t.getHours() < CONFIG.dinnerAskEnd) {
      col.append(renderDinnerAsk(dn));
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
    const cache = {};
    let lastCat;
    let collapsed = false;
    const isDoneOf = ({ r, occ }) => !!(cache[occ.occDate] ??= store.get(occ.occDate))[doneKey(member.id, r.id)];
    const done = list.filter(isDoneOf).length; // たたんだ区切りの分も数える
    for (const { r, occ } of list) {
      if (grouped && r.category && r.category !== lastCat) {
        const c = data.categories[r.category];
        const items = list.filter((x) => x.r.category === r.category);
        const n = items.filter(isDoneOf).length;
        const key = `${member.id}|${r.category}`;
        const complete = n === items.length;
        // 終わった区切りは1行にたたむ（完了した直後の数秒と、タップで開いたときは中身を見せる）
        const fresh = Date.now() - (groupJustDone[key] ?? 0) < 2800;
        collapsed = complete && !fresh && !groupOpen.has(key);
        const head = el('li', 'task-group' + (complete ? ' complete' : ''));
        head.dataset.group = key;
        const carry = items.some((x) => x.occ.carry);
        head.append(el('span', 'group-label', `${c?.icon ?? ''} ${c?.label ?? r.category}${carry ? 'のこり' : ''}`.trim()),
          el('span', 'group-count', complete ? '✓ できた！' : `${n}/${items.length}`));
        ul.append(head);
      }
      lastCat = r.category;
      if (grouped && collapsed) continue;
      const map = (cache[occ.occDate] ??= store.get(occ.occDate));
      const isDone = !!map[doneKey(member.id, r.id)];

      const li = el('li', 'task' + (isDone ? ' done' : ''));
      li.dataset.member = member.id;
      li.dataset.id = r.id;
      li.dataset.occ = occ.occDate;
      li.append(el('div', 'check', '✓'));

      const body = el('div', 'task-body');
      // titles.<memberId> があればその子向けの表記（kid3 は小3までの漢字）
      body.append(el('div', 'task-title', (occ.prefix ?? '') + (r.titles?.[member.id] ?? r.title)));
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
      fitTitles(col);
      for (const cls of levels) {
        if (list.scrollHeight <= list.clientHeight + 2) break;
        col.classList.add(cls);
        fitTitles(col);
      }
    });
  }

  // 少しだけはみ出して2行になるタスク名は、文字を最大2割まで小さくして1行に収める。
  // それでも収まらない長い文はそのまま折り返す
  function fitTitles(col) {
    for (const t of col.querySelectorAll('.task-title')) {
      t.style.fontSize = '';
      const base = parseFloat(getComputedStyle(t).fontSize);
      const oneLine = (px) => t.offsetHeight < px * 1.6;
      if (oneLine(base)) continue;
      const k = [0.94, 0.88, 0.82].find((x) => { t.style.fontSize = `${base * x}px`; return oneLine(base * x); });
      if (!k) t.style.fontSize = '';
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(autoFit));

  function renderTasks(t) {
    const members = (data.members ?? []).filter((m) =>
      !KID_VIEW || m.id === KID_VIEW || m.name === KID_VIEW || (m.aliases ?? []).includes(KID_VIEW));
    const cols = $('columns');
    if (focusMember && !members.some((m) => m.id === focusMember)) focusMember = null;
    cols.style.gridTemplateColumns = focusMember
      ? members.map((m) => (m.id === focusMember ? '1fr' : 'clamp(90px, 9vw, 140px)')).join(' ')
      : `repeat(${Math.max(members.length, 1)}, 1fr)`;
    cols.classList.toggle('focusing', !!focusMember);
    cols.replaceChildren(...members.map((m) => renderColumn(m, t)));
    if (KID_VIEW) cols.append(el('p', 'phone-note', '✋ チェックは玄関のタブレットでしてね'));
    else requestAnimationFrame(autoFit); // スマホはスクロールできるので詰めない

    // 見出し：いま有効なカテゴリ名
    const cats = [...new Set(data.routines.filter((r) => occurrence(r, t)).map((r) => r.category))];
    const c = cats.length === 1 ? data.categories?.[cats[0]] : null;
    $('now-title').textContent = c ? `${c.icon ?? ''} ${c.label}`.trim() : 'いまやること';
  }

  // アラート欄はやめた（リストが押し下げられるため）。ゴミの日は各自のタスクにあるので出さない。
  // 傘は天気の横、バッテリー低下とデータ読み込み失敗は画面下の赤字に出す
  function renderAlerts() {
    const warns = [];
    if (Fully.available) {
      const lv = Number(Fully.battery());
      if (Number.isFinite(lv) && lv <= CONFIG.batteryWarnLevel && !Fully.plugged()) warns.push(`⚠️ バッテリー低下 ${lv}%`);
    }
    if (dataError) warns.push('⚠️ タスクデータを読み込めません（前回のデータを表示中）');
    $('status-warn').textContent = warns.join('　');

    // 傘：この先12時間の降水確率で「いる／いらない」（夜は翌朝の登校まで見える）
    $('wx-umb').hidden = !weather;
    if (weather) {
      const need = weather.popAhead >= CONFIG.rainAlertPop;
      $('wx-umb-icon').textContent = need ? '☂️' : '🌂';
      $('wx-umb-label').textContent = need ? 'かさ いる' : 'かさ いらない';
      $('wx-umb').classList.toggle('need', need);
    }
  }

  function renderWeather() {
    if (!weather) return;
    $('wx-icon').textContent = weather.icon;
    $('wx-temp').textContent = `${Math.round(weather.temp)}°`;
    const w = wearAdvice(weather.feels);
    $('wx-wear').hidden = !w;
    if (w) {
      $('wx-wear-icon').textContent = w.icon;
      $('wx-wear-label').textContent = w.label;
    }
    // 気温の右に 最高／最低 を縦に並べる（地名と降水確率は出さない。傘は「いる／いらない」で出す）
    $('wx-sub').innerHTML =
      `<span class="hi">${Math.round(weather.max)}°</span><span class="lo">${Math.round(weather.min)}°</span>`;
  }

  function renderDevice() {
    const parts = [];
    if (Fully.available) {
      const b = Fully.battery();
      if (b != null) parts.push(`🔋${b}%${Fully.plugged() ? '⚡' : ''}`);
    }
    parts.push(`v${BUILD}`);
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
    applyBrightness();
  }

  // 明るさ・自動消灯は設定画面で決めて、このタブレットに保存する（読み込み直しても戻らない）
  const savedNum = (k, def) => { try { const v = localStorage.getItem(k); return v == null || v === '' ? def : Number(v); } catch { return def; } };
  const dayBrightness = () => savedNum('dd:brightness', CONFIG.dayBrightness);
  const idleOffMin = () => savedNum('dd:idle-off-min', 5);
  function applyBrightness() {
    const b = dayBrightness();
    Fully.setBrightness(nightState ? Math.min(CONFIG.nightBrightness, b) : b);
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

  // 体感温度（日中の平均）→ 服装の目安。かんも読めるよう小3までの漢字で
  function wearAdvice(feels) {
    if (feels == null) return null;
    if (feels >= 25) return { icon: '👕', label: '半そで' };
    if (feels >= 19) return { icon: '👚', label: '長そで' };
    if (feels >= 14) return { icon: '🥼', label: 'うすいうわぎ' };
    if (feels >= 8) return { icon: '🧥', label: 'コート' };
    if (feels >= 3) return { icon: '🧥🧣', label: 'コート・マフラー' };
    return { icon: '🧥🧣🧤', label: 'てぶくろも' };
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
      + '&hourly=precipitation_probability,apparent_temperature'
      + '&timezone=Asia%2FTokyo&forecast_days=2';
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      // 現在から12時間以内の最大降水確率
      const nowMs = now().getTime();
      let popAhead = 0;
      const today = ymd(now());
      const feels = [];
      j.hourly.time.forEach((ts, i) => {
        // 服装の目安：今日の 7〜17時（外にいる時間）の体感温度の平均
        const hh = Number(ts.slice(11, 13));
        if (ts.startsWith(today) && hh >= 7 && hh <= 17) feels.push(j.hourly.apparent_temperature[i]);
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
        feels: feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : null,
      };
      renderWeather();
      render(true);
    } catch (e) {
      console.warn('[weather]', e);
      if (!weather) $('wx-sub').textContent = '天気×';
    }
  }

  // ---------- エラー表示（実機で原因を追えるよう、画面下に出す） ----------
  function showError(where, e) {
    const t = new Date();
    const msg = `⚠️ ${where}: ${e?.message ?? e} (${pad(t.getHours())}:${pad(t.getMinutes())})`;
    console.error('[DD]', where, e);
    const box = $('status-error');
    if (box) box.textContent = msg;
    diag(`${where}: ${e?.message ?? e}`);
  }
  window.addEventListener('error', (ev) => showError('error', ev.error ?? ev.message));

  // ---------- 診断ログ（画面が止まる件の切り分け用。設定画面の一番下に出る） ----------
  function diag(ev) {
    const t = new Date();
    const line = `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${ev}`;
    try {
      const arr = JSON.parse(localStorage.getItem('dd:diag') || '[]');
      arr.push(line);
      localStorage.setItem('dd:diag', JSON.stringify(arr.slice(-60)));
    } catch {}
  }
  diag(`起動 v${BUILD}${typeof window.fully !== 'undefined' ? '' : '（Fullyなし）'}`);
  document.addEventListener('visibilitychange', () => diag(`visibility ${document.visibilityState}`));
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
    if (KID_VIEW) return; // スマホでは見るだけ
    const col = ev.target.closest('.col');
    if (!col) return;
    // 畳まれた列 or 列の見出しをタップ → その子にズーム（ズーム中の見出しなら解除）
    if (col.classList.contains('collapsed')) return setFocus(col.dataset.member);
    const db = ev.target.closest('[data-dinner]');
    if (db) return pickDinner(db.dataset.dinner, db.closest('.dinner-ask'));
    if (ev.target.closest('.col-head')) {
      return setFocus(focusMember === col.dataset.member ? null : col.dataset.member);
    }
    // たたんだ区切りをタップ → 開く／閉じる
    const gh = ev.target.closest('.task-group.complete');
    if (gh) {
      const key = gh.dataset.group;
      if (groupOpen.has(key)) groupOpen.delete(key); else groupOpen.add(key);
      return render(true);
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
      const group = m[k] && !finished ? completedGroup(member, id, now()) : null;
      if (group) groupJustDone[`${member}|${group.id}`] = Date.now();
      if (focusMember) armFocusTimer();
      render(true);
      if (finished) {
        celebrate(member);
        maybeNotifyComplete(member, finished);
      } else if (group) {
        celebrate(member, `🎉 ${group.label} できた！`);
        setTimeout(() => render(true), 3000); // 見せ終わったら1行にたたむ
      }
    } catch (e) {
      showError('check', e);
    }
  });

  // ---------- 夕ごはんの予定（gas/ の Apps Script） ----------
  // URL は公開リポジトリに置かず、このタブレットの localStorage にだけ持つ
  const dinnerUrl = () => { try { return (localStorage.getItem('dd:dinner-url') || '').trim(); } catch { return ''; } };
  const dinnerToday = (t) => dinner?.days?.find((d) => d.date === ymd(t)) ?? null;

  async function loadDinner() {
    const url = dinnerUrl();
    if (!url) return false;
    try {
      const res = await fetch(`${url}?api=list&t=${Date.now()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!Array.isArray(json.days)) throw new Error(json.error || 'invalid');
      dinner = json;
      // 操作中は作り直さない（押した瞬間に項目が入れ替わるとタップが消える）
      if (Date.now() - lastTouch > 10e3) render(true);
      return true;
    } catch (e) {
      console.warn('[dinner]', e);
      return false;
    }
  }

  function renderDinnerAsk(dn) {
    const box = el('div', 'dinner-ask');
    box.append(el('div', 'dinner-ask-title', '🍽️ きょうの夕ごはん'));
    const row = el('div', 'dinner-ask-btns');
    for (const [k, s] of Object.entries(dinner.statuses)) {
      if (s.beforeDeadlineOnly) continue; // 「まだわからない」は当日には選べない
      const b = el('button', 'dinner-btn' + (k === dn.status ? ' on' : ''));
      b.append(el('span', 'dinner-btn-icon', s.icon), el('span', 'dinner-btn-label', s.label));
      b.dataset.dinner = k;
      row.append(b);
    }
    box.append(row);
    box.append(el('div', 'dinner-ask-msg', dn.late ? 'いまのままなら、光っているのを押す' : ''));
    return box;
  }

  // 当日朝のダメ押し確認：今のままを押せば「確認」、ちがうのを押せば変更（しめきり後なので ⚠️ で通知される）
  async function pickDinner(status, box) {
    const dn = dinnerToday(now());
    if (!dn || box?.classList.contains('busy')) return;
    box?.classList.add('busy');
    const msg = box?.querySelector('.dinner-ask-msg');
    if (msg) msg.textContent = '⏳ 送信中…';
    try {
      // text/plain で送る＝プリフライトなしの単純リクエスト
      const res = await fetch(dinnerUrl(), { method: 'POST', body: JSON.stringify({ date: dn.date, status, confirm: true }) });
      const json = await res.json();
      if (!Array.isArray(json.days)) throw new Error(json.error || 'invalid');
      dinner = json;
      const s = dinner.statuses[status];
      toast(`${s.icon} 夕ごはん ${s.label}（たさんに送った）`, 'var(--c)');
      render(true);
    } catch (e) {
      console.warn('[dinner]', e);
      box?.classList.remove('busy');
      if (msg) msg.textContent = '⚠️ 送れなかった。もう一度押してね';
    }
  }

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

  // 試し表示：いま付けたチェックで、その区切り（おきたら等）が全部終わったか。ほかの区切りも同時に出ているときだけ
  function completedGroup(memberId, routineId, t) {
    if (!UI_NEXT) return null;
    const list = activeTasks(t, memberId);
    const cat = list.find(({ r }) => r.id === routineId)?.r.category;
    if (!cat || new Set(list.map(({ r }) => r.category)).size < 2) return null;
    const items = list.filter(({ r }) => r.category === cat);
    const ok = items.every(({ r, occ }) => !!store.get(occ.occDate)[doneKey(memberId, r.id)]);
    return ok ? { id: cat, label: data.categories?.[cat]?.label ?? cat } : null;
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
  function celebrate(memberId, title = '🎉 ぜんぶできた！') {
    const m = (data.members ?? []).find((x) => x.id === memberId);
    const col = document.querySelector(`.col[data-member="${memberId}"]`);
    const rect = col?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const layer = el('div', 'celebrate');
    layer.style.setProperty('--c', m?.color || 'var(--amber)');

    // 紙吹雪：列の上部から打ち上げて、重力で落とす
    const colors = [m?.color, ...CONFETTI_COLORS].filter(Boolean);
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height * 0.3;
    for (let i = 0; i < 36; i++) {
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
    msg.append(el('div', 'celebrate-big', title), el('div', 'celebrate-name', `${m?.icon ?? ''} ${m?.name ?? ''}`));
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
  let pressAt = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressAt = null; };
  // Android は指を置いたままにすると長押しジェスチャーとして pointercancel を出すので、
  // それでは取り消さない。止めるのは「指を離した」「指が動いた」ときだけ
  clockEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  clockEl.addEventListener('pointerdown', (e) => {
    pressAt = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressAt = null; openSettings(); }, CONFIG.longPressMs);
  });
  clockEl.addEventListener('pointermove', (e) => {
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 30) cancelPress();
  });
  clockEl.addEventListener('pointerup', cancelPress);
  clockEl.addEventListener('touchend', cancelPress);
  // 長押しで WebView のメニューや選択状態に入らないよう、ページ全体で止める（設定の入力欄は貼り付けできるよう除く）
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });

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
    $('bright').value = dayBrightness();
    $('bright-val').textContent = dayBrightness();
    $('idle-off').value = String(idleOffMin());
    $('dinner-url').value = dinnerUrl();
    $('dinner-msg').textContent = '';
    renderEnrollList();
    try { $('diag-log').textContent = JSON.parse(localStorage.getItem('dd:diag') || '[]').reverse().join('\n') || '（なし）'; } catch {}
    $('settings').hidden = false;
  }
  $('bright').addEventListener('input', (e) => {
    try { localStorage.setItem('dd:brightness', e.target.value); } catch {}
    $('bright-val').textContent = e.target.value;
    Fully.setBrightness(Number(e.target.value)); // 動かしながら確かめられるよう、夜でもその値で一度点ける
  });
  $('idle-off').addEventListener('change', (e) => {
    try { localStorage.setItem('dd:idle-off-min', e.target.value); } catch {}
  });
  $('settings-close').addEventListener('click', () => {
    applyBrightness();
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
  $('dinner-test').addEventListener('click', async () => {
    try { localStorage.setItem('dd:dinner-url', $('dinner-url').value.trim()); } catch {}
    $('dinner-msg').textContent = '⏳ 読み込み中…';
    const ok = await loadDinner();
    const d = dinnerToday(now());
    $('dinner-msg').textContent = ok && d
      ? `✅ 今日：${dinner.statuses[d.status].label}${d.confirmedAt ? '（朝の確認ずみ）' : ''}／今月のしめきり後の変更 ${dinner.lateCount}回`
      : '⚠️ 読めませんでした（URL・デプロイ設定を確認）';
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
  let lastTickAt = Date.now();
  function tick() {
    const t = now();
    // JS が止まっていた時間を記録（時計が止まる症状の切り分け用）
    const gap = Date.now() - lastTickAt;
    lastTickAt = Date.now();
    if (gap > 3000 && document.visibilityState === 'visible') {
      const scanning = window.FaceID?.isScanning?.() ? '・顔スキャン中' : '';
      const sinceWake = lastWake ? Math.round((Date.now() - lastWake) / 1000) : -1;
      showError('freeze', `JS停止 ${Math.round(gap / 1000)}秒（起床から${sinceWake}秒${scanning}）`);
    }
    watchFrames();
    idleScreenOff();
    render();
    // 日付が変わったら古いチェック状態を掃除
    if (ymd(t) !== lastDay) { lastDay = ymd(t); store.prune(); }
    // 毎日決まった時刻にリロード（長時間稼働対策）
    if (t.getHours() === CONFIG.dailyReloadHour && t.getMinutes() === 0 && t.getSeconds() < 2
        && performance.now() > 120e3) {
      location.reload();
    }
  }

  // 毎秒1回だけ次のフレームを頼み、3秒以上来なければ記録する（触らなくても止まっているかが分かる）
  let frameAskedAt = 0;
  let frameStalled = false;
  function watchFrames() {
    if (!frameAskedAt) {
      frameAskedAt = Date.now();
      requestAnimationFrame(() => {
        if (frameStalled) diag(`描画再開（${Math.round((Date.now() - frameAskedAt) / 1000)}秒ぶり）`);
        frameAskedAt = 0;
        frameStalled = false;
      });
      return;
    }
    const screenOn = Fully.available ? Fully.call('getScreenOn') !== false : true;
    if (!frameStalled && Date.now() - frameAskedAt > 3000 && document.visibilityState === 'visible' && screenOn) {
      frameStalled = true;
      diag('フレームが3秒来ない（JSは動いている）');
      // 触らずに見ているだけでも時計が止まるので、画面が確実に点いているときは自動で点け直す（5分に1回まで）
      if (Fully.call('getScreenOn') === true && Date.now() - lastRecover > 5 * 60e3) {
        diag('自動で画面OFF→ON（定期監視）');
        lastRecover = Date.now();
        Fully.screenOff();
        setTimeout(() => Fully.call('turnScreenOn'), 1200);
      }
    }
  }

  // 触られず・動きもない時間が続いたら画面を消す（点けるのは Fully の動体検知）
  let lastMotion = 0;
  function idleScreenOff() {
    const min = idleOffMin();
    if (!Fully.available || !min || !$('settings').hidden) return;
    const idleFor = Date.now() - Math.max(lastTouch, lastMotion, lastWake, bootAt);
    if (idleFor < min * 60e3 || Fully.call('getScreenOn') !== true) return;
    diag(`無操作${min}分で画面OFF`);
    lastWake = Date.now(); // 続けて何度も消しにいかないように
    Fully.screenOff();
  }
  const bootAt = Date.now();

  // ---------- 描画停止の検知（Android WebView 対策） ----------
  // 触ったのに次のフレームが描かれなければ「描画が止まった」とみなし、
  // Fully なら画面を一度消して点け直す（手動の画面OFF→ONで直る症状への自動対処）
  let paintCheckPending = false;
  let lastWake = 0;
  let lastWeatherWake = 0;
  let lastRecover = 0;
  document.addEventListener('pointerdown', () => {
    // 復旧直後は見ない（画面ON直後も見る：止まるのはそこが多い見立て）
    if (paintCheckPending || Date.now() - lastRecover < 60e3) return;
    paintCheckPending = true;
    let painted = false;
    requestAnimationFrame(() => { painted = true; });
    setTimeout(() => {
      paintCheckPending = false;
      if (painted || document.visibilityState !== 'visible') return;
      let n = 0;
      try { n = Number(localStorage.getItem('dd:stalls') || 0) + 1; localStorage.setItem('dd:stalls', String(n)); } catch {}
      showError('stall', `描画停止を検知（累計${n}回）`);
      if (Fully.available) {
        diag('自動で画面OFF→ON');
        lastRecover = Date.now();
        Fully.screenOff();
        setTimeout(() => Fully.call('turnScreenOn'), 1200);
      }
    }, 2000);
  }, true);

  // ---------- 新しい版の自動読み込み ----------
  // version.json の build が変わったら、URL に ?b= を付けて読み直す（URL が変わるのでキャッシュを通らない）
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);
  async function checkUpdate() {
    if (BUILD === 'dev') return;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { build } = await res.json();
      if (!build || build === BUILD) return;
      // 操作中・設定中は避ける
      if (Date.now() - lastTouch < 30e3 || !$('settings').hidden) return;
      const u = new URL(location.href);
      u.searchParams.set('b', build);
      location.replace(u.toString());
    } catch (e) {
      console.warn('[update]', e);
    }
  }

  window.DD = {
    log: diag,
    screenOn() {
      diag('画面ON');
      window.DD.wake();
    },
    wake() {
      lastWake = Date.now();
      // 操作中は作り直さない（押した瞬間に項目が入れ替わるとタップが消える）
      if (Date.now() - lastTouch > 10e3) render(true);
      if (Date.now() - lastWeatherWake > 5 * 60e3) { lastWeatherWake = Date.now(); loadWeather(); loadDinner(); }
      runFaceScan();
    },
    motion() {
      lastMotion = Date.now();
      if (Date.now() - lastWake < 60e3) return;
      diag('動体検知で起床');
      window.DD.wake();
    },
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
  loadDinner();
  setInterval(tick, 1000);
  setInterval(loadDinner, CONFIG.dinnerRefreshMin * 60e3);
  setInterval(loadTasks, CONFIG.tasksRefreshMin * 60e3);
  setInterval(loadWeather, CONFIG.weatherRefreshMin * 60e3);
  setInterval(burnInShift, 60e3);
  setInterval(checkUpdate, 60e3);
  // オフライン復帰時に再取得
  window.addEventListener('online', () => { loadTasks(); loadWeather(); });
})();
