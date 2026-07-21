type a = str


def greeting(name: a) -> a:
    return 'Hello ' + name


def timeouts(n: int) -> int:
    if (n % 2):
        while True:
            n = n
    return n


def throws(n: int) -> int:
    if (n % 2 == 0):
        raise Exception("some put exception")
    return n
