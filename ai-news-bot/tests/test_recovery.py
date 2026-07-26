"""Crash-recovery va idempotentlik testlari (Faza 3).

Har bosqichning o'z idempotentlik testi bor (test_rank, test_writer va h.k.):
ular "oqim ikki marta toza ishga tushdi" holatini tekshiradi. Bu yerdagi
savol boshqacha va og'irroq:

    jarayon bosqich **o'rtasida** o'ldi — qayta ishga tushganda nima bo'ladi?

Real sabablar: Docker konteyner restart, OOM killer, deploy paytida SIGTERM,
serverning o'chib qolishi. Bunda holat yarim yozilgan bo'ladi: ba'zi
klasterlar baholangan, ba'zilari yo'q; post yozilgan, lekin status
yangilanmagan; Telegram'ga yuborilgan, lekin bazaga yozilmagan.

Ikki xil xato bor va ular teng emas:

  Yo'qotish   — ish bajarilmay qoladi. Arzon: keyingi sikl qayta uradi.
  Takrorlash  — ish ikki marta bajariladi. Qimmat: LLM puli ikki marta
                ketadi, post kanalga ikki marta chiqadi (04-xavflar X5).

Shuning uchun har test "uzilishdan keyin qayta urinilyaptimi" degandan
ko'ra "uzilishdan keyin ikkilanmayaptimi" degan savolga javob beradi.

Uzilish `_Boom` istisnosi bilan modellashtiriladi — SIGKILL emas, lekin
baza nuqtai nazaridan farqi yo'q: commit bo'lmagan tranzaksiya yo'qoladi,
commit bo'lgani qoladi.
"""

from __future__ import annotations

from typing import Any

import pytest

from core.db import execute, query_one, utc_now


class _Boom(Exception):
    """Jarayon shu nuqtada o'ldi."""


# ─────────────────────────── Umumiy seed'lar ───────────────────────────


def _seed_item(
    *,
    source: str = "test",
    url: str = "https://x.dev/a",
    title: str = "Test yangilik",
    content: str = "qisqa matn",
    status: str = "raw",
) -> int:
    cursor = execute(
        "INSERT INTO items (source, url, url_normalized, title, content, "
        "fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (source, url, url, title, content, utc_now(), status),
    )
    return int(cursor.lastrowid)


def _seed_cluster(
    item_id: int,
    *,
    title: str = "Test yangilik",
    status: str = "new",
    enriched: bool = False,
    text_length: int = 2000,
) -> int:
    """Klaster yaratish. `enriched=True` bo'lsa Writer navbatiga tushadi."""
    now = utc_now()
    if enriched:
        cursor = execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, "
            "status, importance_score, relevance_score, category, "
            "enriched_text, article_url, enrich_source, enriched_at) "
            "VALUES (?, ?, ?, ?, ?, 9, 9, 'model_release', ?, ?, 'fetch', ?)",
            (
                item_id,
                title,
                now,
                now,
                status,
                "Batafsil matn. " * (text_length // 15),
                "https://x.dev/a",
                now,
            ),
        )
    else:
        cursor = execute(
            "INSERT INTO clusters (primary_item_id, title, created_at, updated_at, status) "
            "VALUES (?, ?, ?, ?, ?)",
            (item_id, title, now, now, status),
        )
    cluster_id = int(cursor.lastrowid)
    execute(
        "INSERT INTO cluster_items (cluster_id, item_id, is_primary) VALUES (?, ?, 1)",
        (cluster_id, item_id),
    )
    return cluster_id


def _post_body(link: str = "https://x.dev/a") -> str:
    return (
        "🔹 <b>Test sarlavha</b>\n\n"
        "Mohiyat jumlasi shu yerda.\n\n"
        "• Birinchi tafsilot\n• Ikkinchi tafsilot\n\n"
        f'🔗 <a href="{link}">Manba</a>  #AI #ModelRelease'
    )


def _hours_ago(hours: int) -> str:
    from datetime import UTC, datetime, timedelta

    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat(timespec="seconds")


def _count(table: str, where: str = "", params: Any = ()) -> int:
    sql = f"SELECT COUNT(*) AS c FROM {table}"  # noqa: S608 — jadval nomi testda qattiq yozilgan
    if where:
        sql += f" WHERE {where}"
    row = query_one(sql, params)
    return int(row["c"]) if row else 0


# ─────────────────────────── Collector ───────────────────────────


class TestCollectorRecovery:
    """save_items() o'rtasida uzilish.

    Collector'da tranzaksiya yo'q — har element alohida INSERT. Bu ataylab:
    yarim yig'ilgan partiya ham foydali, keyingi sikl qolganini oladi.
    Muhimi — qayta ishga tushganda saqlanganlar ikkilanmasligi.
    """

    def _items(self, count: int) -> list[Any]:
        from bot.collector import CollectedItem

        return [
            CollectedItem(
                source="test",
                url=f"https://x.dev/{i}",
                title=f"Yangilik {i}",
                content="matn",
            )
            for i in range(count)
        ]

    def test_partial_save_keeps_earlier_items(self, migrated_db, monkeypatch) -> None:
        """Uchinchi elementda uzilsa, birinchi ikkitasi bazada qoladi."""
        from bot.collector import base, save_items

        real_execute = base.execute
        state = {"calls": 0}

        def flaky(sql: str, params: Any = ()) -> Any:
            if sql.strip().startswith("INSERT INTO items"):
                state["calls"] += 1
                if state["calls"] == 3:
                    raise _Boom("jarayon o'ldi")
            return real_execute(sql, params)

        monkeypatch.setattr(base, "execute", flaky)

        with pytest.raises(_Boom):
            save_items(self._items(5))

        assert _count("items") == 2

    def test_rerun_after_crash_does_not_duplicate(self, migrated_db, monkeypatch) -> None:
        """Qayta ishga tushish: saqlanganlar dublikat, qolganlari yangi."""
        from bot.collector import base, save_items

        real_execute = base.execute
        state = {"calls": 0}

        def flaky(sql: str, params: Any = ()) -> Any:
            if sql.strip().startswith("INSERT INTO items"):
                state["calls"] += 1
                if state["calls"] == 3:
                    raise _Boom("jarayon o'ldi")
            return real_execute(sql, params)

        monkeypatch.setattr(base, "execute", flaky)
        with pytest.raises(_Boom):
            save_items(self._items(5))

        # Restart: mock olib tashlanadi, o'sha partiya qaytadan keladi
        monkeypatch.setattr(base, "execute", real_execute)
        result = save_items(self._items(5))

        assert result.inserted == 3
        assert result.duplicates == 2
        assert _count("items") == 5


# ─────────────────────────── Dedup ───────────────────────────


class TestDedupRecovery:
    """Klaster yaratish o'rtasida uzilish.

    `_create_cluster()` uch amal qiladi: clusters'ga INSERT, cluster_items'ga
    bog'lash, items.status = 'clustered'. Ular bitta tranzaksiyada emas,
    shuning uchun oraliq holat mumkin: klaster bor, lekin element hali 'raw'.

    Navbat so'rovi (`_fetch_unclustered`) status'ga emas, cluster_items'ga
    tayanadi — shuning uchun bog'langan element status qanday bo'lishidan
    qat'i nazar qayta klasterlanmaydi. Test aynan shuni tasdiqlaydi.
    """

    def test_linked_item_is_not_reclustered(self, migrated_db) -> None:
        """cluster_items'ga tushgan element 'raw' bo'lsa ham navbatga qaytmaydi."""
        from bot.dedup.clustering import _fetch_unclustered

        item_id = _seed_item(status="raw")
        _seed_cluster(item_id)
        # Uzilish: status yangilanishi commit bo'lmagan
        execute("UPDATE items SET status = 'raw' WHERE id = ?", (item_id,))

        assert _fetch_unclustered() == []

    def test_orphan_item_returns_to_queue(self, migrated_db) -> None:
        """Klasterga bog'lanmagan element navbatda qoladi — yo'qolmaydi."""
        from bot.dedup.clustering import _fetch_unclustered

        _seed_item(status="raw", url="https://x.dev/orphan")

        assert len(_fetch_unclustered()) == 1

    def test_rerun_does_not_duplicate_membership(self, migrated_db) -> None:
        """Bir element ikki marta bog'lansa PRIMARY KEY ushlaydi, xato bermaydi."""
        from bot.dedup.clustering import _add_to_cluster

        item_id = _seed_item()
        cluster_id = _seed_cluster(item_id)

        # INSERT OR IGNORE — ikkinchi urinish jimgina o'tadi
        _add_to_cluster(cluster_id, {"id": item_id}, similarity=0.9)

        assert _count("cluster_items", "cluster_id = ?", (cluster_id,)) == 1

    def test_item_count_recomputed_not_incremented(self, migrated_db) -> None:
        """item_count COUNT(*) dan qayta hisoblanadi — takror qo'shish uni buzmaydi.

        Agar `item_count = item_count + 1` bo'lganida, uzilishdan keyingi
        qayta urinish sonni noto'g'ri oshirib yuborardi.
        """
        from bot.dedup.clustering import _add_to_cluster

        item_id = _seed_item()
        cluster_id = _seed_cluster(item_id)
        second = _seed_item(url="https://x.dev/b", title="Boshqa")

        _add_to_cluster(cluster_id, {"id": second}, similarity=0.9)
        _add_to_cluster(cluster_id, {"id": second}, similarity=0.9)

        row = query_one("SELECT item_count FROM clusters WHERE id = ?", (cluster_id,))
        assert row["item_count"] == 2


# ─────────────────────────── Rank ───────────────────────────


def _mock_rank_llm(
    monkeypatch: pytest.MonkeyPatch,
    batches: list[Any],
) -> dict[str, int]:
    """Rank uchun LLM mock. `batches` elementi: natijalar ro'yxati yoki istisno."""
    import json

    from bot.rank import scorer
    from core.llm.client import LLMResponse

    state = {"calls": 0}
    queue = list(batches)

    class FakeClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *exc: object) -> None:
            pass

        def complete(self, stage: str, **kw: Any) -> LLMResponse:
            state["calls"] += 1
            payload = queue.pop(0) if queue else batches[-1]
            if isinstance(payload, Exception):
                raise payload
            return LLMResponse(
                text=json.dumps({"results": payload}),
                model="test-model",
                requested_model="test-model",
                prompt_tokens=500,
                completion_tokens=100,
                cost_usd=0.001,
                duration_ms=300,
            )

    monkeypatch.setattr(scorer, "LLMClient", FakeClient)
    return state


def _score(cluster_id: int, *, importance: int = 9) -> dict[str, Any]:
    return {
        "id": cluster_id,
        "importance": importance,
        "relevance": 9,
        "category": "tool",
        "is_spam": False,
        "reason": "Foydali.",
    }


class TestRankRecovery:
    """Batch o'rtasida uzilish — baholanmagan klasterlar `new` qolishi kerak."""

    def test_crash_mid_batch_leaves_rest_new(self, migrated_db, monkeypatch) -> None:
        """Ikkinchi batch uzildi: birinchisi saqlanadi, qolgani navbatda."""
        from bot.rank import run_rank

        ids = [_seed_cluster(_seed_item(url=f"https://x.dev/{i}"), title=f"N{i}") for i in range(4)]

        _mock_rank_llm(
            monkeypatch,
            [
                [_score(ids[0]), _score(ids[1])],
                _Boom("jarayon o'ldi"),
            ],
        )

        with pytest.raises(_Boom):
            run_rank(batch_size=2)

        assert _count("clusters", "status = 'ranked'") == 2
        assert _count("clusters", "status = 'new'") == 2

    def test_rerun_only_processes_remaining(self, migrated_db, monkeypatch) -> None:
        """Qayta ishga tushish faqat qolganini baholaydi — LLM puli takrorlanmaydi."""
        from bot.rank import run_rank

        ids = [_seed_cluster(_seed_item(url=f"https://x.dev/{i}"), title=f"N{i}") for i in range(4)]

        _mock_rank_llm(
            monkeypatch,
            [[_score(ids[0]), _score(ids[1])], _Boom("o'ldi")],
        )
        with pytest.raises(_Boom):
            run_rank(batch_size=2)

        # Restart
        state = _mock_rank_llm(monkeypatch, [[_score(ids[2]), _score(ids[3])]])
        report = run_rank(batch_size=2)

        assert state["calls"] == 1, "faqat bitta batch qayta baholanishi kerak"
        assert report.processed == 2
        assert _count("clusters", "status = 'new'") == 0

    def test_apply_scores_guards_on_status(self, migrated_db, monkeypatch) -> None:
        """UPDATE ... WHERE status = 'new' — allaqachon baholangani qayta yozilmaydi.

        Ssenariy: birinchi ishga tushish baholab commit qildi, lekin hisobot
        yozilmasdan o'ldi. Restartda o'sha javob qaytadan qo'llansa ham
        klaster o'zgarmasligi kerak.
        """
        from bot.rank.scorer import _apply_scores

        cluster_id = _seed_cluster(_seed_item())

        _apply_scores({cluster_id: _parsed(importance=9.0)}, min_importance=6.0)
        first = query_one(
            "SELECT importance_score, ranked_at, status FROM clusters WHERE id = ?",
            (cluster_id,),
        )

        # Takroriy qo'llash — boshqa baho bilan
        _apply_scores({cluster_id: _parsed(importance=2.0)}, min_importance=6.0)
        second = query_one(
            "SELECT importance_score, ranked_at, status FROM clusters WHERE id = ?",
            (cluster_id,),
        )

        assert second["importance_score"] == first["importance_score"]
        assert second["status"] == "ranked"


def _parsed(*, importance: float) -> dict[str, Any]:
    return {
        "importance_score": importance,
        "relevance_score": 9.0,
        "category": "tool",
        "is_spam": False,
        "rank_reason": "sabab",
    }


# ─────────────────────────── Enricher ───────────────────────────


class TestEnricherRecovery:
    """Boyitish o'rtasida uzilish.

    `enriched_at` — yagona belgi. U to'lgan bo'lsa klaster qayta ishlanmaydi
    (muvaffaqiyatsiz bo'lsa ham, `enrich_source='none'` bilan). Uzilish
    `enriched_at` yozilishidan oldin sodir bo'lsa klaster navbatda qoladi.
    """

    def test_crash_before_save_leaves_cluster_pending(self, migrated_db, monkeypatch) -> None:
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.enrich import _fetch_pending, run_enrich

        cluster_id = _seed_cluster(_seed_item(), status="ranked")

        def boom(cluster: dict[str, Any]) -> Any:
            raise _Boom("fetch paytida o'ldi")

        monkeypatch.setattr(enrich_mod, "_enrich_by_fetch", boom)

        # run_enrich bitta klasterning xatosini yutadi va `none` deb belgilaydi —
        # bu ataylab (izohga qarang). Uzilish esa `_save` gacha yetmasligi kerak.
        monkeypatch.setattr(enrich_mod, "_save", _raise_boom)
        with pytest.raises(_Boom):
            run_enrich(use_search=False)

        assert (
            query_one("SELECT enriched_at FROM clusters WHERE id = ?", (cluster_id,))["enriched_at"]
            is None
        )
        assert len(_fetch_pending(10)) == 1

    def test_enriched_cluster_not_reprocessed(self, migrated_db, monkeypatch) -> None:
        """`enriched_at` to'lgan klaster qayta urinilmaydi — kredit tejaladi."""
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.enrich import run_enrich

        _seed_cluster(_seed_item(), status="ranked")

        calls = {"n": 0}

        def counting_fetch(cluster: dict[str, Any]) -> tuple[str, str, str]:
            calls["n"] += 1
            return "Boyitilgan matn " * 50, "https://x.dev/a", ""

        monkeypatch.setattr(enrich_mod, "_enrich_by_fetch", counting_fetch)

        run_enrich(use_search=False)
        run_enrich(use_search=False)

        assert calls["n"] == 1

    def test_failed_enrich_is_not_retried(self, migrated_db, monkeypatch) -> None:
        """Boyitib bo'lmagani ham belgilangan — cheksiz qayta urinish yo'q."""
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.enrich import run_enrich

        cluster_id = _seed_cluster(_seed_item(), status="ranked")

        calls = {"n": 0}

        def failing_fetch(cluster: dict[str, Any]) -> None:
            calls["n"] += 1
            return None

        monkeypatch.setattr(enrich_mod, "_enrich_by_fetch", failing_fetch)

        run_enrich(use_search=False)
        run_enrich(use_search=False)

        assert calls["n"] == 1
        row = query_one("SELECT enrich_source, status FROM clusters WHERE id = ?", (cluster_id,))
        assert row["enrich_source"] == "none"
        # Klaster `ranked` qoladi — Writer uni feed matni bilan yoza oladi
        assert row["status"] == "ranked"


def _raise_boom(*args: Any, **kwargs: Any) -> None:
    raise _Boom("saqlash paytida o'ldi")


# ─────────────────────────── Writer ───────────────────────────


def _mock_write_llm(monkeypatch: pytest.MonkeyPatch, responses: list[str]) -> dict[str, int]:
    from bot.writer import write as write_mod
    from core.llm.client import LLMResponse

    state = {"calls": 0}
    queue = list(responses)

    class FakeClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> Any:
            return self

        def __exit__(self, *exc: object) -> None:
            pass

        def complete(self, stage: str, **kw: Any) -> LLMResponse:
            state["calls"] += 1
            text = queue.pop(0) if queue else responses[-1]
            return LLMResponse(
                text=text,
                model="test-model",
                requested_model="test-model",
                prompt_tokens=1000,
                completion_tokens=200,
                cost_usd=0.01,
                duration_ms=500,
            )

    monkeypatch.setattr(write_mod, "LLMClient", FakeClient)
    return state


class TestWriterRecovery:
    """Post yozish va saqlash o'rtasida uzilish.

    Writer'da eng qimmat LLM chaqiruvi ($0.014/post). Ikki xavf bor:
      1. Saqlash yarim bajarilsa — post bor, klaster `ranked` qolgan
      2. Qayta ishga tushishda o'sha klaster qayta yozilsa — pul ikki marta
    """

    def test_save_post_is_atomic(self, migrated_db, monkeypatch) -> None:
        """Klaster statusini yangilash uzilsa post ham saqlanmaydi.

        `_save_post()` tranzaksiya ichida — ikkalasi ham bo'ladi yoki
        hech biri. Aks holda post `draft` bo'lib qolardi, klaster esa
        `ranked`: keyingi sikl o'sha klasterga ikkinchi post yozardi.
        """
        from bot.writer import write as write_mod

        cluster_id = _seed_cluster(_seed_item(), status="ranked", enriched=True)

        real_execute = write_mod.execute

        def flaky(sql: str, params: Any = ()) -> Any:
            if sql.strip().startswith("UPDATE clusters"):
                raise _Boom("status yangilashda o'ldi")
            return real_execute(sql, params)

        monkeypatch.setattr(write_mod, "execute", flaky)

        with pytest.raises(_Boom):
            write_mod._save_post({"id": cluster_id, "article_image": None}, "matn", "test-model")

        assert _count("posts") == 0, "tranzaksiya rollback bo'lishi kerak"
        assert (
            query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"]
            == "ranked"
        )

    def test_crash_after_llm_before_save_rewrites(self, migrated_db, monkeypatch) -> None:
        """LLM javob berdi, saqlashdan oldin uzildi → klaster navbatda qoladi.

        Bu yerda LLM puli yo'qoladi — bu qabul qilingan narx. Muhimi:
        klaster yo'qolmaydi va keyingi siklda yoziladi.

        Diqqat: `_save_post()` `run_write()` dagi try blokidan tashqarida,
        shuning uchun saqlashdagi xato butun oqimni to'xtatadi. Bu ataylab —
        baza yozilmayotgan bo'lsa keyingi klasterlarga LLM puli sarflash
        behuda. Klasterlar navbatda qoladi.
        """
        from bot.writer import run_write
        from bot.writer import write as write_mod

        cluster_id = _seed_cluster(_seed_item(), status="ranked", enriched=True)
        _mock_write_llm(monkeypatch, [_post_body()])
        monkeypatch.setattr(write_mod, "_save_post", _raise_boom)

        with pytest.raises(_Boom):
            run_write()
        assert _count("posts") == 0

        # Restart: mock olib tashlanadi
        monkeypatch.undo()
        _mock_write_llm(monkeypatch, [_post_body()])
        report = run_write()

        assert report.written == 1
        assert (
            query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"]
            == "written"
        )

    def test_existing_post_blocks_rewrite(self, migrated_db, monkeypatch) -> None:
        """Post bor, lekin klaster statusi yangilanmagan — qayta yozilmaydi.

        Aynan shu holat `_save_post()` atomik bo'lmaganida yuzaga kelardi.
        Navbat filtri status'ga emas, posts jadvaliga tayanadi — shuning
        uchun bunday "yarim" holatda ham ikkinchi post yozilmaydi.
        """
        from bot.writer import run_write

        cluster_id = _seed_cluster(_seed_item(), status="ranked", enriched=True)
        execute(
            "INSERT INTO posts (cluster_id, body, model, created_at, status) "
            "VALUES (?, ?, 'test-model', ?, 'draft')",
            (cluster_id, _post_body(), utc_now()),
        )

        state = _mock_write_llm(monkeypatch, [_post_body()])
        report = run_write()

        assert state["calls"] == 0, "LLM umuman chaqirilmasligi kerak"
        assert report.processed == 0
        assert _count("posts") == 1

    def test_cost_limit_stops_without_losing_clusters(self, migrated_db, monkeypatch) -> None:
        """Xarajat limiti oqimni to'xtatadi, klasterlar navbatda qoladi."""
        from bot.writer import run_write
        from bot.writer import write as write_mod
        from core.llm import CostLimitExceeded

        for i in range(3):
            _seed_cluster(
                _seed_item(url=f"https://x.dev/{i}", title=f"N{i}"),
                title=f"N{i}",
                status="ranked",
                enriched=True,
            )

        class LimitedClient:
            def __init__(self, *a: Any, **kw: Any) -> None:
                pass

            def __enter__(self) -> Any:
                return self

            def __exit__(self, *exc: object) -> None:
                pass

            def complete(self, stage: str, **kw: Any) -> Any:
                raise CostLimitExceeded("kunlik limit tugadi")

        monkeypatch.setattr(write_mod, "LLMClient", LimitedClient)

        report = run_write()

        assert report.written == 0
        assert _count("posts") == 0
        # Hech bir klaster `write_failed` bo'lmasligi kerak — bu LLM sifati
        # emas, byudjet muammosi. Ertaga qayta urinish kerak.
        assert _count("clusters", "status = 'write_failed'") == 0
        assert _count("clusters", "status = 'ranked'") == 3


# ─────────────────────────── Publisher ───────────────────────────


class TestPublisherRecovery:
    """Eng xavfli bosqich: Telegram'ga yuborish va bazaga yozish orasidagi oyna.

    Bu yerda haqiqiy ikki fazali commit yo'q (Telegram tranzaksiyani
    qo'llab-quvvatlamaydi). Shuning uchun himoya ikki qatlamda:
      1. Navbat faqat `approved` postni oladi — `published` qaytmaydi
      2. Takror filtri model identifikatori bo'yicha ikkinchi postni to'xtatadi
    """

    def _approved_post(self, title: str = "Claude Opus 5") -> int:
        cluster_id = _seed_cluster(
            _seed_item(title=title, url=f"https://x.dev/{title[:10]}"),
            title=title,
            status="ranked",
        )
        execute(
            "UPDATE clusters SET importance_score = 9, relevance_score = 9 WHERE id = ?",
            (cluster_id,),
        )
        cursor = execute(
            "INSERT INTO posts (cluster_id, body, model, created_at, status, reviewed_at) "
            "VALUES (?, ?, 'test-model', ?, 'approved', ?)",
            (cluster_id, _post_body(), utc_now(), utc_now()),
        )
        return int(cursor.lastrowid)

    def test_published_post_leaves_queue(self, migrated_db) -> None:
        """mark_published() dan keyin post navbatga qaytmaydi."""
        from bot.publisher.publish import mark_published
        from bot.publisher.queue import next_in_queue

        post_id = self._approved_post()
        assert next_in_queue()["id"] == post_id

        mark_published(post_id, message_id=42)

        assert next_in_queue() is None

    def test_crash_before_mark_published_can_resend(self, migrated_db) -> None:
        """Telegram'ga ketdi, bazaga yozilmadi → post navbatda qoladi.

        Bu yo'qotish emas, **takrorlash** xavfi: kanalga ikkinchi marta
        chiqishi mumkin. Uni to'xtatuvchi ikkinchi qatlam takror filtri —
        keyingi test.
        """
        from bot.publisher.queue import next_in_queue

        post_id = self._approved_post()
        # Uzilish: mark_published() chaqirilmadi
        assert next_in_queue()["id"] == post_id

    def test_duplicate_filter_blocks_second_publish(self, migrated_db) -> None:
        """Bir mavzuda ikkinchi post chiqmaydi — uzilishdan keyin ham.

        Ssenariy: post #1 kanalga chiqdi va yozildi. Uzilishdan keyin
        o'sha klasterdan yozilgan boshqa post navbatga tushdi. Model
        identifikatori bir xil — filtr to'xtatadi.
        """
        from bot.publisher.publish import mark_published
        from bot.publisher.queue import QueueBlocked, check_can_publish

        first = self._approved_post("Claude Opus 5")
        mark_published(first, message_id=1)
        # Vaqt oralig'i cheklovi takror filtridan oldin ishlaydi — uni
        # chetlab o'tish uchun postni 3 soat oldin chiqqan qilamiz
        # (takror oynasi 48 soat, ya'ni filtr hali ham kuchda).
        execute(
            "UPDATE posts SET published_at = ? WHERE id = ?",
            (_hours_ago(3), first),
        )

        # Ikkinchi post — o'sha voqea haqida, boshqa manbadan
        self._approved_post("Anthropic launches Claude Opus 5")

        with pytest.raises(QueueBlocked, match="allaqachon chiqqan"):
            check_can_publish("Anthropic launches Claude Opus 5")

    def test_publish_now_refuses_published_post(self, migrated_db) -> None:
        """Qo'lda chiqarish ham ikkinchi marta ishlamaydi."""
        from bot.publisher.publish import mark_published, publish_now

        post_id = self._approved_post()
        mark_published(post_id, message_id=7)

        with pytest.raises(ValueError, match="allaqachon chiqarilgan"):
            publish_now(post_id)

    def test_mark_published_is_idempotent(self, migrated_db) -> None:
        """Takroriy chaqiruv klaster statusini buzmaydi."""
        from bot.publisher.publish import mark_published

        post_id = self._approved_post()
        mark_published(post_id, message_id=5)
        row = query_one("SELECT cluster_id, message_id FROM posts WHERE id = ?", (post_id,))

        mark_published(post_id, message_id=5)
        again = query_one("SELECT status, message_id FROM posts WHERE id = ?", (post_id,))

        assert again["status"] == "published"
        assert again["message_id"] == row["message_id"]
        assert (
            query_one("SELECT status FROM clusters WHERE id = ?", (row["cluster_id"],))["status"]
            == "published"
        )

    def test_pending_post_not_resent(self, migrated_db) -> None:
        """Tasdiqqa yuborilgan post ikkinchi marta yuborilmaydi.

        `unsent_drafts()` faqat `draft` oladi. Uzilish mark_pending()
        dan keyin bo'lsa post `pending` — navbatdan chiqadi.
        """
        from bot.publisher.publish import mark_pending
        from bot.publisher.queue import unsent_drafts

        cluster_id = _seed_cluster(_seed_item(), status="ranked")
        execute(
            "UPDATE clusters SET importance_score = 9, relevance_score = 9 WHERE id = ?",
            (cluster_id,),
        )
        cursor = execute(
            "INSERT INTO posts (cluster_id, body, model, created_at, status) "
            "VALUES (?, ?, 'test-model', ?, 'draft')",
            (cluster_id, _post_body(), utc_now()),
        )
        post_id = int(cursor.lastrowid)

        assert len(unsent_drafts()) == 1
        mark_pending(post_id, message_id=10, chat_id=99)
        assert unsent_drafts() == []

    def test_crash_before_mark_pending_resends(self, migrated_db, monkeypatch) -> None:
        """Yuborildi, lekin `pending` yozilmadi → qayta yuboriladi.

        Takrorlash bu yerda arzon: admin chatiga ikkita bir xil xabar
        keladi, kanalga emas. Yo'qotish qimmatroq bo'lardi — post umuman
        ko'rilmay qolardi.
        """
        from bot.publisher.queue import unsent_drafts

        cluster_id = _seed_cluster(_seed_item(), status="ranked")
        execute(
            "UPDATE clusters SET importance_score = 9, relevance_score = 9 WHERE id = ?",
            (cluster_id,),
        )
        execute(
            "INSERT INTO posts (cluster_id, body, model, created_at, status) "
            "VALUES (?, ?, 'test-model', ?, 'draft')",
            (cluster_id, _post_body(), utc_now()),
        )

        # mark_pending() chaqirilmadi — post `draft` qoldi
        assert len(unsent_drafts()) == 1
        assert len(unsent_drafts()) == 1


# ─────────────────────────── Migratsiya ───────────────────────────


class TestMigrationRecovery:
    """Migratsiya uzilishi — sxema yarim qo'llangan holatda qolmasligi kerak."""

    def test_migrate_twice_is_safe(self, migrated_db) -> None:
        """Ikkinchi chaqiruv hech narsa qilmaydi."""
        from core.db.database import current_version, migrate

        before = current_version()
        assert migrate() == 0
        assert current_version() == before

    def test_failed_migration_rolls_back(self, migrated_db, monkeypatch) -> None:
        """Buzuq migratsiya qo'llanmaydi va versiyaga yozilmaydi."""
        from core.db import database

        before = database.current_version()
        broken_sql = "CREATE TABLE bad (id INTEGER); SELECT nonsense();"

        monkeypatch.setattr(
            database,
            "all_migrations",
            lambda: [(999, "buzuq migratsiya", broken_sql)],
        )

        with pytest.raises(Exception, match="nonsense|no such function"):
            database.migrate()

        assert database.current_version() == before
        # Yarim qo'llangan jadval qolmasligi kerak
        assert query_one("SELECT name FROM sqlite_master WHERE type='table' AND name='bad'") is None

    def test_version_recorded_only_after_success(self, migrated_db, monkeypatch) -> None:
        """Muvaffaqiyatli migratsiya versiyaga yoziladi va takrorlanmaydi."""
        from core.db import database

        sql = "CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY);"
        monkeypatch.setattr(database, "all_migrations", lambda: [(998, "sinov migratsiyasi", sql)])

        assert database.migrate() == 1
        assert database.current_version() == 998
        # Ikkinchi urinish CREATE TABLE ni qayta bajarmaydi (aks holda xato)
        assert database.migrate() == 0


# ─────────────────────────── To'liq zanjir ───────────────────────────


class TestPipelineRecovery:
    """Zanjirning ikki marta ishga tushishi — hech narsa ikkilanmaydi.

    Bu integratsiya testi: har bosqichning idempotentligi alohida
    tekshirilgan, bu yerda ular birga ishlaydi. Aynan shu holat scheduler
    restart bo'lganda yuzaga keladi.
    """

    def test_rank_enrich_write_chain_is_idempotent(self, migrated_db, monkeypatch) -> None:
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.enrich import run_enrich
        from bot.rank import run_rank
        from bot.writer import run_write

        cluster_id = _seed_cluster(_seed_item(content="Uzun matn. " * 100))

        def fake_fetch(cluster: dict[str, Any]) -> tuple[str, str, str]:
            return "Batafsil maqola matni. " * 100, "https://x.dev/a", ""

        monkeypatch.setattr(enrich_mod, "_enrich_by_fetch", fake_fetch)

        # ── Birinchi to'liq o'tish ──
        _mock_rank_llm(monkeypatch, [[_score(cluster_id)]])
        run_rank()
        run_enrich(use_search=False)
        _mock_write_llm(monkeypatch, [_post_body()])
        run_write()

        assert _count("posts") == 1
        assert (
            query_one("SELECT status FROM clusters WHERE id = ?", (cluster_id,))["status"]
            == "written"
        )

        # ── Ikkinchi o'tish: hech qanday LLM chaqiruvi bo'lmasligi kerak ──
        rank_state = _mock_rank_llm(monkeypatch, [[_score(cluster_id)]])
        write_state = _mock_write_llm(monkeypatch, [_post_body()])

        run_rank()
        run_enrich(use_search=False)
        run_write()

        assert rank_state["calls"] == 0, "baholangan klaster qayta baholanmasin"
        assert write_state["calls"] == 0, "yozilgan klaster qayta yozilmasin"
        assert _count("posts") == 1

    def test_crash_between_stages_resumes(self, migrated_db, monkeypatch) -> None:
        """Rank tugadi, Enricher boshlanmasdan uzildi → qolgan yo'l davom etadi."""
        from bot.enricher import enrich as enrich_mod
        from bot.enricher.enrich import run_enrich
        from bot.rank import run_rank
        from bot.writer import run_write

        cluster_id = _seed_cluster(_seed_item(content="Uzun matn. " * 100))

        _mock_rank_llm(monkeypatch, [[_score(cluster_id)]])
        run_rank()
        # Uzilish shu yerda — Enricher umuman ishlamadi

        assert (
            query_one("SELECT enriched_at FROM clusters WHERE id = ?", (cluster_id,))["enriched_at"]
            is None
        )

        # Restart: zanjir boshidan ishga tushadi
        def fake_fetch(cluster: dict[str, Any]) -> tuple[str, str, str]:
            return "Batafsil maqola matni. " * 100, "https://x.dev/a", ""

        monkeypatch.setattr(enrich_mod, "_enrich_by_fetch", fake_fetch)
        rank_state = _mock_rank_llm(monkeypatch, [[_score(cluster_id)]])
        _mock_write_llm(monkeypatch, [_post_body()])

        run_rank()
        run_enrich(use_search=False)
        run_write()

        assert rank_state["calls"] == 0, "Rank qayta baholamasligi kerak"
        assert _count("posts") == 1

    def test_runs_table_records_each_attempt(self, migrated_db) -> None:
        """Har urinish `runs` ga yoziladi — tugamagani `finished_at` siz qoladi.

        Health report shu asosda "bosqich qotib qoldi" degan xulosa chiqaradi.
        """
        from core.db import finish_run, start_run

        crashed = start_run("collect")
        # finish_run() chaqirilmadi — jarayon o'ldi

        completed = start_run("collect")
        finish_run(completed, items_in=10, items_out=5)

        assert _count("runs", "finished_at IS NULL") == 1
        assert _count("runs", "finished_at IS NOT NULL") == 1
        assert query_one("SELECT stage FROM runs WHERE id = ?", (crashed,))["stage"] == "collect"
