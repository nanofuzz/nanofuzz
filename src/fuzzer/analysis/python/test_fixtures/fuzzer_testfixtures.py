"""First Python fixture: imports and calls graph helpers from fixture two."""

from .fuzzer_testfixtures2 import (
    AdjacencyList,
    EdgeList,
    Items,
    Matrix,
    Vertex,
    bfs_adj_list,
    dfs_adj_list,
    fibonacci,
    knapsack_max_value,
    make_adj_list,
    minimum_coin_count,
    multi_bfs,
    topological_sort,
)
from .framework_dependencies import torch_probability_sum


# ------------------ IMPORTED TYPE-REFERENCE FIXTURES ------------------
# These aliases require PythonProgram to follow imports from this module to
# fuzzer_testfixtures2.py and preserve the nested graph-related types.
type ImportedGraph = AdjacencyList
type ImportedEdges = EdgeList
type Traversal = list[Vertex]
type DistanceGrid = Matrix
type KnapsackItems = Items


def bfs_from_imported_edges(start: Vertex, edges: ImportedEdges) -> Traversal:
    """Build a graph locally, then call the imported BFS implementation."""
    graph: ImportedGraph = make_adj_list(edges)
    return bfs_adj_list(start, graph)


def dfs_from_imported_edges(start: Vertex, edges: ImportedEdges) -> Traversal:
    """Build a graph locally, then call the imported DFS implementation."""
    graph: ImportedGraph = make_adj_list(edges)
    return dfs_adj_list(start, graph)


def topological_order_from_imported_edges(
    vertex_count: int, edges: ImportedEdges
) -> Traversal:
    """Call the imported DAG algorithm through this first fixture module."""
    return topological_sort(vertex_count, edges)


def source_distances_from_imported_grid(grid: Matrix) -> DistanceGrid:
    """Call the imported multi-source BFS implementation."""
    return multi_bfs(grid)


def graph_fixture_demo() -> Traversal:
    """Small end-to-end call chain used by multi-file fixture tests."""
    sample_edges: ImportedEdges = [(0, 1), (1, 2), (1, 3)]
    return bfs_from_imported_edges(0, sample_edges)


def fibonacci_from_imported_helper(index: int) -> int:
    """Call a primitive dynamic-programming helper imported from fixture two."""
    return fibonacci(index)


def coin_count_from_imported_helper(coins: list[int], amount: int) -> int:
    """Call the imported minimum-coin dynamic-programming algorithm."""
    return minimum_coin_count(coins, amount)


def knapsack_from_imported_helper(items: KnapsackItems, capacity: int) -> int:
    """Call the imported 0/1 knapsack algorithm through this fixture module."""
    return knapsack_max_value(items, capacity)


def torch_score_from_imported_helper(features: list[float]) -> float:
    """Call a PyTorch-backed helper without exposing framework types here."""
    return torch_probability_sum(features)
