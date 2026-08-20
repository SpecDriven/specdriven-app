# Start sessions in Claude or Codex

## Claude Examples

`claude -p "Extract the main function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  | jq '.structured_output'`


##  Capturing the session ID from `claude -p`

Two ways — read it out of the JSON result, or set it yourself up front.

### 1. Read it from the output (`--output-format json`)

`-p` with `--output-format json` returns a result object containing `session_id`:

```bash
SESSION_ID=$(claude -p "do this" --output-format json | jq -r '.session_id')
```

Shape of the result object (abbreviated):

```json
{"is_error":false,"session_id":"e4c85a88-33bc-4559-b077-ec07c63b4052","subtype":"success","result":"...","type":"result"}
```

If you also want the text answer, capture once and split:

```bash
out=$(claude -p "do this" --output-format json)
sid=$(jq -r .session_id <<<"$out")
text=$(jq -r .result <<<"$out")
```

With `--output-format stream-json`, `session_id` shows up on the very first
`type:"system", subtype:"init"` event, so you get it before the run finishes:

```bash
claude -p "do this" --output-format stream-json --verbose | jq -r 'select(.subtype=="init").session_id'
```

### 2. Choose the ID yourself (`--session-id`)

Cleaner for scripting — you know the ID before the process starts, and plain
`text` output still works:

```bash
SESSION_ID=$(uuidgen | tr 'A-Z' 'a-z')
claude -p "do this" --session-id "$SESSION_ID"
```

Must be a valid UUID, and it has to be unused — reusing an existing one errors
rather than appending.

### Resuming

```bash
claude -p "and now do that" --resume "$SESSION_ID"
```

### Caveats

- `--resume` on a `-p` run forks to a *new* session id in recent versions, so
  re-capture it each turn if you're chaining more than two calls.
- `--no-session-persistence` disables saving entirely — don't combine it with
  any of this.

