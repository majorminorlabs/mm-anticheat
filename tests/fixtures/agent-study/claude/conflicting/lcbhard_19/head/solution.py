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
    # Via RSK, P corresponds to a pair (P-tableau, Q-tableau) of the same shape.
    # Conditions 1 and 2 with |P| = AB-1 force the shape to be the A x B
    # rectangle (B rows of length A) minus its bottom-right corner.
    # Condition 3 holds iff inserting some n + 0.5 fills exactly that corner,
    # which only constrains the P-tableau: its last two columns a (length B)
    # and b (length B-1) must satisfy a[i] < b[i-1] for i >= 1.
    # Such tableaux biject with SYT of the full rectangle in which the last
    # two cells of the first row hold consecutive values.
    # Answer = f(shape) * (#those tableaux), where f is the hook-length count.
    N = A * B - 1

    # f(shape) by the hook length formula.
    shape = [A] * (B - 1) + [A - 1]
    num = 1
    for k in range(2, N + 1):
        num = num * k % M
    den = 1
    for i, r in enumerate(shape):
        for j in range(r):
            col_len = B if j < A - 1 else B - 1
            den = den * ((r - j - 1) + (col_len - i - 1) + 1) % M
    f = num * pow(den, M - 2, M) % M

    # Count SYT of the rectangle where cell (0, A-1) is filled right after
    # cell (0, A-2): grow row 0 from A-2 straight to A, never stopping at A-1.
    cur = {(0,) * B: 1}
    for _ in range(N):
        nxt = {}
        for s, v in cur.items():
            for i in range(B):
                si = s[i]
                if si < A and (i == 0 or s[i - 1] > si):
                    if i == 0:
                        if si == A - 1:
                            continue
                        t = (A if si == A - 2 else si + 1,) + s[1:]
                    else:
                        t = s[:i] + (si + 1,) + s[i + 1:]
                    nxt[t] = (nxt.get(t, 0) + v) % M
        cur = nxt
    g = cur.get((A,) * B, 0)

    return f * g % M
