from __future__ import annotations

from typing import Any

import httpx

from .models import SearchResult


class ExternalModelProvider:
    """Adapter boundary for an explicitly configured provider."""
    def __init__(self, client: Any) -> None:
        self.client = client
    async def rerank(self, query: str, results: list[SearchResult]) -> list[SearchResult]:
        payload = {"query": query, "candidates": [result.model_dump(mode="json") for result in results]}
        ordered_ids = await self.client.rerank(payload)
        if not isinstance(ordered_ids, list) or not all(isinstance(item, str) for item in ordered_ids):
            raise ValueError("模型返回的排序结果无效")
        positions = {topic_id: index for index, topic_id in enumerate(ordered_ids)}
        return sorted(results, key=lambda result: positions.get(result.topic.id, len(positions)))


class HttpModelClient:
    def __init__(self, endpoint: str, timeout: float = 20.0) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
    async def rerank(self, payload: dict[str, Any]) -> list[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(self.endpoint, json=payload)
            response.raise_for_status()
            data = response.json()
        return data.get("ordered_ids", []) if isinstance(data, dict) else []
