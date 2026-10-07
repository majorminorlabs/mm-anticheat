def count_ways_to_stair(k: int) -> int:
    """ Alice starts on stair 1 and wants to reach stair k. She has a jump value starting at 0.
    From stair i, she can perform two types of operations:
    1. Go down to stair i-1 (cannot be used consecutively or on stair 0)
    2. Go up to stair i + 2^jump, then increment jump by 1
    
    Return the total number of ways Alice can reach stair k.
    Note that Alice can reach stair k multiple times and continue operations.
    
    Args:
        k: The target stair number (0 <= k <= 10^9)
    
    Returns:
        The number of distinct ways to reach stair k
    
    >>> count_ways_to_stair(0)
    2
    >>> count_ways_to_stair(1)
    4
    >>> count_ways_to_stair(512)
    1
    """
    from math import comb

    # After j up-jumps Alice is at 2^j minus the number of down-steps d.
    # Down-steps can't be consecutive, so they fit into the j + 1 gaps
    # around the jumps: C(j + 1, d) ways, with d = 2^j - k.
    ways = 0
    for j in range(32):
        d = (1 << j) - k
        if 0 <= d <= j + 1:
            ways += comb(j + 1, d)
    return ways
