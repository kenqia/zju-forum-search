from __future__ import annotations

from datetime import datetime, timezone
from secrets import token_urlsafe


class SessionStore:
    """Ephemeral process-local sessions. Credentials are never persisted."""

    def __init__(self) -> None:
        self._sessions: dict[str, tuple[str, datetime | None]] = {}

    def create(self, access_token: str, expires_at: datetime | None = None) -> str:
        session_id = token_urlsafe(32)
        self._sessions[session_id] = (access_token, expires_at)
        return session_id

    def get(self, session_id: str) -> tuple[str, datetime | None] | None:
        value = self._sessions.get(session_id)
        if value and value[1] and value[1] <= datetime.now(timezone.utc):
            self._sessions.pop(session_id, None)
            return None
        return value

    def delete(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
