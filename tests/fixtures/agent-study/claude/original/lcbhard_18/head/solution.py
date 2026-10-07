def count_k_palindromic_numbers(n: int, k: int) -> int:
    """ Count the number of good integers containing exactly n digits.
    
    An integer x is called k-palindromic if:
    - x is a palindrome (reads the same forwards and backwards)
    - x is divisible by k
    
    An integer is called good if its digits can be rearranged to form a k-palindromic integer.
    
    Note: Integers must not have leading zeros, neither before nor after rearrangement.
    
    Args:
        n: The number of digits (1 <= n <= 10)
        k: The divisor for k-palindromic property (1 <= k <= 9)
    
    Returns:
        The count of good integers with exactly n digits
    
    >>> count_k_palindromic_numbers(3, 5)
    27
    >>> count_k_palindromic_numbers(1, 4)
    2
    >>> count_k_palindromic_numbers(5, 6)
    2468
    """
    from math import factorial

    half = (n + 1) // 2
    seen = set()
    for left in range(10 ** (half - 1), 10 ** half):
        s = str(left)
        pal = s + s[::-1][n % 2:]
        if int(pal) % k == 0:
            seen.add("".join(sorted(pal)))

    fact = [factorial(i) for i in range(n + 1)]
    total = 0
    for digits in seen:
        counts = [0] * 10
        for c in digits:
            counts[int(c)] += 1
        # Permutations with a nonzero leading digit: total minus those starting with 0
        perms = (n - counts[0]) * fact[n - 1]
        for c in counts:
            perms //= fact[c]
        total += perms
    return total
