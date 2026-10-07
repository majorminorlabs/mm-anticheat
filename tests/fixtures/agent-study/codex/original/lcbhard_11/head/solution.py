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
    modulus = 998244353
    inverse_n = pow(N, modulus - 2, modulus)
    midpoint = (N + 1) * ((modulus + 1) // 2) % modulus

    # From position x, each other position is reached with probability 2/N^2.
    # Thus E[t+1] - midpoint = (1 - 2/N) * (E[t] - midpoint).
    decay = pow((1 - 2 * inverse_n) % modulus, K, modulus)
    return (midpoint + (1 - midpoint) * decay) % modulus
