# Source License Review — v0.1.0 Bundled Content

Date: 2026-04-08
Reviewer: Claude sub-agent (task follow-up from v0.1.0 ship)
Scope: 12 default primitive files pulled from external GitHub sources during task 12.4

## Summary verdict

**BLOCKED — must remove or replace before v0.1.1.** The 10 files pulled from `anthropics/skills` are governed by a per-skill `LICENSE.txt` (present in 9 of 10 skill subdirectories) that reads "© 2025 Anthropic, PBC. All rights reserved" and expressly prohibits extracting materials from Anthropic's services, retaining copies outside them, reproducing/copying, creating derivative works, and distributing/sublicensing/transferring to third parties. Redistribution inside an MIT-licensed npm package is not permitted by those terms, and the 10th skill (`doc-coauthoring`) has no LICENSE.txt and no inline license — it is unverified and must be treated as equally restricted by default since the repo itself carries no root license. The 2 files from `wshobson/agents` are MIT-licensed and only require standard attribution (copyright + permission notice).

## anthropics/skills

**Repository license:** NONE FOUND at root. GitHub API `license` field is `None`. No `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING` at repo root (all 404).
**Repository root files checked:** `LICENSE` 404, `LICENSE.md` 404, `LICENSE.txt` 404, `COPYING` 404, `THIRD_PARTY_NOTICES.md` 200, `README.md` 200. `THIRD_PARTY_NOTICES.md` contains attribution only for bundled runtime dependencies (imageio BSD-2, FFmpeg GPL-3.0, etc.) — it does NOT grant any license to the skill content itself. `README.md` contains no license section or copyright statement.
**Repo description:** "Public repository for Agent Skills"

**Per-skill LICENSE.txt (the real license surface):** 9 of the 10 skills we bundled ship a `LICENSE.txt` in their directory. The full text of `skills/pdf/LICENSE.txt` (and, by inspection, the identical wording reused by the others) is:

> © 2025 Anthropic, PBC. All rights reserved.
>
> Use of these materials (including all code, prompts, assets, files, and other components of this Skill) is governed by your agreement with Anthropic regarding use of Anthropic's services. If no separate agreement exists, use is governed by Anthropic's Consumer Terms of Service or Commercial Terms of Service, as applicable.
>
> ADDITIONAL RESTRICTIONS: Notwithstanding anything in the Agreement to the contrary, users may not:
> - Extract these materials from the Services or retain copies of these materials outside the Services
> - Reproduce or copy these materials, except for temporary copies created automatically during authorized use of the Services
> - Create derivative works based on these materials
> - Distribute, sublicense, or transfer these materials to any third party
> - Make, offer to sell, sell, or import any inventions embodied in these materials
> - Reverse engineer, decompile, or disassemble these materials
>
> Anthropic retains all right, title, and interest in these materials, including all copyrights, patents, and other intellectual property rights.

This is a proprietary, all-rights-reserved license that explicitly forbids every action our `defaults/skills/` bundle takes: extracting from the service, retaining copies outside it, reproducing, creating derivatives, and redistributing to third parties (our npm users). 7 of the 10 SKILL.md frontmatters also explicitly declare `license: Proprietary. LICENSE.txt has complete terms` or `license: Complete terms in LICENSE.txt`, making the intent unambiguous.

| Local file | Upstream path | Per-skill LICENSE.txt? | Inline `license:` field in frontmatter | Classification | Notes |
|---|---|---|---|---|---|
| defaults/skills/pdf.md | skills/pdf/SKILL.md | yes (200) | `Proprietary. LICENSE.txt has complete terms` | PROBLEMATIC | All-rights-reserved, redistribution forbidden |
| defaults/skills/docx.md | skills/docx/SKILL.md | yes (200) | `Proprietary. LICENSE.txt has complete terms` | PROBLEMATIC | Same terms as pdf |
| defaults/skills/skill-creator.md | skills/skill-creator/SKILL.md | yes (200) | none | PROBLEMATIC | LICENSE.txt present at 200, inherits same Anthropic proprietary terms |
| defaults/skills/canvas-design.md | skills/canvas-design/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms |
| defaults/skills/mcp-builder.md | skills/mcp-builder/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms |
| defaults/skills/brand-guidelines.md | skills/brand-guidelines/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms; plus contains Anthropic trademarks/brand assets |
| defaults/skills/internal-comms.md | skills/internal-comms/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms |
| defaults/skills/frontend-design.md | skills/frontend-design/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms |
| defaults/skills/doc-coauthoring.md | skills/doc-coauthoring/SKILL.md | **no (404)** | none | UNVERIFIED | No per-skill LICENSE.txt, no inline license, no repo root license — redistribution permissions cannot be established. Must be treated as all-rights-reserved by default under US copyright law. |
| defaults/skills/webapp-testing.md | skills/webapp-testing/SKILL.md | yes (200) | `Complete terms in LICENSE.txt` | PROBLEMATIC | Same terms |

## wshobson/agents

**Repository license:** MIT (confirmed via `gh api repos/wshobson/agents` → `spdx_id: MIT`, and `LICENSE` file at root returns 200 with full MIT text, `Copyright (c) 2024 Seth Hobson`).

MIT is fully compatible with redistribution inside an MIT-licensed npm package. The only obligation is preserving the copyright notice and the MIT permission notice in copies or substantial portions.

| Local file | Upstream path | Classification | Notes |
|---|---|---|---|
| defaults/skills/content-marketer.md | plugins/content-marketing/agents/content-marketer.md | NEEDS ATTRIBUTION | MIT — add `Copyright (c) 2024 Seth Hobson` + MIT permission notice somewhere in our package (NOTICE file or per-file header) |
| defaults/skills/business-analyst.md | plugins/business-analytics/agents/business-analyst.md | NEEDS ATTRIBUTION | MIT — same as above |

## Classification counts

- CLEAR: 0
- NEEDS ATTRIBUTION: 2 (both wshobson/agents files)
- PROBLEMATIC: 9 (all anthropics/skills files that have a per-skill LICENSE.txt)
- UNVERIFIED: 1 (`doc-coauthoring.md`, treat as PROBLEMATIC in practice)

## Recommendations

Pick one of these paths before v0.1.1. Do not ship v0.1.1 with the 10 Anthropic skills as-is.

1. **(Recommended) Remove all 10 `anthropics/skills` files from `defaults/skills/` and from the published tarball.** Replace with one of:
   - Rewrite from scratch as original content owned by this project (clean-room, not derivative).
   - Ship as an optional post-install fetcher that pulls the skills directly from Anthropic's service at the user's request, so the files never live inside our npm package. This is the closest thing to compatible with "no retaining copies outside the Services" — but still review with counsel because it is arguably still "extracting from the Services."
   - Drop the feature from v0.1.1.
2. **For the 2 wshobson/agents files:** keep, but add attribution. Minimum viable fix:
   - Add a `NOTICE` (or `THIRD_PARTY_NOTICES.md`) file at repo root reproducing `Copyright (c) 2024 Seth Hobson` and the full MIT permission text, and naming the two files.
   - Optionally add a short source/attribution comment block at the top of each of the two skill files pointing at the upstream path and license.
3. **Do NOT contact Anthropic asking for a redistribution grant unless the project explicitly wants to become an Anthropic-blessed distribution channel** — the existing per-skill LICENSE.txt is unambiguous and a private side-letter is unlikely.
4. **Add a CI check** that fails the build if any file under `defaults/` is added without a corresponding entry in `NOTICE` / `.ralph/source-licenses.md`, so this class of bug cannot recur silently.
5. **v0.1.0 already shipped.** Consider yanking or publishing a v0.1.0-patch that removes the 10 Anthropic files. At minimum, stop promoting v0.1.0 broadly until the offending content is out of the tarball.
