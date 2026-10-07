from typing import Optional, Tuple


def find_cube_placement(V1: int, V2: int, V3: int) -> Optional[Tuple[int, int, int, int, int, int, int, int, int]]:
    """ Given three volumes V1, V2, V3, find a placement of three cubes with side length 7 such that:
    - The volume of the region contained in exactly one cube is V1
    - The volume of the region contained in exactly two cubes is V2  
    - The volume of the region contained in all three cubes is V3
    
    Each cube C(a,b,c) is defined by the region (a ≤ x ≤ a+7) ∧ (b ≤ y ≤ b+7) ∧ (c ≤ z ≤ c+7).
    
    Args:
        V1: Volume of region in exactly one cube (0 ≤ V1 ≤ 3 × 7³)
        V2: Volume of region in exactly two cubes (0 ≤ V2 ≤ 3 × 7³)
        V3: Volume of region in all three cubes (0 ≤ V3 ≤ 3 × 7³)
    
    Returns:
        A tuple (a1, b1, c1, a2, b2, c2, a3, b3, c3) representing the coordinates of the three cubes
        if a valid placement exists, where all absolute values are ≤ 100. Returns None if no valid
        placement exists.
    
    >>> find_cube_placement(840, 84, 7)
    (0, 0, 0, 0, 6, 0, 6, 0, 0)
    >>> find_cube_placement(343, 34, 3)
    None
    """
    if min(V1, V2, V3) < 0 or V1 + 2 * V2 + 3 * V3 != 3 * 7**3:
        return None

    # Fix cube 1 at the origin. On each axis, gaps between consecutive
    # cube starts can be capped at 7 without changing any intersection.
    # Thus starts within [-14, 14] cover every possible overlap pattern.
    patterns = {}
    for b in range(-14, 15):
        for c in range(-14, 15):
            overlaps = (
                max(0, 7 - abs(b)),
                max(0, 7 - abs(c)),
                max(0, 7 - abs(b - c)),
                max(0, 7 - (max(0, b, c) - min(0, b, c))),
            )
            patterns.setdefault(overlaps, (b, c))

    axes = list(patterns.items())
    pair_sum = V2 + 3 * V3
    # Axis permutations do not affect volumes, so only search ordered
    # combinations of patterns (with repetition).
    for i, (x, x_starts) in enumerate(axes):
        for j in range(i, len(axes)):
            y, y_starts = axes[j]
            xy = tuple(a * b for a, b in zip(x, y))
            if V3 and (xy[3] == 0 or V3 % xy[3]):
                continue
            for k in range(j, len(axes)):
                z, z_starts = axes[k]
                if xy[3] * z[3] != V3:
                    continue
                if sum(xy[p] * z[p] for p in range(3)) != pair_sum:
                    continue
                return (
                    0, 0, 0,
                    x_starts[0], y_starts[0], z_starts[0],
                    x_starts[1], y_starts[1], z_starts[1],
                )
    return None
