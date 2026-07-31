import math

# This is a Python-specific analog of ImplicitOracle.implicitOracle
def implicit_oracle(x):
    # Handle list-like structures (corresponds to Array.isArray)
    if isinstance(x, list):
        # Flattening and checking all elements
        def flatten(lst):
            for item in lst:
                if isinstance(item, list):
                    yield from flatten(item)
                else:
                    yield item
        return all(implicit_oracle(e) for e in flatten(x))

    # Handle numbers
    if isinstance(x, (int, float)):
        return not (math.isnan(x) or math.isinf(x))

    # Handle null/None/Undefined
    if x is None:
        return False

    # Handle dictionaries (corresponds to typeof x === "object")
    if isinstance(x, dict):
        return all(implicit_oracle(e) for e in x.values())

    # Default case (boolean, string, etc.)
    return True