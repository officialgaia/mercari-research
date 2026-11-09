"""暗号化（Python⇔ブラウザ）と、利益計算（Python⇔JS）が一致するかのテスト。Node.js が必要。"""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from research.analyzer import judge
from research.crypto import WrongPassword, decrypt, encrypt

DOCS = Path(__file__).resolve().parent.parent / "docs"
node = shutil.which("node")


def test_roundtrip_and_wrong_password():
    obj = {"候補": ["ぷっくりシール"], "n": 1}
    env = encrypt(obj, "pw")
    assert decrypt(env, "pw") == obj
    with pytest.raises(WrongPassword):
        decrypt(env, "nope")


def run_node(script: str) -> str:
    js = f"""
    const fs = require('fs');
    eval(fs.readFileSync({json.dumps(str(DOCS / 'crypto.js'))}, 'utf8') + '; globalThis.Crypto = Crypto;');
    const {{ judge }} = require({json.dumps(str(DOCS / 'judge.js'))});
    (async () => {{ {script} }})().catch(e => {{ console.error(e); process.exit(1); }});
    """
    return subprocess.run([node, "-e", js], capture_output=True, text=True, check=True, timeout=60).stdout


@pytest.mark.skipif(not node, reason="node がない")
def test_python_encrypt_js_decrypt_and_back():
    obj = {"keyword": "コサージュ 卒業式", "price": 1280, "list": [1, 2, 3]}
    env = encrypt(obj, "パスワード123")
    out = run_node(f"""
      const env = {json.dumps(env)};
      const o = await Crypto.decrypt(env, "パスワード123");
      const back = await Crypto.encrypt(o, "パスワード123");
      console.log(JSON.stringify({{o, back}}));
    """)
    res = json.loads(out)
    assert res["o"] == obj
    assert decrypt(res["back"], "パスワード123") == obj


@pytest.mark.skipif(not node, reason="node がない")
def test_judge_parity_with_js():
    rnd = random.Random(42)
    cases = []
    for _ in range(500):
        m = {
            "price_median": rnd.choice([None, rnd.randint(300, 6000)]),
            "sold_recent": rnd.randint(0, 120),
            "sell_through": rnd.choice([None, round(rnd.uniform(0, 3), 3), 99.0]),
        }
        s = {
            "min_profit": rnd.choice([200, 300, 500]),
            "intl_yen": rnd.choice([0, 50, 100, 180]),
            "ship_yen": rnd.choice([185, 210, 230, 520]),
        }
        cases.append((m, s, rnd.choice([20.37, 21.0, 19.84, 22.15])))
    out = run_node(f"""
      const cases = {json.dumps(cases)};
      console.log(JSON.stringify(cases.map(([m, s, c]) => judge(m, s, c))));
    """)
    for (m, s, c), j in zip(cases, json.loads(out)):
        assert judge(m, s, c) == j, (m, s, c)
