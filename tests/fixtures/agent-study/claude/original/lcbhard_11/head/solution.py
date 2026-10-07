def expected_black_ball_position(N: int, K: int) -> int:
    """ There are N-1 white balls and one black ball arranged in a row, with the black ball
    initially at the leftmost position. Takahashi performs K operations, where each operation
    consists of:
    - Choose two integers a and b uniformly at random between 1 and N, inclusive
    - If a ≠ b, swap the a-th and b-th balls from the left
    
    Find the expected position of the black ball after K operations, modulo 998244353.
    
    The result is returned as an integer R where R × Q ≡ P (mod 998244353), where P/Q is
    the expected value expressed as an irreducible fraction.
    
    Args:
        N: Total number of balls (1 ≤ N ≤ 998244352)
        K: Number of operations (1 ≤ K ≤ 10^5)
    
    Returns:
        The expected position modulo 998244353
    
    >>> expected_black_ball_position(2, 1)
    499122178
    >>> expected_black_ball_position(3, 2)
    554580198
    >>> expected_black_ball_position(4, 4)
    592707587
    """
    MOD = 998244353
    if N == 1:
        return 1
    inv_n2 = pow(N * N % MOD, MOD - 2, MOD)
    move = 2 * inv_n2 % MOD  # prob. of moving from position 1 to a specific other position
    stay = (1 - (N - 1) * move) % MOD
    # p = probability the black ball is at position 1
    p = 1
    for _ in range(K):
        p = (p * stay + (1 - p) * move) % MOD
    # Other positions are equally likely; their average is (N + 2) / 2
    avg_rest = (N + 2) * pow(2, MOD - 2, MOD) % MOD
    return (p + (1 - p) * avg_rest) % MOD
