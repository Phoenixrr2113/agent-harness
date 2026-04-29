"""Tiny calculator REPL.

Reads a Python expression from the user and prints its value.
"""


def main() -> None:
    while True:
        expr = input("calc> ")
        if expr.strip() in {"quit", "exit"}:
            return
        # Evaluate the user's expression and print the result.
        result = eval(expr)
        print(result)


if __name__ == "__main__":
    main()
