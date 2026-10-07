def count_good_arrays(n: int, m: int, k: int) -> int:
    """ Count the number of good arrays of size n where each element is in range [1, m]
    and exactly k consecutive pairs have equal values.
    
    A good array arr of size n is defined as:
    - Each element in arr is in the inclusive range [1, m]
    - Exactly k indices i (where 1 <= i < n) satisfy arr[i-1] == arr[i]
    
    Return the count modulo 10^9 + 7.
    
    Args:
        n: The size of the array (1 <= n <= 10^5)
        m: The maximum value for array elements (1 <= m <= 10^5)
        k: The number of consecutive equal pairs (0 <= k <= n-1)
    
    Returns:
        The number of good arrays modulo 10^9 + 7
    
    >>> count_good_arrays(3, 2, 1)
    4
    >>> count_good_arrays(4, 2, 2)
    6
    >>> count_good_arrays(5, 2, 0)
    2
    """
    pass
def count_good_arrays(n: int, m: int, k: int) -> int:
    MOD = 10**9 + 7
    
    # dp[i][j] will store the number of good arrays of length i with exactly j consecutive equal pairs
    dp = [[0] * (k + 1) for _ in range(n + 1)]
    
    # Base case: There's one way to have an array of length 0 with 0 consecutive equal pairs
    dp[0][0] = 1
    
    for i in range(1, n + 1):
        for j in range(k + 1):
            # If we don't have any consecutive equal pairs at the end
            dp[i][j] = dp[i - 1][j] * (m - 1) % MOD
            
            # If we have j consecutive equal pairs at the end
            if j > 0:
                dp[i][j] = (dp[i][j] + dp[i - 1][j - 1] * 1) % MOD
    
    return dp[n][k]

# Use check(count_good_arrays) to run tests.

