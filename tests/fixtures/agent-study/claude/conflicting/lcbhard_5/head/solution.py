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
    if V1 + 2 * V2 + 3 * V3 != 3 * 7 ** 3:
        return None

    def overlap(lo: int, hi: int) -> int:
        return max(0, hi - lo)

    # Fix cube 1 at the origin. Per axis, collect the distinct
    # (pairwise overlaps, triple overlap) profiles and an offset pair producing each.
    axis = {}
    for p in range(0, 8):
        for q in range(-7, 8):
            key = (
                overlap(p, 7),
                overlap(max(0, q), min(7, q + 7)),
                overlap(max(p, q), min(p, q) + 7),
                overlap(max(0, p, q), min(0, p, q) + 7),
            )
            axis.setdefault(key, (p, q))
    profiles = list(axis.items())

    for (x12, x13, x23, x123), (ax, aq) in profiles:
        for (y12, y13, y23, y123), (bx, bq) in profiles:
            for (z12, z13, z23, z123), (cx, cq) in profiles:
                v3 = x123 * y123 * z123
                if v3 != V3:
                    continue
                v2 = x12 * y12 * z12 + x13 * y13 * z13 + x23 * y23 * z23 - 3 * v3
                if v2 == V2:
                    return (0, 0, 0, ax, bx, cx, aq, bq, cq)
    return None
