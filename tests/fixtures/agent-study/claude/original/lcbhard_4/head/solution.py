from typing import Optional, List


def solve_grid(n: int, r: str, c: str) -> Optional[List[str]]:
    """ Given an integer N and strings R and C of length N consisting of 'A', 'B', and 'C',
    determine if it's possible to fill an N×N grid such that:
    - Each row and column contains exactly one 'A', one 'B', and one 'C'
    - The leftmost character written in the i-th row matches the i-th character of R
    - The topmost character written in the i-th column matches the i-th character of C
    
    Empty cells are represented by '.' in the output.
    
    Args:
        n: The size of the grid (3 <= n <= 5)
        r: String of length n specifying leftmost characters in each row
        c: String of length n specifying topmost characters in each column
    
    Returns:
        A list of n strings representing the filled grid if possible, None otherwise.
        Each string has length n, where '.' represents empty cells.
    
    >>> solve_grid(3, 'ABC', 'ABC')
    ['ABC', 'BCA', 'CAB']
    >>> solve_grid(3, 'AAA', 'BBB')
    None
    """
    from itertools import permutations

    grid = [['.'] * n for _ in range(n)]
    col_used = [set() for _ in range(n)]  # letters already placed in each column
    col_top = [None] * n  # topmost letter placed in each column

    def backtrack(i: int) -> bool:
        if i == n:
            return all(len(s) == 3 for s in col_used)
        for pos in permutations(range(n), 3):
            # pos[k] is the column holding letter 'ABC'[k]
            if 'ABC'[pos.index(min(pos))] != r[i]:
                continue
            ok = True
            for k, j in enumerate(pos):
                ch = 'ABC'[k]
                if ch in col_used[j] or (col_top[j] is None and ch != c[j]):
                    ok = False
                    break
            if not ok:
                continue
            prev_tops = list(col_top)
            for k, j in enumerate(pos):
                ch = 'ABC'[k]
                grid[i][j] = ch
                col_used[j].add(ch)
                if col_top[j] is None:
                    col_top[j] = ch
            # Prune: remaining rows must be able to fill each column
            if all(3 - len(col_used[j]) <= n - i - 1 for j in range(n)) and backtrack(i + 1):
                return True
            for k, j in enumerate(pos):
                grid[i][j] = '.'
                col_used[j].discard('ABC'[k])
            col_top[:] = prev_tops
        return False

    if backtrack(0):
        return [''.join(row) for row in grid]
    return None
