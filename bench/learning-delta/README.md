# learning-delta PoC

**Question**: does one `journal → learn → install` cycle produce a measurable behavior delta on unseen prompts in the same category?

**Not measuring**: absolute quality, generalization across categories, statistical significance. This is a directional eyeball.

## Setup

- **Model**: Ollama `qwen3.5:9b` (local, free, weak enough to have headroom for learning to help)
- **Category**: "quick technical trade-off recommendations"
- **Split**: 3 training prompts (seed sessions for `learn` to analyze) + 3 holdout prompts (evaluated baseline vs post)
- **Judge**: manual eyeball on 3 dimensions — structure, specificity, decisiveness

## Layout

```
prompts/
  training.txt   # 3 prompts — run through fresh harness to create sessions
  holdout.txt    # 3 prompts — eval set, never touched by learn
baseline/
  holdout-1.md   # outputs from fresh harness on holdout prompts
  holdout-2.md
  holdout-3.md
post/
  holdout-1.md   # outputs after learn --install
  holdout-2.md
  holdout-3.md
  instincts.md   # what learn actually installed
findings.md      # eyeball comparison + verdict
```

## Procedure

1. Fresh `harness init bench-harness` scaffold
2. Configure for Ollama qwen3.5:9b
3. Run 3 training prompts → sessions pile up in `bench-harness/sessions/`
4. Run 3 holdout prompts → save outputs to `baseline/`
5. `harness journal` then `harness learn --install`
6. Snapshot the newly-installed instinct files
7. Re-run 3 holdout prompts → save outputs to `post/`
8. Eyeball baseline vs post, write `findings.md`
