def count_good_sequences(N: int, M: int) -> int:
    """ Count the number of length-M sequences of positive integers whose product is a "good integer" not exceeding N.
    
    A positive integer n is called a "good integer" if and only if the sum of its positive divisors is divisible by 3.
    
    The result should be returned modulo 998244353.
    
    Args:
        N: Upper bound for the product of elements in the sequence (1 <= N <= 10^10)
        M: Length of the sequences (1 <= M <= 10^5)
    
    Returns:
        The number of valid sequences modulo 998244353
    
    >>> count_good_sequences(10, 1)
    5
    >>> count_good_sequences(4, 2)
    2
    >>> count_good_sequences(370, 907)
    221764640
    """
    # f(n) = number of length-M sequences with product n; multiplicative with
    # f(p^e) = C(e + M - 1, M - 1).  The answer is the sum of f over good n <= N,
    # computed as (sum over all n) - (sum over bad n), where bad n has every
    # sigma(p^e) not divisible by 3:
    #   p == 3: always bad;  p % 3 == 1: bad iff e % 3 != 2;  p % 3 == 2: bad iff e even.
    # Both sums are multiplicative-function prefix sums, done with a Min_25 sieve.
    MOD = 998244353
    from math import isqrt
    s = isqrt(N)

    # Lucy sieve: prime counts and chi-weighted prime counts (chi = character mod 3)
    # for every value in {N // i}.  lo[w] covers w <= s, hi[i] covers N // i.
    lo = [w - 1 for w in range(s + 1)]
    lo[0] = 0
    hi = [0] + [N // i - 1 for i in range(1, s + 1)]
    loc = [(1 if w % 3 == 1 else 0) - 1 for w in range(s + 1)]
    loc[0] = 0
    hic = [0] + [(1 if (N // i) % 3 == 1 else 0) - 1 for i in range(1, s + 1)]
    primes = []
    for p in range(2, s + 1):
        if lo[p] == lo[p - 1]:
            continue
        primes.append(p)
        cnt = lo[p - 1]
        cntc = loc[p - 1]
        ch = 0 if p == 3 else (1 if p % 3 == 1 else -1)
        p2 = p * p
        lim = min(s, N // p2)
        for i in range(1, lim + 1):
            d = i * p
            if d <= s:
                hi[i] -= hi[d] - cnt
                if ch:
                    hic[i] -= ch * (hic[d] - cntc)
            else:
                w = N // d
                hi[i] -= lo[w] - cnt
                if ch:
                    hic[i] -= ch * (loc[w] - cntc)
        for w in range(s, p2 - 1, -1):
            q = w // p
            lo[w] -= lo[q] - cnt
            if ch:
                loc[w] -= ch * (loc[q] - cntc)

    # Prime sums of f: total f(p) = M; bad f(p) = M iff p == 3 or p % 3 == 1.
    def bad_count(pi, pic, w):
        has3 = 1 if w >= 3 else 0
        return (pi - has3 + pic) // 2 + has3

    Tlo = [M * lo[w] % MOD for w in range(s + 1)]
    Thi = [M * hi[i] % MOD for i in range(s + 1)]
    Blo = [M * bad_count(lo[w], loc[w], w) % MOD for w in range(s + 1)]
    Bhi = [0] + [M * bad_count(hi[i], hic[i], N // i) % MOD for i in range(1, s + 1)]

    # c[e] = f(p^e) = C(e + M - 1, M - 1)
    c = [1]
    for e in range(1, N.bit_length() + 2):
        c.append(c[-1] * ((M - 1 + e) % MOD) % MOD * pow(e, MOD - 2, MOD) % MOD)

    # Min_25 second phase over primes in descending order, updating in place
    # (larger values first, so reads still see the previous round's values).
    for k in range(len(primes) - 1, -1, -1):
        p = primes[k]
        p2 = p * p
        if p2 > N:
            continue
        if p == 3:
            fb = c
        elif p % 3 == 1:
            fb = [0 if e % 3 == 2 else c[e] for e in range(len(c))]
        else:
            fb = [0 if e % 2 else c[e] for e in range(len(c))]
        PT = M * (k + 1) % MOD
        PB = Blo[p]
        pes = []
        pe = p
        e = 1
        while pe * p <= N:
            pes.append((e, pe))
            pe *= p
            e += 1
        lim = min(s, N // p2)
        for i in range(1, lim + 1):
            v = N // i
            at = 0
            ab = 0
            for e, pe in pes:
                if pe * p > v:
                    break
                d = i * pe
                if d <= s:
                    at += c[e] * (Thi[d] - PT) + c[e + 1]
                    ab += fb[e] * (Bhi[d] - PB) + fb[e + 1]
                else:
                    w = N // d
                    at += c[e] * (Tlo[w] - PT) + c[e + 1]
                    ab += fb[e] * (Blo[w] - PB) + fb[e + 1]
            Thi[i] = (Thi[i] + at) % MOD
            Bhi[i] = (Bhi[i] + ab) % MOD
        for w in range(s, p2 - 1, -1):
            at = 0
            ab = 0
            for e, pe in pes:
                if pe * p > w:
                    break
                q = w // pe
                at += c[e] * (Tlo[q] - PT) + c[e + 1]
                ab += fb[e] * (Blo[q] - PB) + fb[e + 1]
            Tlo[w] = (Tlo[w] + at) % MOD
            Blo[w] = (Blo[w] + ab) % MOD

    return (Thi[1] - Bhi[1]) % MOD
