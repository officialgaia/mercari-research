"""メルカリからデータを取ってくる部分。

- MercariFetcher : 非公式ライブラリ mercapi を使って本物の検索結果を取得
- MockFetcher    : ネットにつながずにダミーデータを返す（画面の確認用。MOCK=1 で起動）

メルカリに負荷をかけないよう、リクエストの間に必ず待ち時間を入れる。
"""
from __future__ import annotations

import asyncio
import hashlib
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .analyzer import Listing


@dataclass
class FetchResult:
    sold: list[Listing]
    on_sale: list[Listing]
    on_sale_total: int
    sold_capped: bool
    requests: int


class FetchError(Exception):
    pass


class MercariFetcher:
    NEW_CONDITION_ID = 1  # 「新品、未使用」

    def __init__(self, interval: float = 2.0):
        self.interval = interval
        self._api = None  # mercapi はプロセスで1つだけ作る（README の推奨）

    def _client(self):
        if self._api is None:
            try:
                from mercapi import Mercapi
            except ImportError as e:  # pragma: no cover
                raise FetchError("mercapi がインストールされていません（pip install -r requirements.txt）") from e
            self._api = Mercapi()
        return self._api

    async def fetch(self, cand: dict, *, window_days: int, max_pages: int) -> FetchResult:
        from mercapi.requests import SearchRequestData as S

        api = self._client()
        common = dict(
            item_conditions=[self.NEW_CONDITION_ID] if cand.get("new_only") else [],
            price_min=cand.get("price_min") or None,
            price_max=cand.get("price_max") or None,
            exclude=cand.get("exclude") or None,
        )
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        reqs = 0

        # 1) 売り切れ：新しい順に、期間より古くなるかページ上限までたどる
        sold: list[Listing] = []
        capped = False
        try:
            res = await api.search(
                cand["keyword"],
                status=[S.Status.STATUS_SOLD_OUT],
                sort_by=S.SortBy.SORT_CREATED_TIME,
                sort_order=S.SortOrder.ORDER_DESC,
                **common,
            )
            reqs += 1
            page = 1
            while True:
                sold.extend(_convert(i, sold=True) for i in res.items)
                oldest_created = min((_aware(i.created) for i in res.items), default=None)
                if not res.meta.next_page_token or oldest_created is None:
                    break
                # 出品日が期間より古くなったら、それ以降はほぼ対象外なので打ち切り
                if oldest_created < since - timedelta(days=window_days):
                    break
                if page >= max_pages:
                    capped = True
                    break
                await asyncio.sleep(self.interval)
                res = await res.next_page()
                reqs += 1
                page += 1

            await asyncio.sleep(self.interval)

            # 2) 出品中：件数（競合の数）と、1ページ目の価格だけ使う
            res2 = await api.search(
                cand["keyword"],
                status=[S.Status.STATUS_ON_SALE],
                sort_by=S.SortBy.SORT_CREATED_TIME,
                sort_order=S.SortOrder.ORDER_DESC,
                **common,
            )
            reqs += 1
        except Exception as e:  # ネットワーク・仕様変更など
            raise FetchError(f"メルカリからの取得に失敗しました: {type(e).__name__}: {e}") from e

        on_sale = [_convert(i, sold=False) for i in res2.items]
        return FetchResult(sold, on_sale, int(res2.meta.num_found or 0), capped, reqs)


MOCK_WORDS = ["パール", "パール", "パール", "くま", "くま", "リボン", "ゴールド", "シルバー", "韓国", "大人気", "花", "ハート", "ビーズ", "クリア"]


class MockFetcher:
    """キーワードから決まった乱数でそれっぽいデータを作る。"""

    def __init__(self, interval: float = 0.3):
        self.interval = interval

    async def fetch(self, cand: dict, *, window_days: int, max_pages: int) -> FetchResult:
        await asyncio.sleep(self.interval)
        seed = int(hashlib.md5(cand["keyword"].encode()).hexdigest()[:8], 16)
        rnd = random.Random(seed)
        now = datetime.now(timezone.utc)
        base = rnd.choice([480, 780, 980, 1280, 1580, 2480, 3200])
        demand = rnd.choice([3, 8, 15, 28, 45, 70])
        supply = rnd.choice([20, 60, 150, 400, 1200])

        def item(i: int, sold: bool) -> Listing:
            created = now - timedelta(days=rnd.uniform(0, 70 if sold else 40))
            updated = created + timedelta(days=rnd.uniform(0.05, 12)) if sold else created
            updated = min(updated, now)
            price = max(300, int(rnd.gauss(base, base * 0.22) // 10 * 10))
            extra = " ".join(rnd.sample(MOCK_WORDS, 2))
            return Listing(
                id=f"m{seed % 10**8:08d}{i:03d}",
                name=f"{cand['keyword']} {extra} 新品",
                price=price,
                created=created,
                updated=updated,
                thumbnail="",
                sold=sold,
            )

        n_sold = min(int(demand * 2.2), 120 * max_pages)
        sold = [item(i, True) for i in range(n_sold)]
        on_sale = [item(i + 500, False) for i in range(min(supply, 120))]
        return FetchResult(sold, on_sale, supply, n_sold >= 120 * max_pages, 2)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _convert(i, *, sold: bool) -> Listing:
    return Listing(
        id=i.id_,
        name=i.name,
        price=i.real_price or 0,
        created=_aware(i.created),
        updated=_aware(i.updated),
        thumbnail=(i.thumbnails[0] if getattr(i, "thumbnails", None) else ""),
        sold=sold,
    )
