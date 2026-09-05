import pytest
from pydantic import BaseModel

from app.cc98 import CC98Error
from app.config import Settings
from app.models import Reply, TopicSummary
from app.search import SearchOptions, SearchService, plan_query


class FakeClient:
    def __init__(self):
        self.searches = []
        self.pages = {
            "1": {
                1: ([Reply(id="r1", content="高等数学 期末复习资料", floor=1), Reply(id="r1", content="duplicate", floor=1)], True),
                2: ([Reply(id="r2", content="考试重点在第 3 章", floor=2)], False),
            },
            "2": {1: ([Reply(id="r3", content="无关内容")], False)},
        }

    async def search_topics(self, token, query):
        self.searches.append(query)
        return [
            TopicSummary(id="1", title="高数期末资料", board="课程", published_at="2026-01-01", reply_count=2, url="https://cc98.org/topic/1"),
            TopicSummary(id="2", title="闲聊", url="https://cc98.org/topic/2"),
        ]

    async def get_replies(self, token, topic_id, *, page=1, page_size=100):
        return self.pages[topic_id][page]


def test_plan_query_keeps_original_and_terms():
    plan = plan_query("帮我找高等数学 期末复习资料")
    assert plan.original_query == "帮我找高等数学 期末复习资料"
    assert plan.terms[0] == plan.original_query
    assert "高等数学" in plan.terms


@pytest.mark.asyncio
async def test_search_fetches_pages_deduplicates_and_ranks():
    client = FakeClient()
    service = SearchService(client)
    response = await service.search("test-token", "高等数学 期末")
    assert response.results[0].topic.id == "1"
    assert len(response.results[0].replies) == 2
    assert response.results[0].evidence
    assert client.searches == ["高等数学 期末"]


@pytest.mark.asyncio
async def test_multi_request_stops_on_rate_limit_and_marks_partial():
    class Limited(FakeClient):
        async def search_topics(self, token, query):
            self.searches.append(query)
            if len(self.searches) == 2:
                raise CC98Error("rate", kind="rate_limit", status_code=429)
            return [TopicSummary(id="1", title=query, url="https://cc98.org/topic/1")]

    client = Limited()
    service = SearchService(client, config=Settings(multi_request_enabled=True, multi_request_delay_seconds=0, multi_request_max_requests=3))
    response = await service.search("test-token", "高数 期末", SearchOptions(multi_request=True))
    assert response.partial is True
    assert response.requests_made == 1
    assert response.stop_reason


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_local_sort():
    class BrokenProvider:
        async def rerank(self, query, results):
            raise RuntimeError("offline")

    client = FakeClient()
    service = SearchService(client, config=Settings(llm_experiment_enabled=True), model_provider=BrokenProvider())
    response = await service.search("test-token", "高数", SearchOptions(llm_experiment=True))
    assert response.llm_experiment is True
    assert response.llm_fallback
