# models.json template

The **Apply models.json template** menu entry writes [`templates/models.json`](../templates/models.json) over `~/.pi/agent/models.json`. The template carries three providers with every model, compat flag, thinking-level map, context limit, modality, and price filled in. Only the endpoint and the key are placeholders:

| Provider | API | Models | Placeholder `baseUrl` | Placeholder `apiKey` |
|---|---|---|---|---|
| `openai-proxy` | `openai-responses` | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | `https://your-openai-relay.example.invalid/v1` | `$OPENAI_PROXY_API_KEY` |
| `anthropic-proxy` | `anthropic-messages` | Claude Fable 5.1, Claude Opus 5.5, Claude Opus 4.6, Claude Sonnet 5.5 | `https://your-anthropic-relay.example.invalid` | `$ANTHROPIC_PROXY_API_KEY` |
| `deepseek-proxy` | `openai-responses` | DeepSeek V4.1 Flash, DeepSeek V4 Pro | `https://your-deepseek-relay.example.invalid/v1` | `$DEEPSEEK_PROXY_API_KEY` |

The flow (TUI only):

1. **Fill in or keep.** Either enter a base URL and API key for each provider (the key prompt is masked), or skip the prompts. An empty answer, and every provider when you skip, keeps the provider's current value from your existing `models.json`, or the template placeholder when there is none. A key written as `$NAME` is read by pi from that environment variable, so the placeholders already work if you export `OPENAI_PROXY_API_KEY` and so on.
2. **Default provider and model.** Two selectors pick `defaultProvider` and `defaultModel` for `settings.json`. The template's defaults, [`templates/settings.json`](../templates/settings.json) (`anthropic-proxy` / `claude-opus-5-5`), come first.
3. **Review.** A summary lists the file being replaced, providers that disappear because they are not in the template, each provider's endpoint and where its key comes from, the two `settings.json` keys, and any placeholders left. Keys are never shown. Enter applies, Esc writes nothing.

`models.json` is replaced as a whole: the previous file is kept as `models.json.preset-bak`, the new one is written atomically with mode `0600`. Into `settings.json` go `defaultProvider`, `defaultModel`, and the template's `modelThinkingLevels` for models that have no level yet: Claude Fable 5.1 starts at `high`, its official default (pi's global default is `medium`). A level you saved yourself (Ctrl+S in `/thinking`) is never replaced. The template's `compaction.modelOverrides` go in the same way, only for models that have no override yet: every 1M-context model gets `reserveTokens: 500000`, so auto-compaction (native, through `pi-better-compaction`) starts around 500k instead of near the 1M limit, while the footer and overflow handling keep the real window. Everything else in `settings.json` stays. Running it again with the same answers writes nothing. Open `/model` afterwards to load the models; the new default applies from the next pi start.

The providers target subscription relays (a ChatGPT or Claude subscription exposed as an API by a relay), so their parameters follow the subscription catalogs rather than the pay-as-you-go API ones:

- **OpenAI** thinking levels use the ChatGPT-subscription (`openai-codex`) mapping: `minimal` is served as `low`. GPT-6 Astra and GPT-6.1 Sol cannot disable reasoning, so `off` is unavailable for them. GPT-6.1 Sol has a 1M context (the subscription's default is 500k, with no long-context surcharge); GPT-6 Astra and GPT-6 Luna stay at the subscription's 272k. The provider enables `additional_tools` and client-side tool search (`supportsAdditionalTools`, `supportsToolSearch`): tools added mid-session are sent as anchored additions instead of rewriting the tool list, which keeps the cached prefix.
- **Compatibility flags** mirror what pi's bundled catalog enables for these models and were verified end to end through two different subscription relays:
  - OpenAI: `supportsOpenAIGrammarTools` (grammar-constrained tools go out as native OpenAI custom tools) and `supportsMidConvoSystemMessages` (mid-conversation developer messages stay in place instead of being folded into the leading system prompt, which would break the cached prefix).
  - Anthropic: `supportsMidConvoEffort` (changing the thinking level mid-session keeps the prompt cache and binds thinking blocks), `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, and `supportsEagerToolInputStreaming`. Claude Opus 4.6 turns the three mid-conversation flags off.

  If your relay rejects one of the enabled flags, set it to `false` in `models.json` after applying the template.
- **Claude** follows the subscription: 1M context on every listed model, the 1h prompt cache (pi prices 1h cache writes at 2× input on its own), and Opus 5.5 / Sonnet 5.5 marked as rejecting `temperature`, like the official catalog.
- **DeepSeek** is pay-as-you-go, so its prices are DeepSeek's own peak rates (off-peak is half): V4.1 Flash $0.30 / $1.20 / $0.006 cache hit, V4 Pro $1.32 / $3.96 / $0.044 per 1M tokens. Both take `low`, `high`, and `max` (`off` sends `none`); pi's default `medium` runs as `high`, DeepSeek's own default. No cache lifetime is declared, so nothing pays for cache warming.

To add another provider, edit `models.json` by hand or ask pi to do it; pi's own `docs/models.md` describes the format. Re-applying the template removes providers that are not in it, so keep a copy of hand-added ones.
