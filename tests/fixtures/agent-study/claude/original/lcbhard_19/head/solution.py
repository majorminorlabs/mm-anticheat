def count_special_permutations(A: int, B: int, M: int) -> int:
    """Count the number of permutations P of (1, 2, ..., AB-1) that satisfy:
    1. The length of a longest increasing subsequence of P is A
    2. The length of a longest decreasing subsequence of P is B
    3. There exists an integer n such that appending n + 0.5 to the end of P
       does not change either the length of a longest increasing subsequence
       or the length of a longest decreasing subsequence

    Return the count modulo M.

    Args:
        A: Required length of longest increasing subsequence (A >= 2)
        B: Required length of longest decreasing subsequence (B >= 2)
        M: Modulus (prime number between 10^8 and 10^9)

    Returns:
        Number of valid permutations modulo M

    >>> count_special_permutations(3, 2, 998244353)
    10
    >>> count_special_permutations(10, 12, 924844033)
    623378361
    """
    # By RSK, P corresponds to a pair (P-tableau, Q-tableau) of the same shape
    # lam = A x B rectangle (B rows of length A) minus its bottom-right corner.
    # Appending n + 0.5 row-inserts into the P-tableau; condition 3 holds iff
    # some insertion ends at the missing corner. The bumping path must then
    # run down the last column, which happens iff T[i][A-2] < T[i-1][A-1]
    # for every i = 1..B-1. Answer = f^lam * (#SYT of lam with that property).
    shape = [A] * (B - 1) + [A - 1]
    n = A * B - 1

    # f^lam via the hook length formula.
    num = 1
    for k in range(1, n + 1):
        num = num * k % M
    den = 1
    for i in range(B):
        for j in range(shape[i]):
            arm = shape[i] - j - 1
            leg = sum(1 for r in range(i + 1, B) if shape[r] > j)
            den = den * (arm + leg + 1) % M
    f_lam = num * pow(den, M - 2, M) % M

    # Count constrained SYT by DP over growing shapes, level by level.
    # Shapes are encoded as tuples of row lengths.
    cur = {tuple([0] * B): 1}
    for _ in range(n):
        nxt = {}
        for s, v in cur.items():
            ls = list(s)
            for i in range(B):
                c = ls[i]
                if c >= shape[i] or (i > 0 and ls[i - 1] <= c):
                    continue
                # Placing cell (i, A-1) requires (i+1, A-2) already filled.
                if c == A - 1 and ls[i + 1] < A - 1:
                    continue
                ls[i] = c + 1
                t = tuple(ls)
                nxt[t] = (nxt.get(t, 0) + v) % M
                ls[i] = c
        cur = nxt
    good = cur[tuple(shape)]

    return f_lam * good % M
