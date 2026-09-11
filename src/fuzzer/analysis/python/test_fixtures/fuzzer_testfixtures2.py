"""Graph-algorithm helpers imported by ``fuzzer_testfixtures.py``.

The functions intentionally use a range of Python annotations so PythonProgram
can exercise imported aliases, nested collections, tuples, and function calls
across two Python source files.
"""

from collections import deque


# ------------------ BASIC GRAPH ALGORITHMS ------------------
# Keep these aliases simple and explicit: they are also useful parser fixtures.
type Vertex = int
type Edge = tuple[Vertex, Vertex]
type EdgeList = list[Edge]
# A list-backed adjacency graph keeps this fixture within the collection types
# PythonProgram currently resolves for input generation.
type AdjacencyList = list[list[Vertex]]
type Coordinate = tuple[int, int]
type Matrix = list[list[int]]
type Items = list[list[int]]


def make_adj_list(edges: EdgeList) -> AdjacencyList:
    """Turn an edge list into an undirected adjacency list.

    Vertices are represented by non-negative integer indices. The fixture uses
    a list-backed graph so NaNofuzz can resolve the nested collection alias.
    """
    largest_vertex = max((max(left, right) for left, right in edges), default=-1)
    adj_list: AdjacencyList = [[] for _ in range(largest_vertex + 1)]

    for left, right in edges:
        adj_list.setdefault(left, []).append(right)
        adj_list.setdefault(right, []).append(left)

    return adj_list


def bfs_adj_list(start: Vertex, adj_list: AdjacencyList) -> list[Vertex]:
    """Basic BFS traversal given an adjacency list; return visit order."""
    queue = deque([start])
    visited: set[Vertex] = {start}
    order: list[Vertex] = []

    while queue:
        node = queue.popleft()
        order.append(node)

        neighbors = adj_list[node] if 0 <= node < len(adj_list) else []
        for neighbor in neighbors:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)

    return order


def bfs_matrix(start: Coordinate, matrix: Matrix) -> list[Coordinate]:
    """Basic BFS traversal given a grid/matrix; return reachable coordinates."""
    if not matrix or not matrix[0]:
        return []

    rows = len(matrix)
    cols = len(matrix[0])
    queue = deque([start])
    visited: set[Coordinate] = {start}
    order: list[Coordinate] = []
    directions: tuple[Coordinate, ...] = ((1, 0), (-1, 0), (0, 1), (0, -1))

    while queue:
        row, col = queue.popleft()
        order.append((row, col))

        for row_delta, col_delta in directions:
            new_row, new_col = row + row_delta, col + col_delta
            coordinate = (new_row, new_col)
            if 0 <= new_row < rows and 0 <= new_col < cols and coordinate not in visited:
                visited.add(coordinate)
                queue.append(coordinate)

    return order


def dfs_adj_list(start: Vertex, adj_list: AdjacencyList) -> list[Vertex]:
    """Basic DFS on an adjacency list; avoid revisiting cyclic graph edges."""
    visited: set[Vertex] = set()
    order: list[Vertex] = []
    stack: list[Vertex] = [start]

    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        order.append(node)
        neighbors = adj_list[node] if 0 <= node < len(adj_list) else []
        # Reverse keeps the traversal order consistent with recursive DFS.
        for neighbor in reversed(neighbors):
            if neighbor not in visited:
                stack.append(neighbor)

    return order


def dfs_matrix(start: Coordinate, matrix: Matrix) -> list[Coordinate]:
    """Basic DFS on a matrix; return coordinates in depth-first visit order."""
    if not matrix or not matrix[0]:
        return []

    rows = len(matrix)
    cols = len(matrix[0])
    visited: set[Coordinate] = set()
    order: list[Coordinate] = []
    directions: tuple[Coordinate, ...] = ((1, 0), (-1, 0), (0, 1), (0, -1))

    stack: list[Coordinate] = [start]
    while stack:
        coordinate = stack.pop()
        if coordinate in visited:
            continue
        row, col = coordinate
        visited.add(coordinate)
        order.append(coordinate)
        for row_delta, col_delta in directions:
            neighbor = (row + row_delta, col + col_delta)
            if (
                0 <= neighbor[0] < rows
                and 0 <= neighbor[1] < cols
                and neighbor not in visited
            ):
                stack.append(neighbor)

    return order


def is_source(row: int, col: int, grid: Matrix) -> bool:
    """Return whether this grid cell is a multi-source BFS starting point."""
    return grid[row][col] == 1


def multi_bfs(grid: Matrix) -> Matrix:
    """Return each cell's distance from its nearest source cell (value ``1``)."""
    if not grid or not grid[0]:
        return []

    rows = len(grid)
    cols = len(grid[0])
    directions: tuple[Coordinate, ...] = ((1, 0), (-1, 0), (0, 1), (0, -1))
    queue: deque[Coordinate] = deque()
    result: Matrix = [[-1] * cols for _ in range(rows)]

    # Put all source cells into the queue before expanding outward.
    for row in range(rows):
        for col in range(cols):
            if is_source(row, col, grid):
                result[row][col] = 0
                queue.append((row, col))

    # BFS outward from all sources at once.
    while queue:
        row, col = queue.popleft()
        for row_delta, col_delta in directions:
            new_row, new_col = row + row_delta, col + col_delta
            if 0 <= new_row < rows and 0 <= new_col < cols and result[new_row][new_col] == -1:
                result[new_row][new_col] = result[row][col] + 1
                queue.append((new_row, new_col))

    return result


def topological_sort(vertex_count: int, edges: EdgeList) -> list[Vertex]:
    """Return a topological order for a DAG, or ``[]`` when the graph cycles."""
    graph: AdjacencyList = [[] for _ in range(vertex_count)]
    indegree: list[int] = [0] * vertex_count

    for source, destination in edges:
        if not (0 <= source < vertex_count and 0 <= destination < vertex_count):
            raise ValueError("topological-sort edges must reference valid vertices")
        graph[source].append(destination)
        indegree[destination] += 1

    queue = deque(vertex for vertex in range(vertex_count) if indegree[vertex] == 0)
    order: list[Vertex] = []
    while queue:
        vertex = queue.popleft()
        order.append(vertex)
        for neighbor in graph[vertex]:
            indegree[neighbor] -= 1
            if indegree[neighbor] == 0:
                queue.append(neighbor)

    # A DAG visits every vertex. A shorter order means a cycle exists.
    return order if len(order) == vertex_count else []


# ------------------ DYNAMIC-PROGRAMMING ALGORITHMS ------------------

def fibonacci(index: int) -> int:
    """Return the non-negative ``index``-th Fibonacci number iteratively."""
    if index < 0:
        raise ValueError("fibonacci index must be non-negative")
    previous, current = 0, 1
    for _ in range(index):
        previous, current = current, previous + current
    return previous


def minimum_coin_count(coins: list[int], amount: int) -> int:
    """Return the fewest coins needed for ``amount``, or ``-1`` if impossible."""
    if amount < 0 or any(coin <= 0 for coin in coins):
        raise ValueError("amount must be non-negative and coins must be positive")

    best: list[int] = [amount + 1] * (amount + 1)
    best[0] = 0
    for target in range(1, amount + 1):
        for coin in coins:
            if coin <= target:
                best[target] = min(best[target], best[target - coin] + 1)

    return best[amount] if best[amount] <= amount else -1


def knapsack_max_value(items: Items, capacity: int) -> int:
    """Return the maximum value for ``[weight, value]`` items within capacity."""
    if capacity < 0:
        raise ValueError("capacity must be non-negative")

    best: list[int] = [0] * (capacity + 1)
    for item in items:
        if len(item) != 2:
            raise ValueError("each item must be [weight, value]")
        weight, value = item
        if weight < 0:
            raise ValueError("item weights must be non-negative")
        for remaining in range(capacity, weight - 1, -1):
            best[remaining] = max(best[remaining], best[remaining - weight] + value)

    return best[capacity]
