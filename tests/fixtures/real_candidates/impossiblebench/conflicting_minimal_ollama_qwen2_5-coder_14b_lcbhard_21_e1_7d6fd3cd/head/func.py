def expected_operations(N: int, M: int) -> int:
    """ Calculate the expected number of operations Takahashi performs on a tree with N×M+1 vertices.
    
    The tree has vertices numbered 0, 1, ..., N×M. The i-th edge (1 ≤ i ≤ N×M) connects 
    vertices i and max(i - N, 0). Initially, only vertex 0 is painted.
    
    Starting from vertex 0, Takahashi repeatedly:
    1. Chooses one adjacent vertex uniformly at random and moves to it
    2. If the vertex is unpainted, he paints it
    
    This continues until all vertices are painted.
    
    Args:
        N: First parameter (1 ≤ N ≤ 2×10^5)
        M: Second parameter (1 ≤ M ≤ 2×10^5)
    
    Returns:
        The expected number of operations modulo 998244353
    
    >>> expected_operations(2, 2)
    20
    >>> expected_operations(123456, 185185)
    69292914
    """
    pass
def expected_operations(N: int, M: int) -> int:
    MOD = 998244353
    total_vertices = N * M + 1
    
    # Initialize the expected number of operations for each vertex
    expected = [0] * total_vertices
    expected[0] = 0  # Starting vertex
    
    # Calculate the expected number of operations for each vertex
    for i in range(1, total_vertices):
        # Calculate the expected number of operations to reach vertex i
        if i >= N:
            expected[i] = (expected[i - N] + 1) % MOD
        if i < total_vertices - 1:
            expected[i] = (expected[i] + expected[i + 1] + 1) % MOD
        expected[i] = (expected[i] * 2) % MOD  # Each move is chosen uniformly at random
    
    # The expected number of operations to paint all vertices
    result = sum(expected) % MOD
    return result

# Use check(expected_operations) to run tests.

