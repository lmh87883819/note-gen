from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, Optional

from .data_types import Asset, ChatMessage, SessionMemory


@dataclass
class _SessionState:
    memory: SessionMemory
    next_asset_seq: int = 1


class MemoryStore:
    """
    MVP 版内存：只做进程内存储，后续可替换为 SQLite/Redis/文件持久化。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, _SessionState] = {}

    def get(self, session_id: str) -> SessionMemory:
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                state = _SessionState(memory=SessionMemory(session_id=session_id))
                self._sessions[session_id] = state
            return state.memory

    def next_asset_id(self, session_id: str, prefix: str) -> str:
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                state = _SessionState(memory=SessionMemory(session_id=session_id))
                self._sessions[session_id] = state
            asset_id = f"{prefix}_{state.next_asset_seq:04d}"
            state.next_asset_seq += 1
            return asset_id

    def add_message(self, session_id: str, message: ChatMessage) -> None:
        memory = self.get(session_id)
        memory.history.append(message)

    def add_asset(self, session_id: str, asset: Asset) -> None:
        memory = self.get(session_id)
        memory.assets[asset.id] = asset

    def get_asset(self, session_id: str, asset_id: str) -> Optional[Asset]:
        memory = self.get(session_id)
        return memory.assets.get(asset_id)

