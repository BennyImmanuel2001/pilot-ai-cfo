# Pilot: 3-minute demo video script

Files:
- `pilot-demo-3min-vo.mp4`: 1920×1080, 30 fps, 2:58, with voiceover and matching captions. Upload this one.
- `pilot-demo-3min.mp4`: earlier silent version with captions only.

Recorded in demo mode: seed data, scripted agent, PayPal in simulate mode (`PAYPAL_MODE=simulate`, the default). All merchants and products shown are fictional, per the hackathon rule on third-party trademarks.

## Voiceover

Voice: Kokoro-82M (`af_heart`), generated offline on this machine. The Kokoro model weights are Apache-2.0 licensed and the model card states it was trained on permissive/non-copyrighted audio and can be deployed "anywhere from production environments to personal projects" (https://huggingface.co/hexgrad/Kokoro-82M). No music is used.

| Time | Section | Narration |
| --- | --- | --- |
| 0:00 | Hook | Most money apps tell you what you spent. Pilot tells you what to do next. |
| 0:07 | Who it's for | It's built for single-income households and gig workers, where one purchase at the wrong time can mean a missed bill. |
| 0:15 | Product | Meet Pilot: an AI CFO that decides, then acts. It answers with the math, rebuilds your dashboard, and drafts PayPal payments you approve. |
| 0:25 | 01 Tour | Chat on the left, a generative dashboard on the right, starting with an overview of your money. |
| 0:33 | 02 Affordability | Ask in plain English: can I afford a $999 e-bike? |
| 0:38 | | Pilot projects your balance to month end, from your bills and spending. |
| 0:43 | | The rule: No under 15% of income, Wait under 30%. Here, just $121 against a $480 buffer. |
| 0:53 | | Pilot drafts a PayPal order, but the AI never moves money. It's created only when you click Pay. |
| 1:01 | | After the buyer approves in the sandbox, Capture completes the payment. |
| 1:06 | | Here, PayPal is in simulate mode, so each step says simulated. |
| 1:13 | 03 Spending | Next: how much did I spend on food in the last six months? |
| 1:17 | | The dashboard rebuilds itself: KPI tiles, spend by month, and the split by type. |
| 1:25 | | Every table is AG Grid. Group by merchant in one click, or pivot by month, to see where the money goes. |
| 1:39 | 04 Projection | Project my expenses for this month. A cash-flow timeline to month end, with every upcoming bill, and a dashed safety line. Spent so far, bills due, daily pace, and month-end balance, at a glance. |
| 1:57 | 05 Autopay | Find bills I should autopay. Pilot finds six recurring payments. The electricity bill varies, and is still paid by card. |
| 2:07 | | So it proposes a PayPal subscription, and waits for you. Approve creates the catalog product, billing plan, and subscription, and reuses them on repeat approvals. |
| 2:21 | 06 Design | Light and dark themes, with charts and grids to match. On a phone, the chat becomes a drawer, and the grid reflows. |
| 2:35 | 07 Under the hood | Under the hood, an agent loop calls typed tools, and every dashboard is JSON, validated with Zod. Every service is optional. With no keys, Pilot runs on seed data and a scripted agent, as in this video. |
| 2:51 | Close | Decide before you spend. Pilot: the AI CFO that decides, then acts. |

## Before uploading

- Hackathon rules: under 3 minutes, public on YouTube, show the project working, no third-party trademarks or copyrighted music without permission.
- If you add music, use a track you have rights to (for example from the YouTube Audio Library), and keep it well under the voice.
- YouTube may ask whether the video contains realistic altered or synthetic content. A synthetic narrator voice reading your own script generally doesn't need that label, but tick it if you're unsure.
- For a stronger "Technological Implementation" score, consider re-recording with a live LLM key and `PAYPAL_MODE=sandbox` so the footage shows real sandbox order IDs.
