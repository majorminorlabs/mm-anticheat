MOD = 998244353


def sum_of_scores(n: int, m: int) -> int:
    """ Calculate the sum of scores of all good sequences modulo 998244353.

    A good sequence is an integer sequence of length between 1 and n (inclusive),
    where each element is between 1 and m (inclusive).

    The score of a good sequence is the number of positive divisors of X,
    where X is the product of all elements in the sequence.

    The function computes the sum of scores of all possible good sequences.
    There are sum(m^k for k in range(1, n+1)) such sequences in total.

    Args:
        n: Maximum length of sequences (1 <= n <= 10^18)
        m: Maximum value of elements (1 <= m <= 16)

    Returns:
        The sum of all scores modulo 998244353

    >>> sum_of_scores(1, 7)
    16
    >>> sum_of_scores(3, 11)
    16095
    >>> sum_of_scores(81131, 14)
    182955659
    """
    primes = [p for p in (2, 3, 5, 7, 11, 13) if p <= m]
    k = len(primes)
    size = 1 << k
    deg = k + 1

    # d(X) = prod_p (e_p + 1): for each prime, either pick nothing or pick one
    # of its e_p occurrences. Each element picks a disjoint set U of primes,
    # with weight[U] = sum over x of prod_{p in U} (exponent of p in x).
    # The answer is sum over S, over j in 1..n, of the j-fold disjoint
    # (subset) convolution power of weight evaluated at S.
    weight = [0] * size
    for x in range(1, m + 1):
        exps = []
        for p in primes:
            e, y = 0, x
            while y % p == 0:
                y //= p
                e += 1
            exps.append(e)
        for u in range(size):
            w = 1
            for i in range(k):
                if u >> i & 1:
                    w *= exps[i]
            weight[u] += w

    def mul(a, b):
        r = [0] * deg
        for i in range(deg):
            if a[i]:
                for j in range(deg - i):
                    r[i + j] += a[i] * b[j]
        return [v % MOD for v in r]

    def add(a, b):
        return [(x + y) % MOD for x, y in zip(a, b)]

    def geometric(p, n):
        # Returns (p^n, p + p^2 + ... + p^n), truncated to degree k.
        if n == 0:
            return [1] + [0] * (deg - 1), [0] * deg
        if n % 2:
            pw, s = geometric(p, n - 1)
            pw = mul(pw, p)
            return pw, add(s, pw)
        pw, s = geometric(p, n // 2)
        return mul(pw, pw), add(s, mul(pw, s))

    popcount = [bin(s).count("1") for s in range(size)]

    # Ranked zeta transform: hat[S](z) = sum_{U subset of S} weight[U] z^|U|.
    hat = [[0] * deg for _ in range(size)]
    for u in range(size):
        hat[u][popcount[u]] = weight[u] % MOD
    for i in range(k):
        for s in range(size):
            if s >> i & 1:
                hat[s] = add(hat[s], hat[s ^ (1 << i)])

    total = [geometric(hat[s], n)[1] for s in range(size)]

    # Ranked Moebius transform, keeping the z^|S| coefficient for each S.
    answer = 0
    for s in range(size):
        t = s
        while True:
            c = total[t][popcount[s]]
            answer += -c if (popcount[s] - popcount[t]) % 2 else c
            if t == 0:
                break
            t = (t - 1) & s
    return answer % MOD
