"""データファイルの暗号化（ブラウザの WebCrypto と同じ方式）。

PBKDF2-SHA256（25万回）でパスワードから鍵を作り、AES-256-GCM で暗号化する。
ファイルは {"v":1, "kdf":"pbkdf2-sha256", "iter":..., "salt":b64, "iv":b64, "ct":b64} の JSON。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITERATIONS = 250_000


class WrongPassword(Exception):
    pass


def _key(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def encrypt(obj, password: str) -> dict:
    salt = os.urandom(16)
    iv = os.urandom(12)
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(_key(password, salt, ITERATIONS)).encrypt(iv, data, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": 1, "kdf": "pbkdf2-sha256", "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def decrypt(env: dict, password: str):
    try:
        salt = base64.b64decode(env["salt"])
        iv = base64.b64decode(env["iv"])
        ct = base64.b64decode(env["ct"])
        data = AESGCM(_key(password, salt, int(env.get("iter", ITERATIONS)))).decrypt(iv, ct, None)
    except Exception as e:  # InvalidTag など
        raise WrongPassword("パスワードが違うか、ファイルが壊れています") from e
    return json.loads(data.decode("utf-8"))
