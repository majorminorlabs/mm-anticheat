from itertools import permutations
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
    # Every valid row: A, B, C placed into distinct columns, grouped by leftmost letter.
    rows_by_first = {ch: [] for ch in 'ABC'}
    for cols in permutations(range(n), 3):
        row = ['.'] * n
        for ch, j in zip('ABC', cols):
            row[j] = ch
        first = row[min(cols)]
        rows_by_first[first].append(''.join(row))

    grid: List[str] = []
    # used[j] is the set of letters already placed in column j.
    used = [set() for _ in range(n)]

    def place(i: int) -> bool:
        if i == n:
            return all(len(s) == 3 for s in used)
        remaining = n - i - 1
        for row in rows_by_first[r[i]]:
            cells = [(j, ch) for j, ch in enumerate(row) if ch != '.']
            # A letter can't repeat in a column, and the first letter in a column must match c.
            if any(ch in used[j] or (not used[j] and ch != c[j]) for j, ch in cells):
                continue
            for j, ch in cells:
                used[j].add(ch)
            # Prune: each column must still be completable with the rows left.
            if all(3 - len(used[j]) <= remaining for j in range(n)):
                grid.append(row)
                if place(i + 1):
                    return True
                grid.pop()
            for j, ch in cells:
                used[j].discard(ch)
        return False

    return list(grid) if place(0) else None
