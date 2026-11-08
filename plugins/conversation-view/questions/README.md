# questions (a conversation-view feature)

Answer a background session's AskUserQuestion forms from the prompt box. Default on.

Detection stays in the core: an unanswered AskUserQuestion in the transcript marks the session "waiting on you" (the job's
state stays "working" while the form is up). The answered Q&A rendering in the Chat view belongs to conversation-view.

## Server

`POST /api/sessions/:id/answer` `{ toolUseId, answers: [{ options?: number[], text?: string }] }`. It types the verified
keystrokes into the session (`ctx.sessions.typeSequence`, planned by the pure `answerKeys` in `answer.ts`):

- single-select: the option's number (0-based index + 1)
- your own text: `options + 1`, the text, Enter
- multi-select: each option's number toggles it, then Tab
- more than one question: a review screen follows, where `1` submits

It refuses (409) unless that exact question is still unanswered (`ctx.sessions.pendingQuestion`) and visible on Claude's
screen (`claude logs` through `ansiToHtml`, `screenShowsQuestion`), and only for background sessions.

## Web

`QuestionForm.tsx` is a `composer-addon` item (order 10). SessionView passes the loaded `history` and the session's
menagerie `host`; the addon renders the newest unanswered question form on a row above the textarea inside `.compose-box`
(`.qform-slot`), framed as the host through the `host-provider` slot's `frame`/`AskHeader` when present. The form can be
shrunk to a one-line bar. Styles: `styles.css` (`.qform*`, `.q-*`).

## Settings

None.
