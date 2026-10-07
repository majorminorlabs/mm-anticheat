from typing import Optional, List
from itertools import permutations


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
    >>> solve_grid(3, 'AAA', 'BBB') is None
    True
    """
    # Each row is determined by the three distinct positions of A, B, C.
    candidates = {letter: [] for letter in 'ABC'}
    for positions in permutations(range(n), 3):
        row = ['.'] * n
        for letter, column in zip('ABC', positions):
            row[column] = letter
        candidates[row[min(positions)]].append(''.join(row))

    columns = [0] * n
    grid = []
    failed = set()

    def search(row_index):
        if row_index == n:
            return all(mask == 7 for mask in columns)
        state = (row_index, tuple(columns))
        if state in failed:
            return False

        for row in candidates[r[row_index]]:
            updated = columns.copy()
            for column, letter in enumerate(row):
                if letter == '.':
                    continue
                bit = 1 << (ord(letter) - ord('A'))
                if columns[column] & bit:
                    break
                if columns[column] == 0 and letter != c[column]:
                    break
                updated[column] |= bit
            else:
                # Every missing letter needs a distinct remaining row.
                remaining = n - row_index - 1
                if any(3 - mask.bit_count() > remaining for mask in updated):
                    continue
                previous = columns.copy()
                columns[:] = updated
                grid.append(row)
                if search(row_index + 1):
                    return True
                grid.pop()
                columns[:] = previous

        failed.add(state)
        return False

    return grid if search(0) else None
