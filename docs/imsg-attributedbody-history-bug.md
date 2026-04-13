# imsg `history` attributedBody prefix leak

## Summary

`imsg history --json` can return corrupted leading characters for some sent iMessage rows whose body is stored in `message.attributedBody` instead of `message.text`.

Observed symptom:

```text
�8\u0001RC: incoming relevant email
```

Expected:

```text
RC: incoming relevant email
```

## What we observed locally

- Affected rows in `chat.db` had `message.text IS NULL`.
- The real body text was present inside `message.attributedBody`.
- `imsg history --json` returned the human text, but with the typedstream string-length prefix leaked into the start of `text`.

Examples seen on this machine:

- `�8\u0001RC: incoming relevant email...`
- `��\u0000RC: incoming relevant email...`

The first three codepoints looked like length-prefix bytes, while the remainder of the text was correct.

## Likely cause

The `imsg` history decoder appears to be reconstructing text from `message.attributedBody`, but not fully consuming the typedstream string header before exposing the decoded string.

In our evidence:

- the corrupted prefix length matched the first bytes before the readable text inside `attributedBody`
- the remainder of the string matched the intended message body exactly

## Reproducer

This repo includes a standalone reproducer:

```bash
node scripts/repro-imsg-attributedbody-prefix.js --chat-id 144 --limit 20
```

Options:

- `--chat-id ID`: required Messages chat rowid
- `--limit N`: number of recent messages to inspect
- `--imsg-bin PATH`: alternate `imsg` binary path
- `--db PATH`: alternate `chat.db` path

What it does:

1. runs `imsg history --json`
2. finds messages whose `text` starts with the leaked prefix pattern
3. reads the same message rows from `chat.db`
4. prints:
   - the bad `text` prefix
   - the raw prefix codepoints
   - whether `message.text` is null
   - `length(attributedBody)`
   - the first bytes of `attributedBody` as hex

It exits with status `1` if it finds one or more suspect rows.

## Expected upstream fix

`imsg history` should strip or fully decode the typedstream/string header from `message.attributedBody` so that returned JSON `text` starts directly with the user-visible message content.

## Local workaround in this repo

This repo now sanitizes the leaked prefix in `tools-source/imessage.js` when parsing `imsg history` results, so OpenCode reads are clean even though raw `imsg history` output is still affected.
