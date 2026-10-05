def append_func(input_value, info):
    return f'{input_value} Changed'

def wrap_function(input_value, validator, info):
    return f'Input {validator(input_value)} Changed'

