# Reader test materials

`reading-fixture.pdf` is a synthetic document, clearly marked TEST FIXTURE on
every page. It contains a Roman-label cover, printed page labels `1` and `2`,
a real three-item outline, selectable text and a formula-like rectangle. Its
third page has intrinsic 90-degree rotation. The equations are test strings,
not research results. Regenerate from the local app directory:

```sh
node scripts/make-fixture.mjs
```

Metadata timestamps and fonts are fixed; `reading-fixture.json` records the
SHA256, labels, rotations and formula rectangle. This material belongs only
in this test directory and must not be automatically imported into user data.

Optional real-paper test material: **LoRA: Low-Rank Adaptation of Large Language
Models**, arXiv:2106.09685v2, by Edward J. Hu and coauthors. Official source:
<https://arxiv.org/abs/2106.09685v2>, PDF:
<https://arxiv.org/pdf/2106.09685v2>. Download an unmodified local copy as
`lora-2106.09685v2.pdf` to enable its parser smoke test. It remains an optional,
ignored local test input and is not redistributed under the application's MIT
license. The source paper retains its own copyright and arXiv license.

Verified local download on 2026-10-28: 26 physical pages, SHA256
`e9a0d3128767db616085dc0f4e6e455e672e89af823e8ed1282793682787395a`.
The parser extracted the arXiv v2 identifier and author text. PDF.js emitted
`TT: undefined function: 32` for one embedded font, but parsing and text
extraction completed; this is not a claim that every glyph was visually checked.

`pdf-reader-contract.test.ts` checks actual PDF.js parsing, labels, outline,
text extraction, intrinsic rotation and reprojection. Browser selection,
pointer dragging and visual alignment require separate browser verification.
