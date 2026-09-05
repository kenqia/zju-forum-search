from __future__ import annotations

from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from .auth import SessionStore
from .cc98 import CC98Error, HttpCC98Client
from .config import settings
from .models import AuthStatus, LoginRequest, SearchResponse
from .search import SearchOptions, SearchService
from .providers import ExternalModelProvider, HttpModelClient

app = FastAPI(title="ZJU Forum Search", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
sessions = SessionStore()
cc98_client = HttpCC98Client()
model_provider = ExternalModelProvider(HttpModelClient(settings.llm_endpoint)) if settings.llm_endpoint else None
search_service = SearchService(cc98_client, model_provider=model_provider)


def _session(session_id: str | None = Cookie(default=None, alias="zju_session")) -> tuple[str, object]:
    if not session_id:
        raise HTTPException(status_code=401, detail="尚未登录 CC98")
    value = sessions.get(session_id)
    if not value:
        raise HTTPException(status_code=401, detail="登录会话已过期，请重新登录")
    return value


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login", response_model=AuthStatus)
async def login(request: LoginRequest, response: Response) -> AuthStatus:
    try:
        await cc98_client.validate_token(request.access_token)
    except CC98Error as exc:
        status = 401 if exc.kind == "auth" else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    # The token is held only in the in-memory session store and is never logged or returned.
    session_id = sessions.create(request.access_token)
    response.set_cookie("zju_session", session_id, httponly=True, samesite="lax", secure=False, max_age=86400)
    return AuthStatus(authenticated=True)


@app.get("/api/auth/status", response_model=AuthStatus)
async def auth_status(session: tuple[str, object] = Depends(_session)) -> AuthStatus:
    return AuthStatus(authenticated=True, expires_at=session[1] if hasattr(session[1], "year") else None)


@app.post("/api/auth/logout")
async def logout(response: Response, session_id: str | None = Cookie(default=None, alias="zju_session")) -> dict[str, str]:
    if session_id:
        sessions.delete(session_id)
    response.delete_cookie("zju_session")
    return {"status": "ok"}


@app.post("/api/search", response_model=SearchResponse)
async def search(query: str, multi_request: bool = False, llm_experiment: bool = False, session: tuple[str, object] = Depends(_session)) -> SearchResponse:
    try:
        return await search_service.search(session[0], query, SearchOptions(multi_request=multi_request, llm_experiment=llm_experiment))
    except CC98Error as exc:
        status = 401 if exc.kind == "auth" else 429 if exc.kind == "rate_limit" else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
