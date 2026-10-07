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
    tiles = tiles[:n]
    grid = [[False] * w for _ in range(h)]
    used = [False] * n

    def fits(r: int, c: int, a: int, b: int) -> bool:
        if r + a > h or c + b > w:
            return False
        return not any(grid[i][j] for i in range(r, r + a) for j in range(c, c + b))

    def fill(r: int, c: int, a: int, b: int, value: bool) -> None:
        for i in range(r, r + a):
            for j in range(c, c + b):
                grid[i][j] = value

    def dfs(pos: int) -> bool:
        # Advance to the first uncovered cell in row-major order
        while pos < h * w and grid[pos // w][pos % w]:
            pos += 1
        if pos == h * w:
            return True
        r, c = divmod(pos, w)
        for i in range(n):
            if used[i]:
                continue
            a, b = tiles[i]
            for x, y in {(a, b), (b, a)}:
                if fits(r, c, x, y):
                    used[i] = True
                    fill(r, c, x, y, True)
                    if dfs(pos):
                        return True
                    fill(r, c, x, y, False)
                    used[i] = False
        return False

    return dfs(0)
