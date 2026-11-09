"""暗号化（Python⇔ブラウザ）と、利益計算（Python⇔JS）が一致するかのテスト。Node.js が必要。"""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from research.analyzer import evaluate
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
    const {{ evaluate }} = require({json.dumps(str(DOCS / 'evaluate.js'))});
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
def test_evaluate_parity_with_js():
    rnd = random.Random(42)
    cases = []
    for _ in range(300):
        metrics = {
            "price_median": rnd.choice([None, rnd.randint(300, 5000)]),
            "price_p25": rnd.randint(300, 4000),
            "sold_recent": rnd.randint(0, 120),
            "sell_through": rnd.choice([None, round(rnd.uniform(0, 3), 3), 99.0]),
            "window_days": 30,
            "sold_capped": rnd.random() < 0.2,
        }
        cand = {
            "cost_value": rnd.choice([0, rnd.randint(1, 80), round(rnd.uniform(1, 60), 2)]),
            "cost_currency": rnd.choice(["JPY", "CNY"]),
            "intl_yen": rnd.randint(0, 300),
            "ship_yen": rnd.choice([None, 0, 185, 210, 520]),
        }
        settings = {
            "fee_rate": rnd.choice([0.1, 0.08, 0.15]),
            "price_basis": rnd.choice(["median", "p25"]),
            "cny_jpy": rnd.choice([21.0, 20.37, 22.5]),
            "default_ship": 210,
            "min_profit": rnd.choice([200, 300, 500]),
            "min_sold": rnd.choice([5, 10, 15]),
            "min_sell_through": rnd.choice([0.2, 0.3, 0.5]),
        }
        cases.append((metrics, cand, settings))
    out = run_node(f"""
      const cases = {json.dumps(cases, ensure_ascii=False)};
      console.log(JSON.stringify(cases.map(([m, c, s]) => evaluate(m, c, s))));
    """)
    js = json.loads(out)
    for (m, c, s), j in zip(cases, js):
        p = evaluate(m, c, s)
        for k in ("sell_price", "unit_cost", "fee", "profit", "verdict", "ship", "intl"):
            assert p[k] == j[k], (k, m, c, s, p[k], j[k])
        assert p["reasons"] == j["reasons"], (p["reasons"], j["reasons"])
