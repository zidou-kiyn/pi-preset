from jinja2 import Environment


def r(src):
    return Environment().from_string(src).render()


def test_registered():
    assert "truncate_middle" in Environment().filters


def test_short_unchanged():
    assert r("{{ 'short'|truncate_middle(10) }}") == "short"
    assert r("{{ 'abcdefghij'|truncate_middle(10) }}") == "abcdefghij"


def test_custom_marker_total_length():
    assert r("{{ 'abcdefghij'|truncate_middle(7, '-') }}") == "abc-hij"
    assert r("{{ 'abcdefghij'|truncate_middle(8, '..') }}") == "abc..hij"


def test_default_marker_head_gets_extra():
    # keep = 7 - 3 = 4 -> head 2, tail 2
    assert r("{{ 'abcdefghij'|truncate_middle(7) }}") == "ab...ij"
    # keep = 8 - 3 = 5 -> head 3, tail 2
    assert r("{{ 'abcdefghij'|truncate_middle(8) }}") == "abc...ij"


def test_default_length():
    s = "x" * 30
    out = Environment().from_string("{{ s|truncate_middle }}").render(s=s)
    assert len(out) == 20 and out.startswith("x" * 9) and out.endswith("x" * 8) and "..." in out
