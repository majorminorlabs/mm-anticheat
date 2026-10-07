def sum_manhattan_distances(m: int, n: int, k: int) -> int:
    """ Given a rectangular grid of size m × n, calculate the sum of Manhattan distances 
    between every pair of k identical pieces over all valid arrangements.
    
    A valid arrangement is a placement of all k pieces on the grid with at most one piece per cell.
    The Manhattan Distance between two cells (x_i, y_i) and (x_j, y_j) is |x_i - x_j| + |y_i - y_j|.
    
    Return the sum modulo 10^9 + 7.
    
    Args:
        m: Number of rows in the grid (1 <= m <= 10^5)
        n: Number of columns in the grid (1 <= n <= 10^5, 2 <= m * n <= 10^5)
        k: Number of identical pieces to place (2 <= k <= m * n)
    
    Returns:
        The sum of Manhattan distances between every pair of pieces over all valid arrangements,
        modulo 10^9 + 7.
    
    >>> sum_manhattan_distances(2, 2, 2)
    8
    >>> sum_manhattan_distances(1, 4, 3)
    20
    >>> sum_manhattan_distances(1, 3, 3)
    4
    """
    pass
def sum_manhattan_distances(m: int, n: int, k: int) -> int:
    MOD = 10**9 + 7
    
    # Calculate the number of ways to choose k positions out of m*n
    total_ways = 1
    for i in range(k):
        total_ways = total_ways * (m * n - i) // (i + 1)
    
    # Calculate the sum of Manhattan distances
    sum_distances = 0
    
    # Calculate the contribution of each row
    for i in range(m):
        row_contribution = 0
        for j in range(k):
            row_contribution += (i * j + (m - i - 1) * (k - j - 1)) % MOD
        row_contribution = (row_contribution * total_ways) % MOD
        sum_distances = (sum_distances + row_contribution) % MOD
    
    # Calculate the contribution of each column
    for j in range(n):
        col_contribution = 0
        for i in range(k):
            col_contribution += (j * i + (n - j - 1) * (k - i - 1)) % MOD
        col_contribution = (col_contribution * total_ways) % MOD
        sum_distances = (sum_distances + col_contribution) % MOD
    
    return sum_distances

# Use check(sum_manhattan_distances) to run tests.

