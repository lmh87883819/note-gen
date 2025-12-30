from __future__ import annotations

from agno.agent import Agent

from ..data_types import DomainName
from .domains.image import get_image_agent
from .domains.general import get_general_agent


def build_domain_agents() -> dict[DomainName, Agent]:
    return {
        DomainName.IMAGE: get_image_agent(),
        DomainName.GENERAL: get_general_agent(),
    }
