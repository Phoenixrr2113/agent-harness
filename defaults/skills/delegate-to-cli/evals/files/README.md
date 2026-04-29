# widget-tools

A small CLI for inspecting and reshaping widget config files.

## Install

    npm install -g widget-tools

## Usage

    widget-tools inspect path/to/widgets.json
    widget-tools normalize path/to/widgets.json --out widgets.normalized.json

## Commands

- `inspect` — print a summary of widget counts by type.
- `normalize` — sort widgets by id and emit canonical JSON.

## License

MIT
