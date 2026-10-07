def sum_concatenated_permutations(n: int) -> int:
    """ Given a positive integer n, calculate the sum of concatenated permutations modulo 998244353.
    
    For each permutation P of (1, 2, ..., n), concatenate all numbers in P to form a single integer.
    For example, if P = (1, 20, 34), the concatenated result is 12034.
    
    Return the sum of all such concatenated integers for all n! permutations, modulo 998244353.
    
    Args:
        n: A positive integer (1 <= n <= 2 * 10^5)
    
    Returns:
        The sum of concatenated permutations modulo 998244353
    
    >>> sum_concatenated_permutations(3)
    1332
    >>> sum_concatenated_permutations(1)
    1
    """
    pass
def sum_concatenated_permutations(n: int) -> int:
    MOD = 998244353
    
    # Precompute factorials and their modular inverses
    fact = [1] * (n + 1)
    inv_fact = [1] * (n + 1)
    for i in range(2, n + 1):
        fact[i] = fact[i - 1] * i % MOD
        inv_fact[i] = pow(fact[i], MOD - 2, MOD)
    
    # Calculate the sum of concatenated permutations
    total_sum = 0
    for digit in range(1, n + 1):
        # Count how many times the digit appears in each position
        for position in range(1, n + 1):
            # Number of permutations where the digit is in the current position
            count = fact[n - 1] * inv_fact[position - 1] * inv_fact[n - position] % MOD
            # Contribution of the digit in the current position
            contribution = digit * (10 ** (position - 1)) * count % MOD
            total_sum = (total_sum + contribution) % MOD
    
    return total_sum

# Use check(sum_concatenated_permutations) to run tests.

