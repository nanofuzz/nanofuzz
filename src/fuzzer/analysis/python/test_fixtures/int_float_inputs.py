"""Manual NaNofuzz target for checking Python int and float inputs."""


type UserId = int


def weighted_total(user_id: UserId, quantity: int, price: float) -> float:
    """Return a value that uses both integer and floating-point inputs."""
    return user_id + quantity * price
