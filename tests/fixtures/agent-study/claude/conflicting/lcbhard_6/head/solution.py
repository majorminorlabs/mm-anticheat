from typing import List, Tuple


def can_tile_grid(n: int, h: int, w: int, tiles: List[Tuple[int, int]]) -> bool:
    """ Determine if it's possible to place rectangular tiles on an H×W grid such that:
    - Every cell is covered by exactly one tile
    - Tiles can be rotated (so a 2×3 tile can be placed as 3×2)
    - Some tiles may remain unused
    - Tiles must be aligned with grid cells and cannot extend outside
    
    Args:
        n: Number of available tiles (1 ≤ n ≤ 7)
        h: Height of the grid (1 ≤ h ≤ 10)
        w: Width of the grid (1 ≤ w ≤ 10)
        tiles: List of (a, b) tuples where tile i has dimensions a×b (1 ≤ a, b ≤ 10)
    
    Returns:
        True if the grid can be perfectly tiled, False otherwise
    
    >>> can_tile_grid(5, 5, 5, [(1, 1), (3, 3), (4, 4), (2, 3), (2, 5)])
    True
    >>> can_tile_grid(1, 1, 2, [(2, 3)])
    False
    >>> can_tile_grid(1, 2, 2, [(1, 1)])
    False
    """
    grid = [[False] * w for _ in range(h)]
    used = [False] * n

    def first_empty():
        for i in range(h):
            for j in range(w):
                if not grid[i][j]:
                    return i, j
        return None

    def fits(r, c, a, b):
        if r + a > h or c + b > w:
            return False
        return all(not grid[i][j] for i in range(r, r + a) for j in range(c, c + b))

    def fill(r, c, a, b, val):
        for i in range(r, r + a):
            for j in range(c, c + b):
                grid[i][j] = val

    def solve():
        cell = first_empty()
        if cell is None:
            return True
        r, c = cell
        tried = set()
        for k in range(n):
            if used[k]:
                continue
            a, b = tiles[k]
            # Skip duplicate tile shapes at this position
            key = (min(a, b), max(a, b))
            if key in tried:
                continue
            tried.add(key)
            for x, y in {(a, b), (b, a)}:
                if fits(r, c, x, y):
                    used[k] = True
                    fill(r, c, x, y, True)
                    if solve():
                        return True
                    fill(r, c, x, y, False)
                    used[k] = False
        return False

    # Prune: some subset of tile areas must sum to exactly h * w
    target = h * w
    reachable = {0}
    for a, b in tiles:
        reachable |= {s + a * b for s in reachable if s + a * b <= target}
    if target not in reachable:
        return False

    return solve()
