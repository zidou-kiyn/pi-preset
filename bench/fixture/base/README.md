# ledger

A tiny personal expense ledger. Entries live in one JSON file; the CLI adds,
lists and summarises them.

```
ledger add 12.50 food "lunch"           # add an expense (positive = spend)
ledger add -2000 salary "october"       # negative = income
ledger list [--from 2024-03-01] [--to 2024-03-31]
ledger report [--from ...] [--to ...]   # totals per month and category
```

The data file defaults to `~/.ledger.json`; set `LEDGER_FILE` to use another
path. Amounts are stored as integer cents, dates as `YYYY-MM-DD` strings.

Run `npm test` for the unit tests, `npm run test:all` to include the
integration tests (slow: they exercise the sync stub end-to-end).
