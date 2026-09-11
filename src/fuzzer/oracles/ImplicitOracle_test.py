from ImplicitOracle import implicit_oracle


def test_implicit_oracle():
    assert implicit_oracle(float('nan')) is False
    assert implicit_oracle(float('inf')) is False
    assert implicit_oracle(float('-inf')) is False
    assert implicit_oracle(None) is False
    assert implicit_oracle("") is True
    assert implicit_oracle(0) is True
    assert implicit_oracle(-1) is True
    assert implicit_oracle(1) is True
    assert implicit_oracle("xyz") is True
    assert implicit_oracle([]) is True
    assert implicit_oracle([1]) is True
    assert implicit_oracle([[]]) is True
    assert implicit_oracle([[]]) is True
    assert implicit_oracle([None, 1]) is False
    assert implicit_oracle([1, None]) is False
    assert implicit_oracle([float('nan'), 1]) is False
    assert implicit_oracle([1, float('inf')]) is False
    assert implicit_oracle([float('-inf'), 1]) is False
    assert implicit_oracle([[None, 1], 1]) is False
    assert implicit_oracle([1, [None, 1]]) is False
    assert implicit_oracle([[float('nan'), 1], 1]) is False
    assert implicit_oracle([1, [1, float('inf')]]) is False
    assert implicit_oracle([[1, float('-inf')], 1]) is False
    assert implicit_oracle({}) is True
    assert implicit_oracle({"a": "abc", "b": 123}) is True
    assert implicit_oracle({"a": None, "b": 1}) is False
    assert implicit_oracle({"a": 1, "b": None}) is False
    assert implicit_oracle({"a": 1, "b": float('nan')}) is False
    assert implicit_oracle({"a": 1, "b": float('inf')}) is False
    assert implicit_oracle({"a": float('-inf'), "b": 1}) is False
    assert implicit_oracle([{"a": [{"c": None}], "b": 1}]) is False
    assert implicit_oracle([{"a": [{"c": float('nan')}], "b": 1}]) is False
    assert implicit_oracle([{"a": [{"c": float('inf')}], "b": 1}]) is False
    assert implicit_oracle([{"a": [{"c": float('-inf')}], "b": 1}]) is False
    assert implicit_oracle([{"a": [{"c": 2}], "b": 1}]) is True
