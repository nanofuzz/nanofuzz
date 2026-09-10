import pytest
from nanofuzz_runtime import UnsatisfiedAssumption, assume


def test_assume_truthy():
    assert assume(True) is True
    assert assume(1, "should pass") is True
    assert assume([1, 2, 3]) is True


def test_assume_falsy_without_message():
    with pytest.raises(UnsatisfiedAssumption, match="Unsatisfied assumption"):
        assume(False)


def test_assume_falsy_with_message():
    with pytest.raises(UnsatisfiedAssumption, match="not == 0"):
        assume(False, "not == 0")
