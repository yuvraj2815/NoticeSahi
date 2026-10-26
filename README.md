# NoticeSahi

**Know before you go.** NoticeSahi checks an event poster against a short spoken announcement, shows where details match or conflict, and helps students turn the result into an accessible, shareable plan.

## Hackathon pitch

Campus updates often arrive in more than one format: a printed or digital poster, followed by a voice note or announcement. NoticeSahi compares both sources instead of silently choosing one. It highlights evidence, lets a student translate or hear the event card, gives them a ready-to-copy question for the organiser, and creates a calendar invite only after any flagged detail is confirmed.

- **Creative:** a two-source consistency check that makes the evidence visible.
- **Impact:** translation and speech output support students who face language, reading, or access barriers.
- **Functionality:** upload or record, review, clarify, and save the confirmed event details.

## Vercel deployment

The `api/` handlers expose the same API on Vercel, while the `public/` folder serves the web app. Add `SARVAM_API_KEY` under the Vercel project's Environment Variables before using live AI features. Keep the combined poster and audio upload under 4 MB to stay below Vercel's function request limit. The API function is configured for up to five minutes so poster extraction can finish.

## Local run

This project uses the `sarvamai` SDK. In this workspace, start it with the Python environment created for the first Sarvam call:

```powershell
..\sarvam-first-call\.venv\Scripts\python.exe server.py
```

Then open <http://localhost:8000>. The server reads `SARVAM_API_KEY` from the process environment or, for this local workspace, from `..\sarvam-first-call\.env`. It never sends the key to the browser or writes it to logs.

For another machine, install the package from `requirements.txt` and set `SARVAM_API_KEY` as an environment variable. Do not commit the key.

## MVP flow

1. Upload one JPG, PNG, or PDF event poster and a short audio announcement, or record one in the browser. For Vercel, keep the combined upload under 4 MB and audio under 30 seconds.
2. Sarvam Vision extracts event fields from the poster.
3. Saaras transcribes the announcement (keep it to 30 seconds for the real-time endpoint).
4. Sarvam-105B compares the sources and flags mismatches without choosing which source is correct.
5. Optionally translate the event card or listen to it with Bulbul, copy a question for the organiser, then review and download a calendar invite after confirmation.

The app does not store uploaded files. Poster and audio bytes are held in memory for the request and sent to Sarvam for processing. A sample mismatch preview is available without an API call. Live checks and speech features use Sarvam API credits.

## Deploy

`render.yaml` prepares a Render web service. Add `SARVAM_API_KEY` as a private environment variable in the host dashboard before deploying. The key is not stored in this repository.
