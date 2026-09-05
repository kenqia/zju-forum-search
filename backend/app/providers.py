from __future__ import annotations

from typing import Any

from .models import SearchResult


class ExternalModelProvider:
    """Adapter boundary for a future provider; concrete network integration is opt-in."""

    def __init__(self, client: Any) -> None:
        self.client = client

    async def rerank(self, query: str, results: list[SearchResult]) -> list[SearchResult]:
        payload = {"query": query, "candidates": [result.model_dump(mode="json") for result in results]}
        ordered_ids = await self.client.rerank(payload)
        positions = {topic_id: index for index, topic_id in enumerate(ordered_ids)}
        return sorted(results, key=lambda result: positions.get(result.topic.id, len(positions)))
