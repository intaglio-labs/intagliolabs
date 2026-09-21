#!/usr/bin/env python3
"""Head-to-head on the owner's judged cards: Laya (local MLX) vs Jev (hosted), same compact state.

Read-only on the corpus. Prints numbers only: no name, no line, no quote.
Run by hand from a venv with laya-mlx installed:
  python ui/scripts/eval-laya.py                 # both engines, compact state
  python ui/scripts/eval-laya.py --laya-only
Why compact: Laya's English checkpoint reads 512 tokens (multilingual 1024) including the questions,
so the full personState (~1.3k tokens) cannot be sent as-is. The same compact state goes to both
engines, so the comparison is fair; Jev's full-state number (0.72 AUC on this set) is the ceiling
it loses by being fed less.
"""
import json, os, sqlite3, sys, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser('~')
DB = os.path.join(HOME, '.hazlie/context/context.db')
KEY_PATH = os.path.join(HOME, '.hazlie/secrets/typesafe-api-key.txt')
LAYA_ONLY = '--laya-only' in sys.argv
MODEL = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--model=')), 'aac6fef/laya-mlx')
NOW = time.time() * 1000
DAY = 86_400_000

def ago(ms):
    if not ms: return 'never'
    d = (NOW - ms) / DAY
    for lim, w in [(14, 'within two weeks'), (45, 'about a month ago'), (120, 'a few months ago'), (300, 'about half a year ago'),
                   (550, 'about a year ago'), (1000, 'about two years ago'), (1500, 'about three years ago')]:
        if d < lim: return w
    return 'four or more years ago'
def span(a, b):
    d = (b - a) / DAY
    for lim, w in [(30, 'under a month'), (365, 'under a year'), (730, 'one to two years'), (1460, 'two to four years')]:
        if d < lim: return w
    return 'four or more years'
def count(n):
    n = n or 0
    for lim, w in [(1, 'none'), (5, 'a handful'), (30, 'a couple dozen'), (200, 'well over a hundred'), (1000, 'hundreds'), (5000, 'thousands')]:
        if n < lim: return w
    return 'many thousands'
def balance(s, r):
    if (s or 0) + (r or 0) == 0: return 'no direct messages'
    f = s / (s + r)
    return 'the owner writes much more than they do' if f > 0.62 else 'they write much more than the owner does' if f < 0.38 else 'roughly even both ways'
def clip(t, n=120): return ' '.join(str(t or '').split())[:n]

db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
events = db.execute("""SELECT e.event, e.person_key FROM rm_card_event e JOIN rm_candidate_snapshot s ON s.id = e.snapshot_id
  WHERE e.event IN ('accepted','dismissed','muted') ORDER BY e.created_at""").fetchall()

def compact_state(key):
    p = db.execute('SELECT * FROM people WHERE person_key=?', (key,)).fetchone()
    if not p: return None
    cols = [c[1] for c in db.execute('PRAGMA table_info(people)')]
    p = dict(zip(cols, p))
    li = json.loads(p['linkedin']) if p.get('linkedin') else None
    mt = db.execute("""SELECT COUNT(*), MAX(c.ts) FROM person_event_links l JOIN context c ON c.id=l.context_id
        WHERE l.person_key=? AND l.source='calendar' AND l.role IN ('attendee','organizer')
        AND json_array_length(json_extract(c.meta,'$.attendees')) BETWEEN 2 AND 8""", (key,)).fetchone()
    ex = db.execute("""SELECT c.text, l.authored FROM person_event_links l JOIN context c ON c.id=l.context_id
        WHERE l.person_key=? AND l.room=0 AND (l.authored=1 OR l.owner_authored=1) ORDER BY c.ts DESC LIMIT 4""", (key,)).fetchall()[::-1]
    return {
        'professional': {'linkedin': {'title': li.get('position'), 'company': li.get('company'), 'industry': li.get('industry')} if li else 'not a LinkedIn connection'},
        'relationship': {'direct_messages': count(p['direct_messages']), 'balance': balance(p['sent'], p['received']),
                         'known_for': span(p['first_seen'], p['last_seen']), 'meetings_one_on_one': count(mt[0]), 'last_meeting': ago(mt[1] or 0)},
        'recency': {'they_last_wrote': ago(p['last_from_them'] or 0), 'owner_last_wrote': ago(p['last_from_owner'] or 0)},
        'last_exchange': [{'who': 'them' if t else 'owner', 'text': clip(x)} for x, t in ex],
    }

QUESTIONS = {
    'worth': {'type': 'noul', 'instructions': 'The owner accepts a reminder when the relationship was real (many messages or meetings over years), went quiet within roughly the last year, and a message now would be welcome; the owner dismisses reminders about people gone for years or never close. Would the owner accept a reminder to reach out to this person now?'},
    'closeness': {'type': 'score', 'instructions': 'How close are these two people?', 'criteria': ['strangers or one-off contact', 'acquaintances', 'a real but casual relationship', 'close', "very close, part of each other's lives"]},
    'professional_axis': {'type': 'score', 'instructions': 'Where does this relationship sit between purely personal and purely professional?', 'criteria': ['purely personal', 'mostly personal with some work overlap', 'evenly mixed', 'mostly professional with some personal warmth', 'purely professional']},
    'romantic': {'type': 'noul', 'instructions': 'Do the words indicate a romantic or dating relationship, current or past?'},
    'ended': {'type': 'choice', 'instructions': 'Looking at `last_exchange`, how did this conversation leave things?', 'criteria': {'warm': 'good terms', 'neutral': 'it just stopped', 'bad': 'conflict, coldness, or a pointed question left unanswered'}},
}

def jev(state):
    key = open(KEY_PATH).read().strip()
    body = json.dumps({'model': 'jev-latest', 'state': state, 'questions': QUESTIONS}).encode()
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=body, headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

rows = []
laya_ms = []
jev_ms = []
import laya_mlx as laya
agent = laya.load(MODEL)
tok_est = []
for ev, key in events:
    st = compact_state(key)
    if not st: continue
    tok_est.append(len(json.dumps(st)) // 4)
    # --prose renders the same facts as sentences: Laya is an encoder trained on
    # text states, and JSON keys may cost it more than they cost Jev.
    if '--prose' in sys.argv:
        pro = st['professional']['linkedin']
        li = f"On LinkedIn they are {pro.get('title') or 'untitled'} at {pro.get('company') or 'an unknown company'} ({pro.get('industry') or 'no industry'})." if isinstance(pro, dict) else 'They are not a LinkedIn connection.'
        rel = st['relationship']; rec = st['recency']
        text = (f"{li} They have exchanged {rel['direct_messages']} direct messages, {rel['balance']}, and have known each other for {rel['known_for']}. "
                f"They have had {rel['meetings_one_on_one']} one-on-one meetings; the last was {rel['last_meeting']}. "
                f"The other person last wrote {rec['they_last_wrote']}; the owner last wrote {rec['owner_last_wrote']}. Last exchange: "
                + ' '.join(f"[{x['who']}] {x['text']}" for x in st['last_exchange']))
        laya_state = text
    else:
        laya_state = json.dumps(st)
    t = time.time(); L = agent.predict(laya_state, QUESTIONS); laya_ms.append((time.time() - t) * 1000)
    J = None
    if not LAYA_ONLY:
        t = time.time()
        try: J = jev(st)
        except Exception as e: J = None
        jev_ms.append((time.time() - t) * 1000)
    rows.append((ev, L['answers'], J['answers'] if J else None))

def val(a, q):
    if a is None or q not in a: return None
    x = a[q]
    return x.get('noul') if 'noul' in x else x.get('score') if 'score' in x else None
def auc(getter):
    acc = [getter(r) for r in rows if r[0] == 'accepted']; rej = [getter(r) for r in rows if r[0] != 'accepted']
    acc = [x for x in acc if x is not None]; rej = [x for x in rej if x is not None]
    if not acc or not rej: return float('nan')
    w = sum(1 if a > b else 0.5 if a == b else 0 for a in acc for b in rej)
    return w / (len(acc) * len(rej))
def mean(xs): xs = [x for x in xs if x is not None]; return sum(xs) / len(xs) if xs else float('nan')
def med(xs): xs = sorted(xs); return xs[len(xs) // 2] if xs else float('nan')

print(f'# Laya vs Jev, compact state — {datetime.now().date()} — cards {len(rows)} — est tokens/card median {med(tok_est)} — model {MODEL}')
print(f'latency ms: laya median {med(laya_ms):.0f} p95 {sorted(laya_ms)[int(len(laya_ms)*0.95)-1]:.0f}' + (f' · jev median {med(jev_ms):.0f}' if jev_ms else ''))
for q in ['worth', 'closeness', 'professional_axis', 'romantic']:
    line = f'{q:18s} AUC laya {auc(lambda r: val(r[1], q)):.2f}'
    if not LAYA_ONLY: line += f'  jev {auc(lambda r: val(r[2], q)):.2f}'
    line += f'  | laya acc-mean {mean([val(r[1], q) for r in rows if r[0]=="accepted"]):.2f} rej-mean {mean([val(r[1], q) for r in rows if r[0]!="accepted"]):.2f}'
    print(line)
def dist(getter):
    out = {}
    for r in rows:
        v = getter(r); out[v] = out.get(v, 0) + 1
    return out
print('ended laya', dist(lambda r: (r[1].get('ended') or {}).get('choice')), '| jev', dist(lambda r: ((r[2] or {}).get('ended') or {}).get('choice')) if not LAYA_ONLY else '')
if not LAYA_ONLY:
    agree = sum(1 for r in rows if r[2] and (r[1].get('ended') or {}).get('choice') == (r[2].get('ended') or {}).get('choice'))
    print(f'ended agreement laya=jev {agree}/{len([r for r in rows if r[2]])}')
    print('worth bucket agreement (>=0.6 / <0.4 / else):', sum(1 for r in rows if r[2] and (lambda a,b: (a>=0.6)==(b>=0.6) and (a<0.4)==(b<0.4))(val(r[1],'worth'), val(r[2],'worth'))), '/', len([r for r in rows if r[2]]))
