#!/usr/bin/env python3
"""
GitHub Issue → data/tasks.json に反映する。

2つの書き方に対応:
  1) Issueフォーム（.github/ISSUE_TEMPLATE/task.yml）
  2) タイトル1行のクイック入力
       + 11/5 茶和子 体操服        … 単発TODOを追加（日付省略時は「明日」、担当省略時は全員）
       + 明日 花乃子 寛成 集金袋
       - 体操服                     … タイトルに「体操服」を含む項目を削除

環境変数: ISSUE_TITLE, ISSUE_BODY, ISSUE_NUMBER, ISSUE_CREATED_AT, TASKS_PATH(任意)
結果は GITHUB_OUTPUT に  result=added|deleted|skip|error / message=... を書く。
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
TASKS_PATH = os.environ.get("TASKS_PATH", "data/tasks.json")
DOW_JA = "月火水木金土日"  # Python weekday(): 月=0
KEEP_PAST_DAYS = 2  # 過去の単発TODOは何日残すか

TIME_SLOTS = {
    "一日中": (5, 23),
    "朝": (5, 10),
    "夕方": (15, 23),
    "夜": (19, 2),
}


# 学年別漢字配当表（小1・小2）。members の kanji_grade: 2 の子には、これ以外の漢字を使うと注意を返す
KANJI_UPTO_G2 = set(
    "一右雨円王音下火花貝学気九休玉金空月犬見五口校左三山子四糸字耳七車手十出女小上森人水正生青夕石赤千"
    "川先早草足村大男竹中虫町天田土二日入年白八百文木本名目立力林六"
    "引羽雲園遠何科夏家歌画回会海絵外角楽活間丸岩顔汽記帰弓牛魚京強教近兄形計元言原戸古午後語工公広交光"
    "考行高黄合谷国黒今才細作算止市矢姉思紙寺自時室社弱首秋週春書少場色食心新親図数西声星晴切雪船線前組"
    "走多太体台地池知茶昼長鳥朝直通弟店点電刀冬当東答頭同道読内南肉馬売買麦半番父風分聞米歩母方北毎妹万"
    "明鳴毛門夜野友用曜来里理話"
)


class InputError(Exception):
    pass


# ---------- 入出力 ----------
def dump_json(obj, indent=0) -> str:
    """indent=2 で整形しつつ、数値・文字列だけの配列は1行に収める。"""
    pad, pad1 = "  " * indent, "  " * (indent + 1)
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        items = [f'{pad1}{json.dumps(k, ensure_ascii=False)}: {dump_json(v, indent + 1)}' for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list):
        if all(not isinstance(x, (dict, list)) for x in obj):
            return "[" + ", ".join(json.dumps(x, ensure_ascii=False) for x in obj) + "]"
        return "[\n" + ",\n".join(pad1 + dump_json(x, indent + 1) for x in obj) + "\n" + pad + "]"
    return json.dumps(obj, ensure_ascii=False)


def load_tasks() -> dict:
    with open(TASKS_PATH, encoding="utf-8") as f:
        d = json.load(f)
    d.setdefault("todos", [])
    return d


def save_tasks(d: dict) -> None:
    with open(TASKS_PATH, "w", encoding="utf-8") as f:
        f.write(dump_json(d) + "\n")


def output(result: str, message: str) -> None:
    print(f"[{result}] {message}")
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"result={result}\n")
            f.write("message<<__EOF__\n" + message + "\n__EOF__\n")


# ---------- 解析 ----------
def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def base_today() -> date:
    raw = os.environ.get("ISSUE_CREATED_AT")
    if raw:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(JST).date()
    return datetime.now(JST).date()


DATE_LIKE = re.compile(r"^(\d{1,4}[-/.年月]\d|\d{1,2}日$)")


def parse_date(text: str, today: date) -> date | None:
    try:
        return _parse_date(text, today)
    except ValueError:  # 13/45 など存在しない日付
        return None


def _parse_date(text: str, today: date) -> date | None:
    t = norm(text)
    if not t:
        return None
    rel = {"今日": 0, "きょう": 0, "明日": 1, "あした": 1, "あす": 1, "明後日": 2, "あさって": 2}
    if t in rel:
        return today + timedelta(days=rel[t])
    m = re.fullmatch(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", t)
    if m:
        return date(*map(int, m.groups()))
    m = re.fullmatch(r"(\d{1,2})[/月](\d{1,2})日?", t)
    if m:
        mo, d = map(int, m.groups())
        cand = date(today.year, mo, d)
        if cand < today - timedelta(days=1):  # 過ぎていれば来年
            cand = date(today.year + 1, mo, d)
        return cand
    m = re.fullmatch(r"(\d{1,2})日", t)
    if m:
        d = int(m.group(1))
        cand = date(today.year, today.month, d)
        if cand < today:
            nm = (today.replace(day=1) + timedelta(days=32)).replace(day=1)
            cand = nm.replace(day=d)
        return cand
    m = re.fullmatch(r"(来週の?)?([月火水木金土日])(曜日?)?", t)
    if m:
        target = DOW_JA.index(m.group(2))
        delta = (target - today.weekday()) % 7
        if m.group(1):
            delta = delta + 7 if delta else 7
        return today + timedelta(days=delta)
    return None


def member_lookup(d: dict) -> dict[str, str]:
    """名前・アイコン・id → member id"""
    lut = {}
    for m in d.get("members", []):
        for key in (m["id"], m.get("name"), m.get("icon")):
            if key:
                lut[norm(key)] = m["id"]
    return lut


def parse_form(body: str) -> dict[str, str]:
    """Issueフォームの本文（### 見出し + 値）を dict に。"""
    sections, cur = {}, None
    for line in body.splitlines():
        h = re.match(r"^###\s+(.+?)\s*$", line)
        if h:
            cur = norm(h.group(1))
            sections[cur] = []
        elif cur is not None:
            sections[cur].append(line)
    out = {}
    for k, lines in sections.items():
        v = "\n".join(lines).strip()
        out[k] = "" if v in ("_No response_", "None") else v
    return out


def checked(value: str) -> list[str]:
    return [norm(m) for m in re.findall(r"^- \[[xX]\]\s*(.+)$", value, re.M)]


def section(form: dict, *prefixes: str) -> str:
    for k, v in form.items():
        if any(k.startswith(p) for p in prefixes):
            return v
    return ""


# ---------- 操作 ----------
def fmt_date(d: date) -> str:
    return f"{d.month}/{d.day}({DOW_JA[d.weekday()]})"


def names_of(d: dict, ids: list[str]) -> str:
    if ids == ["all"]:
        return "全員"
    by_id = {m["id"]: m.get("name", m["id"]) for m in d.get("members", [])}
    return "・".join(by_id.get(i, i) for i in ids)


def resolve_members(d: dict, names: list[str]) -> list[str]:
    if not names or any(n in ("全員", "みんな", "all") for n in names):
        return ["all"]
    lut = member_lookup(d)
    ids, unknown = [], []
    for n in names:
        (ids if n in lut else unknown).append(lut.get(n, n))
    if unknown:
        known = "、".join(m.get("name", m["id"]) for m in d.get("members", []))
        raise InputError(f"担当「{'、'.join(unknown)}」が見つかりません（登録済み: {known}）")
    return list(dict.fromkeys(ids))


def kanji_note(d, members, title) -> str:
    """kanji_grade: 2 の子が担当に入っていて、小3以上の漢字があれば注意文を返す"""
    ids = {m["id"] for m in d.get("members", [])} if "all" in members else set(members)
    kids = [m for m in d.get("members", []) if m["id"] in ids and m.get("kanji_grade") == 2]
    hard = "".join(dict.fromkeys(c for c in title if "\u4e00" <= c <= "\u9fff" and c not in KANJI_UPTO_G2))
    if not kids or not hard:
        return ""
    who = "・".join(m.get("name", m["id"]) for m in kids)
    return f"\n📝 {who}には むずかしい漢字があります（{'・'.join(hard)}）。ひらがなにするなら、消して入れ直してください。"


def add_todo(d, issue_no, title, when: date, members, slot="一日中", prev_evening=True, tags=None):
    if not title:
        raise InputError("やることが空です")
    s, e = TIME_SLOTS.get(slot, TIME_SLOTS["一日中"])
    if e < s:  # 夜(19→2)は単発TODOでは 19→23 に丸める
        e = 23
    todo = {
        "id": f"todo_{when.isoformat()}_{issue_no}",
        "title": title,
        "date": when.isoformat(),
        "members": members,
        "start_hour": s,
        "end_hour": e,
        "prev_evening": prev_evening,
        "tags": tags or ["予定"],
        "source": f"#{issue_no}",
    }
    d["todos"].append(todo)
    extra = "（前日17時から表示）" if prev_evening else ""
    return (f"✅ 追加しました：{fmt_date(when)} {names_of(d, members)}「{title}」 {s}〜{e}時{extra}"
            + kanji_note(d, members, title))


def add_routine(d, issue_no, title, days, members, slot, tags=None, category=None):
    if not title:
        raise InputError("やることが空です")
    if not days:
        raise InputError("ルーティンの曜日を1つ以上選んでください")
    s, e = TIME_SLOTS.get(slot, TIME_SLOTS["一日中"])
    cat = category or {"朝": "morning", "夕方": "evening", "夜": "night"}.get(slot, "evening")
    d["routines"].append({
        "id": f"r_{issue_no}",
        "title": title,
        "category": cat,
        "start_hour": s,
        "end_hour": e,
        "days": days,
        "members": members,
        "tags": tags or [],
        "source": f"#{issue_no}",
    })
    dow = "".join("日月火水木金土"[x] for x in days)
    return (f"✅ ルーティンを追加しました：毎週{dow} {names_of(d, members)}「{title}」 {s}〜{e}時"
            + kanji_note(d, members, title))


def delete_items(d, query):
    q = norm(query)
    if not q:
        raise InputError("削除するタイトル（の一部）を書いてください")
    hits = [("todos", x) for x in d["todos"] if q in norm(x["title"]) or q == x["id"]]
    hits += [("routines", x) for x in d["routines"] if q in norm(x["title"]) or q == x["id"]]
    if not hits:
        raise InputError(f"「{q}」を含む項目はありません")
    if len(hits) > 1:
        lst = "\n".join(f"- `{x['id']}` {x['title']}" + (f"（{x['date']}）" if "date" in x else "") for _, x in hits)
        raise InputError(f"「{q}」に複数一致しました。id を指定してください：\n{lst}")
    kind, item = hits[0]
    d[kind].remove(item)
    return f"🗑️ 削除しました：「{item['title']}」"


def cleanup_old(d, today):
    limit = (today - timedelta(days=KEEP_PAST_DAYS)).isoformat()
    before = len(d["todos"])
    d["todos"] = [t for t in d["todos"] if t.get("date", "9999") >= limit]
    return before - len(d["todos"])


# ---------- 入口 ----------
def handle(title: str, body: str, issue_no: str) -> tuple[str, str]:
    d = load_tasks()
    today = base_today()
    title_n = norm(title)
    form = parse_form(body or "")
    kind = norm(section(form, "種類"))

    if kind:  # フォーム入力
        what = section(form, "やること").strip()  # タイトルは入力どおりに残す
        members = resolve_members(d, checked(section(form, "担当")))
        slot = norm(section(form, "表示する時間帯")) or "一日中"
        tags = [norm(x) for x in re.split(r"[,、\s]+", section(form, "タグ")) if norm(x)]
        if kind.startswith("削除"):
            msg, result = delete_items(d, what), "deleted"
        elif kind.startswith("毎週"):
            day_map = {c: (i + 1) % 7 for i, c in enumerate(DOW_JA)}  # 月=1 … 日=0
            days = sorted({day_map[c[0]] for c in checked(section(form, "曜日")) if c[:1] in day_map})
            msg, result = add_routine(d, issue_no, what, days, members, slot, tags), "added"
        else:
            raw = section(form, "日付")
            when = parse_date(raw, today) if raw else today + timedelta(days=1)
            if not when:
                raise InputError(f"日付「{raw}」を読み取れません（例: 11/5、明日、金曜）")
            same_day_only = bool(checked(section(form, "オプション")))
            msg = add_todo(d, issue_no, what, when, members, slot, not same_day_only, tags)
            result = "added"
    elif title_n[:1] in "+-":  # クイック入力
        op = title_n[0]
        rest = title.strip()[1:].strip()  # 元の表記（全角など）を保つ
        if op == "-":
            msg, result = delete_items(d, rest), "deleted"
        else:
            when, names, words = None, [], []
            lut = member_lookup(d)
            for tok in rest.split():  # 全角スペースでも区切れる
                n = norm(tok)
                if when is None and not words and not names and (dt := parse_date(n, today)):
                    when = dt
                elif when is None and not words and not names and DATE_LIKE.match(n):
                    raise InputError(f"日付「{tok}」を読み取れません（例: 11/5、明日、金曜）")
                elif not words and (n in lut or n in ("全員", "みんな")):
                    names.append(n)
                else:
                    words.append(tok)
            when = when or today + timedelta(days=1)
            msg = add_todo(d, issue_no, " ".join(words), when, resolve_members(d, names))
            result = "added"
    else:
        return "skip", "タスク追加用のIssueではありません"

    removed = cleanup_old(d, today)
    if removed:
        msg += f"\n（過去の単発TODOを {removed} 件整理しました）"
    save_tasks(d)
    return result, msg


def main() -> int:
    try:
        result, msg = handle(
            os.environ.get("ISSUE_TITLE", ""),
            os.environ.get("ISSUE_BODY", ""),
            os.environ.get("ISSUE_NUMBER", "0"),
        )
    except InputError as e:
        output("error", f"⚠️ {e}")
        return 0
    output(result, msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
