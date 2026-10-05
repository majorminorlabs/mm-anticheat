import importlib
import sys
import textwrap
from collections.abc import Iterator
from pathlib import Path

import pytest

from pydantic import PydanticUndefinedAnnotation, PydanticUserError

pytestmark = pytest.mark.skipif(sys.version_info < (3, 15), reason='Requires lazy imports introduced in Python 3.15')

def test_lazy_import_in_annotation(create_module) -> None:
    module = create_module(
        textwrap.dedent("""
        lazy from datetime import date

        from pydantic import BaseModel

        class Model(BaseModel):
            d: date
        """)
    )

    assert module.Model.__pydantic_complete__
    assert module.Model(d='2026-01-01').d == module.date(2026, 1, 1)
