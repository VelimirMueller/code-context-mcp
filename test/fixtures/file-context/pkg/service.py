"""Service module (CCA-04 fixture).

import notreal  # inside the docstring: not an import line
"""
import os
import json as j
from typing import (
    Optional,
    List,
)
from . import models

MAX_RETRIES = 3
DEFAULTS = {
    "timeout": 5,
}


def fetch(url: str, retries: int = MAX_RETRIES) -> Optional[str]:
    """Fetch a URL."""
    return None


async def fetch_many(
    urls: List[str],
    limit: int = 10,
) -> List[str]:
    return []


class Client(models.Base):
    """HTTP client."""

    def get(self, path):
        return fetch(path)


def _private():
    pass
