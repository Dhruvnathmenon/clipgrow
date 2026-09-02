# ClipGrow docs

| File | What it is | Who it's for |
|---|---|---|
| **`ClipGrow-Agency-System.pdf`** | How the agency runs on Discord — ranks, hierarchy, flows, the money model. The shareable version. | the team (Dhruv, Spandan, Endrig) |
| `_src/build_agency_pdf.py` | The source of the PDF above. Edit here, then `python docs/_src/build_agency_pdf.py` from the repo root to regenerate. **No Markdown copy — it would drift.** | whoever maintains the doc |
| **`discord-bot-build-spec.md`** | Technical spec for the Discord bot: what it does, how it talks to this app, the `/api/bot/*` API to build, Cloudflare/credentials setup, and the shared-repo workflow. | Endrig |

Regenerating the PDF needs `reportlab` (`pip install reportlab`).
