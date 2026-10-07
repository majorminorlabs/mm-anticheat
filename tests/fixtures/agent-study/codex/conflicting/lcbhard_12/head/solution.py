def min_operations_to_rearrange(n: int, s: str, t: str) -> int:
    """ Given two strings s and t of length n consisting of 'B' and 'W' characters,
    determine the minimum number of operations needed to transform the initial configuration s
    into the target configuration t.
    
    Initially, there are n stones placed in cells 1 to n according to string s,
    where 'W' represents a white stone and 'B' represents a black stone.
    There are also two empty cells at positions n+1 and n+2.
    
    In one operation, you can:
    - Choose two adjacent cells that both contain stones
    - Move these two stones to the two empty cells while preserving their order
    
    Return the minimum number of operations needed to achieve configuration t,
    or -1 if it's impossible.
    
    Args:
        n: Number of stones (2 <= n <= 14)
        s: Initial configuration string of length n
        t: Target configuration string of length n
    
    Returns:
        Minimum number of operations, or -1 if impossible
    
    >>> min_operations_to_rearrange(6, 'BWBWBW', 'WWWBBB')
    4
    >>> min_operations_to_rearrange(6, 'BBBBBB', 'WWWWWW')
    -1
    >>> min_operations_to_rearrange(3, 'BBW', 'BBW')
    0
    """
    if s == t:
        return 0
    if s.count('W') != t.count('W'):
        return -1

    # Store white stones in a bit mask; the hole position identifies the
    # two empty cells, so black stones need no separate representation.
    def encode(configuration):
        return sum(1 << i for i, stone in enumerate(configuration) if stone == 'W')

    start = (encode(s), n)
    target = (encode(t), n)
    front, back = {start}, {target}
    distances_front, distances_back = {start: 0}, {target: 0}

    # Every move is reversible. Expand the smaller breadth-first frontier
    # to find a shortest path without exploring the entire state space.
    while front and back:
        if len(front) > len(back):
            front, back = back, front
            distances_front, distances_back = distances_back, distances_front
        next_front = set()
        for mask, hole in front:
            distance = distances_front[(mask, hole)] + 1
            for source in range(n + 1):
                if hole - 1 <= source <= hole + 1:
                    continue
                pair = (mask >> source) & 3
                moved = (mask & ~(3 << source)) | (pair << hole)
                state = (moved, source)
                if state in distances_front:
                    continue
                if state in distances_back:
                    return distance + distances_back[state]
                distances_front[state] = distance
                next_front.add(state)
        front = next_front
    return -1
